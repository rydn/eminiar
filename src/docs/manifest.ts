import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { PROJECT_RELATIVE_PATH_RE } from "../config.js";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";

/** Index source tag prefix for every documentation page: `docs:<name>`. */
export const DOCS_PREFIX = "docs:";

/** One registered documentation source: a local path or a set of URL seeds to crawl. */
export interface DocSource {
  /** Slug, unique in the manifest; the index tag is `docs:<name>`. */
  name: string;
  kind: "url" | "path";
  /** URL seeds (kind `url`); same-origin pages under each seed's directory are crawled. */
  urls?: string[] | undefined;
  /** Project-relative file or directory (kind `path`). */
  path?: string | undefined;
  /** Globs for a directory path (default: the config `index.docs` globs). */
  glob?: string[] | undefined;
  /** Where the source came from: `npm:zod`, `pypi:fastapi`, `go:<module>`, `env:SUMSUB`, `image:nats`, `files:terraform`, `manual`. */
  provider?: string | undefined;
  title?: string | undefined;
  crawl?: { depth?: number | undefined; maxPages?: number | undefined } | undefined;
  ttlHours?: number | undefined;
  tags?: string[] | undefined;
  notes?: string | undefined;
  addedAt: string;
}

export interface DocsManifest {
  version: 1;
  sources: DocSource[];
}

/** What the last sync of a source did; kept in the project DB, not in the committed manifest. */
export interface DocsSyncState {
  at: number;
  pages: number;
  documents: number;
  chunks: number;
  errors: string[];
  skipped: number;
  ms: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function docsTag(name: string): string {
  return `${DOCS_PREFIX}${name}`;
}

export function nameFromTag(tag: string): string | undefined {
  return tag.startsWith(DOCS_PREFIX) ? tag.slice(DOCS_PREFIX.length) : undefined;
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** `@aws-sdk/client-s3` → `aws-sdk-client-s3`, `Sumsub KYC` → `sumsub-kyc`. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return (s || "source").slice(0, 64);
}

export function manifestPathAt(root: string, rel = ".eminiar/docs.json"): string {
  return join(root, rel);
}

export function manifestPath(ctx: ProjectContext): string {
  return manifestPathAt(ctx.root, ctx.config.docs.manifest);
}

function empty(): DocsManifest {
  return { version: 1, sources: [] };
}

/**
 * A manifest as read, how many `sources` entries it held that were not kept, and the names of
 * the path sources among them dropped for a path outside the project.
 */
function normalize(raw: unknown): { manifest: DocsManifest; dropped: number; outside: string[] } {
  if (!raw || typeof raw !== "object") return { manifest: empty(), dropped: 0, outside: [] };
  const sources = Array.isArray((raw as DocsManifest).sources) ? (raw as DocsManifest).sources : [];
  const out: DocSource[] = [];
  const outside: string[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!s || typeof s !== "object" || typeof s.name !== "string") continue;
    if (!isValidName(s.name) || seen.has(s.name)) continue;
    if (s.kind !== "url" && s.kind !== "path") continue;
    if (s.kind === "url" && !(Array.isArray(s.urls) && s.urls.length)) continue;
    if (s.kind === "path" && typeof s.path !== "string") continue;
    // A committed manifest must not point a sync at files outside the project (../, /, a drive).
    if (s.kind === "path" && !PROJECT_RELATIVE_PATH_RE.test(s.path as string)) {
      process.stderr.write(
        `eminiar: ignoring docs source ${JSON.stringify(s.name)}: its path ${JSON.stringify(s.path)} must be inside the project\n`,
      );
      outside.push(s.name);
      continue;
    }
    seen.add(s.name);
    out.push({
      ...s,
      addedAt: typeof s.addedAt === "string" ? s.addedAt : new Date(0).toISOString(),
    });
  }
  return {
    manifest: { version: 1, sources: out },
    dropped: sources.length - out.length,
    outside,
  };
}

/**
 * Why a write would lose part of a parsed manifest, or undefined: a version other than 1 (a
 * newer eminiar's format), top-level keys other than version and sources, a `sources` that is
 * not an array, or entries normalize() did not keep (bad name, duplicate, unknown kind, a path
 * outside the project).
 */
