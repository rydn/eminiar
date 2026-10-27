import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { syncAgents } from "../../src/swarm/agents.js";
import { swarmCommand } from "../../src/swarm/cli.js";
import {
  activeSwarmConfig,
  parseSwarmYaml,
  resetSwarmConfigCache,
} from "../../src/swarm/config.js";
import { ago, capOutput, formatRunStatus, formatSync, watchStep } from "../../src/swarm/format.js";
import { type CallerStamp, resetSwarmSecret, signCaller } from "../../src/swarm/identity.js";
import {
  type RunSnapshot,
  recordActivity,
  registerWorker,
  runSnapshot,
  STALE_MS,
} from "../../src/swarm/runtime.js";
import type { SwarmEventRow } from "../../src/swarm/types.js";
import { emSwarm } from "../../src/tools/em_swarm.js";

const YAML = `
version: 1
swarms:
  feat:
    description: test swarm
    max_agents: 3
    agents:
      coder:
        description: writes code
        count: 2
      tester:
        description: tests code
  rev:
    description: review swarm
    agents:
      checker:
        description: checks things
`;

const SESSION = "sess-main-1";

/** Write a genuinely generated agent file (marker + hash) for a swarm the YAML no longer has. */
function plantGenerated(root: string): void {
  const r = parseSwarmYaml(
    "swarms:\n  old:\n    description: d\n    agents:\n      x: { description: x }\n",
    join(root, ".eminiar", "swarm.yaml"),
    ".eminiar/swarm.yaml",
  );
  if (r.state !== "ok") throw new Error("bad fixture");
  syncAgents(root, r.config);
}

function writeSwarm(root: string, body: string): void {
  mkdirSync(join(root, ".eminiar"), { recursive: true });
  writeFileSync(join(root, ".eminiar", "swarm.yaml"), body);
  resetSwarmConfigCache();
}

function project(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, "package.json"), "{}");
  return root;
}

const mainStamp = (sessionId = SESSION) => signCaller({ kind: "main", sessionId });
const agentStamp = (agentId: string, agentType: string, sessionId = SESSION) =>
  signCaller({ kind: "agent", agentId, agentType, sessionId });

