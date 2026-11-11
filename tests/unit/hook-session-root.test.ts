import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { drainReindexQueue } from "../../src/graph/reindex.js";
import { dispatch } from "../../src/hooks/dispatch.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookInput } from "../../src/hooks/types.js";
import { resolveProjectRoot, sessionRoot } from "../../src/project.js";
import { getCurrentSession } from "../../src/session/current.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { activeSwarmConfig, resetSwarmConfigCache } from "../../src/swarm/config.js";
import { swarmRoots } from "../../src/swarm/hooks.js";
import { startRun } from "../../src/swarm/runtime.js";

// The session starts in `ws`, a folder with no project marker (a multi-repo workspace), and
// Claude then cd's into `app`, a git repository inside it. Claude Code keeps CLAUDE_PROJECT_DIR
// at `ws` for every hook and for the MCP server, while the payload `cwd` follows the cd.
let ws: string;
let app: string;
let unmark: () => void;

const SESSION = "s-cd";
const afterCd = (over: Partial<HookInput>): HookInput => ({
  session_id: SESSION,
  cwd: app,
  hook_event_name: "x",
  ...over,
});
const wsDb = (): StorageAdapter => getStorage(getContext(ws), { vectors: false });
const appDbExists = (): boolean => existsSync(getContext(app).dbPath);
const categories = (db: StorageAdapter, category: string) =>
  db.eventsBySession(SESSION, { categories: [category] });

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_ROUTING_MODE = "enforce";
  ws = realpathSync(mkdtempSync(join(tmpdir(), "em-ws-")));
  writeFileSync(
    join(ws, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  app = join(ws, "app");
  mkdirSync(join(app, ".git"), { recursive: true });
  writeFileSync(join(app, "big.log"), "x".repeat(30 * 1024));
  resetContextCache();
  // The server Claude Code started for this session runs at the session root.
  unmark = markServerAlive(getContext(ws));
});
beforeEach(() => {
  process.env.CLAUDE_PROJECT_DIR = ws;
});
afterEach(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.EMINIAR_PROJECT_ROOT;
});
afterAll(() => {
  unmark();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_ROUTING_MODE;
});

describe("sessionRoot", () => {
  it("prefers CLAUDE_PROJECT_DIR, then EMINIAR_PROJECT_ROOT, then the given cwd", () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(sessionRoot(app)).toBe(app);
    process.env.EMINIAR_PROJECT_ROOT = ws;
    expect(sessionRoot(app)).toBe(ws);
    // A nested `claude` inherits the outer session's EMINIAR_PROJECT_ROOT; its own wins.
    process.env.EMINIAR_PROJECT_ROOT = app;
    process.env.CLAUDE_PROJECT_DIR = ws;
    expect(sessionRoot(app)).toBe(ws);
  });

  it("agrees with the MCP server's root for a session started in a subfolder", () => {
    const src = join(app, "src");
    mkdirSync(src, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = src;
    expect(sessionRoot(ws)).toBe(app);
    expect(sessionRoot(ws)).toBe(resolveProjectRoot());
  });
});

