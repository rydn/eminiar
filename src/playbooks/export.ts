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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { redactSecrets } from "../adjudicator/redact.js";
import type { ProjectContext } from "../context.js";
import { within } from "../docs/manifest.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { oneLine } from "./frontmatter.js";
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
   * root and must stay inside it; an absolute path (for example ~/.claude/skills) is used as given.
   * Default: `.claude/skills` in the project.
   */
  targetDir?: string | undefined;
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
}

const mask = (s: string): string => redactSecrets(s);

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

/** The skill text. Masked again here: the stored playbook may predate a new redaction rule. */
export function renderSkill(
  file: PlaybookFile,
  opts: Pick<ExportSkillOptions, "sideEffecting" | "allowedTools" | "values"> = {},
): string {
  assertSkillName(file.name);
  const sideEffecting = opts.sideEffecting ?? true;
  const tools = cleanTools(opts.allowedTools);
  const head = ["---", `name: ${file.name}`, `description: ${yamlString(describe(file))}`];
  if (sideEffecting) head.push("disable-model-invocation: true");
  if (tools.length > 0) head.push(`allowed-tools: ${yamlString(tools.join(", "))}`);
  head.push("---");

  const body: string[] = [`${EXPORT_MARKER} name=${file.name} -->`, ""];
  body.push(`# ${mask(oneLine(file.title))}`, "");
  body.push(mask(fillPrompt(file, opts.values)).trim(), "");
  if (file.params.length > 0) {
    body.push(
      "Parameters (pass them as arguments; a missing one keeps its default):",
      ...file.params.map(
        (p) =>
          `- ${p.name}${p.default !== undefined ? ` (default: ${mask(oneLine(p.default))})` : ""}`,
      ),
      "",
      "Arguments: $ARGUMENTS",
      "",
    );
  }
  return `${head.join("\n")}\n\n${body.join("\n")}`;
}

/** Lexical and real-path check that `dir` is inside the project when it is meant to be. */
function resolveTarget(ctx: ProjectContext, targetDir: string | undefined): string {
  const root = resolve(ctx.root);
  const raw = targetDir ?? DEFAULT_SKILLS_DIR;
  if (raw.includes("\0")) throw new Error("invalid target directory");
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const inProject = !isAbsolute(raw) || within(abs, root);
  if (!isAbsolute(raw) && !within(abs, root))
    throw new Error("target directory must stay inside the project");
  if (inProject) {
    // the nearest existing parent must really resolve inside the project (no symlink out)
    let probe = abs;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    let realRoot = root;
    try {
      realRoot = realpathSync.native(root);
    } catch {
      /* keep root */
    }
    if (!within(realpathSync.native(probe), realRoot))
      throw new Error("target directory resolves outside the project");
  }
  return abs;
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
  const content = renderSkill(file, opts);
  const dir = join(resolveTarget(ctx, opts.targetDir), name);
  if (!within(dir, resolveTarget(ctx, opts.targetDir))) throw new Error("invalid skill name");
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
    if (!readFileSync(path, "utf8").includes(EXPORT_MARKER))
      throw new Error(
        `refusing to overwrite ${path}: it was not created by eminiar (no export marker)`,
      );
    created = false;
  }
  mkdirSync(dir, { recursive: true });
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
  return { name, path, created, sideEffecting: opts.sideEffecting ?? true, content };
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
