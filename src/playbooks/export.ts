import {
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../adjudicator/redact.js";
import type { ProjectContext } from "../context.js";
import { within } from "../docs/manifest.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { oneLine, serializePlaybookFile } from "./frontmatter.js";
import { gitIgnoredFor } from "./git.js";
import { assertAdding, fillPrompt, type PlaybookFile, read } from "./store.js";

/**
 * Export a playbook as a Claude Code skill (`<dir>/<name>/SKILL.md`) and as a printable prompt
 * for a Desktop or cloud scheduled task. eminiar writes the file and prints the text; it never
 * runs or schedules anything.
 *
 * A skill file written here carries a marker comment. Re-exporting replaces only a file that has
 * it, so a skill someone wrote by hand (or edited into their own) is never overwritten.
 */

/** Skill names are lowercase letters, digits and single hyphens (stricter than a playbook name). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** First line of the body of every exported skill; its presence means "eminiar made this". */
export const EXPORT_MARKER = "<!-- eminiar:playbook-export";

export const DEFAULT_SKILLS_DIR = ".claude/skills";

const MAX_DESCRIPTION = 300;
/** A tool entry such as `Read`, `Bash(git log:*)`, `mcp__x__y`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const TOOL_BAD_RE = /[\u0000-\u001f\u007f"\\]/;

export interface ExportSkillOptions {
  /**
   * Directory the `<name>/SKILL.md` folder goes in. Relative paths resolve against the project
   * root; the resolved folder (symlinks followed) must stay inside the project, an absolute path
   * included. Default: `.claude/skills` in the project.
   */
  targetDir?: string | undefined;
  /**
   * Write to the user-level skills folder (`~/.claude/skills`, a skill every project sees) instead
   * of the project. Only a human at a terminal may ask for this: the CLI sets it from `--user`,
   * the MCP tool and the dashboard never do. Cannot be combined with `targetDir`.
   */
  userScope?: boolean | undefined;
  /**
   * Export a private playbook even though the target folder is not git-ignored (it will be
   * committable). CLI only (`--allow-private`); the MCP tool never sets it.
   */
  allowPrivate?: boolean | undefined;
  /**
   * The playbook changes things outside the repo (posts, merges, deploys). A side-effecting skill
   * gets `disable-model-invocation: true`, so only the person can start it. Default true: the
   * safe side when nobody said otherwise.
   */
  sideEffecting?: boolean | undefined;
  /** Pre-approved tools for the skill (`allowed-tools`), for example `["Read", "Bash(git log:*)"]`. */
  allowedTools?: string[] | undefined;
  /** Parameter values to bake into the prompt instead of the `{{param}}` placeholder. */
  values?: Record<string, string> | undefined;
}

export interface ExportSkillResult {
  name: string;
  /** Absolute path of the SKILL.md. */
  path: string;
  /** False when an earlier eminiar export was replaced. */
  created: boolean;
  sideEffecting: boolean;
  content: string;
  /**
   * How many Claude Code constructs in the playbook text were defused so the skill does not run
   * or substitute them when it loads: a bang-backtick command, a fenced bang block, $ARGUMENTS,
   * $0 or ${NAME}.
   */
  escaped: number;
}

const mask = (s: string): string => redactSecrets(s);

/**
 * Claude Code expands some text in a SKILL.md before the model reads it: !`cmd` and a ```! block
 * run a shell command; $ARGUMENTS, $0/$1 and ${NAME} are substituted. A stored prompt is data, so
 * each is defused with a space that breaks the syntax and keeps the text readable. `count.n`
 * says how many were changed.
 */
