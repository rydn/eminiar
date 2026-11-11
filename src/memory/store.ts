import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import fg from "fast-glob";
import { hashText } from "../chunker/types.js";
import type { ProjectContext } from "../context.js";
import { within } from "../docs/manifest.js";
import { memoryId } from "../graph/ids.js";
import { indexContent } from "../index/indexer.js";
import type { StorageAdapter } from "../storage/adapter.js";
import {
  type GraphEdge,
  MEMORY_STATUSES,
  type MemoryRow,
  type MemoryStatus,
} from "../storage/types.js";
import { type MemoryMeta, parseMemoryFile, serializeMemoryFile } from "./frontmatter.js";

export { MEMORY_STATUSES };

export function isStatus(s: unknown): s is MemoryStatus {
  return typeof s === "string" && (MEMORY_STATUSES as readonly string[]).includes(s);
}

/**
 * Memories are markdown files under `<project>/<memories.dir>/<topic>/<name>.md`
 * (Serena-style: named, human-editable, git-shareable). The database only mirrors
 * them: a `memories` row per file (hash/mtime/size for cheap change detection), an
 * indexed document (`memory:<name>`) for hybrid search, and a `memory:` graph node
 * with `mentions` edges to the files/symbols the memory is about. The file always
 * wins: `reconcile()` re-imports anything edited, added or removed by hand.
 */
export const MEMORY_KINDS = [
  "decision",
  "constraint",
  "fact",
  "preference",
  "todo",
  "note",
  "onboarding",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

const SEGMENT = "[a-z0-9][a-z0-9._-]*";
/** `slug` or `topic/slug`, lowercase, safe on every filesystem. */
export const NAME_RE = new RegExp(`^(?:${SEGMENT}/)?${SEGMENT}$`);

export function isValidName(name: string): boolean {
  return name.length <= 120 && NAME_RE.test(name);
}

/**
 * Throws unless `name` is a valid memory name. The name becomes the file path (relOf), so every
 * entry point that takes one from a caller (tools, dashboard, CLI) checks it here first:
 * `../../x` would otherwise read, rewrite or delete any .md file the process can reach.
 */
function assertValidName(name: string): void {
  if (!isValidName(name))
    throw new Error(
      `invalid memory name "${name}": use lowercase slug or topic/slug with [a-z0-9._-], e.g. auth/session-tokens`,
    );
}

export function isKind(k: unknown): k is MemoryKind {
  return typeof k === "string" && (MEMORY_KINDS as readonly string[]).includes(k);
}

/** Project-relative memories directory (forward slashes, no trailing slash). */
export function memoriesRel(ctx: ProjectContext): string {
  return ctx.config.memories.dir.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function memoriesDir(ctx: ProjectContext): string {
  return join(ctx.root, memoriesRel(ctx));
}

/** Project-relative path of a memory file (forward slashes, as stored in rows and graph nodes). */
export function relOf(ctx: ProjectContext, name: string): string {
  return `${memoriesRel(ctx)}/${name}.md`;
}

function absOf(ctx: ProjectContext, name: string): string {
  return join(ctx.root, relOf(ctx, name));
}

type RealPath = (p: string) => string;

/** realpathSync.native, cached in `memo` across the files of one call (few folders, many files). */
function realPaths(memo: Map<string, string>): RealPath {
  return (p) => {
    let r = memo.get(p);
    if (r === undefined) {
      r = realpathSync.native(p);
      memo.set(p, r);
    }
    return r;
  };
}

/**
 * Where `abs` really is: its target when it is a symlink, otherwise below the realpath of its
 * nearest existing folder (the one a write would create it in), so a regular file costs an lstat
 * and its folder's cached realpath. Throws when that does not resolve (dangling, a loop).
 */
function realLocation(abs: string, real: RealPath): string {
  if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) return real(abs);
  // lstat, so a dangling folder link stops the walk and fails realpath instead of being created.
  let dir = dirname(abs);
  while (!lstatSync(dir, { throwIfNoEntry: false }) && dirname(dir) !== dir) dir = dirname(dir);
  return join(real(dir), relative(dir, abs));
}

/** The memories folder once symlinks are resolved, or undefined when that leaves the project. */
function memoriesBound(ctx: ProjectContext, real: RealPath): string | undefined {
  const configured = memoriesDir(ctx);
  // An existing folder by its on-disk name: on a case-insensitive filesystem `.eminiar/Memories`
  // is the folder `memories`, and the files below it resolve to that spelling.
  const dir = lstatSync(configured, { throwIfNoEntry: false })
    ? real(configured)
    : realLocation(configured, real);
  return within(dir, real(ctx.root)) ? dir : undefined;
}

/**
 * `abs` stays inside the memories folder once symlinks are resolved, and that folder inside the
 * project. A memories folder linked to another folder of the project works; a topic or file link
 * anywhere else (`rules.md -> ../../CLAUDE.md`, a topic -> src/ or ~) cannot lead a read, a
 * header repair or a write to a file that is not a memory.
 */
function insideMemories(
  ctx: ProjectContext,
  abs: string,
  memo: Map<string, string> = new Map(),
): boolean {
  const real = realPaths(memo);
  try {
    const bound = memoriesBound(ctx, real);
    if (bound === undefined) return false;
    // The folder itself is `bound` (by its on-disk name), however its configured spelling reads.
    return abs === memoriesDir(ctx) || within(realLocation(abs, real), bound);
  } catch {
    return false; // dangling, a loop, or gone since it was listed
  }
}

/** Throws unless memory `name` is a valid name whose file stays inside the memories folder. */
function assertMemoryPath(ctx: ProjectContext, name: string): void {
  assertValidName(name);
  if (!insideMemories(ctx, absOf(ctx, name)))
    throw new Error(
      `memory "${name}" is dangling or outside the memories folder (a symlink under ${memoriesRel(ctx)}); refusing to touch it`,
    );
}

/** The memory name a `supersedes` value names: `mem:` / `memory:` prefixes are accepted. */
function supersededName(v: string | undefined): string | undefined {
  return v?.replace(/^mem(?:ory)?:/, "");
}

/** The name a file under the memories dir denotes, or undefined when it is not a valid one. */
function nameOfFile(ctx: ProjectContext, abs: string): string | undefined {
  const rel = relative(memoriesDir(ctx), abs).split(sep).join("/");
  if (!rel.endsWith(".md")) return undefined;
  const name = rel.slice(0, -3);
  return isValidName(name) ? name : undefined;
}

/** Lowercase, hyphenated, cut at a word boundary near `max` characters. */
export function slugify(s: string, max = 48): string {
  let slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > max) {
    const cut = slug.lastIndexOf("-", max);
    slug = slug.slice(0, cut > max / 2 ? cut : max);
  }
  return slug.replace(/-+$/, "") || "memory";
}

