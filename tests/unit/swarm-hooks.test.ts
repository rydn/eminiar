import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookInput } from "../../src/hooks/types.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { activeSwarmConfig, resetSwarmConfigCache } from "../../src/swarm/config.js";
import { coordinationRoot } from "../../src/swarm/hooks.js";
import { verifyCaller } from "../../src/swarm/identity.js";
import { addTasks, callerOf, claimTask, startRun } from "../../src/swarm/runtime.js";

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
      tester:
        description: tests code
`;

const PREFIX = /^Use the eminiar tools/;
const SWARM_TOOL = "mcp__plugin_eminiar_eminiar__em_swarm";

/** A project root with enforce routing (no context-mode deferral), optionally a swarm file. */
function project(name: string, swarmYaml?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `em-swh-${name}-`)));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  if (swarmYaml !== undefined) {
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), swarmYaml);
  }
  return root;
}

const input = (root: string, over: Partial<HookInput>): HookInput => ({
  session_id: "s1",
  cwd: root,
  hook_event_name: "x",
  ...over,
});

const dbOf = (root: string): StorageAdapter => getStorage(getContext(root), { vectors: false });

/** Give the project brief some content, so briefFor visibly adds to a subagent prompt. */
function seedBrief(root: string): void {
  const db = dbOf(root);
  db.graphUpsertNodes([
    {
      id: "file:src/x.ts",
      kind: "file",
      name: "src/x.ts",
      path: "src/x.ts",
      source: "tree-sitter",
    },
  ]);
  db.metricsReplace([
    {
      node_id: "file:src/x.ts",
      kind: "file",
      path: "src/x.ts",
      fan_in: 3,
      fan_out: 0,
      loc: 9,
      complexity: 1,
      commits_90d: 2,
      score: 0.8,
      cluster: 0,
    },
  ]);
}

const unmarks: Array<() => void> = [];
const mode = process.env.EMINIAR_ROUTING_MODE;

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-swh-home-"));
  process.env.EMINIAR_ROUTING_MODE = "enforce";
  resetContextCache();
  resetSwarmConfigCache();
});
afterAll(() => {
  for (const u of unmarks) u();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  if (mode === undefined) delete process.env.EMINIAR_ROUTING_MODE;
  else process.env.EMINIAR_ROUTING_MODE = mode;
});

describe("swarm hooks without a swarm file", () => {
  let root: string;
  beforeAll(() => {
    root = project("plain");
    unmarks.push(markServerAlive(getContext(root)));
    seedBrief(root);
  });

  it("leaves every hook path as it was and records nothing", async () => {
    const spawn = await handlers.PreToolUse!(
      input(root, {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "swarm-feat-coder", prompt: "do task #1" },
      }),
    );
    expect(spawn?.hookSpecificOutput?.permissionDecision).toBe("allow");
    const prompt = String(spawn?.hookSpecificOutput?.updatedInput?.prompt);
    expect(prompt).toMatch(PREFIX);
    // not a swarm worker here, so the usual prompt brief is still attached
    expect(prompt).toContain("Project brief (eminiar)");

    expect(
      await handlers.SubagentStart!(
        input(root, {
          hook_event_name: "SubagentStart",
          agent_id: "agent-p1",
          agent_type: "swarm-feat-coder",
        }),
      ),
    ).toBeUndefined();
    await handlers.PostToolUse!(
      input(root, {
        hook_event_name: "PostToolUse",
        agent_id: "agent-p1",
        agent_type: "swarm-feat-coder",
        tool_name: "Edit",
        tool_input: { file_path: join(root, "src/a.ts") },
        tool_response: {},
      }),
    );
    await handlers.SubagentStop!(
      input(root, {
        hook_event_name: "SubagentStop",
        agent_id: "agent-p1",
        agent_type: "swarm-feat-coder",
        last_assistant_message: "done",
      }),
    );
    const start = await handlers.SessionStart!(
      input(root, { hook_event_name: "SessionStart", source: "startup" }),
    );
    const text = String(start?.hookSpecificOutput?.additionalContext);
    expect(text).toContain("eminiar is active (routing: enforce)");
    expect(text).not.toContain("eminiar swarm");
    expect(existsSync(join(root, ".claude", "agents"))).toBe(false);

    const db = dbOf(root);
    expect(db.swarm.runs()).toEqual([]);
    expect(db.swarm.workerFind("agent-p1")).toBeUndefined();
  });
});

describe("swarm hooks for an opted-in project", () => {
  let root: string;
  let db: StorageAdapter;
  let taskId: number;
  let runId: string;

  beforeAll(() => {
    root = project("on", BASIC);
    unmarks.push(markServerAlive(getContext(root)));
    seedBrief(root);
    db = dbOf(root);
  });

  it("syncs the agent files at SessionStart and names the swarms", async () => {
    const start = await handlers.SessionStart!(
      input(root, { hook_event_name: "SessionStart", source: "startup" }),
    );
    const text = String(start?.hookSpecificOutput?.additionalContext);
    expect(text).toContain(
      "eminiar swarms (.eminiar/swarm.yaml): feat (hierarchical: coder, tester)",
    );
    expect(text).toContain("Agent files were regenerated (2 changed)");
    expect(text).toContain("/eminiar:em-swarm <swarm> <goal>");
    expect(existsSync(join(root, ".claude", "agents", "swarm-feat-coder.md"))).toBe(true);
    expect(existsSync(join(root, ".claude", "agents", "swarm-feat-tester.md"))).toBe(true);
    const line = text.split("\n\n").find((p) => p.startsWith("eminiar swarms"))!;
    expect(line.length).toBeLessThanOrEqual(600);

    // unchanged YAML: nothing regenerated, no restart hint
    const again = await handlers.SessionStart!(
      input(root, { hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(String(again?.hookSpecificOutput?.additionalContext)).not.toContain("regenerated");
  });

  it("reserves the spawn, briefs the worker at SubagentStart (once) and lets it claim", async () => {
    const cfg = activeSwarmConfig(root)!;
    const run = startRun(db, cfg, { swarm: "feat", goal: "add a widget", sessionId: "s1" });
    runId = run.id;
    const [task] = addTasks(db, { root }, run, cfg.swarms[0]!, callerOf(cfg, {}), [
      { title: "implement the widget", role: "coder", files: ["src/w.ts"] },
    ]);
    taskId = task!.id;

    const prompt = `Work on task #${taskId}.`;
    const spawn = await handlers.PreToolUse!(
      input(root, {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "swarm-feat-coder", description: "widget", prompt },
        tool_use_id: "toolu_spawn1",
      }),
    );
    expect(spawn?.hookSpecificOutput?.permissionDecision).toBe("allow");
    const updated = String(spawn?.hookSpecificOutput?.updatedInput?.prompt);
    // the routing prefix stays, the prompt brief does not (SubagentStart briefs the worker)
    expect(updated).toMatch(PREFIX);
    expect(updated).not.toContain("Project brief (eminiar)");
    expect(updated.endsWith(prompt)).toBe(true);
    expect(spawn?.hookSpecificOutput?.updatedInput?.subagent_type).toBe("swarm-feat-coder");
    expect(db.swarm.spawnsPending(run.id, 0)).toBe(1);

    const started = await handlers.SubagentStart!(
      input(root, {
        hook_event_name: "SubagentStart",
        agent_id: "agent-w1",
        agent_type: "swarm-feat-coder",
      }),
    );
    expect(started?.hookSpecificOutput?.hookEventName).toBe("SubagentStart");
    const brief = String(started?.hookSpecificOutput?.additionalContext);
    expect(brief.split("\n")[0]).toBe(`## eminiar swarm worker: swarm-feat-coder · run ${run.id}`);
    // no hand-over at start: the brief tells the worker to claim the task its prompt names
    expect(brief).toContain('claim it first with em_swarm {action:"claim", task:N}');
    expect(brief).toContain(`#${taskId} implement the widget`);
    expect(db.swarm.taskGet(taskId)).toMatchObject({ status: "pending" });
    expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
    claimTask(
      db,
      run,
      cfg.swarms[0]!,
      callerOf(cfg, { agentId: "agent-w1", agentType: "swarm-feat-coder" }),
      taskId,
    );
    expect(db.swarm.workerGet(run.id, "agent-w1")?.task_id).toBe(taskId);
    // the Agent call returning has nothing left to release
    await handlers.PostToolUse!(
      input(root, {
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_use_id: "toolu_spawn1",
        tool_input: { subagent_type: "swarm-feat-coder", prompt },
        tool_response: {},
      }),
    );
    expect(db.swarm.spawnsPendingOfSwarm("feat", 0)).toBe(0);

    // a non-swarm subagent gets nothing from SubagentStart
    expect(
      await handlers.SubagentStart!(
        input(root, { hook_event_name: "SubagentStart", agent_id: "a-x", agent_type: "Explore" }),
      ),
    ).toBeUndefined();
  });

  it("denies spawns over the role count and over max_agents", async () => {
    const spawn = (type: string) =>
      handlers.PreToolUse!(
        input(root, {
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: type, prompt: "help out" },
        }),
      );
    // coder: one running (agent-w1) + this reservation = count 2
    expect((await spawn("swarm-feat-coder"))?.hookSpecificOutput?.permissionDecision).toBe("allow");
    const third = await spawn("swarm-feat-coder");
    expect(third?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(third?.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /^eminiar swarm: role "coder".*count is 2/,
    );
    expect(third?.hookSpecificOutput?.updatedInput).toBeUndefined();
    // the swarm: 1 running + 1 starting + this one = max_agents 3
    expect((await spawn("swarm-feat-tester"))?.hookSpecificOutput?.permissionDecision).toBe(
      "allow",
    );
    const over = await spawn("swarm-feat-tester");
    expect(over?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(over?.hookSpecificOutput?.permissionDecisionReason).toMatch(/max_agents is 3/);
    expect(db.swarm.events(runId).filter((e) => e.kind === "deny")).toHaveLength(2);
  });

  it("stamps em_swarm calls from a worker and strips forged caller fields from the coordinator", async () => {
    const call = (over: Partial<HookInput>, tool_input: Record<string, unknown>) =>
      handlers.PreToolUse!(
        input(root, { hook_event_name: "PreToolUse", tool_name: SWARM_TOOL, tool_input, ...over }),
      );
    const stamped = await call(
      { agent_id: "agent-w1", agent_type: "swarm-feat-coder" },
      {
        action: "update",
        task: taskId,
        status: "done",
        caller_agent_id: "agent-forged",
        caller_kind: "main",
      },
    );
    expect(stamped?.hookSpecificOutput?.permissionDecision).toBe("allow");
    const up = stamped?.hookSpecificOutput?.updatedInput as Record<string, unknown>;
    expect(up).toMatchObject({
      action: "update",
      task: taskId,
      status: "done",
      caller_kind: "agent",
      caller_agent_id: "agent-w1",
      caller_agent_type: "swarm-feat-coder",
    });
    expect(verifyCaller(up)).toMatchObject({ verified: true, kind: "agent", agentId: "agent-w1" });
    // a stamp the model writes itself does not verify
    expect(
      verifyCaller({
        caller_kind: "agent",
        caller_agent_id: "agent-w1",
        caller_sig: "00".repeat(32),
      }).verified,
    ).toBe(false);
    // the settings-install name form is stamped too; another server's em_swarm is not
    const settings = await handlers.PreToolUse!(
      input(root, {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__eminiar__em_swarm",
        agent_id: "agent-w1",
        agent_type: "swarm-feat-coder",
        tool_input: { action: "status" },
      }),
    );
    expect(settings?.hookSpecificOutput?.updatedInput?.caller_agent_id).toBe("agent-w1");
    const foreign = await handlers.PreToolUse!(
      input(root, {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__evil__em_swarm",
        agent_id: "agent-w1",
        agent_type: "swarm-feat-coder",
        tool_input: { action: "status" },
      }),
    );
    expect(foreign?.hookSpecificOutput?.updatedInput).toBeUndefined();

    // the coordinator cannot pose as a worker: its call is stamped as the main session
    const forged = await call(
      {},
      { action: "finish", status: "done", caller_agent_id: "agent-w1", caller_agent_type: "x" },
    );
    const fin = forged?.hookSpecificOutput?.updatedInput as Record<string, unknown>;
    expect(fin.caller_agent_id).toBeUndefined();
    expect(verifyCaller(fin)).toMatchObject({ verified: true, kind: "main", sessionId: "s1" });
    expect(
      db
        .eventsBySession("s1", { categories: ["routing"] })
        .filter((e) => e.payload.includes("em_swarm")),
    ).toEqual([]);
  });

  it("records a worker's tool calls and failures", async () => {
    await handlers.PostToolUse!(
      input(root, {
        hook_event_name: "PostToolUse",
        agent_id: "agent-w1",
        agent_type: "swarm-feat-coder",
        tool_name: "Edit",
        tool_input: { file_path: join(root, "src/w.ts") },
        tool_response: {},
      }),
    );
    await handlers.PostToolUseFailure!(
      input(root, {
        hook_event_name: "PostToolUseFailure",
        agent_id: "agent-w1",
        agent_type: "swarm-feat-coder",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        error: "exit 1: 2 failing",
      }),
    );
    const w = db.swarm.workerGet(runId, "agent-w1")!;
    expect(w.tool_calls).toBe(2);
    expect(w.errors).toBe(1);
    const events = db.swarm.events(runId, { limit: 50 });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tool", text: "Edit src/w.ts", task_id: taskId }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tool_error", text: "Bash npm test ✗ exit 1: 2 failing" }),
    );
  });

  it("closes the worker at SubagentStop and auto-closes the task it still held", async () => {
    await handlers.SubagentStop!(
      input(root, {
        hook_event_name: "SubagentStop",
        agent_id: "agent-w1",
        agent_type: "swarm-feat-coder",
        last_assistant_message: "Implemented the widget in src/w.ts; tests pass.",
      }),
    );
    expect(db.swarm.taskGet(taskId)).toMatchObject({
      status: "done",
      auto_closed: true,
      result: "Implemented the widget in src/w.ts; tests pass.",
    });
    expect(db.swarm.workerGet(runId, "agent-w1")).toMatchObject({ status: "done", task_id: null });

    const start = await handlers.SessionStart!(
      input(root, { hook_event_name: "SessionStart", source: "resume" }),
    );
    expect(String(start?.hookSpecificOutput?.additionalContext)).toContain(
      `Active run ${runId} of "feat": add a widget (0 pending, 0 active, 1 done)`,
    );
  });
});

