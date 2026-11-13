/**
 * Which model an agent definition pins, found the way Claude Code finds the definition
 * (code.claude.com/docs/en/sub-agents, "Choose the subagent scope"):
 *
 *   1 managed     <managed settings dir>/.claude/agents/
 *   2 --agents    session JSON: invisible to a hook (see `unknown` below)
 *   3 project     every .claude/agents/ from the cwd up to the repository root, closest first
 *   4 user        ~/.claude/agents/ (CLAUDE_CONFIG_DIR/agents/ when set)
 *   5 plugin      the plugin's agents/ (or its manifest `agents` paths), only by scoped name
 *   built-ins     general-purpose, Explore, Plan (no pin), statusline-setup, claude-code-guide
 *   fork          `fork` (Agent(fork)) is no definition: it runs on the main session's model
 *
 * Project, user and managed directories are scanned recursively and an agent is identified by its
 * frontmatter `name` alone (the file name does not matter). A plugin agent is `plugin:agent`, or
 * `plugin:sub:agent` for agents/sub/agent.md. Apply mode must never override a pin it cannot see,
 * so whenever the definition cannot be read with certainty the answer is `unknown`, never
 * `unpinned`. Read-only, synchronous and bounded; never throws.
 *
 * A swarm role with a model range (swarm.yaml `model_range`) is `ranged`: `eminiar swarm sync`
 * wrote its file with `model: <fallback>` and `range=<floor>..<ceiling>` in the marker. The range
 * counts only while the file is untouched (its hash verifies) and the fallback lies inside it;
 * anything else is the plain pin of the frontmatter `model`.
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { claudeConfigDir, claudePluginsDir } from "../paths.js";
import { agentFileRange } from "../swarm/agents.js";
import type { ModelRange } from "../swarm/types.js";
import { isPinned, tierOf, tierRank } from "./savings.js";

export type PinStatus = "pinned" | "ranged" | "unpinned" | "unknown";
export type PinSource = "managed" | "project" | "user" | "plugin" | "builtin";

export interface AgentPin {
  /**
   * pinned: a `model` other than inherit; ranged: a generated swarm agent whose `model` is the
   * fallback inside a model range; unpinned: found without one; unknown: cannot tell.
   */
  status: PinStatus;
  /** The pinned model (pinned), or the fallback the agent runs on unless the adjudicator picks (ranged). */
  model?: string;
  /** The tiers a ranged agent's model may move between, floor below ceiling (ranged only). */
  range?: ModelRange;
  /**
   * unpinned only: the definition says `model: inherit`, so it runs on the main session's model
   * even when CLAUDE_CODE_SUBAGENT_MODEL is set (no `model` line falls back to that variable).
   */
  inherit?: boolean;
  source?: PinSource;
  /** The definition file, with the home directory shown as `~`. */
  file?: string;
  /** Why, in a few words (stored on the adjudication row). */
  reason: string;
  /**
   * What the definition grants (security adjudication): read from the same file as the pin, so
   * there is no extra I/O. Absent when no definition was found.
   */
  grant?: AgentGrant;
}

/**
 * The tool-related frontmatter of an agent definition. `tools` unset: the agent inherits the
 * session's tools. `conflict`: definitions at the winning location disagree, so nothing here
 * can be trusted (the grant is unknown).
 */
export interface AgentGrant {
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  /** The definition names `mcpServers` (its own servers, not enumerated). */
  mcpServers?: boolean;
  /** The definition's description, a signal for the task cues; never stored or sent. */
  description?: string;
  conflict?: boolean;
}

export interface PinLookup {
  /** The project root. */
  root: string;
  /** The hook's cwd; project agent dirs are walked up from here. */
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Test seam: the managed settings directory (null: none). */
  managedDir?: string | null | undefined;
}

/**
 * The subagent_type of a fork (sub-agents.md "Fork the current conversation"): it inherits the
 * main session's system prompt, tools and model, so it has no pin, no `model` and no per-call
 * `effort` to advise.
 */
export const FORK_AGENT = "fork";

/** The dispatch starts a fork. */
export function isFork(agentType: string | undefined): boolean {
  return agentType === FORK_AGENT;
}

/** Built-in agent types and the model each one runs on when no file overrides it. */
const BUILTIN: Record<string, string | undefined> = {
  "general-purpose": undefined,
  Explore: undefined,
  Plan: undefined,
  "statusline-setup": "sonnet",
  "claude-code-guide": "haiku",
};

/** Bounds on a recursive agents-directory scan. */
const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const MAX_BYTES = 256 * 1024;
/** How far above the project root the walk looks for the repository root. */
const MAX_UP = 8;

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

