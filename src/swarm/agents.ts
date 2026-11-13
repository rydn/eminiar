import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { TIERS } from "../adjudicator/types.js";
import type { ModelRange, RoleSpec, SwarmConfig, SwarmSpec, Topology } from "./types.js";

/**
 * Generated agent files are `---\n<frontmatter>\n---\n<marker line>\n<body>`. The marker is
 * the first line after the frontmatter and carries a hash of everything else, so sync can
 * tell its own untouched files from hand-written or hand-edited ones. A role with a model
 * range also carries `range=<floor>..<ceiling>` there (before `hash=`), and the hash covers it.
 */
export const MARKER_PREFIX = "<!-- eminiar:swarm ";
const HASH_RE = /\bhash=([0-9a-f]{12})\b/;
const RANGE_RE = /\srange=([a-z]+)\.\.([a-z]+)(?=\s)/;

/** A model range as the marker writes it: `floor..ceiling`. */
export function modelRangeText(r: ModelRange): string {
  return `${r.floor}..${r.ceiling}`;
}

/**
 * eminiar tools a worker keeps whatever its `tools` allowlist says, except the command runners
 * (EXEC_TOOLS): those only when the role keeps Bash.
 */
export const WORKER_EM_TOOLS = [
  "em_swarm",
  "em_recall",
  "em_memory",
  "em_remember",
  "em_search",
  "em_symbols",
  "em_history",
  "em_graph_impact",
  "em_graph_query",
  "em_architecture",
  "em_execute",
  "em_execute_file",
  "em_batch_execute",
  "em_docs",
  "em_fetch_and_index",
] as const;

/**
 * `yaml` is loaded on first use: hooks import this module in every project, and only
 * projects with a swarm file ever render an agent file.
 */
let yamlLib: typeof import("yaml") | undefined;
function yaml(): typeof import("yaml") {
  yamlLib ??= createRequire(import.meta.url)("yaml") as typeof import("yaml");
  return yamlLib;
}

/**
 * eminiar's command runners. Each runs arbitrary code, so a role without Bash (a `tools` list
 * that leaves it out, or Bash in `disallowed_tools`) must not get them back this way.
 */
export const EXEC_TOOLS: ReadonlySet<string> = new Set([
  "em_execute",
  "em_execute_file",
  "em_batch_execute",
]);

/** Does the role keep Bash? An unset `tools` means every tool; `disallowed_tools` wins. */
export function roleHasShell(role: Pick<RoleSpec, "tools" | "disallowedTools">): boolean {
  return (role.tools?.includes("Bash") ?? true) && !role.disallowedTools?.includes("Bash");
}

/** MCP tool name prefixes: plugin install and `install --method settings`. */
export const EM_MCP_PREFIXES = ["mcp__plugin_eminiar_eminiar__", "mcp__eminiar__"] as const;

export const AGENTS_REL = ".claude/agents";

export function agentsDir(root: string): string {
  return join(root, ".claude", "agents");
}

export function agentRel(agentType: string): string {
  return `${AGENTS_REL}/${agentType}.md`;
}

const TOPOLOGY_RULE: Record<Topology, string> = {
  hierarchical:
    "the coordinator (the main Claude Code session) plans and assigns the work. Take tasks for your role, report back, and leave planning to the coordinator unless you find work that is missing.",
  mesh: "peers share one task board. Claim any open task (your role's first), and read the blackboard for what the other workers found.",
  pipeline:
    "work moves in stages. You can claim a task only once every task of the earlier stages is done.",
};

/**
 * The role's tool allowlist with the eminiar tools added under both MCP name forms; the
 * command runners only when `shell` (the role keeps Bash).
 */
export function workerTools(tools: string[], shell = tools.includes("Bash")): string[] {
  // ToolSearch loads deferred MCP tools; without it an allowlisted worker may not reach em_*.
  const out = tools.includes("ToolSearch") ? [...tools] : [...tools, "ToolSearch"];
  for (const prefix of EM_MCP_PREFIXES)
    for (const t of WORKER_EM_TOOLS)
      if ((shell || !EXEC_TOOLS.has(t)) && !out.includes(prefix + t)) out.push(prefix + t);
  return out;
}

