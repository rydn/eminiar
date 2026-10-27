import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { getContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { planAgentSync, renderAgentFile, syncAgents, workerTools } from "../../src/swarm/agents.js";
import { coordinatorBrief, taskBrief, workerBrief } from "../../src/swarm/brief.js";
import {
  activeSwarmConfig,
  findRole,
  loadSwarmConfig,
  parseSwarmYaml,
  resetSwarmConfigCache,
  STARTER_YAML,
} from "../../src/swarm/config.js";
import { globMatch, inScope } from "../../src/swarm/glob.js";
import {
  addTasks,
  callerOf,
  claimTask,
  closeWorker,
  finishRun,
  postNote,
  recordActivity,
  registerWorker,
  reserveSpawn,
  runSnapshot,
  STALE_MS,
  SwarmError,
  startRun,
  taskRef,
  toolHead,
  updateTask,
} from "../../src/swarm/runtime.js";
import type { SwarmConfig } from "../../src/swarm/types.js";

const parse = (yaml: string) =>
  parseSwarmYaml(yaml, "/x/.eminiar/swarm.yaml", ".eminiar/swarm.yaml");
const ok = (yaml: string): SwarmConfig => {
  const r = parse(yaml);
  if (r.state !== "ok") throw new Error(JSON.stringify(r));
  return r.config;
};

const BASIC = `
version: 1
swarms:
  feat:
    description: test swarm
    max_agents: 3
    agents:
      coder:
        description: writes code
        count: 2
        tools: [Read, Edit]
        scope: ["src/**"]
        memory_tags: [decision]
      tester:
        description: tests code
  line:
    description: pipeline swarm
    topology: pipeline
    stages: [plan, build, check]
    agents:
      plan: { description: plans }
      build: { description: builds }
      check: { description: checks }
  peers:
    description: mesh swarm
    topology: mesh
    agents:
      a: { description: peer a }
      b: { description: peer b }
`;

describe("swarm config", () => {
  it("parses the starter file", () => {
    const c = ok(STARTER_YAML);
    expect(c.swarms.map((s) => s.name)).toEqual(["feature", "review"]);
    const coder = findRole(c, "swarm-feature-coder");
    expect(coder?.role.count).toBe(2);
    expect(coder?.role.model).toBe("sonnet");
    expect(findRole(c, "swarm-feature-architect")?.role.model).toBe("opus");
    expect(c.swarms[1]!.topology).toBe("mesh");
  });

  it("resolves defaults, context layering and pipeline stages", () => {
    const c = ok(`
defaults:
  model: haiku
  context: { memories: 1, max_chars: 1000 }
swarms:
  s:
    description: d
    topology: pipeline
    context: { docs: 0 }
    agents:
      x: { description: dx, context: { history: false } }
      y: { description: dy, model: opus }
`);
    const s = c.swarms[0]!;
    expect(s.stages).toEqual(["x", "y"]);
    expect(s.roles[0]!.model).toBe("haiku");
    expect(s.roles[1]!.model).toBe("opus");
    expect(s.roles[0]!.context).toMatchObject({
      memories: 1,
      docs: 0,
      history: false,
      maxChars: 1000,
    });
    expect(c.enabled).toBe(true);
    expect(c.sync).toBe("auto");
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports typos, bad names and bad stages with paths and lines", () => {
    const r = parse(`swarms:
  s:
    description: d
    max_agent: 3
    agents:
      Bad_Name: { description: x }
`);
    expect(r.state).toBe("invalid");
    if (r.state !== "invalid") return;
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("swarms.s");
    expect(r.issues.some((i) => i.path.startsWith("swarms.s.agents") && i.line === 6)).toBe(true);

    const st = parse(`swarms:
  s:
    description: d
    topology: pipeline
    stages: [a, nope, a]
    agents:
      a: { description: x }
`);
    expect(st.state).toBe("invalid");
    if (st.state === "invalid") {
      expect(st.issues.map((i) => i.path)).toContain("swarms.s.stages.1");
      expect(st.issues.some((i) => /only once/.test(i.message))).toBe(true);
    }
  });

  it("rejects agent-name collisions and over-long names", () => {
    const r = parse(`swarms:
  a-b:
    description: d
    agents:
      c: { description: x }
  a:
    description: d
    agents:
      b-c: { description: x }
`);
    expect(r.state).toBe("invalid");
    if (r.state === "invalid") expect(r.issues[0]!.message).toMatch(/also produced by/);
    const long = parse(`swarms:
  ${"s".repeat(32)}:
    description: d
    agents:
      ${"r".repeat(32)}: { description: x }
`);
    expect(long.state).toBe("invalid");
  });

  it("rejects malformed hooks, unsafe scopes and YAML syntax errors", () => {
    expect(
      parse(`swarms:
  s:
    description: d
    agents:
      a:
        description: x
        hooks: { SessionStart: [] }
`).state,
    ).toBe("invalid");
    expect(
      parse(`swarms:
  s:
    description: d
    agents:
      a: { description: x, scope: ["../etc/**"] }
`).state,
    ).toBe("invalid");
    const syn = parse("swarms: [unclosed");
    expect(syn.state).toBe("invalid");
    if (syn.state === "invalid") expect(syn.issues[0]!.line).toBe(1);
    expect(parse("").state).toBe("invalid");
    expect(parse("swarms: {}").state).toBe("invalid");
  });
});

describe("swarm globs", () => {
  it("matches scopes", () => {
    expect(inScope("src/ui/web/app.tsx", ["src/ui"])).toBe(true);
    expect(inScope("src/uix/a.ts", ["src/ui"])).toBe(false);
    expect(inScope("src/a/b/c.ts", ["src/**/*.ts"])).toBe(true);
    expect(inScope("src/c.ts", ["src/**/*.ts"])).toBe(true);
    expect(inScope("src/c.tsx", ["src/*.{ts,tsx}"])).toBe(true);
    expect(inScope("lib/c.ts", ["src/**"])).toBe(false);
    expect(inScope("anything", [])).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a.c", "abc")).toBe(false);
  });
});

describe("swarm agent files", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "em-swarm-agents-"));
  });

  it("renders valid frontmatter that survives hostile text", () => {
    const c = ok(`swarms:
  s:
    description: d
    agents:
      a:
        description: 'quotes " and: colons and # hashes'
        prompt: "---\\nname: evil\\n---"
        tools: [Read]
        skills: [eminiar:em-history]
        hooks:
          PostToolUse:
            - matcher: "Edit|Write"
              hooks: [{ type: command, command: "echo 'hi: there'" }]
`);
    const s = c.swarms[0]!;
    const text = renderAgentFile(c, s, s.roles[0]!);
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(m).not.toBeNull();
    const fm = parseYaml(m![1]!) as Record<string, unknown>;
    expect(fm.name).toBe("swarm-s-a");
    expect(String(fm.description)).toContain('quotes " and: colons and # hashes');
    expect(fm.name).toBe("swarm-s-a");
    expect(String(fm.tools)).toContain("mcp__plugin_eminiar_eminiar__em_swarm");
    expect(String(fm.tools)).toContain("mcp__eminiar__em_recall");
    expect(fm.skills).toEqual(["eminiar:em-history"]);
    expect((fm.hooks as Record<string, unknown>).PostToolUse).toBeTruthy();
    expect(text).toContain("<!-- eminiar:swarm swarm=s role=a");
    expect(
      workerTools(["Read", "mcp__eminiar__em_swarm"]).filter((t) => t === "mcp__eminiar__em_swarm"),
    ).toHaveLength(1);
  });

  it("syncs, is idempotent, never touches hand-written files and prunes", () => {
    const c = ok(BASIC);
    const dir = join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "swarm-feat-tester.md"), "---\nname: swarm-feat-tester\n---\nmine");
    writeFileSync(join(dir, "other.md"), "---\nname: other\n---\nkeep");
    const first = syncAgents(root, c);
    expect(first.conflicts).toBe(1);
    expect(first.actions.find((a) => a.agentType === "swarm-feat-tester")?.action).toBe("conflict");
    expect(readFileSync(join(dir, "swarm-feat-tester.md"), "utf8")).toContain("mine");
    expect(existsSync(join(dir, "swarm-feat-coder.md"))).toBe(true);
    const again = syncAgents(root, c);
    expect(again.changed).toBe(0);
    // dropping a swarm prunes only its generated files
    const smaller = ok(`swarms:
  feat:
    description: test swarm
    agents:
      coder: { description: writes code }
`);
    const pruned = syncAgents(root, smaller);
    expect(
      pruned.actions
        .filter((a) => a.action === "delete")
        .map((a) => a.agentType)
        .sort(),
    ).toEqual([
      "swarm-line-build",
      "swarm-line-check",
      "swarm-line-plan",
      "swarm-peers-a",
      "swarm-peers-b",
    ]);
    expect(pruned.actions.find((a) => a.agentType === "swarm-feat-coder")?.action).toBe("update");
    // disabled → every generated file goes, hand-written ones stay
    syncAgents(root, undefined);
    expect(existsSync(join(dir, "swarm-feat-coder.md"))).toBe(false);
    expect(existsSync(join(dir, "swarm-feat-tester.md"))).toBe(true);
    expect(existsSync(join(dir, "other.md"))).toBe(true);
    expect(planAgentSync(root, undefined)).toEqual([]);
  });
});