interface Def {
  file: string;
  name?: string | undefined;
  model?: string | undefined;
  /** The marker's model range, when sync wrote the file and nobody edited it since. */
  range?: ModelRange | undefined;
  grant?: AgentGrant | undefined;
}

interface Found {
  defs: Def[];
  /** The scan stopped at a bound, so a missing definition proves nothing. */
  truncated: boolean;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

/** The managed settings directory Claude Code reads per platform. */
function defaultManagedDir(): string | null {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "linux":
      return "/etc/claude-code";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return null;
  }
}

/** A top-level YAML scalar of the frontmatter, unquoted, without a trailing comment. */
function scalar(fm: string, key: string): string | undefined {
  const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(fm)?.[1]?.trim();
  if (!raw) return undefined;
  const q = raw[0];
  if (q === '"' || q === "'") {
    const end = raw.indexOf(q, 1);
    return end > 1 ? raw.slice(1, end).trim() || undefined : undefined;
  }
  return raw.replace(/\s+#.*$/, "").trim() || undefined;
}

/** Bounds on a tool list in a definition. */
const MAX_TOOLS = 256;
const MAX_DESCRIPTION = 2048;

/** Split on commas outside parentheses: `Agent(a, b), Read` is two entries. Linear. */
function splitTools(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of raw) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function toolName(entry: string): string | undefined {
  let t = entry.trim();
  const q = t[0];
  if ((q === '"' || q === "'") && t.endsWith(q) && t.length > 1) t = t.slice(1, -1).trim();
  t = t.replace(/\s+#.*$/, "").trim();
  // `Bash(git:*)` and `Agent(worker)` name the tool; the pattern in parentheses narrows it.
  const paren = t.indexOf("(");
  if (paren > 0) t = t.slice(0, paren).trim();
  return t && t.length <= 200 && !/[\s]/.test(t) ? t : undefined;
}

/**
 * A frontmatter list: a comma string (`tools: Read, Grep`), a flow list (`[Read, Grep]`) or a
 * block list (`- Read` lines under the key). undefined: the key is absent or has no entries.
 */
function toolList(fm: string, key: string): string[] | undefined {
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return undefined;
  let raw = lines[at]!.slice(key.length + 1).trim();
  const items: string[] = [];
  if (!raw || raw.startsWith("#")) {
    for (let i = at + 1; i < lines.length && items.length < MAX_TOOLS * 2; i++) {
      const m = /^[ \t]*-[ \t]+(.+)$/.exec(lines[i]!);
      if (m) items.push(m[1]!);
      else if (lines[i]!.trim() && !lines[i]!.trim().startsWith("#")) break;
    }
  } else {
    if (raw.startsWith("["))
      raw = raw.slice(1, raw.lastIndexOf("]") > 0 ? raw.lastIndexOf("]") : undefined);
    items.push(...splitTools(raw));
  }
  const names = items.map(toolName).filter((n): n is string => !!n);
  return names.length ? [...new Set(names)].slice(0, MAX_TOOLS) : undefined;
}

/** A scalar or a block scalar (`|` / `>`) value, as one line of text. */
function textOf(fm: string, key: string): string | undefined {
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return undefined;
  const first = lines[at]!.slice(key.length + 1).trim();
  if (/^[|>][+-]?$/.test(first)) {
    const body: string[] = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (lines[i] && !/^[ \t]/.test(lines[i]!)) break;
      body.push(lines[i]!.trim());
    }
    return body.join(" ").trim().slice(0, MAX_DESCRIPTION) || undefined;
  }
  return scalar(fm, key)?.slice(0, MAX_DESCRIPTION);
}

function grantOf(fm: string): AgentGrant {
  const g: AgentGrant = {};
  const tools = toolList(fm, "tools");
  if (tools) g.tools = tools;
  const dis = toolList(fm, "disallowedTools");
  if (dis) g.disallowedTools = dis;
  const mode = scalar(fm, "permissionMode");
  if (mode) g.permissionMode = mode;
  if (/^mcpServers:/m.test(fm)) g.mcpServers = true;
  const desc = textOf(fm, "description");
  if (desc) g.description = desc;
  return g;
}

function readDef(file: string, want?: string): Def | undefined {
  try {
    if (statSync(file).size > MAX_BYTES) return { file };
    const text = readFileSync(file, "utf8");
    const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (!fm) return { file };
    const def: Def = { file, name: scalar(fm, "name"), model: scalar(fm, "model") };
    // The grant is parsed only for the definition that is looked for (the scan reads every file).
    if (want === undefined || def.name === want) def.grant = grantOf(fm);
    // Only a marker that names a range is hashed (agentFileRange verifies the whole file).
    if (text.includes(" range=")) def.range = agentFileRange(text);
    return def;
  } catch {
    return undefined;
  }
}

/**
 * The range every definition at one location agrees on, when it is a real range around their
 * fallback `model`: two tiers or more, and the fallback's tier inside. opusplan has no one tier.
 */
function rangeOf(defs: Def[], model: string): ModelRange | undefined {
  const r = defs[0]?.range;
  if (!r || defs.some((d) => d.range?.floor !== r.floor || d.range?.ceiling !== r.ceiling))
    return undefined;
  const tier = model.toLowerCase() === "opusplan" ? undefined : tierOf(model);
  const [lo, hi, at] = [tierRank(r.floor), tierRank(r.ceiling), tierRank(tier)];
  return lo >= 0 && lo < hi && at >= lo && at <= hi
    ? { floor: r.floor, ceiling: r.ceiling }
    : undefined;
}

/** Every *.md under `dir`, recursively, within the scan bounds. */
function scan(dir: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const walk = (d: string, depth: number) => {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH) truncated = true;
        else walk(p, depth + 1);
      } else if (e.name.endsWith(".md")) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        files.push(p);
      }
    }
  };
  walk(dir, 0);
  return { files, truncated };
}