describe("hooks after a cd into a nested repository", () => {
  // Every hook below runs with cwd = app: none of them may open a database of its own there.
  afterEach(() => {
    expect(appDbExists()).toBe(false);
  });

  it("UserPromptSubmit records the prompt in the session root's database", async () => {
    await handlers.UserPromptSubmit!(
      afterCd({ hook_event_name: "UserPromptSubmit", prompt: "Let's go with better-sqlite3." }),
    );
    expect(categories(wsDb(), "decision")).toHaveLength(1);
  });

  it("PostToolUse queues an edited file, relative to the session root, for the server", async () => {
    await handlers.PostToolUse!(
      afterCd({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(app, "src/a.ts") },
        tool_response: {},
      }),
    );
    expect(wsDb().reindexQueueDrain()).toContain("app/src/a.ts");
  });

  it("PostToolUseFailure records the error in the session root's database", async () => {
    await handlers.PostToolUseFailure!(
      afterCd({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        error: "Error: Cannot find module 'left-pad'",
      }),
    );
    expect(categories(wsDb(), "error").length).toBeGreaterThan(0);
  });

  it("SubagentStop indexes the findings in the session root's database", async () => {
    await handlers.SubagentStop!(
      afterCd({
        hook_event_name: "SubagentStop",
        agent_id: "a1",
        agent_type: "Explore",
        last_assistant_message: "The parser lives in src/parse.ts.",
      }),
    );
    expect(categories(wsDb(), "agent_findings")).toHaveLength(1);
  });

  it("PreCompact's snapshot is replayed by SessionStart(compact) from the session root", async () => {
    // The snapshot is built from the session's events; seed one so the test never depends on
    // what the tests before it recorded.
    await handlers.UserPromptSubmit!(
      afterCd({ hook_event_name: "UserPromptSubmit", prompt: "Let's go with better-sqlite3." }),
    );
    await handlers.PreCompact!(afterCd({ hook_event_name: "PreCompact", trigger: "auto" }));
    expect(wsDb().snapshotLatestUnconsumed(SESSION)).toBeDefined();
    const out = await handlers.SessionStart!(
      afterCd({ hook_event_name: "SessionStart", source: "compact" }),
    );
    expect(out?.hookSpecificOutput?.additionalContext).toContain("## Session Guide (eminiar)");
    // The MCP server reads the session id from the root's current-session file.
    expect(getCurrentSession(getContext(ws))).toBe(SESSION);
  });

  it("PreToolUse still sees the session's server, so enforce keeps denying", async () => {
    const out = await handlers.PreToolUse!(
      afterCd({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(app, "big.log") },
      }),
    );
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("Stop ingests the transcript once, into the session root's usage tables", async () => {
    const transcript = join(mkdtempSync(join(tmpdir(), "em-transcript-")), `${SESSION}.jsonl`);
    const entry = (req: string) =>
      `${JSON.stringify({
        type: "assistant",
        requestId: req,
        timestamp: "2026-11-08T10:00:00.000Z",
        sessionId: SESSION,
        message: {
          id: `msg_${req}`,
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`;
    writeFileSync(transcript, entry("req_1"));
    // The repository Claude cd'd into turns usage off for itself; the session's project decides.
    writeFileSync(join(app, "eminiar.config.json"), JSON.stringify({ usage: { enabled: false } }));
    resetContextCache();
    const stop = (cwd: string) =>
      handlers.Stop!(
        afterCd({
          hook_event_name: "Stop",
          cwd,
          transcript_path: transcript,
          last_assistant_message: "ok",
        }),
      );
    await stop(ws);
    appendFileSync(transcript, entry("req_2"));
    await stop(app);
    // One offset per transcript: the turn after the cd reads only the new line, into one DB.
    expect(
      wsDb()
        .apiCalls({ sessionId: SESSION })
        .map((c) => c.request_id)
        .sort(),
    ).toEqual(["req_1", "req_2"]);
  });

  it("SessionEnd closes the session in the session root's database", async () => {
    await handlers.SessionEnd!(afterCd({ hook_event_name: "SessionEnd", reason: "exit" }));
    expect(wsDb().sessionGet(SESSION)?.ended_at).toBeTypeOf("number");
  });

  it("names the risky files of a commit made in the nested repository", async () => {
    const svc = join(ws, "svc");
    mkdirSync(join(svc, "src"), { recursive: true });
    writeFileSync(join(svc, "src", "parser.ts"), "export const x = 1;\n");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: svc, encoding: "utf8" });
    git("init", "-q");
    git("add", "src/parser.ts");
    // The session database keys files from the session root: svc's file is svc/src/parser.ts.
    const risk = { commits: 9, fixes: 5, bugOrigins: 2, risk: 0.62, reasons: ["fix density"] };
    wsDb().metaSet(
      "history_files",
      JSON.stringify({ head: "abc", files: { "svc/src/parser.ts": risk } }),
    );
    const out = await handlers.PreToolUse!(
      afterCd({
        hook_event_name: "PreToolUse",
        cwd: svc,
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "tweak parser"' },
      }),
    );
    expect(out?.hookSpecificOutput?.additionalContext).toContain("svc/src/parser.ts is bug-prone");
  });
});

