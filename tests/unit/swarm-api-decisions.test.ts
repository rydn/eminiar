/**
 * Swarm API decisions (task #141): runDetail carries `decisions` keyed by task id, and
 * /api/swarm/task returns {task, decision}. Real storage in a temp home, no network, no model.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { activeSwarmConfig, resetSwarmConfigCache } from "../../src/swarm/config.js";
import { addTasks, callerOf, startRun } from "../../src/swarm/runtime.js";
import { runDetail, swarmRoute } from "../../src/ui/swarm-api.js";

const YAML =
  "version: 1\nswarms:\n  one:\n    description: One\n    agents:\n      a:\n        description: A\n        prompt: P\n";

let root: string;
let home: string;
let runId = "";
let ids: number[] = [];

const ctx = () => getContext(root);
const get = (path: string, q: Record<string, string> = {}) =>
  swarmRoute(ctx(), {
    path,
    method: "GET",
    query: new URLSearchParams(q),
    body: async () => ({}),
  });
// biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON
type J = any;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-swdec-"));
  writeFileSync(join(root, "package.json"), '{"name":"swdec"}');
  mkdirSync(join(root, ".eminiar"), { recursive: true });
  writeFileSync(join(root, ".eminiar/swarm.yaml"), YAML);
  resetContextCache();
  resetSwarmConfigCache();

  const db = getStorage(ctx());
  const cfg = activeSwarmConfig(root)!;
  const run = startRun(db, cfg, { swarm: "one", goal: "g", sessionId: "S" });
  runId = run.id;
  const tasks = addTasks(db, ctx(), run, cfg.swarms[0]!, callerOf(cfg, {}), [
    { title: "advised and followed" },
    { title: "no decision at all" },
  ]);
  ids = tasks.map((t) => t.id);
  const base = {
    inputHash: "h",
    outcome: "pending" as const,
    final: false,
    runId,
    tier: "opus",
    effort: "high",
    complexity: 3,
    confidence: 0.9,
  };
  db.adjudicator.insert({
    ...base,
    ts: 1,
    surface: "plan",
    taskId: ids[0]!,
    scores: JSON.stringify({ s: 1, advisedPick: "sonnet" }),
  } as never);
  db.adjudicator.insert({
    ...base,
    ts: 2,
    surface: "agent",
    taskId: ids[0]!,
    modelRequested: "sonnet",
    scores: JSON.stringify({}),
  } as never);
});
afterAll(() => {
  closeAllStorage();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

describe("runDetail decisions", () => {
  it("has a decision for every task of the run, keyed by task id", () => {
    const run = getStorage(ctx()).swarm.runGet(runId)!;
    const d = runDetail(ctx(), run).decisions!;
    expect(Object.keys(d).map(Number).sort()).toEqual([...ids].sort());
    expect(d[ids[0]!]!.taskId).toBe(ids[0]);
    expect(d[ids[0]!]!.title).toBe("advised and followed");
  });

  it("an advised and dispatched task reports followed; an undecided one is none", () => {
    const run = getStorage(ctx()).swarm.runGet(runId)!;
    const d = runDetail(ctx(), run).decisions!;
    expect(d[ids[0]!]!.follow).toBe("followed");
    expect(d[ids[0]!]!.advice?.model).toBe("sonnet");
    expect(d[ids[1]!]!.follow).toBe("none");
    expect(d[ids[1]!]!.advice).toBeUndefined();
    expect(d[ids[1]!]!.ran).toBeUndefined();
  });

  it("survives a JSON round trip and an incremental tasksSince fetch", () => {
    const run = getStorage(ctx()).swarm.runGet(runId)!;
    const d = JSON.parse(JSON.stringify(runDetail(ctx(), run, { tasksSince: Date.now() + 1e9 })));
    // tasks are filtered, decisions still cover the whole run
    expect(d.tasks).toHaveLength(0);
    expect(Object.keys(d.decisions)).toHaveLength(2);
  });
});

describe("runDetail decisions hash (#158)", () => {
  it("omits the map when the client's hash matches, resends it when it does not", () => {
    const run = getStorage(ctx()).swarm.runGet(runId)!;
    const first = runDetail(ctx(), run);
    expect(first.decisionsUnchanged).toBe(false);
    expect(first.decisionsHash).toMatch(/^[0-9a-f]{16}$/);
    const same = runDetail(ctx(), run, { decisionsHash: first.decisionsHash });
    expect(same.decisionsUnchanged).toBe(true);
    expect(same.decisions).toBeUndefined();
    expect(same.decisionsHash).toBe(first.decisionsHash);
    const stale = runDetail(ctx(), run, { decisionsHash: "0000000000000000" });
    expect(stale.decisionsUnchanged).toBe(false);
    expect(Object.keys(stale.decisions ?? {})).toHaveLength(2);
  });

  it("the route passes decisionsHash through", async () => {
    const run = getStorage(ctx()).swarm.runGet(runId)!;
    const h = runDetail(ctx(), run).decisionsHash as string;
    const b = (await get("/api/swarm/run", { id: runId, decisionsHash: h })).body as J;
    expect(b.decisionsUnchanged).toBe(true);
    expect(b.decisions).toBeUndefined();
  });
});

describe("/api/swarm/task", () => {
  it("returns the task with its decision", async () => {
    const r = await get("/api/swarm/task", { id: String(ids[0]) });
    expect(r.status).toBe(200);
    const b = r.body as J;
    expect(b.task.id).toBe(ids[0]);
    expect(b.decision.taskId).toBe(ids[0]);
    expect(b.decision.follow).toBe("followed");
  });

  it("a task with no adjudication still gets a decision (follow none)", async () => {
    const b = (await get("/api/swarm/task", { id: String(ids[1]) })).body as J;
    expect(b.decision.follow).toBe("none");
    expect(b.decision.advice).toBeUndefined();
  });

  it("rejects a bad id with 400, an unknown task or a wrong run with 404", async () => {
    expect((await get("/api/swarm/task", { id: "abc" })).status).toBe(400);
    expect((await get("/api/swarm/task", { id: "999999" })).status).toBe(404);
    expect((await get("/api/swarm/task", { id: String(ids[0]), run: "other" })).status).toBe(404);
  });

  it("is GET only", async () => {
    const r = await swarmRoute(ctx(), {
      path: "/api/swarm/task",
      method: "POST",
      query: new URLSearchParams({ id: String(ids[0]) }),
      body: async () => ({}),
    });
    expect(r.status).toBe(405);
  });
});

describe("decisions hash, last (mutates rows) (#158)", () => {
  it("the hash moves when a decision changes", () => {
    const db = getStorage(ctx());
    const run = db.swarm.runGet(runId)!;
    const before = runDetail(ctx(), run).decisionsHash;
    const id = db.adjudicator.forTask(runId, ids[1]!).length;
    expect(id).toBe(0);
    db.adjudicator.insert({
      inputHash: "h2",
      outcome: "pending",
      final: false,
      runId,
      tier: "haiku",
      surface: "plan",
      taskId: ids[1]!,
      ts: 3,
      scores: JSON.stringify({ advisedPick: "haiku" }),
    } as never);
    expect(runDetail(ctx(), run).decisionsHash).not.toBe(before);
  });
});