/** Definitions in a project/user/managed agents dir whose `name` is `type`. */
function byName(dir: string, type: string): Found {
  const { files, truncated } = scan(dir);
  const defs: Def[] = [];
  for (const f of files) {
    const d = readDef(f, type);
    if (d?.name === type) defs.push(d);
  }
  return { defs, truncated };
}

function shown(file: string, home: string): string {
  const rel = relative(home, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? join("~", rel) : file;
}

/**
 * The verdict for the definitions found at one location: their pins must agree (two files with
 * the same name load in filesystem order, which is not documented).
 */
function decide(defs: Def[], source: PinSource, home: string): AgentPin {
  const pin = decidePin(defs, source, home);
  const grant = agreedGrant(defs);
  return grant ? { ...pin, grant } : pin;
}

/** The grant every definition at the location agrees on; a conflict marks the grant unknown. */
function agreedGrant(defs: Def[]): AgentGrant | undefined {
  const first = defs[0]?.grant;
  if (!first) return undefined;
  const key = (g: AgentGrant | undefined) =>
    JSON.stringify([g?.tools, g?.disallowedTools, g?.permissionMode, g?.mcpServers]);
  return defs.some((d) => key(d.grant) !== key(first)) ? { conflict: true } : first;
}

function decidePin(defs: Def[], source: PinSource, home: string): AgentPin {
  const pins = new Set(defs.map((d) => (isPinned(d.model) ? d.model.trim() : "")));
  const first = defs[0]!;
  const file = shown(first.file, home);
  if (pins.size > 1)
    return {
      status: "unknown",
      source,
      file,
      reason: `${defs.length} ${source} definitions disagree on the model`,
    };
  const model = [...pins][0];
  if (!model) {
    const out: AgentPin = {
      status: "unpinned",
      source,
      file,
      reason: `${source} agent has no model pin`,
    };
    if (defs.every((d) => d.model?.trim().toLowerCase() === "inherit")) out.inherit = true;
    return out;
  }
  const range = rangeOf(defs, model);
  return range
    ? {
        status: "ranged",
        model,
        range,
        source,
        file,
        reason: `${source} agent ranges ${range.floor}..${range.ceiling} (fallback ${model})`,
      }
    : { status: "pinned", model, source, file, reason: `${source} agent pins model ${model}` };
}

/** The .claude/agents dirs from the cwd up to the repository root, closest first. */
function projectDirs(root: string, cwd: string | undefined): string[] {
  const top = resolve(root);
  const inside = (d: string) => {
    const rel = relative(top, d);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  let d = cwd && inside(resolve(cwd)) ? resolve(cwd) : top;
  const dirs: string[] = [];
  for (;;) {
    dirs.push(d);
    if (d === top) break;
    d = dirname(d);
  }
  // The project root may sit below the repository root: walk on to the directory with .git.
  if (!existsSync(join(top, ".git"))) {
    const above: string[] = [];
    let u = top;
    for (let i = 0; i < MAX_UP; i++) {
      const parent = dirname(u);
      if (parent === u) break;
      u = parent;
      above.push(u);
      if (existsSync(join(u, ".git"))) {
        dirs.push(...above);
        break;
      }
    }
  }
  return dirs.map((x) => join(x, ".claude", "agents"));
}

/** The installed copies of `plugin`: installed_plugins.json, plus CLAUDE_CODE_PLUGIN_DIRS. */
function pluginDirs(plugin: string, env: NodeJS.ProcessEnv, home: string): string[] {
  const out = new Set<string>();
  const pluginsRoot = claudePluginsDir(env, home);
  try {
    const j = JSON.parse(readFileSync(join(pluginsRoot, "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, unknown>;
    };
    for (const [key, val] of Object.entries(j?.plugins ?? {})) {
      const at = key.lastIndexOf("@");
      if ((at > 0 ? key.slice(0, at) : key) !== plugin) continue;
      for (const e of Array.isArray(val) ? val : [val]) {
        const p = (e as { installPath?: unknown } | null)?.installPath;
        if (typeof p === "string" && p) out.add(p);
      }
    }
  } catch {
    // no install record: only session plugin dirs remain
  }
  const sep = process.platform === "win32" ? ";" : ":";
  for (const raw of (env.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(sep)) {
    const p = raw.trim().replace(/^~(?=$|[/\\])/, home);
    if (!p || !isAbsolute(p)) continue;
    const name = manifest(p)?.name;
    if ((typeof name === "string" ? name : basename(p)) === plugin) out.add(p);
  }
  return [...out];
}

function manifest(dir: string): Record<string, unknown> | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    return m && typeof m === "object" ? (m as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The agents paths of one installed plugin: the manifest's `agents` replaces agents/. */
function agentPaths(dir: string): string[] {
  const a = manifest(dir)?.agents;
  const list =
    typeof a === "string" ? [a] : Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  return (list.length ? list : ["./agents"]).map((p) => resolve(dir, p));
}

/** Definitions of `plugin:[sub:]agent` across the plugin's installed copies. */
function pluginDefs(segments: string[], env: NodeJS.ProcessEnv, home: string): Found | string {
  const [plugin, ...rest] = segments;
  const agent = rest.at(-1)!;
  const sub = rest.slice(0, -1);
  const installs = pluginDirs(plugin!, env, home);
  if (!installs.length) return `plugin ${plugin} is not installed where eminiar can see it`;
  const defs: Def[] = [];
  const matches = (d: Def | undefined, file: string) =>
    !!d && (d.name === agent || basename(file, ".md") === agent);
  for (const install of installs) {
    for (const p of agentPaths(install)) {
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) {
        if (!sub.length && p.endsWith(".md")) {
          const d = readDef(p);
          if (matches(d, p)) defs.push(d!);
        }
        continue;
      }
      let entries: string[];
      try {
        entries = readdirSync(join(p, ...sub)).filter((n) => n.endsWith(".md"));
      } catch {
        continue;
      }
      for (const n of entries) {
        const f = join(p, ...sub, n);
        const d = readDef(f);
        if (matches(d, f)) defs.push(d!);
      }
    }
  }
  return { defs, truncated: false };
}

/** The model pin of the agent a dispatch names, in Claude Code's lookup order. */
export function resolveAgentPin(agentType: string, q: PinLookup): AgentPin {
  try {
    if (isFork(agentType))
      return {
        status: "unpinned",
        source: "builtin",
        reason: "a fork runs on the main session's model",
      };
    const env = q.env ?? process.env;
    const home = homeOf(env);

    if (agentType.includes(":")) {
      const segments = agentType.split(":");
      if (segments.length < 2 || !segments.every((s) => SEGMENT.test(s) && s !== "." && s !== ".."))
        return { status: "unknown", source: "plugin", reason: "malformed plugin agent name" };
      const found = pluginDefs(segments, env, home);
      if (typeof found === "string") return { status: "unknown", source: "plugin", reason: found };
      if (!found.defs.length)
        return {
          status: "unknown",
          source: "plugin",
          reason: `plugin agent ${agentType} has no definition file eminiar can read`,
        };
      return decide(found.defs, "plugin", home);
    }

    const managed = q.managedDir === undefined ? defaultManagedDir() : q.managedDir;
    const scopes: Array<[PinSource, string]> = [];
    if (managed) scopes.push(["managed", join(managed, ".claude", "agents")]);
    for (const d of projectDirs(q.root, q.cwd)) scopes.push(["project", d]);
    scopes.push(["user", join(claudeConfigDir(env, home), "agents")]);

    let truncated = false;
    for (const [source, dir] of scopes) {
      const found = byName(dir, agentType);
      if (found.defs.length) return decide(found.defs, source, home);
      truncated ||= found.truncated;
    }
    if (truncated)
      return { status: "unknown", reason: "an agents directory is too large to scan fully" };
    if (Object.hasOwn(BUILTIN, agentType)) {
      const model = BUILTIN[agentType];
      return model
        ? { status: "pinned", model, source: "builtin", reason: `built-in agent runs on ${model}` }
        : { status: "unpinned", source: "builtin", reason: "built-in agent has no model pin" };
    }
    return {
      status: "unknown",
      reason: `no definition of ${agentType} found (a --agents or plugin agent?)`,
    };
  } catch (err) {
    return { status: "unknown", reason: `agent lookup failed: ${(err as Error)?.message ?? err}` };
  }
}