/** `<kind>/<slug of the first words>`, suffixed with -2, -3… when taken. */
export function autoName(db: StorageAdapter, kind: string, content: string): string {
  const base = `${kind}/${slugify(content)}`;
  if (!db.memoryGetByName(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base}-${i}`;
    if (!db.memoryGetByName(n)) return n;
  }
  return `${base}-${Date.now()}`;
}

function arr(v: string | string[] | undefined): string[] {
  return Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
}

function str(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Graph ids a memory is about: `file:` paths lose a leading ./, duplicates collapse. */
export function normalizeRelated(ids: string[]): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id) continue;
    out.add(id.startsWith("file:") ? `file:${id.slice(5).replace(/^\.\//, "")}` : id);
  }
  return [...out];
}

/**
 * The graph node a `related:` entry points at. Memories name other memories as
 * `mem:<name>` (the prefix their bodies link with too) while the node is
 * `memory:<name>`; without this the edge targeted a node that never exists.
 */
export function relatedTarget(id: string): string {
  return id.startsWith("mem:") ? memoryId(id.slice(4)) : id;
}

/** `mem:<name>` anywhere in a body: bare, in backticks or as a markdown link target. */
const MEM_LINK_RE = /(?<![A-Za-z0-9_./-])mem:([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)/g;

/**
 * Memory names a body links to with `mem:<name>`. A trailing `.` or `-` ends a
 * sentence rather than the name; invalid names and the memory itself are dropped.
 */
export function memoryLinks(body: string, self?: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MEM_LINK_RE)) {
    const name = m[1]!.replace(/[.-]+$/, "");
    if (name && name !== self && isValidName(name)) out.add(name);
  }
  return [...out];
}

/** A project path as prose writes it: `src/a/b.ts`, `./docs/x.md`, `.eminiar/docs.json`. */
const PATH_RE =
  /(?<![\w/.-])(?:\.\/)?((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?![\w/-])/g;

/**
 * Files a body names by path that exist in the project, as `file:` ids: the links a
 * memory implies without a `related:` header, so file recall and impact analysis find
 * it. Memory files themselves are left out (`mem:` links cover those).
 */
export function impliedFileLinks(root: string, body: string, skipPrefix?: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(PATH_RE)) {
    const p = m[1]!.replace(/[.,;:)]+$/, "");
    if (!p || p.startsWith("..") || out.has(p) || (skipPrefix && p.startsWith(`${skipPrefix}/`)))
      continue;
    try {
      if (statSync(join(root, p)).isFile()) out.add(p);
    } catch {
      // not a project file (a URL path, an example, a file that no longer exists)
    }
    if (out.size >= 30) break;
  }
  return [...out].map((p) => `file:${p}`);
}

