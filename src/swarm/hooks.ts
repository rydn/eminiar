import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getContext, type ProjectContext } from "../context.js";
import { hookLog } from "../hooks/log.js";
import type { HookHandler, HookInput, HookOutput } from "../hooks/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { syncAgents } from "./agents.js";
import { workerBrief } from "./brief.js";
import { activeSwarmConfig, findRole, isSwarmAgentType, loadSwarmConfig } from "./config.js";
import { STAMP_FIELDS, signCaller } from "./identity.js";
import {
  clip,
  closeSessionWorkers,
  closeWorker,
  recordActivity,
  registerWorker,
  releaseSpawn,
  reserveSpawn,
  touchWorker,
} from "./runtime.js";
import type { SwarmConfig, TaskStatus } from "./types.js";

/**
 * The swarm side of the Claude Code hooks (spec: docs/design/agent-swarms.md, "Hooks").
 * Opt-in and cheap: every entry point returns before any I/O unless the agent type looks
 * like a generated swarm worker (or the tool is em_swarm), and then does nothing unless the
 * project has an enabled `.eminiar/swarm.yaml`. Nothing here throws: a swarm problem is
 * logged to ~/.eminiar/hook.log and Claude carries on.
 */

/** em_swarm under its two MCP names (plugin install, settings install) and no other server's. */
const EM_SWARM_TOOLS = new Set(["mcp__plugin_eminiar_eminiar__em_swarm", "mcp__eminiar__em_swarm"]);

export function isSwarmTool(name: string | undefined): boolean {
  return !!name && EM_SWARM_TOOLS.has(name);
}

/** Fields the PreToolUse hook owns on em_swarm calls; a model can never set them itself. */
export const CALLER_FIELDS = STAMP_FIELDS;

/** Claude Code caps hook additionalContext at 10,000 characters (longer goes to a file). */
const CONTEXT_MAX = 9500;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function fail(where: string, err: unknown): undefined {
  hookLog("error", `swarm ${where}: ${(err as Error)?.stack ?? String(err)}`);
  return undefined;
}

// --- worktrees ----------------------------------------------------------------------------

/**
 * The checkout that owns the swarm ledger. A worker with `isolation: worktree` runs in a git
 * worktree of the project (`<main>/.claude/worktrees/x` or anywhere else); its `.git` is a
 * file `gitdir: <main>/.git/worktrees/<name>`. The ledger lives in the main checkout's
 * database, so every swarm path maps such a root back to `<main>`. Anything else (a normal
 * checkout, a submodule, a bare repo, an unreadable file) is its own coordination root.
 */
export function coordinationRoot(root: string): string {
  try {
    const dotGit = join(root, ".git");
    if (!statSync(dotGit).isFile()) return root;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return root;
    const gitdir = resolve(root, m[1]!);
    // A linked worktree's gitdir has a `commondir` file naming the repository's git dir.
    let common: string;
    try {
      common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    } catch {
      return root; // a submodule checkout (its gitdir has no commondir): its own project
    }
    // The usual layout: <main>/.git is the common dir, so <main> is the main checkout.
    if (basename(common) === ".git") return realpathSync(dirname(common));
    // Otherwise (a worktree of a submodule, of a bare repository, of a repository with a
    // separate git dir) ask git for the main worktree, its first entry. Only a real checkout
    // is usable: the ledger shares the project database with the memories and the graph,
    // and for bare or separate-git-dir repositories git names the git dir instead, so such
    // a worktree keeps its own ledger (a documented limitation).
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = /^worktree (.+)$/m.exec(out)?.[1];
    if (!first || /^bare$/m.test(out.split("\n\n")[0] ?? "")) return root;
    const main = realpathSync(first);
    return main !== realpathSync(common) && statSync(join(main, ".git"), { throwIfNoEntry: false })
      ? main
      : root;
  } catch {
    return root;
  }
}

interface SwarmScope {
  /** Context of the coordination root: the ledger, memories and briefs come from here. */
  ctx: ProjectContext;
  db: StorageAdapter;
  config: SwarmConfig;
  /** The hook's own project root (a worktree for isolated workers), for display paths. */
  root: string;
}

/**
 * The nearest enabled swarm file that knows `agentType` (any, when not given): the hook's own
 * checkout first, then the coordination root. An isolated worker's worktree is made from
 * HEAD, so an uncommitted swarm.yaml exists only in the main checkout.
 */
function configFor(local: string, main: string, agentType?: string): SwarmConfig | undefined {
  for (const r of local === main ? [local] : [local, main]) {
    const c = activeSwarmConfig(r);
    if (c && (agentType === undefined || findRole(c, agentType))) return c;
  }
  return undefined;
}