describe("a session started in a monorepo package", () => {
  it("names the risky files of a commit, keyed from the package", async () => {
    // The git top level is above the session root: packages/a has its own package.json.
    const mono = realpathSync(mkdtempSync(join(tmpdir(), "em-mono-")));
    const pkg = join(mono, "packages", "a");
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{}");
    const names = ["src/p.ts", "src/caf\u00e9.ts"];
    for (const n of names) writeFileSync(join(pkg, n), "export const p = 1;\n");
    spawnSync("git", ["init", "-q"], { cwd: mono });
    spawnSync("git", ["add", "."], { cwd: mono });
    process.env.CLAUDE_PROJECT_DIR = pkg;
    const risk = { commits: 9, fixes: 5, bugOrigins: 2, risk: 0.62, reasons: ["fix density"] };
    getStorage(getContext(pkg), { vectors: false }).metaSet(
      "history_files",
      JSON.stringify({ head: "abc", files: Object.fromEntries(names.map((n) => [n, risk])) }),
    );
    const out = await handlers.PreToolUse!(
      afterCd({
        hook_event_name: "PreToolUse",
        cwd: pkg,
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "tweak"' },
      }),
    );
    const text = String(out?.hookSpecificOutput?.additionalContext);
    for (const n of names) expect(text).toContain(`${n} is bug-prone`);
  });
});

