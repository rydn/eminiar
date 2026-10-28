import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getContext, type ProjectContext } from "../context.js";
import { hookLog } from "../hooks/log.js";
import type { HookHandler, HookInput, HookOutput } from "../hooks/types.js";
import { findProjectRoot, resolveProjectRoot } from "../project.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { syncAgents } from "./agents.js";
import { workerBrief } from "./brief.js";
import {
  activeSwarmConfig,
  enforceIntent,
  findRole,
  isSwarmAgentType,
  loadSwarmConfig,
  swarmFile,
} from "./config.js";
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
import type { ConfigIssue, SwarmConfig, TaskStatus } from "./types.js";

/**
 * The swarm side of the Claude Code hooks (spec: docs/design/agent-swarms.md, "Hooks").
 * Opt-in and cheap: without an enabled `.eminiar/swarm.yaml` the entry points do nothing.
 * Worker lifecycle hooks (SubagentStart / Stop, activity, touch) return before any I/O unless
 * the agent type looks like a generated swarm worker (or the tool is em_swarm). The one
 * exception is the PreToolUse(Agent / Task) check, which first looks for `enforce: true` in
 * the swarm files (swarmRoots order; the first file found governs) and, when enforcing, denies
 * every subagent that is not a configured worker or allow-listed agent, from the main session
 * and from inside subagents alike. Nothing here throws except swarmGate (by design): a swarm
 * problem is logged to ~/.eminiar/hook.log and Claude carries on.
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

/**
 * The one normalisation point for an Agent / Task call's `subagent_type`: trimmed, or
 * undefined when absent. Reservation (PreToolUse) and release (PostToolUse / failure) both
 * read it, so they always agree on the type a spawn was recorded under.
 */
function spawnType(input: Pick<HookInput, "tool_input">): string | undefined {
  return str(input.tool_input?.subagent_type)?.trim() || undefined;
}

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

/**
 * This session's project root: CLAUDE_PROJECT_DIR (Claude Code sets it per hook command for
 * THIS session), then EMINIAR_PROJECT_ROOT (inherited by nested `claude` processes started
 * from Bash, so it must not win), then the process cwd. Unlike resolveProjectRoot, which the
 * MCP server uses, the hook order puts the per-session variable first.
 */