/** The command runners under both MCP name forms, for a role that disallows Bash. */
const execToolNames = (): string[] =>
  EM_MCP_PREFIXES.flatMap((prefix) => [...EXEC_TOOLS].map((t) => prefix + t));

/**
 * The tool grant of a generated agent file: `allow` is the `tools` line (unset: the worker
 * inherits every tool), `deny` the `disallowedTools` line. frontmatter() renders exactly this,
 * and the security adjudication reads it, so both always see the same grant.
 */
export function roleToolGrant(role: Pick<RoleSpec, "tools" | "disallowedTools">): {
  allow?: string[];
  deny: string[];
} {
  // Workers are leaves: Claude Code lets subagents spawn subagents unless Agent is disallowed.
  // A role that lists Agent or Task in its own `tools` opted out of that.
  const spawns = role.tools?.some((t) => t === "Agent" || t === "Task");
  // Without a `tools` list the worker inherits every MCP tool, so disallowing Bash has to
  // disallow the command runners too.
  const noShell = role.disallowedTools?.includes("Bash") ? execToolNames() : [];
  const deny = [
    ...new Set([...(role.disallowedTools ?? []), ...(spawns ? [] : ["Agent"]), ...noShell]),
  ];
  return role.tools ? { allow: workerTools(role.tools, roleHasShell(role)), deny } : { deny };
}

function frontmatter(swarm: SwarmSpec, role: RoleSpec): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    name: role.agentType,
    description: `Worker "${role.role}" of the eminiar swarm "${swarm.name}": ${role.description} Spawn it for a task of this swarm and name the task as "task #N" in the prompt; the em-swarm skill coordinates runs.`,
  };
  if (role.model) fm.model = role.model;
  const grant = roleToolGrant(role);
  if (grant.allow) fm.tools = grant.allow.join(", ");
  if (grant.deny.length) fm.disallowedTools = grant.deny.join(", ");
  if (role.skills.length) fm.skills = role.skills;
  if (role.hooks) {
    const hooks = Object.fromEntries(
      Object.entries(role.hooks).filter(([, v]) => Array.isArray(v) && v.length),
    );
    if (Object.keys(hooks).length) fm.hooks = hooks;
  }
  if (role.isolation) fm.isolation = role.isolation;
  if (role.maxTurns) fm.maxTurns = role.maxTurns;
  if (role.effort) fm.effort = role.effort;
  if (role.color) fm.color = role.color;
  return fm;
}

/**
 * A ranged role hashes its range in front of the frontmatter (which starts with `name:`, so
 * the two inputs never coincide). An unranged role hashes what it always did, so its file
 * stays byte for byte the same.
 */
const hashOf = (fm: string, rest: string, range?: string) =>
  createHash("sha1")
    .update(range ? `range=${range}\n${fm}\n${rest}` : `${fm}\n${rest}`)
    .digest("hex")
    .slice(0, 12);

/**
 * A worker without `isolation: worktree` shares the session's working tree with the other
 * workers' uncommitted edits. Workers have stashed and popped files there while coders were
 * active, and nothing was lost only by luck of timing, so the protocol says it once for every
 * worker that has a shell, rather than each spawn prompt.
 */
const SHARED_TREE_RULE =
  "Other workers may be editing this working tree at the same time, and their changes are not committed. Never run `git stash`, `git checkout`, `git switch`, `git reset`, `git restore` or `git clean`, not even on one path: they hide or wipe another worker's work. If you commit, add only the files you changed: `git add -A` or `git commit -a` takes their unfinished work with yours. To test without your change (a mutation check), copy the files into a scratch directory outside the tree and run the tests there.";