export interface MemoryFile {
  name: string;
  kind: string;
  status?: string | undefined;
  supersedes?: string | undefined;
  tags: string[];
  related: string[];
  created: string;
  updated: string;
  body: string;
  /** Project-relative path. */
  path: string;
  row: MemoryRow;
}

function writeMemoryFile(ctx: ProjectContext, name: string, meta: MemoryMeta, body: string): void {
  const abs = absOf(ctx, name);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, serializeMemoryFile(meta, `\n${body.trim()}\n`));
}

interface GraphInput {
  kind: string;
  tags: string[];
  related: string[];
  /** Files the body names by path (not in the header): mentions edges at lower confidence. */
  implied?: string[] | undefined;
  status?: string | undefined;
  supersedes?: string | undefined;
  body: string;
}

function syncGraph(db: StorageAdapter, name: string, rel: string, g: GraphInput): void {
  const self = memoryId(name);
  db.graphDeleteForPath("curated", rel);
  db.graphUpsertNodes([
    {
      id: self,
      kind: "memory",
      name,
      path: rel,
      source: "curated",
      meta: { kind: g.kind, tags: g.tags, ...(g.status ? { status: g.status } : {}) },
    },
  ]);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const push = (dst: string, kind: string, confidence = 1) => {
    const key = `${kind}|${dst}`;
    if (dst === self || seen.has(key)) return;
    seen.add(key);
    edges.push({ src: self, dst, kind, source: "curated", confidence, weight: 1 });
  };
  for (const id of g.related) push(relatedTarget(id), "mentions");
  for (const id of g.implied ?? []) push(id, "mentions", 0.6);
  // `mem:` references in the body connect memories too, as their own edge kind so a
  // header's deliberate `related:` list stays distinguishable from passing references.
  for (const other of memoryLinks(g.body, name)) push(memoryId(other), "links");
  if (g.supersedes) push(memoryId(supersededName(g.supersedes)!), "supersedes");
  if (edges.length) db.graphUpsertEdges(edges);
}

function forgetInDb(db: StorageAdapter, name: string, rel: string): void {
  db.memoryDeleteByName(name);
  db.graphDeleteForPath("curated", rel);
}

/**
 * Mirror one file into the database. Repairs the header when it is missing or
 * disagrees with the path (the path is the name: `mv` renames a memory), then
 * re-indexes, upserts the row and rebuilds the memory's graph node and edges.
 */