function sessionRoot(): string {
  const root = findProjectRoot(
    process.env.CLAUDE_PROJECT_DIR || process.env.EMINIAR_PROJECT_ROOT || process.cwd(),
  );
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * The project roots a swarm hook tries, in order: the session's project root (sessionRoot),
 * then the hook's own. The cwd drifts when the coordinator's shell cd's into a nested
 * repository or package, and its root then stops short of the workspace's swarm.yaml. Pure fs,
 * never throws; every swarm path takes its order from here.
 */
function orderedRoots(hookRoot: string | undefined): string[] {
  const out: string[] = [];
  try {
    out.push(sessionRoot());
  } catch {
    // no session root: the hook's own is all there is
  }
  if (hookRoot && !out.includes(hookRoot)) out.push(hookRoot);
  return out;
}

/**
 * Every directory whose swarm file may govern this hook call, ordered and deduplicated: the
 * session root, then the hook cwd's root, each followed by its coordination root (the main
 * checkout of a worktree). No getContext, no database: safe after a handler threw.
 */
export function swarmRoots(input: Pick<HookInput, "cwd">): string[] {
  let hook: string | undefined;
  try {
    hook = resolveProjectRoot(input.cwd || undefined);
  } catch {
    // fall back to the session root alone
  }
  const out: string[] = [];
  for (const r of orderedRoots(hook)) {
    for (const d of [r, coordinationRoot(r)]) if (!out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * The directories whose swarm file may govern ENFORCEMENT, the SessionStart text and the agent
 * files: the session's own root and its coordination root, nothing else. The hook cwd's root
 * never decides these, because a `cd` into a sub-repo the session never opted into must not
 * impose that repo's enforcement (an unsatisfiable deny), announce it, or write agent files
 * into it. Tracking (swarmScope) keeps the cwd fallback. Pure fs, never throws.
 */
function enforcementRoots(): string[] {
  try {
    const r = sessionRoot();
    const out = [r];
    const c = coordinationRoot(r);
    if (c !== r) out.push(c);
    return out;
  } catch {
    return [];
  }
}

/** The project contexts a swarm hook should try, in the order of swarmRoots. */
export function swarmRootCandidates(ctx: ProjectContext): ProjectContext[] {
  const out: ProjectContext[] = [];
  for (const r of orderedRoots(ctx.root)) {
    if (r === ctx.root) {
      out.push(ctx);
      continue;
    }
    try {
      out.push(getContext(r));
    } catch {
      // an unusable session root: skip it
    }
  }
  return out;
}

function swarmScope(hookCtx: ProjectContext, agentType?: string): SwarmScope | undefined {
  for (const ctx of swarmRootCandidates(hookCtx)) {
    const main = coordinationRoot(ctx.root);
    const config = configFor(ctx.root, main, agentType);
    if (!config) continue;
    const mctx = main === ctx.root ? ctx : getContext(main);
    return { ctx: mctx, db: getStorage(mctx, { vectors: false }), config, root: ctx.root };
  }
  return undefined;
}

// --- PreToolUse ---------------------------------------------------------------------------

export type SwarmSpawnCheck =
  /** Over capacity or not allowed: answer the PreToolUse call with this denial. */
  | { kind: "deny"; output: HookOutput }
  /** A configured swarm worker; its brief comes from SubagentStart, not the prompt. */
  | { kind: "worker"; agentType: string; runId?: string | undefined; taskId?: number | undefined };

/**
 * PreToolUse on Agent / Task: when the project enforces, apply the enforcement rule (deny
 * non-workers, require a run, nested calls only from the allow-list); otherwise, for a swarm
 * worker, check capacity and reserve the slot. Undefined for every other agent type, and when
 * swarms are not opted in.
 */
export function swarmPreAgent(ctx: ProjectContext, input: HookInput): SwarmSpawnCheck | undefined {
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return undefined;
  const ti = input.tool_input ?? {};
  const agentType = spawnType(input);
  // Enforcement, main session and subagents alike (swarms are Claude Code only), before
  // anything else.
  if (input.client !== "cursor") {
    const enf = enforcementFor(input);
    if (enf) return enforcePreAgent(input, enf, agentType || "general-purpose");
  }
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
      return denyCheck(`eminiar swarm: ${d.reason}`);
    }
    return { kind: "worker", agentType, runId: d.run?.id, taskId: d.taskId };
  } catch (err) {
    fail("reserveSpawn", err);
    // A busy database is transient: refuse the spawn with a retry hint rather than let it
    // past the capacity check the project opted into. Any other failure lets it through
    // unrecorded (SubagentStart still registers the worker) so a broken ledger never
    // blocks Claude.
    if (isBusy(err)) return denyCheck(BUSY_TEXT);
    return { kind: "worker", agentType };
  }
}

const BUSY_TEXT =
  "eminiar swarm: the swarm ledger is busy, so capacity could not be checked; retry the spawn in a moment.";

function denyCheck(reason: string): SwarmSpawnCheck {
  return {
    kind: "deny",
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    },
  };
}

// --- enforcement --------------------------------------------------------------------------

const ENFORCE_PREFIX = "eminiar swarm enforcement:";
const ENFORCE_TEXT_MAX = 1800;

/** The first line of an error, at most 160 chars, for failedText. */
function errLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return clip(m.split("\n")[0] ?? "", 160);
}

/** `path (line N): message` of the first issue, as the SessionStart warning words it. */
function issueWhere(issues: ConfigIssue[]): string {
  const first = issues[0];
  return first
    ? `${first.path || "(file)"}${first.line ? ` (line ${first.line})` : ""}: ${first.message}`
    : "unknown problem";
}

