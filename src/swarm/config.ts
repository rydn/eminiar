import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { TIERS, type Tier } from "../adjudicator/types.js";
import { editDistance } from "../search/typo.js";
import { tierOf } from "../storage/dispatch.js";
import { READONLY_BUILTINS } from "./agents.js";
import { checkGlob, GlobError } from "./glob.js";

/**
 * `yaml` is loaded on first use: every hook process imports this module, and only projects
 * that have a swarm file ever parse one (it cost ~7 ms per hook otherwise).
 */
let yamlLib: typeof import("yaml") | undefined;
function yaml(): typeof import("yaml") {
  yamlLib ??= createRequire(import.meta.url)("yaml") as typeof import("yaml");
  return yamlLib;
}

import {
  type ConfigIssue,
  type ContextSpec,
  type LoadResult,
  type ModelRange,
  type RoleSpec,
  type SwarmConfig,
  type SwarmSpec,
  TOPOLOGIES,
} from "./types.js";

/** Candidate swarm files, in order; the first that exists wins. */
export const SWARM_FILES = [".eminiar/swarm.yaml", ".eminiar/swarm.yml"] as const;

/** Claude Code caps agent names; `swarm-<swarm>-<role>` must fit. */
const AGENT_NAME_MAX = 64;
/** Hyphen-separated words: no leading, trailing or doubled hyphens (`a--b` would put `---` in a name). */
const NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NAME_MAX = 32;
const NAME_MSG =
  "use 1-32 characters: lowercase letters and digits in words joined by single hyphens, starting with a letter (e.g. code-review)";
/**
 * Claude Code ends agent frontmatter at the first `---` anywhere in it, so no value that
 * lands in the frontmatter may contain one.
 */
const noFence = (s: string) => !s.includes("---");
const FENCE_MSG = 'must not contain "---" (Claude Code would end the agent frontmatter there)';
/** Model aliases Claude Code accepts, or a Claude model id (incl. Bedrock/Vertex forms). */
const MODEL_RE =
  /^(?:inherit|opusplan|(?:sonnet|opus|haiku|fable)(?:\[1m\])?|(?:[a-z0-9-]+\.)*claude-[a-z0-9.:@-]+(?:\[1m\])?)$/;

export const DEFAULT_CONTEXT: ContextSpec = {
  memories: 4,
  docs: 2,
  history: true,
  structure: true,
  insights: true,
  maxChars: 4000,
};

export const AGENT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

// --- raw YAML schema (snake_case) --------------------------------------------------------
// zod strips keys it does not know; parseSwarmYaml lists them first (unknownKeys) and keeps a
// typo of a known key an error.

const ToolName = z
  .string()
  .trim()
  .regex(
    /^[^,\r\n\t]{1,200}$/,
    "a tool name such as Read, Bash or mcp__server__tool (no commas or tabs)",
  )
  .refine(noFence, FENCE_MSG);
const SkillName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/,
    "a skill name such as em-history or eminiar:em-graph",
  )
  .refine(noFence, FENCE_MSG);
const Model = z
  .string()
  .max(100)
  .regex(MODEL_RE, "a model alias (inherit, sonnet, opus, haiku, fable) or a Claude model id")
  .refine(noFence, FENCE_MSG);
const rank = (t: Tier) => TIERS.indexOf(t);
/**
 * Bounds the adjudicator may move a role's model within. Each is one of the Agent tool's
 * `model` values; an unset bound is the fallback model's tier (see roleRange).
 */
const RawModelRange = z
  .object({ floor: z.enum(TIERS).optional(), ceiling: z.enum(TIERS).optional() })
  .refine(
    (r) => !r.floor || !r.ceiling || rank(r.floor) <= rank(r.ceiling),
    `floor must not be above ceiling (${TIERS.join(" < ")})`,
  );
