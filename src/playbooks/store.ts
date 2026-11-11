import { randomBytes } from "node:crypto";
import {
  chmodSync,
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
import { dirname, join } from "node:path";
import { isSecretName, redactSecrets } from "../adjudicator/redact.js";
import { hashText } from "../chunker/types.js";
import type { ProjectContext } from "../context.js";
import { within } from "../docs/manifest.js";
import type { StorageAdapter } from "../storage/adapter.js";
import {
  PLAYBOOK_RUN_STATUSES,
  PLAYBOOK_SOURCES,
  PLAYBOOK_TRIGGERS,
  type PlaybookParam,
  type PlaybookRow,
  type PlaybookRunRow,
  type PlaybookRunStatus,
  type PlaybookSource,
  type PlaybookSuggestionRow,
  type PlaybookSuggestionStatus,
  type PlaybookTrigger,
} from "../storage/types.js";
import {
  oneLine,
  type PlaybookMeta,
  parsePlaybookFile,
  serializePlaybookFile,
} from "./frontmatter.js";
import { gitIgnoredFor, gitTrackedIn, type IgnoreAnswer } from "./git.js";

/**
 * Playbooks are stored recurring tasks: a name, a title, a prompt, optional parameters, an
 * optional schedule hint, tags. eminiar keeps them and shows them; it never runs one and never
 * schedules one (the schedule is a note for people).
 *
 * They are markdown files, `<playbooks.dir>/<name>.md`, or `<playbooks.privateDir>/<name>.md`
 * for a private one (that folder is kept out of git). The database mirrors them like it mirrors
 * memories: the file wins and `reconcile()` re-imports anything edited, added or removed by
 * hand. Text is masked with redactSecrets before it is saved, and the mirror is masked again
 * on import, since a file can arrive with the repo.
 */

/** A flat slug: the name is the file name, so no separators and nothing that starts with a dot. */
export const PLAYBOOK_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidName(name: string): boolean {
  return name.length <= 64 && PLAYBOOK_NAME_RE.test(name);
}

function assertValidName(name: string): void {
  if (!isValidName(name))
    throw new Error(
      `invalid playbook name "${name}": use a lowercase slug of [a-z0-9._-] up to 64 characters, e.g. review-open-prs`,
    );
}

export function isSource(s: unknown): s is PlaybookSource {
  return typeof s === "string" && (PLAYBOOK_SOURCES as readonly string[]).includes(s);
}

const MAX_TITLE = 120;
const MAX_PROMPT = 20_000;
const MAX_SCHEDULE = 120;
const MAX_TAGS = 20;
const MAX_TAG = 40;
const MAX_PARAMS = 20;
const MAX_DEFAULT = 200;
const MAX_NOTE = 500;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export function slugify(s: string, max = 48): string {
  let slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > max) {
    const cut = slug.lastIndexOf("-", max);
    slug = slug.slice(0, cut > max / 2 ? cut : max);
  }
  return slug.replace(/-+$/, "") || "playbook";
}

// --- where the files live --------------------------------------------------------------

