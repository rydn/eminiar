import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { type RunSnapshot, registerWorker, runSnapshot } from "../../src/swarm/runtime.js";
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
`;

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

describe("em_swarm tool", () => {
  let root: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;
  type Args = Parameters<typeof emSwarm.handler>[0];
  const call = async (args: Args) => {
    const r = await emSwarm.handler(args, ctx);
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  const coder = { caller_agent_id: "agent-c1aaaaaa", caller_agent_type: "swarm-feat-coder" };
  const tester = { caller_agent_id: "agent-t1bbbbbb", caller_agent_type: "swarm-feat-tester" };

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-tool-"));
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
    const denied = await call({ action: "start", swarm: "feat", goal: "g", ...coder });
    expect(denied.isError).toBe(false);
    expect(denied.text).toMatch(/^em_swarm: only the coordinator/);
    const unknown = await call({ action: "start", swarm: "nope", goal: "g" });
    expect(unknown.text).toMatch(/^em_swarm: unknown swarm "nope"/);
    expect((await call({ action: "status" })).text).toMatch(/No active run/);

    const start = await call({ action: "start", swarm: "feat", goal: "add a widget" });
    expect(start.text).toContain('subagent_type "swarm-feat-coder"');
    expect(start.text).toContain("Agent files synced first");
    expect(existsSync(join(root, ".claude", "agents", "swarm-feat-coder.md"))).toBe(true);
    const run = db.swarm.runActive("feat")!;
    expect(run.goal).toBe("add a widget");

    const plan = await call({
      action: "plan",
      tasks: [
        { key: "impl", title: "implement", role: "coder", files: ["src/w.ts"] },
        { title: "test it", role: "tester", deps: ["impl"] },
      ],
    });
    expect(plan.text).toContain("Planned 2 task(s)");
    const [t1, t2] = db.swarm.tasks(run.id);
    expect(plan.text).toContain(`#${t2!.id} test it → tester (subagent_type "swarm-feat-tester")`);
    expect((await call({ action: "plan", tasks: [{ title: "x", role: "ghost" }] })).text).toMatch(
      /^em_swarm: tasks\[0\]\.role "ghost"/,
    );

    // the hook registers workers at SubagentStart; claims are then attributed to them
    const cfg = activeSwarmConfig(root)!;
    registerWorker(db, cfg, { agentId: coder.caller_agent_id, agentType: coder.caller_agent_type });
    registerWorker(db, cfg, {
      agentId: tester.caller_agent_id,
      agentType: tester.caller_agent_type,
    });
    const nothing = await call({ action: "claim", ...tester });
    expect(nothing.text).toMatch(/^Nothing to claim in run .*waits on/);
    const claim = await call({ action: "claim", ...coder });
    expect(claim.text).toContain(`Claimed task #${t1!.id}`);
    expect(claim.text).toContain("implement");
    expect((await call({ action: "claim", ...coder })).text).toContain("You already hold");

    const stolen = await call({ action: "update", task: t1!.id, status: "done", ...tester });
    expect(stolen.isError).toBe(false);
    expect(stolen.text).toMatch(new RegExp(`^em_swarm: .*task #${t1!.id}`));
    expect(db.swarm.taskGet(t1!.id)?.status).toBe("active");
    const done = await call({
      action: "update",
      task: `#${t1!.id}`,
      status: "done",
      result: "added src/w.ts",
      ...coder,
    });
    expect(done.text).toContain(`Task #${t1!.id} is now done`);
    expect(done.text).toContain("Claim the next");

    expect(
      (await call({ action: "post", key: "design", value: "use a map", ...coder })).text,
    ).toContain('Posted "design" (v1');
    await call({ action: "post", key: "long", value: "x".repeat(2000) });
    expect((await call({ action: "read", key: "design" })).text).toContain("use a map");
    const board = await call({ action: "read" });
    expect(board.text).toContain("## design");
    expect(board.text).toContain("more characters");
    expect((await call({ action: "read", key: "nope" })).text).toMatch(/No note "nope".*keys:/);

    // a worker resolves its own run even without naming it
    expect((await call({ action: "status", ...tester })).text).toContain(`Run ${run.id}`);
    const status = await call({ action: "status" });
    expect(status.text).toContain("Tasks (2): 1 pending · 1 done");
    expect(status.text).toContain(`#${t1!.id} implement (coder) · coder@c1aaaaaa — added src/w.ts`);
    expect(status.text).toContain("● running coder@c1aaaaaa");
    expect(status.text).toContain("Blackboard");
    expect(status.text).toContain("Recent events");
    expect(status.text.length).toBeLessThanOrEqual(6000);

    const workerFinish = await call({ action: "finish", ...coder });
    expect(workerFinish.text).toMatch(/^em_swarm: only the coordinator/);
    const fin = await call({
      action: "finish",
      status: "done",
      summary: "widget added",
      remember: true,
    });
    expect(fin.text).toMatch(/finished: done/);
    expect(fin.text).toContain("1 were still open");
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

  it("limits subagents that are not swarm workers to list, status, read and post", async () => {
    const explore = { caller_agent_id: "agent-e0000001", caller_agent_type: "Explore" };
    for (const action of ["claim", "plan", "update", "finish"] as const) {
      const r = await call({
        action,
        task: 1,
        status: "done",
        tasks: [{ title: "x" }],
        ...explore,
      });
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/^em_swarm: Explore is not a worker of a swarm/);
    }
    expect((await call({ action: "list", ...explore })).text).toContain("eminiar swarms");
    expect((await call({ action: "status", ...explore })).text).toMatch(/No active run|Run /);
  });

  it("maps a git worktree back to the main checkout", async () => {
    mkdirSync(join(root, ".git", "worktrees", "wt1"), { recursive: true });
    const wt = mkdtempSync(join(tmpdir(), "em-swarm-wt-"));
    writeFileSync(join(wt, ".git"), `gitdir: ${join(root, ".git", "worktrees", "wt1")}\n`);
    const wtCtx = getContext(wt);
    expect(wtCtx.root).not.toBe(ctx.root);
    const r = await emSwarm.handler({ action: "list" }, wtCtx);
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
  const run = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await swarmCommand(
      args,
      ctx,
      { out: (s) => out.push(s), err: (s) => err.push(s) },
      { maxTicks: 2 },
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  beforeAll(() => {
    process.env.EMINIAR_HOME ??= mkdtempSync(join(tmpdir(), "em-home-cli-"));
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
    expect((await run("bogus")).code).toBe(2);
  });

  it("watch prints one NDJSON line per change and exits when the run finishes", async () => {
    const r = await emSwarm.handler({ action: "start", swarm: "feat", goal: "watch me" }, ctx);
    expect(r.isError).toBeFalsy();
    const db = getStorage(ctx, { vectors: false });
    const active = db.swarm.runActive("feat")!;
    const live = await run("watch", "--interval", "0.01");
    const lines = live.out.split("\n").filter(Boolean);
    // two ticks with no change in between: only the snapshot line
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "swarm.snapshot", run: active.id });

    expect((await run("status", active.id)).out).toContain(`Run ${active.id}`);
    expect((await run("runs", "--limit", "0")).code).toBe(2);
    await emSwarm.handler({ action: "finish", status: "cancelled" }, ctx);
    const fin = await run("watch", "--run", active.id);
    expect(fin.code).toBe(0);
    expect(JSON.parse(fin.out)).toMatchObject({ type: "swarm.finished", status: "cancelled" });
    expect(runSnapshot(db, db.swarm.runGet(active.id)!).run.status).toBe("cancelled");
  });
});
