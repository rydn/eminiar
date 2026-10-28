import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { dispatch, gate } from "../../src/hooks/dispatch.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookInput } from "../../src/hooks/types.js";
import { paths } from "../../src/paths.js";
import { resolveProjectRoot } from "../../src/project.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { activeSwarmConfig, resetSwarmConfigCache } from "../../src/swarm/config.js";
import { coordinationRoot, failedText, notWorkerText } from "../../src/swarm/hooks.js";
import { verifyCaller } from "../../src/swarm/identity.js";
import { addTasks, callerOf, claimTask, startRun } from "../../src/swarm/runtime.js";

/** Fault injection for the storage layer: the enforcement fail-closed paths. */
const storageFault = vi.hoisted(() => ({ mode: "" as "" | "throw" | "busy" | "swarm" }));
vi.mock("../../src/storage/index.js", async (orig) => {
  const m = await orig<typeof import("../../src/storage/index.js")>();
  return {
    ...m,
    getStorage: (...args: Parameters<typeof m.getStorage>) => {
      if (storageFault.mode === "throw") throw new Error("disk on fire\nsecond line");
      if (storageFault.mode === "busy")
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      const db = m.getStorage(...args);
      if (storageFault.mode === "swarm")
        return new Proxy(db, {
          get: (t, prop, r) => {
            if (prop === "swarm") throw new Error("ledger broke");
            return Reflect.get(t, prop, r);
          },
        });
      return db;
    },
  };
});

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
const sessionEnv = {
  EMINIAR_PROJECT_ROOT: process.env.EMINIAR_PROJECT_ROOT,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};
