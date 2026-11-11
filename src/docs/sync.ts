import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { kickEmbedding } from "../embeddings/queue.js";
import { type Fetched, fetchMarkdown } from "../fetch/fetcher.js";
import { indexContent, indexPath, refuseOutside } from "../index/indexer.js";
import { checkRead, loadPermissionRules, type ReadCheck } from "../permissions/settings.js";
import { readRefusal } from "../sandbox/file.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { syncDocsGraphQuietly } from "./graph.js";
import {
  clearSyncState,
  type DocSource,
  docsTag,
  manifestPath,
  probeManifestAt,
  setSyncState,
  within,
} from "./manifest.js";
import { looksLikeSpec, specToMarkdown } from "./specs.js";

export interface SyncResult {
  name: string;
  kind: DocSource["kind"];
  /** Pages fetched or files scanned. */
  pages: number;
  indexed: number;
  unchanged: number;
  cached: number;
  chunks: number;
  skipped: number;
  /** OpenAPI documents / Postman collections rendered per operation. */
  specs: number;
  /** Pages cut at docs.crawl.maxPageBytes. */
  truncated: number;
  errors: string[];
  ms: number;
}

export interface SyncOptions {
  force?: boolean | undefined;
  concurrency?: number | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetchMarkdown | undefined;
  onPage?: ((url: string, line: string) => void) | undefined;
}

const SKIP_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|zip|gz|tgz|tar|pdf|woff2?|ttf|otf|eot|mp4|mp3|webm|xml|rss|atom|wasm)$/i;

/** The part of a seed's path that crawled links must stay under. */
export function scopeOf(seed: URL): string {
  const p = seed.pathname;
  if (p.endsWith("/")) return p;
  const last = p.slice(p.lastIndexOf("/") + 1);
  // `/docs/api.html` → `/docs/`; `/reference/react` → `/reference/react` (a section prefix)
  return last.includes(".") ? p.slice(0, p.lastIndexOf("/") + 1) : p;
}

export function normalizeUrl(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Links in turndown-style markdown: `[text](href)`, `<https://…>`; images are skipped by extension later. */
export function extractLinks(markdown: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const u = normalizeUrl(m[1]!, base);
    if (u) out.add(u);
  }
  for (const m of markdown.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
    const u = normalizeUrl(m[1]!, base);
    if (u) out.add(u);
  }
  return [...out];
}

/** Keep the first `max` bytes of a page; a reference page can run to megabytes. */
function capBytes(markdown: string, max: number, r: SyncResult): string {
  if (markdown.length <= max) return markdown;
  r.truncated++;
  return `${markdown.slice(0, max)}\n\n… (page truncated at ${Math.round(max / 1024)} KB; raise docs.crawl.maxPageBytes to keep more)`;
}

/** Documentation is lexical-only unless `docs.embed` is on: mark its chunks so no model work is queued. */
function skipEmbedding(db: StorageAdapter, tag: string): void {
  for (const doc of db.documentsBySource(tag, 100_000)) {
    const ids = db
      .chunksOfDocument(doc.id)
      .filter((c) => !c.embedded)
      .map((c) => c.id);
    if (ids.length) db.markEmbedded(ids);
  }
}

function inScope(url: string, scopes: Array<{ origin: string; prefix: string }>): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (SKIP_EXT.test(u.pathname)) return false;
  return scopes.some((s) => u.origin === s.origin && u.pathname.startsWith(s.prefix));
}