function swarmScope(ctx: ProjectContext, agentType?: string): SwarmScope | undefined {
  const main = coordinationRoot(ctx.root);
  const config = configFor(ctx.root, main, agentType);
  if (!config) return undefined;
  const mctx = main === ctx.root ? ctx : getContext(main);
  return { ctx: mctx, db: getStorage(mctx, { vectors: false }), config, root: ctx.root };
}

// --- PreToolUse ---------------------------------------------------------------------------

export type SwarmSpawnCheck =
  /** Over capacity: answer the PreToolUse call with this denial. */
  | { kind: "deny"; output: HookOutput }
  /** A configured swarm worker; its brief comes from SubagentStart, not the prompt. */
  | { kind: "worker"; agentType: string; runId?: string | undefined; taskId?: number | undefined };

/**
 * PreToolUse on Agent / Task for a swarm worker: check capacity and reserve the slot.
 * Undefined for every other agent type, and when swarms are not opted in.
 */
export function swarmPreAgent(ctx: ProjectContext, input: HookInput): SwarmSpawnCheck | undefined {
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return undefined;
  const ti = input.tool_input ?? {};
  const agentType = ti.subagent_type;
  if (!isSwarmAgentType(agentType)) return undefined;
  let scope: SwarmScope | undefined;
  try {
    scope = swarmScope(ctx, agentType);
  } catch (err) {
    return fail("preAgent", err);
  }
  if (!scope) return undefined;
  try {
    const d = reserveSpawn(scope.db, scope.config, {
      agentType,
      prompt: str(ti.prompt),
      description: str(ti.description),
      sessionId: input.session_id || undefined,
      toolUseId: input.tool_use_id || undefined,
    });
    if (!d) return { kind: "worker", agentType };
    if (d.decision === "deny") {
      hookLog("info", `swarm deny ${agentType}: ${d.reason}`);
      return {
        kind: "deny",
        output: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `eminiar swarm: ${d.reason}`,
          },
        },
      };
    }
    return { kind: "worker", agentType, runId: d.run?.id, taskId: d.taskId };
  } catch (err) {
    fail("reserveSpawn", err);
    // A busy database is transient: refuse the spawn with a retry hint rather than let it
    // past the capacity check the project opted into. Any other failure lets it through
    // unrecorded (SubagentStart still registers the worker) so a broken ledger never
    // blocks Claude.
    if (isBusy(err))
      return {
        kind: "deny",
        output: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "eminiar swarm: the swarm ledger is busy, so capacity could not be checked; retry the spawn in a moment.",
          },
        },
      };
    return { kind: "worker", agentType };
  }
}

function isBusy(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return (
    e?.code === "SQLITE_BUSY" ||
    e?.code === "SQLITE_LOCKED" ||
    /database is (locked|busy)/i.test(String(e?.message ?? ""))
  );
}

/**
 * PreToolUse inside a swarm worker: refresh its liveness, so a worker in a long tool call
 * keeps its capacity slot and its task. Cheap; never throws.
 */
export function swarmTouch(ctx: ProjectContext, input: HookInput): void {
  if (!input.agent_id || !isSwarmAgentType(input.agent_type)) return;
  try {
    const s = swarmScope(ctx, input.agent_type);
    if (s) touchWorker(s.db, input.agent_id);
  } catch (err) {
    fail("touch", err);
  }
}

function allowWith(updatedInput: Record<string, unknown>): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput },
  };
}

/**
 * PreToolUse on em_swarm: tell the tool who is calling. The hook knows the caller (main
 * session, or a subagent's `agent_id` / `agent_type`) and the session; it drops any stamp
 * fields the model passed and adds its own, signed (src/swarm/identity.ts), so the server
 * can trust them. `updatedInput` replaces the whole input, so the original is spread first.
 */
export function swarmStampCaller(input: HookInput): HookOutput | undefined {
  try {
    if (!isSwarmTool(input.tool_name) || !input.tool_input) return undefined;
    const rest: Record<string, unknown> = { ...input.tool_input };
    for (const f of STAMP_FIELDS) delete rest[f];
    const stamp = input.agent_id
      ? signCaller({
          kind: "agent",
          agentId: input.agent_id,
          agentType: input.agent_type || undefined,
          sessionId: input.session_id || undefined,
        })
      : signCaller({ kind: "main", sessionId: input.session_id || undefined });
    return allowWith({ ...rest, ...stamp });
  } catch (err) {
    return fail("stampCaller", err);
  }
}