function lossyReason(
  raw: Record<string, unknown>,
  dropped: number,
  outside: string[],
  removing?: string | undefined,
): string | undefined {
  if (raw.version !== 1)
    return raw.version === undefined
      ? "it has no version (this eminiar writes version 1)"
      : `it has version ${JSON.stringify(raw.version)}, and this eminiar only writes version 1`;
  const extra = Object.keys(raw).filter((k) => k !== "version" && k !== "sources");
  if (extra.length) return `it has keys this eminiar does not know (${extra.sort().join(", ")})`;
  if (Object.hasOwn(raw, "sources") && !Array.isArray(raw.sources))
    return "its sources is not an array";
  const rest = outside.filter((n) => n !== removing);
  const lost = dropped - (outside.length - rest.length);
  if (lost)
    return `${lost} of its sources ${lost === 1 ? "is" : "are"} not valid entries${rest.length ? ` (${rest.join(", ")}: path outside the project)` : ""}`;
  return undefined;
}

/**
 * Largest manifest read, in bytes. The real one is a few KB; the bound keeps a hostile repo
 * (a committed symlink, or a project-set `docs.manifest`) from making every hook read a huge
 * file or a device.
 */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

/** What is at a manifest path: nothing, a manifest, or a file that was not read (and why). */
export type ManifestProbe =
  | { state: "missing" }
  | {
      state: "ok";
      manifest: DocsManifest;
      /** Path sources normalize() dropped for a path outside the project, by name. */
      outside?: string[] | undefined;
    }
  | { state: "refused"; reason: string };

/** Options for probeManifestAt. */
export interface ManifestProbeOptions {
  /** The project root the manifest must stay inside, also after resolving symlinks. */
  root?: string | undefined;
  /**
   * Probe for a write: a symlink is refused (even one inside the project), and so is a manifest
   * a write would reduce (lossyReason).
   */
  write?: boolean | undefined;
  /**
   * A write that removes this source: its entries dropped for a path outside the project are not
   * lost by it, so `em_docs remove` can clear such an entry from the file.
   */
  removing?: string | undefined;
}

/**
 * Thrown by every manifest write when a file is present but was not read: writing would replace
 * the committed sources with only the ones this call knows about.
 */
export class ManifestRefusedError extends Error {
  readonly file: string;
  readonly reason: string;
  constructor(file: string, reason: string) {
    super(
      `refusing to write the docs manifest ${file}: ${reason}, so it was not read and writing it would drop its sources; fix or move it, then retry`,
    );
    this.name = "ManifestRefusedError";
    this.file = file;
    this.reason = reason;
  }
}

/** `child` is `parent` or below it (both already absolute and resolved the same way). */
export function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why `file` is not a manifest location inside `root`, or undefined. Lexically it must be below
 * the root; its nearest existing parent folder must resolve (realpath) inside the resolved root,
 * so a committed `.eminiar` symlink cannot lead out; and the file itself, when it is a symlink,
 * is refused for a write and must resolve inside the root for a read.
 */
function locationProblem(file: string, root: string, write: boolean): string | undefined {
  if (file === root || !within(file, root)) return "it is outside the project";
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch (err) {
    return `the project root could not be resolved (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`;
  }
  try {
    let dir = dirname(file);
    // The nearest entry that exists (lstat: a dangling folder symlink stops the walk and then
    // fails realpath below, rather than being created through).
    while (!lstatSync(dir, { throwIfNoEntry: false }) && within(dirname(dir), root) && dir !== root)
      dir = dirname(dir);
    if (!within(realpathSync.native(dir), realRoot))
      return "its folder resolves outside the project (a symlink)";
    const lst = lstatSync(file, { throwIfNoEntry: false });
    if (lst?.isSymbolicLink()) {
      if (write) {
        let dangling = false;
        try {
          dangling = !statSync(file, { throwIfNoEntry: false });
        } catch {
          // a loop or unreadable target: still a symlink, refused below
        }
        return dangling
          ? "it is a symlink to a missing file"
          : "it is a symlink, and writes replace only a regular file";
      }
      let target: string;
      try {
        target = realpathSync.native(file);
      } catch {
        // Dangling or a loop: probeManifestAt reports it.
        return undefined;
      }
      if (!within(target, realRoot)) return "it is a symlink to a file outside the project";
    }
    return undefined;
  } catch (err) {
    return `its location could not be resolved (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`;
  }
}