function syncFile(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
  opts: { force?: boolean; sessionId?: string | undefined } = {},
): { changed: boolean; row: MemoryRow } | undefined {
  const abs = absOf(ctx, name);
  const rel = relOf(ctx, name);
  if (!existsSync(abs)) return undefined;
  let st = statSync(abs);
  const row = db.memoryGetByName(name);
  const mtime = Math.floor(st.mtimeMs);
  if (!opts.force && row && row.file_mtime === mtime && row.file_size === st.size)
    return { changed: false, row };

  let text = readFileSync(abs, "utf8");
  let hash = hashText(text);
  if (!opts.force && row && row.file_hash === hash) {
    db.memoryUpsertByName({
      name,
      kind: row.kind,
      content: row.content,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
      nodeIds: row.node_ids ? (JSON.parse(row.node_ids) as string[]) : undefined,
      documentId: row.document_id ?? undefined,
      path: rel,
      fileHash: hash,
      fileMtime: mtime,
      fileSize: st.size,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
      status: row.status ?? undefined,
      supersedes: row.supersedes ?? undefined,
    });
    return { changed: false, row: db.memoryGetByName(name)! };
  }

  const parsed = parseMemoryFile(text);
  const meta = parsed.meta;
  const kind = isKind(meta.kind) ? meta.kind : "note";
  const tags = arr(meta.tags);
  const related = normalizeRelated(arr(meta.related));
  const status = isStatus(meta.status) ? meta.status : undefined;
  const supersedes = str(meta.supersedes);
  const created =
    str(meta.created) ??
    (row
      ? new Date(row.created_at).toISOString()
      : new Date(st.birthtimeMs || Date.now()).toISOString());
  const updated = str(meta.updated) ?? new Date(st.mtimeMs).toISOString();
  const needsRepair =
    !parsed.hadFrontmatter ||
    meta.name !== name ||
    meta.kind !== kind ||
    !str(meta.created) ||
    !str(meta.updated);
  if (needsRepair) {
    const fixed: MemoryMeta = { ...meta, name, kind, tags, related, created, updated };
    text = serializeMemoryFile(
      fixed,
      parsed.hadFrontmatter ? parsed.body : `\n${parsed.body.replace(/^\s*\n/, "")}`,
    );
    writeFileSync(abs, text);
    st = statSync(abs);
    hash = hashText(text);
  }
  const body = parsed.body.trim();
  const implied = impliedFileLinks(ctx.root, body, memoriesRel(ctx)).filter(
    (id) => !related.includes(id),
  );
  const doc = indexContent(db, {
    source: "memory",
    uri: `memory:${name}`,
    title: name,
    content: `${body || "(empty)"}${tags.length ? `\n\ntags: ${tags.join(", ")}` : ""}`,
    kind: "markdown",
    sessionId: opts.sessionId,
    meta: { name, kind, tags, related, path: rel, status, supersedes },
  });
  db.memoryUpsertByName({
    name,
    kind,
    content: body,
    tags,
    // the header's deliberate list first, then the files the body names
    nodeIds: [...related, ...implied],
    sessionId: opts.sessionId,
    documentId: doc.documentId,
    path: rel,
    fileHash: hash,
    fileMtime: Math.floor(st.mtimeMs),
    fileSize: st.size,
    createdAt: Date.parse(created) || Date.now(),
    updatedAt: Date.parse(updated) || Date.now(),
    status,
    supersedes,
  });
  syncGraph(db, name, rel, { kind, tags, related, implied, status, supersedes, body });
  return { changed: true, row: db.memoryGetByName(name)! };
}

/** Change header fields of a memory in place (status, supersedes …) without touching the body. */
export function setMeta(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
  patch: Record<string, string | undefined>,
): boolean {
  assertMemoryPath(ctx, name);
  const abs = absOf(ctx, name);
  if (!existsSync(abs)) return false;
  const parsed = parseMemoryFile(readFileSync(abs, "utf8"));
  const meta: MemoryMeta = { ...parsed.meta };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete meta[k];
    else meta[k] = v;
  }
  meta.updated = new Date().toISOString();
  writeFileSync(abs, serializeMemoryFile(meta, parsed.body));
  syncFile(ctx, db, name, { force: true });
  return true;
}

/**
 * Rows from before memories were files become files once; the old row and document go. A row
 * whose file would land outside the memories folder stays in the database for a later run and
 * is listed in `skipped`.
 */