/** The run line of notWorkerText. `undefined` run: none is active; "unknown": the lookup failed. */
export function runLineText(
  config: Pick<SwarmConfig, "swarms">,
  run: { id: string; swarm: string } | undefined | "unknown",
): string {
  if (run && run !== "unknown")
    return `Run ${run.id} of "${run.swarm}" is active: spawn its workers with a prompt naming "task #N" (em_swarm {action:"status"} lists the tasks).`;
  const name = config.swarms.length === 1 ? config.swarms[0]!.name : "<swarm>";
  const line = `Start a run first: em_swarm {action:"start", swarm:"${name}", goal:"<goal>"}, add tasks with em_swarm {action:"plan"}, then spawn swarm-<swarm>-<role> with a prompt naming "task #N" (the /eminiar:em-swarm skill has the playbook).`;
  return run === "unknown"
    ? `If no run is active, ${line.charAt(0).toLowerCase()}${line.slice(1)}`
    : line;
}

/** Deny text for an agent type that is not a swarm worker. */
export function notWorkerText(
  config: Pick<SwarmConfig, "swarms" | "rel" | "allowedAgents">,
  agentType: string,
  runLine: string,
): string {
  const lines = [
    `${ENFORCE_PREFIX} "${agentType}" is not a swarm worker${agentType.startsWith("swarm-") ? " (a stale agent file?)" : ""}, and this project (${config.rel}, enforce: true) only allows swarm workers as subagents.`,
    "Swarms:",
  ];
  const tail: string[] = [runLine];
  if (config.allowedAgents.length) tail.push(`Also allowed: ${config.allowedAgents.join(", ")}.`);
  tail.push(
    `Or do the work yourself in this session. Only the user can turn enforcement off (enforce: false in ${config.rel}); ask them rather than editing it.`,
  );
  // The swarm list is the flexible part: shrink it (descriptions, then swarms) until the
  // head, the run line and the closing sentence fit, so the escape-hatch sentence survives.
  const listed = (n: number, desc: number): string[] => {
    const out = config.swarms
      .slice(0, n)
      .map(
        (s) =>
          `- ${s.name}: ${clip(s.description, desc)} Workers: ${s.roles.map((r) => r.agentType).join(", ")}`,
      );
    if (config.swarms.length > n)
      out.push(`+${config.swarms.length - n} more: em_swarm {action:"list"}`);
    return out;
  };
  const build = (n: number, desc: number): string =>
    [...lines, ...listed(n, desc), ...tail].join("\n");
  let n = Math.min(8, config.swarms.length);
  let text = build(n, 120);
  for (const desc of [60, 30]) if (text.length > ENFORCE_TEXT_MAX) text = build(n, desc);
  while (text.length > ENFORCE_TEXT_MAX && n > 0) text = build(--n, 30);
  return text.length > ENFORCE_TEXT_MAX ? clip(text, ENFORCE_TEXT_MAX) : text;
}

/** Deny text for a configured worker while its swarm has no active run. */
export function noRunText(swarm: string, agentType: string): string {
  return `${ENFORCE_PREFIX} swarm "${swarm}" has no active run, so ${agentType} cannot start. Start one with em_swarm {action:"start", swarm:"${swarm}", goal:"<goal>"}, add tasks with em_swarm {action:"plan"}, then spawn ${agentType} again with a prompt naming "task #N" (the /eminiar:em-swarm skill has the playbook).`;
}

/** Deny text for an Agent / Task call made from inside a subagent (workers are leaves). */
export function nestedText(
  config: Pick<SwarmConfig, "rel" | "allowedAgents">,
  agentType: string,
): string {
  const allowed = config.allowedAgents.length
    ? ` Only these agent types may be started from a subagent: ${config.allowedAgents.join(", ")}.`
    : "";
  return `${ENFORCE_PREFIX} "${agentType}" cannot be started from inside a subagent: swarm workers are leaves and only the coordinator (the main session) spawns them (${config.rel}, enforce: true). Subagents cannot start subagents while enforcement is on: finish the work yourself and report back to the main session, which can start a swarm run or spawn workers (a swarm worker can add follow-up tasks with em_swarm {action:"plan"}).${allowed}`;
}

/** Deny text when the swarm file sets enforce: true but is invalid. */
export function brokenText(rel: string, where: string): string {
  return `${ENFORCE_PREFIX} ${rel} sets enforce: true but is invalid (${where}), so every subagent is denied until it is fixed; \`eminiar swarm validate\` lists the issues. Do the work in this session meanwhile, or ask the user to fix the file.`;
}

