import { z } from "zod";
import {
  type AddInput,
  addDocSources,
  addPicked,
  formatAdd,
  PICKS,
  type Pick,
  removeDocSource,
} from "../docs/add.js";
import { type CatalogEntry, catalogForProvider, mergedCatalog } from "../docs/catalog.js";
import { categoryInfo, categoryRank, docCategory, GROUP_LABELS } from "../docs/category.js";
import { type Discovery, discoverDocs } from "../docs/discover.js";
import {
  DOCS_PREFIX,
  docsTag,
  manifestPath,
  nameFromTag,
  readManifest,
  syncState,
} from "../docs/manifest.js";
import { resolveProvider } from "../docs/resolve.js";
import { formatSync, syncSources } from "../docs/sync.js";
import { vectorRanker } from "../embeddings/queue.js";
import { formatResults } from "../search/format.js";
import { type SearchResponse, search } from "../search/pipeline.js";
import { recordStat } from "../stats/record.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import type { SourceStatRow } from "../storage/types.js";
import { defineTool, errorResult, text } from "./types.js";

const sourceShape = {
  name: z.string().optional(),
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
  path: z.string().optional().describe("Project-relative file or directory"),
  glob: z.array(z.string()).optional(),
  provider: z
    .string()
    .optional()
    .describe(
      "npm:<pkg> | pypi:<pkg> | go:<module> | env:<PREFIX> | image:<name> | api:<host> | files:<kind>; resolved to URLs when none are given",
    ),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  crawl_depth: z.number().int().min(0).max(3).optional(),
  max_pages: z.number().int().min(1).max(200).optional(),
  ttl_hours: z.number().positive().optional(),
};

function toInput(a: z.infer<z.ZodObject<typeof sourceShape>>): AddInput {
  return {
    name: a.name,
    url: a.url,
    urls: a.urls,
    path: a.path,
    glob: a.glob,
    provider: a.provider,
    title: a.title,
    tags: a.tags,
    notes: a.notes,
    crawl:
      a.crawl_depth !== undefined || a.max_pages !== undefined
        ? { depth: a.crawl_depth, maxPages: a.max_pages }
        : undefined,
    ttlHours: a.ttl_hours,
  };
}

