import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { activeSwarmConfig, resetSwarmConfigCache } from "../../src/swarm/config.js";
import {
  addTasks,
  callerOf,
  claimTask,
  closeWorker,
  postNote,
  recordActivity,
  registerWorker,
  reserveSpawn,
  startRun,
} from "../../src/swarm/runtime.js";
import type { SwarmEventRow } from "../../src/swarm/types.js";
import {
  busySegments,
  newestEvents,
  type runDetail,
  TASK_TEXT_MAX,
  TIMELINE_EVENTS_MAX,
} from "../../src/ui/swarm-api.js";

/** The run payload after a JSON round trip. */
type Detail = ReturnType<typeof runDetail>;

let port = 0;
let root: string;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

beforeAll(async () => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  process.env.EMINIAR_PLUGIN_ROOT = process.cwd();
  root = mkdtempSync(join(tmpdir(), "em-swarm-ui-"));
  writeFileSync(join(root, "package.json"), '{"name":"swarm-demo"}');
  resetContextCache();
  resetSwarmConfigCache();
  port = await freePort();
  const { serve } = await import("../../src/ui/server.js");
  void serve({ port, open: false, root });
  await new Promise((r) => setTimeout(r, 300));
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
  delete process.env.EMINIAR_PLUGIN_ROOT;
});

