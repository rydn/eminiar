/**
 * Agent swarms: shared types. A swarm is declared in `.eminiar/swarm.yaml`; its roles become
 * Claude Code project agents (`.claude/agents/swarm-<swarm>-<role>.md`) and its runs are a
 * ledger in the project database. The main session coordinates; workers are subagents.
 * Spec: docs/design/agent-swarms.md.
 */

export const TOPOLOGIES = ["hierarchical", "mesh", "pipeline"] as const;
export type Topology = (typeof TOPOLOGIES)[number];

export const TASK_STATUSES = ["pending", "active", "done", "failed", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_STATUSES = ["active", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** `stale`: still marked running but silent for longer than STALE_MS (derived, never stored). */
export type WorkerStatus = "running" | "done" | "stale";

/** Hook events a role may scope to its own agent file (Claude Code frontmatter hooks). */
export const ROLE_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type RoleHookEvent = (typeof ROLE_HOOK_EVENTS)[number];

// --- configuration (resolved: defaults applied) ---------------------------------------

/** What a worker is told at start; every field resolved from defaults < swarm < role. */
export interface ContextSpec {
  memories: number;
  docs: number;
  history: boolean;
  structure: boolean;
  insights: boolean;
  maxChars: number;
}

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number | undefined;
}

export interface HookMatcher {
  matcher?: string | undefined;
  hooks: HookCommand[];
}

export type RoleHooks = Partial<Record<RoleHookEvent, HookMatcher[] | undefined>>;

export interface RoleSpec {
  swarm: string;
  role: string;
  /** Claude Code agent name / `subagent_type`: `swarm-<swarm>-<role>`. */
  agentType: string;
  description: string;
  prompt: string;
  model?: string | undefined;
  tools?: string[] | undefined;
  disallowedTools?: string[] | undefined;
  skills: string[];
  hooks?: RoleHooks | undefined;
  /** Project-relative path globs the role works on (knowledge is focused on them). */
  scope: string[];
  /** Tags, kinds or topics of memories always shown to this role. */
  memoryTags: string[];
  /** At most this many workers of the role at once. */
  count: number;
  isolation?: "worktree" | undefined;
  maxTurns?: number | undefined;
  effort?: string | undefined;
  color?: string | undefined;
  context: ContextSpec;
}

export interface SwarmSpec {
  name: string;
  description: string;
  topology: Topology;
  /** Concurrent workers in one run. */
  maxAgents: number;
  /** Pipeline order of roles; roles not listed are not stage-gated. */
  stages: string[];
  /** Extra playbook text for the coordinator (the main session). */
  instructions: string;
  roles: RoleSpec[];
}

export interface SwarmConfig {
  /** Absolute path of the YAML file. */
  file: string;
  /** Project-relative path of the YAML file. */
  rel: string;
  enabled: boolean;
  /** auto: SessionStart regenerates agent files when they differ from the YAML. */
  sync: "auto" | "manual";
  swarms: SwarmSpec[];
  /** sha1 of the resolved swarms, for "is everything generated from this version?". */
  hash: string;
}

export interface ConfigIssue {
  /** Dotted YAML path (`swarms.feature.agents.coder.count`), or "" for the whole file. */
  path: string;
  message: string;
  /** 1-based line in the YAML file, when it could be located. */
  line?: number | undefined;
}

export type LoadResult =
  | { state: "absent"; file: string; rel: string }
  | { state: "invalid"; file: string; rel: string; issues: ConfigIssue[] }
  | { state: "ok"; config: SwarmConfig };

// --- runtime ledger --------------------------------------------------------------------

export interface RunRow {
  id: string;
  swarm: string;
  goal: string;
  status: RunStatus;
  topology: Topology;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  summary: string | null;
}

export interface TaskRow {
  id: number;
  run_id: string;
  title: string;
  detail: string | null;
  role: string | null;
  status: TaskStatus;
  agent_id: string | null;
  deps: number[];
  files: string[];
  result: string | null;
  /** Closed by SubagentStop because the worker stopped without reporting. */
  auto_closed: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkerRow {
  run_id: string;
  agent_id: string;
  agent_type: string;
  role: string;
  status: "running" | "done";
  task_id: number | null;
  prompt: string | null;
  session_id: string | null;
  spawned_at: number;
  last_ts: number;
  ended_at: number | null;
  tool_calls: number;
  errors: number;
  last_tool: string | null;
  summary: string | null;
}

export const EVENT_KINDS = [
  "run_start",
  "run_finish",
  "plan",
  "claim",
  "update",
  "post",
  "spawn",
  "deny",
  "start",
  "tool",
  "tool_error",
  "stop",
  "auto_close",
] as const;
export type SwarmEventKind = (typeof EVENT_KINDS)[number];

export interface SwarmEventRow {
  id: number;
  run_id: string;
  ts: number;
  agent_id: string | null;
  role: string | null;
  kind: SwarmEventKind;
  task_id: number | null;
  text: string | null;
  payload: Record<string, unknown> | null;
}

export interface NoteRow {
  run_id: string;
  key: string;
  value: string;
  author: string | null;
  ts: number;
  version: number;
}

export interface SpawnRow {
  id: number;
  swarm: string;
  run_id: string | null;
  session_id: string | null;
  agent_type: string;
  prompt: string | null;
  task_id: number | null;
  tool_use_id: string | null;
  ts: number;
  consumed: boolean;
}

export interface TaskInput {
  run_id: string;
  title: string;
  detail?: string | null | undefined;
  role?: string | null | undefined;
  deps?: number[] | undefined;
  files?: string[] | undefined;
  created_by?: string | null | undefined;
}

export interface TaskPatch {
  status?: TaskStatus | undefined;
  agent_id?: string | null | undefined;
  result?: string | null | undefined;
  auto_closed?: boolean | undefined;
  files?: string[] | undefined;
}

export interface EventInput {
  run_id: string;
  kind: SwarmEventKind;
  agent_id?: string | null | undefined;
  role?: string | null | undefined;
  task_id?: number | null | undefined;
  text?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
  ts?: number | undefined;
}

/**
 * The swarm ledger, a sub-store of the project database (`db.swarm`). Every method is a
 * single statement or an explicit transaction; hooks run in separate processes, so state
 * that is checked and then written goes through `immediate()`.
 */
export interface SwarmStore {
  /** Run `fn` in a BEGIN IMMEDIATE transaction (takes the write lock up front). */
  immediate<T>(fn: () => T): T;

  runCreate(r: {
    id: string;
    swarm: string;
    goal: string;
    topology: Topology;
    session_id?: string | null | undefined;
  }): RunRow;
  runGet(id: string): RunRow | undefined;
  runs(opts?: {
    swarm?: string | undefined;
    status?: RunStatus | undefined;
    limit?: number;
  }): RunRow[];
  /** Newest active run, of `swarm` when given, preferring runs of `sessionId`. */
  runActive(swarm?: string | undefined, sessionId?: string | undefined): RunRow | undefined;
  runUpdate(
    id: string,
    patch: { status?: RunStatus; summary?: string | null; ended_at?: number | null },
  ): void;
  runTouch(id: string): void;

  taskAdd(t: TaskInput): TaskRow;
  taskGet(id: number): TaskRow | undefined;
  tasks(runId: string): TaskRow[];
  taskUpdate(id: number, patch: TaskPatch): void;
  /** Atomically move a pending task to active for `agentId`; false if it was not pending. */
  taskClaim(id: number, agentId: string): boolean;

  workerUpsert(w: {
    run_id: string;
    agent_id: string;
    agent_type: string;
    role: string;
    session_id?: string | null | undefined;
    prompt?: string | null | undefined;
    task_id?: number | null | undefined;
  }): WorkerRow;
  workerGet(runId: string, agentId: string): WorkerRow | undefined;
  /** The newest worker row for a Claude Code agent id, across runs. */
  workerFind(agentId: string): WorkerRow | undefined;
  workers(runId: string): WorkerRow[];
  workerUpdate(
    runId: string,
    agentId: string,
    patch: {
      status?: "running" | "done";
      task_id?: number | null;
      ended_at?: number | null;
      summary?: string | null;
    },
  ): void;
  /** Count one tool call (or error) and stamp the last activity. */
  workerTouch(runId: string, agentId: string, tool: string | null, error?: boolean): void;

  eventAdd(e: EventInput): number;
  events(runId: string, opts?: { after?: number; limit?: number }): SwarmEventRow[];

  noteSet(runId: string, key: string, value: string, author: string | null): NoteRow;
  noteGet(runId: string, key: string): NoteRow | undefined;
  notes(runId: string): NoteRow[];

  spawnAdd(s: {
    swarm: string;
    run_id?: string | null | undefined;
    session_id?: string | null | undefined;
    agent_type: string;
    prompt?: string | null | undefined;
    task_id?: number | null | undefined;
    tool_use_id?: string | null | undefined;
  }): number;
  /** Consume the open reservation made for one Agent tool call; false if none was open. */
  spawnConsumeByToolUse(toolUseId: string): boolean;
  /** Oldest unconsumed reservation for `agentType` newer than `sinceTs`, marked consumed. */
  spawnTake(agentType: string, sinceTs: number, sessionId?: string | null): SpawnRow | undefined;
  /** Unconsumed reservations for `agentType` newer than `sinceTs` (same session when given), oldest first. */
  spawnsOpen(agentType: string, sinceTs: number, sessionId?: string | null): SpawnRow[];
  /** Mark one reservation consumed; false if it already was. */
  spawnConsume(id: number): boolean;
  /** Void every open reservation of a run (it finished). */
  spawnsVoid(runId: string): number;
  /** Unconsumed reservations of a swarm (any run, or none yet), optionally of one agent type. */
  spawnsPendingOfSwarm(swarm: string, sinceTs: number, agentType?: string): number;
  /** Workers of a swarm (any run) still marked running with activity since `sinceTs`. */
  liveWorkersOfSwarm(swarm: string, sinceTs: number): WorkerRow[];
  /** Active tasks held by one agent, across runs. */
  tasksHeldBy(agentId: string): TaskRow[];
  /** Workers still marked running that belong to a Claude Code session. */
  workersOfSession(sessionId: string): WorkerRow[];
  /** Keep only the newest `keep` events of a run; returns how many were deleted. */
  eventsPrune(runId: string, keep: number): number;
  /** Stamp a worker's last activity without counting a tool call. */
  workerPing(runId: string, agentId: string): void;
  /** The newest event of a run. */
  eventLast(runId: string): SwarmEventRow | undefined;
  /** Rewrite an event (to collapse repeats). */
  eventUpdate(
    id: number,
    patch: { ts?: number; text?: string | null; payload?: Record<string, unknown> | null },
  ): void;
  /** Unconsumed reservations of a run newer than `sinceTs`, optionally of one agent type. */
  spawnsPending(runId: string, sinceTs: number, agentType?: string): number;
}