/** Point the session project root at `root` (undefined: an empty dir, never the eminiar repo). */
function sessionRoot(root?: string): void {
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.EMINIAR_PROJECT_ROOT =
    root ?? realpathSync(mkdtempSync(join(tmpdir(), "em-swh-session-")));
}

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-swh-home-"));
  process.env.EMINIAR_ROUTING_MODE = "enforce";
  sessionRoot();
  resetContextCache();
  resetSwarmConfigCache();
});
afterAll(() => {
  for (const u of unmarks) u();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  for (const [k, v] of Object.entries(sessionEnv))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
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
    sessionRoot(root);
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

  it("names the session root on an em_swarm call without a project_root, and never overrides one", async () => {
    sessionRoot(root);
    try {
      const call = (tool_input: Record<string, unknown>) =>
        handlers.PreToolUse!(
          input(root, { hook_event_name: "PreToolUse", tool_name: SWARM_TOOL, tool_input }),
        );
      const plain = (await call({ action: "status" }))?.hookSpecificOutput?.updatedInput as Record<
        string,
        unknown
      >;
      // in a normal session this is the root the server resolves for the same project
      expect(plain.project_root).toBe(resolveProjectRoot());
      expect(plain.project_root).toBe(realpathSync(root));
      expect(verifyCaller(plain).verified).toBe(true);
      const explicit = (await call({ action: "status", project_root: "/some/other" }))
        ?.hookSpecificOutput?.updatedInput as Record<string, unknown>;
      expect(explicit.project_root).toBe("/some/other");
    } finally {
      sessionRoot();
    }
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
    sessionRoot(root);
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
    sessionRoot(root);
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
    sessionRoot(syntax);
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

describe("swarm hooks when the shell cwd drifts into a nested repository", () => {
  it("resolves the workspace swarm from the session root, not the hook cwd", async () => {
    const ws = project("ws", BASIC);
    const sub = join(ws, "backend");
    mkdirSync(join(sub, ".git"), { recursive: true });
    writeFileSync(join(sub, "package.json"), "{}");
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      unmarks.push(markServerAlive(getContext(ws)));
      const db = dbOf(ws);
      const cfg = activeSwarmConfig(ws)!;
      const run = startRun(db, cfg, { swarm: "feat", goal: "drift", sessionId: "s1" });
      // every hook arrives with the nested repository as its cwd
      const spawn = await handlers.PreToolUse!(
        input(sub, {
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "swarm-feat-coder", prompt: "go" },
          tool_use_id: "toolu_drift1",
        }),
      );
      expect(spawn?.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(db.swarm.spawnsPending(run.id, 0)).toBe(1);
      await handlers.SubagentStart!(
        input(sub, {
          hook_event_name: "SubagentStart",
          agent_id: "agent-d1",
          agent_type: "swarm-feat-coder",
        }),
      );
      expect(db.swarm.workerGet(run.id, "agent-d1")).toBeDefined();
      await handlers.PostToolUse!(
        input(sub, {
          hook_event_name: "PostToolUse",
          agent_id: "agent-d1",
          agent_type: "swarm-feat-coder",
          tool_name: "Read",
          tool_input: { file_path: "src/a.ts" },
        }),
      );
      expect(db.swarm.workerGet(run.id, "agent-d1")?.tool_calls).toBe(1);
      const start = await handlers.SessionStart!(
        input(sub, { hook_event_name: "SessionStart", source: "startup" }),
      );
      expect(String(start?.hookSpecificOutput?.additionalContext)).toContain("eminiar swarms");
      // with no session root the drifted cwd sees nothing (the old behaviour, now the fallback)
      sessionRoot();
      resetContextCache();
      const none = await handlers.PreToolUse!(
        input(sub, {
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: { subagent_type: "swarm-feat-tester", prompt: "go" },
          tool_use_id: "toolu_drift2",
        }),
      );
      expect(none?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
      expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });
});

describe("swarm enforcement in PreToolUse(Agent)", () => {
  const agent = (cwd: string, type: string | undefined, over: Partial<HookInput> = {}) =>
    handlers.PreToolUse!(
      input(cwd, {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: type === undefined ? { prompt: "go" } : { subagent_type: type, prompt: "go" },
        tool_use_id: `toolu_enf_${Math.random()}`,
        ...over,
      }),
    );

  it("denies non-workers, needs a run for workers, and survives a cd into a sub-repo", async () => {
    const ws = project("enf", `${BASIC}enforce: true\nallowed_agents: [statusline-setup]\n`);
    const sub = join(ws, "sub");
    mkdirSync(join(sub, ".git"), { recursive: true });
    writeFileSync(join(sub, "package.json"), "{}");
    mkdirSync(join(sub, ".eminiar"));
    writeFileSync(join(sub, ".eminiar", "swarm.yaml"), BASIC); // its own, non-enforcing
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      unmarks.push(markServerAlive(getContext(ws)));
      for (const cwd of [ws, sub]) {
        for (const t of ["Explore", "general-purpose", "swarm-gone-x", undefined]) {
          const r = await agent(cwd, t);
          expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
          expect(r?.hookSpecificOutput?.permissionDecisionReason).toMatch(
            /^eminiar swarm enforcement:.*enforce: false/s,
          );
        }
      }
      expect(
        (await agent(sub, "statusline-setup"))?.hookSpecificOutput?.permissionDecision,
      ).not.toBe("deny");
      // a subagent's own calls are enforced too: only the allow-list passes, workers are leaves
      for (const t of ["Explore", "swarm-feat-coder"]) {
        const inner = await agent(ws, t, { agent_id: "a1", agent_type: "swarm-feat-coder" });
        expect(inner?.hookSpecificOutput?.permissionDecision).toBe("deny");
        expect(inner?.hookSpecificOutput?.permissionDecisionReason).toMatch(
          /^eminiar swarm enforcement:.*cannot be started from inside a subagent.*report back to the main session.*em_swarm \{action:"plan"\}.*statusline-setup/s,
        );
      }
      expect(
        (await agent(ws, "statusline-setup", { agent_id: "a1" }))?.hookSpecificOutput
          ?.permissionDecision,
      ).not.toBe("deny");
      // Cursor is not enforced
      const cur = await agent(ws, "Explore", { client: "cursor" });
      expect(cur?.hookSpecificOutput?.permissionDecision).not.toBe("deny");
      // a configured worker without a run: denied, nothing reserved
      const db = dbOf(ws);
      const noRun = await agent(sub, "swarm-feat-coder");
      expect(noRun?.hookSpecificOutput?.permissionDecisionReason).toContain("has no active run");
      const cfg = activeSwarmConfig(ws)!;
      const run = startRun(db, cfg, { swarm: "feat", goal: "g", sessionId: "s1" });
      expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
      const ok = await agent(sub, "swarm-feat-coder");
      expect(ok?.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(db.swarm.spawnsPending(run.id, 0)).toBe(1);
      // an invalid file that asks for enforcement denies everything
      writeFileSync(join(ws, ".eminiar", "swarm.yaml"), "enforce: true\nswarms: [oops\n");
      resetSwarmConfigCache();
      const bad = await agent(ws, "swarm-feat-coder");
      expect(bad?.hookSpecificOutput?.permissionDecisionReason).toContain("is invalid");
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });

  const subRepo = (ws: string, yaml: string): string => {
    const sub = join(ws, "sub");
    mkdirSync(join(sub, ".git"), { recursive: true });
    writeFileSync(join(sub, "package.json"), "{}");
    mkdirSync(join(sub, ".eminiar"));
    writeFileSync(join(sub, ".eminiar", "swarm.yaml"), yaml);
    return sub;
  };
  const decision = (r: Awaited<ReturnType<typeof agent>>) =>
    r?.hookSpecificOutput?.permissionDecision;

  it("lets CLAUDE_PROJECT_DIR win over an inherited EMINIAR_PROJECT_ROOT", async () => {
    const a = project("enf-env-a", `${BASIC}enforce: true\n`);
    const b = project("enf-env-b"); // no swarm file
    const savedClaude = process.env.CLAUDE_PROJECT_DIR;
    try {
      process.env.EMINIAR_PROJECT_ROOT = a;
      process.env.CLAUDE_PROJECT_DIR = b;
      resetContextCache();
      resetSwarmConfigCache();
      expect(decision(await agent(b, "Explore"))).not.toBe("deny");
      // with CLAUDE_PROJECT_DIR gone, EMINIAR_PROJECT_ROOT is the fallback
      delete process.env.CLAUDE_PROJECT_DIR;
      expect(decision(await agent(b, "Explore"))).toBe("deny");
    } finally {
      if (savedClaude !== undefined) process.env.CLAUDE_PROJECT_DIR = savedClaude;
      sessionRoot();
      resetContextCache();
      resetSwarmConfigCache();
    }
  });

  it("lets the first candidate with a swarm file decide: workspace enforcing, sub-repo not", async () => {
    const ws = project("enf-gov1", `${BASIC}enforce: true\n`);
    const sub = subRepo(ws, BASIC);
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      unmarks.push(markServerAlive(getContext(ws)));
      for (const cwd of [ws, sub]) expect(decision(await agent(cwd, "Explore"))).toBe("deny");
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });

  it("lets the first candidate with a swarm file decide: workspace not enforcing, sub-repo enforcing", async () => {
    const ws = project("enf-gov2", BASIC);
    const sub = subRepo(ws, `${BASIC}enforce: true\n`);
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      unmarks.push(markServerAlive(getContext(ws)));
      for (const cwd of [ws, sub]) {
        expect(decision(await agent(cwd, "Explore"))).not.toBe("deny");
        // the workspace's own workers are not denied for lack of a run either
        expect(decision(await agent(cwd, "swarm-feat-coder"))).not.toBe("deny");
      }
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });

  it("ignores an enforcing sub-repo the cwd drifted into when the session root has no swarm file", async () => {
    const ws = project("enf-nofile");
    const sub = subRepo(ws, `${BASIC}enforce: true\n`);
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      unmarks.push(markServerAlive(getContext(ws)));
      expect(decision(await agent(sub, "Explore"))).not.toBe("deny");
      const start = await handlers.SessionStart!(
        input(sub, { hook_event_name: "SessionStart", source: "startup" }),
      );
      expect(String(start?.hookSpecificOutput?.additionalContext ?? "")).not.toContain(
        "Swarm enforcement is on",
      );
      expect(existsSync(join(sub, ".claude", "agents"))).toBe(false);
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });

  it("writes nothing into an enforcing sub-repo when the session root has swarms disabled", async () => {
    const ws = project("enf-disabled", `${BASIC}enabled: false\n`);
    const sub = subRepo(ws, `${BASIC}enforce: true\n`);
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      unmarks.push(markServerAlive(getContext(ws)));
      expect(decision(await agent(sub, "Explore"))).not.toBe("deny");
      const start = await handlers.SessionStart!(
        input(sub, { hook_event_name: "SessionStart", source: "startup" }),
      );
      expect(String(start?.hookSpecificOutput?.additionalContext ?? "")).not.toContain(
        "Swarm enforcement is on",
      );
      expect(existsSync(join(sub, ".claude", "agents"))).toBe(false);
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });

  it("releases a reservation made under a type with stray whitespace", async () => {
    const ws = project("enf-trim", `${BASIC}enforce: true\n`);
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      unmarks.push(markServerAlive(getContext(ws)));
      const db = dbOf(ws);
      const run = startRun(db, activeSwarmConfig(ws)!, {
        swarm: "feat",
        goal: "g",
        sessionId: "s1",
      });
      const tool_use_id = "toolu_trim";
      const sloppy = await agent(ws, "swarm-feat-coder ", { tool_use_id });
      expect(decision(sloppy)).toBe("allow");
      expect(db.swarm.spawnsPending(run.id, 0)).toBe(1);
      await handlers.PostToolUseFailure!(
        input(ws, {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Agent",
          tool_input: { subagent_type: "swarm-feat-coder ", prompt: "go" },
          tool_use_id,
          error: "boom",
        }),
      );
      expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
      expect(decision(await agent(ws, "swarm-feat-coder"))).toBe("allow");
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });
});

describe("notWorkerText with many long swarm descriptions", () => {
  it("keeps the closing escape-hatch sentence", () => {
    const swarms = Array.from({ length: 8 }, (_, i) => ({
      name: `swarm${i}`,
      description: "d".repeat(400),
      roles: Array.from({ length: 6 }, (_, j) => ({
        agentType: `swarm-swarm${i}-role-number-${j}`,
      })),
    }));
    const text = notWorkerText(
      { swarms, rel: ".eminiar/swarm.yaml", allowedAgents: [] } as never,
      "Explore",
      'Start a run first: em_swarm {action:"start", swarm:"<swarm>", goal:"<goal>"}.',
    );
    expect(text.length).toBeLessThanOrEqual(1800);
    expect(text).toContain("enforce: false");
    expect(text).toContain("Start a run first");
    expect(text.startsWith("eminiar swarm enforcement:")).toBe(true);
  });
});

describe("em-hook --gate (decide only)", () => {
  const payload = (cwd: string, type: string | undefined, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: type === undefined ? { prompt: "go" } : { subagent_type: type, prompt: "go" },
      tool_use_id: "toolu_gate",
      ...over,
    });
  const decision = (out: string): string | undefined =>
    JSON.parse(out).hookSpecificOutput?.permissionDecision;

  it("denies non-workers, passes workers and the allow-list, and writes nothing", () => {
    const ws = project("gate", `${BASIC}enforce: true\nallowed_agents: [statusline-setup]\n`);
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      const denied = JSON.parse(gate(payload(ws, "Explore")));
      expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(
        /^eminiar swarm enforcement:.*enforce: false/s,
      );
      expect(decision(gate(payload(ws, undefined)))).toBe("deny");
      // a configured worker is the plugin hook's business (run, capacity): the gate allows it
      expect(gate(payload(ws, "swarm-feat-coder"))).toBe("{}");
      expect(gate(payload(ws, "statusline-setup"))).toBe("{}");
      // not applicable
      expect(gate(payload(ws, "Explore", { tool_name: "Bash" }))).toBe("{}");
      const nested = JSON.parse(gate(payload(ws, "swarm-feat-coder", { agent_id: "a1" })));
      expect(nested.hookSpecificOutput.permissionDecisionReason).toMatch(
        /^eminiar swarm enforcement:.*inside a subagent/s,
      );
      expect(gate(payload(ws, "statusline-setup", { agent_id: "a1" }))).toBe("{}");
      expect(gate(payload(ws, "Explore", { client: "cursor" }))).toBe("{}");
      // an invalid enforcing file denies everything
      writeFileSync(join(ws, ".eminiar", "swarm.yaml"), "enforce: true\nswarms: [oops\n");
      resetSwarmConfigCache();
      expect(decision(gate(payload(ws, "swarm-feat-coder")))).toBe("deny");
    } finally {
      sessionRoot();
      resetContextCache();
      resetSwarmConfigCache();
    }
  });

  it("allows when the project does not enforce, and throws on bad input", () => {
    const ws = project("gate-off", BASIC);
    sessionRoot(ws);
    try {
      resetContextCache();
      resetSwarmConfigCache();
      expect(gate(payload(ws, "Explore"))).toBe("{}");
      expect(() => gate("not json")).toThrow();
      expect(() => gate("")).toThrow();
    } finally {
      sessionRoot();
      resetContextCache();
    }
  });

  it("the shim exits 1 in gate mode when node is missing, and 0 with {} otherwise", () => {
    const shim = join(__dirname, "..", "..", "bin", "em-hook");
    const home = mkdtempSync(join(tmpdir(), "em-swh-gatehome-"));
    // a PATH with the shell tools but (hopefully) no node
    if (existsSync("/usr/bin/node") || existsSync("/bin/node")) return;
    // a temp cwd and explicit roots: never this repo's own .eminiar/swarm.yaml
    const cwd = project("gate-shim");
    const run = (args: string[]) =>
      spawnSync("/bin/sh", [shim, ...args], {
        input: payload(cwd, "Explore"),
        encoding: "utf8",
        cwd,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          EMINIAR_HOME: home,
          CLAUDE_PROJECT_DIR: cwd,
          EMINIAR_PROJECT_ROOT: cwd,
        },
      });
    const g = run(["--gate"]);
    expect(g.status).toBe(1);
    expect(g.stdout).toBe("");
    const plain = run([]);
    expect(plain.status).toBe(0);
    expect(plain.stdout.trim()).toBe("{}");
  });
});

describe("em-hook --gate writes nothing", () => {
  const ENF = `${BASIC}enforce: true\n`;
  const payload = (cwd: string, type: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: type, prompt: "go" },
      tool_use_id: "toolu_gatew",
      ...over,
    });
  const projectDbs = (): string[] => {
    const dir = paths().projects;
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((d) => existsSync(join(dir, d, "eminiar.db")));
  };
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env.EMINIAR_HOME;
    closeAllStorage();
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-swh-gatew-"));
    resetContextCache();
    resetSwarmConfigCache();
  });
  afterEach(() => {
    closeAllStorage();
    if (savedHome === undefined) delete process.env.EMINIAR_HOME;
    else process.env.EMINIAR_HOME = savedHome;
    sessionRoot();
    resetContextCache();
    resetSwarmConfigCache();
  });

  it("creates no project database for denies, allows or an invalid file", () => {
    const ws = project("gatew", ENF);
    sessionRoot(ws);
    resetContextCache();
    for (const type of ["Explore", "swarm-feat-coder", "general-purpose"]) gate(payload(ws, type));
    writeFileSync(join(ws, ".eminiar", "swarm.yaml"), "enforce: true\nswarms: [oops\n");
    resetSwarmConfigCache();
    expect(JSON.parse(gate(payload(ws, "Explore"))).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
    expect(projectDbs()).toEqual([]);
    expect(storageFault.mode).toBe("");
  });

  it("adds no spawn row, run or event even with an active run", () => {
    const ws = project("gatew2", ENF);
    sessionRoot(ws);
    resetContextCache();
    resetSwarmConfigCache();
    const db = dbOf(ws);
    const run = startRun(db, activeSwarmConfig(ws)!, { swarm: "feat", goal: "g", sessionId: "s1" });
    expect(projectDbs()).toHaveLength(1); // control: the helper does see a project database
    const runs = db.swarm.runs().length;
    const events = db.swarm.events(run.id, { limit: 1000 }).length;
    for (const type of ["Explore", "swarm-feat-coder", "swarm-feat-tester"])
      gate(payload(ws, type));
    expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
    expect(db.swarm.runs().length).toBe(runs);
    expect(db.swarm.events(run.id, { limit: 1000 }).length).toBe(events);
  });
});