const SKILL_SYNTAX: ReadonlyArray<readonly [RegExp, string]> = [
  [/(`{3,})!/g, "$1 !"],
  [/!(?=`)/g, "! "],
  [/\$(?=ARGUMENTS|\d|\{)/g, "$ "],
];
export function neutraliseSkillSyntax(s: string, count: { n: number }): string {
  let out = s;
  for (const [re, to] of SKILL_SYNTAX)
    out = out.replace(re, (...m) => {
      count.n++;
      return to.replace("$1", m[1] as string);
    });
  return out;
}

/** A YAML scalar that cannot break out of its line: JSON string syntax is valid YAML. */
const yamlString = (s: string): string => JSON.stringify(oneLine(s));

export function isValidSkillName(name: string): boolean {
  return name.length <= 64 && SKILL_NAME_RE.test(name);
}

function assertSkillName(name: string): void {
  if (!isValidSkillName(name))
    throw new Error(
      `invalid skill name ${JSON.stringify(name)}: use lowercase letters, digits and single hyphens (max 64)`,
    );
}

function cleanTools(tools: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tools ?? []) {
    const t = raw.trim();
    if (t.length === 0) continue;
    if (TOOL_BAD_RE.test(t) || t.length > 200 || t.includes(","))
      throw new Error(`invalid allowed tool ${JSON.stringify(raw)}`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function describe(file: PlaybookFile): string {
  let d = mask(oneLine(file.title));
  if (file.schedule) d += ` (${mask(oneLine(file.schedule))})`;
  d = `${d}. Use when asked to: ${mask(oneLine(file.title)).toLowerCase()}`.slice(
    0,
    MAX_DESCRIPTION,
  );
  return d;
}

/**
 * The skill text and how many Claude Code constructs were defused in it. Masked again here: the
 * stored playbook may predate a new redaction rule.
 */
function renderSkillParts(
  file: PlaybookFile,
  opts: Pick<ExportSkillOptions, "sideEffecting" | "allowedTools" | "values"> = {},
): { content: string; escaped: number } {
  assertSkillName(file.name);
  const sideEffecting = opts.sideEffecting ?? true;
  const tools = cleanTools(opts.allowedTools);
  const count = { n: 0 };
  const safe = (s: string): string => neutraliseSkillSyntax(s, count);
  const head = ["---", `name: ${file.name}`, `description: ${yamlString(safe(describe(file)))}`];
  if (sideEffecting) head.push("disable-model-invocation: true");
  if (tools.length > 0) head.push(`allowed-tools: ${yamlString(tools.join(", "))}`);
  head.push("---");

  const body: string[] = [`${EXPORT_MARKER} name=${file.name} -->`, ""];
  body.push(`# ${safe(mask(oneLine(file.title)))}`, "");
  body.push(safe(mask(fillPrompt(file, opts.values))).trim(), "");
  if (file.params.length > 0) {
    body.push(
      "Parameters (pass them as arguments; a missing one keeps its default):",
      ...file.params.map(
        (p) =>
          `- ${p.name}${p.default !== undefined ? ` (default: ${safe(mask(oneLine(p.default)))})` : ""}`,
      ),
      "",
      // eminiar's own substitution, added after the stored text was defused
      "Arguments: $ARGUMENTS",
      "",
    );
  }
  return { content: `${head.join("\n")}\n\n${body.join("\n")}`, escaped: count.n };
}

export function renderSkill(
  file: PlaybookFile,
  opts: Pick<ExportSkillOptions, "sideEffecting" | "allowedTools" | "values"> = {},
): string {
  return renderSkillParts(file, opts).content;
}

/**
 * Where the skill folder goes. The project's own folders only (the resolved real path must stay
 * inside the project, an absolute `targetDir` included), or, for a human at the CLI, the user's
 * `~/.claude/skills`. A caller-supplied path never reaches outside the project.
 */
function resolveTarget(
  ctx: ProjectContext,
  targetDir: string | undefined,
  userScope: boolean,
): { dir: string; inProject: boolean } {
  if (userScope) {
    if (targetDir !== undefined) throw new Error("a user-level export has no target directory");
    return { dir: join(homedir(), ".claude", "skills"), inProject: false };
  }
  const root = resolve(ctx.root);
  const raw = targetDir ?? DEFAULT_SKILLS_DIR;
  if (raw.includes("\0")) throw new Error("invalid target directory");
  // git reads a leading `:` as pathspec magic (`:/dist` is the top-level dist); git.ts already
  // spells paths literally, and a folder named like that is refused before it gets that far
  if (/^(?:\.[/\\])*:/.test(raw))
    throw new Error("invalid target directory: it must not start with ':'");
  let realRoot = root;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    /* keep root */
  }
  const abs = resolve(root, raw);
  if (!isAbsolute(raw) && !within(abs, root))
    throw new Error("target directory must stay inside the project");
  // The nearest existing parent must really resolve inside the project: no symlink out, and an
  // absolute path (spelled with or without the real root) is judged by where it lands.
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (!within(realpathSync.native(probe), realRoot))
    throw new Error(
      "target directory must stay inside the project: it resolves outside the project",
    );
  return { dir: abs, inProject: true };
}

/**
 * A private playbook must not land in a folder that is committed. git decides (`check-ignore`
 * knows later negations, nested ignore files and the global excludes); anything but "ignored" -
 * not ignored, not a repository, git missing, a timeout - refuses. Git is asked from the folder
 * that will hold the file, so a nested repository or worktree answers for its own files. With
 * the index: a tracked SKILL.md is not ignored.
 */
function assertGitIgnored(ctx: ProjectContext, path: string, name: string): void {
  if (gitIgnoredFor(ctx.root, path) === "ignored") return;
  const rel = relative(resolve(ctx.root), path);
  const why = `playbook ${name} is private and ${rel} is not git-ignored, so the skill could be committed`;
  throw new Error(
    `refusing to export: ${why} (or git could not say). Add the folder to .gitignore, or make the playbook public; the CLI can override with --allow-private`,
  );
}

/** The same directory object (device and inode), and a real directory rather than a link. */
const sameDir = (a: Stats | undefined, b: Stats): boolean =>
  a?.isDirectory() === true && !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;

/**
 * `mkdir -p want` below `base` (both real paths, `base` an existing folder), one folder at a
 * time. Each folder on the way must be a real directory when it is reached, and its parent the
 * same directory object right before and right after a folder is made in it: a parent swapped for
 * a link in between would have put the new folder somewhere else, so that is detected, the folder
 * removed again, and the call refused. `leafMode` is the mode of the last folder when it is made.
 * Node has no mkdirat, so this cannot rule a swap out, only detect it around each mkdir.
 */
function makeDirs(base: string, want: string, leafMode: number, fail: () => Error): void {
  let cur = base;
  let curSt = lstatSync(cur);
  if (curSt.isSymbolicLink() || !curSt.isDirectory()) throw fail();
  const rel = relative(base, want);
  if (rel === "") return;
  const parts = rel.split(sep);
  if (isAbsolute(rel) || parts.some((p) => p === "" || p === "." || p === "..")) throw fail();
  const parentStill = (): boolean => sameDir(lstatSync(cur, { throwIfNoEntry: false }), curSt);
  for (const [i, part] of parts.entries()) {
    const next = join(cur, part);
    let st = lstatSync(next, { throwIfNoEntry: false });
    if (!st) {
      if (!parentStill()) throw fail();
      let made = false;
      try {
        mkdirSync(next, i === parts.length - 1 ? leafMode : 0o777);
        made = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      if (!parentStill()) {
        if (made) {
          try {
            rmdirSync(next); // where the swapped link sent it, while the link is still there
          } catch {
            /* gone, or not empty: not ours to remove */
          }
        }
        throw fail();
      }
      st = lstatSync(next, { throwIfNoEntry: false });
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory() || !parentStill()) throw fail();
    cur = next;
    curSt = st;
  }
}

/**
 * chmod 0700 of the folder `dir` through a descriptor opened without following a final link, and
 * only when the folder it names really is `dir` (same device and inode as the real path now) and
 * that real path passes `ok`. A component swapped for a link makes the two differ, so the chmod
 * can never reach a folder outside. Without O_DIRECTORY/O_NOFOLLOW (Windows, which has no such
 * modes anyway) nothing is tightened.
 */
function tightenDir(dir: string, ok: (real: string) => boolean, fail: () => Error): void {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fsConstants;
  if (O_DIRECTORY === undefined || O_NOFOLLOW === undefined) return;
  let fd: number;
  try {
    fd = openSync(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch {
    throw fail(); // a link, or no longer a folder
  }
  try {
    const st = fstatSync(fd);
    if ((st.mode & 0o077) === 0) return;
    let real: string;
    let rs: Stats;
    try {
      real = realpathSync.native(dir);
      rs = statSync(real);
    } catch {
      throw fail();
    }
    if (rs.dev !== st.dev || rs.ino !== st.ino || !ok(real)) throw fail();
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

/** True when the marker is the exact line eminiar writes: first body line after the front matter. */
function hasExportMarker(text: string, name: string): boolean {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end < 0) return false;
  let i = end + 1;
  while (i < lines.length && lines[i]?.trim() === "") i++;
  return lines[i] === `${EXPORT_MARKER} name=${name} -->`;
}

export function exportSkill(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
  opts: ExportSkillOptions = {},
): ExportSkillResult {
  assertAdding(ctx); // writes a file, so it follows the same switch as every other write
  assertSkillName(name);
  const file = read(ctx, db, name);
  if (!file) throw new Error(`no playbook named ${JSON.stringify(name)}`);
  const { content, escaped } = renderSkillParts(file, opts);
  const { dir: target, inProject } = resolveTarget(ctx, opts.targetDir, opts.userScope === true);
  const dir = join(target, name);
  if (!within(dir, target)) throw new Error("invalid skill name");
  if (file.private && inProject && !opts.allowPrivate)
    assertGitIgnored(ctx, join(dir, "SKILL.md"), name);
  try {
    const ds = lstatSync(dir);
    if (ds.isSymbolicLink() || !ds.isDirectory())
      throw new Error(`refusing to write into ${dir}: not a plain directory`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const path = join(dir, "SKILL.md");

  let created = true;
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(path);
  } catch {
    st = undefined;
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isFile())
      throw new Error(`refusing to overwrite ${path}: not a regular file`);
    if (!hasExportMarker(readFileSync(path, "utf8"), name))
      throw new Error(
        `refusing to overwrite ${path}: it was not created by eminiar (no export marker)`,
      );
    created = false;
  }
  // A concurrent writer may swap a path component for a symlink between the checks above and the
  // write. So: make the folders one at a time, checking each parent around the mkdir; resolve the
  // directory once, require the result to sit inside the project (not only below the target),
  // write through that resolved name, and re-check where the temp file and the final file really
  // are, removing them if they left the project. Nothing is made or chmodded through a link.
  let realRoot = resolve(ctx.root);
  try {
    realRoot = realpathSync.native(realRoot);
  } catch {
    /* keep root */
  }
  const outside = `refusing to write into ${dir}: it resolves outside the target directory`;
  const fail = (): Error => new Error(outside);
  const dirOk = (rd: string): boolean =>
    dirname(rd) === realpathSync.native(target) && (!inProject || within(rd, realRoot));
  const escapes = (p: string): boolean => {
    try {
      return !dirOk(realpathSync.native(dirname(p)));
    } catch {
      return true;
    }
  };
  // the folder as a real path: the real path of its nearest existing ancestor, plus the rest
  let probe = dir;
  while (!lstatSync(probe, { throwIfNoEntry: false }) && dirname(probe) !== probe)
    probe = dirname(probe);
  let realProbe: string;
  try {
    realProbe = realpathSync.native(probe);
  } catch {
    throw fail(); // a dangling link or a loop
  }
  const want = join(realProbe, relative(probe, dir));
  if (inProject && !within(want, realRoot)) throw fail();
  makeDirs(inProject ? realRoot : realProbe, want, file.private ? 0o700 : 0o777, fail);
  if (escapes(path)) throw fail();
  const realDir = realpathSync.native(dir);
  // A private playbook stays its owner's on disk too, as in the store: a 0700 folder (an
  // existing looser one is tightened) and a 0600 file (the rename replaces an older 0644 one).
  if (file.private) tightenDir(realDir, dirOk, fail);
  const rpath = join(realDir, "SKILL.md");
  const tmp = `${rpath}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", file.private ? 0o600 : 0o666);
    if (escapes(tmp)) throw new Error(outside);
    writeSync(fd, content);
    closeSync(fd);
    fd = undefined;
    if (escapes(tmp)) throw new Error(outside);
    renameSync(tmp, rpath);
    if (escapes(path)) {
      unlinkSync(rpath);
      throw new Error(outside);
    }
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
  return { name, path, created, sideEffecting: opts.sideEffecting ?? true, content, escaped };
}

/**
 * Text to paste into a Desktop or cloud scheduled task. Self-contained (a cloud run has no
 * eminiar), masked, with the schedule hint at the top as a note for whoever sets the schedule.
 */
export function schedulePrompt(
  ctx: ProjectContext,
  db: StorageAdapter,
  name: string,
  values: Record<string, string> = {},
): string {
  const file = read(ctx, db, name);
  if (!file) throw new Error(`no playbook named ${JSON.stringify(name)}`);
  const lines: string[] = [];
  lines.push(`Scheduled task: ${mask(oneLine(file.title))}`);
  if (file.schedule) lines.push(`Suggested schedule: ${mask(oneLine(file.schedule))}`);
  lines.push("", mask(fillPrompt(file, values)).trim(), "");
  return lines.join("\n");
}

/** The playbook as its own markdown file (front matter and prompt), for copying elsewhere. */
export function exportMarkdown(file: PlaybookFile): string {
  const meta: Record<string, string | string[]> = {
    name: file.name,
    title: file.title,
    tags: file.tags,
  };
  if (file.params.length)
    meta.params = file.params.map((p) =>
      p.default === undefined ? p.name : `${p.name}=${p.default}`,
    );
  if (file.schedule) meta.schedule = file.schedule;
  return serializePlaybookFile(meta, `\n${file.prompt}\n`);
}