describe("a git worktree inside the session's project", () => {
  it("keeps its copy of the code, and excluded files, out of the graph", async () => {
    // EnterWorktree, or an `isolation: worktree` subagent: cwd is the worktree, the session
    // root stays the main checkout, so the worktree's edits are queued in the main project.
    const wt = join(ws, ".claude", "worktrees", "w1");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(ws, ".git", "worktrees", "w1")}\n`);
    writeFileSync(join(wt, "src", "dup.ts"), "export function dupSymbol() { return 1; }\n");
    mkdirSync(join(app, "lib"), { recursive: true });
    writeFileSync(join(app, "lib", "own.ts"), "export function ownSymbol() { return 1; }\n");
    mkdirSync(join(app, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(app, "node_modules", "dep", "index.js"), "exports.dep = 1;\n");
    const edit = (cwd: string, file: string) =>
      handlers.PostToolUse!(
        afterCd({
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Edit",
          tool_input: { file_path: file },
          tool_response: {},
        }),
      );
    await edit(wt, join(wt, "src", "dup.ts"));
    await edit(app, join(app, "lib", "own.ts"));
    await edit(app, join(app, "node_modules", "dep", "index.js"));
    const db = wsDb();
    await drainReindexQueue(getContext(ws), db);
    expect(db.fileIndexGet(".claude/worktrees/w1/src/dup.ts")).toBeUndefined();
    expect(db.fileIndexGet("app/node_modules/dep/index.js")).toBeUndefined();
    expect(db.fileIndexGet("app/lib/own.ts")).toBeDefined();
  });
});

describe("Cursor", () => {
  it("exports the session root, not the payload cwd, for the later hooks", async () => {
    const out = JSON.parse(
      await dispatch(
        JSON.stringify({
          conversation_id: "conv-cd",
          hook_event_name: "sessionStart",
          cursor_version: "2.6.0",
          workspace_roots: [ws],
          cwd: app,
        }),
        ["--client", "cursor"],
      ),
    );
    expect(out.env.EMINIAR_PROJECT_ROOT).toBe(ws);
  });
});

describe("git commit -a from a nested repository", () => {
  it("names a tracked file with unstaged changes only when -a is given", async () => {
    const svc = join(ws, "svc-all");
    mkdirSync(join(svc, "src"), { recursive: true });
    writeFileSync(join(svc, "src", "a.ts"), "export const a = 1;\n");
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: svc });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(svc, "src", "a.ts"), "export const a = 2;\n");
    const risk = { commits: 9, fixes: 5, bugOrigins: 2, risk: 0.62, reasons: ["fix density"] };
    wsDb().metaSet(
      "history_files",
      JSON.stringify({ head: "abc", files: { "svc-all/src/a.ts": risk } }),
    );
    const ask = async (command: string) =>
      String(
        (
          await handlers.PreToolUse!(
            afterCd({
              hook_event_name: "PreToolUse",
              cwd: svc,
              tool_name: "Bash",
              tool_input: { command },
            }),
          )
        )?.hookSpecificOutput?.additionalContext ?? "",
      );
    expect(await ask('git commit -m "x"')).not.toContain("a.ts is bug-prone");
    expect(await ask('git commit -am "x"')).toContain("svc-all/src/a.ts is bug-prone");
    expect(await ask('git commit --all -m "x"')).toContain("svc-all/src/a.ts is bug-prone");
  });
});

describe("swarm hooks after a cd", () => {
  const SWARM = `version: 1
swarms:
  feat:
    description: test swarm
    max_agents: 3
    agents:
      coder:
        description: writes code
        count: 2
        tools: [Read, Edit]
`;
  // A workspace of its own: a swarm file in the session root, or only in the nested repository.
  const workspace = (name: string, swarmIn: "root" | "nested", enforce: boolean) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `em-sw-${name}-`)));
    const nested = join(root, "sub");
    mkdirSync(join(nested, ".git"), { recursive: true });
    writeFileSync(join(nested, "package.json"), "{}");
    const dir = join(swarmIn === "root" ? root : nested, ".eminiar");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "swarm.yaml"), `${SWARM}${enforce ? "enforce: true\n" : ""}`);
    process.env.CLAUDE_PROJECT_DIR = root;
    resetContextCache();
    resetSwarmConfigCache();
    return { root, nested };
  };
  const spawn = (cwd: string, id: string): HookInput => ({
    session_id: "s-sw",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "swarm-feat-coder", prompt: "go" },
    tool_use_id: id,
  });

  it("swarmRoots tries the session root, then the root of the directory Claude cd'd into", () => {
    const { root, nested } = workspace("roots", "nested", false);
    expect(swarmRoots({ cwd: nested })).toEqual([root, nested]);
    expect(swarmRoots({ cwd: root })).toEqual([root]);
  });

  it("tracks a spawn through a swarm file that exists only in the nested repository", async () => {
    const { nested } = workspace("track", "nested", false);
    const db = getStorage(getContext(nested), { vectors: false });
    const run = startRun(db, activeSwarmConfig(nested)!, {
      swarm: "feat",
      goal: "g",
      sessionId: "s-sw",
    });
    const out = await handlers.PreToolUse!(spawn(nested, "toolu_nested"));
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(db.swarm.spawnsPending(run.id, 0)).toBe(1);
  });

  it("releases the reservation of a denied spawn in the session root's ledger after a cd", async () => {
    const { root, nested } = workspace("fail", "root", true);
    const db = getStorage(getContext(root), { vectors: false });
    const run = startRun(db, activeSwarmConfig(root)!, {
      swarm: "feat",
      goal: "g",
      sessionId: "s-sw",
    });
    const original = handlers.PreToolUse;
    try {
      // the handler reserves the slot, then dies late
      handlers.PreToolUse = async (i) => {
        await original!(i);
        throw new Error("handler exploded");
      };
      const out = JSON.parse(await dispatch(JSON.stringify(spawn(nested, "toolu_fc_cd")), []));
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(db.swarm.spawnsPending(run.id, 0)).toBe(0);
    } finally {
      handlers.PreToolUse = original!;
    }
    expect(existsSync(getContext(nested).dbPath)).toBe(false);
  });
});
