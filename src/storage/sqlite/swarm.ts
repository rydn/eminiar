import type Database from "better-sqlite3";
import type {
  EventInput,
  NoteRow,
  RunRow,
  RunStatus,
  SpawnRow,
  SwarmEventRow,
  SwarmStore,
  TaskInput,
  TaskPatch,
  TaskRow,
  Topology,
  WorkerRow,
} from "../../swarm/types.js";

type Row = Record<string, unknown>;

function jsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function jsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toTask(r: Row): TaskRow {
  return {
    ...(r as unknown as TaskRow),
    deps: jsonArray<number>(r.deps).filter((n) => Number.isInteger(n)),
    files: jsonArray<string>(r.files).filter((s) => typeof s === "string"),
    auto_closed: r.auto_closed === 1,
  };
}

function toEvent(r: Row): SwarmEventRow {
  return { ...(r as unknown as SwarmEventRow), payload: jsonObject(r.payload) };
}

function toSpawn(r: Row): SpawnRow {
  return { ...(r as unknown as SpawnRow), consumed: r.consumed === 1 };
}

/** SQLite implementation of the swarm ledger; shares the adapter's connection. */
export class SqliteSwarmStore implements SwarmStore {
  private readonly stmts = new Map<string, Database.Statement<unknown[], unknown>>();

  constructor(private readonly db: Database.Database) {}