const get = async (p: string, init?: RequestInit) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: r.status, body: JSON.parse(await r.text()) as Record<string, unknown> };
};
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  get(p, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

type Overview = {
  state: string;
  enabled: boolean;
  file: string;
  issues: Array<{ path: string; message: string; line?: number }>;
  swarms: Array<{
    name: string;
    topology: string;
    roles: Array<{ role: string; model: string | null; file: { path: string; action: string } }>;
  }>;
  orphans: unknown[];
  syncNeeded: boolean;
  runs: Array<{ id: string; status: string; counts: { tasks: { total: number; done: number } } }>;
  starter?: string;
};

const yamlPath = () => join(root, ".eminiar", "swarm.yaml");
const agentFile = (name: string) => join(root, ".claude", "agents", `${name}.md`);

describe("swarm dashboard API", () => {
  let runId = "";

  it("shows the opt-in state when there is no swarm file", async () => {
    const r = await get("/api/swarm");
    expect(r.status).toBe(200);
    const o = r.body as unknown as Overview;
    expect(o.state).toBe("absent");
    expect(o.enabled).toBe(false);
    expect(o.file).toBe(".eminiar/swarm.yaml");
    expect(o.starter).toContain("swarms:");
    expect(o.swarms).toEqual([]);
    expect(o.runs).toEqual([]);
    // nothing to sync yet
    expect((await post("/api/swarm/sync", {})).status).toBe(409);
  });

  it("refuses writes without a JSON content type", async () => {
    const r = await get("/api/swarm/init", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(existsSync(yamlPath())).toBe(false);
    const cross = await post("/api/swarm/init", {}, { origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    expect(existsSync(yamlPath())).toBe(false);
  });

  it("creates the starter file once and generates the agent files", async () => {
    const r = await post("/api/swarm/init", {});
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(".eminiar/swarm.yaml");
    expect(existsSync(yamlPath())).toBe(true);
    expect(existsSync(agentFile("swarm-feature-coder"))).toBe(true);
    expect((r.body.sync as { changed: number }).changed).toBeGreaterThan(0);

    const again = await post("/api/swarm/init", {});
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toMatch(/already exists/);

    const o = (await get("/api/swarm")).body as unknown as Overview;
    expect(o.state).toBe("ok");
    expect(o.enabled).toBe(true);
    expect(o.syncNeeded).toBe(false);
    expect(o.swarms.map((s) => s.name)).toEqual(["feature", "review"]);
    const coder = o.swarms[0]!.roles.find((x) => x.role === "coder")!;
    expect(coder.file).toEqual({
      path: ".claude/agents/swarm-feature-coder.md",
      action: "unchanged",
    });
    expect(coder.model).toBe("sonnet");
    expect((await get("/api/swarm/init")).status).toBe(405);
  });

  it("reports a missing agent file and syncs it back", async () => {
    unlinkSync(agentFile("swarm-feature-tester"));
    const o = (await get("/api/swarm")).body as unknown as Overview;
    expect(o.syncNeeded).toBe(true);
    expect(o.swarms[0]!.roles.find((x) => x.role === "tester")!.file.action).toBe("create");
    const s = await post("/api/swarm/sync", {});
    expect(s.status).toBe(200);
    expect(s.body.changed).toBe(1);
    expect(existsSync(agentFile("swarm-feature-tester"))).toBe(true);
    expect(((await get("/api/swarm")).body as unknown as Overview).syncNeeded).toBe(false);
  });

  it("serves a run snapshot with derived worker status and a timeline", async () => {
    const ctx = getContext(root);
    const db = getStorage(ctx);
    const cfg = activeSwarmConfig(root)!;
    const swarm = cfg.swarms[0]!;
    const run = startRun(db, cfg, { swarm: "feature", goal: "ship the widget", sessionId: "S1" });
    runId = run.id;
    const [impl] = addTasks(db, ctx, run, swarm, callerOf(cfg, {}), [
      { key: "impl", title: "implement widget", role: "coder", files: ["src/w.ts"] },
      { title: "test widget", role: "tester", deps: ["impl"] },
    ]);
    expect(
      reserveSpawn(db, cfg, {
        agentType: "swarm-feature-coder",
        prompt: `Work on task #${impl!.id}`,
        sessionId: "S1",
      })?.decision,
    ).toBe("allow");
    registerWorker(db, cfg, {
      agentId: "agent-c0ffee01",
      agentType: "swarm-feature-coder",
      sessionId: "S1",
    });
    // no hand-over at start: the worker claims the task its prompt names
    claimTask(
      db,
      run,
      swarm,
      callerOf(cfg, { agentId: "agent-c0ffee01", agentType: "swarm-feature-coder" }),
      impl!.id,
    );
    for (const [tool, input] of [
      ["Read", { file_path: join(root, "src/w.ts") }],
      ["Edit", { file_path: join(root, "src/w.ts") }],
      ["Bash", { command: "npm test" }],
    ] as const)
      recordActivity(db, cfg, root, {
        agentId: "agent-c0ffee01",
        agentType: "swarm-feature-coder",
        tool,
        input,
      });
    postNote(
      db,
      run,
      callerOf(cfg, { agentId: "agent-c0ffee01", agentType: "swarm-feature-coder" }),
      "design",
      "use a map",
    );
    registerWorker(db, cfg, { agentId: "agent-7e57e501", agentType: "swarm-feature-tester" });
    closeWorker(db, cfg, {
      agentId: "agent-7e57e501",
      agentType: "swarm-feature-tester",
      message: "nothing to test yet",
    });

    const o = (await get("/api/swarm")).body as unknown as Overview;
    expect(o.runs[0]?.id).toBe(run.id);
    expect(o.runs[0]?.counts.tasks).toMatchObject({ total: 2, active: 1, pending: 1 });

    expect((await get("/api/swarm/run")).status).toBe(400);
    expect((await get("/api/swarm/run?id=../../etc")).status).toBe(400);
    const missing = await get("/api/swarm/run?id=20991231-abcdef");
    expect(missing.status).toBe(404);
    expect(missing.body.error).not.toBe("not found");

    const r = await get(`/api/swarm/run?id=${run.id}`);
    expect(r.status).toBe(200);
    const d = r.body as unknown as Detail;
    expect(d.run.id).toBe(run.id);
    expect(d.tasks.map((t) => t.title)).toEqual(["implement widget", "test widget"]);
    const coder = d.workers.find((w) => w.role === "coder");
    expect(coder).toMatchObject({ status: "running", task_id: impl!.id, tool_calls: 3 });
    expect(d.workers.find((w) => w.role === "tester")?.status).toBe("done");
    expect(d.notes[0]).toMatchObject({ key: "design", version: 1 });
    expect(d.counts.toolCalls).toBe(3);
    expect(d.roles).toEqual(["architect", "coder", "tester", "reviewer"]);
    expect(d.configured).toBe(true);
    expect(d.maxAgents).toBe(4);
    expect(d.lastEventId).toBe(d.events[d.events.length - 1]?.id);
    const tl = d.timeline.workers.find((w) => w.agent_id === "agent-c0ffee01");
    expect(tl?.segments).toHaveLength(1);
    expect(tl?.segments[0]).toMatchObject({ open: true, errors: 0 });
    expect(tl?.segments[0]?.io).toMatchObject({ read: 1, write: 1, exec: 1 });
    const tools = d.events.filter((e) => e.kind === "tool");
    expect(tools.map((e) => e.payload?.io)).toEqual(["read", "write", "exec"]);
  });

  it("pages events after an id, oldest first", async () => {
    const all = await get(`/api/swarm/events?id=${runId}&after=0`);
    expect(all.status).toBe(200);
    const events = all.body.events as SwarmEventRow[];
    expect(events.length).toBeGreaterThan(5);
    const ids = events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(all.body.last).toBe(ids[ids.length - 1]);
    expect(all.body.more).toBe(false);
    expect((all.body.run as { status: string }).status).toBe("active");

    const mid = ids[2]!;
    const rest = await get(`/api/swarm/events?id=${runId}&after=${mid}`);
    expect((rest.body.events as SwarmEventRow[]).map((e) => e.id)).toEqual(ids.slice(3));
    const none = await get(`/api/swarm/events?id=${runId}&after=${all.body.last}`);
    expect(none.body.events).toEqual([]);
    expect(none.body.last).toBe(all.body.last);

    expect((await get(`/api/swarm/events?id=${runId}&after=-1`)).status).toBe(400);
    expect((await get(`/api/swarm/events?id=${runId}&after=abc`)).status).toBe(400);
    expect((await get("/api/swarm/events?id=nope")).status).toBe(400);
    expect((await get("/api/swarm/events?id=20991231-abcdef")).status).toBe(404);
  });

  it("finishes a run as the coordinator, once", async () => {
    expect((await post("/api/swarm/finish", { id: "bad id", status: "done" })).status).toBe(400);
    expect(
      (await post("/api/swarm/finish", { id: "20991231-abcdef", status: "done" })).status,
    ).toBe(404);
    expect((await post("/api/swarm/finish", { id: runId, status: "active" })).status).toBe(400);
    expect(
      (await post("/api/swarm/finish", { id: runId, status: "done", summary: 3 })).status,
    ).toBe(400);
    const done = await post("/api/swarm/finish", {
      id: runId,
      status: "done",
      summary: "widget shipped",
    });
    expect(done.status).toBe(200);
    expect(done.body.run).toMatchObject({ id: runId, status: "done", summary: "widget shipped" });
    expect(done.body.memory).toBeNull();
    const again = await post("/api/swarm/finish", { id: runId, status: "failed" });
    expect(again.status).toBe(409);

    const d = (await get(`/api/swarm/run?id=${runId}`)).body as unknown as Detail;
    expect(d.run.status).toBe("done");
    expect(d.events[d.events.length - 1]?.kind).toBe("run_finish");
    // a finished run's timeline no longer runs to now
    const tl = d.timeline.workers.find((w) => w.agent_id === "agent-c0ffee01");
    expect(tl?.segments[0]?.open).toBeUndefined();
  });

  it("shows a disabled config read-only and an invalid one with line numbers", async () => {
    const text = readFileSync(yamlPath(), "utf8");
    writeFileSync(yamlPath(), text.replace("enabled: true", "enabled: false"));
    const off = (await get("/api/swarm")).body as unknown as Overview;
    expect(off.state).toBe("ok");
    expect(off.enabled).toBe(false);
    // the generated files are still there and a sync would remove them
    expect(off.swarms[0]!.roles[0]!.file.action).toBe("delete");
    expect(off.syncNeeded).toBe(true);

    writeFileSync(yamlPath(), "version: 1\nswarms:\n  feature:\n    topology: star\n");
    const bad = (await get("/api/swarm")).body as unknown as Overview;
    expect(bad.state).toBe("invalid");
    expect(bad.issues.length).toBeGreaterThan(0);
    expect(bad.issues.some((i) => typeof i.line === "number")).toBe(true);
    expect(bad.runs[0]?.id).toBe(runId);
    expect((await post("/api/swarm/sync", {})).status).toBe(400);
    rmSync(yamlPath());
  });

  // The runs below go straight into the ledger: the swarm file is gone by now, and the
  // dashboard must work from the ledger alone.
  const ledger = () => getStorage(getContext(root));
  let seq = 0;
  const newRun = (goal: string) =>
    ledger().swarm.runCreate({
      id: `20261028-${(0xa00000 + ++seq).toString(16)}`,
      swarm: "feature",
      goal,
      topology: "hierarchical",
    });

  it("reports a memory that could not be written when finishing with remember", async () => {
    const run = newRun("finish with a broken memories dir");
    // A file where the memory's folder should be: the run closes, the memory write fails.
    const blocker = join(root, ".eminiar", "memories", "swarm");
    mkdirSync(join(root, ".eminiar", "memories"), { recursive: true });
    writeFileSync(blocker, "not a folder");
    try {
      const r = await post("/api/swarm/finish", { id: run.id, status: "done", remember: true });
      expect(r.status).toBe(200);
      expect(r.body.run).toMatchObject({ id: run.id, status: "done" });
      expect(r.body.memory).toBeNull();
      expect(typeof r.body.memoryError).toBe("string");
      expect(String(r.body.memoryError).length).toBeGreaterThan(0);
    } finally {
      rmSync(blocker);
    }
    const ok = await post("/api/swarm/finish", {
      id: newRun("finish and remember").id,
      status: "done",
      remember: true,
    });
    expect(ok.status).toBe(200);
    expect(String(ok.body.memory)).toMatch(/^swarm\/run-/);
    expect(ok.body.memoryError).toBeNull();
  });

  it("releases a stuck worker as the coordinator", async () => {
    const db = ledger().swarm;
    const run = newRun("a worker never stopped");
    const agent = "agent-57a1e001";
    db.workerUpsert({
      run_id: run.id,
      agent_id: agent,
      agent_type: "swarm-feature-coder",
      role: "coder",
    });
    expect((await post("/api/swarm/release", { id: run.id })).status).toBe(400);
    expect((await get(`/api/swarm/release?id=${run.id}&agent=${agent}`)).status).toBe(405);
    const r = await post("/api/swarm/release", { id: run.id, agent });
    expect(r.status).toBe(200);
    expect(r.body.released).toEqual([agent]);
    expect(db.workerGet(run.id, agent)?.status).toBe("done");
    expect((await post("/api/swarm/release", { id: run.id, agent })).status).toBe(404);
    db.runUpdate(run.id, { status: "done", ended_at: Date.now() });
    expect((await post("/api/swarm/release", { id: run.id, agent })).status).toBe(409);
  });

  it("lists active runs first whatever the limit, and says when older runs are left out", async () => {
    const db = ledger().swarm;
    const oldActive = newRun("an old run still active");
    for (let i = 0; i < 12; i++) {
      const r = newRun(`finished ${i}`);
      db.runUpdate(r.id, { status: "done", ended_at: Date.now() });
    }
    const newActive = newRun("the newest active run");
    const all = db.runs({ limit: 500 });

    const five = (await get("/api/swarm?limit=5")).body as unknown as Overview & {
      runsMore: boolean;
      runsLimit: number;
    };
    expect(five.runs).toHaveLength(5);
    expect(five.runs.slice(0, 2).map((r) => r.id)).toEqual([newActive.id, oldActive.id]);
    expect(five.runs.slice(2).every((r) => r.status !== "active")).toBe(true);
    // the newest finished runs, newest first
    expect(five.runs.slice(2).map((r) => r.id)).toEqual(
      all
        .filter((r) => r.status !== "active")
        .slice(0, 3)
        .map((r) => r.id),
    );
    expect(five.runsMore).toBe(true);
    expect(five.runsLimit).toBe(5);

    // a limit below the active count still lists every active run
    const one = (await get("/api/swarm?limit=1")).body as unknown as Overview & {
      runsMore: boolean;
    };
    expect(one.runs.map((r) => r.id)).toEqual([newActive.id, oldActive.id]);
    expect(one.runsMore).toBe(true);

    const every = (await get("/api/swarm?limit=500")).body as unknown as Overview & {
      runsMore: boolean;
    };
    expect(every.runs).toHaveLength(all.length);
    expect(every.runsMore).toBe(false);
    // the default page
    expect(((await get("/api/swarm")).body as { runsLimit: number }).runsLimit).toBe(30);
    for (const r of [oldActive, newActive])
      db.runUpdate(r.id, { status: "cancelled", ended_at: Date.now() });
  });

  it("draws the timeline from the newest events of a long run and cuts the oldest", async () => {
    const db = ledger().swarm;
    const run = newRun("a long run");
    const other = newRun("a run whose events interleave");
    for (const [agent, role] of [
      ["agent-ea41e001", "architect"],
      ["agent-1a7e0002", "coder"],
    ] as const)
      db.workerUpsert({
        run_id: run.id,
        agent_id: agent,
        agent_type: `swarm-feature-${role}`,
        role,
      });
    const t0 = Date.now() - 3_600_000;
    const early = 600;
    const late = TIMELINE_EVENTS_MAX + 500;
    let newest = 0;
    db.immediate(() => {
      for (let i = 0; i < early; i++)
        db.eventAdd({
          run_id: run.id,
          kind: "tool",
          agent_id: "agent-ea41e001",
          role: "architect",
          ts: t0 + i,
          payload: { tool: "Read", io: "read" },
        });
      for (let i = 0; i < late; i++) {
        newest = db.eventAdd({
          run_id: run.id,
          kind: "tool",
          agent_id: "agent-1a7e0002",
          role: "coder",
          ts: t0 + 1_000_000 + i,
          payload: { tool: "Edit", io: "write" },
        });
        // another run writing at the same time: the run's ids are not contiguous
        if (i % 3 === 0) db.eventAdd({ run_id: other.id, kind: "tool", ts: t0 + 1_000_000 + i });
      }
    });
    const d = (await get(`/api/swarm/run?id=${run.id}`)).body as unknown as Detail;
    expect(d.timeline.cut).toBe(true);
    expect(d.lastEventId).toBe(newest);
    const byAgent = (a: string) => d.timeline.workers.find((w) => w.agent_id === a)!;
    // the oldest events (the early worker's and the first late ones) are the ones cut
    expect(byAgent("agent-ea41e001").segments).toEqual([]);
    const segs = byAgent("agent-1a7e0002").segments;
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      n: TIMELINE_EVENTS_MAX,
      start: t0 + 1_000_000 + 500,
      end: t0 + 1_000_000 + late - 1,
    });
    expect(d.timeline.from).toBe(t0 + 1_000_000 + 500);
    for (const r of [run, other]) db.runUpdate(r.id, { status: "done", ended_at: Date.now() });
  });

  it("cuts long task text in a snapshot, serves the whole task and sends task deltas", async () => {
    const db = ledger().swarm;
    const run = newRun("task text");
    const long = "y".repeat(TASK_TEXT_MAX + 200);
    const t = db.taskAdd({ run_id: run.id, title: "long one", detail: long, created_by: "test" });
    db.taskAdd({ run_id: run.id, title: "short one", detail: "short", created_by: "test" });
    const d = (await get(`/api/swarm/run?id=${run.id}`)).body as unknown as Detail;
    const cut = d.tasks.find((x) => x.id === t.id)!;
    expect(cut.detail).toHaveLength(TASK_TEXT_MAX);
    expect(cut.clipped).toBe(true);
    expect(d.tasks.find((x) => x.title === "short one")?.clipped).toBeUndefined();
    expect(d.taskCount).toBe(2);
    expect(d.tasksPartial).toBe(false);

    const full = await get(`/api/swarm/task?id=${t.id}&run=${run.id}`);
    expect(full.status).toBe(200);
    expect((full.body.task as { detail: string }).detail).toBe(long);
    expect((await get(`/api/swarm/task?id=${t.id}&run=20991231-abcdef`)).status).toBe(404);
    expect((await get("/api/swarm/task?id=x")).status).toBe(400);
    expect((await get("/api/swarm/task?id=999999999")).status).toBe(404);

    // nothing changed since: an empty delta, and no events with events=0
    const later = Date.now() + 60_000;
    const none = (await get(`/api/swarm/run?id=${run.id}&tasksSince=${later}&events=0`))
      .body as unknown as Detail;
    expect(none.tasks).toEqual([]);
    expect(none.tasksPartial).toBe(true);
    expect(none.taskCount).toBe(2);
    expect(none.events).toEqual([]);
    expect((await get(`/api/swarm/run?id=${run.id}&tasksSince=-1`)).status).toBe(400);
    db.runUpdate(run.id, { status: "done", ended_at: Date.now() });
  });
});

describe("newestEvents", () => {
  it("returns the newest events in order, however the run's ids interleave", () => {
    const db = getStorage(getContext(root)).swarm;
    const ids = ["20261028-b00001", "20261028-b00002"];
    for (const id of ids) db.runCreate({ id, swarm: "x", goal: id, topology: "mesh" });
    const [p, q] = ids as [string, string];
    db.immediate(() => {
      // dense at first, then sparse: the newest page alone misjudges the older density
      for (let i = 0; i < 8000; i++) db.eventAdd({ run_id: p, kind: "tool", text: `d${i}` });
      for (let i = 0; i < 1000; i++) {
        db.eventAdd({ run_id: p, kind: "tool", text: `s${i}` });
        for (let k = 0; k < 20; k++) db.eventAdd({ run_id: q, kind: "tool" });
      }
    });
    const every: number[] = [];
    for (let after = 0; ; ) {
      const page = db.events(p, { after, limit: 1000 });
      every.push(...page.map((e) => e.id));
      if (page.length < 1000) break;
      after = page[page.length - 1]!.id;
    }
    expect(every).toHaveLength(9000);
    const store = getStorage(getContext(root));
    for (const max of [500, 1000, 1500, 3000, 8999]) {
      const r = newestEvents(store, p, max);
      expect(r.events.map((e) => e.id)).toEqual(every.slice(-max));
      expect(r.cut).toBe(true);
    }
    for (const max of [9000, 20_000]) {
      const r = newestEvents(store, p, max);
      expect(r.events.map((e) => e.id)).toEqual(every);
      expect(r.cut).toBe(false);
    }
    expect(newestEvents(store, "20261028-b00009", 100)).toEqual({ events: [], cut: false });
  });
});

describe("busySegments", () => {
  const ev = (id: number, ts: number, kind: SwarmEventRow["kind"] = "tool", io = "read") =>
    ({
      id,
      run_id: "r",
      ts,
      agent_id: "a",
      role: "coder",
      kind,
      task_id: null,
      text: null,
      payload: kind === "tool" || kind === "tool_error" ? { tool: "Read", io } : null,
    }) as SwarmEventRow;

  it("merges events closer than the gap and splits at longer pauses", () => {
    const t = 1_000_000;
    const segs = busySegments([
      ev(1, t, "start"),
      ev(2, t + 10_000),
      ev(3, t + 50_000, "tool", "write"),
      ev(4, t + 200_000, "tool_error", "exec"),
      ev(5, t + 230_000, "claim"),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: t, end: t + 50_000, n: 3, errors: 0 });
    expect(segs[0]!.io).toMatchObject({ read: 1, write: 1 });
    expect(segs[1]).toMatchObject({ start: t + 200_000, end: t + 230_000, n: 2, errors: 1 });
    expect(segs[1]!.io).toMatchObject({ exec: 1, swarm: 1 });
  });

  it("keeps a running worker's last segment open to now, within the gap only", () => {
    const t = 5_000_000;
    expect(busySegments([ev(1, t)], { running: true, now: t + 30_000 })[0]).toMatchObject({
      end: t + 30_000,
      open: true,
    });
    expect(busySegments([ev(1, t)], { running: true, now: t + 120_000 })[0]!.open).toBeUndefined();
    expect(busySegments([])).toEqual([]);
  });
});
