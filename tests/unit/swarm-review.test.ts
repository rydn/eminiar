/**
 * Regressions for the adversarial review of the swarm foundation (config, agent files,
 * globs, ledger). Each test names the finding it pins.
 */
import {
  chmodSync,
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
import { generatedState, renderAgentFile, syncAgents } from "../../src/swarm/agents.js";
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
  closeWorker,
  finishRun,
  recordActivity,
  registerWorker,
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
    return startRun(db, cfg, { swarm: "feat", goal, sessionId: session });
  };

  it("#1 does not hand over a task when reservations are ambiguous", () => {
    const run = fresh("ambiguous");
    const [t1, t2] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "one", role: "coder" },
      { title: "two", role: "coder" },
    ]);
    // first spawn's permission is denied by the user: its reservation is never used
    reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t1!.id}`,
      sessionId: "S",
    });
    reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t2!.id}`,
      sessionId: "S",
    });
    const w = registerWorker(db, cfg, {
      agentId: "A1",
      agentType: "swarm-feat-coder",
      sessionId: "S",
    });
    expect(w?.task).toBeUndefined();
    expect(w?.prompt).toBeUndefined();
    expect(db.swarm.taskGet(t1!.id)!.status).toBe("pending");
    expect(taskRef(`Unlike task #${t1!.id}, do task #${t2!.id}`)).toBeUndefined();
  });

  it("#1 never matches another session's reservation", () => {
    const run = fresh("sessions", "A");
    const [t] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "a's", role: "coder" },
    ]);
    reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t!.id}`,
      sessionId: "A",
    });
    const b = registerWorker(db, cfg, {
      agentId: "B1",
      agentType: "swarm-feat-coder",
      sessionId: "B",
    });
    expect(b?.task).toBeUndefined();
    const a = registerWorker(db, cfg, {
      agentId: "A2",
      agentType: "swarm-feat-coder",
      sessionId: "A",
    });
    expect(a?.task?.id).toBe(t!.id);
  });

  it("#2 a resumed or never-registered worker takes no reservation; #12 stop makes no run", () => {
    const run = fresh("resume");
    const [t1, t2] = addTasks(db, { root }, run, cfg.swarms[0]!, coord(), [
      { title: "one", role: "coder" },
      { title: "two", role: "coder" },
    ]);
    reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t1!.id}`,
      sessionId: "S",
    });
    const w1 = registerWorker(db, cfg, {
      agentId: "R1",
      agentType: "swarm-feat-coder",
      sessionId: "S",
    });
    expect(w1?.task?.id).toBe(t1!.id);
    reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `task #${t2!.id}`,
      sessionId: "S",
    });
    const again = registerWorker(db, cfg, {
      agentId: "R1",
      agentType: "swarm-feat-coder",
      sessionId: "S",
    });
    expect(again?.task?.id).toBe(t1!.id);
    const w2 = registerWorker(db, cfg, {
      agentId: "R2",
      agentType: "swarm-feat-coder",
      sessionId: "S",
    });
    expect(w2?.task?.id).toBe(t2!.id);
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
    expect(d?.decision === "allow" && d.run.id).toBe(current.id);
    expect(db.swarm.runActive("feat", "S")?.id).toBe(current.id);
  });

  it("#5 capacity counts workers of finished runs and finish voids reservations", () => {
    const run = fresh("capacity");
    for (const id of ["C1", "C2"]) {
      reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S" });
      registerWorker(db, cfg, { agentId: id, agentType: "swarm-feat-coder", sessionId: "S" });
    }
    reserveSpawn(db, cfg, { agentType: "swarm-feat-tester", sessionId: "S" });
    finishRun(getContext(root), db, run, coord(), { status: "done" });
    expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
    startRun(db, cfg, { swarm: "feat", goal: "next", sessionId: "S" });
    const d = reserveSpawn(db, cfg, { agentType: "swarm-feat-coder", sessionId: "S" });
    expect(d?.decision).toBe("deny");
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

  it("#7 hand-over respects deps and pipeline stages", () => {
    fresh("unused");
    const line = cfg.swarms.find((s) => s.name === "line")!;
    const run = startRun(db, cfg, { swarm: "line", goal: "pipe", sessionId: "P" });
    const [, b] = addTasks(db, { root }, run, line, coord(), [
      { title: "plan", role: "plan" },
      { title: "build", role: "build" },
    ]);
    reserveSpawn(db, cfg, {
      agentType: "swarm-line-build",
      prompt: `task #${b!.id}`,
      sessionId: "P",
    });
    const w = registerWorker(db, cfg, {
      agentId: "PB",
      agentType: "swarm-line-build",
      sessionId: "P",
    });
    expect(w?.task).toBeUndefined();
    expect(w?.handoffNote).toMatch(/earlier stages/);
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