/** Deny text when the enforcement check itself failed (fails closed). `err` is any error or text. */
export function failedText(err: unknown): string {
  return `${ENFORCE_PREFIX} the check failed (${errLine(err)}), so this subagent is denied (enforcement fails closed). Retry in a moment; if it keeps failing, do the work in this session and tell the user (details in ~/.eminiar/hook.log).`;
}

/** The SessionStart sentence announcing enforcement. */
export function enforcementSessionText(config: Pick<SwarmConfig, "allowedAgents">): string {
  const also = config.allowedAgents.length
    ? `; also allowed: ${config.allowedAgents.join(", ")}`
    : "";
  return `Swarm enforcement is on: the Agent tool only runs swarm workers (swarm-<swarm>-<role>) while a run of their swarm is active${also}. Explore, Plan, general-purpose, forks and other agents are denied, so plan subagent work as a swarm run, or do it in this session.`;
}

export type Enforcement =
  | { kind: "on"; dir: string; config: SwarmConfig }
  | { kind: "broken"; rel: string; where: string }
  | { kind: "error"; err: unknown };

/**
 * Does the raw swarm file text of the governing candidate ask for enforcement? The first
 * candidate (enforcementRoots order) that has a swarm file decides, as in enforcementFor. Reads
 * files only (no yaml parser, no database), so it still works when the config loader itself
 * is what broke.
 */