/**
 * Look at a manifest file without trusting it: a regular file of at most MANIFEST_MAX_BYTES
 * holding a JSON object is `ok`; no entry is `missing`; anything else (too large, a directory,
 * a device, a FIFO, a dangling symlink, unreadable, not JSON) is `refused`. With `root`, a path
 * that leaves the project (lexically or through a symlink) is `refused` too; with `write`, so are
 * a symlink and a manifest a write would reduce (another version, unknown keys, dropped entries).
 */
export function probeManifestAt(file: string, opts: ManifestProbeOptions = {}): ManifestProbe {
  if (opts.root !== undefined) {
    const problem = locationProblem(file, opts.root, opts.write === true);
    if (problem) return { state: "refused", reason: problem };
  }
  let fd: number | undefined;
  try {
    // statSync follows symlinks; checking first keeps a FIFO or device from ever being opened.
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) {
      // A dangling symlink would have a write create its target, wherever that points.
      return lstatSync(file, { throwIfNoEntry: false })
        ? { state: "refused", reason: "it is a symlink to a missing file" }
        : { state: "missing" };
    }
    if (!st.isFile()) return { state: "refused", reason: "it is not a regular file" };
    if (st.size > MANIFEST_MAX_BYTES) return { state: "refused", reason: tooLarge(st.size) };
    // O_NONBLOCK: a path swapped for a FIFO after the stat cannot block the open.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { state: "refused", reason: "it is not a regular file" };
    if (fst.size > MANIFEST_MAX_BYTES) return { state: "refused", reason: tooLarge(fst.size) };
    // Read at most the size seen, so a file growing after the fstat is not followed.
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString("utf8", 0, off));
    } catch {
      return { state: "refused", reason: "it is not valid JSON" };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { state: "refused", reason: "it is not a JSON object" };
    const { manifest, dropped, outside } = normalize(raw);
    if (opts.write) {
      const lossy = lossyReason(raw as Record<string, unknown>, dropped, outside, opts.removing);
      if (lossy) return { state: "refused", reason: lossy };
    }
    return { state: "ok", manifest, ...(outside.length ? { outside } : {}) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Removed between the stat and the open: nothing is there to lose.
    if (code === "ENOENT") return { state: "missing" };
    return { state: "refused", reason: `it could not be read (${code ?? (err as Error).message})` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed or invalid; nothing to release
      }
    }
  }
}

function tooLarge(size: number): string {
  return `it is ${size} bytes, over the ${MANIFEST_MAX_BYTES}-byte limit`;
}

/**
 * Read a manifest file; a missing, malformed or oversized file, or a path that is not a
 * regular file (a directory, a device, a FIFO, also through a symlink), reads as empty, and so
 * does one outside `root` when it is given. For readers only (hooks fail open): a write must
 * use readManifestForWrite.
 */
export function readManifestAt(file: string, root?: string): DocsManifest {
  const p = probeManifestAt(file, { root });
  return p.state === "ok" ? p.manifest : empty();
}

export function readManifest(ctx: ProjectContext): DocsManifest {
  return readManifestAt(manifestPath(ctx), ctx.root);
}

/**
 * Read the manifest to change it: a missing one is empty, a present one that was not read, or
 * that a write would reduce, or one outside the project or behind a symlink, throws
 * ManifestRefusedError instead of reading as empty.
 */
export function readManifestForWrite(ctx: ProjectContext): DocsManifest {
  const file = manifestPath(ctx);
  const p = probeManifestAt(file, { root: ctx.root, write: true });
  if (p.state === "refused") throw new ManifestRefusedError(file, p.reason);
  return p.state === "ok" ? p.manifest : empty();
}

/**
 * Write the manifest; throws ManifestRefusedError rather than replace a file it could not read,
 * leave the project, or write through a symlink. The text goes to a new temp file in the same
 * folder, renamed over the manifest, so nothing is written through whatever is at the path.
 */