const Glob = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (g) => !g.startsWith("/") && !/^[A-Za-z]:/.test(g) && !g.split(/[\\/]/).includes(".."),
    "a project-relative glob without '..'",
  )
  .superRefine((g, c) => {
    try {
      checkGlob(g);
    } catch (err) {
      c.addIssue({
        code: "custom",
        message: `not a usable glob: ${err instanceof GlobError ? err.message : String(err)}`,
      });
    }
  });

const AgentName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
    "an agent type such as Explore, statusline-setup or my-plugin:reviewer",
  )
  .refine(
    (n) => !n.startsWith("swarm-"),
    "swarm workers need no entry: they are allowed during a run of their swarm",
  );

const RawContext = z.object({
  memories: z.number().int().min(0).max(10).optional(),
  docs: z.number().int().min(0).max(10).optional(),
  history: z.boolean().optional(),
  structure: z.boolean().optional(),
  insights: z.boolean().optional(),
  // SubagentStart context over 10,000 characters is moved to a file Claude may never read.
  max_chars: z.number().int().min(500).max(9000).optional(),
});
type RawContext = z.infer<typeof RawContext>;

const RawHookCommand = z.object({
  type: z.literal("command"),
  command: z.string().trim().min(1).max(2000).refine(noFence, FENCE_MSG),
  timeout: z.number().int().positive().max(600).optional(),
});
const RawHookMatcher = z.object({
  matcher: z
    .string()
    .max(200)
    .refine(noFence, FENCE_MSG)
    .refine((m) => {
      try {
        new RegExp(m);
        return true;
      } catch {
        return false;
      }
    }, "not a valid regular expression (Claude Code matches tool names with it)")
    .optional(),
  hooks: z.array(RawHookCommand).min(1).max(10),
});
const RawHooks = z.object({
  PreToolUse: z.array(RawHookMatcher).max(10).optional(),
  PostToolUse: z.array(RawHookMatcher).max(10).optional(),
  Stop: z.array(RawHookMatcher).max(10).optional(),
});

const RawAgent = z.object({
  description: z.string().trim().min(1).max(500).refine(noFence, FENCE_MSG),
  prompt: z.string().max(20_000).optional(),
  model: Model.optional(),
  model_range: RawModelRange.optional(),
  tools: z.array(ToolName).max(80).optional(),
  tools_profile: z.enum(["readonly"]).optional(),
  disallowed_tools: z.array(ToolName).max(80).optional(),
  skills: z.array(SkillName).max(20).optional(),
  hooks: RawHooks.optional(),
  scope: z.array(Glob).max(30).optional(),
  memory_tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  count: z.number().int().min(1).max(8).optional(),
  isolation: z.literal("worktree").optional(),
  max_turns: z.number().int().min(1).max(500).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  color: z.enum(AGENT_COLORS).optional(),
  context: RawContext.optional(),
});
type RawAgent = z.infer<typeof RawAgent>;

const RawSwarm = z.object({
  description: z.string().trim().min(1).max(500),
  topology: z.enum(TOPOLOGIES).optional(),
  max_agents: z.number().int().min(1).max(16).optional(),
  stages: z.array(z.string()).max(32).optional(),
  instructions: z.string().max(20_000).optional(),
  context: RawContext.optional(),
  // Names are checked in resolve(): zod reports a bad record key only as "Invalid key".
  agents: z.record(z.string(), RawAgent),
});

// Loose at the top so `x-*` keys can hold YAML anchors.
const RawFile = z.looseObject({
  version: z.literal(1).optional(),
  enabled: z.boolean().optional(),
  sync: z.enum(["auto", "manual"]).optional(),
  enforce: z.boolean().optional(),
  allowed_agents: z.array(AgentName).max(50).optional(),
  defaults: z
    .object({
      model: Model.optional(),
      model_range: RawModelRange.optional(),
      skills: z.array(SkillName).max(20).optional(),
      context: RawContext.optional(),
    })
    .optional(),
  swarms: z.record(z.string(), RawSwarm),
});
type RawFile = z.infer<typeof RawFile>;
/** The file as a user may write it; edit.ts checks its draft type (doc-types.ts) against this. */
export type SwarmFileRaw = z.input<typeof RawFile>;