  private prep(sql: string): Database.Statement<unknown[], unknown> {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  immediate<T>(fn: () => T): T {
    // Nested calls (an immediate step inside another transaction) just run inline.
    if (this.db.inTransaction) return fn();
    return this.db.transaction(fn).immediate();
  }

  // --- runs -------------------------------------------------------------------------

  runCreate(r: {
    id: string;
    swarm: string;
    goal: string;
    topology: Topology;
    session_id?: string | null | undefined;
  }): RunRow {
    const now = Date.now();
    this.prep(
      `INSERT INTO swarm_runs (id, swarm, goal, status, topology, session_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(r.id, r.swarm, r.goal, r.topology, r.session_id ?? null, now, now);
    return this.runGet(r.id)!;
  }

  runGet(id: string): RunRow | undefined {
    return this.prep("SELECT * FROM swarm_runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  runs(
    opts: { swarm?: string | undefined; status?: RunStatus | undefined; limit?: number } = {},
  ): RunRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.swarm) {
      where.push("swarm = ?");
      params.push(opts.swarm);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    params.push(Math.max(1, Math.min(opts.limit ?? 50, 500)));
    return this.prep(
      `SELECT * FROM swarm_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...params) as RunRow[];
  }

  runActive(swarm?: string | undefined, sessionId?: string | undefined): RunRow | undefined {
    // Same-session runs first, then the newest; a run of another session is still
    // reachable (a resumed or parallel session coordinating the same swarm).
    return this.prep(
      `SELECT * FROM swarm_runs WHERE status = 'active' AND (? IS NULL OR swarm = ?)
       ORDER BY (session_id IS NOT NULL AND session_id = ?) DESC, created_at DESC, rowid DESC
       LIMIT 1`,
    ).get(swarm ?? null, swarm ?? null, sessionId ?? null) as RunRow | undefined;
  }

  runUpdate(
    id: string,
    patch: { status?: RunStatus; summary?: string | null; ended_at?: number | null },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [Date.now()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      params.push(patch.summary);
    }
    if (patch.ended_at !== undefined) {
      sets.push("ended_at = ?");
      params.push(patch.ended_at);
    }
    params.push(id);
    this.prep(`UPDATE swarm_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  runTouch(id: string): void {
    this.prep("UPDATE swarm_runs SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // --- tasks ------------------------------------------------------------------------

  taskAdd(t: TaskInput): TaskRow {
    const now = Date.now();
    const info = this.prep(
      `INSERT INTO swarm_tasks (run_id, title, detail, role, status, deps, files, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(
      t.run_id,
      t.title,
      t.detail ?? null,
      t.role ?? null,
      JSON.stringify(t.deps ?? []),
      JSON.stringify(t.files ?? []),
      t.created_by ?? null,
      now,
      now,
    );
    return this.taskGet(Number(info.lastInsertRowid))!;
  }

  taskGet(id: number): TaskRow | undefined {
    const r = this.prep("SELECT * FROM swarm_tasks WHERE id = ?").get(id) as Row | undefined;
    return r ? toTask(r) : undefined;
  }

  tasks(runId: string): TaskRow[] {
    return (
      this.prep("SELECT * FROM swarm_tasks WHERE run_id = ? ORDER BY id").all(runId) as Row[]
    ).map(toTask);
  }

  taskUpdate(id: number, patch: TaskPatch): void {
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [Date.now()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.agent_id !== undefined) {
      sets.push("agent_id = ?");
      params.push(patch.agent_id);
    }
    if (patch.result !== undefined) {
      sets.push("result = ?");
      params.push(patch.result);
    }
    if (patch.auto_closed !== undefined) {
      sets.push("auto_closed = ?");
      params.push(patch.auto_closed ? 1 : 0);
    }
    if (patch.files !== undefined) {
      sets.push("files = ?");
      params.push(JSON.stringify(patch.files));
    }
    params.push(id);
    this.prep(`UPDATE swarm_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  taskClaim(id: number, agentId: string): boolean {
    const info = this.prep(
      `UPDATE swarm_tasks SET status = 'active', agent_id = ?, auto_closed = 0, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(agentId, Date.now(), id);
    return info.changes === 1;
  }

  // --- workers ----------------------------------------------------------------------

  workerUpsert(w: {
    run_id: string;
    agent_id: string;
    agent_type: string;
    role: string;
    session_id?: string | null | undefined;
    prompt?: string | null | undefined;
    task_id?: number | null | undefined;
  }): WorkerRow {
    const now = Date.now();
    // A resumed subagent keeps its counters; a restart of a finished one runs again.
    this.prep(
      `INSERT INTO swarm_agents (run_id, agent_id, agent_type, role, status, task_id, prompt, session_id, spawned_at, last_ts)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, agent_id) DO UPDATE SET
         status = 'running', ended_at = NULL, last_ts = excluded.last_ts,
         task_id = COALESCE(excluded.task_id, swarm_agents.task_id),
         prompt = COALESCE(excluded.prompt, swarm_agents.prompt)`,
    ).run(
      w.run_id,
      w.agent_id,
      w.agent_type,
      w.role,
      w.task_id ?? null,
      w.prompt ?? null,
      w.session_id ?? null,
      now,
      now,
    );
    return this.workerGet(w.run_id, w.agent_id)!;
  }

  workerGet(runId: string, agentId: string): WorkerRow | undefined {
    return this.prep("SELECT * FROM swarm_agents WHERE run_id = ? AND agent_id = ?").get(
      runId,
      agentId,
    ) as WorkerRow | undefined;
  }

  workerFind(agentId: string): WorkerRow | undefined {
    return this.prep(
      "SELECT * FROM swarm_agents WHERE agent_id = ? ORDER BY spawned_at DESC LIMIT 1",
    ).get(agentId) as WorkerRow | undefined;
  }

  workers(runId: string): WorkerRow[] {
    return this.prep("SELECT * FROM swarm_agents WHERE run_id = ? ORDER BY spawned_at").all(
      runId,
    ) as WorkerRow[];
  }

  workerUpdate(
    runId: string,
    agentId: string,
    patch: {
      status?: "running" | "done";
      task_id?: number | null;
      ended_at?: number | null;
      summary?: string | null;
    },
  ): void {
    const sets: string[] = ["last_ts = ?"];
    const params: unknown[] = [Date.now()];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.task_id !== undefined) {
      sets.push("task_id = ?");
      params.push(patch.task_id);
    }
    if (patch.ended_at !== undefined) {
      sets.push("ended_at = ?");
      params.push(patch.ended_at);
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      params.push(patch.summary);
    }
    params.push(runId, agentId);
    this.prep(`UPDATE swarm_agents SET ${sets.join(", ")} WHERE run_id = ? AND agent_id = ?`).run(
      ...params,
    );
  }

  workerTouch(runId: string, agentId: string, tool: string | null, error = false): void {
    this.prep(
      `UPDATE swarm_agents SET last_ts = ?, tool_calls = tool_calls + 1, errors = errors + ?,
         last_tool = COALESCE(?, last_tool)
       WHERE run_id = ? AND agent_id = ?`,
    ).run(Date.now(), error ? 1 : 0, tool, runId, agentId);
  }

  // --- events -----------------------------------------------------------------------

  eventAdd(e: EventInput): number {
    const info = this.prep(
      `INSERT INTO swarm_events (run_id, ts, agent_id, role, kind, task_id, text, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.run_id,
      e.ts ?? Date.now(),
      e.agent_id ?? null,
      e.role ?? null,
      e.kind,
      e.task_id ?? null,
      e.text ?? null,
      e.payload ? JSON.stringify(e.payload) : null,
    );
    return Number(info.lastInsertRowid);
  }

  events(runId: string, opts: { after?: number; limit?: number } = {}): SwarmEventRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    if (opts.after !== undefined) {
      // Incremental (a live feed): the next events after `after`, oldest first.
      return (
        this.prep("SELECT * FROM swarm_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?").all(
          runId,
          opts.after,
          limit,
        ) as Row[]
      ).map(toEvent);
    }
    // A snapshot: the latest `limit` events, returned oldest first.
    return (
      this.prep("SELECT * FROM swarm_events WHERE run_id = ? ORDER BY id DESC LIMIT ?").all(
        runId,
        limit,
      ) as Row[]
    )
      .map(toEvent)
      .reverse();
  }

  // --- blackboard -------------------------------------------------------------------

  noteSet(runId: string, key: string, value: string, author: string | null): NoteRow {
    this.prep(
      `INSERT INTO swarm_notes (run_id, key, value, author, ts, version) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(run_id, key) DO UPDATE SET value = excluded.value, author = excluded.author,
         ts = excluded.ts, version = swarm_notes.version + 1`,
    ).run(runId, key, value, author, Date.now());
    return this.noteGet(runId, key)!;
  }

  noteGet(runId: string, key: string): NoteRow | undefined {
    return this.prep("SELECT * FROM swarm_notes WHERE run_id = ? AND key = ?").get(runId, key) as
      | NoteRow
      | undefined;
  }

  notes(runId: string): NoteRow[] {
    return this.prep("SELECT * FROM swarm_notes WHERE run_id = ? ORDER BY ts DESC").all(
      runId,
    ) as NoteRow[];
  }

  // --- spawn reservations -----------------------------------------------------------

  spawnAdd(s: {
    swarm: string;
    run_id?: string | null | undefined;
    session_id?: string | null | undefined;
    agent_type: string;
    prompt?: string | null | undefined;
    task_id?: number | null | undefined;
    tool_use_id?: string | null | undefined;
  }): number {
    const info = this.prep(
      `INSERT INTO swarm_spawns (swarm, run_id, session_id, agent_type, prompt, task_id, tool_use_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      s.swarm,
      s.run_id ?? null,
      s.session_id ?? null,
      s.agent_type,
      s.prompt ?? null,
      s.task_id ?? null,
      s.tool_use_id ?? null,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  }

  spawnConsumeByToolUse(toolUseId: string): boolean {
    return (
      this.prep("UPDATE swarm_spawns SET consumed = 1 WHERE tool_use_id = ? AND consumed = 0").run(
        toolUseId,
      ).changes > 0
    );
  }

  spawnTake(agentType: string, sinceTs: number, sessionId?: string | null): SpawnRow | undefined {
    return this.immediate(() => {
      const r = this.prep(
        `SELECT * FROM swarm_spawns WHERE agent_type = ? AND consumed = 0 AND ts >= ?
           AND (? IS NULL OR session_id IS NULL OR session_id = ?)
         ORDER BY id LIMIT 1`,
      ).get(agentType, sinceTs, sessionId ?? null, sessionId ?? null) as Row | undefined;
      if (!r) return undefined;
      this.prep("UPDATE swarm_spawns SET consumed = 1 WHERE id = ?").run(r.id);
      return toSpawn({ ...r, consumed: 1 });
    });
  }

  spawnsPending(runId: string, sinceTs: number, agentType?: string): number {
    const r = this.prep(
      `SELECT COUNT(*) n FROM swarm_spawns
       WHERE run_id = ? AND consumed = 0 AND ts >= ? AND (? IS NULL OR agent_type = ?)`,
    ).get(runId, sinceTs, agentType ?? null, agentType ?? null) as { n: number };
    return r.n;
  }

  spawnsOpen(agentType: string, sinceTs: number, sessionId?: string | null): SpawnRow[] {
    return (
      this.prep(
        `SELECT * FROM swarm_spawns WHERE agent_type = ? AND consumed = 0 AND ts >= ?
           AND (? IS NULL OR session_id IS NULL OR session_id = ?)
         ORDER BY id`,
      ).all(agentType, sinceTs, sessionId ?? null, sessionId ?? null) as Row[]
    ).map(toSpawn);
  }

  spawnConsume(id: number): boolean {
    return (
      this.prep("UPDATE swarm_spawns SET consumed = 1 WHERE id = ? AND consumed = 0").run(id)
        .changes === 1
    );
  }

  spawnsVoid(runId: string): number {
    return this.prep("UPDATE swarm_spawns SET consumed = 1 WHERE run_id = ? AND consumed = 0").run(
      runId,
    ).changes;
  }

  spawnsPendingOfSwarm(swarm: string, sinceTs: number, agentType?: string): number {
    const r = this.prep(
      `SELECT COUNT(*) n FROM swarm_spawns
       WHERE swarm = ? AND consumed = 0 AND ts >= ? AND (? IS NULL OR agent_type = ?)`,
    ).get(swarm, sinceTs, agentType ?? null, agentType ?? null) as { n: number };
    return r.n;
  }

  liveWorkersOfSwarm(swarm: string, sinceTs: number): WorkerRow[] {
    return this.prep(
      `SELECT a.* FROM swarm_agents a JOIN swarm_runs r ON r.id = a.run_id
       WHERE r.swarm = ? AND a.status = 'running' AND a.last_ts >= ?`,
    ).all(swarm, sinceTs) as WorkerRow[];
  }

  tasksHeldBy(agentId: string): TaskRow[] {
    return (
      this.prep(
        "SELECT * FROM swarm_tasks WHERE agent_id = ? AND status = 'active' ORDER BY id",
      ).all(agentId) as Row[]
    ).map(toTask);
  }

  workersOfSession(sessionId: string): WorkerRow[] {
    return this.prep(
      "SELECT * FROM swarm_agents WHERE session_id = ? AND status = 'running' ORDER BY spawned_at",
    ).all(sessionId) as WorkerRow[];
  }

  eventsPrune(runId: string, keep: number): number {
    const cut = this.prep(
      "SELECT id FROM swarm_events WHERE run_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
    ).get(runId, Math.max(0, keep - 1)) as { id: number } | undefined;
    if (!cut) return 0;
    return this.prep("DELETE FROM swarm_events WHERE run_id = ? AND id < ?").run(runId, cut.id)
      .changes;
  }

  workerPing(runId: string, agentId: string): void {
    this.prep("UPDATE swarm_agents SET last_ts = ? WHERE run_id = ? AND agent_id = ?").run(
      Date.now(),
      runId,
      agentId,
    );
  }

  eventLast(runId: string): SwarmEventRow | undefined {
    const r = this.prep("SELECT * FROM swarm_events WHERE run_id = ? ORDER BY id DESC LIMIT 1").get(
      runId,
    ) as Row | undefined;
    return r ? toEvent(r) : undefined;
  }

  eventUpdate(
    id: number,
    patch: { ts?: number; text?: string | null; payload?: Record<string, unknown> | null },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.ts !== undefined) {
      sets.push("ts = ?");
      params.push(patch.ts);
    }
    if (patch.text !== undefined) {
      sets.push("text = ?");
      params.push(patch.text);
    }
    if (patch.payload !== undefined) {
      sets.push("payload = ?");
      params.push(patch.payload ? JSON.stringify(patch.payload) : null);
    }
    if (!sets.length) return;
    params.push(id);
    this.prep(`UPDATE swarm_events SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
}