async function syncUrlSource(
  ctx: ProjectContext,
  db: StorageAdapter,
  src: DocSource,
  r: SyncResult,
  opts: SyncOptions,
): Promise<void> {
  const tag = docsTag(src.name);
  const depthMax = src.crawl?.depth ?? ctx.config.docs.crawl.depth;
  const maxPages = src.crawl?.maxPages ?? ctx.config.docs.crawl.maxPages;
  const ttlMs = (src.ttlHours ?? ctx.config.docs.ttlHours) * 3600 * 1000;
  const fetchPage = opts.fetchImpl ?? fetchMarkdown;
  const seeds = (src.urls ?? []).map((u) => normalizeUrl(u, u)).filter((u): u is string => !!u);
  const scopes = seeds.map((s) => {
    const u = new URL(s);
    return { origin: u.origin, prefix: scopeOf(u) };
  });
  if (opts.force) db.deleteDocumentsBySource(tag);

  const queue: Array<{ url: string; depth: number }> = seeds.map((url) => ({ url, depth: 0 }));
  const seen = new Set(seeds);
  let claimed = 0;
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      if (claimed >= maxPages) return;
      claimed++;
      let f: Fetched;
      try {
        f = await fetchPage(next.url, { ttlMs, force: opts.force ?? false, timeoutMs: 15_000 });
      } catch (err) {
        r.errors.push(`${next.url}: ${(err as Error).message}`);
        continue;
      }
      r.pages++;
      if (f.cached) r.cached++;
      if (f.status && f.status >= 400) {
        r.errors.push(`${next.url}: HTTP ${f.status}`);
        continue;
      }
      if (!f.markdown.trim()) {
        r.skipped++;
        continue;
      }
      // An OpenAPI document or Postman collection is rendered one section per operation.
      const spec = looksLikeSpec(next.url, f.markdown) ? specToMarkdown(f.markdown) : undefined;
      if (spec) r.specs++;
      const ir = indexContent(db, {
        source: tag,
        title: spec
          ? `${spec.title} (${next.url})`
          : f.title
            ? `${f.title} (${next.url})`
            : next.url,
        uri: next.url,
        content: capBytes(spec?.markdown ?? f.markdown, ctx.config.docs.crawl.maxPageBytes, r),
        kind: "markdown",
        meta: {
          docs: src.name,
          url: next.url,
          depth: next.depth,
          ...(spec ? { spec: spec.kind, operations: spec.operations } : {}),
        },
      });
      if (ir.created) r.indexed++;
      else r.unchanged++;
      r.chunks += ir.chunks;
      opts.onPage?.(next.url, `${f.cached ? "cached" : "fetched"} · ${ir.chunks} chunks`);
      if (next.depth < depthMax && !spec) {
        for (const link of extractLinks(f.markdown, next.url)) {
          if (seen.has(link) || !inScope(link, scopes)) continue;
          seen.add(link);
          queue.push({ url: link, depth: next.depth + 1 });
        }
      }
    }
  };
  // Workers re-check the queue after each page, so links found late are still crawled.
  const n = Math.max(1, Math.min(opts.concurrency ?? 3, maxPages));
  let active = true;
  while (active) {
    await Promise.all(Array.from({ length: n }, worker));
    active = queue.length > 0 && claimed < maxPages;
  }
}

/**
 * An IndexPathOptions.refuse for committed or configured doc globs: files must stay inside the
 * project once symlinks are resolved, and Claude Code's Read deny/ask rules apply per file as
 * they do for em_index, so a denied `.env` is never indexed.
 */
export function refuseUnreadable(ctx: ProjectContext): (file: string) => string | undefined {
  const rules = loadPermissionRules(ctx.root);
  const realRoot = realpathSync.native(ctx.root);
  const denied = (c: ReadCheck) => `refused by permission rule ${c.rule} (${c.kind})`;
  return (file) => {
    // The path as written first: a pure regex test, no syscalls, and the common refusal.
    const asWritten = checkRead(rules, [file]);
    if (!asWritten.allowed) return denied(asWritten);
    let real: string;
    let native: string;
    try {
      real = realpathSync(file);
      native = realpathSync.native(file);
    } catch {
      return undefined; // gone since the walk: the reader reports it
    }
    if (!within(native, realRoot)) return "refused, it resolves outside the project";
    // Then its symlink target and on-disk letter case, when they differ (see checkReadPath).
    const more = [real, native].filter((p, i, a) => p !== file && a.indexOf(p) === i);
    if (!more.length) return undefined;
    const c = checkRead(rules, more);
    return c.allowed ? undefined : denied(c);
  };
}

/** Returns false when the source was refused (its sync state is cleared, not recorded). */
function syncPathSource(
  ctx: ProjectContext,
  db: StorageAdapter,
  src: DocSource,
  r: SyncResult,
  opts: SyncOptions,
): boolean {
  const tag = docsTag(src.name);
  // The manifest is committed: its path, and every file a directory walk finds, must stay
  // inside the project once symlinks are resolved and pass the Read rules.
  const refuse = refuseUnreadable(ctx);
  const target = src.path as string;
  const abs = resolve(ctx.root, target);
  const refused =
    refuseOutside(ctx.root)(abs) ?? readRefusal(loadPermissionRules(ctx.root), abs, target);
  if (refused) {
    // What this source indexed before (e.g. by a version without this check) goes too.
    db.deleteDocumentsBySource(tag);
    clearSyncState(db, src.name);
    r.skipped = 1;
    r.errors.push(`${target}: ${refused}`);
    return false;
  }
  if (opts.force) db.deleteDocumentsBySource(tag);
  const s = indexPath(db, ctx.root, target, {
    source: tag,
    globs: src.glob ?? ctx.config.index.docs,
    recursive: true,
    refuse,
    transform: (content, rel) => {
      const max = ctx.config.docs.crawl.maxPageBytes;
      if (!looksLikeSpec(rel, content))
        return content.length > max ? { content: capBytes(content, max, r) } : undefined;
      const spec = specToMarkdown(content);
      if (!spec) return content.length > max ? { content: capBytes(content, max, r) } : undefined;
      r.specs++;
      return { content: capBytes(spec.markdown, max, r), title: spec.title, kind: "markdown" };
    },
  });
  r.pages = s.files;
  r.indexed = s.indexed;
  r.unchanged = s.unchanged;
  r.chunks = s.chunks;
  r.skipped = s.skipped.length;
  r.errors.push(...s.skipped.slice(0, 5).map((k) => `${k.path}: ${k.reason}`));
  return true;
}