function migrateLegacy(
  ctx: ProjectContext,
  db: StorageAdapter,
  skipped: string[],
  memo: Map<string, string>,
): number {
  let n = 0;
  for (const row of db.memoryLegacyRows()) {
    const kind = isKind(row.kind) ? row.kind : "note";
    const base = `${kind}/${slugify(row.content)}`;
    const taken = existsSync(absOf(ctx, base)) || !!db.memoryGetByName(base);
    const name = taken ? `${base}-${row.id}` : base;
    const created = new Date(row.created_at).toISOString();
    if (!insideMemories(ctx, absOf(ctx, name), memo)) {
      skipped.push(relOf(ctx, name));
      continue;
    }
    if (!existsSync(absOf(ctx, name))) {
      writeMemoryFile(
        ctx,
        name,
        {
          name,
          kind,
          tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
          related: normalizeRelated(row.node_ids ? (JSON.parse(row.node_ids) as string[]) : []),
          created,
          updated: created,
        },
        row.content,
      );
    }
    db.memoryDelete(row.id);
    syncFile(ctx, db, name, { force: true });
    n++;
  }
  return n;
}

export interface ReconcileSummary {
  files: number;
  synced: number;
  removed: number;
  migrated: number;
  /**
   * Files whose path is not a valid name (uppercase, spaces, nested deeper than one topic), files
   * and linked folders (listed once) that resolve outside the memories folder, and legacy rows
   * left in the database for that reason.
   */
  skipped: string[];
}

/** Bring the database in line with the files: cheap (stat per file) and safe to call often. */
export function reconcile(ctx: ProjectContext, db: StorageAdapter): ReconcileSummary {
  const out: ReconcileSummary = { files: 0, synced: 0, removed: 0, migrated: 0, skipped: [] };
  const memo = new Map<string, string>();
  out.migrated = migrateLegacy(ctx, db, out.skipped, memo);
  const dir = memoriesDir(ctx);
  const files: string[] = [];
  if (lstatSync(dir, { throwIfNoEntry: false })) {
    if (!existsSync(dir) || !insideMemories(ctx, dir, memo)) {
      // The folder itself is a dangling link or leads out of the project (often for a moment: a
      // checkout, a link being replaced). Nothing under it is read, and the rows are kept:
      // forgetting them here would drop every memory from search until the next reconcile.
      out.skipped.push(memoriesRel(ctx));
      return out;
    }
    // fast-glob follows symlinks: a top-level topic or file link that leads out of the memories
    // folder is listed once and never walked (a `x -> ~` would read every .md file in ~).
    const ignore: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (!e.isSymbolicLink() || insideMemories(ctx, abs, memo)) continue;
      out.skipped.push(relative(ctx.root, abs));
      ignore.push(fg.escapePath(e.name), `${fg.escapePath(e.name)}/**`);
    }
    // Names nest one topic deep; depth 3 still finds one level more, reported as skipped.
    // Entries rather than files only, so a dangling link (a symlink whose target is gone, which
    // fast-glob reports as a link instead of following it) is reported instead of vanishing.
    for (const e of fg.sync("**/*.md", {
      cwd: dir,
      absolute: true,
      onlyFiles: false,
      objectMode: true,
      dot: true,
      deep: 3,
      ignore,
    })) {
      if (e.dirent.isFile()) files.push(e.path);
      else if (e.dirent.isSymbolicLink()) out.skipped.push(relative(ctx.root, e.path));
    }
  }
  const seen = new Set<string>();
  for (const f of files) {
    const name = nameOfFile(ctx, f);
    if (!name || !insideMemories(ctx, f, memo)) {
      out.skipped.push(relative(ctx.root, f));
      continue;
    }
    seen.add(name);
    out.files++;
    if (syncFile(ctx, db, name)?.changed) out.synced++;
  }
  for (const row of db.memoryList({ limit: 100_000 })) {
    if (row.name && !seen.has(row.name)) {
      forgetInDb(db, row.name, row.path ?? relOf(ctx, row.name));
      out.removed++;
    }
  }
  return out;
}