function kb(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export interface OrphanedDocSource {
  name: string;
  documents: number;
  chunks: number;
  latest: number;
}

/**
 * `docs:<name>` sources that still have pages in the index but no manifest entry (the manifest
 * was deleted, or lives on another branch). Lookup and the recall hooks keep serving them, so
 * `list` must say so and `remove` must be able to drop them.
 */
export function orphanedDocSources(
  db: StorageAdapter,
  registered: Iterable<string>,
  stats: SourceStatRow[] = db.documentSourceStats(DOCS_PREFIX),
): OrphanedDocSource[] {
  const known = new Set(registered);
  const out: OrphanedDocSource[] = [];
  for (const s of stats) {
    const name = nameFromTag(s.source);
    if (name === undefined || known.has(name)) continue;
    out.push({ name, documents: s.documents, chunks: s.chunks, latest: s.latest });
  }
  return out;
}

function formatOrphans(orphans: OrphanedDocSource[]): string[] {
  const names = orphans.map((o) => o.name);
  return [
    `# Orphaned in the index (${orphans.length}; pages without a manifest entry)`,
    ...orphans.map(
      (o) => `- ${o.name} · ${o.documents} doc(s) · ${o.chunks} chunks · indexed ${ago(o.latest)}`,
    ),
    `em_docs {action:"remove", names:${JSON.stringify(names)}} drops them; {action:"add", pick:"recommended"} or {action:"add", name, url|path} re-registers.`,
  ];
}

export function formatDiscovery(d: Discovery, max = 40): string {
  const lines: string[] = [];
  lines.push(
    `Documentation discovery for ${d.root}${d.projects.length > 1 ? ` (${d.projects.length} projects: ${d.projects.slice(0, 12).join(", ")}${d.projects.length > 12 ? ", …" : ""})` : ""}`,
  );
  const reg = (b: boolean) => (b ? "  (registered)" : "");
  const local = d.local;
  lines.push("", `Local docs (${local.length}):`);
  for (const c of local.slice(0, max))
    lines.push(
      `- ${c.name} · ${c.path}${c.glob && c.glob.length <= 4 ? ` [${c.glob.join(", ")}]` : ""} · ${c.files} file(s) · ${kb(c.bytes)} — ${c.why}${reg(c.registered)}`,
    );
  if (local.length > max) lines.push(`  … ${local.length - max} more`);
  type P = Discovery["providers"][number];
  const groups: Array<[string, string, string, (p: P) => boolean]> = [
    [
      "catalog",
      "Third-party services and APIs with known documentation",
      "URLs known; in `recommended`",
      (p) => p.confidence === "catalog" && (p.tier ?? "library") === "service",
    ],
    [
      "probe",
      "Third-party APIs called from code",
      "documentation site is probed at add; in `recommended`",
      (p) => p.confidence === "probe",
    ],
    [
      "catalog",
      "Infrastructure the project runs on",
      'URLs known; pick "infra"',
      (p) => p.confidence === "catalog" && p.tier === "infra",
    ],
    [
      "catalog",
      "Frameworks and libraries",
      'URLs known; pick "catalog" — Claude usually knows these and their sites are large',
      (p) => p.confidence === "catalog" && (p.tier ?? "library") === "library",
    ],
    [
      "registry",
      "Packages without a catalogue entry",
      'resolved through npm / PyPI / pkg.go.dev with pick "registry"',
      (p) => p.confidence === "registry",
    ],
    [
      "unknown",
      "Env var prefixes and images nobody knows",
      "pass url to add",
      (p) => p.confidence === "unknown",
    ],
  ];
  for (const [conf, title, note, wants] of groups) {
    const list = d.providers.filter(wants);
    if (!list.length) continue;
    lines.push("", `${title} (${list.length}; ${note}):`);
    for (const p of list.slice(0, max)) {
      const used =
        p.usedBy.length > 1
          ? ` · used by ${p.usedBy.length} projects`
          : p.usedBy[0] && p.usedBy[0] !== "."
            ? ` · ${p.usedBy[0]}`
            : "";
      const where = p.urls[0] ? ` · ${p.urls[0]}` : "";
      const ev = conf === "probe" || conf === "unknown" ? ` · ${p.evidence[0]}` : "";
      lines.push(`- ${p.name} ← ${p.provider}${used}${where}${ev}${reg(p.registered)}`);
    }
    if (list.length > max) lines.push(`  … ${list.length - max} more`);
  }
  const rec =
    d.local.filter((c) => !c.registered).length +
    d.providers.filter(
      (p) =>
        !p.registered &&
        (p.confidence === "probe" ||
          (p.confidence === "catalog" && (p.tier ?? "library") === "service")),
    ).length;
  const rest = d.providers.filter(
    (p) => !p.registered && p.confidence !== "unknown" && p.confidence !== "probe",
  ).length;
  lines.push(
    "",
    rec || rest
      ? `Next: em_docs {action:"add", pick:"recommended"} registers and indexes the local docs, third-party services and APIs above (${rec} candidates, a few pages each). Frameworks, infrastructure and registry packages stay out unless asked: pick "infra" | "catalog" | "registry" | "all", or names:[…]. Unknown ones: em_docs {action:"add", name, url}.`
      : 'Everything found is already registered. em_docs {action:"sync"} refreshes; em_docs {action:"lookup", query} answers from the index.',
  );
  return lines.join("\n");
}

export const emDocs = defineTool({
  name: "em_docs",
  description:
    "The project's documentation knowledge base (manifest .eminiar/docs.json, committed). `discover` scans the project for local docs, specs and instructions plus the third-party libraries, services, infrastructure and APIs it calls, and maps them to their documentation. `add` registers sources (by url, path, provider or a discovery `pick`) and crawls/indexes them under `docs:<name>`; `sync` refreshes; `lookup` answers a question from the indexed documentation — use it before WebFetch/WebSearch for anything the project depends on. `list`, `remove`, `resolve` manage the set.",
  schema: {
    action: z.enum(["discover", "add", "remove", "list", "sync", "lookup", "resolve"]),
    ...sourceShape,
    names: z
      .array(z.string())
      .optional()
      .describe("sync/remove: which sources; add with pick: which candidates"),
    sources: z.array(z.object(sourceShape)).optional().describe("add: several sources at once"),
    pick: z
      .enum(PICKS as [Pick, ...Pick[]])
      .optional()
      .describe(
        "add: take candidates from a fresh discovery — recommended = local docs + third-party services + APIs found in code (small); infra | catalog | registry | all widen it",
      ),
    sync: z.boolean().optional().describe("add: index right away (default true)"),
    force: z
      .boolean()
      .optional()
      .describe(
        "sync: refetch ignoring the cache and drop stale pages; add with pick: also refresh already-registered candidates (new URLs, crawl budgets)",
      ),
    include_dev: z.boolean().optional().describe("discover: also devDependencies"),
    subprojects: z
      .boolean()
      .optional()
      .describe("discover: scan one level of sub-projects (default from config)"),
    query: z.string().optional(),
    queries: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    max_tokens: z.number().int().min(100).max(20_000).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = getStorage(ctx);
    const done = (out: string) => {
      recordStat(ctx, "em_docs", {
        rawChars: out.length,
        returnedChars: out.length,
        durationMs: Date.now() - started,
      });
      return text(out);
    };
    try {
      switch (args.action) {
        case "discover": {
          const d = discoverDocs(ctx, {
            includeDev: args.include_dev,
            subprojects: args.subprojects,
          });
          const out = formatDiscovery(d);
          const raw = JSON.stringify(d).length;
          recordStat(ctx, "em_docs", {
            rawChars: raw,
            returnedChars: out.length,
            durationMs: Date.now() - started,
          });
          return text(out);
        }
        case "add": {
          if (args.pick) {
            const o = await addPicked(ctx, db, args.pick, {
              names: args.names,
              includeDev: args.include_dev,
              subprojects: args.subprojects,
              sync: args.sync,
              force: args.force,
            });
            return done(formatAdd(o));
          }
          const inputs: AddInput[] = [];
          if (args.sources?.length) inputs.push(...args.sources.map(toInput));
          if (args.url || args.urls?.length || args.path || args.provider)
            inputs.push(toInput(args));
          if (!inputs.length)
            return errorResult("add needs url/urls, path, provider, sources[] or pick");
          const o = await addDocSources(ctx, db, inputs, { sync: args.sync, force: args.force });
          return done(formatAdd(o));
        }
        case "remove": {
          const names = [...(args.name ? [args.name] : []), ...(args.names ?? [])];
          if (!names.length) return errorResult("remove needs `name` or `names`");
          // An orphaned source (pages in the index, no manifest entry) is removable too; a name
          // that is neither registered nor indexed is an error.
          let unknown = 0;
          const lines = names.map((n) => {
            const r = removeDocSource(ctx, db, n);
            if (r.removed) return `removed ${n} (${r.documents} document(s) dropped)`;
            if (r.documents) return `removed ${n} (orphaned; ${r.documents} document(s) dropped)`;
            unknown++;
            return `${n}: not registered and not in the index; em_docs {action:"list"} shows both`;
          });
          const out = lines.join("\n");
          return unknown === names.length ? errorResult(out) : done(out);
        }
        case "list": {
          const m = readManifest(ctx);
          const sourceStats = db.documentSourceStats(DOCS_PREFIX);
          const orphans = orphanedDocSources(
            db,
            m.sources.map((s) => s.name),
            sourceStats,
          );
          if (!m.sources.length) {
            const none = `no documentation sources registered (${manifestPath(ctx)}). em_docs {action:"discover"} finds local docs and the libraries, services and APIs this project uses.`;
            return done(orphans.length ? [none, "", ...formatOrphans(orphans)].join("\n") : none);
          }
          const stats = new Map(sourceStats.map((s) => [s.source, s]));
          const catalog = mergedCatalog(ctx.config.docs.catalog as CatalogEntry[]);
          const categorised = m.sources
            .map((s) => ({
              s,
              cat: docCategory(s, s.provider ? catalogForProvider(s.provider, catalog) : undefined),
            }))
            .sort(
              (a, b) =>
                categoryRank(a.cat) - categoryRank(b.cat) || a.s.name.localeCompare(b.s.name),
            );
          const lines: string[] = [];
          let lastGroup = "";
          let lastCat = "";
          for (const { s, cat } of categorised) {
            const info = categoryInfo(cat);
            if (info.group !== lastGroup) {
              if (lines.length) lines.push("");
              lines.push(`# ${GROUP_LABELS[info.group]}`);
              lastGroup = info.group;
              lastCat = "";
            }
            if (cat !== lastCat) {
              lines.push(`## ${info.label}`);
              lastCat = cat;
            }
            const st = stats.get(docsTag(s.name));
            const sync = syncState(db, s.name);
            const where =
              s.kind === "url"
                ? (s.urls ?? []).join(", ")
                : `${s.path}${s.glob ? ` [${s.glob.length <= 3 ? s.glob.join(", ") : `${s.glob.length} globs`}]` : ""}`;
            const state = sync
              ? `synced ${ago(sync.at)}${sync.errors.length ? ` · ${sync.errors.length} error(s)` : ""}`
              : "never synced";
            lines.push(
              `- ${s.name} [${s.kind}]${s.provider ? ` ← ${s.provider}` : ""}${s.tags?.length ? ` (${s.tags.join(", ")})` : ""} · ${st?.documents ?? 0} doc(s) · ${st?.chunks ?? 0} chunks · ${state} · ${where}`,
            );
          }
          if (orphans.length) lines.push("", ...formatOrphans(orphans));
          lines.push(
            "",
            `${m.sources.length} source(s)${orphans.length ? ` + ${orphans.length} orphaned` : ""}; em_docs {action:"lookup", query} searches them all, {action:"sync"} refreshes.`,
          );
          return done(lines.join("\n"));
        }
        case "sync": {
          const names = [...(args.name ? [args.name] : []), ...(args.names ?? [])];
          const r = await syncSources(ctx, db, names.length ? names : undefined, {
            force: args.force,
          });
          return done(
            r.length
              ? formatSync(r)
              : 'no documentation sources registered; run em_docs {action:"discover"} first',
          );
        }
        case "resolve": {
          if (!args.provider) return errorResult("resolve needs `provider`");
          const r = await resolveProvider(args.provider);
          return done(
            r.urls.length
              ? `${r.provider} → ${r.title}\n${r.urls.map((u) => `  ${u}`).join("\n")}\n(via ${r.via}${r.crawl ? `, crawl depth ${r.crawl.depth ?? 1}` : ""})`
              : `${r.provider}: ${r.notes ?? "unresolved"}`,
          );
        }
        case "lookup": {
          const queries = [...(args.query ? [args.query] : []), ...(args.queries ?? [])];
          if (!queries.length) return errorResult("lookup needs `query` or `queries`");
          const m = readManifest(ctx);
          if (!m.sources.length && !db.documentSourceStats(DOCS_PREFIX).length)
            return done(
              'no documentation indexed yet. em_docs {action:"discover"} then {action:"add", pick:"recommended"} builds the knowledge base.',
            );
          if (args.name && !m.sources.some((s) => s.name === args.name))
            return errorResult(
              `unknown documentation source "${args.name}"; em_docs {action:"list"} shows them`,
            );
          const vectorSearch = await vectorRanker(ctx, db);
          const responses: SearchResponse[] = [];
          let raw = 0;
          for (const q of queries) {
            const r = await search(db, q, {
              limit: args.limit ?? ctx.config.search.defaultLimit,
              vectorSearch,
              filters: args.name ? { source: docsTag(args.name) } : { sourcePrefix: DOCS_PREFIX },
            });
            raw += r.hits.reduce((n, h) => n + h.chunk.body.length, 0);
            responses.push(r);
          }
          let out = formatResults(responses, args.max_tokens ?? ctx.config.search.defaultMaxTokens);
          // Pages whose source lost its manifest entry still rank (ranking is untouched); say so,
          // since nothing refreshes them until they are re-registered or removed.
          const hitSources = new Set(
            responses.flatMap((r) => r.hits.map((h) => h.chunk.document.source)),
          );
          const orphaned = orphanedDocSources(
            db,
            m.sources.map((s) => s.name),
          ).filter((o) => hitSources.has(docsTag(o.name)));
          if (orphaned.length)
            out += `\n\nnote: ${orphaned.map((o) => o.name).join(", ")} ${orphaned.length === 1 ? "is" : "are"} not in the manifest (orphaned pages); em_docs {action:"list"} explains`;
          recordStat(ctx, "em_docs", {
            rawChars: raw,
            returnedChars: out.length,
            durationMs: Date.now() - started,
          });
          return text(out);
        }
      }
    } catch (err) {
      return errorResult((err as Error).message);
    }
    return errorResult(`unknown action ${String(args.action)}`);
  },
});