/** The full agent file for one role. Deterministic, so sync can compare by content. */
export function renderAgentFile(config: SwarmConfig, swarm: SwarmSpec, role: RoleSpec): string {
  const fm = yaml().stringify(frontmatter(swarm, role), { lineWidth: 0 }).trimEnd();
  // Validation rejects "---" in every frontmatter value; this guards against a gap there,
  // because Claude Code would cut the frontmatter at the first "---" and drop the agent.
  if (fm.includes("---"))
    throw new Error(`agent ${role.agentType}: frontmatter would contain "---"; fix ${config.rel}`);
  const stages =
    swarm.topology === "pipeline" && swarm.stages.length
      ? ` Stages: ${swarm.stages.join(" → ")}.`
      : "";
  const rest = [
    "",
    `You are the **${role.role}** worker of the eminiar swarm **${swarm.name}**: ${role.description}`,
    `Topology ${swarm.topology}: ${TOPOLOGY_RULE[swarm.topology]}${stages}`,
    "",
    ...(role.prompt ? [role.prompt, ""] : []),
    "## Swarm protocol",
    "",
    ...[
      'eminiar starts you with a swarm brief: the run goal, the open tasks, the shared notes and what the project knows (memories, history, structure). First claim the task your prompt names with `em_swarm {action:"claim", task:N}` (or the next open one with `em_swarm {action:"claim"}`); if the brief says you already hold a task, continue it.',
      'Ask eminiar before acting: `em_recall {query}` for decisions and constraints, `em_history {action:"file", path}` before editing a file, `em_graph_impact {node}` before changing a symbol, `em_symbols` / `em_search` instead of grepping.',
      ...(!role.isolation && roleHasShell(role) ? [SHARED_TREE_RULE] : []),
      'Share what other workers need with `em_swarm {action:"post", key, value}` and read theirs with `em_swarm {action:"read"}`.',
      'Close every task with `em_swarm {action:"update", task, status, result}`: status `done`, `failed` or `blocked`; the result says what changed and how you verified it.',
      "Record durable decisions with `em_remember` so later sessions know them.",
      "Your final message goes back to the coordinator: lead with the outcome, then the files you changed and anything left open.",
    ].map((step, i) => `${i + 1}. ${step}`),
    "",
  ].join("\n");
  const range = role.range ? modelRangeText(role.range) : undefined;
  const marker = `${MARKER_PREFIX}swarm=${swarm.name} role=${role.role}${range ? ` range=${range}` : ""} hash=${hashOf(fm, rest, range)} · generated from ${config.rel} by \`eminiar swarm sync\`; edit the YAML, not this file (it is overwritten). -->`;
  return `---\n${fm}\n---\n${marker}\n${rest}`;
}

/** How a file on disk relates to sync: ours untouched, ours but edited by hand, or not ours. */
export type GeneratedState = "generated" | "edited" | "foreign";

/** The marker's range, when it names two tiers, floor first. */
function markerRange(marker: string): ModelRange | undefined {
  const m = RANGE_RE.exec(marker);
  const floor = TIERS.find((t) => t === m?.[1]);
  const ceiling = TIERS.find((t) => t === m?.[2]);
  return floor && ceiling && TIERS.indexOf(floor) <= TIERS.indexOf(ceiling)
    ? { floor, ceiling }
    : undefined;
}

function readGenerated(raw: string): { state: GeneratedState; range?: ModelRange | undefined } {
  // A checkout with autocrlf turns the file into CRLF; it is still ours and unedited.
  const content = raw.replace(/\r\n/g, "\n");
  if (!content.startsWith("---\n")) return { state: "foreign" };
  const end = content.indexOf("\n---\n", 3);
  if (end === -1) return { state: "foreign" };
  const fm = content.slice(4, end);
  const after = content.slice(end + 5);
  const nl = after.indexOf("\n");
  const marker = nl === -1 ? after : after.slice(0, nl);
  if (!marker.startsWith(MARKER_PREFIX)) return { state: "foreign" };
  const hash = HASH_RE.exec(marker)?.[1];
  if (!hash) return { state: "foreign" };
  const range = markerRange(marker);
  const body = nl === -1 ? "" : after.slice(nl + 1);
  const same = hashOf(fm, body, range && modelRangeText(range)) === hash;
  return { state: same ? "generated" : "edited", range };
}

