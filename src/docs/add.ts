import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { type CatalogEntry, mergedCatalog } from "./catalog.js";
import {
  type Discovery,
  discoverDocs,
  type LocalCandidate,
  type ProviderCandidate,
} from "./discover.js";
import { syncDocsGraphQuietly } from "./graph.js";
import {
  clearSyncState,
  type DocSourceInput,
  docsTag,
  removeSource,
  slugify,
  upsertSources,
} from "./manifest.js";
import { type Resolved, resolveProvider } from "./resolve.js";
import { formatSync, type SyncResult, syncSources } from "./sync.js";

/**
 * recommended = local docs + third-party services + APIs found in code (small, project-specific);
 * service / infra / catalog = catalogue tiers; api = probed hosts; registry = unknown packages;
 * all = everything.
 */
export type Pick =
  | "recommended"
  | "local"
  | "service"
  | "infra"
  | "catalog"
  | "api"
  | "registry"
  | "all";

export const PICKS: Pick[] = [
  "recommended",
  "local",
  "service",
  "infra",
  "catalog",
  "api",
  "registry",
  "all",
];

/** A loosely specified source as the tool, CLI and dashboard receive it. */
export interface AddInput {
  name?: string | undefined;
  url?: string | undefined;
  urls?: string[] | undefined;
  path?: string | undefined;
  glob?: string[] | undefined;
  provider?: string | undefined;
  title?: string | undefined;
  tags?: string[] | undefined;
  notes?: string | undefined;
  crawl?: { depth?: number | undefined; maxPages?: number | undefined } | undefined;
  ttlHours?: number | undefined;
}

export interface AddOutcome {
  added: string[];
  updated: string[];
  failed: Array<{ name: string; reason: string }>;
  resolved: Resolved[];
  sync: SyncResult[];
  file?: string | undefined;
}