export function writeManifest(
  ctx: ProjectContext,
  m: DocsManifest,
  removing?: string | undefined,
): string {
  const file = manifestPath(ctx);
  const opts = { root: ctx.root, write: true, removing };
  const p = probeManifestAt(file, opts);
  if (p.state === "refused") throw new ManifestRefusedError(file, p.reason);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  // The folders just made are real ones; check the location again in case the tree moved.
  const again = locationProblem(file, ctx.root, true);
  if (again) throw new ManifestRefusedError(file, again);
  const sorted = {
    version: 1 as const,
    sources: [...m.sources].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const mode = p.state === "ok" ? statSync(file, { throwIfNoEntry: false })?.mode : undefined;
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    // wx: fails if anything (a planted symlink included) already has the temp name.
    writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { flag: "wx" });
    if (mode !== undefined) chmodSync(tmp, mode & 0o7777);
    // rename replaces the directory entry; it never follows a symlink at `file`.
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

export type DocSourceInput = Omit<DocSource, "addedAt"> & { addedAt?: string | undefined };

/** Validate and fill one source; throws on a bad name or an empty definition. */
export function makeSource(input: DocSourceInput): DocSource {
  const name = isValidName(input.name) ? input.name : slugify(input.name);
  if (!isValidName(name)) throw new Error(`invalid source name "${input.name}"`);
  const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new Error(`${name}: "${u}" is not a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error(`${name}: only http(s) URLs can be crawled`);
  }
  const path = input.path?.trim();
  if (input.kind === "url" && !urls.length) throw new Error(`${name}: a url source needs urls`);
  if (input.kind === "path" && !path) throw new Error(`${name}: a path source needs a path`);
  // The rule normalize() reads the manifest with, so an added source is never dropped on read.
  if (path && !PROJECT_RELATIVE_PATH_RE.test(path))
    throw new Error(`${name}: path must be inside the project`);
  const src: DocSource = {
    name,
    kind: input.kind,
    addedAt: input.addedAt ?? new Date().toISOString(),
  };
  if (input.kind === "url") src.urls = [...new Set(urls)];
  if (input.kind === "path") src.path = path;
  if (input.glob?.length) src.glob = input.glob;
  if (input.provider) src.provider = input.provider;
  if (input.title) src.title = input.title;
  if (input.crawl && (input.crawl.depth !== undefined || input.crawl.maxPages !== undefined))
    src.crawl = {
      ...(input.crawl.depth !== undefined ? { depth: input.crawl.depth } : {}),
      ...(input.crawl.maxPages !== undefined ? { maxPages: input.crawl.maxPages } : {}),
    };
  if (input.ttlHours !== undefined) src.ttlHours = input.ttlHours;
  if (input.tags?.length) src.tags = [...new Set(input.tags)];
  if (input.notes) src.notes = input.notes;
  return src;
}

/** Add or replace sources by name; returns which were new and which replaced an entry. */
export function upsertSources(
  ctx: ProjectContext,
  inputs: DocSourceInput[],
): { added: string[]; updated: string[]; file: string } {
  const m = readManifestForWrite(ctx);
  const added: string[] = [];
  const updated: string[] = [];
  for (const input of inputs) {
    const src = makeSource(input);
    const i = m.sources.findIndex((s) => s.name === src.name);
    if (i === -1) {
      m.sources.push(src);
      added.push(src.name);
    } else {
      m.sources[i] = { ...src, addedAt: m.sources[i]!.addedAt };
      updated.push(src.name);
    }
  }
  const file = writeManifest(ctx, m);
  return { added, updated, file };
}

/**
 * Remove a source by name. An entry that is only in the file (dropped on read for a path outside
 * the project) is removed too: the write loses nothing else, so the probe allows it.
 */
export function removeSource(ctx: ProjectContext, name: string): boolean {
  const file = manifestPath(ctx);
  const p = probeManifestAt(file, { root: ctx.root, write: true, removing: name });
  if (p.state === "refused") throw new ManifestRefusedError(file, p.reason);
  if (p.state === "missing") return false;
  const m = p.manifest;
  const before = m.sources.length;
  m.sources = m.sources.filter((s) => s.name !== name);
  if (m.sources.length === before && !p.outside?.includes(name)) return false;
  writeManifest(ctx, m, name);
  return true;
}

export function getSource(ctx: ProjectContext, name: string): DocSource | undefined {
  return readManifest(ctx).sources.find((s) => s.name === name);
}

const SYNC_KEY = (name: string) => `docs.sync.${name}`;

export function syncState(db: StorageAdapter, name: string): DocsSyncState | undefined {
  const raw = db.metaGet(SYNC_KEY(name));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DocsSyncState;
  } catch {
    return undefined;
  }
}

export function setSyncState(db: StorageAdapter, name: string, state: DocsSyncState): void {
  db.metaSet(SYNC_KEY(name), JSON.stringify(state));
}

export function clearSyncState(db: StorageAdapter, name: string): void {
  db.metaSet(SYNC_KEY(name), "");
}