export interface WriteInput {
  name?: string | undefined;
  kind: string;
  content: string;
  tags?: string[] | undefined;
  related?: string[] | undefined;
  /** Overwrite an existing memory of the same name (its created date is kept). */
  replace?: boolean | undefined;
  sessionId?: string | undefined;
  /** Decision lifecycle; a decision without one reads as accepted. */
  status?: MemoryStatus | undefined;
  /** The memory this one replaces; that one is marked superseded. */
  supersedes?: string | undefined;
}

export function write(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: WriteInput,
): {
  name: string;
  path: string;
  created: boolean;
  row: MemoryRow;
  superseded?: string | undefined;
} {
  const name = input.name?.trim() || autoName(db, input.kind, input.content);
  assertMemoryPath(ctx, name);
  const abs = absOf(ctx, name);
  const prev = db.memoryGetByName(name);
  const exists = !!prev || existsSync(abs);
  if (exists && !input.replace)
    throw new Error(
      `memory "${name}" already exists; pass replace: true to overwrite it, or em_memory {action: "edit"} to change part of it`,
    );
  const now = new Date().toISOString();
  let extra: MemoryMeta = {};
  if (exists) {
    try {
      extra = parseMemoryFile(readFileSync(abs, "utf8")).meta;
    } catch {
      // unreadable file: rewrite it from scratch
    }
  }
  const created =
    str(extra.created) ?? (prev ? new Date(prev.created_at).toISOString() : undefined) ?? now;
  const meta: MemoryMeta = {
    ...extra,
    name,
    kind: input.kind,
    tags: input.tags ?? [],
    related: normalizeRelated(input.related ?? []),
    created,
    updated: now,
  };
  if (input.status) meta.status = input.status;
  if (input.supersedes) meta.supersedes = input.supersedes;
  writeMemoryFile(ctx, name, meta, input.content);
  const r = syncFile(ctx, db, name, { force: true, sessionId: input.sessionId })!;
  // The header keeps `supersedes` as written (`mem:x` is accepted, as in syncGraph). The target is
  // marked only when this write sets or changes the name, so re-saving the memory (the dashboard
  // passes it back on every edit) never rewrites the target or undoes a status set on it since.
  // An invalid name, or one whose file is outside the memories folder, is stored but not marked:
  // the memory is already written, so this stays a quiet no-op rather than a throw.
  const sup = supersededName(input.supersedes);
  let superseded: string | undefined;
  if (
    sup &&
    sup !== name &&
    sup !== supersededName(str(extra.supersedes)) &&
    isValidName(sup) &&
    insideMemories(ctx, absOf(ctx, sup)) &&
    setMeta(ctx, db, sup, { status: "superseded" })
  )
    superseded = sup;
  return { name, path: relOf(ctx, name), created: !exists, row: r.row, superseded };
}

export function read(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
): MemoryFile | undefined {
  assertMemoryPath(ctx, name);
  const synced = syncFile(ctx, db, name);
  if (!synced) return undefined;
  const parsed = parseMemoryFile(readFileSync(absOf(ctx, name), "utf8"));
  return {
    name,
    kind: synced.row.kind,
    status: str(parsed.meta.status),
    supersedes: str(parsed.meta.supersedes),
    tags: arr(parsed.meta.tags),
    related: normalizeRelated(arr(parsed.meta.related)),
    created: str(parsed.meta.created) ?? new Date(synced.row.created_at).toISOString(),
    updated: str(parsed.meta.updated) ?? "",
    body: parsed.body.trim(),
    path: relOf(ctx, name),
    row: synced.row,
  };
}