describe("swarm enforcement matrix", () => {
  const ENF = `${BASIC}enforce: true\n`;
  const agent = (cwd: string, type: string | undefined, over: Partial<HookInput> = {}) =>
    handlers.PreToolUse!(
      input(cwd, {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: type === undefined ? { prompt: "go" } : { subagent_type: type, prompt: "go" },
        tool_use_id: `toolu_mx_${Math.random()}`,
        ...over,
      }),
    );
  const decisionOf = (r: Awaited<ReturnType<typeof agent>>) =>
    r?.hookSpecificOutput?.permissionDecision;
  const reasonOf = (r: Awaited<ReturnType<typeof agent>>) =>
    String(r?.hookSpecificOutput?.permissionDecisionReason);
  let savedMode: string | undefined;
  const enter = (ws: string) => {
    sessionRoot(ws);
    resetContextCache();
    resetSwarmConfigCache();
    unmarks.push(markServerAlive(getContext(ws)));
  };
  beforeEach(() => {
    storageFault.mode = "";
    savedMode = process.env.EMINIAR_ROUTING_MODE;
  });
  afterEach(() => {
    storageFault.mode = "";
    if (savedMode === undefined) delete process.env.EMINIAR_ROUTING_MODE;
    else process.env.EMINIAR_ROUTING_MODE = savedMode;
    sessionRoot();
    resetContextCache();
    resetSwarmConfigCache();
  });

  it("denies Plan, fork and plugin agents with the swarms, descriptions and the escape hatch", async () => {
    const ws = project("mx1", ENF);
    enter(ws);
    for (const t of ["Plan", "fork", "plugin:x"]) {
      const r = await agent(ws, t);
      expect(decisionOf(r)).toBe("deny");
      const reason = reasonOf(r);
      expect(reason).toMatch(/^eminiar swarm enforcement: /);
      expect(reason).toContain(`"${t}" is not a swarm worker`);
      expect(reason).toContain("- feat: test swarm");
      expect(reason).toContain("swarm-feat-coder, swarm-feat-tester");
      expect(reason).toContain('em_swarm {action:"start", swarm:"feat"');
      expect(reason).toContain("enforce: false");
      expect(reason).toContain(".eminiar/swarm.yaml");
    }
    // a stale swarm- type reads as a stale agent file
    expect(reasonOf(await agent(ws, "swarm-gone-x"))).toContain("(a stale agent file?)");
  });

  it("names the active run in the deny text instead of the start call", async () => {
    const ws = project("mx2", ENF);
    enter(ws);
    const db = dbOf(ws);
    const run = startRun(db, activeSwarmConfig(ws)!, { swarm: "feat", goal: "g", sessionId: "s1" });
    const reason = reasonOf(await agent(ws, "Explore"));
    expect(reason).toContain(`Run ${run.id} of "feat" is active`);
    expect(reason).not.toContain("Start a run first");
  });

  it("lets general-purpose in allowed_agents also allow an omitted type", async () => {
    const ws = project("mx3", `${ENF}allowed_agents: [general-purpose]\n`);
    enter(ws);
    expect(decisionOf(await agent(ws, undefined))).not.toBe("deny");
    expect(decisionOf(await agent(ws, "general-purpose"))).not.toBe("deny");
    expect(decisionOf(await agent(ws, "  "))).not.toBe("deny"); // blank counts as omitted
    expect(decisionOf(await agent(ws, "Explore"))).toBe("deny");
  });

  it("denies in every routing mode", async () => {
    const ws = project("mx4", ENF);
    writeFileSync(
      join(ws, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "off", deferToContextMode: false } }),
    );
    enter(ws);
    for (const m of ["off", "annotate", "enforce"]) {
      process.env.EMINIAR_ROUTING_MODE = m;
      resetContextCache();
      const r = await agent(ws, "Explore");
      expect(decisionOf(r), m).toBe("deny");
      expect(reasonOf(r)).toMatch(/^eminiar swarm enforcement:/);
    }
  });

  it("fails closed when the ledger cannot be opened or reserved, and says busy when it is busy", async () => {
    const ws = project("mx5", ENF);
    enter(ws);
    const db = dbOf(ws);
    const run = startRun(db, activeSwarmConfig(ws)!, { swarm: "feat", goal: "g", sessionId: "s1" });
    for (const mode of ["throw", "swarm"] as const) {
      storageFault.mode = mode;
      const r = await agent(ws, "swarm-feat-coder");
      expect(decisionOf(r), mode).toBe("deny");
      expect(reasonOf(r)).toBe(failedText(mode === "throw" ? "disk on fire" : "ledger broke"));
      expect(reasonOf(r)).not.toContain("second line");
    }
    storageFault.mode = "busy";
    const busy = await agent(ws, "swarm-feat-coder");
    expect(decisionOf(busy)).toBe("deny");
    expect(reasonOf(busy)).toContain("ledger is busy");
    expect(reasonOf(busy)).toContain("retry");
    storageFault.mode = "";
    expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
    // and the same call goes through once the fault is gone
    expect(decisionOf(await agent(ws, "swarm-feat-coder"))).toBe("allow");
  });

  it("still denies a non-worker when the ledger is down (the run line is best effort)", async () => {
    const ws = project("mx6", ENF);
    enter(ws);
    storageFault.mode = "throw";
    const r = await agent(ws, "Explore");
    expect(decisionOf(r)).toBe("deny");
    expect(reasonOf(r)).toContain('"Explore" is not a swarm worker');
    expect(reasonOf(r)).toContain("If no run is active, start a run first");
  });

  it("denies everything in an invalid enforcing file, with the first issue", async () => {
    const ws = project("mx7", "enforce: true\nmax_agent: 1\nswarms: {}\n");
    enter(ws);
    for (const t of ["Explore", "swarm-feat-coder", undefined]) {
      const r = await agent(ws, t);
      expect(decisionOf(r)).toBe("deny");
      expect(reasonOf(r)).toContain("sets enforce: true but is invalid");
    }
  });

  it("does not enforce when the project does not ask for it: Explore passes and no spawn row is written", async () => {
    for (const [name, yaml] of [
      ["plain-off", BASIC],
      ["allowed-only", `${BASIC}allowed_agents: [statusline-setup]\n`],
      ["disabled", `${BASIC}enabled: false\nenforce: true\n`],
      ["enforce-false", `${BASIC}enforce: false\n`],
    ] as const) {
      const ws = project(`mx8-${name}`, yaml);
      enter(ws);
      const db = dbOf(ws);
      const run =
        name === "disabled"
          ? undefined
          : startRun(db, activeSwarmConfig(ws)!, { swarm: "feat", goal: "g", sessionId: "s1" });
      for (const t of ["Explore", "general-purpose", "Plan", "fork", undefined]) {
        const r = await agent(ws, t);
        expect(decisionOf(r), `${name}/${t}`).not.toBe("deny");
      }
      if (run) {
        expect(db.swarm.spawnsPending(run.id, 0), name).toBe(0);
        expect(db.swarm.runs().length).toBe(1);
      }
    }
    // an invalid file that does not ask for enforcement is not enforced either
    const ws = project("mx8-bad", "swarms: [oops\n");
    enter(ws);
    expect(decisionOf(await agent(ws, "Explore"))).not.toBe("deny");
  });

  it("an invalid file with enabled: false does not deny", async () => {
    const ws = project("mx9", "enabled: false\nenforce: true\nswarms: [oops\n");
    enter(ws);
    expect(decisionOf(await agent(ws, "Explore"))).not.toBe("deny");
  });

  it("the Task tool name is enforced too", async () => {
    const ws = project("mx10", ENF);
    enter(ws);
    const r = await agent(ws, "Explore", { tool_name: "Task" });
    expect(decisionOf(r)).toBe("deny");
  });

  it("SessionStart carries the enforcement sentence only when enforcing", async () => {
    const start = async (ws: string) => {
      enter(ws);
      const r = await handlers.SessionStart!(
        input(ws, { hook_event_name: "SessionStart", source: "startup" }),
      );
      return String(r?.hookSpecificOutput?.additionalContext);
    };
    const on = await start(project("ss1", `${ENF}allowed_agents: [statusline-setup]\n`));
    expect(on).toContain("Swarm enforcement is on:");
    expect(on).toContain("also allowed: statusline-setup");
    expect(on).toContain("Start one with /eminiar:em-swarm");
    const off = await start(project("ss2", BASIC));
    expect(off).toContain("eminiar swarms (");
    expect(off).not.toContain("enforcement");
    const allowedOnly = await start(project("ss3", `${BASIC}allowed_agents: [Explore]\n`));
    expect(allowedOnly).not.toContain("enforcement");
    const broken = await start(project("ss4", "enforce: true\nswarms: [oops\n"));
    expect(broken).toContain("because it sets enforce: true, every subagent is denied");
    const brokenOff = await start(project("ss5", "swarms: [oops\n"));
    expect(brokenOff).toContain("is invalid, so swarms are off.");
    expect(brokenOff).not.toContain("every subagent is denied");
  });
});