/** Fetch/scan one source and (re)index it under `docs:<name>`; records the outcome in the DB. */
export async function syncSource(
  ctx: ProjectContext,
  db: StorageAdapter,
  src: DocSource,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const started = Date.now();
  const r: SyncResult = {
    name: src.name,
    kind: src.kind,
    pages: 0,
    indexed: 0,
    unchanged: 0,
    cached: 0,
    chunks: 0,
    skipped: 0,
    specs: 0,
    truncated: 0,
    errors: [],
    ms: 0,
  };
  let recorded = true;
  try {
    if (src.kind === "url") await syncUrlSource(ctx, db, src, r, opts);
    else recorded = syncPathSource(ctx, db, src, r, opts);
  } catch (err) {
    r.errors.push((err as Error).message);
  }
  if (!ctx.config.docs.embed) skipEmbedding(db, docsTag(src.name));
  r.ms = Date.now() - started;
  if (!recorded) return r;
  setSyncState(db, src.name, {
    at: Date.now(),
    pages: r.pages,
    documents: db.countDocuments(docsTag(src.name)),
    chunks: r.chunks,
    errors: r.errors.slice(0, 10),
    skipped: r.skipped,
    ms: r.ms,
  });
  if (ctx.config.docs.embed) kickEmbedding(ctx, db);
  return r;
}

/** Sync every registered source, or only `names`. Unknown names are reported as errors. */
export async function syncSources(
  ctx: ProjectContext,
  db: StorageAdapter,
  names?: string[] | undefined,
  opts: SyncOptions = {},
): Promise<SyncResult[]> {
  // readManifest, plus the entries it dropped for a path outside the project.
  const p = probeManifestAt(manifestPath(ctx), { root: ctx.root });
  const m = p.state === "ok" ? p.manifest : { version: 1 as const, sources: [] };
  const outside = new Set(p.state === "ok" ? (p.outside ?? []) : []);
  const registered = (name: string) => m.sources.some((s) => s.name === name);
  const wanted = names?.length ? m.sources.filter((s) => names.includes(s.name)) : m.sources;
  const out: SyncResult[] = [];
  const failed = (name: string, kind: DocSource["kind"], error: string): SyncResult => ({
    name,
    kind,
    pages: 0,
    indexed: 0,
    unchanged: 0,
    cached: 0,
    chunks: 0,
    skipped: 0,
    specs: 0,
    truncated: 0,
    errors: [error],
    ms: 0,
  });
  for (const name of names ?? [])
    if (!registered(name) && !outside.has(name)) out.push(failed(name, "url", "not registered"));
  // Such an entry indexes nothing, and what an earlier version indexed for it goes too, so a
  // hand-edited `../docs` is reported on every sync rather than served from old pages.
  for (const name of outside) {
    if (registered(name) || (names?.length && !names.includes(name))) continue;
    const removed = db.deleteDocumentsBySource(docsTag(name));
    if (removed) clearSyncState(db, name);
    const note = removed ? `; ${removed} earlier page(s) removed` : "";
    out.push(failed(name, "path", `ignored: its path is outside the project${note}`));
  }
  for (const src of wanted) out.push(await syncSource(ctx, db, src, opts));
  // Pages just (re)indexed may name different code files: refresh the doc nodes' edges.
  syncDocsGraphQuietly(ctx, db);
  return out;
}

export function formatSync(results: SyncResult[]): string {
  return results
    .map((r) => {
      const bits = [
        `${r.pages} ${r.kind === "url" ? "page(s)" : "file(s)"}`,
        `${r.indexed} indexed`,
        `${r.unchanged} unchanged`,
        ...(r.cached ? [`${r.cached} from cache`] : []),
        `${r.chunks} chunks`,
        ...(r.specs ? [`${r.specs} API spec(s) rendered per operation`] : []),
        ...(r.truncated ? [`${r.truncated} page(s) truncated`] : []),
        ...(r.skipped ? [`${r.skipped} skipped`] : []),
        `${r.ms} ms`,
      ];
      const errs = r.errors.length
        ? `\n  ${r.errors.slice(0, 5).join("\n  ")}${r.errors.length > 5 ? `\n  … ${r.errors.length - 5} more` : ""}`
        : "";
      return `${r.name}: ${bits.join(" · ")}${errs}`;
    })
    .join("\n");
}