// --- helpers ----------------------------------------------------------------------------

export function agentTypeOf(swarm: string, role: string): string {
  return `swarm-${swarm}-${role}`;
}

function mergeContext(...layers: Array<RawContext | undefined>): ContextSpec {
  const out: ContextSpec = { ...DEFAULT_CONTEXT };
  for (const l of layers) {
    if (!l) continue;
    if (l.memories !== undefined) out.memories = l.memories;
    if (l.docs !== undefined) out.docs = l.docs;
    if (l.history !== undefined) out.history = l.history;
    if (l.structure !== undefined) out.structure = l.structure;
    if (l.insights !== undefined) out.insights = l.insights;
    if (l.max_chars !== undefined) out.maxChars = l.max_chars;
  }
  return out;
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** A key the schema does not know: the path of its object, the key, and that object's keys. */
interface UnknownKey {
  at: string[];
  key: string;
  known: string[];
}

/**
 * Walk the parsed YAML along the file schema and list the keys it does not know. Top-level
 * `x-*` keys (YAML anchor holders) and merge keys are part of the format.
 */
function unknownKeys(v: unknown, s: unknown = RawFile, at: string[] = []): UnknownKey[] {
  if (s instanceof z.ZodOptional) s = s.unwrap();
  if (Array.isArray(v))
    return s instanceof z.ZodArray
      ? v.flatMap((x, i) => unknownKeys(x, s.element, [...at, String(i)]))
      : [];
  if (!v || typeof v !== "object") return [];
  const entries = Object.entries(v);
  if (s instanceof z.ZodRecord)
    return entries.flatMap(([k, x]) => unknownKeys(x, s.valueType, [...at, k]));
  if (!(s instanceof z.ZodObject)) return [];
  const known = Object.keys(s.shape);
  return entries.flatMap(([k, x]) =>
    Object.hasOwn(s.shape, k)
      ? unknownKeys(x, s.shape[k], [...at, k])
      : at.length === 0 && (k.startsWith("x-") || k === "<<")
        ? []
        : [{ at, key: k, known }],
  );
}

/** Every key the file schema names at any level: one of them at the wrong level is misplaced. */
function schemaKeys(s: unknown = RawFile, out = new Set<string>()): Set<string> {
  if (s instanceof z.ZodOptional) s = s.unwrap();
  if (s instanceof z.ZodArray) schemaKeys(s.element, out);
  else if (s instanceof z.ZodRecord) schemaKeys(s.valueType, out);
  else if (s instanceof z.ZodObject)
    for (const [k, v] of Object.entries(s.shape))
      if (!out.has(k)) {
        out.add(k);
        schemaKeys(v, out);
      }
  return out;
}

/** An agent-level key that reads as a restriction: ignoring it would silently lift a limit. */
const RESTRICTION_KEY = /tool|scope|hook|allow|deny|permission|model|effort|count/i;

/**
 * Whether an unknown key inside a role could be meant as one of its restrictions: it names one
 * (`tool`, `scope`, `hook`, `allow`, `deny`, `permission`, `model`, `effort`, `count`) or is
 * within two edits of such a known key (`scp` for `scope`), whatever its length. Returns the
 * closest such known key, or "" when the key only looks like a restriction.
 */
function restrictionLike(key: string, known: readonly string[]): string | undefined {
  let best: { k: string; d: number } | undefined;
  for (const k of known) {
    if (!RESTRICTION_KEY.test(k)) continue;
    const d = editDistance(key.toLowerCase(), k.toLowerCase(), 2);
    if (d <= 2 && key.length >= 3 && (!best || d < best.d)) best = { k, d };
  }
  if (best) return best.k;
  return RESTRICTION_KEY.test(key) ? "" : undefined;
}

/**
 * The known key an unknown one is a typo of: equal but for case, or one edit away (two for
 * keys of 7+ characters, as search's typo correction counts them). `disallowedTools`,
 * `max_agent` and `enforced` are typos; `permission_mode` is not.
 */
function typoOf(key: string, known: readonly string[]): string | undefined {
  const max = key.length >= 7 ? 2 : 1;
  let best: { k: string; d: number } | undefined;
  for (const k of known) {
    const d = editDistance(key.toLowerCase(), k.toLowerCase(), max);
    if (d <= max && (!best || d < best.d)) best = { k, d };
  }
  return best?.k;
}

/**
 * A role's model range: its own `model_range`, else `defaults.model_range` (taken whole, never
 * merged per bound), with an unset bound at the fallback's tier. The fallback (`model`, else
 * `defaults.model`) is what the agent file pins and what the worker runs on whenever the
 * adjudicator does not choose, so it needs a known tier inside the range. Undefined for no
 * range, for `{}` (how a role opts out of the default) and for a range of one tier.
 */
function roleRange(
  defaults: RawFile["defaults"],
  a: RawAgent,
  at: string[],
  issue: (path: string[], message: string) => void,
): ModelRange | undefined {
  const spec = a.model_range ?? defaults?.model_range;
  if (!spec || (!spec.floor && !spec.ceiling)) return undefined;
  const model = a.model ?? defaults?.model;
  const rangeKey = a.model_range ? "model_range" : "defaults.model_range";
  const modelKey = a.model !== undefined ? "model" : "defaults.model";
  // A problem made only of defaults is reported once, at the defaults.
  const fromDefaults = !a.model_range && a.model === undefined;
  const path = a.model_range
    ? [...at, "model_range"]
    : fromDefaults
      ? ["defaults", "model_range"]
      : [...at, "model"];
  if (!model) {
    issue(
      path,
      `${rangeKey} needs a fallback model inside it: set ${fromDefaults ? "defaults.model, or model on every role without one" : "model on this role or defaults.model"} (the agent file pins it, and the worker runs on it whenever the adjudicator does not choose)`,
    );
    return undefined;
  }
  if (model === "inherit") {
    issue(
      path,
      `${modelKey} inherit cannot be the fallback of ${rangeKey}: the main session's model is not known in advance; set it to haiku, sonnet, opus or fable`,
    );
    return undefined;
  }
  // opusplan is opus while planning and sonnet otherwise: no one tier to check against.
  const tier = model === "opusplan" ? undefined : tierOf(model);
  if (!tier) {
    issue(
      path,
      `${modelKey} ${model} has no single tier, so it cannot be the fallback of ${rangeKey}; use haiku, sonnet, opus, fable or a model id of one of them`,
    );
    return undefined;
  }
  const floor = spec.floor ?? tier;
  const ceiling = spec.ceiling ?? tier;
  const outside =
    rank(tier) < rank(floor)
      ? `below the floor ${floor}`
      : rank(tier) > rank(ceiling)
        ? `above the ceiling ${ceiling}`
        : undefined;
  if (outside) {
    issue(
      path,
      `${modelKey} ${model} is ${outside} of ${rangeKey}: the fallback must lie inside the range`,
    );
    return undefined;
  }
  return floor === ceiling ? undefined : { floor, ceiling };
}

/** Locate the swarm file of a project, or the default path when none exists. */
export function swarmFile(root: string): { file: string; rel: string; exists: boolean } {
  for (const rel of SWARM_FILES) {
    const file = join(root, rel);
    if (existsSync(file)) return { file, rel, exists: true };
  }
  return { file: join(root, SWARM_FILES[0]), rel: SWARM_FILES[0], exists: false };
}

// --- parse + resolve --------------------------------------------------------------------

/**
 * Does the raw text ask for enforcement (top-level `enforce: true`, not switched off by
 * `enabled: false`)? Used when the file cannot be parsed, so an invalid file never silently
 * drops enforcement. bin/em-hook applies the same rule with grep, so keep the two in step.
 *
 * Accepts the YAML 1.2 spellings true/True/TRUE and false/False/FALSE, a plain or quoted
 * key, a BOM, CRLF, whitespace before the colon and a trailing ` # comment`. A quoted or
 * suffixed value ("true", trueish) is not a boolean and does not count, matching what
 * parseSwarmYaml reports. Known edge: a flow-style or indented whole document that fails to
 * parse is not recognised; when it does parse, the parsed value decides instead.
 */
export function enforceIntent(text: string): boolean {
  return topLevelFlag(text, "enforce", "true") && !topLevelFlag(text, "enabled", "false");
}

function topLevelFlag(text: string, key: string, word: "true" | "false"): boolean {
  const w = word === "true" ? "(?:true|True|TRUE)" : "(?:false|False|FALSE)";
  return new RegExp(
    `^\\uFEFF?(?:${key}|"${key}"|'${key}')[ \\t]*:[ \\t]+${w}(?:[ \\t]+#.*)?[ \\t]*\\r?$`,
    "m",
  ).test(text);
}

/** Parse and validate swarm YAML text. `rel`/`file` only label the result. */
export function parseSwarmYaml(text: string, file: string, rel: string): LoadResult {
  const Y = yaml();
  const lines = new Y.LineCounter();
  if (text.length > MAX_FILE_CHARS)
    return {
      state: "invalid",
      file,
      rel,
      enforce: enforceIntent(text),
      issues: [{ path: "", message: `the file is larger than ${MAX_FILE_CHARS / 1000} KB` }],
    };
  const doc = Y.parseDocument(text, {
    lineCounter: lines,
    prettyErrors: false,
    uniqueKeys: true,
    merge: true,
  });
  const lineAt = (offset: number | undefined) =>
    offset === undefined ? undefined : lines.linePos(offset).line;

  if (doc.errors.length) {
    return {
      state: "invalid",
      file,
      rel,
      enforce: enforceIntent(text),
      issues: doc.errors.map((e) => ({
        path: "",
        message: e.message.split("\n")[0] ?? e.message,
        line: lineAt(e.pos?.[0]),
      })),
    };
  }

  /** The line of the deepest node along `path` that exists in the document. */
  const lineOf = (path: Array<string | number | symbol>): number | undefined => {
    const keys = path.filter((k): k is string | number => typeof k !== "symbol");
    for (let n = keys.length; n >= 0; n--) {
      const node = n === 0 ? doc.contents : doc.getIn(keys.slice(0, n), true);
      if (Y.isNode(node) && node.range) return lineAt(node.range[0]);
    }
    return undefined;
  };

  let js: unknown;
  try {
    // maxAliasCount bounds alias expansion ("billion laughs").
    js = doc.toJS({ maxAliasCount: 200 });
  } catch (err) {
    return {
      state: "invalid",
      file,
      rel,
      enforce: enforceIntent(text),
      issues: [{ path: "", message: (err as Error).message.split("\n")[0] ?? "unreadable YAML" }],
    };
  }
  if (js === null || js === undefined || typeof js !== "object" || Array.isArray(js)) {
    return {
      state: "invalid",
      file,
      rel,
      enforce: enforceIntent(text),
      issues: [{ path: "", message: "expected a mapping with a `swarms:` key", line: 1 }],
    };
  }

  const top = js as Record<string, unknown>;
  const enforce = top.enforce === true && top.enabled !== false;
  const issues: ConfigIssue[] = [];
  const issue = (path: string[], message: string) =>
    issues.push({ path: path.join("."), message, line: lineOf(path) });
  // Names are checked on the raw document so a typo elsewhere never hides a bad name.
  const checkName = (path: string[], n: string, what: string) => {
    if (!NAME_RE.test(n) || n.length > NAME_MAX) issue(path, `${what} name "${n}": ${NAME_MSG}`);
  };
  const rawSwarms = (js as Record<string, unknown>).swarms;
  if (rawSwarms && typeof rawSwarms === "object" && !Array.isArray(rawSwarms))
    for (const [name, s] of Object.entries(rawSwarms)) {
      checkName(["swarms", name], name, "swarm");
      const agents = (s as Record<string, unknown> | null)?.agents;
      if (agents && typeof agents === "object" && !Array.isArray(agents))
        for (const role of Object.keys(agents))
          checkName(["swarms", name, "agents", role], role, "agent");
    }

  // A key this version does not know is ignored with a note, so a file written for a newer
  // eminiar still loads (and still enforces) here. A typo of a known key stays an error:
  // ignoring it would silently drop the setting the author meant.
  // A key the schema knows at another level (`disallowed_tools` under defaults) is misplaced,
  // not new: ignoring it would drop the setting, so it stays an error.
  const ignoredKeys: ConfigIssue[] = [];
  const allKeys = schemaKeys();
  for (const u of unknownKeys(js)) {
    const near = typoOf(u.key, u.known);
    const found = { path: u.at.join("."), line: lineOf([...u.at, u.key]) };
    if (allKeys.has(u.key))
      issues.push({ ...found, message: `unknown key "${u.key}": not allowed here` });
    else if (near)
      issues.push({ ...found, message: `unknown key "${u.key}" (did you mean "${near}"?)` });
    else if (
      u.at.length === 4 &&
      u.at[0] === "swarms" &&
      u.at[2] === "agents" &&
      restrictionLike(u.key, u.known) !== undefined
    ) {
      const like = restrictionLike(u.key, u.known);
      issues.push({
        ...found,
        message: `unknown key "${u.key}" looks like a restriction${like ? ` (did you mean "${like}"?)` : ""}: ignoring it would silently drop a limit`,
      });
    } else
      ignoredKeys.push({
        ...found,
        message: `unknown key "${u.key}" ignored: not a setting in this eminiar version`,
      });
  }

  const parsed = RawFile.safeParse(js);
  if (!parsed.success) {
    return {
      state: "invalid",
      file,
      rel,
      enforce,
      issues: [
        ...issues,
        ...parsed.error.issues.slice(0, 50).map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
          line: lineOf(i.path),
        })),
      ],
    };
  }

  const config = resolve(parsed.data, file, rel, issue);
  if (issues.length) return { state: "invalid", file, rel, enforce, issues };
  return { state: "ok", config: { ...config, ignoredKeys } };
}

