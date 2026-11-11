import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redactSecrets } from "../adjudicator/redact.js";
import type { ProjectContext } from "../context.js";
import { within } from "../docs/manifest.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { oneLine, serializePlaybookFile } from "./frontmatter.js";
import { fillPrompt, type PlaybookFile, read } from "./store.js";

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
 * not ignored, not a repository, git missing, a timeout - refuses.
 */
function assertGitIgnored(ctx: ProjectContext, path: string, name: string): void {
  const root = resolve(ctx.root);
  let realRoot = root;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    /* keep root */
  }
  // name the file by where it really lands (the root may be spelled through a symlink)
  let probe = path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const real = join(realpathSync.native(probe), relative(probe, path));
  const rel = relative(realRoot, real);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv;
  const why = `playbook ${name} is private and ${rel} is not git-ignored, so the skill could be committed`;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], {
      cwd: root,
      env,
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    throw new Error(
      `refusing to export: ${why} (or git could not say). Add the folder to .gitignore, or make the playbook public; the CLI can override with --allow-private`,
    );
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
  mkdirSync(dir, { recursive: true });
  if (dirname(realpathSync.native(dir)) !== realpathSync.native(target))
    throw new Error(`refusing to write into ${dir}: it resolves outside the target directory`);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
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