/**
 * PostToolUse / PostToolUseFailure of an Agent call for a swarm worker: its reservation is
 * done (the worker started and counts as running, or it never will).
 */
export function swarmAgentReturned(ctx: ProjectContext, input: HookInput): void {
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return;
  const agentType = input.tool_input?.subagent_type;
  if (!isSwarmAgentType(agentType) || !input.tool_use_id) return;
  try {
    const s = swarmScope(ctx, agentType);
    if (s) releaseSpawn(s.db, input.tool_use_id);
  } catch (err) {
    fail("agentReturned", err);
  }
}

/** SessionEnd: close the session's workers that never sent SubagentStop. */
export function swarmSessionEnd(ctx: ProjectContext, input: HookInput): void {
  if (!input.session_id) return;
  try {
    const s = swarmScope(ctx);
    if (s) closeSessionWorkers(s.db, input.session_id);
  } catch (err) {
    fail("sessionEnd", err);
  }
}

// --- SubagentStart ------------------------------------------------------------------------

/** Block the hook process briefly (it is short-lived and has nothing else to do). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** SubagentStart for a swarm worker: register it and inject its brief. */
export async function swarmSubagentStart(
  ctx: ProjectContext,
  input: HookInput,
): Promise<HookOutput | undefined> {
  const agentType = input.agent_type;
  if (!isSwarmAgentType(agentType) || !input.agent_id) return undefined;
  let s: SwarmScope | undefined;
  try {
    s = swarmScope(ctx, agentType);
  } catch (err) {
    return fail("subagentStart", err);
  }
  if (!s) return undefined;
  const scope = s;
  const role = findRole(scope.config, agentType);
  if (!role) return undefined;
  // The ledger may be busy for a moment (another hook's transaction): retry within the
  // hook's 10 s budget rather than start the worker without a brief.
  let started: ReturnType<typeof registerWorker>;
  for (let attempt = 0; ; attempt++) {
    try {
      started = registerWorker(scope.db, scope.config, {
        agentId: input.agent_id,
        agentType,
        sessionId: input.session_id || undefined,
      });
      break;
    } catch (err) {
      if (!isBusy(err) || attempt >= 2) {
        fail("registerWorker", err);
        started = undefined;
        break;
      }
      pause(400);
    }
  }
  let brief: string;
  try {
    brief = started
      ? await workerBrief(scope.ctx, scope.db, started)
      : fallbackBrief(role.role.role, role.swarm.name);
  } catch (err) {
    fail("workerBrief", err);
    brief = fallbackBrief(role.role.role, role.swarm.name, started?.run.id);
  }
  const lines = [
    `## eminiar swarm worker: ${agentType}${started ? ` · run ${started.run.id}` : ""}`,
  ];
  if (scope.root !== scope.ctx.root)
    lines.push(
      `You work in a git worktree (${scope.root}); the swarm ledger is shared with the main checkout ${scope.ctx.root}.`,
    );
  lines.push(brief);
  return {
    hookSpecificOutput: {
      hookEventName: "SubagentStart",
      additionalContext: clip(lines.join("\n"), CONTEXT_MAX),
    },
  };
}

/** The brief when the ledger could not be read: enough to work and to coordinate. */
function fallbackBrief(role: string, swarm: string, runId?: string): string {
  return [
    `You are the "${role}" worker of the eminiar swarm "${swarm}"${runId ? `, run ${runId}` : ""}. The swarm ledger was busy when you started, so this brief is short.`,
    'If your prompt names "task #N", claim it with em_swarm {action:"claim", task:N}; otherwise claim the next open task with em_swarm {action:"claim"}. Report with em_swarm {action:"update", task, status, result}.',
    'Ask eminiar before acting: em_recall {query}, em_history {action:"file", path}, em_graph_impact {node}.',
  ].join("\n");
}

/** The SubagentStart handler: swarm workers get their brief; every other agent nothing. */
export const subagentStart: HookHandler = async (input) => {
  if (!isSwarmAgentType(input.agent_type) || !input.agent_id) return undefined;
  try {
    return await swarmSubagentStart(getContext(input.cwd), input);
  } catch (err) {
    return fail("subagentStart", err);
  }
};

// --- PostToolUse / PostToolUseFailure / SubagentStop ---------------------------------------

/** A tool call (or failure) made inside a swarm worker: count it and add it to the feed. */
export function swarmActivity(ctx: ProjectContext, input: HookInput, failed: boolean): void {
  const agentType = input.agent_type;
  if (!isSwarmAgentType(agentType) || !input.agent_id || !input.tool_name) return;
  try {
    const s = swarmScope(ctx, agentType);
    if (!s) return;
    recordActivity(s.db, s.config, s.root, {
      agentId: input.agent_id,
      agentType,
      sessionId: input.session_id || undefined,
      tool: input.tool_name,
      input: input.tool_input,
      failed,
      error: failed ? (input.error ?? "tool failed") : undefined,
    });
  } catch (err) {
    fail("activity", err);
  }
}