describe("dispatch fails closed for enforcement", () => {
  const ENF = `${BASIC}enforce: true\n`;
  const body = (cwd: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "Explore", prompt: "go" },
      tool_use_id: "toolu_fc",
      ...over,
    });
  const original = { pre: handlers.PreToolUse, post: handlers.PostToolUse };
  beforeEach(() => {
    const boom = async () => {
      throw new Error("handler exploded\nstack line");
    };
    handlers.PreToolUse = boom;
    handlers.PostToolUse = boom;
  });
  afterEach(() => {
    handlers.PreToolUse = original.pre!;
    handlers.PostToolUse = original.post!;
    sessionRoot();
    resetContextCache();
    resetSwarmConfigCache();
  });

  it("denies a main-session Agent call in an enforcing project", async () => {
    const ws = project("fc1", ENF);
    sessionRoot(ws);
    resetContextCache();
    resetSwarmConfigCache();
    for (const tool of ["Agent", "Task"]) {
      const out = JSON.parse(await dispatch(body(ws, { tool_name: tool }), []));
      expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toBe(failedText("handler exploded"));
    }
    // enforcement intent is read from the raw file, so an invalid file counts too
    writeFileSync(join(ws, ".eminiar", "swarm.yaml"), "enforce: true\nswarms: [oops\n");
    resetSwarmConfigCache();
    expect(JSON.parse(await dispatch(body(ws), [])).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  it("stays permissive in a non-enforcing project and for everything that is not a main-session Agent call", async () => {
    const off = project("fc2", BASIC);
    sessionRoot(off);
    resetContextCache();
    resetSwarmConfigCache();
    expect(await dispatch(body(off), [])).toBe("{}");
    expect(await dispatch(body(off, { agent_id: "a1" }), [])).toBe("{}");
    const none = project("fc3");
    sessionRoot(none);
    resetContextCache();
    expect(await dispatch(body(none), [])).toBe("{}");

    const ws = project("fc4", ENF);
    sessionRoot(ws);
    resetContextCache();
    resetSwarmConfigCache();
    expect(await dispatch(body(ws, { tool_name: "Bash" }), [])).toBe("{}");
    // a nested call fails closed as well when enforcing
    expect(
      JSON.parse(await dispatch(body(ws, { agent_id: "a1" }), [])).hookSpecificOutput
        .permissionDecision,
    ).toBe("deny");
    expect(await dispatch(body(ws, { hook_event_name: "PostToolUse" }), [])).toBe("{}");
    // a client marker of cursor is never denied by the fallback
    expect(await dispatch(body(ws, { client: "cursor" }), [])).toBe("{}");
  });

  it("never denies a Cursor payload", async () => {
    const ws = project("fc5", ENF);
    sessionRoot(ws);
    resetContextCache();
    resetSwarmConfigCache();
    const cursor = JSON.stringify({
      conversation_id: "c1",
      workspace_roots: [ws],
      hook_event_name: "preToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "Explore", prompt: "go" },
    });
    const out = await dispatch(cursor, []);
    expect(out).not.toContain("swarm enforcement");
    expect(out).not.toContain("deny");
    const viaFlag = await dispatch(body(ws), ["--client", "cursor"]);
    expect(viaFlag).not.toContain("swarm enforcement");
    expect(viaFlag).not.toContain("deny");
  });
});

describe("bin/em-hook end to end", () => {
  const ROOT = join(__dirname, "..", "..");
  const shim = join(ROOT, "bin", "em-hook");
  const built = existsSync(join(ROOT, "dist", "hook.js"));
  const payload = (cwd: string, type: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s1",
      cwd,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: type, prompt: "go" },
      tool_use_id: "toolu_e2e",
      ...over,
    });
  const clean = (): NodeJS.ProcessEnv => {
    const e = { ...process.env };
    for (const k of [
      "EMINIAR_PROJECT_ROOT",
      "CLAUDE_PROJECT_DIR",
      "EMINIAR_ROUTING_MODE",
      "EM_SELF",
    ])
      delete e[k];
    return e;
  };
  const nodeHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), "em-swh-e2ehome-"));
    writeFileSync(join(home, "node-path"), process.execPath);
    return home;
  };

  it.skipIf(!built)(
    "denies a non-worker through the built hook, in gate mode and in the plugin hook",
    () => {
      const ws = project("e2e", `${BASIC}enforce: true\n`);
      const home = nodeHome();
      const env = { ...clean(), EMINIAR_HOME: home, CLAUDE_PROJECT_DIR: ws };
      const run = (args: string[], stdin: string, cwd = ws) =>
        spawnSync("/bin/sh", [shim, ...args], {
          input: stdin,
          encoding: "utf8",
          env,
          cwd,
          timeout: 60_000,
        });
      for (const args of [["--gate"], []]) {
        const r = run(args, payload(ws, "Explore"));
        expect(r.status, `${args} ${r.stderr}`).toBe(0);
        const out = JSON.parse(r.stdout);
        expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
        expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
        expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(
          /^eminiar swarm enforcement: "Explore" is not a swarm worker.*enforce: false/s,
        );
        // the hook cwd drifted into a directory with no swarm file: the session root still governs
        const drift = run(args, payload(tmpdir(), "Explore", { cwd: tmpdir() }), ws);
        expect(JSON.parse(drift.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
      }
      // gate: a configured worker is allowed (the plugin hook owns run and capacity), exit 0 + {}
      const worker = run(["--gate"], payload(ws, "swarm-feat-coder"));
      expect(worker.status).toBe(0);
      expect(worker.stdout.trim()).toBe("{}");
      // the plugin hook denies the same worker for lack of a run
      const noRun = JSON.parse(run([], payload(ws, "swarm-feat-coder")).stdout);
      expect(noRun.hookSpecificOutput.permissionDecisionReason).toContain("has no active run");
      // not applicable
      expect(run(["--gate"], payload(ws, "Explore", { tool_name: "Bash" })).stdout.trim()).toBe(
        "{}",
      );
      expect(
        JSON.parse(run(["--gate"], payload(ws, "Explore", { agent_id: "a1" })).stdout)
          .hookSpecificOutput.permissionDecision,
      ).toBe("deny");
      // gate fails (exit 1, nothing on stdout) on garbage; the plugin hook stays permissive
      const bad = run(["--gate"], "not json");
      expect(bad.status).toBe(1);
      expect(bad.stdout).toBe("");
      const lenient = run([], "not json");
      expect(lenient.status).toBe(0);
      expect(lenient.stdout.trim()).toBe("{}");
    },
  );

  it.skipIf(!built)("allows everything in a project that does not enforce", () => {
    const ws = project("e2e-off", BASIC);
    const env = { ...clean(), EMINIAR_HOME: nodeHome(), CLAUDE_PROJECT_DIR: ws };
    for (const args of [["--gate"], []]) {
      const r = spawnSync("/bin/sh", [shim, ...args], {
        input: payload(ws, "Explore"),
        encoding: "utf8",
        env,
        cwd: ws,
        timeout: 60_000,
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision).not.toBe("deny");
    }
  });

  describe("with no Node.js to run", () => {
    // A PATH holding only the tools the shim needs, so `node` cannot be found anywhere.
    const tools = mkdtempSync(join(tmpdir(), "em-swh-tools-"));
    for (const t of ["cat", "dirname", "grep", "sh", "env"])
      for (const d of ["/usr/bin", "/bin"])
        if (existsSync(join(d, t)) && !existsSync(join(tools, t)))
          symlinkSync(join(d, t), join(tools, t));
    const run = (ws: string, stdin: string, args: string[] = []) =>
      spawnSync("/bin/sh", [shim, ...args], {
        input: stdin,
        encoding: "utf8",
        cwd: ws,
        env: {
          PATH: tools,
          HOME: tools,
          EMINIAR_HOME: mkdtempSync(join(tmpdir(), "em-swh-nonode-")),
          CLAUDE_PROJECT_DIR: ws,
        },
      });

    it("denies an Agent call in an enforcing project and prints {} for everything else", () => {
      const ws = project("nonode", `${BASIC}enforce: true # on\n`);
      const deny = run(ws, payload(ws, "Explore"));
      expect(deny.status).toBe(0);
      const out = JSON.parse(deny.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("cannot run (no Node.js");
      expect(
        JSON.parse(run(ws, payload(ws, "Explore", { tool_name: "Task" })).stdout).hookSpecificOutput
          .permissionDecision,
      ).toBe("deny");
      // a call made inside a subagent is denied too
      expect(
        JSON.parse(run(ws, payload(ws, "Explore", { agent_id: "a1" })).stdout).hookSpecificOutput
          .permissionDecision,
      ).toBe("deny");
      for (const over of [{ tool_name: "Bash" }, { hook_event_name: "SessionStart" }]) {
        const r = run(ws, payload(ws, "Explore", over));
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe("{}");
      }
      // cursor is never denied by the shim
      expect(run(ws, payload(ws, "Explore"), ["--client", "cursor"]).stdout.trim()).toBe("{}");
    });

    it("prints {} when the project does not enforce or enabled is false", () => {
      for (const [name, yaml] of [
        ["off", BASIC],
        ["disabled", `${BASIC}enabled: false\nenforce: true\n`],
        ["false", `${BASIC}enforce: false\n`],
      ] as const) {
        const ws = project(`nonode-${name}`, yaml);
        const r = run(ws, payload(ws, "Explore"));
        expect(r.status, name).toBe(0);
        expect(r.stdout.trim(), name).toBe("{}");
      }
      const none = project("nonode-none");
      expect(run(none, payload(none, "Explore")).stdout.trim()).toBe("{}");
    });
  });
});