function relDir(ctx: ProjectContext, priv: boolean): string {
  const p = ctx.config.playbooks;
  return (priv ? p.privateDir : p.dir).replace(/^\.\//, "").replace(/\/+$/, "");
}

export function playbooksRel(ctx: ProjectContext): string {
  return relDir(ctx, false);
}

export function privatePlaybooksRel(ctx: ProjectContext): string {
  return relDir(ctx, true);
}

function relOf(ctx: ProjectContext, name: string, priv: boolean): string {
  return `${relDir(ctx, priv)}/${name}.md`;
}

function absOf(ctx: ProjectContext, name: string, priv: boolean): string {
  return join(ctx.root, relOf(ctx, name, priv));
}

/** The real path of the nearest existing folder at or above `dir`, then the rest as written. */
function realLocation(dir: string): string {
  let d = dir;
  const rest: string[] = [];
  while (!lstatSync(d, { throwIfNoEntry: false })) {
    const up = dirname(d);
    if (up === d) break;
    rest.unshift(d.slice(up.length + 1));
    d = up;
  }
  return join(realpathSync.native(d), ...rest);
}

/**
 * Throws unless a playbook file at `abs` stays inside the project once symlinks are resolved,
 * and is not itself a link: a folder or file link to ~, src/ or CLAUDE.md must not lead a read,
 * a write or a delete to a file that is not a playbook. (Check then use, like the memories.)
 */
function assertInside(ctx: ProjectContext, abs: string): void {
  let ok = false;
  try {
    const link = lstatSync(abs, { throwIfNoEntry: false });
    ok =
      !link?.isSymbolicLink() && within(realLocation(dirname(abs)), realpathSync.native(ctx.root));
  } catch {
    ok = false; // dangling, a loop
  }
  if (!ok)
    throw new Error(
      `playbook path ${abs.slice(ctx.root.length + 1)} is a link or leaves the project; refusing to touch it`,
    );
}

/** The private folder is kept out of git, so it must not be the public one or inside it. */
function assertFolders(ctx: ProjectContext): void {
  const pub = relDir(ctx, false);
  const priv = relDir(ctx, true);
  if (priv === pub || priv.startsWith(`${pub}/`))
    throw new Error(
      `playbooks.privateDir (${priv}) must not be playbooks.dir or inside it: that folder is committed`,
    );
}

/**
 * Text fallback, used only when git cannot answer: true when a .gitignore line ignores `rel` or
 * a folder above it and no later negation could undo it. Lines apply in order, so a negation
 * that names `rel`, a folder above it or anything below it, or that holds a glob, counts as
 * undoing the cover (a false "not covered" only adds a line; a false "covered" leaks).
 */
function ignoreCovers(lines: string[], rel: string): boolean {
  const parts = rel.split("/");
  const prefixes = new Set<string>();
  for (let i = 1; i <= parts.length; i++) prefixes.add(parts.slice(0, i).join("/"));
  let covered = false;
  for (const l of lines) {
    const raw = l.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const neg = raw.startsWith("!");
    const t = (neg ? raw.slice(1) : raw).replace(/^\//, "").replace(/\/\*{0,2}$/, "");
    if (t === "") continue;
    if (!neg) {
      if (prefixes.has(t)) covered = true;
    } else if (prefixes.has(t) || t.startsWith(`${rel}/`) || /[*?[\\]/.test(t)) {
      covered = false;
    }
  }
  return covered;
}

/**
 * The files of the private folder that git tracks (project-relative), [] when none or when git
 * cannot say (no git, no repository: nothing is tracked then).
 */
function trackedPrivate(ctx: ProjectContext): string[] {
  const rel = relDir(ctx, true);
  return (gitTrackedIn(ctx.root, rel) ?? []).map((f) => `${rel}/${f}`);
}

/** Is the private playbook `name` a file git tracks (force-added upstream, arrived by a pull)? */
function isTrackedPrivate(ctx: ProjectContext, name: string): boolean {
  const want = `${relDir(ctx, true)}/${name}.md`.toLowerCase();
  return trackedPrivate(ctx).some((f) => f.toLowerCase() === want);
}

/**
 * Does git ignore the private folder? Asks about the file being written (with the index, so a
 * tracked file is "not ignored") and about a random name no .gitignore line can single out, so
 * a line that covers only `probe.md` or `p*` does not pass for the folder. Ignored only when
 * every answer is; unknown when git cannot say (no git, no repository, an error).
 */
function gitIgnoresPrivate(ctx: ProjectContext, name: string | undefined): IgnoreAnswer {
  const rel = relDir(ctx, true);
  const probes = [`${rel}/eminiar-probe-${randomBytes(8).toString("hex")}.md`];
  if (name !== undefined) probes.push(`${rel}/${name}.md`);
  const answers = probes.map((p) => gitIgnoredFor(ctx.root, p));
  if (answers.includes("not-ignored")) return "not-ignored";
  return answers.every((a) => a === "ignored") ? "ignored" : "unknown";
}

/**
 * Makes sure git ignores the private folder before a private playbook (`name`) is written there,
 * adding a line to the project's .gitignore when it does not. Throws when that fails, or when
 * git tracks files in the folder (then it is a committed folder, and an edit there is a change to
 * a tracked file): a private playbook is never written to a folder git might commit.
 */
export function ensurePrivateIgnored(ctx: ProjectContext, name?: string): void {
  const rel = relDir(ctx, true);
  const tracked = trackedPrivate(ctx);
  if (tracked.length > 0)
    throw new Error(
      `git tracks ${tracked.slice(0, 5).join(", ")}${tracked.length > 5 ? ` and ${tracked.length - 5} more` : ""} in the private playbook folder ${rel}, so that folder is not private; refusing to write a private playbook there. Untrack them (git rm --cached) or set playbooks.privateDir to another folder`,
    );
  const file = join(ctx.root, ".gitignore");
  assertInside(ctx, file);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Git is the authority: a glob and a later negation can undo each other in ways a text scan
  // misreads. Without git (or outside a repo) the text check stands in. A project without a
  // .git of its own (inside a parent repository that ignores everything, say) keeps its own
  // line too, so the folder stays ignored after a later `git init` there.
  const covered = ignoreCovers(text.split(/\r?\n/), rel);
  const ownRepo = !!lstatSync(join(ctx.root, ".git"), { throwIfNoEntry: false });
  const before = gitIgnoresPrivate(ctx, name);
  if (before === "ignored" && (ownRepo || covered)) return;
  if (before === "unknown" && covered) return;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${text}${sep}# eminiar: private playbooks stay local\n${rel}/\n`);
  const after = gitIgnoresPrivate(ctx, name);
  if (after === "not-ignored" || (after === "unknown" && before !== "unknown"))
    throw new Error(
      `git would still track ${rel} after adding it to .gitignore (a later rule or a nested .gitignore un-ignores it); refusing to write a private playbook there`,
    );
}

const KNOWN_KEYS = new Set([
  "name",
  "title",
  "params",
  "schedule",
  "tags",
  "source",
  "created",
  "updated",
]);

/** Header keys eminiar does not know, safe to write back: values masked, secret-named keys gone. */
function carryOver(extra: PlaybookMeta): PlaybookMeta {
  const out: PlaybookMeta = {};
  for (const [k, v] of Object.entries(extra)) {
    if (KNOWN_KEYS.has(k) || isSecretName(k) || mask(k) !== k) continue;
    out[k] = Array.isArray(v) ? v.map((x) => mask(oneLine(x))) : mask(oneLine(v));
  }
  return out;
}

function writeAtomic(abs: string, text: string, priv: boolean): void {
  mkdirSync(dirname(abs), { recursive: true, ...(priv ? { mode: 0o700 } : {}) });
  // mkdir's mode applies only to a folder it creates: an existing private folder is tightened
  if (priv && (statSync(dirname(abs)).mode & 0o077) !== 0) chmodSync(dirname(abs), 0o700);
  // A random name opened with `wx` (never follows a link, never reuses a file): a planted
  // symlink at a guessable tmp name must not lead the write to a file outside the project.
  const tmp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: priv ? 0o600 : 0o644 });
    renameSync(tmp, abs);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
}

// --- field rules -----------------------------------------------------------------------

export interface PlaybookFile {
  name: string;
  title: string;
  prompt: string;
  params: PlaybookParam[];
  schedule?: string | undefined;
  tags: string[];
  source: PlaybookSource;
  private: boolean;
  created: string;
  updated: string;
  /** Project-relative path. */
  path: string;
  row: PlaybookRow;
}

/** What a playbook is made of, as callers pass it. */
export interface PlaybookFields {
  title: string;
  prompt: string;
  params?: PlaybookParam[] | undefined;
  schedule?: string | undefined;
  tags?: string[] | undefined;
}

interface Clean {
  title: string;
  prompt: string;
  params: PlaybookParam[];
  schedule: string | undefined;
  tags: string[];
}

const mask = (s: string): string => redactSecrets(s);

/**
 * Validate and mask the fields. `strict` (writes) throws on bad input; lenient (importing a
 * hand-edited file) drops what is unusable so one bad line never hides the playbook.
 */
function clean(
  f: PlaybookFields,
  strict: boolean,
  fallbackTitle: string,
  unchangedPrompt?: string | undefined,
): Clean {
  const bad = (msg: string): never => {
    throw new Error(msg);
  };
  const title = mask(oneLine(f.title ?? "")).slice(0, MAX_TITLE) || fallbackTitle;
  if (strict && !oneLine(f.title ?? "")) bad("a playbook needs a title");
  const prompt = mask((f.prompt ?? "").replace(/\r\n/g, "\n")).trim();
  if (strict && !prompt) bad("a playbook needs a prompt");
  if (strict && prompt.length > MAX_PROMPT && prompt !== unchangedPrompt)
    bad(`prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT}`);
  const params: PlaybookParam[] = [];
  for (const p of f.params ?? []) {
    const name = (p.name ?? "").trim();
    if (!PARAM_NAME_RE.test(name)) {
      if (strict)
        bad(`invalid parameter name "${name}": letters, digits and _, starting with a letter`);
      continue;
    }
    if (params.some((q) => q.name === name)) continue;
    if (params.length >= MAX_PARAMS) {
      if (strict) bad(`at most ${MAX_PARAMS} parameters`);
      break;
    }
    const d = p.default === undefined ? undefined : mask(oneLine(p.default)).slice(0, MAX_DEFAULT);
    params.push(d === undefined || d === "" ? { name } : { name, default: d });
  }
  const sched = f.schedule === undefined ? "" : mask(oneLine(f.schedule));
  if (strict && sched.length > MAX_SCHEDULE)
    bad(`schedule hint is over ${MAX_SCHEDULE} characters`);
  const tags: string[] = [];
  for (const raw of f.tags ?? []) {
    const t = mask(oneLine(raw)).toLowerCase().slice(0, MAX_TAG);
    if (t && !tags.includes(t)) tags.push(t);
  }
  if (strict && tags.length > MAX_TAGS) bad(`at most ${MAX_TAGS} tags`);
  return {
    title,
    prompt,
    params,
    schedule: sched ? sched.slice(0, MAX_SCHEDULE) : undefined,
    tags: tags.slice(0, MAX_TAGS),
  };
}

/** `name` / `name=default` header items to parameters. */
function parseParams(items: string[]): PlaybookParam[] {
  return items.map((it) => {
    const i = it.indexOf("=");
    return i < 0 ? { name: it.trim() } : { name: it.slice(0, i).trim(), default: it.slice(i + 1) };
  });
}

function paramItems(params: PlaybookParam[]): string[] {
  return params.map((p) => (p.default === undefined ? p.name : `${p.name}=${p.default}`));
}

function arr(v: string | string[] | undefined): string[] {
  return Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
}

function str(v: string | string[] | undefined): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function jsonList<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function rowParams(row: { params: string | null }): PlaybookParam[] {
  return jsonList<PlaybookParam>(row.params).filter((p) => p && typeof p.name === "string");
}

export function rowTags(row: { tags: string | null }): string[] {
  return jsonList<string>(row.tags).filter((t) => typeof t === "string");
}

// --- config gates ----------------------------------------------------------------------
//
// The switches are enforced here, once, so the MCP tool, the CLI and the dashboard API cannot
// disagree: each turns a PlaybookGateError into its own refusal (tool error, exit 1, HTTP 403).
//   playbooks.viewing            every call, reads and writes alike (off: playbooks are off)
//   playbooks.adding             every write: playbooks, runs (run/report) and suggestions
//   playbooks.extraction.enabled suggest, suggestions, accept, dismiss and scan

export type PlaybookSwitch =
  | "playbooks.viewing"
  | "playbooks.adding"
  | "playbooks.extraction.enabled";

/** A call refused by a config switch; `key` is the switch, which the message also names. */
export class PlaybookGateError extends Error {
  readonly key: PlaybookSwitch;
  constructor(key: PlaybookSwitch, message: string) {
    super(message);
    this.name = "PlaybookGateError";
    this.key = key;
  }
}

function assertViewing(ctx: ProjectContext): void {
  if (!ctx.config.playbooks.viewing)
    throw new PlaybookGateError(
      "playbooks.viewing",
      "playbooks are off: playbooks.viewing is false in the eminiar config",
    );
}

export function assertAdding(ctx: ProjectContext): void {
  assertViewing(ctx);
  if (!ctx.config.playbooks.adding)
    throw new PlaybookGateError(
      "playbooks.adding",
      "playbooks are read-only: playbooks.adding is false in the eminiar config",
    );
}

function assertExtraction(ctx: ProjectContext): void {
  assertViewing(ctx);
  if (!ctx.config.playbooks.extraction.enabled)
    throw new PlaybookGateError(
      "playbooks.extraction.enabled",
      "playbook suggestions are off: playbooks.extraction.enabled is false in the eminiar config",
    );
}

/**
 * The gate of a history scan: viewing and extraction, plus adding unless it is a dry run (a
 * real scan stores suggestions). Callers check it before `scan`, so a refused scan reads nothing.
 */
export function assertCanScan(
  ctx: ProjectContext,
  opts: { dryRun?: boolean | undefined } = {},
): void {
  assertExtraction(ctx);
  if (!opts.dryRun) assertAdding(ctx);
}

// --- mirroring -------------------------------------------------------------------------

/**
 * Mirror one file into the database. Never rewrites the file. Returns undefined when it does not
 * exist or is not a safe path.
 */
function syncFile(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
  priv: boolean,
  opts: { force?: boolean } = {},
): { changed: boolean; row: PlaybookRow } | undefined {
  const abs = absOf(ctx, name, priv);
  const rel = relOf(ctx, name, priv);
  const link = lstatSync(abs, { throwIfNoEntry: false });
  if (!link) return undefined;
  assertInside(ctx, abs);
  const st = statSync(abs);
  if (!st.isFile()) return undefined;
  const row = db.playbooks.get(name);
  const mtime = Math.floor(st.mtimeMs);
  if (
    !opts.force &&
    row &&
    row.file_mtime === mtime &&
    row.file_size === st.size &&
    row.path === rel &&
    row.private === (priv ? 1 : 0)
  )
    return { changed: false, row };
  const text = readFileSync(abs, "utf8");
  const hash = hashText(text);
  const parsed = parsePlaybookFile(text);
  const meta = parsed.meta;
  const c = clean(
    {
      title: str(meta.title) ?? name,
      prompt: parsed.body,
      params: parseParams(arr(meta.params)),
      schedule: str(meta.schedule),
      tags: arr(meta.tags),
    },
    false,
    name,
  );
  const source = isSource(meta.source) ? meta.source : "manual";
  const created =
    Date.parse(str(meta.created) ?? "") || row?.created_at || st.birthtimeMs || Date.now();
  const updated = Date.parse(str(meta.updated) ?? "") || st.mtimeMs;
  db.playbooks.upsert({
    name,
    title: c.title,
    prompt: c.prompt,
    params: c.params,
    schedule: c.schedule,
    tags: c.tags,
    source,
    private: priv,
    path: rel,
    fileHash: hash,
    fileMtime: Math.floor(st.mtimeMs),
    fileSize: st.size,
    createdAt: Math.floor(created),
    updatedAt: Math.floor(updated),
  });
  return { changed: true, row: db.playbooks.get(name)! };
}

function fileOf(row: PlaybookRow): PlaybookFile {
  return {
    name: row.name,
    title: row.title,
    prompt: row.prompt,
    params: rowParams(row),
    schedule: row.schedule ?? undefined,
    tags: rowTags(row),
    source: isSource(row.source) ? row.source : "manual",
    private: row.private === 1,
    created: new Date(row.created_at).toISOString(),
    updated: new Date(row.updated_at ?? row.created_at).toISOString(),
    path: row.path ?? "",
    row,
  };
}

/**
 * Which folder holds `name`. The private one wins when a name exists in both: that file is the
 * user's own, while a committed file of the same name can arrive with any pull and must not
 * replace what a person wrote for themselves. `shadowedBy` tells callers about the loser. A file
 * in the private folder that git tracks is not the user's own (it came with the repo): it never
 * counts, so it neither wins nor lists as private.
 */
function locate(ctx: ProjectContext, name: string): boolean | undefined {
  if (lstatSync(absOf(ctx, name, true), { throwIfNoEntry: false }) && !isTrackedPrivate(ctx, name))
    return true;
  if (lstatSync(absOf(ctx, name, false), { throwIfNoEntry: false })) return false;
  return undefined;
}

/**
 * The project-relative path of a file in either folder whose name equals `name` only when case
 * is ignored (`Review-PRs.md` for `review-prs`). A case-insensitive disk holds one file for both
 * spellings, so a second playbook that differs only in case must not be created.
 */
function caseVariant(ctx: ProjectContext, name: string): string | undefined {
  const exact = `${name}.md`;
  for (const priv of [true, false]) {
    const rel = relDir(ctx, priv);
    let entries: string[];
    try {
      assertInside(ctx, join(ctx.root, rel, "x.md"));
      entries = readdirSync(join(ctx.root, rel));
    } catch {
      continue; // no such folder, a link out of the project, or unreadable
    }
    const hit = entries.find((f) => f !== exact && f.toLowerCase() === exact);
    if (hit) return `${rel}/${hit}`;
  }
  return undefined;
}

/** A name a new playbook cannot take: mirrored, on disk, or on disk in another case. */
function nameTaken(ctx: ProjectContext, db: StorageAdapter, name: string): boolean {
  return (
    !!db.playbooks.get(name) ||
    locate(ctx, name) !== undefined ||
    caseVariant(ctx, name) !== undefined
  );
}

/**
 * The project-relative path of a committed playbook that a private one of the same name hides,
 * or undefined when `name` is not in both folders.
 */
export function shadowedBy(ctx: ProjectContext, name: string): string | undefined {
  if (!isValidName(name) || locate(ctx, name) !== true) return undefined;
  return lstatSync(absOf(ctx, name, false), { throwIfNoEntry: false })
    ? relOf(ctx, name, false)
    : undefined;
}

export interface ReconcileSummary {
  files: number;
  synced: number;
  removed: number;
  /** Files that are not valid names, are links, or repeat a name held by another folder. */
  skipped: string[];
  /**
   * Files in the private folder that git tracks: not imported (they came with the repo, so they
   * are neither private nor the user's own). Also listed in `skipped`.
   */
  tracked: string[];
}

/** Bring the database in line with the files: cheap (a stat per file) and safe to call often. */
export function reconcile(ctx: ProjectContext, db: StorageAdapter): ReconcileSummary {
  assertFolders(ctx);
  const out: ReconcileSummary = { files: 0, synced: 0, removed: 0, skipped: [], tracked: [] };
  const seen = new Set<string>();
  let readable = true;
  for (const priv of [true, false]) {
    // private first: on a repeated name the private file is the one that counts (see locate)
    const rel = relDir(ctx, priv);
    const dir = join(ctx.root, rel);
    if (!lstatSync(dir, { throwIfNoEntry: false })) continue;
    let entries: string[];
    try {
      assertInside(ctx, join(dir, "x.md")); // the folder, not a file in it
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      // The folder is a link out of the project or unreadable (often for a moment, during a
      // checkout): report it and keep its rows instead of dropping every playbook from the list.
      out.skipped.push(rel);
      readable = false;
      continue;
    }
    // one git call per reconcile, and only when the private folder has playbooks in it
    const tracked = new Set(
      priv && entries.length > 0 ? trackedPrivate(ctx).map((t) => t.toLowerCase()) : [],
    );
    for (const f of entries) {
      // names are compared without case: on a case-insensitive disk Review-PRs.md is review-prs
      const name = f.slice(0, -3).toLowerCase();
      const relFile = `${rel}/${f}`;
      if (tracked.has(relFile.toLowerCase())) {
        out.tracked.push(relFile);
        out.skipped.push(relFile);
        continue;
      }
      if (!isValidName(name) || seen.has(name)) {
        out.skipped.push(relFile);
        continue;
      }
      try {
        const r = syncFile(ctx, db, name, priv);
        if (!r) {
          out.skipped.push(relFile);
          continue;
        }
        seen.add(name);
        out.files++;
        if (r.changed) out.synced++;
      } catch {
        out.skipped.push(relFile); // a link or a path that leaves the project
      }
    }
  }
  if (readable)
    for (const row of db.playbooks.list({ limit: 100_000 })) {
      if (!seen.has(row.name)) {
        db.playbooks.delete(row.name);
        out.removed++;
      }
    }
  return out;
}

// --- reading ---------------------------------------------------------------------------

export function read(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
): PlaybookFile | undefined {
  assertViewing(ctx);
  assertValidName(name);
  const priv = locate(ctx, name);
  if (priv === undefined) {
    // the file is gone: forget a stale row
    if (db.playbooks.get(name)) db.playbooks.delete(name);
    return undefined;
  }
  const synced = syncFile(ctx, db, name, priv);
  return synced ? fileOf(synced.row) : undefined;
}

/** Mirror rows, most recently updated first. Run `reconcile` first to pick up hand edits. */
export function list(
  ctx: ProjectContext,
  db: StorageAdapter,
  opts: {
    tag?: string | undefined;
    source?: string | undefined;
    includePrivate?: boolean | undefined;
    limit?: number | undefined;
  } = {},
): PlaybookRow[] {
  assertViewing(ctx);
  return db.playbooks.list({ ...opts, limit: opts.limit ?? 200 });
}

// --- writing ---------------------------------------------------------------------------

export interface WriteInput extends PlaybookFields {
  name?: string | undefined;
  /** Keep the playbook in the git-ignored folder. */
  private?: boolean | undefined;
  source?: PlaybookSource | undefined;
  /** Overwrite an existing playbook of the same name (its created date is kept). */
  replace?: boolean | undefined;
}

/** `slug of the title`, suffixed -2, -3… while taken. */
function freeName(ctx: ProjectContext, db: StorageAdapter, title: string): string {
  const base = slugify(title);
  if (!nameTaken(ctx, db, base)) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base.slice(0, 58)}-${i}`;
    if (!nameTaken(ctx, db, n)) return n;
  }
  return `${base.slice(0, 48)}-${Date.now()}`;
}

export function write(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: WriteInput,
): { name: string; path: string; created: boolean; row: PlaybookRow } {
  assertAdding(ctx);
  assertFolders(ctx);
  // The prompt limit applies when the prompt changes: a hand-written file over it stays editable.
  const c = clean(
    input,
    true,
    "",
    input.name ? db.playbooks.get(input.name.trim())?.prompt : undefined,
  );
  const name = input.name?.trim() || freeName(ctx, db, c.title);
  assertValidName(name);
  const priv = input.private === true;
  const where = locate(ctx, name);
  const variant = input.replace ? undefined : caseVariant(ctx, name);
  if (variant)
    throw new Error(
      `playbook "${name}" clashes with ${variant}: names are compared without case, and a case-insensitive disk holds one file for both; rename or remove that file first`,
    );
  const exists = where !== undefined || !!db.playbooks.get(name);
  if (exists && !input.replace)
    throw new Error(`playbook "${name}" already exists; pass replace: true to overwrite it`);
  const abs = absOf(ctx, name, priv);
  assertInside(ctx, abs);
  if (where !== undefined && where !== priv) assertInside(ctx, absOf(ctx, name, where));
  if (priv) ensurePrivateIgnored(ctx, name);

  const prev = db.playbooks.get(name);
  let extra: PlaybookMeta = {};
  if (where !== undefined) {
    try {
      extra = parsePlaybookFile(readFileSync(absOf(ctx, name, where), "utf8")).meta;
    } catch {
      // unreadable file: rewrite it from scratch
    }
  }
  const now = new Date().toISOString();
  // `created` survives only as a real date, re-serialised: a free-text value is never copied.
  const oldCreated = Date.parse(str(extra.created) ?? "");
  const created = Number.isNaN(oldCreated)
    ? prev
      ? new Date(prev.created_at).toISOString()
      : now
    : new Date(oldCreated).toISOString();
  // A key a person added by hand is carried over only as masked text, so a private -> public
  // move cannot commit a secret that rode along; a key named like a secret (api_token) or one
  // whose name masking changes is dropped, as no mask can vouch for a free-text value there.
  const meta: PlaybookMeta = {
    ...carryOver(extra),
    name,
    title: c.title,
    created,
    updated: now,
    source: input.source ?? (isSource(extra.source) ? extra.source : "manual"),
    tags: c.tags,
  };
  if (c.params.length) meta.params = paramItems(c.params);
  else delete meta.params;
  if (c.schedule) meta.schedule = c.schedule;
  else delete meta.schedule;
  writeAtomic(abs, serializePlaybookFile(meta, `\n${c.prompt}\n`), priv);
  // moved between folders: the old copy goes, so a name lives in one place only
  if (where !== undefined && where !== priv) unlinkSync(absOf(ctx, name, where));
  const r = syncFile(ctx, db, name, priv, { force: true })!;
  return { name, path: relOf(ctx, name, priv), created: !exists, row: r.row };
}

export function remove(ctx: ProjectContext, db: StorageAdapter, name: string): boolean {
  assertAdding(ctx);
  assertValidName(name);
  const where = locate(ctx, name);
  let existed = !!db.playbooks.get(name);
  if (where !== undefined) {
    const abs = absOf(ctx, name, where);
    // unlink removes a link, never its target; the folder must still be inside the project
    assertInside(ctx, join(dirname(abs), "x.md"));
    unlinkSync(abs);
    existed = true;
  }
  db.playbooks.delete(name);
  return existed;
}

// --- using a playbook ------------------------------------------------------------------

/**
 * The prompt with `{{param}}` filled from `values`, then the parameter's default. Unknown
 * `{{x}}` and parameters without a value stay as written, so a gap shows instead of vanishing.
 */
export function fillPrompt(
  file: Pick<PlaybookFile, "prompt" | "params">,
  values: Record<string, string> = {},
): string {
  return file.prompt.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    const v = Object.hasOwn(values, name) ? values[name] : undefined;
    return v ?? file.params.find((p) => p.name === name)?.default ?? whole;
  });
}

export interface RunInput {
  playbook: string;
  trigger: PlaybookTrigger;
  status?: PlaybookRunStatus | undefined;
  sessionId?: string | undefined;
  note?: string | undefined;
}

/**
 * Record that a playbook was used (by a person or by Claude); nothing is executed. A write, so
 * it needs `playbooks.adding`.
 */
export function recordRun(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: RunInput,
): { id: number } {
  assertAdding(ctx);
  assertValidName(input.playbook);
  if (!(PLAYBOOK_TRIGGERS as readonly string[]).includes(input.trigger))
    throw new Error(`invalid trigger "${input.trigger}": use ${PLAYBOOK_TRIGGERS.join(" | ")}`);
  if (
    input.status !== undefined &&
    !(PLAYBOOK_RUN_STATUSES as readonly string[]).includes(input.status)
  )
    throw new Error(`invalid status "${input.status}": use ${PLAYBOOK_RUN_STATUSES.join(" | ")}`);
  if (!db.playbooks.get(input.playbook)) throw new Error(`no playbook named "${input.playbook}"`);
  const note = input.note ? mask(oneLine(input.note)).slice(0, MAX_NOTE) : undefined;
  return {
    id: db.playbooks.runAdd({
      playbook: input.playbook,
      trigger: input.trigger,
      status: input.status,
      sessionId: input.sessionId,
      note,
    }),
  };
}

export interface CloseRunInput {
  playbook: string;
  /**
   * The id `run` returned. Without one the newest started run opened through em_playbook (trigger
   * mcp, what the schedule text produces) is closed, never a CLI or dashboard run.
   */
  runId?: number | undefined;
  status: PlaybookRunStatus;
  note?: string | undefined;
}

/**
 * Close a started run in place: its row gets the outcome, no second row is added. Rejects an
 * unknown run (or one of another playbook), a run that is already closed, and `started` itself.
 */
export function closeRun(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: CloseRunInput,
): { id: number } {
  assertAdding(ctx);
  assertValidName(input.playbook);
  if (
    input.status === "started" ||
    !(PLAYBOOK_RUN_STATUSES as readonly string[]).includes(input.status)
  )
    throw new Error(`invalid status "${input.status}": use done | failed | skipped`);
  if (!db.playbooks.get(input.playbook)) throw new Error(`no playbook named "${input.playbook}"`);
  let run: PlaybookRunRow | undefined;
  if (input.runId === undefined) {
    run = db.playbooks
      .runs({ playbook: input.playbook, limit: 1000 })
      .find((r) => r.status === "started" && r.trigger === "mcp");
    if (!run)
      throw new Error(
        `playbook ${input.playbook} has no started run from em_playbook to report on; pass the run id (run_id) to close a CLI or dashboard run`,
      );
  } else {
    run = db.playbooks.getRun(input.runId);
    if (run?.playbook !== input.playbook) run = undefined;
    if (!run) throw new Error(`no run ${input.runId} for playbook ${input.playbook}`);
    if (run.status !== "started")
      throw new Error(`run ${run.id} is already ${run.status}; a closed run is not changed`);
  }
  const note = input.note ? mask(oneLine(input.note)).slice(0, MAX_NOTE) : undefined;
  if (!db.playbooks.runSetStatus(run.id, input.status, note))
    throw new Error(`run ${run.id} is already closed; a closed run is not changed`);
  return { id: run.id };
}

export function runs(
  ctx: ProjectContext,
  db: StorageAdapter,
  opts: { playbook?: string | undefined; limit?: number | undefined } = {},
): PlaybookRunRow[] {
  assertViewing(ctx);
  return db.playbooks.runs(opts);
}

// --- suggestions -----------------------------------------------------------------------

export interface SuggestInput extends PlaybookFields {
  name?: string | undefined;
  /** The recurring pattern that prompted it. */
  evidence?: string | undefined;
  sessionId?: string | undefined;
}

/**
 * Store a suggested playbook for a person to accept or dismiss. The same task (same prompt,
 * ignoring case and spacing) is stored once, whatever its status. Needs
 * `playbooks.extraction.enabled` and `playbooks.adding`: nothing is suggested while either is off.
 */
export function suggest(
  ctx: ProjectContext,
  db: StorageAdapter,
  input: SuggestInput,
): { id: number; created: boolean } {
  assertExtraction(ctx);
  assertAdding(ctx);
  const c = clean(input, true, "");
  const name = input.name?.trim() || slugify(c.title);
  assertValidName(name);
  return db.playbooks.suggestionAdd({
    name,
    title: c.title,
    prompt: c.prompt,
    params: c.params,
    schedule: c.schedule,
    tags: c.tags,
    evidence: input.evidence ? mask(oneLine(input.evidence)).slice(0, MAX_NOTE) : undefined,
    sessionId: input.sessionId,
  });
}

export function suggestions(
  ctx: ProjectContext,
  db: StorageAdapter,
  opts: { status?: PlaybookSuggestionStatus | undefined; limit?: number | undefined } = {},
): PlaybookSuggestionRow[] {
  assertExtraction(ctx);
  return db.playbooks.suggestions(opts as Parameters<typeof db.playbooks.suggestions>[0]);
}

/** Turn a pending suggestion into a playbook (source "suggested"); `overrides` edit it first. */
export function acceptSuggestion(
  ctx: ProjectContext,
  db: StorageAdapter,
  id: number,
  overrides: Partial<WriteInput> = {},
): { name: string; path: string } {
  assertExtraction(ctx);
  assertAdding(ctx);
  const s = db.playbooks.suggestionGet(id);
  if (!s) throw new Error(`no suggestion with id ${id}`);
  if (s.status !== "pending") throw new Error(`suggestion ${id} is already ${s.status}`);
  const w = write(ctx, db, {
    // a taken name gets a numbered one: accepting must not overwrite a playbook
    name:
      overrides.name ?? (isValidName(s.name) && !nameTaken(ctx, db, s.name) ? s.name : undefined),
    title: overrides.title ?? s.title,
    prompt: overrides.prompt ?? s.prompt,
    params: overrides.params ?? rowParams(s),
    schedule: overrides.schedule ?? s.schedule ?? undefined,
    tags: overrides.tags ?? rowTags(s),
    private: overrides.private,
    source: "suggested",
  });
  // The update only applies to a pending row. Losing the race (another process accepted it
  // after our check) means that process owns the playbook: take ours back out.
  if (!db.playbooks.suggestionSetStatus(id, "accepted", w.name)) {
    remove(ctx, db, w.name);
    throw new Error(`suggestion ${id} is already accepted or dismissed`);
  }
  return { name: w.name, path: w.path };
}

export function dismissSuggestion(ctx: ProjectContext, db: StorageAdapter, id: number): boolean {
  assertExtraction(ctx);
  assertAdding(ctx);
  const s = db.playbooks.suggestionGet(id);
  if (s?.status !== "pending") return false;
  return db.playbooks.suggestionSetStatus(id, "dismissed");
}