/** SubagentStop for a swarm worker: close it, settle its task, keep its last message. */
export function swarmSubagentStop(ctx: ProjectContext, input: HookInput): void {
  const agentType = input.agent_type;
  if (!isSwarmAgentType(agentType) || !input.agent_id) return;
  try {
    const s = swarmScope(ctx, agentType);
    if (!s) return;
    closeWorker(s.db, s.config, {
      agentId: input.agent_id,
      agentType,
      sessionId: input.session_id || undefined,
      message: input.last_assistant_message,
    });
  } catch (err) {
    fail("subagentStop", err);
  }
}

// --- SessionStart -------------------------------------------------------------------------

const SESSION_LINE_MAX = 600;

function taskCounts(db: StorageAdapter, runId: string): string {
  const c: Record<TaskStatus, number> = { pending: 0, active: 0, done: 0, failed: 0, blocked: 0 };
  for (const t of db.swarm.tasks(runId)) c[t.status]++;
  const parts = [`${c.pending} pending`, `${c.active} active`, `${c.done} done`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  return parts.join(", ");
}

/**
 * SessionStart: when swarms are opted in, regenerate the agent files (`sync: auto`) and
 * return one short context line naming the swarms and any active run. An invalid swarm
 * file returns a one-line warning instead. Undefined when the project has no swarm file.
 */
export function swarmSessionStart(ctx: ProjectContext, sessionId?: string): string | undefined {
  try {
    const local = ctx.root;
    let main = local;
    let loaded = loadSwarmConfig(local);
    if (loaded.state === "absent") {
      main = coordinationRoot(local);
      if (main === local) return undefined;
      loaded = loadSwarmConfig(main);
      if (loaded.state === "absent") return undefined;
    } else main = coordinationRoot(local);

    if (loaded.state === "invalid") {
      const first = loaded.issues[0];
      const where = first
        ? `${first.path || "(file)"}${first.line ? ` (line ${first.line})` : ""}: ${first.message}`
        : "unknown problem";
      const more = loaded.issues.length > 1 ? ` (+${loaded.issues.length - 1} more)` : "";
      return clip(
        `eminiar swarm: ${loaded.rel} is invalid, so swarms are off. ${where}${more}. \`eminiar swarm validate\` lists every issue.`,
        400,
      );
    }

    const config = loaded.config;
    // The agent files belong to this checkout: Claude Code reads .claude/agents from here.
    if (!config.enabled) {
      if (config.sync !== "auto") return undefined;
      const pruned = syncAgents(local, config);
      return pruned.changed
        ? `eminiar swarm: swarms are disabled in ${config.rel}; removed ${pruned.changed} generated agent file(s) from .claude/agents.`
        : undefined;
    }
    const sync = syncAgents(local, config, { dryRun: config.sync !== "auto" });

    const swarms = config.swarms
      .map((s) => `${s.name} (${s.topology}: ${s.roles.map((r) => r.role).join(", ")})`)
      .join("; ");
    // Most actionable first, so the cap never cuts a sync warning.
    const out = [`eminiar swarms (${config.rel}): ${clip(swarms, 240)}.`];
    if (sync.changed)
      out.push(
        config.sync === "auto"
          ? `Agent files were regenerated (${sync.changed} changed); if Claude Code does not list them yet, run /agents or restart.`
          : `${sync.changed} agent file(s) are out of date (sync: manual); run \`eminiar swarm sync\`.`,
      );
    if (sync.conflicts)
      out.push(
        `${sync.conflicts} agent file(s) in .claude/agents were left alone (hand-written, or generated and then edited); \`eminiar swarm sync --dry-run\` explains.`,
      );
    const mctx = main === local ? ctx : getContext(main);
    const db = getStorage(mctx, { vectors: false });
    const run = db.swarm.runActive(undefined, sessionId);
    if (run)
      out.push(
        `Active run ${run.id} of "${run.swarm}": ${clip(run.goal, 80)} (${taskCounts(db, run.id)}); em_swarm {action:"status"} shows it.`,
      );
    out.push("Start one with /eminiar:em-swarm <swarm> <goal>.");
    return clip(out.join(" "), SESSION_LINE_MAX);
  } catch (err) {
    return fail("sessionStart", err);
  }
}