function resolve(
  raw: RawFile,
  file: string,
  rel: string,
  issue: (path: string[], message: string) => void,
): Omit<SwarmConfig, "ignoredKeys"> {
  const swarms: SwarmSpec[] = [];
  const seenAgent = new Map<string, string>();
  const reported = new Set<string>();
  // Every role that inherits a broken defaults.model_range hits the same issue; list it once.
  const once = (path: string[], message: string) => {
    const key = `${path.join(".")}\n${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    issue(path, message);
  };
  const swarmEntries = Object.entries(raw.swarms);
  if (!swarmEntries.length) issue(["swarms"], "define at least one swarm");

  for (const [name, s] of swarmEntries) {
    const roleEntries = Object.entries(s.agents);
    if (!roleEntries.length) issue(["swarms", name, "agents"], "define at least one agent");
    const roles: RoleSpec[] = roleEntries.map(([role, a]) => {
      const agentType = agentTypeOf(name, role);
      if (agentType.length > AGENT_NAME_MAX)
        issue(
          ["swarms", name, "agents", role],
          `agent name "${agentType}" is longer than ${AGENT_NAME_MAX} characters; shorten the swarm or role name`,
        );
      const other = seenAgent.get(agentType);
      if (other)
        issue(
          ["swarms", name, "agents", role],
          `agent name "${agentType}" is also produced by ${other}; rename one of them`,
        );
      seenAgent.set(agentType, `swarms.${name}.agents.${role}`);
      if (a.tools_profile === "readonly")
        for (const t of a.tools ?? [])
          if (!READONLY_BUILTINS.includes(t))
            issue(
              ["swarms", name, "agents", role, "tools"],
              `tools_profile: readonly allows only ${READONLY_BUILTINS.join(", ")} (and the read-only em_* tools); "${t}" can write or run code. Remove it, or drop tools_profile`,
            );
      return {
        swarm: name,
        role,
        agentType,
        description: a.description,
        prompt: (a.prompt ?? "").trim(),
        model: a.model ?? raw.defaults?.model,
        range: roleRange(raw.defaults, a, ["swarms", name, "agents", role], once),
        tools: a.tools ? uniq(a.tools) : undefined,
        toolsProfile: a.tools_profile,
        disallowedTools: a.disallowed_tools ? uniq(a.disallowed_tools) : undefined,
        skills: uniq([...(raw.defaults?.skills ?? []), ...(a.skills ?? [])]),
        hooks: a.hooks,
        scope: uniq(a.scope ?? []),
        memoryTags: uniq(a.memory_tags ?? []),
        count: a.count ?? 1,
        isolation: a.isolation,
        maxTurns: a.max_turns,
        effort: a.effort,
        color: a.color,
        context: mergeContext(raw.defaults?.context, s.context, a.context),
      };
    });

    const roleNames = new Set(roles.map((r) => r.role));
    const topology = s.topology ?? "hierarchical";
    const stages = s.stages ?? [];
    stages.forEach((st, i) => {
      if (!roleNames.has(st))
        issue(["swarms", name, "stages", String(i)], `stage "${st}" is not an agent of this swarm`);
    });
    if (new Set(stages).size !== stages.length)
      issue(["swarms", name, "stages"], "a role may appear in stages only once");
    if (stages.length && topology !== "pipeline")
      issue(
        ["swarms", name, "stages"],
        `stages only apply to topology: pipeline (this swarm is ${topology}); remove them or change the topology`,
      );

    swarms.push({
      name,
      description: s.description,
      topology,
      maxAgents: s.max_agents ?? 4,
      // A pipeline with no explicit stages runs its roles in the order they are declared.
      stages: stages.length ? stages : topology === "pipeline" ? roles.map((r) => r.role) : [],
      instructions: (s.instructions ?? "").trim(),
      roles,
    });
  }

  return {
    file,
    rel,
    enabled: raw.enabled ?? true,
    sync: raw.sync ?? "auto",
    enforce: raw.enforce ?? false,
    allowedAgents: uniq(raw.allowed_agents ?? []),
    swarms,
    hash: createHash("sha1").update(JSON.stringify(swarms)).digest("hex"),
  };
}

// --- loading with a per-process cache ----------------------------------------------------

const MAX_FILE_CHARS = 256_000;
const cache = new Map<string, { text: string; result: LoadResult }>();

/**
 * Load the project's swarm file. The file is small, so it is read every time and only the
 * parse is cached (keyed by the text): an edit that keeps the size and mtime still counts.
 */
export function loadSwarmConfig(root: string): LoadResult {
  const { file, rel, exists } = swarmFile(root);
  if (!exists) return { state: "absent", file, rel };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
    const hit = cache.get(file);
    if (hit && hit.text === text) return hit.result;
  } catch (err) {
    return {
      state: "invalid",
      file,
      rel,
      issues: [{ path: "", message: `cannot read ${rel}: ${(err as Error).message}` }],
    };
  }
  const result = parseSwarmYaml(text, file, rel);
  if (cache.size > 32) cache.clear();
  cache.set(file, { text, result });
  return result;
}

/** The project's swarm config when swarms are opted in (file present, valid, enabled). */
export function activeSwarmConfig(root: string): SwarmConfig | undefined {
  const r = loadSwarmConfig(root);
  return r.state === "ok" && r.config.enabled ? r.config : undefined;
}

export function resetSwarmConfigCache(): void {
  cache.clear();
}

/** Role lookup by generated agent name (`swarm-<swarm>-<role>`). */
export function findRole(
  config: SwarmConfig,
  agentType: string | undefined,
): { swarm: SwarmSpec; role: RoleSpec } | undefined {
  if (!agentType) return undefined;
  // Claude Code may report a namespaced type (`plugin:name`); generated agents are project
  // agents, so only the bare name is ours.
  for (const swarm of config.swarms)
    for (const role of swarm.roles) if (role.agentType === agentType) return { swarm, role };
  return undefined;
}

export function findSwarm(config: SwarmConfig, name: string | undefined): SwarmSpec | undefined {
  return name ? config.swarms.find((s) => s.name === name) : undefined;
}

/** Cheap pre-filter for hooks: could this agent type be a generated swarm worker? */
export function isSwarmAgentType(agentType: unknown): agentType is string {
  return typeof agentType === "string" && agentType.startsWith("swarm-");
}

// --- starter file ----------------------------------------------------------------------

export const STARTER_YAML = `# eminiar agent swarms (opt-in). Docs: https://github.com/rydn/eminiar/blob/main/docs/swarms.md
# Each agent below becomes a Claude Code agent file .claude/agents/swarm-<swarm>-<agent>.md.
# The main Claude Code session coordinates; start a run with:  /eminiar:em-swarm feature <goal>
version: 1
enabled: true
sync: auto            # regenerate the agent files at session start when this file changes
# enforce: true        # only swarm workers may run as subagents, and only during a run of their swarm
# allowed_agents: []   # with enforce: other agent types still allowed, e.g. [statusline-setup]

defaults:
  model: sonnet
  context:            # what eminiar tells each worker when it starts
    memories: 4       # project memories matching the role and task
    docs: 2           # documentation pages matching the task
    history: true     # bug-prone files, recent fixes and history lessons in the work area
    insights: true    # hot files (fan-in × churn) in the work area
    structure: true   # the project brief: overview, decisions, constraints
    max_chars: 4000

swarms:
  feature:
    description: Plan, build, test and review a change to the codebase.
    topology: hierarchical   # hierarchical | mesh | pipeline
    max_agents: 4            # workers running at once across all runs of the swarm
    instructions: |
      Break the goal into tasks one worker can finish in one go, each naming the files it touches.
      Let the architect design first, fan the coding tasks out, then test, then review.
    agents:
      architect:
        description: Designs the change from the code graph, the history and past decisions.
        model: opus
        disallowed_tools: [Edit, Write, NotebookEdit]
        memory_tags: [decision, constraint]
        prompt: |
          Study the affected code with em_architecture, em_symbols and em_graph_impact before proposing anything.
          Check em_recall for decisions and constraints that apply.
          Post the design under the blackboard key "design": files to change, the approach, the risks.
      coder:
        description: Implements one task at a time with the smallest diff that works.
        count: 2                 # at most two coders at once
        prompt: |
          Read the "design" note first: em_swarm {action:"read", key:"design"}.
          Before editing a file run em_history {action:"file", path} and respect its fix record.
          Keep the change minimal and consistent with the surrounding code, and run the relevant tests.
      tester:
        description: Writes and runs tests that pin the new behaviour and its edge cases.
        prompt: |
          Cover the behaviour the task describes, including edge cases and failure paths.
          Run the tests and report exact failures. Never weaken a test to make it pass.
      reviewer:
        description: Adversarial reviewer that tries to break the change before it ships.
        model: opus
        disallowed_tools: [Edit, Write, NotebookEdit]
        memory_tags: [constraint, preference]
        prompt: |
          Review the diff for correctness bugs, missed edge cases, broken conventions and missing tests.
          Every finding needs a concrete failing input or scenario.
          Do not fix anything yourself: add each finding as a task for the coder role with
          em_swarm {action:"plan", tasks:[{title, detail, role:"coder"}]}.

  review:
    description: Review the working tree from several angles at once.
    topology: mesh
    max_agents: 3
    agents:
      correctness:
        description: Hunts for logic errors and unhandled edge cases.
        disallowed_tools: [Edit, Write, NotebookEdit]
        prompt: Find bugs, each with a concrete failing input. Post each under the key "finding-<n>".
      security:
        description: Looks for injection, path traversal, leaked secrets and unsafe defaults.
        disallowed_tools: [Edit, Write, NotebookEdit]
        prompt: Report only exploitable issues, each with the input that triggers it.
      tests:
        description: Checks that every changed behaviour has a test that would fail without it.
        disallowed_tools: [Edit, Write, NotebookEdit]
        prompt: List untested behaviour together with the test you would add.
`;