describe("em_swarm tool", () => {
  let root: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;
  type Args = Parameters<typeof emSwarm.handler>[0];
  let main: CallerStamp;
  let coder: CallerStamp;
  let tester: CallerStamp;
  /** Call the tool as `as` (default: the coordinator of SESSION; null: no hook stamp). */
  const call = async (args: Args, as: CallerStamp | null = main) => {
    const r = await emSwarm.handler({ ...args, ...(as ?? {}) }, ctx);
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  const activeIds = () => db.swarm.runs({ status: "active", limit: 50 }).map((r) => r.id);
  const finishAll = async () => {
    for (const id of activeIds()) await call({ action: "finish", run: id, status: "cancelled" });
  };
  const register = (stamp: CallerStamp) =>
    registerWorker(db, activeSwarmConfig(root)!, {
      agentId: stamp.caller_agent_id!,
      agentType: stamp.caller_agent_type!,
      sessionId: SESSION,
    });

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-tool-"));
    resetSwarmSecret();
    main = mainStamp();
    coder = agentStamp("agent-c1aaaaaa", "swarm-feat-coder");
    tester = agentStamp("agent-t1bbbbbb", "swarm-feat-tester");
    root = project("em-swarm-tool-");
    resetContextCache();
    resetSwarmConfigCache();
    ctx = getContext(root);
    db = getStorage(ctx, { vectors: false });
  });
  afterAll(() => closeAllStorage());

  it("explains the opt-in when there is no swarm file", async () => {
    const r = await call({ action: "list" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/opt-in/);
    expect(r.text).toContain("eminiar swarm init");
    expect((await call({ action: "start", swarm: "feat", goal: "x" })).text).toMatch(/opt-in/);
  });

  it("sync with no file prunes generated agent files and keeps hand-written ones", async () => {
    const dir = join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    plantGenerated(root);
    writeFileSync(join(dir, "swarm-mine.md"), "---\nname: swarm-mine\n---\nhand-written");
    const r = await call({ action: "sync" });
    expect(r.text).toContain("deleted .claude/agents/swarm-old-x.md");
    expect(existsSync(join(dir, "swarm-old-x.md"))).toBe(false);
    expect(existsSync(join(dir, "swarm-mine.md"))).toBe(true);
  });

  it("lists validation issues with file, line and path", async () => {
    writeSwarm(
      root,
      `swarms:
  s:
    description: d
    max_agent: 3
    agents:
      a: { description: x }
`,
    );
    const r = await call({ action: "list" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/\.eminiar\/swarm\.yaml:\d+ swarms\.s/);
    // an invalid file must not prune the agent files a typo would otherwise wipe
    plantGenerated(root);
    expect((await call({ action: "sync" })).text).toMatch(/problem/);
    expect(existsSync(join(root, ".claude", "agents", "swarm-old-x.md"))).toBe(true);
  });

  it("lists swarms, roles and agent file state", async () => {
    writeSwarm(root, YAML);
    const r = await call({ action: "list" });
    expect(r.text).toContain("feat · hierarchical · up to 3 worker(s)");
    expect(r.text).toContain("coder → swarm-feat-coder · inherit · ×2 · not generated");
    expect(r.text).toContain("Left-over agent files: .claude/agents/swarm-old-x.md");
    expect(r.text).toContain("No active run.");
  });

  it("runs a whole swarm: start, plan, claim, update, post, read, status, finish", async () => {
    // a worker cannot start a run; SwarmError comes back as plain text, not an error result
    const denied = await call({ action: "start", swarm: "feat", goal: "g" }, coder);
    expect(denied.isError).toBe(false);
    expect(denied.text).toMatch(/^em_swarm: only the coordinator/);
    const unknown = await call({ action: "start", swarm: "nope", goal: "g" });
    expect(unknown.text).toMatch(/^em_swarm: unknown swarm "nope"/);
    expect((await call({ action: "status" })).text).toMatch(/No active run/);

    const start = await call({ action: "start", swarm: "feat", goal: "add a widget" });
    expect(start.text).toContain('subagent_type "swarm-feat-coder"');
    // warnings and sync notes lead, so a capped brief never loses them
    expect(start.text).toMatch(/^Agent files synced first/);
    expect(existsSync(join(root, ".claude", "agents", "swarm-feat-coder.md"))).toBe(true);
    const run = db.swarm.runActive("feat")!;
    expect(run.goal).toBe("add a widget");
    expect(run.session_id).toBe(SESSION);

    const plan = await call({
      action: "plan",
      tasks: [
        { key: "impl", title: "implement", role: "coder", files: ["src/w.ts"] },
        { title: "test it", role: "tester", deps: ["impl"] },
      ],
    });
    const [t1, t2] = db.swarm.tasks(run.id);
    const planLines = plan.text.split("\n");
    expect(planLines[0]).toBe(`Planned 2 task(s) in run ${run.id}; claimable now: #${t1!.id}.`);
    expect(planLines[1]).toMatch(/^Next: spawn one worker per claimable task/);
    expect(planLines[1]).toContain("coder → swarm-feat-coder, tester → swarm-feat-tester");
    expect(planLines).toContain(`#${t1!.id} implement (coder)`);
    expect(planLines).toContain(`#${t2!.id} test it (tester)`);
    expect((await call({ action: "plan", tasks: [{ title: "x", role: "ghost" }] })).text).toMatch(
      /^em_swarm: tasks\[0\]\.role "ghost"/,
    );

    // the hook registers workers at SubagentStart; claims are then attributed to them
    register(coder);
    register(tester);
    const nothing = await call({ action: "claim" }, tester);
    expect(nothing.text).toMatch(/^Nothing to claim in run .*waits on/);
    expect(nothing.text).not.toMatch(/\.\.$/);
    const claim = await call({ action: "claim" }, coder);
    expect(claim.text).toMatch(
      new RegExp(`^Claimed task #${t1!.id} \\(run ${run.id}\\)\\. Report it`),
    );
    expect(claim.text).toContain("implement");
    expect((await call({ action: "claim" }, coder)).text).toContain("You already hold");

    const stolen = await call({ action: "update", task: t1!.id, status: "done" }, tester);
    expect(stolen.isError).toBe(false);
    expect(stolen.text).toMatch(new RegExp(`^em_swarm: .*task #${t1!.id}`));
    expect(db.swarm.taskGet(t1!.id)?.status).toBe("active");
    const done = await call(
      { action: "update", task: `#${t1!.id}`, status: "done", result: "added src/w.ts" },
      coder,
    );
    expect(done.text).toContain(`Task #${t1!.id} is now done`);
    expect(done.text).toContain("Claim the next");

    expect(
      (await call({ action: "post", key: "design", value: "use a map" }, coder)).text,
    ).toContain('Posted "design" (v1');
    await call({ action: "post", key: "long", value: "x".repeat(2000) });
    expect((await call({ action: "read", key: "design" })).text).toContain("use a map");
    const board = await call({ action: "read" });
    // every key is named before any value
    const keysLine = board.text.split("\n")[0]!;
    expect(keysLine).toMatch(/^Blackboard of run .*\. Keys: /);
    expect(keysLine).toContain("long (v1, coordinator");
    expect(keysLine).toContain("design (v1, coder@c1aaaaaa");
    expect(board.text).toContain("## design");
    expect(board.text).toContain("more characters");
    expect((await call({ action: "read", key: "nope" })).text).toMatch(/No note "nope".*keys:/);

    // a worker resolves its own run even without naming it
    expect((await call({ action: "status" }, tester)).text).toContain(`Run ${run.id}`);
    const status = await call({ action: "status" });
    expect(status.text).toContain("Tasks (2): 1 pending · 1 done");
    expect(status.text).toContain(`#${t1!.id} implement (coder) · coder@c1aaaaaa — added src/w.ts`);
    expect(status.text).toContain("● running coder@c1aaaaaa");
    expect(status.text).toContain("Blackboard");
    expect(status.text).toContain("Recent events");
    expect(status.text.length).toBeLessThanOrEqual(6000);

    const workerFinish = await call({ action: "finish" }, coder);
    expect(workerFinish.text).toMatch(/^em_swarm: only the coordinator/);
    const fin = await call({
      action: "finish",
      status: "done",
      summary: "widget added",
      remember: true,
    });
    expect(fin.text).toMatch(/finished: done/);
    expect(fin.text).toContain("1 were still open");
    expect(fin.text).toContain("2 worker(s) still marked running were closed");
    const name = /Memory written: (\S+)/.exec(fin.text)?.[1];
    expect(name).toMatch(/^swarm\/run-/);
    expect(db.memoryGetByName(name!)?.content).toContain("Outcome: widget added");

    const after = await call({ action: "status" });
    expect(after.text).toMatch(/No active run/);
    expect(after.text).toContain(run.id);
    expect((await call({ action: "plan", run: run.id, tasks: [{ title: "late" }] })).text).toMatch(
      /^em_swarm: run .* is done/,
    );
  });

  it("refuses changes from calls eminiar's hook did not stamp", async () => {
    const all = {
      swarm: "feat",
      goal: "g",
      key: "k",
      value: "v",
      task: 1,
      status: "done" as const,
      tasks: [{ title: "x" }],
    };
    for (const action of [
      "start",
      "plan",
      "claim",
      "update",
      "post",
      "finish",
      "release",
      "sync",
    ] as const) {
      const r = await call({ action, ...all }, null);
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(
        new RegExp(`^em_swarm: ${action} was refused because the call carries no caller stamp`),
      );
      expect(r.text).toContain("eminiar upgrade");
    }
    // looking is still allowed, with a note saying why changes fail
    expect((await call({ action: "list" }, null)).text).toMatch(/^Note: this call was not stamped/);
    expect((await call({ action: "status" }, null)).text).toMatch(/No active run/);

    // a model that passes the caller fields itself cannot forge the coordinator …
    const forged = { caller_kind: "main", caller_sig: "ab".repeat(32) };
    const f = await call({ action: "start", swarm: "feat", goal: "g", ...forged }, null);
    expect(f.text).toMatch(/^em_swarm: start was refused because the caller stamp does not verify/);
    // … nor turn a real stamp into another worker's
    const swapped = { ...coder, caller_agent_type: "swarm-feat-tester" };
    expect((await call({ action: "claim" }, swapped)).text).toMatch(/does not verify/);
    expect(activeIds()).toEqual([]);
  });

  it("rejects unknown task keys instead of dropping them", async () => {
    // the schema keeps unknown keys (as the MCP server parses them) so the handler sees them
    const parsed = z
      .object(emSwarm.schema)
      .parse({ action: "plan", tasks: [{ title: "x", name: "y" }] });
    expect(parsed.tasks?.[0]).toHaveProperty("name", "y");
    await call({ action: "start", swarm: "feat", goal: "keys" });
    const bad = await call({
      action: "plan",
      tasks: [{ title: "ok" }, { title: "x", name: "oops", prio: 1 } as never],
    });
    expect(bad.text).toBe(
      "em_swarm: unknown key(s) tasks[1].name, tasks[1].prio; a task takes only key, title, detail, role, deps, files (put anything else in detail). Nothing was planned.",
    );
    expect(db.swarm.tasks(db.swarm.runActive("feat")!.id)).toHaveLength(0);
    await finishAll();
  });

  it("asks which run when several are active, and finds a task's run from its id", async () => {
    await call({ action: "start", swarm: "feat", goal: "run a" });
    const b = await call({ action: "start", swarm: "feat", goal: "run b" });
    const ra = db.swarm.runs({ status: "active" }).find((r) => r.goal === "run a")!;
    const rb = db.swarm.runs({ status: "active" }).find((r) => r.goal === "run b")!;
    expect(b.text).toMatch(/^Warning: swarm "feat" already had 1 active run\(s\) in this session/);
    expect(b.text).toContain(ra.id);

    for (const args of [
      { action: "plan", tasks: [{ title: "x" }] },
      { action: "finish", status: "cancelled" },
      { action: "release" },
      { action: "claim" },
      { action: "post", key: "k", value: "v" },
    ] as Args[]) {
      const r = await call(args);
      expect(r.text).toMatch(
        new RegExp(`^em_swarm: 2 runs are active in this session, so ${args.action} needs run: `),
      );
      expect(r.text).toContain(`${ra.id} (feat) "run a"`);
      expect(r.text).toContain(`${rb.id} (feat) "run b"`);
    }
    expect(activeIds()).toHaveLength(2);
    const st = await call({ action: "status" });
    expect(st.text).toMatch(/Also active: .*changes in this session need run/);

    await call({ action: "plan", run: ra.id, tasks: [{ title: "in a", role: "coder" }] });
    const ta = db.swarm.tasks(ra.id)[0]!;
    // task ids are global: no run needed to update or claim one
    const up = await call({ action: "update", task: ta.id, status: "blocked", result: "waiting" });
    expect(up.text).toContain(`Task #${ta.id} is now blocked. run ${ra.id}:`);
    const cl = await call({ action: "claim", task: ta.id });
    expect(cl.text).toBe(
      `em_swarm: cannot claim task #${ta.id}: it is blocked (task #${ta.id} is in run ${ra.id}, swarm "feat")`,
    );
    const wrong = await call({ action: "update", run: rb.id, task: ta.id, status: "done" });
    expect(wrong.text).toContain(`task #${ta.id} belongs to run ${ra.id}, not run ${rb.id}`);
    expect((await call({ action: "update", task: 99999, status: "done" })).text).toMatch(
      /^em_swarm: there is no task #99999/,
    );

    // another session's coordinator must name the run it means
    const other = mainStamp("sess-other-2");
    const far = await call({ action: "finish", status: "cancelled" }, other);
    expect(far.text).toMatch(
      /^em_swarm: no active run in this session; .* belong to another Claude Code session\. Pass run/,
    );
    expect((await call({ action: "status" }, other)).text).toMatch(/Also active: /);

    await call({ action: "finish", run: ra.id, status: "cancelled" });
    const fin = await call({ action: "finish", status: "cancelled" });
    expect(fin.text).toContain(`Run ${rb.id} (feat) finished: cancelled`);
  });

  it("flags tasks held by a quiet worker and releases them", async () => {
    await call({ action: "start", swarm: "feat", goal: "stale holder" });
    const run = db.swarm.runActive("feat", SESSION)!;
    await call({ action: "plan", tasks: [{ title: "slow work", role: "coder" }] });
    const t = db.swarm.tasks(run.id)[0]!;
    const quiet = agentStamp("agent-q1cccccc", "swarm-feat-coder");
    register(quiet);
    expect((await call({ action: "claim", task: t.id }, quiet)).text).toContain("Claimed");
    expect((await call({ action: "release" }, quiet)).text).toMatch(
      /^em_swarm: only the coordinator \(the main session\) can release workers/,
    );

    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + STALE_MS + 5 * 60_000);
    try {
      const st = await call({ action: "status" });
      expect(st.text).toContain(
        `#${t.id} slow work (coder) · coder@q1cccccc · ⚠ holder quiet 20m — release with em_swarm {action:"release", agent:"q1cccccc"} or update status:pending`,
      );
      expect(st.text).toMatch(/Next: 1 active task\(s\) are held by a worker that went quiet/);
      expect(st.text).toContain("1 held by a quiet worker");
      expect(st.text.indexOf("Next:")).toBeLessThan(st.text.indexOf("Tasks ("));
      const snap = runSnapshot(db, run);
      expect(snap.counts.staleHeld).toBe(1);
      // nothing moves until the coordinator acts: watch calls that idle
      expect(watchStep("prev", snap).line).toMatchObject({ type: "swarm.idle", stale_held: 1 });

      const rel = await call({ action: "release" });
      expect(rel.text).toMatch(
        new RegExp(
          `^Released 1 worker\\(s\\) of run ${run.id}: coder@q1cccccc \\(task #${t.id} back to pending\\)`,
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(db.swarm.taskGet(t.id)?.status).toBe("pending");
    expect((await call({ action: "release", agent: "zzz" })).text).toMatch(
      /^Nothing released in run .*: no running worker's id starts with "zzz"\. No worker of the run is running\./,
    );
    expect((await call({ action: "release", role: "ghost" })).text).toMatch(
      /^em_swarm: role "ghost" is not a role of swarm "feat"/,
    );
    await finishAll();
  });

  it("limits workers to task work and other subagents to list, status, read and post", async () => {
    await call({ action: "start", swarm: "feat", goal: "rights" });
    const run = db.swarm.runActive("feat", SESSION)!;
    register(coder);
    // a worker may plan follow-ups in any topology, but not run the run
    const follow = await call(
      { action: "plan", tasks: [{ title: "follow-up", role: "tester" }] },
      coder,
    );
    expect(follow.text).toMatch(/^Planned 1 task\(s\) in run /);
    expect(follow.text).toContain("Next: the coordinator spawns workers for these");
    expect((await call({ action: "sync", force: true }, coder)).text).toMatch(
      /^em_swarm: only the coordinator \(the main session\) can sync agent files/,
    );

    const explore = agentStamp("agent-e0000001", "Explore");
    for (const action of [
      "claim",
      "plan",
      "update",
      "finish",
      "release",
      "start",
      "sync",
    ] as const) {
      const r = await call(
        { action, swarm: "feat", goal: "g", task: 1, status: "done", tasks: [{ title: "x" }] },
        explore,
      );
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/^em_swarm: Explore is not a worker of a swarm/);
    }
    expect((await call({ action: "list" }, explore)).text).toContain("eminiar swarms");
    expect((await call({ action: "status" }, explore)).text).toContain(`Run ${run.id}`);
    expect((await call({ action: "post", key: "seen", value: "yes" }, explore)).text).toContain(
      `blackboard of run ${run.id}`,
    );
    expect((await call({ action: "read", key: "seen" }, explore)).text).toContain("yes");

    // a worker of another swarm cannot read this run
    const checker = agentStamp("agent-k0000001", "swarm-rev-checker");
    for (const action of ["read", "status"] as const)
      expect((await call({ action, run: run.id }, checker)).text).toMatch(
        new RegExp(
          `^em_swarm: you are a worker of swarm "rev", but run ${run.id} belongs to swarm "feat"`,
        ),
      );
    await finishAll();
  });

  it("maps a git worktree back to the main checkout", async () => {
    const gitdir = join(root, ".git", "worktrees", "wt1");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    const wt = mkdtempSync(join(tmpdir(), "em-swarm-wt-"));
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    const wtCtx = getContext(wt);
    expect(wtCtx.root).not.toBe(ctx.root);
    const r = await emSwarm.handler({ action: "list", ...main }, wtCtx);
    // the worktree has no swarm file of its own; the main checkout's swarms answer
    expect(r.content[0]!.text).toContain("feat · hierarchical");
    const runs = await swarmCommand(["runs"], wtCtx, { out: () => {}, err: () => {} });
    expect(runs).toBe(0);
  });

  it("says so when swarms are disabled, and sync then prunes", async () => {
    writeSwarm(root, `enabled: false\n${YAML}`);
    expect((await call({ action: "list" })).text).toMatch(/disabled/);
    const r = await call({ action: "sync" });
    expect(r.text).toContain("swarms are disabled");
    expect(existsSync(join(root, ".claude", "agents", "swarm-feat-coder.md"))).toBe(false);
    expect(existsSync(join(root, ".claude", "agents", "swarm-mine.md"))).toBe(true);
  });

  it("keeps the description short", () => {
    expect(emSwarm.description.length).toBeLessThan(500);
  });
});

describe("swarm format", () => {
  const snap = (over: Partial<RunSnapshot["run"]> = {}): RunSnapshot => ({
    run: {
      id: "20261028-abcdef",
      swarm: "feat",
      goal: "g",
      status: "active",
      topology: "hierarchical",
      session_id: null,
      created_at: Date.now() - 60_000,
      updated_at: Date.now(),
      ended_at: null,
      summary: null,
      ...over,
    },
    tasks: [],
    workers: [],
    holders: [],
    notes: [],
    events: [],
    counts: {
      tasks: { pending: 0, active: 0, done: 0, failed: 0, blocked: 0 },
      workers: { running: 0, done: 0, stale: 0 },
      toolCalls: 0,
      errors: 0,
      autoClosed: 0,
      staleHeld: 0,
    },
  });
  const ev = (id: number, kind: SwarmEventRow["kind"]): SwarmEventRow => ({
    id,
    run_id: "20261028-abcdef",
    ts: Date.now(),
    agent_id: "agent-c1aaaaaa",
    role: "coder",
    kind,
    task_id: 1,
    text: `${kind} ${id}`,
    payload: null,
  });

  it("prints n/a for unknown values instead of 0", () => {
    expect(ago(null)).toBe("n/a");
    expect(ago(0)).toBe("n/a");
    const s = snap();
    s.workers = [
      {
        run_id: s.run.id,
        agent_id: "agent-zzzz1111",
        agent_type: "swarm-feat-coder",
        role: "coder",
        status: "done",
        task_id: null,
        prompt: null,
        session_id: null,
        spawned_at: Date.now(),
        last_ts: Date.now(),
        ended_at: null,
        tool_calls: 0,
        errors: 0,
        last_tool: null,
        summary: null,
      },
    ];
    s.counts.workers.done = 1;
    const text = formatRunStatus(s);
    expect(text).toContain("last n/a · ended n/a");
    expect(text).toContain("No tasks yet");
  });

  it("emits a watch line only when something changed", () => {
    const first = watchStep(undefined, snap());
    expect(first.line?.type).toBe("swarm.snapshot");
    expect(watchStep(first.key, snap()).line).toBeUndefined();
    const busy = snap();
    busy.counts.tasks.active = 1;
    busy.counts.workers.running = 1;
    const changed = watchStep(first.key, busy);
    expect(changed.line?.type).toBe("swarm.changed");
    const idle = snap();
    idle.counts.tasks.done = 1;
    expect(watchStep(changed.key, idle).line?.type).toBe("swarm.idle");
    const fin = watchStep(changed.key, snap({ status: "done" }));
    expect(fin.line).toMatchObject({
      type: "swarm.finished",
      status: "done",
      run: "20261028-abcdef",
    });
    // the first line for a run that is already closed says so
    expect(watchStep(undefined, snap({ status: "cancelled" })).line?.type).toBe("swarm.finished");
  });

  it("never wakes the watcher for worker tool calls", () => {
    const busy = (events: SwarmEventRow[]) => {
      const s = snap();
      s.counts.tasks.active = 1;
      s.counts.workers.running = 1;
      s.events = events;
      return s;
    };
    const first = watchStep(undefined, busy([ev(1, "claim"), ev(2, "tool")]));
    expect(first.line?.last_event).toMatchObject({ id: 1, kind: "claim" });
    const tools = [
      ev(1, "claim"),
      ev(2, "tool"),
      ev(3, "tool_error"),
      ev(4, "tool"),
      ev(5, "spawn"),
    ];
    expect(watchStep(first.key, busy(tools)).line).toBeUndefined();
    const posted = watchStep(first.key, busy([...tools, ev(6, "post")]));
    expect(posted.line).toMatchObject({
      type: "swarm.changed",
      last_event: { id: 6, kind: "post" },
    });
    // the CLI passes the newest counting event it tracked across ticks
    expect(watchStep(posted.key, busy([ev(9, "tool")]), ev(6, "post")).line).toBeUndefined();
  });

  it("caps output and reports dry-run sync", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const capped = capOutput(long, 2000, "see more");
    expect(capped.length).toBeLessThanOrEqual(2000);
    expect(capped).toMatch(/more characters left out; see more$/);
    const dry = formatSync(
      {
        actions: [
          { agentType: "swarm-a-b", path: ".claude/agents/swarm-a-b.md", action: "create" },
        ],
        changed: 1,
        conflicts: 0,
      },
      { dryRun: true },
    );
    expect(dry).toContain("dry run");
    expect(dry).toContain("+ to create .claude/agents/swarm-a-b.md");
  });
});

describe("eminiar swarm CLI", () => {
  let root: string;
  let ctx: ProjectContext;
  const run = async (...args: string[]) => runIn(ctx, ...args);
  const runIn = async (c: ProjectContext, ...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await swarmCommand(
      args,
      c,
      { out: (s) => out.push(s), err: (s) => err.push(s) },
      { maxTicks: 2 },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const tool = (args: Parameters<typeof emSwarm.handler>[0]) =>
    emSwarm.handler({ ...args, ...mainStamp() }, ctx);

  beforeAll(() => {
    process.env.EMINIAR_HOME ??= mkdtempSync(join(tmpdir(), "em-home-cli-"));
    resetSwarmSecret();
    root = project("em-swarm-cli-");
    resetSwarmConfigCache();
    ctx = getContext(root);
  });
  afterAll(() => closeAllStorage());

  it("init writes the starter file once and generates the agents", async () => {
    expect((await run("validate")).code).toBe(1);
    const init = await run("init");
    expect(init.code).toBe(0);
    expect(init.out).toContain("wrote .eminiar/swarm.yaml (swarms: feature, review)");
    expect(existsSync(join(root, ".claude", "agents", "swarm-feature-coder.md"))).toBe(true);
    const again = await run("init");
    expect(again.code).toBe(1);
    expect(again.err).toContain("--force");
    expect((await run("init", "--force")).code).toBe(0);
    expect(readFileSync(join(root, ".eminiar", "swarm.yaml"), "utf8")).toContain("swarms:");
  });

  it("init --json and sync --json report conflicts and reasons like the text mode", async () => {
    const fresh = project("em-swarm-cli-fresh-");
    resetSwarmConfigCache();
    const c = getContext(fresh);
    const sync = await runIn(c, "sync", "--json");
    expect(sync.code).toBe(0);
    expect(JSON.parse(sync.out)).toMatchObject({
      reason: "no .eminiar/swarm.yaml: swarms are off",
    });
    mkdirSync(join(fresh, ".claude", "agents"), { recursive: true });
    writeFileSync(join(fresh, ".claude", "agents", "swarm-feature-coder.md"), "hand-written");
    const init = await runIn(c, "init", "--json");
    expect(init.code).toBe(1);
    expect(JSON.parse(init.out).sync.conflicts).toBe(1);
    writeSwarm(
      fresh,
      "swarms:\n  s:\n    description: d\n    bogus: 1\n    agents:\n      a: { description: x }\n",
    );
    const bad = await runIn(c, "sync", "--json");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out).reason).toMatch(/is invalid/);
    resetSwarmConfigCache();
  });

  it("validates with file:line messages", async () => {
    expect((await run("validate")).out).toMatch(/^ok: \.eminiar\/swarm\.yaml · 2 swarm\(s\)/);
    writeSwarm(
      root,
      "swarms:\n  s:\n    description: d\n    topology: star\n    agents:\n      a: { description: x }\n",
    );
    const bad = await run("validate");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^\.eminiar\/swarm\.yaml:4 swarms\.s\.topology: /);
    const js = await run("validate", "--json");
    expect(JSON.parse(js.out).state).toBe("invalid");
    writeSwarm(root, YAML);
  });

  it("syncs (dry run first), lists, and shows runs and status", async () => {
    const dry = await run("sync", "--dry-run");
    expect(dry.out).toContain("dry run");
    expect(existsSync(join(root, ".claude", "agents", "swarm-feature-coder.md"))).toBe(true);
    const sync = await run("sync");
    expect(sync.out).toContain("deleted .claude/agents/swarm-feature-coder.md");
    expect(existsSync(join(root, ".claude", "agents", "swarm-feat-coder.md"))).toBe(true);
    expect((await run("list")).out).toContain("coder → swarm-feat-coder");
    expect(JSON.parse((await run("list", "--json")).out).swarms[0].roles[0].subagent_type).toBe(
      "swarm-feat-coder",
    );
    expect((await run("runs")).out).toBe("No swarm runs yet.");
    expect((await run("status")).code).toBe(1);
    expect((await run("watch")).code).toBe(1);
    expect((await run("release")).code).toBe(1);
    expect((await run("bogus")).code).toBe(2);
    // a value option without its value is a usage error, not a silent default
    for (const args of [
      ["watch", "--interval"],
      ["runs", "--limit"],
      ["status", "--run"],
    ]) {
      const r = await run(...args);
      expect(r.code).toBe(2);
      expect(r.err).toBe(`${args[1]} needs a value`);
    }
  });

  it("watch prints one NDJSON line per change and exits when the run finishes", async () => {
    const r = await tool({ action: "start", swarm: "feat", goal: "watch me" });
    expect(r.isError).toBeFalsy();
    const db = getStorage(ctx, { vectors: false });
    const active = db.swarm.runActive("feat")!;
    // tool calls after the worker started are not what the watcher reports
    const cfg = activeSwarmConfig(root)!;
    registerWorker(db, cfg, {
      agentId: "agent-w1dddddd",
      agentType: "swarm-feat-coder",
      sessionId: SESSION,
    });
    for (let i = 0; i < 3; i++)
      recordActivity(db, cfg, root, {
        agentId: "agent-w1dddddd",
        agentType: "swarm-feat-coder",
        tool: "Read",
        input: { file_path: join(root, "package.json") },
      });
    const live = await run("watch", "--interval", "0.01");
    const lines = live.out.split("\n").filter(Boolean);
    // two ticks with no change in between: only the snapshot line
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: "swarm.snapshot",
      run: active.id,
      stale_held: 0,
      last_event: { kind: "start" },
    });

    expect((await run("status", active.id)).out).toContain(`Run ${active.id}`);
    expect((await run("runs", "--limit", "0")).code).toBe(2);
    const rel = await run("release");
    expect(rel.code).toBe(0);
    expect(rel.out).toMatch(
      /^Nothing released in run .*: no running worker has been quiet for 15 minutes/,
    );
    await tool({ action: "finish", status: "cancelled" });
    const fin = await run("watch", "--run", active.id);
    expect(fin.code).toBe(0);
    expect(JSON.parse(fin.out)).toMatchObject({ type: "swarm.finished", status: "cancelled" });
    expect(runSnapshot(db, db.swarm.runGet(active.id)!).run.status).toBe("cancelled");
  });

  it("status in the terminal prints every task, where the tool caps the text", async () => {
    await tool({ action: "start", swarm: "feat", goal: "many tasks" });
    const db = getStorage(ctx, { vectors: false });
    const active = db.swarm.runActive("feat")!;
    const tasks = Array.from({ length: 50 }, (_, i) => ({
      title: `task number ${i} ${"y".repeat(150)}`,
    }));
    await tool({ action: "plan", tasks });
    const capped = await tool({ action: "status" });
    const text = capped.content[0]!.text;
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain("… 38 more pending");
    const full = await run("status");
    expect(full.out).toContain("task number 49");
    expect(full.out).not.toContain("more pending");
    await tool({ action: "finish", run: active.id, status: "cancelled" });
  });
});
