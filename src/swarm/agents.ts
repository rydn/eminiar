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
import type { RoleSpec, SwarmConfig, SwarmSpec, Topology } from "./types.js";

/**
 * Generated agent files are `---\n<frontmatter>\n---\n<marker line>\n<body>`. The marker is
 * the first line after the frontmatter and carries a hash of everything else, so sync can
 * tell its own untouched files from hand-written or hand-edited ones.
 */
export const MARKER_PREFIX = "<!-- eminiar:swarm ";
const HASH_RE = /\bhash=([0-9a-f]{12})\b/;

/** eminiar tools a worker always keeps, whatever its `tools` allowlist says. */
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

/** The role's tool allowlist with the eminiar tools added under both MCP name forms. */
export function workerTools(tools: string[]): string[] {
  // ToolSearch loads deferred MCP tools; without it an allowlisted worker may not reach em_*.
  const out = tools.includes("ToolSearch") ? [...tools] : [...tools, "ToolSearch"];
  for (const prefix of EM_MCP_PREFIXES)
    for (const t of WORKER_EM_TOOLS) if (!out.includes(prefix + t)) out.push(prefix + t);
  return out;
}

function frontmatter(swarm: SwarmSpec, role: RoleSpec): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    name: role.agentType,
    description: `Worker "${role.role}" of the eminiar swarm "${swarm.name}": ${role.description} Spawn it for a task of this swarm and name the task as "task #N" in the prompt; the em-swarm skill coordinates runs.`,
  };
  if (role.model) fm.model = role.model;
  if (role.tools) fm.tools = workerTools(role.tools).join(", ");
  if (role.disallowedTools?.length) fm.disallowedTools = role.disallowedTools.join(", ");
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

const hashOf = (fm: string, rest: string) =>
  createHash("sha1").update(`${fm}\n${rest}`).digest("hex").slice(0, 12);

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
    '1. eminiar starts you with a swarm brief: the run goal, the open tasks, the shared notes and what the project knows (memories, history, structure). First claim the task your prompt names with `em_swarm {action:"claim", task:N}` (or the next open one with `em_swarm {action:"claim"}`); if the brief says you already hold a task, continue it.',
    '2. Ask eminiar before acting: `em_recall {query}` for decisions and constraints, `em_history {action:"file", path}` before editing a file, `em_graph_impact {node}` before changing a symbol, `em_symbols` / `em_search` instead of grepping.',
    '3. Share what other workers need with `em_swarm {action:"post", key, value}` and read theirs with `em_swarm {action:"read"}`.',
    '4. Close every task with `em_swarm {action:"update", task, status, result}`: status `done`, `failed` or `blocked`; the result says what changed and how you verified it.',
    "5. Record durable decisions with `em_remember` so later sessions know them.",
    "6. Your final message goes back to the coordinator: lead with the outcome, then the files you changed and anything left open.",
    "",
  ].join("\n");
  const marker = `${MARKER_PREFIX}swarm=${swarm.name} role=${role.role} hash=${hashOf(fm, rest)} · generated from ${config.rel} by \`eminiar swarm sync\`; edit the YAML, not this file (it is overwritten). -->`;
  return `---\n${fm}\n---\n${marker}\n${rest}`;
}

/** How a file on disk relates to sync: ours untouched, ours but edited by hand, or not ours. */
export type GeneratedState = "generated" | "edited" | "foreign";

export function generatedState(raw: string): GeneratedState {
  // A checkout with autocrlf turns the file into CRLF; it is still ours and unedited.
  const content = raw.replace(/\r\n/g, "\n");
  if (!content.startsWith("---\n")) return "foreign";
  const end = content.indexOf("\n---\n", 3);
  if (end === -1) return "foreign";
  const fm = content.slice(4, end);
  const after = content.slice(end + 5);
  const nl = after.indexOf("\n");
  const marker = nl === -1 ? after : after.slice(0, nl);
  if (!marker.startsWith(MARKER_PREFIX)) return "foreign";
  const hash = HASH_RE.exec(marker)?.[1];
  if (!hash) return "foreign";
  return hashOf(fm, nl === -1 ? "" : after.slice(nl + 1)) === hash ? "generated" : "edited";
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