export function rawEnforced(_input: Pick<HookInput, "cwd">): boolean {
  try {
    for (const d of enforcementRoots()) {
      try {
        const f = swarmFile(d);
        if (f.exists) return enforceIntent(readFileSync(f.file, "utf8"));
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Which swarm file enforces for this call: the FIRST candidate in enforcementRoots order (the
 * session root, then its coordination root; never the hook cwd's root) that has a swarm file decides, whether that file enforces or not and
 * whether it is valid or invalid-with-intent. Later candidates are consulted only when
 * earlier ones have no file. The session root coming first keeps a `cd` into a sub-repo from
 * switching the workspace's enforcement off, and keeps a sub-repo's file from imposing its
 * enforcement on the workspace's workers. Never throws.
 */
export function enforcementFor(input: Pick<HookInput, "cwd">): Enforcement | undefined {
  try {
    for (const dir of enforcementRoots()) {
      const loaded = loadSwarmConfig(dir);
      if (loaded.state === "absent") continue;
      if (loaded.state === "ok")
        return loaded.config.enabled && loaded.config.enforce
          ? { kind: "on", dir, config: loaded.config }
          : undefined;
      return loaded.enforce
        ? { kind: "broken", rel: loaded.rel, where: issueWhere(loaded.issues) }
        : undefined;
    }
    return undefined;
  } catch (err) {
    fail("enforcement", err);
    return rawEnforced(input) ? { kind: "error", err } : undefined;
  }
}

/** Open the coordination root's ledger of a swarm file's directory. */
function ledgerOf(dir: string): StorageAdapter {
  return getStorage(getContext(coordinationRoot(dir)), { vectors: false });
}

function enforcePreAgent(
  input: HookInput,
  enf: Enforcement,
  agentType: string,
): SwarmSpawnCheck | undefined {
  if (enf.kind === "broken") return denyCheck(brokenText(enf.rel, enf.where));
  if (enf.kind === "error") return denyCheck(failedText(enf.err));
  const { config, dir } = enf;
  const ti = input.tool_input ?? {};
  if (input.agent_id) {
    // A subagent starting a subagent: only the allow-list passes; workers are leaves.
    if (config.allowedAgents.includes(agentType)) return undefined;
    hookLog("info", `swarm enforcement denied nested ${agentType}`);
    return denyCheck(nestedText(config, agentType));
  }
  if (!findRole(config, agentType)) {
    if (config.allowedAgents.includes(agentType)) return undefined;
    return denyCheck(notWorkerDenial(input, dir, config, agentType, true));
  }
  try {
    const d = reserveSpawn(ledgerOf(dir), config, {
      agentType,
      prompt: str(ti.prompt),
      description: str(ti.description),
      sessionId: input.session_id || undefined,
      toolUseId: input.tool_use_id || undefined,
      requireRun: true,
    });
    if (!d) return denyCheck(failedText("unknown agent type"));
    if (d.decision === "deny") {
      hookLog("info", `swarm deny ${agentType}: ${d.reason}`);
      const swarm = findRole(config, agentType)!.swarm.name;
      return denyCheck(
        d.code === "no_run" ? noRunText(swarm, agentType) : `eminiar swarm: ${d.reason}`,
      );
    }
    return { kind: "worker", agentType, runId: d.run?.id, taskId: d.taskId };
  } catch (err) {
    fail("enforceReserve", err);
    return denyCheck(isBusy(err) ? BUSY_TEXT : failedText(err));
  }
}

/** The deny reason for a non-worker. `lookup` reads the ledger for the run line (best effort). */
function notWorkerDenial(
  input: Pick<HookInput, "session_id">,
  dir: string,
  config: SwarmConfig,
  agentType: string,
  lookup: boolean,
): string {
  let run: Parameters<typeof runLineText>[1] = "unknown";
  if (lookup) {
    try {
      run = ledgerOf(dir).swarm.runActive(undefined, input.session_id || undefined);
    } catch (err) {
      fail("enforceRunLine", err);
    }
  }
  hookLog("info", `swarm enforcement denied ${agentType}`);
  return notWorkerText(config, agentType, runLineText(config, run));
}

/**
 * `em-hook --gate`: decide only, for a project-level `onFailure: "block"` entry. Applies the same
 * rule as the plugin hook (enforcementFor + findRole + allowedAgents + the same texts) but never
 * reserves a spawn or touches the ledger; run and capacity stay with the plugin hook. Returns
 * the deny output, or undefined to allow / not applicable. THROWS on any error, so the caller
 * exits non-zero and the blocking entry blocks.
 */
export function swarmGate(input: HookInput): HookOutput | undefined {
  if (input.hook_event_name !== "PreToolUse") return undefined;
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return undefined;
  if (input.client === "cursor") return undefined;
  const enf = enforcementFor(input);
  if (!enf) return undefined;
  if (enf.kind === "error") throw enf.err;
  const agentType = spawnType(input) || "general-purpose";
  const nested = !!input.agent_id;
  if (enf.kind === "on") {
    if (enf.config.allowedAgents.includes(agentType)) return undefined;
    if (!nested && findRole(enf.config, agentType)) return undefined;
  }
  const reason =
    enf.kind === "broken"
      ? brokenText(enf.rel, enf.where)
      : nested
        ? nestedText(enf.config, agentType)
        : notWorkerDenial(input, enf.dir, enf.config, agentType, false);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
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
    // The MCP server resolves its project from EMINIAR_PROJECT_ROOT first, which a nested
    // claude inherits from an outer session; the hooks use this session's root. Name it, so
    // both use one ledger. An explicit project_root is never overridden.
    if (typeof rest.project_root !== "string" || !rest.project_root)
      rest.project_root = sessionRoot();
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
  const agentType = spawnType(input);
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
const SESSION_LINE_MAX_ENFORCING = 1000;

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
export function swarmSessionStart(hookCtx: ProjectContext, sessionId?: string): string | undefined {
  // The session root only: the hook cwd's root never decides the text or where agent files go.
  let ctx: ProjectContext;
  try {
    const r = sessionRoot();
    ctx = r === hookCtx.root ? hookCtx : getContext(r);
  } catch (err) {
    return fail("sessionStart", err);
  }
  return sessionStartAt(ctx, sessionId);
}

function sessionStartAt(ctx: ProjectContext, sessionId?: string): string | undefined {
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
      const where = issueWhere(loaded.issues);
      const more = loaded.issues.length > 1 ? ` (+${loaded.issues.length - 1} more)` : "";
      if (loaded.enforce)
        return clip(
          `eminiar swarm: ${loaded.rel} is invalid (${where}${more}), so swarms are off and, because it sets enforce: true, every subagent is denied until it is fixed. \`eminiar swarm validate\` lists every issue.`,
          500,
        );
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
    if (config.enforce) out.push(enforcementSessionText(config));
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
    return clip(out.join(" "), config.enforce ? SESSION_LINE_MAX_ENFORCING : SESSION_LINE_MAX);
  } catch (err) {
    return fail("sessionStart", err);
  }
}