function nameFor(input: AddInput): string {
  if (input.name) return slugify(input.name);
  if (input.provider) {
    const key = input.provider.slice(input.provider.indexOf(":") + 1);
    return slugify(key.replace(/^github\.com\//, ""));
  }
  const url = input.url ?? input.urls?.[0];
  if (url) {
    try {
      return slugify(
        new URL(url).hostname
          .replace(/^(www|docs|developer|developers|api)\./, "")
          .replace(/\.[a-z.]+$/, ""),
      );
    } catch {
      // fall through
    }
  }
  if (input.path) return slugify(input.path.replace(/[./]+$/, "") || "root");
  return "source";
}

function candidateToInput(c: LocalCandidate | ProviderCandidate): AddInput {
  if ("path" in c) {
    return {
      name: c.name,
      path: c.path,
      glob: c.glob,
      title: c.why,
      tags: c.project ? [c.project] : undefined,
    };
  }
  return {
    name: c.name,
    provider: c.provider,
    urls: c.urls.length ? c.urls : undefined,
    title: c.title,
    crawl: c.crawl,
    tags: c.tags,
  };
}

/** Which discovery candidates a `pick` selects; `names` narrows further; registered ones are skipped unless asked. */
export function pickCandidates(
  d: Discovery,
  pick: Pick,
  names?: string[] | undefined,
  opts: { includeRegistered?: boolean | undefined } = {},
): AddInput[] {
  const wantLocal = pick === "local" || pick === "recommended" || pick === "all";
  const wants = (p: ProviderCandidate): boolean => {
    const tier = p.tier ?? "library";
    switch (pick) {
      case "recommended":
        return p.confidence === "probe" || (p.confidence === "catalog" && tier === "service");
      case "service":
        return p.confidence === "catalog" && tier === "service";
      case "infra":
        return p.confidence === "catalog" && tier === "infra";
      case "catalog":
        return p.confidence === "catalog";
      case "api":
        return p.confidence === "probe";
      case "registry":
        return p.confidence === "registry";
      case "all":
        return p.confidence !== "unknown";
      default:
        return false;
    }
  };
  const out: AddInput[] = [];
  const seen = new Set<string>();
  const take = (c: LocalCandidate | ProviderCandidate) => {
    if ((c.registered && !opts.includeRegistered) || seen.has(c.name)) return;
    if (names?.length && !names.includes(c.name)) return;
    seen.add(c.name);
    out.push(candidateToInput(c));
  };
  if (wantLocal) for (const c of d.local) take(c);
  for (const c of d.providers) if (wants(c)) take(c);
  return out;
}

/**
 * Register sources (resolving providers to URLs when none were given), then sync them.
 * Shared by em_docs, the CLI and the dashboard so all three behave the same.
 */
export async function addDocSources(
  ctx: ProjectContext,
  db: StorageAdapter,
  inputs: AddInput[],
  opts: {
    sync?: boolean | undefined;
    force?: boolean | undefined;
    catalog?: CatalogEntry[] | undefined;
  } = {},
): Promise<AddOutcome> {
  const catalog = opts.catalog ?? mergedCatalog(ctx.config.docs.catalog as CatalogEntry[]);
  const out: AddOutcome = { added: [], updated: [], failed: [], resolved: [], sync: [] };
  const ready: DocSourceInput[] = [];
  for (const input of inputs) {
    const name = nameFor(input);
    const urls = [...(input.url ? [input.url] : []), ...(input.urls ?? [])];
    let title = input.title;
    let crawl = input.crawl;
    if (!urls.length && !input.path && input.provider) {
      const r = await resolveProvider(input.provider, {
        catalog,
        apiCrawl: ctx.config.docs.crawl.api,
      });
      out.resolved.push(r);
      if (!r.urls.length) {
        out.failed.push({ name, reason: r.notes ?? `could not resolve ${input.provider}` });
        continue;
      }
      urls.push(...r.urls);
      title ??= r.title;
      crawl ??= r.crawl;
    }
    if (!urls.length && !input.path) {
      out.failed.push({ name, reason: "needs url(s), a path or a resolvable provider" });
      continue;
    }
    ready.push({
      name,
      kind: input.path && !urls.length ? "path" : "url",
      urls: urls.length ? urls : undefined,
      path: !urls.length ? input.path : undefined,
      glob: input.glob,
      provider: input.provider,
      title,
      crawl,
      ttlHours: input.ttlHours,
      tags: input.tags,
      notes: input.notes,
    });
  }
  if (ready.length) {
    try {
      const r = upsertSources(ctx, ready);
      out.added = r.added;
      out.updated = r.updated;
      out.file = r.file;
    } catch (err) {
      // one bad definition fails the batch validation; retry one by one so the rest land
      for (const s of ready) {
        try {
          const r = upsertSources(ctx, [s]);
          out.added.push(...r.added);
          out.updated.push(...r.updated);
          out.file = r.file;
        } catch (e) {
          out.failed.push({ name: s.name, reason: (e as Error).message });
        }
      }
      void err;
    }
  }
  const names = [...out.added, ...out.updated];
  if (opts.sync !== false && names.length)
    out.sync = await syncSources(ctx, db, names, { force: opts.force });
  else if (names.length) syncDocsGraphQuietly(ctx, db);
  return out;
}

export function removeDocSource(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
): { removed: boolean; documents: number } {
  const removed = removeSource(ctx, name);
  // Also drops an orphaned source's pages (indexed, but no manifest entry any more); the
  // graph rebuild below then clears any `doc:` node left over from when it was registered.
  const documents = db.deleteDocumentsBySource(docsTag(name));
  clearSyncState(db, name);
  if (removed || documents) syncDocsGraphQuietly(ctx, db);
  return { removed, documents };
}

export function formatAdd(o: AddOutcome): string {
  const lines: string[] = [];
  if (o.added.length) lines.push(`added: ${o.added.join(", ")}`);
  if (o.updated.length) lines.push(`updated: ${o.updated.join(", ")}`);
  for (const r of o.resolved.filter((r) => r.urls.length))
    lines.push(`resolved ${r.provider} via ${r.via}: ${r.urls.join(", ")}`);
  for (const f of o.failed) lines.push(`skipped ${f.name}: ${f.reason}`);
  if (o.sync.length) lines.push("", formatSync(o.sync));
  if (o.file && (o.added.length || o.updated.length))
    lines.push("", `manifest: ${o.file} (commit it)`);
  return lines.join("\n") || "nothing to add";
}

/** Convenience for `pick`: discover, select, add. */
export async function addPicked(
  ctx: ProjectContext,
  db: StorageAdapter,
  pick: Pick,
  opts: {
    names?: string[] | undefined;
    includeDev?: boolean | undefined;
    subprojects?: boolean | undefined;
    sync?: boolean | undefined;
    force?: boolean | undefined;
  },
): Promise<AddOutcome> {
  const d = discoverDocs(ctx, { includeDev: opts.includeDev, subprojects: opts.subprojects });
  // force also refreshes already-registered candidates (new URLs, crawl budgets) and re-crawls them
  return addDocSources(
    ctx,
    db,
    pickCandidates(d, pick, opts.names, { includeRegistered: opts.force }),
    {
      sync: opts.sync,
      force: opts.force,
    },
  );
}