describe("swarm hooks with an invalid swarm file", () => {
  it("warns once at SessionStart and keeps every other path a no-op", async () => {
    const root = project(
      "bad",
      "swarms:\n  s:\n    description: d\n    max_agent: 3\n    agents:\n      a: { description: x }\n",
    );
    unmarks.push(markServerAlive(getContext(root)));
    const start = await handlers.SessionStart!(
      input(root, { hook_event_name: "SessionStart", source: "startup" }),
    );
    const text = String(start?.hookSpecificOutput?.additionalContext);
    expect(text).toMatch(
      /eminiar swarm: \.eminiar\/swarm\.yaml is invalid, so swarms are off\. swarms\.s \(line \d+\): /,
    );
    expect(text).toContain("eminiar is active");
    const spawn = await handlers.PreToolUse!(
      input(root, {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "swarm-s-a", prompt: "x" },
      }),
    );
    expect(spawn?.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(
      await handlers.SubagentStart!(
        input(root, { hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "swarm-s-a" }),
      ),
    ).toBeUndefined();
    expect(dbOf(root).swarm.runs()).toEqual([]);

    const syntax = project("syntax", "swarms: [unclosed");
    const s = await handlers.SessionStart!(
      input(syntax, { hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(String(s?.hookSpecificOutput?.additionalContext)).toMatch(
      /swarm\.yaml is invalid.*\(file\) \(line 1\)/,
    );
  });
});

describe("swarm hooks in a git worktree", () => {
  let main: string;
  let wt: string;

  beforeAll(() => {
    main = realpathSync(mkdtempSync(join(tmpdir(), "em-swh-main-")));
    mkdirSync(join(main, ".git", "worktrees", "x"), { recursive: true });
    // git writes commondir into every linked worktree's gitdir
    writeFileSync(join(main, ".git", "worktrees", "x", "commondir"), "../..\n");
    mkdirSync(join(main, ".eminiar"), { recursive: true });
    writeFileSync(join(main, ".eminiar", "swarm.yaml"), BASIC);
    // what `git worktree add` leaves: a .git file pointing into <main>/.git/worktrees/<name>
    wt = join(main, ".claude", "worktrees", "x");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "x")}\n`);
  });

  it("maps a worktree to its main checkout and nothing else", () => {
    expect(coordinationRoot(wt)).toBe(main);
    expect(coordinationRoot(main)).toBe(main);
    const relative = realpathSync(mkdtempSync(join(tmpdir(), "em-swh-rel-")));
    writeFileSync(join(relative, ".git"), "gitdir: ../nowhere/.git/worktrees/y\n");
    expect(coordinationRoot(relative)).toBe(relative); // target does not exist
    const sub = realpathSync(mkdtempSync(join(tmpdir(), "em-swh-sub-")));
    mkdirSync(join(main, ".git", "modules", "sub"), { recursive: true });
    writeFileSync(join(sub, ".git"), `gitdir: ${join(main, ".git", "modules", "sub")}\n`);
    expect(coordinationRoot(sub)).toBe(sub); // a submodule is its own project
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "em-swh-none-")));
    expect(coordinationRoot(plain)).toBe(plain);
  });

  it("maps real git worktrees; separate git dirs keep their own ledger", () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        stdio: "ignore",
      });
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
      return; // no git on this machine
    }
    const base = realpathSync(mkdtempSync(join(tmpdir(), "em-swh-sep-")));
    const repo = join(base, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "--separate-git-dir", join(base, "sep.git"));
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", join(base, "w"));
    // git cannot name the main checkout of a separate-git-dir repository, so the worktree
    // keeps its own ledger instead of pointing at the git dir (documented limitation)
    expect(coordinationRoot(join(base, "w"))).toBe(join(base, "w"));
    // a worktree of an ordinary repository maps to the main checkout
    const plainRepo = join(base, "plain");
    mkdirSync(plainRepo);
    git(plainRepo, "init", "-q");
    writeFileSync(join(plainRepo, "a.txt"), "a");
    git(plainRepo, "add", ".");
    git(plainRepo, "commit", "-qm", "init");
    git(plainRepo, "worktree", "add", "-q", join(base, "pw"));
    expect(coordinationRoot(join(base, "pw"))).toBe(plainRepo);
  });

  it("registers an isolated worker in the main checkout's ledger", async () => {
    const wtRoot = getContext(wt).root;
    expect(wtRoot).toBe(realpathSync(wt));
    const started = await handlers.SubagentStart!(
      input(wt, {
        hook_event_name: "SubagentStart",
        agent_id: "agent-wt",
        agent_type: "swarm-feat-tester",
      }),
    );
    const brief = String(started?.hookSpecificOutput?.additionalContext);
    expect(brief).toContain("You work in a git worktree");
    const mainDb = dbOf(main);
    const w = mainDb.swarm.workerFind("agent-wt");
    expect(w?.role).toBe("tester");
    // the worktree's own database stays clean
    expect(dbOf(wt).swarm.workerFind("agent-wt")).toBeUndefined();

    await handlers.PostToolUse!(
      input(wt, {
        hook_event_name: "PostToolUse",
        agent_id: "agent-wt",
        agent_type: "swarm-feat-tester",
        tool_name: "Edit",
        tool_input: { file_path: join(wtRoot, "src", "b.ts") },
        tool_response: {},
      }),
    );
    // paths are shown relative to the worker's checkout
    expect(mainDb.swarm.events(w!.run_id, { limit: 50 })).toContainEqual(
      expect.objectContaining({ kind: "tool", text: "Edit src/b.ts" }),
    );
    await handlers.SubagentStop!(
      input(wt, {
        hook_event_name: "SubagentStop",
        agent_id: "agent-wt",
        agent_type: "swarm-feat-tester",
        last_assistant_message: "no tests needed",
      }),
    );
    expect(mainDb.swarm.workerGet(w!.run_id, "agent-wt")?.status).toBe("done");
  });
});