export function generatedState(raw: string): GeneratedState {
  return readGenerated(raw).state;
}

/**
 * The model range of an agent file, from its marker's `range=`, for readers that see only the
 * file (the adjudicator's pin lookup). Undefined unless sync wrote the file and nobody edited
 * it since: a hand edit breaks the hash, so the range may not be the swarm file's any more and
 * only the frontmatter `model` pin counts.
 */
export function agentFileRange(raw: string): ModelRange | undefined {
  const g = readGenerated(raw);
  return g.state === "generated" ? g.range : undefined;
}

/** True for any file sync generated (edited or not). */
export function isGenerated(content: string): boolean {
  return generatedState(content) !== "foreign";
}

// --- sync ---------------------------------------------------------------------------------

export type SyncActionKind = "create" | "update" | "unchanged" | "delete" | "conflict";

export interface SyncAction {
  agentType: string;
  /** Project-relative path of the agent file. */
  path: string;
  action: SyncActionKind;
  reason?: string | undefined;
  /** An update held back because the role's part of the swarm file has keys this version does not know. */
  held?: true | undefined;
}

export interface SyncResult {
  actions: SyncAction[];
  /** Files created, updated or deleted. */
  changed: number;
  conflicts: number;
}

type Entry =
  | { kind: "missing" }
  | { kind: "file"; content: string; state: GeneratedState }
  | { kind: "other"; why: string };

function inspect(file: string): Entry {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "other", why: `cannot inspect it: ${(err as Error).message}` };
  }
  if (st.isSymbolicLink()) return { kind: "other", why: "it is a symbolic link" };
  if (!st.isFile()) return { kind: "other", why: "it is not a regular file" };
  try {
    const content = readFileSync(file, "utf8");
    return { kind: "file", content, state: generatedState(content) };
  } catch (err) {
    return { kind: "other", why: `cannot read it: ${(err as Error).message}` };
  }
}

/**
 * Why the agents directory must not be written, or undefined when it is safe. The nearest
 * existing ancestor is resolved, so a symlinked `.claude` without an `agents/` folder yet
 * is caught before mkdir would create the folder outside the project.
 */
function unsafeDir(root: string, dir: string): string | undefined {
  let probe = dir;
  for (let i = 0; i < 4; i++) {
    try {
      const real = realpathSync(probe);
      const rel = relative(realpathSync(root), real);
      if (rel.startsWith("..") || /^[A-Za-z]:/.test(rel) || (rel === "" && probe !== root))
        return `${AGENTS_REL} resolves outside the project (${real}); swarm sync only writes inside the project`;
      return undefined;
    } catch {
      // missing: check its parent
      const parent = join(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
  }
  return undefined;
}

/** Generated agent files already on disk, keyed by agent name. */
function existingGenerated(dir: string): Map<string, Entry & { kind: "file" }> {
  const out = new Map<string, Entry & { kind: "file" }>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.startsWith("swarm-") || !n.endsWith(".md")) continue;
    const e = inspect(join(dir, n));
    if (e.kind === "file" && e.state !== "foreign") out.set(n.slice(0, -3), e);
  }
  return out;
}

/** The ignored keys that bear on one agent file: the role's own, its swarm's, defaults and top level. */
function ignoredWhere(
  ignored: readonly { path: string; message: string }[],
  config: SwarmConfig,
  agentType: string,
): string[] {
  const hit = config.swarms.flatMap((swarm) =>
    swarm.roles.filter((r) => r.agentType === agentType).map((r) => ({ swarm, role: r })),
  )[0];
  if (!hit) return [];
  const out: string[] = [];
  for (const i of ignored) {
    const seg = i.path === "" ? [] : i.path.split(".");
    const name = /"(.+?)"/.exec(i.message)?.[1] ?? "?";
    const mine =
      seg[0] !== "swarms" ||
      seg.length < 2 ||
      (seg[1] === hit.swarm.name &&
        (seg.length < 4 || seg[2] !== "agents" || seg[3] === hit.role.role));
    if (mine) out.push(name);
  }
  return out;
}