describe("swarm runtime", () => {
  let root: string;
  let db: StorageAdapter;
  let cfg: SwarmConfig;
  const coordinator = () => callerOf(cfg, {});

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-swarm-rt-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), BASIC);
    resetContextCache();
    resetSwarmConfigCache();
    db = getStorage(getContext(root), { vectors: false });
    cfg = activeSwarmConfig(root)!;
  });
  afterAll(() => closeAllStorage());

  it("loads the project file and honours enabled: false", () => {
    expect(loadSwarmConfig(root).state).toBe("ok");
    const off = mkdtempSync(join(tmpdir(), "em-swarm-off-"));
    expect(loadSwarmConfig(off).state).toBe("absent");
    mkdirSync(join(off, ".eminiar"));
    writeFileSync(join(off, ".eminiar", "swarm.yml"), `enabled: false\n${BASIC}`);
    expect(loadSwarmConfig(off).state).toBe("ok");
    expect(activeSwarmConfig(off)).toBeUndefined();
  });

  it("plans with keys and deps, and enforces hierarchical roles", () => {
    const run = startRun(db, cfg, { swarm: "feat", goal: "add a widget", sessionId: "S" });
    const swarm = cfg.swarms[0]!;
    const [a, b] = addTasks(db, { root }, run, swarm, coordinator(), [
      { key: "impl", title: "implement", role: "coder", files: [join(root, "src/w.ts")] },
      { title: "test it", role: "tester", deps: ["impl"] },
    ]);
    expect(a!.files).toEqual(["src/w.ts"]);
    expect(b!.deps).toEqual([a!.id]);
    expect(() =>
      addTasks(db, { root }, run, swarm, coordinator(), [{ title: "x", role: "nope" }]),
    ).toThrow(SwarmError);
    expect(() =>
      addTasks(db, { root }, run, swarm, coordinator(), [{ title: "x", deps: ["later"] }]),
    ).toThrow(/neither/);

    const tester = callerOf(cfg, { agentId: "agent-t1", agentType: "swarm-feat-tester" });
    const coder = callerOf(cfg, { agentId: "agent-c1", agentType: "swarm-feat-coder" });
    // tester's task waits on the coder's
    expect(claimTask(db, run, swarm, tester).reason).toMatch(/waits on/);
    expect(() => claimTask(db, run, swarm, coder, b!.id)).toThrow(/waits on|tester role/);
    const got = claimTask(db, run, swarm, coder);
    expect(got.task?.id).toBe(a!.id);
    expect(claimTask(db, run, swarm, coder).already).toBe(true);
    // someone else cannot close it
    expect(() => updateTask(db, run, tester, { task: a!.id, status: "done" })).toThrow(
      /held by another/,
    );
    updateTask(db, run, coder, { task: a!.id, status: "done", result: "added src/w.ts" });
    expect(claimTask(db, run, swarm, tester).task?.id).toBe(b!.id);
    // coordinator can reopen; reopening releases the holder
    const reopened = updateTask(db, run, coordinator(), { task: b!.id, status: "pending" });
    expect(reopened.agent_id).toBeNull();
    expect(() => updateTask(db, run, coder, { task: b!.id, status: "active" })).toThrow(
      /status must be/,
    );
    finishRun(getContext(root), db, run, coordinator(), { status: "cancelled" });
  });

  it("gates pipeline stages and lets mesh peers take any task", () => {
    const line = cfg.swarms.find((s) => s.name === "line")!;
    const run = startRun(db, cfg, { swarm: "line", goal: "pipeline goal" });
    const [p, b] = addTasks(db, { root }, run, line, coordinator(), [
      { title: "plan", role: "plan" },
      { title: "build", role: "build" },
    ]);
    const builder = callerOf(cfg, { agentId: "agent-b", agentType: "swarm-line-build" });
    expect(claimTask(db, run, line, builder).reason).toMatch(/earlier stages/);
    const planner = callerOf(cfg, { agentId: "agent-p", agentType: "swarm-line-plan" });
    claimTask(db, run, line, planner);
    updateTask(db, run, planner, { task: p!.id, status: "done" });
    expect(claimTask(db, run, line, builder).task?.id).toBe(b!.id);

    const peers = cfg.swarms.find((s) => s.name === "peers")!;
    const mrun = startRun(db, cfg, { swarm: "peers", goal: "mesh goal" });
    const [t] = addTasks(db, { root }, mrun, peers, coordinator(), [{ title: "for a", role: "a" }]);
    const peerB = callerOf(cfg, { agentId: "agent-pb", agentType: "swarm-peers-b" });
    expect(claimTask(db, mrun, peers, peerB).task?.id).toBe(t!.id);
  });

  it("enforces max_agents and role count with spawn reservations", () => {
    const run = startRun(db, cfg, { swarm: "feat", goal: "capacity", sessionId: "CAP" });
    const spawn = (type: string, prompt = "go") =>
      reserveSpawn(db, cfg, { agentType: type, prompt, sessionId: "CAP" });
    expect(reserveSpawn(db, cfg, { agentType: "general-purpose" })).toBeUndefined();
    expect(spawn("swarm-feat-coder")?.decision).toBe("allow");
    expect(spawn("swarm-feat-coder")?.decision).toBe("allow");
    const third = spawn("swarm-feat-coder");
    expect(third?.decision).toBe("deny");
    if (third?.decision === "deny") expect(third.reason).toMatch(/count is 2/);
    expect(spawn("swarm-feat-tester")?.decision).toBe("allow");
    const over = spawn("swarm-feat-tester");
    expect(over?.decision).toBe("deny");
    if (over?.decision === "deny") expect(over.reason).toMatch(/max_agents is 3/);
    // reservations are consumed by SubagentStart; the workers then count as running
    registerWorker(db, cfg, {
      agentId: "agent-x1",
      agentType: "swarm-feat-coder",
      sessionId: "CAP",
    });
    expect(runSnapshot(db, run).counts.workers.running).toBe(1);
    // a stale worker stops counting
    db.swarm.workerUpdate(run.id, "agent-x1", {});
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE swarm_agents SET last_ts = ? WHERE agent_id = ?")
      .run(Date.now() - STALE_MS - 1000, "agent-x1");
    expect(runSnapshot(db, run).workers[0]!.status).toBe("stale");
    finishRun(getContext(root), db, run, coordinator(), { status: "cancelled" });
  });

  it("registers a worker, which claims its task, records activity and auto-closes on stop", async () => {
    const swarm = cfg.swarms[0]!;
    const run = startRun(db, cfg, { swarm: "feat", goal: "lifecycle", sessionId: "LC" });
    const [t1, t2] = addTasks(db, { root }, run, swarm, coordinator(), [
      { title: "first", role: "coder", files: ["src/a.ts"] },
      { title: "second", role: "coder" },
    ]);
    expect(taskRef(`Please do task #${t1!.id} now`)).toBe(t1!.id);
    expect(taskRef("task 5")).toBeUndefined();
    const allow = reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `Work on task #${t1!.id}`,
      sessionId: "LC",
    });
    expect(allow?.decision === "allow" && allow.taskId).toBe(t1!.id);
    const started = registerWorker(db, cfg, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      sessionId: "LC",
    });
    expect(started?.run.id).toBe(run.id);
    // no hand-over at start: the worker claims the task its prompt names
    expect(started?.task).toBeUndefined();
    const brief = await workerBrief(getContext(root), db, started!);
    expect(brief).toMatch(/you are the "coder" worker/i);
    expect(brief).toContain('claim it first with em_swarm {action:"claim", task:N}');
    expect(brief).toContain(`#${t1!.id} first`);
    claimTask(
      db,
      run,
      swarm,
      callerOf(cfg, { agentId: "agent-w1", agentType: "swarm-feat-coder" }),
      t1!.id,
    );
    expect(db.swarm.taskGet(t1!.id)!.agent_id).toBe("agent-w1");
    expect(brief.length).toBeLessThanOrEqual(4000);

    recordActivity(db, cfg, root, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      tool: "Edit",
      input: { file_path: join(root, "src/a.ts") },
    });
    recordActivity(db, cfg, root, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      tool: "Bash",
      input: { command: "npm test" },
      failed: true,
      error: "exit 1",
    });
    const snap = runSnapshot(db, run);
    const w = snap.workers.find((x) => x.agent_id === "agent-w1")!;
    expect(w.tool_calls).toBe(2);
    expect(w.errors).toBe(1);
    expect(snap.events.some((e) => e.kind === "tool" && e.text === "Edit src/a.ts")).toBe(true);
    expect(snap.events.some((e) => e.kind === "tool_error" && e.payload?.io === "exec")).toBe(true);

    const closed = closeWorker(db, cfg, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      message: "Done: edited src/a.ts",
    });
    expect(closed?.closed[0]?.status).toBe("done");
    expect(db.swarm.taskGet(t1!.id)!.auto_closed).toBe(true);
    expect(db.swarm.workerGet(run.id, "agent-w1")!.status).toBe("done");

    // a worker that stops silently releases its task
    const second = callerOf(cfg, { agentId: "agent-w2", agentType: "swarm-feat-coder" });
    registerWorker(db, cfg, {
      agentId: "agent-w2",
      agentType: "swarm-feat-coder",
      sessionId: "LC",
    });
    claimTask(db, run, swarm, second, t2!.id);
    closeWorker(db, cfg, { agentId: "agent-w2", agentType: "swarm-feat-coder", message: "" });
    expect(db.swarm.taskGet(t2!.id)).toMatchObject({ status: "pending", agent_id: null });

    // blackboard and briefs
    postNote(db, run, second, "design", "use a map");
    expect(postNote(db, run, coordinator(), "design", "use a set").version).toBe(2);
    expect(() => postNote(db, run, coordinator(), "bad key!", "x")).toThrow(/key must be/);
    const cb = await coordinatorBrief(getContext(root), db, cfg, swarm, run);
    expect(cb).toContain('subagent_type "swarm-feat-coder"');
    const tb = await taskBrief(db, run, swarm.roles[0], db.swarm.taskGet(t2!.id)!);
    expect(tb).toContain("second");

    // only the coordinator finishes; remember writes a memory
    expect(() => finishRun(getContext(root), db, run, second, { status: "done" })).toThrow(
      /coordinator/,
    );
    const fin = finishRun(getContext(root), db, run, coordinator(), {
      status: "done",
      summary: "all good",
      remember: true,
    });
    expect(fin.memory).toMatch(/^swarm\/run-\d{4}-\d{2}-\d{2}-lifecycle/);
    expect(db.memoryGetByName(fin.memory!)?.content).toContain("Outcome: all good");
    expect(() => addTasks(db, { root }, run, swarm, coordinator(), [{ title: "late" }])).toThrow(
      /is done/,
    );
  });

  it("opens an ad-hoc run for a worker spawned outside a run", () => {
    for (const r of db.swarm.runs({ swarm: "peers", status: "active" }))
      finishRun(getContext(root), db, r, coordinator(), { status: "cancelled" });
    const fresh = registerWorker(db, cfg, {
      agentId: "agent-adhoc",
      agentType: "swarm-peers-a",
      sessionId: "NEW",
    });
    expect(fresh?.run.goal).toMatch(/^\(ad hoc\)/);
    expect(registerWorker(db, cfg, { agentId: "agent-z", agentType: "Explore" })).toBeUndefined();
  });

  it("describes tool calls compactly", () => {
    expect(toolHead(root, "Read", { file_path: join(root, "src/x.ts") })).toBe("Read src/x.ts");
    expect(toolHead(root, "mcp__plugin_eminiar_eminiar__em_search", { queries: ["a"] })).toBe(
      "em_search",
    );
    expect(toolHead(root, "Bash", { command: "npm test\necho hi" })).toBe("Bash npm test");
  });
});