/** Rows, most recently updated first, with onboarding memories ahead of the rest. */
export function list(
  ctx: ProjectContext,
  db: StorageAdapter,
  opts: {
    topic?: string | undefined;
    kind?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  } = {},
): MemoryRow[] {
  void ctx;
  const rows = db.memoryList({ ...opts, limit: opts.limit ?? 100 }).filter((r) => r.name);
  return rows.sort((a, b) => Number(b.kind === "onboarding") - Number(a.kind === "onboarding"));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace `find` (literal, or a regex with `regex: true`) in the body only; returns the count. */
export function edit(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
  opts: { find: string; replace: string; regex?: boolean | undefined },
): number {
  assertMemoryPath(ctx, name);
  const abs = absOf(ctx, name);
  if (!existsSync(abs)) throw new Error(`memory "${name}" does not exist`);
  syncFile(ctx, db, name);
  const parsed = parseMemoryFile(readFileSync(abs, "utf8"));
  const re = new RegExp(opts.regex ? opts.find : escapeRe(opts.find), "g");
  const count = (parsed.body.match(re) ?? []).length;
  if (!count) return 0;
  const body = parsed.body.replace(re, opts.replace);
  writeFileSync(
    abs,
    serializeMemoryFile({ ...parsed.meta, updated: new Date().toISOString() }, body),
  );
  syncFile(ctx, db, name, { force: true });
  return count;
}

/** Move a memory to a new name; `mem:<old>` references in other memories follow. */
export function rename(
  ctx: ProjectContext,
  db: StorageAdapter,
  from: string,
  to: string,
): { refsUpdated: number } {
  assertMemoryPath(ctx, from);
  assertMemoryPath(ctx, to);
  const absFrom = absOf(ctx, from);
  const absTo = absOf(ctx, to);
  if (!existsSync(absFrom)) throw new Error(`memory "${from}" does not exist`);
  if (existsSync(absTo) || db.memoryGetByName(to)) throw new Error(`memory "${to}" already exists`);
  mkdirSync(dirname(absTo), { recursive: true });
  renameSync(absFrom, absTo);
  const parsed = parseMemoryFile(readFileSync(absTo, "utf8"));
  writeFileSync(
    absTo,
    serializeMemoryFile(
      { ...parsed.meta, name: to, updated: new Date().toISOString() },
      parsed.body,
    ),
  );
  forgetInDb(db, from, relOf(ctx, from));
  syncFile(ctx, db, to, { force: true });

  let refsUpdated = 0;
  const ref = new RegExp(`mem:${escapeRe(from)}(?![a-z0-9._/-])`, "g");
  const memo = new Map<string, string>();
  for (const row of db.memoryList({ limit: 100_000 })) {
    if (!row.name || row.name === to) continue;
    const abs = absOf(ctx, row.name);
    // A row's file may have become a link out of the memories folder since it was imported.
    if (!existsSync(abs) || !insideMemories(ctx, abs, memo)) continue;
    const text = readFileSync(abs, "utf8");
    if (!ref.test(text)) continue;
    ref.lastIndex = 0;
    writeFileSync(abs, text.replace(ref, `mem:${to}`));
    syncFile(ctx, db, row.name, { force: true });
    refsUpdated++;
  }
  return { refsUpdated };
}

/** `abs` is a symlink whose target does not exist. */
function danglingLink(abs: string): boolean {
  return !!lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(abs);
}

/** Delete the file and everything mirrored from it. */
export function remove(ctx: ProjectContext, db: StorageAdapter, name: string): boolean {
  assertValidName(name);
  const abs = absOf(ctx, name);
  // A dangling link (its target is gone) may go: unlink removes the link, never a target, as long
  // as the folder holding it is inside the memories folder. reconcile lists such links in skipped.
  if (danglingLink(abs) && insideMemories(ctx, dirname(abs))) {
    unlinkSync(abs);
    forgetInDb(db, name, relOf(ctx, name));
    return true;
  }
  assertMemoryPath(ctx, name);
  const existed = existsSync(abs) || !!db.memoryGetByName(name);
  if (existsSync(abs)) unlinkSync(abs);
  forgetInDb(db, name, relOf(ctx, name));
  return existed;
}

const hinted = new Set<string>();

/** One-time note when the project's .gitignore would keep the memories out of git. */
export function gitignoreHint(ctx: ProjectContext): string | undefined {
  if (hinted.has(ctx.root)) return undefined;
  hinted.add(ctx.root);
  const file = join(ctx.root, ".gitignore");
  if (!existsSync(file)) return undefined;
  const dir = memoriesRel(ctx);
  const top = dir.split("/")[0]!;
  const ignored = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""))
    .some((l) => l === top || l === dir || l === `${top}/**` || l === `${dir}/**`);
  return ignored
    ? `note: .gitignore ignores ${dir}, so memories stay local to this machine (remove that line to share them with the team)`
    : undefined;
}
