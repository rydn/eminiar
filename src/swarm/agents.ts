import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { RoleSpec, SwarmConfig, SwarmSpec, Topology } from "./types.js";

/** First line of every generated body; sync only rewrites or deletes files carrying it. */
export const MARKER_PREFIX = "<!-- eminiar:swarm ";

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

/** MCP tool name prefixes: plugin install and `install --method settings`. */
export const EM_MCP_PREFIXES = ["mcp__plugin_eminiar_eminiar__", "mcp__eminiar__"] as const;

export const AGENTS_REL = ".claude/agents";

export function agentsDir(root: string): string {
  return join(root, ".claude", "agents");
}

export function agentRel(agentType: string): string {
  return `${AGENTS_REL}/${agentType}.md`;
}

export function isGenerated(content: string): boolean {
  return content.includes(MARKER_PREFIX);
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
  const out = [...tools];
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

/** The full agent file for one role. Deterministic, so sync can compare by content. */
export function renderAgentFile(config: SwarmConfig, swarm: SwarmSpec, role: RoleSpec): string {
  const fm = stringify(frontmatter(swarm, role), { lineWidth: 0 }).trimEnd();
  const stages =
    swarm.topology === "pipeline" && swarm.stages.length
      ? ` Stages: ${swarm.stages.join(" → ")}.`
      : "";
  const body = [
    `${MARKER_PREFIX}swarm=${swarm.name} role=${role.role} · generated from ${config.rel} by \`eminiar swarm sync\`; edit the YAML, not this file (it is overwritten). -->`,
    "",
    `You are the **${role.role}** worker of the eminiar swarm **${swarm.name}**: ${role.description}`,
    `Topology ${swarm.topology}: ${TOPOLOGY_RULE[swarm.topology]}${stages}`,
    "",
    ...(role.prompt ? [role.prompt, ""] : []),
    "## Swarm protocol",
    "",
    '1. eminiar starts you with a swarm brief: the run goal, your task, the shared notes and what the project knows (memories, history, structure). If your prompt names `task #N`, that task is already claimed for you; otherwise claim one with `em_swarm {action:"claim"}`.',
    '2. Ask eminiar before acting: `em_recall {query}` for decisions and constraints, `em_history {action:"file", path}` before editing a file, `em_graph_impact {node}` before changing a symbol, `em_symbols` / `em_search` instead of grepping.',
    '3. Share what other workers need with `em_swarm {action:"post", key, value}` and read theirs with `em_swarm {action:"read"}`.',
    '4. Close every task with `em_swarm {action:"update", task, status, result}`: status `done`, `failed` or `blocked`; the result says what changed and how you verified it.',
    "5. Record durable decisions with `em_remember` so later sessions know them.",
    "6. Your final message goes back to the coordinator: lead with the outcome, then the files you changed and anything left open.",
    "",
  ].join("\n");
  return `---\n${fm}\n---\n${body}`;
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

function readMaybe(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Generated agent files already on disk (by marker), keyed by agent name. */
function existingGenerated(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.startsWith("swarm-") || !n.endsWith(".md")) continue;
    const content = readMaybe(join(dir, n));
    if (content !== undefined && isGenerated(content)) out.set(n.slice(0, -3), content);
  }
  return out;
}

/** What a sync would do. `config` undefined or disabled means "remove every generated file". */
export function planAgentSync(
  root: string,
  config: SwarmConfig | undefined,
): Array<SyncAction & { content?: string }> {
  const dir = agentsDir(root);
  const generated = existingGenerated(dir);
  const actions: Array<SyncAction & { content?: string }> = [];
  const wanted = new Set<string>();
  if (config?.enabled) {
    for (const swarm of config.swarms)
      for (const role of swarm.roles) {
        wanted.add(role.agentType);
        const content = renderAgentFile(config, swarm, role);
        const path = agentRel(role.agentType);
        const current = generated.get(role.agentType);
        if (current !== undefined) {
          actions.push({
            agentType: role.agentType,
            path,
            action: current === content ? "unchanged" : "update",
            content,
          });
          continue;
        }
        const other = readMaybe(join(dir, `${role.agentType}.md`));
        if (other !== undefined) {
          actions.push({
            agentType: role.agentType,
            path,
            action: "conflict",
            reason: "a hand-written agent file with this name exists; rename the role or the file",
          });
          continue;
        }
        actions.push({ agentType: role.agentType, path, action: "create", content });
      }
  }
  for (const name of generated.keys())
    if (!wanted.has(name))
      actions.push({
        agentType: name,
        path: agentRel(name),
        action: "delete",
        reason: config?.enabled ? "no longer in the swarm file" : "swarms are disabled",
      });
  return actions;
}

/** Bring `.claude/agents/swarm-*.md` in line with the swarm file. */
export function syncAgents(
  root: string,
  config: SwarmConfig | undefined,
  opts: { dryRun?: boolean } = {},
): SyncResult {
  const dir = agentsDir(root);
  const planned = planAgentSync(root, config);
  let changed = 0;
  for (const a of planned) {
    if (opts.dryRun) {
      if (a.action === "create" || a.action === "update" || a.action === "delete") changed++;
      continue;
    }
    const file = join(dir, `${a.agentType}.md`);
    if ((a.action === "create" || a.action === "update") && a.content !== undefined) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, a.content);
      renameSync(tmp, file);
      changed++;
    } else if (a.action === "delete") {
      try {
        unlinkSync(file);
        changed++;
      } catch {
        // already gone
      }
    }
  }
  return {
    actions: planned.map(({ content: _c, ...a }) => a),
    changed,
    conflicts: planned.filter((a) => a.action === "conflict").length,
  };
}