const list = (v: unknown): string[] =>
  typeof v === "string"
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

function frontmatterOf(raw: string): Record<string, unknown> | undefined {
  const content = raw.replace(/\r\n/g, "\n");
  const end = content.indexOf("\n---\n", 3);
  if (!content.startsWith("---\n") || end === -1) return undefined;
  try {
    const v = yaml().parse(content.slice(4, end)) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Keys that carry no restriction: dropping or changing them never widens an agent. */
const NEUTRAL_KEYS = new Set(["name", "description", "skills", "color", "model", "effort"]);

/**
 * Whether the new agent file is strictly more restrictive than the old and widens nothing:
 * a subset of the old tools, a superset of the old disallowed tools and hooks, no more turns,
 * and no old key (one this version may not know) dropped. Unparseable files never tighten.
 */
export function tightens(oldRaw: string, newRaw: string): boolean {
  const o = frontmatterOf(oldRaw);
  const n = frontmatterOf(newRaw);
  if (!o || !n) return false;
  let tighter = false;
  for (const k of Object.keys(o)) {
    if (NEUTRAL_KEYS.has(k)) continue;
    if (!(k in n)) return false;
    const a = o[k];
    const b = n[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (k === "tools") {
      const ob = new Set(list(a));
      const nb = list(b);
      if (!nb.every((t) => ob.has(t))) return false;
      tighter = true;
    } else if (k === "disallowedTools") {
      const nb = new Set(list(b));
      if (!list(a).every((t) => nb.has(t))) return false;
      tighter = true;
    } else if (k === "hooks") {
      const oh = (a ?? {}) as Record<string, unknown>;
      const nh = (b ?? {}) as Record<string, unknown>;
      for (const [ev, entries] of Object.entries(oh)) {
        const have = new Set(((nh[ev] as unknown[]) ?? []).map((e) => JSON.stringify(e)));
        if (!Array.isArray(entries) || !entries.every((e) => have.has(JSON.stringify(e))))
          return false;
      }
      tighter = true;
    } else if (k === "maxTurns") {
      if (typeof a !== "number" || typeof b !== "number" || b > a) return false;
      tighter = true;
    } else return false;
  }
  // Settings only the new file has (a first tools allowlist, a turn cap, more hooks) restrict.
  for (const k of Object.keys(n)) if (!(k in o) && !NEUTRAL_KEYS.has(k)) tighter = true;
  return tighter;
}

/**
 * What a sync would do. `config` undefined or disabled means "remove every generated file".
 * `force` lets sync overwrite or delete generated files that were edited by hand.
 */
export function planAgentSync(
  root: string,
  config: SwarmConfig | undefined,
  opts: { force?: boolean | undefined } = {},
): Array<SyncAction & { content?: string }> {
  const dir = agentsDir(root);
  const wantedRoles = config?.enabled
    ? config.swarms.flatMap((swarm) => swarm.roles.map((role) => ({ swarm, role })))
    : [];
  const unsafe = unsafeDir(root, dir);
  if (unsafe)
    return wantedRoles.map(({ role }) => ({
      agentType: role.agentType,
      path: agentRel(role.agentType),
      action: "conflict" as const,
      reason: unsafe,
    }));
  const generated = existingGenerated(dir);
  const actions: Array<SyncAction & { content?: string }> = [];
  const wanted = new Set<string>();
  const editedReason =
    "the generated file was edited by hand; move the edits into the swarm file, then sync with --force";
  for (const { swarm, role } of wantedRoles) {
    wanted.add(role.agentType);
    const path = agentRel(role.agentType);
    let content: string;
    try {
      content = renderAgentFile(config!, swarm, role);
    } catch (err) {
      actions.push({
        agentType: role.agentType,
        path,
        action: "conflict",
        reason: (err as Error).message,
      });
      continue;
    }
    const e = inspect(join(dir, `${role.agentType}.md`));
    if (e.kind === "missing")
      actions.push({ agentType: role.agentType, path, action: "create", content });
    else if (e.kind === "other")
      actions.push({
        agentType: role.agentType,
        path,
        action: "conflict",
        reason: `left alone: ${e.why}`,
      });
    else if (e.state === "foreign")
      actions.push({
        agentType: role.agentType,
        path,
        action: "conflict",
        reason: "a hand-written agent file with this name exists; rename the role or the file",
      });
    else if (e.state === "edited" && !opts.force)
      actions.push({ agentType: role.agentType, path, action: "conflict", reason: editedReason });
    else
      actions.push({
        agentType: role.agentType,
        path,
        action: e.content === content ? "unchanged" : "update",
        content,
      });
  }
  for (const [name, e] of generated)
    if (!wanted.has(name))
      actions.push(
        e.state === "edited" && !opts.force
          ? { agentType: name, path: agentRel(name), action: "conflict", reason: editedReason }
          : {
              agentType: name,
              path: agentRel(name),
              action: "delete",
              reason: config?.enabled ? "no longer in the swarm file" : "swarms are disabled",
            },
      );
  // A role whose settings (or its swarm's, or the defaults') carry keys this version does not
  // know may have been generated by a newer eminiar, whose agent file carries those settings (a
  // hook, a limit): rewriting it here would drop them, so that role's update is held as a
  // conflict, with the reason in the sync output. Never held: a create (nothing to drop), a
  // delete (removing an agent only restricts), an update that strictly tightens the file
  // (fewer tools, more disallowed tools, more hooks, fewer turns) and anything for a role
  // without such keys. --force writes everything.
  const ignored = config?.ignoredKeys ?? [];
  if (ignored.length && !opts.force) {
    const holds = (agentType: string): string[] => ignoredWhere(ignored, config!, agentType);
    return actions.map((a) => {
      if (a.action !== "update") return a;
      const where = holds(a.agentType);
      if (!where.length) return a;
      const old = generated.get(a.agentType);
      if (old && tightens(old.content, a.content ?? "")) return a;
      return {
        agentType: a.agentType,
        path: a.path,
        action: "conflict" as const,
        held: true as const,
        reason: `kept: ${config!.rel} has keys this eminiar version does not know (${where.slice(0, 3).join(", ")}${where.length > 3 ? ", ..." : ""}), and a newer one may have generated this file with them; update eminiar, or sync with --force`,
      };
    });
  }
  return actions;
}

/** Bring `.claude/agents/swarm-*.md` in line with the swarm file. Never throws per file. */
export function syncAgents(
  root: string,
  config: SwarmConfig | undefined,
  opts: { dryRun?: boolean; force?: boolean | undefined } = {},
): SyncResult {
  const dir = agentsDir(root);
  const planned = planAgentSync(root, config, opts);
  const actions: SyncAction[] = [];
  let changed = 0;
  for (const { content, ...a } of planned) {
    const writes = a.action === "create" || a.action === "update" || a.action === "delete";
    if (opts.dryRun || !writes) {
      if (writes) changed++;
      actions.push(a);
      continue;
    }
    const file = join(dir, `${a.agentType}.md`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      if (a.action === "delete") unlinkSync(file);
      else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, content ?? "");
        // create: link fails if something appeared meanwhile, so nothing is ever replaced;
        // update: the file is ours (checked in the plan), so an atomic rename is right.
        if (a.action === "create") linkSync(tmp, file);
        else renameSync(tmp, file);
      }
      changed++;
      actions.push(a);
    } catch (err) {
      actions.push({
        ...a,
        action: "conflict",
        reason: `could not ${a.action}: ${(err as Error).message}`,
      });
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // renamed, or never written
      }
    }
  }
  return { actions, changed, conflicts: actions.filter((a) => a.action === "conflict").length };
}
