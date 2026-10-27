/**
 * Regressions for the adversarial review of the swarm foundation (config, agent files,
 * globs, ledger). Each test names the finding it pins.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import {
  generatedState,
  renderAgentFile,
  syncAgents,
  workerTools,
} from "../../src/swarm/agents.js";
import { workerBrief } from "../../src/swarm/brief.js";
import {
  activeSwarmConfig,
  loadSwarmConfig,
  parseSwarmYaml,
  resetSwarmConfigCache,
} from "../../src/swarm/config.js";
import { globMatch, inScope } from "../../src/swarm/glob.js";
import {
  addTasks,
  callerOf,
  claimTask,
  closeSessionWorkers,
  closeWorker,
  finishRun,
  recordActivity,
  registerWorker,
  releaseSpawn,
  releaseWorkers,
  reserveSpawn,
  runSnapshot,
  startRun,
  taskRef,
  updateTask,
} from "../../src/swarm/runtime.js";
import type { SwarmConfig } from "../../src/swarm/types.js";

const parse = (y: string) => parseSwarmYaml(y, "/x/.eminiar/swarm.yaml", ".eminiar/swarm.yaml");
const ok = (y: string): SwarmConfig => {
  const r = parse(y);
  if (r.state !== "ok") throw new Error(JSON.stringify(r));
  return r.config;
};
const invalid = (y: string) => {
  const r = parse(y);
  expect(r.state).toBe("invalid");
  return r.state === "invalid" ? r.issues : [];
};
const one = (agent: string) => `swarms:\n  s:\n    description: d\n    agents:\n      a:\n${agent}`;

describe("config review", () => {
  it("rejects --- anywhere it would land in agent frontmatter, and bad hyphenation", () => {
    expect(
      invalid(one("        description: Reviews diffs --- never edits\n"))[0]!.message,
    ).toMatch(/---/);
    invalid(one("        description: x\n        tools: ['Read ---']\n"));
    invalid(
      one(
        "        description: x\n        hooks:\n          PostToolUse:\n            - hooks: [{ type: command, command: 'echo --- done' }]\n",
      ),
    );
    expect(
      invalid(
        "swarms:\n  ab--:\n    description: d\n    agents:\n      c: { description: x }\n",
      )[0]!.message,
    ).toMatch(/single hyphens/);
    invalid("swarms:\n  ab-:\n    description: d\n    agents:\n      c: { description: x }\n");
    // the prompt lives in the body, where --- is harmless
    ok(one("        description: x\n        prompt: |\n          ---\n          fine\n"));
  });

  it("reports bad names with the real message instead of 'Invalid key'", () => {
    const issues = invalid(
      "swarms:\n  s:\n    description: d\n    agents:\n      code_reviewer: { description: x }\n",
    );
    expect(issues[0]!.message).toMatch(/agent name "code_reviewer"/);
    expect(issues[0]!.line).toBe(5);
  });

  it("accepts anchors in x-* keys and merge keys; rejects other unknown top-level keys", () => {
    const c = ok(`x-base: &base
  description: shared
  model: opus
swarms:
  s:
    description: d
    agents:
      a:
        <<: *base
        prompt: hi
`);
    expect(c.swarms[0]!.roles[0]!).toMatchObject({ description: "shared", model: "opus" });
    expect(
      invalid(
        "swarmz: {}\nswarms:\n  s: { description: d, agents: { a: { description: x } } }\n",
      )[0]!.message,
    ).toMatch(/unknown key "swarmz"/);
  });

  it("turns alias bombs into issues instead of throwing", () => {
    const bomb = [
      "a: &a [x,x,x,x,x,x,x,x,x,x]",
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]",
      "e: [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]",
      "swarms: {}",
    ].join("\n");
    expect(() => parse(bomb)).not.toThrow();
    expect(parse(bomb).state).toBe("invalid");
  });

  it("rejects stages outside a pipeline, non-Claude models and bad matchers", () => {
    invalid(
      "swarms:\n  s:\n    description: d\n    topology: mesh\n    stages: [a]\n    agents:\n      a: { description: x }\n",
    );
    invalid(one("        description: x\n        model: gpt-4o\n"));
    ok(one("        description: x\n        model: claude-sonnet-5-5\n"));
    ok(one("        description: x\n        model: sonnet[1m]\n"));
    invalid(
      one(
        "        description: x\n        hooks:\n          PreToolUse:\n            - matcher: '(unclosed'\n              hooks: [{ type: command, command: ls }]\n",
      ),
    );
    invalid(one("        description: x\n        scope: ['src/{*.ts']\n"));
  });

  it("sees an edit that keeps the file size and mtime", () => {
    const root = mkdtempSync(join(tmpdir(), "em-swarm-cache-"));
    mkdirSync(join(root, ".eminiar"));
    const file = join(root, ".eminiar", "swarm.yaml");
    writeFileSync(file, one("        description: x\n        count: 2\n"));
    expect(activeSwarmConfig(root)!.swarms[0]!.roles[0]!.count).toBe(2);
    writeFileSync(file, one("        description: x\n        count: 7\n"));
    expect(activeSwarmConfig(root)!.swarms[0]!.roles[0]!.count).toBe(7);
  });
});

describe("glob review", () => {
  it("translates braces with wildcards, nested braces and classes", () => {
    expect(globMatch("src/{*.ts,*.md}", "src/a.ts")).toBe(true);
    expect(globMatch("src/{*.ts,*.md}", "src/a.md")).toBe(true);
    expect(globMatch("src/{a*,b}", "src/abc")).toBe(true);
    expect(globMatch("src/{a*,b}", "src/")).toBe(false);
    expect(globMatch("src/{a,{b,c}}", "src/c")).toBe(true);
    expect(globMatch("src/[ab].ts", "src/b.ts")).toBe(true);
    expect(globMatch("src/[!ab].ts", "src/b.ts")).toBe(false);
    expect(globMatch("./src/**", "src/x/y.ts")).toBe(true);
    expect(globMatch("**/*.ts", "a.ts")).toBe(true);
    expect(inScope("src/x.ts", ["src/"])).toBe(true);
  });

  it("does not backtrack catastrophically", () => {
    const t = Date.now();
    expect(globMatch(`${"*a".repeat(12)}b`, "a".repeat(40))).toBe(false);
    expect(globMatch(`${"**a".repeat(8)}b`, "a".repeat(60))).toBe(false);
    expect(globMatch(`${"**/".repeat(10)}x`, `${"d/".repeat(40)}y`)).toBe(false);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("agent file review", () => {
  const cfg = () =>
    ok(
      "swarms:\n  feat:\n    description: d\n    agents:\n      coder: { description: writes code }\n",
    );

  it("only trusts a marker on the first line after the frontmatter, with a matching hash", () => {
    const c = cfg();
    const text = renderAgentFile(c, c.swarms[0]!, c.swarms[0]!.roles[0]!);
    expect(generatedState(text)).toBe("generated");
    expect(generatedState(text.replace("writes code", "writes better code"))).toBe("edited");
    expect(generatedState("---\nname: mine\n---\nI mention <!-- eminiar:swarm here")).toBe(
      "foreign",
    );
  });

  it("never deletes or overwrites hand-written, edited, unreadable or odd entries", () => {
    const root = mkdtempSync(join(tmpdir(), "em-swarm-sync-"));
    const dir = join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    // prose that mentions the marker
    writeFileSync(join(dir, "swarm-notes.md"), "notes about <!-- eminiar:swarm swarm=x role=y -->");
    // a directory with the agent's file name
    mkdirSync(join(dir, "swarm-feat-coder.md"));
    const r = syncAgents(root, cfg());
    expect(r.actions.find((a) => a.agentType === "swarm-feat-coder")?.action).toBe("conflict");
    expect(readFileSync(join(dir, "swarm-notes.md"), "utf8")).toContain("notes about");

    const root2 = mkdtempSync(join(tmpdir(), "em-swarm-sync2-"));
    const dir2 = join(root2, ".claude", "agents");
    mkdirSync(dir2, { recursive: true });
    syncAgents(root2, cfg());
    const f = join(dir2, "swarm-feat-coder.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("Swarm protocol", "My protocol"));
    expect(syncAgents(root2, cfg()).actions[0]).toMatchObject({ action: "conflict" });
    expect(syncAgents(root2, undefined).actions[0]).toMatchObject({ action: "conflict" });
    expect(readFileSync(f, "utf8")).toContain("My protocol");
    expect(syncAgents(root2, cfg(), { force: true }).actions[0]).toMatchObject({
      action: "update",
    });

    if (process.getuid?.() !== 0) {
      const root3 = mkdtempSync(join(tmpdir(), "em-swarm-sync3-"));
      const dir3 = join(root3, ".claude", "agents");
      mkdirSync(dir3, { recursive: true });
      const locked = join(dir3, "swarm-feat-coder.md");
      writeFileSync(locked, "secret");
      chmodSync(locked, 0o000);
      expect(syncAgents(root3, cfg()).actions[0]).toMatchObject({ action: "conflict" });
      chmodSync(locked, 0o644);
      expect(readFileSync(locked, "utf8")).toBe("secret");
    }
  });

  it("refuses an agents directory that resolves outside the project", () => {
    const shared = mkdtempSync(join(tmpdir(), "em-swarm-shared-"));
    const root = mkdtempSync(join(tmpdir(), "em-swarm-link-"));
    mkdirSync(join(root, ".claude"));
    symlinkSync(shared, join(root, ".claude", "agents"));
    const r = syncAgents(root, cfg());
    expect(r.conflicts).toBe(1);
    expect(r.actions[0]!.reason).toMatch(/outside the project/);
  });
});

describe("second review round", () => {
  it("refuses a symlinked .claude without an agents folder yet", () => {
    const outside = mkdtempSync(join(tmpdir(), "em-swarm-out-"));
    const root = mkdtempSync(join(tmpdir(), "em-swarm-dotclaude-"));
    symlinkSync(outside, join(root, ".claude"));
    const c = ok(
      "swarms:\n  feat:\n    description: d\n    agents:\n      coder: { description: x }\n",
    );
    expect(syncAgents(root, c).conflicts).toBe(1);
    expect(existsSync(join(outside, "agents"))).toBe(false);
  });

  it("recognises a generated file checked out with CRLF line endings", () => {
    const c = ok(
      "swarms:\n  feat:\n    description: d\n    agents:\n      coder: { description: x }\n",
    );
    const text = renderAgentFile(c, c.swarms[0]!, c.swarms[0]!.roles[0]!);
    expect(generatedState(text.replace(/\n/g, "\r\n"))).toBe("generated");
  });

  it("accepts Claude model ids only, case-sensitively, and caps max_chars", () => {
    for (const m of [
      "sonnet",
      "opus[1m]",
      "inherit",
      "claude-sonnet-5-5",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "claude-opus-4-1@20250805",
    ])
      ok(one(`        description: x\n        model: "${m}"\n`));
    for (const m of ["SONNET", "inherit[1m]", "claude", "gpt-4o"])
      invalid(one(`        description: x\n        model: "${m}"\n`));
    invalid(one("        description: x\n        context: { max_chars: 12000 }\n"));
  });

  it("adds ToolSearch to an allowlist so deferred em_* tools can load", () => {
    expect(workerTools(["Read"])).toContain("ToolSearch");
    expect(workerTools(["Read", "ToolSearch"]).filter((t) => t === "ToolSearch")).toHaveLength(1);
  });
});

describe("ledger review", () => {
  let root: string;
  let db: StorageAdapter;
  let cfg: SwarmConfig;
  const coord = () => callerOf(cfg, {});
  const worker = (id: string, type = "swarm-feat-coder") =>
    callerOf(cfg, { agentId: id, agentType: type });

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-swarm-ledger-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(
      join(root, ".eminiar", "swarm.yaml"),
      `swarms:
  feat:
    description: d
    max_agents: 3
    agents:
      coder: { description: writes code, count: 2 }
      tester: { description: tests code }
  line:
    description: p
    topology: pipeline
    agents:
      plan: { description: plans }
      build: { description: builds }
`,
    );
    resetContextCache();
    resetSwarmConfigCache();
    db = getStorage(getContext(root), { vectors: false });
    cfg = activeSwarmConfig(root)!;
    expect(loadSwarmConfig(root).state).toBe("ok");
  });
  afterAll(() => closeAllStorage());

  const fresh = (goal: string, session = "S") => {
    for (const r of db.swarm.runs({ status: "active" }))
      finishRun(getContext(root), db, r, coord(), { status: "cancelled" });
    for (const w of db.swarm.liveWorkersOfSwarm("feat", 0))
      db.swarm.workerUpdate(w.run_id, w.agent_id, { status: "done" });
    // reservations left open by earlier tests (no PostToolUse came) would count as starting
    (db as unknown as { db: { prepare(s: string): { run(): void } } }).db
      .prepare("UPDATE swarm_spawns SET consumed = 1")
      .run();
    return startRun(db, cfg, { swarm: "feat", goal, sessionId: session });
  };

  it("#1 never hands a task over at start (parallel spawns cannot be told apart)", () => {
    const run = fresh("no hand-over");
    const [t1, t2] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "one", role: "coder" },
      { title: "two", role: "coder" },
    ]);
    reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t1!.id}`,
      sessionId: "S",
      toolUseId: "tu1",
    });
    reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t2!.id}`,
      sessionId: "S",
      toolUseId: "tu2",
    });
    // the #2 worker starts first
    const w2 = registerWorker(db, cfg, {
      agentId: "A2",
      agentType: "swarm-feat-coder",
      sessionId: "S",
    });
    expect(w2?.task).toBeUndefined();
    expect(db.swarm.taskGet(t1!.id)!.status).toBe("pending");
    expect(db.swarm.taskGet(t2!.id)!.status).toBe("pending");
    expect(claimTask(db, run, cfg.swarms[0]!, worker("A2"), t2!.id).task?.id).toBe(t2!.id);
    expect(taskRef(`Unlike task #${t1!.id}, do task #${t2!.id}`)).toBeUndefined();
    // both Agent calls return (PostToolUse): whatever reservation is left is released
    releaseSpawn(db, "tu1");
    releaseSpawn(db, "tu2");
    expect(db.swarm.spawnsPendingOfSwarm("feat", 0)).toBe(0);
  });

  it("#4 the Agent call returning releases its reservation; a never-started spawn frees its slot", () => {
    const run = fresh("release spawn");
    // max_agents 3: hold two slots with reservations whose Agent calls fail
    for (const tu of ["x1", "x2"])
      expect(
        reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S", toolUseId: tu })
          ?.decision,
      ).toBe("allow");
    expect(db.swarm.spawnsPendingOfSwarm("feat", 0)).toBe(2);
    expect(releaseSpawn(db, "x1")).toBe(true);
    expect(releaseSpawn(db, "x1")).toBe(false);
    releaseSpawn(db, "x2");
    expect(db.swarm.spawnsPendingOfSwarm("feat", 0)).toBe(0);
    expect(run.id).toBeTruthy();
  });

  it("#6 a spawn or denial with no active run opens no run", () => {
    for (const r of db.swarm.runs({ status: "active" }))
      finishRun(getContext(root), db, r, coord(), { status: "cancelled" });
    const before = db.swarm.runs({ limit: 500 }).length;
    const d = reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      sessionId: "S",
      toolUseId: "n1",
    });
    expect(d?.decision).toBe("allow");
    expect(d?.decision === "allow" && d.run).toBeUndefined();
    expect(db.swarm.runs({ limit: 500 }).length).toBe(before);
    releaseSpawn(db, "n1");
  });

  it("#2 a resumed worker keeps its task; a never-registered one makes no run", () => {
    const run = fresh("resume");
    const [t1] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "one", role: "coder" },
    ]);
    registerWorker(db, cfg, { agentId: "R1", agentType: "swarm-feat-coder", sessionId: "S" });
    claimTask(db, run, cfg.swarms[0]!, worker("R1"), t1!.id);
    const again = registerWorker(db, cfg, {
      agentId: "R1",
      agentType: "swarm-feat-coder",
      sessionId: "S",
    });
    expect(again?.task?.id).toBe(t1!.id);
    const before = db.swarm.runs({ limit: 500 }).length;
    expect(
      closeWorker(db, cfg, { agentId: "GHOST", agentType: "swarm-feat-coder", message: "x" }),
    ).toBeUndefined();
    for (const r of db.swarm.runs({ status: "active" }))
      finishRun(getContext(root), db, r, coord(), { status: "cancelled" });
    recordActivity(db, cfg, root, {
      agentId: "GHOST2",
      agentType: "swarm-feat-coder",
      tool: "Read",
    });
    expect(db.swarm.runs({ limit: 500 }).length).toBe(before);
  });

  it("#3 a spawn naming a task goes to that task's run, not a recently touched old run", () => {
    const old = fresh("old run");
    const current = startRun(db, cfg, { swarm: "feat", goal: "current", sessionId: "S" });
    const [t] = addTasks(db, { root }, current, cfg.swarms[0]!, coord(), [
      { title: "t", role: "coder" },
    ]);
    db.swarm.runTouch(old.id);
    const d = reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t!.id}`,
      sessionId: "S",
    });
    expect(d?.decision === "allow" && d.run?.id).toBe(current.id);
    expect(db.swarm.runActive("feat", "S")?.id).toBe(current.id);
  });

  it("#5 capacity spans runs; finish closes the run's workers; reservations keep counting", () => {
    const run = fresh("capacity");
    for (const id of ["C1", "C2"]) {
      reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S" });
      registerWorker(db, cfg, { agentId: id, agentType: "swarm-feat-coder", sessionId: "S" });
    }
    // a second run of the same swarm still sees the two coders
    const other = startRun(db, cfg, { swarm: "feat", goal: "parallel", sessionId: "S2" });
    const d = reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S2" });
    expect(d?.decision).toBe("deny");
    if (d?.decision === "deny") expect(d.reason).toMatch(/coder@C1/);
    // a spawn still starting keeps its slot across finish
    reserveSpawn(db, cfg, { agentType: "swarm-feat-tester", sessionId: "S", toolUseId: "late" });
    finishRun(getContext(root), db, run, coord(), { status: "done" });
    expect(db.swarm.workers(run.id).every((w) => w.status === "done")).toBe(true);
    expect(db.swarm.spawnsPendingOfSwarm("feat", 0)).toBe(1);
    expect(
      reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S2" })?.decision,
    ).toBe("allow");
    releaseSpawn(db, "late");
    finishRun(getContext(root), db, other, coord(), { status: "cancelled" });
  });

  it("#1 SessionEnd and release free workers that never stopped", () => {
    const run = fresh("ghosts", "G");
    const [t] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "x", role: "coder" },
    ]);
    registerWorker(db, cfg, { agentId: "G1", agentType: "swarm-feat-coder", sessionId: "G" });
    registerWorker(db, cfg, { agentId: "G2", agentType: "swarm-feat-coder", sessionId: "G" });
    claimTask(db, run, cfg.swarms[0]!, worker("G1"), t!.id);
    expect(() => releaseWorkers(db, run, worker("G2"), { agent: "G1" })).toThrow(/coordinator/);
    expect(releaseWorkers(db, run, coord(), { agent: "G1" }).map((w) => w.agent_id)).toEqual([
      "G1",
    ]);
    expect(db.swarm.taskGet(t!.id)).toMatchObject({ status: "pending", agent_id: null });
    expect(closeSessionWorkers(db, "G")).toBe(1);
    expect(db.swarm.workerGet(run.id, "G2")!.status).toBe("done");
  });

  it("an ad-hoc run closes itself when its last worker stops", () => {
    for (const r of db.swarm.runs({ status: "active" }))
      finishRun(getContext(root), db, r, coord(), { status: "cancelled" });
    const w = registerWorker(db, cfg, {
      agentId: "AH1",
      agentType: "swarm-feat-tester",
      sessionId: "AH",
    });
    expect(w?.run.goal).toMatch(/^\(ad hoc\)/);
    closeWorker(db, cfg, { agentId: "AH1", agentType: "swarm-feat-tester", message: "done" });
    expect(db.swarm.runGet(w!.run.id)?.status).toBe("done");
  });

  it("keeps distinct denial kinds apart and prunes old events", () => {
    const run = fresh("deny kinds");
    for (const id of ["K1", "K2"])
      db.swarm.workerUpsert({
        run_id: run.id,
        agent_id: id,
        agent_type: "swarm-feat-coder",
        role: "coder",
      });
    reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S" }); // count
    db.swarm.workerUpsert({
      run_id: run.id,
      agent_id: "K3",
      agent_type: "swarm-feat-tester",
      role: "tester",
    });
    reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S" }); // max_agents now
    const kinds = db.swarm
      .events(run.id, { limit: 100 })
      .filter((e) => e.kind === "deny")
      .map((e) => e.payload?.type);
    expect(kinds).toEqual(["count", "max_agents"]);
    for (let i = 0; i < 30; i++) db.swarm.eventAdd({ run_id: run.id, kind: "tool", text: `t${i}` });
    expect(db.swarm.eventsPrune(run.id, 10)).toBeGreaterThan(0);
    expect(db.swarm.events(run.id, { limit: 100 })).toHaveLength(10);
  });

  it("#13 repeated denials collapse into one event", () => {
    const run = fresh("deny flood");
    db.swarm.workerUpsert({
      run_id: run.id,
      agent_id: "D1",
      agent_type: "swarm-feat-tester",
      role: "tester",
    });
    for (let i = 0; i < 10; i++)
      reserveSpawn(db, cfg, { agentType: "swarm-feat-tester", sessionId: "S" });
    const denies = db.swarm.events(run.id, { limit: 100 }).filter((e) => e.kind === "deny");
    expect(denies).toHaveLength(1);
    expect(denies[0]!.payload?.count).toBe(10);
  });

  it("#8 foreign agents cannot change the board; workers only update what they hold", () => {
    const run = fresh("rights");
    const [t] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "x", role: "coder" },
    ]);
    const explore = callerOf(cfg, { agentId: "E1", agentType: "Explore" });
    expect(() => claimTask(db, run, cfg.swarms[0]!, explore)).toThrow(/not a swarm worker/);
    expect(() => updateTask(db, run, explore, { task: t!.id, status: "done" })).toThrow(
      /not a swarm worker/,
    );
    expect(() =>
      updateTask(db, run, worker("T1", "swarm-feat-tester"), { task: t!.id, status: "done" }),
    ).toThrow(/claim it first/);
    // a worker can still report after the coordinator finished the run
    claimTask(db, run, cfg.swarms[0]!, worker("W1"), t!.id);
    finishRun(getContext(root), db, run, coord(), { status: "done" });
    expect(
      updateTask(db, run, worker("W1"), { task: t!.id, status: "done", result: "late" }).result,
    ).toBe("late");
  });

  it("#11 a failed dep explains itself", () => {
    const run = fresh("failed dep");
    const [a, b] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { key: "a", title: "a", role: "coder" },
      { title: "b", role: "tester", deps: ["a"] },
    ]);
    claimTask(db, run, cfg.swarms[0]!, worker("F1"), a!.id);
    updateTask(db, run, worker("F1"), { task: a!.id, status: "failed" });
    expect(() =>
      claimTask(db, run, cfg.swarms[0]!, worker("F2", "swarm-feat-tester"), b!.id),
    ).toThrow(/depends on #\d+ \(failed\); reopen/);
  });

  it("#9 a task held by a silent worker is flagged", () => {
    const run = fresh("stale");
    const [t] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "x", role: "coder" },
    ]);
    db.swarm.workerUpsert({
      run_id: run.id,
      agent_id: "Q1",
      agent_type: "swarm-feat-coder",
      role: "coder",
    });
    claimTask(db, run, cfg.swarms[0]!, worker("Q1"), t!.id);
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE swarm_agents SET last_ts = 0 WHERE agent_id = 'Q1'")
      .run();
    expect(runSnapshot(db, run).counts.staleHeld).toBe(1);
    expect(claimTask(db, run, cfg.swarms[0]!, worker("Q2")).reason).toMatch(/went quiet/);
  });

  it("#6 remember picks a free name when a teammate's memory file exists on disk", () => {
    const run = fresh("collide");
    const ctx = getContext(root);
    const date = new Date(run.created_at);
    const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    mkdirSync(join(root, ".eminiar", "memories", "swarm"), { recursive: true });
    writeFileSync(
      join(root, ".eminiar", "memories", "swarm", `run-${d}-collide.md`),
      "---\nkind: note\n---\nmine\n",
    );
    const r = finishRun(ctx, db, run, coord(), { status: "done", remember: true });
    expect(r.memoryError).toBeUndefined();
    expect(r.memory).toMatch(new RegExp(`^swarm/run-${d}-collide-[0-9a-f]{6}$`));
  });

  it("#10 a tiny brief budget keeps the task id and how to report it", async () => {
    const run = startRun(db, cfg, { swarm: "feat", goal: "g".repeat(1990), sessionId: "BR" });
    const [t] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "small", role: "coder" },
    ]);
    const role = {
      ...cfg.swarms[0]!.roles[0]!,
      context: { ...cfg.swarms[0]!.roles[0]!.context, maxChars: 500 },
    };
    const brief = await workerBrief(getContext(root), db, {
      run,
      swarm: cfg.swarms[0]!,
      role,
      task: { ...t!, status: "active" },
    });
    expect(brief.length).toBeLessThanOrEqual(500);
    expect(brief).toContain(`#${t!.id} small`);
    expect(brief).toContain(`task:${t!.id}`);
  });
});
