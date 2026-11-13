import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import {
  budgetFor,
  budgetLeft,
  busyTimeoutFor,
  clearBudget,
  HOOK_BUDGET_MS,
  hasBudget,
  lockWaitFor,
  startBudget,
} from "../../src/hooks/budget.js";
import { dispatch, ranLate } from "../../src/hooks/dispatch.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookHandler, HookInput, HookOutput } from "../../src/hooks/types.js";
import { write } from "../../src/memory/store.js";
import { closeAllStorage, getStorage, setStorageBusyTimeout } from "../../src/storage/index.js";
import { activeSwarmConfig, resetSwarmConfigCache } from "../../src/swarm/config.js";
import { startRun } from "../../src/swarm/runtime.js";

let root: string;
const ctxText = (out: HookOutput | undefined) => out?.hookSpecificOutput?.additionalContext ?? "";

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  root = mkdtempSync(join(tmpdir(), "em-budget-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  resetContextCache();
  const ctx = getContext(root);
  write(ctx, getStorage(ctx, { vectors: false }), {
    name: "decision/sqlite-connection-pool",
    kind: "decision",
    content:
      "The SQLite connection pool is capped at one writer; WAL mode handles concurrent readers.",
  });
});
afterEach(() => {
  clearBudget();
  setStorageBusyTimeout(undefined);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

describe("run budget", () => {
  it("sits under each event's hooks.json timeout", () => {
    // 5 s hooks, then the longer ones
    expect(budgetFor("UserPromptSubmit")).toBe(HOOK_BUDGET_MS);
    expect(budgetFor("PreToolUse")).toBe(HOOK_BUDGET_MS);
    expect(budgetFor("Stop")).toBe(HOOK_BUDGET_MS);
    expect(budgetFor(undefined)).toBe(HOOK_BUDGET_MS);
    expect(HOOK_BUDGET_MS).toBeLessThan(5000);
    expect(budgetFor("SessionStart")).toBeLessThan(10_000);
    expect(budgetFor("PostToolUse")).toBeLessThan(10_000);
    expect(budgetFor("PreCompact")).toBeLessThan(15_000);
  });
  it("counts down from the start and never goes negative", () => {
    startBudget(1000, 5000);
    expect(budgetLeft(5000)).toBe(1000);
    expect(budgetLeft(5400)).toBe(600);
    expect(hasBudget(600, 5400)).toBe(true);
    expect(hasBudget(601, 5400)).toBe(false);
    expect(budgetLeft(9000)).toBe(0);
  });
  it("is unlimited when no run has started, so a handler called directly is not cut short", () => {
    clearBudget();
    expect(budgetLeft()).toBe(Number.POSITIVE_INFINITY);
    expect(hasBudget(60_000)).toBe(true);
  });
});

describe("dispatch deadline", () => {
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "b1", cwd: root, ...over });

  it("answers {} at the budget when the handler has not, and says it ran late", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = () => new Promise<HookOutput>(() => {});
    try {
      const t = Date.now();
      const out = await dispatch(payload({ prompt: "hello there" }), [], { budgetMs: 60 });
      expect(out).toBe("{}");
      expect(Date.now() - t).toBeLessThan(1500);
      expect(ranLate()).toBe(true);
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
  it("a run that finishes in time is not late, and clears its budget", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = async () => ({ systemMessage: "ok" });
    try {
      const out = await dispatch(payload({ prompt: "hello there" }), [], { budgetMs: 5000 });
      expect(JSON.parse(out)).toEqual({ systemMessage: "ok" });
      expect(ranLate()).toBe(false);
      expect(budgetLeft()).toBe(Number.POSITIVE_INFINITY);
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
  it("a late run leaves its budget spent so the abandoned handler skips optional stages", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = () => new Promise<HookOutput>(() => {});
    try {
      await dispatch(payload({ prompt: "hello there" }), [], { budgetMs: 20 });
      expect(budgetLeft()).toBe(0);
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
});

describe("budget counted from process start", () => {
  const payload = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "b2",
    cwd: "",
    prompt: "hello there",
  });
  const logFile = () => join(process.env.EMINIAR_HOME as string, "hook.log");
  const logText = () => {
    try {
      return readFileSync(logFile(), "utf8");
    } catch {
      return "";
    }
  };

  it("a boot that already spent most of the budget answers {} late, and logs it", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = () => new Promise<HookOutput>((r) => setTimeout(() => r({}), 300));
    try {
      const before = logText().length;
      const out = await dispatch(payload, [], { startedAt: performance.now() - 3400 });
      expect(out).toBe("{}");
      expect(ranLate()).toBe(true);
      expect(logText().slice(before)).toContain("hook budget of 3500 ms exceeded");
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
  it("without startedAt the full budget is available to the handler", async () => {
    const saved = handlers.UserPromptSubmit as HookHandler;
    handlers.UserPromptSubmit = () =>
      new Promise<HookOutput>((r) => setTimeout(() => r({ systemMessage: "ok" }), 150));
    try {
      const out = await dispatch(payload, []);
      expect(JSON.parse(out)).toEqual({ systemMessage: "ok" });
      expect(ranLate()).toBe(false);
    } finally {
      handlers.UserPromptSubmit = saved;
    }
  });
  it("budgetLeft reads the performance clock, whose 0 is the process start", () => {
    startBudget(HOOK_BUDGET_MS, 0);
    const left = budgetLeft();
    expect(left).toBeLessThanOrEqual(HOOK_BUDGET_MS - performance.now() + 1);
    expect(left).toBeGreaterThan(0);
  });
});

describe("hooks.json deadlines", () => {
  const table = JSON.parse(readFileSync(join(process.cwd(), "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]>;
  };
  it("every --deadline sits above the soft budget and leaves 500 ms under the timeout", () => {
    let seen = 0;
    for (const entries of Object.values(table.hooks))
      for (const e of entries)
        for (const h of e.hooks) {
          const m = / --deadline (\d+)$/.exec(h.command);
          if (!m) continue;
          seen++;
          const ms = Number(m[1]) * 1000;
          expect(ms).toBeGreaterThan(HOOK_BUDGET_MS);
          expect(ms + 500).toBeLessThanOrEqual(h.timeout * 1000);
        }
    expect(seen).toBeGreaterThan(0);
  });
  it("UserPromptSubmit carries it; no other event does", () => {
    for (const [ev, entries] of Object.entries(table.hooks)) {
      const has = entries.some((e) => e.hooks.some((h) => h.command.includes("--deadline")));
      expect(has, ev).toBe(ev === "UserPromptSubmit");
    }
  });
});

describe("UserPromptSubmit while another process holds the write lock", () => {
  it("still returns the recall, and fast, with a short lock wait", async () => {
    closeAllStorage();
    setStorageBusyTimeout(100);
    const ctx = getContext(root);
    // another process: it holds the write lock for the whole call
    const other = new Database(ctx.dbPath);
    other.exec("BEGIN IMMEDIATE");
    try {
      const input: HookInput = {
        session_id: "b-locked",
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        prompt: "Should the SQLite connection pool allow concurrent writers?",
      };
      const t = Date.now();
      const out = await handlers.UserPromptSubmit?.(input);
      const took = Date.now() - t;
      // one locked write (~100 ms) ends the bookkeeping; the read-only recall is not blocked
      expect(took).toBeLessThan(1500);
      expect(ctxText(out)).toContain("memory decision/sqlite-connection-pool");
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });
  it("records the prompt as before when the database is free", async () => {
    closeAllStorage();
    const ctx = getContext(root);
    const db = getStorage(ctx, { vectors: false });
    await handlers.UserPromptSubmit?.({
      session_id: "b-free",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      prompt: "Should the SQLite connection pool allow concurrent writers?",
    });
    const row = db.sessionGet?.("b-free");
    expect(row?.last_prompt).toContain("SQLite connection pool");
  });
});

/** Another process holds the write lock on `dbPath` for `ms`; resolves once it has it. */
function holdLock(dbPath: string, ms: number): Promise<() => void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const D=require(${JSON.stringify(require.resolve("better-sqlite3"))});const d=new D(${JSON.stringify(dbPath)});d.exec("BEGIN IMMEDIATE");console.log("locked");setTimeout(()=>{d.exec("ROLLBACK");d.close()},${ms});`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  return new Promise<() => void>((res) => child.stdout.once("data", () => res(() => child.kill())));
}

/** An enforcing swarm project with an active run of "feat" (one tester), as the hooks see it. */
async function withSwarmProject(fn: (proj: string, runId: string) => Promise<void>): Promise<void> {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "em-budget-swarm-")));
  writeFileSync(join(proj, "package.json"), "{}");
  writeFileSync(
    join(proj, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  mkdirSync(join(proj, ".eminiar"));
  writeFileSync(
    join(proj, ".eminiar", "swarm.yaml"),
    `version: 1
enforce: true
swarms:
  feat:
    description: t
    max_agents: 3
    agents:
      tester:
        description: tests code
`,
  );
  const saved = {
    root: process.env.EMINIAR_PROJECT_ROOT,
    dir: process.env.CLAUDE_PROJECT_DIR,
  };
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.EMINIAR_PROJECT_ROOT = proj;
  resetContextCache();
  resetSwarmConfigCache();
  try {
    const db = getStorage(getContext(proj), { vectors: false });
    const cfg = activeSwarmConfig(proj)!;
    const run = startRun(db, cfg, { swarm: "feat", goal: "g", sessionId: "s1" });
    await fn(proj, run.id);
  } finally {
    for (const [k, v] of Object.entries({
      EMINIAR_PROJECT_ROOT: saved.root,
      CLAUDE_PROJECT_DIR: saved.dir,
    }))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    resetContextCache();
    resetSwarmConfigCache();
  }
}

const spawnBody = (proj: string, id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "s1",
    cwd: proj,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "swarm-feat-tester", prompt: "go" },
    tool_use_id: id,
    ...over,
  });

describe("a denied-at-the-deadline Agent call", () => {
  it("releases its spawn reservation so the retry is allowed", async () => {
    const realPre = handlers.PreToolUse as HookHandler;
    try {
      await withSwarmProject(async (proj, runId) => {
        const db = getStorage(getContext(proj), { vectors: false });
        const body = (id: string) => spawnBody(proj, id);
        // a slow tail after the real handler reserved the slot
        handlers.PreToolUse = async (i) => {
          const r = await realPre(i);
          await new Promise((res) => setTimeout(res, 400));
          return r;
        };
        const slow = await dispatch(body("toolu_slow"), [], { budgetMs: 150 });
        expect(JSON.parse(slow).hookSpecificOutput.permissionDecision).toBe("deny");
        expect(db.swarm.spawnsPending(runId, 0)).toBe(0);
        handlers.PreToolUse = realPre;
        const retry = await dispatch(body("toolu_retry"), [], { budgetMs: 3000 });
        expect(JSON.parse(retry).hookSpecificOutput.permissionDecision).toBe("allow");
      });
    } finally {
      handlers.PreToolUse = realPre;
    }
  });
});

describe("a failed Agent call while another process holds the write lock", () => {
  it("still releases its spawn reservation under its own lock wait, so the retry is allowed", async () => {
    await withSwarmProject(async (proj, runId) => {
      const ctx = getContext(proj);
      const allowed = await dispatch(spawnBody(proj, "toolu_A"), [], { budgetMs: 3000 });
      expect(JSON.parse(allowed).hookSpecificOutput.permissionDecision).toBe("allow");
      expect(getStorage(ctx, { vectors: false }).swarm.spawnsPending(runId, 0)).toBe(1);
      // a fresh hook process: it opens the database with the wait src/hook.ts picks
      closeAllStorage();
      setStorageBusyTimeout(busyTimeoutFor("PostToolUseFailure", "Agent"));
      const stop = await holdLock(ctx.dbPath, 1000);
      try {
        await handlers.PostToolUseFailure?.({
          session_id: "s1",
          cwd: proj,
          hook_event_name: "PostToolUseFailure",
          tool_name: "Agent",
          tool_input: { subagent_type: "swarm-feat-tester", prompt: "go" },
          tool_use_id: "toolu_A",
          error: "interrupted",
        });
      } finally {
        stop();
      }
      closeAllStorage();
      setStorageBusyTimeout(undefined);
      expect(getStorage(ctx, { vectors: false }).swarm.spawnsPending(runId, 0)).toBe(0);
      const retry = await dispatch(spawnBody(proj, "toolu_B"), [], { budgetMs: 3000 });
      expect(JSON.parse(retry).hookSpecificOutput.permissionDecision).toBe("allow");
    });
  }, 15000);

  it("stays well under its 5 s hook under a lock held past the run, and still answers the recall", async () => {
    await withSwarmProject(async (proj) => {
      const ctx = getContext(proj);
      write(ctx, getStorage(ctx, { vectors: false }), {
        name: "decision/sqlite-connection-pool",
        kind: "decision",
        content:
          "The SQLite connection pool is capped at one writer; WAL mode handles concurrent readers.",
      });
      await dispatch(spawnBody(proj, "toolu_A"), [], { budgetMs: 3000 });
      // a fresh hook process under a lock no wait outlasts: the release waits its 1500 ms and
      // fails; the session row, recordShown and the event must not each wait that long again
      closeAllStorage();
      setStorageBusyTimeout(busyTimeoutFor("PostToolUseFailure", "Agent"));
      const stop = await holdLock(ctx.dbPath, 8000);
      try {
        const t = Date.now();
        const out = await dispatch(
          spawnBody(proj, "toolu_A", {
            hook_event_name: "PostToolUseFailure",
            error: "SQLite connection pool allow concurrent writers failed",
          }),
          [],
        );
        const took = Date.now() - t;
        expect(took).toBeLessThan(budgetFor("PostToolUseFailure"));
        expect(took).toBeLessThan(2500);
        expect(ranLate()).toBe(false);
        expect(ctxText(JSON.parse(out) as HookOutput)).toContain("decision/sqlite-connection-pool");
      } finally {
        stop();
      }
      closeAllStorage();
      setStorageBusyTimeout(undefined);
    });
  }, 20000);
});

describe("lock wait per event", () => {
  it("is short where the answer comes from reads and longer where the write is the job", () => {
    expect(busyTimeoutFor("UserPromptSubmit")).toBe(250);
    expect(busyTimeoutFor("PreToolUse", "Bash")).toBe(250);
    expect(busyTimeoutFor(undefined)).toBe(250);
    for (const e of ["SessionStart", "PreCompact", "SubagentStart", "SubagentStop", "PostToolUse"])
      expect(busyTimeoutFor(e)).toBeGreaterThanOrEqual(1500);
    expect(busyTimeoutFor("PreToolUse", "Agent")).toBeGreaterThanOrEqual(1500);
    expect(busyTimeoutFor("PreToolUse", "Task")).toBeGreaterThanOrEqual(1500);
    // a failed Agent call releases its spawn reservation; other failures only read the recall
    expect(busyTimeoutFor("PostToolUseFailure", "Agent")).toBeGreaterThanOrEqual(1500);
    expect(busyTimeoutFor("PostToolUseFailure", "Task")).toBeGreaterThanOrEqual(1500);
    expect(busyTimeoutFor("PostToolUseFailure", "Bash")).toBe(250);
  });

  it("a hook process picks it from the event the handlers will see, Cursor's translated", () => {
    const claude = (p: Record<string, unknown>, argv: string[] = []) =>
      lockWaitFor(JSON.stringify(p), argv);
    expect(claude({ hook_event_name: "SessionStart", session_id: "s" })).toBe(2000);
    expect(claude({ hook_event_name: "UserPromptSubmit", session_id: "s" })).toBe(250);
    expect(claude({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Agent" })).toBe(
      1500,
    );
    expect(claude({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash" })).toBe(250);
    expect(claude({ session_id: "s" }, ["--event", "SubagentStop"])).toBe(1500);
    expect(lockWaitFor("{not json", [])).toBe(250);
    expect(lockWaitFor("", [])).toBe(250);
    expect(lockWaitFor("[1]", [])).toBe(250);
    // Cursor sends camelCase events, `Shell` for Bash, and no session_id
    const cursor = (event: string, over: Record<string, unknown> = {}) =>
      lockWaitFor(
        JSON.stringify({
          hook_event_name: event,
          conversation_id: "c1",
          workspace_roots: [root],
          ...over,
        }),
        ["--client", "cursor"],
      );
    expect(cursor("sessionStart")).toBe(2000);
    expect(cursor("postToolUse", { tool_name: "Shell" })).toBe(2000);
    expect(cursor("afterFileEdit", { file_path: "a.ts" })).toBe(2000);
    expect(cursor("preCompact")).toBe(2000);
    expect(cursor("subagentStop")).toBe(1500);
    expect(cursor("stop")).toBe(1500);
    expect(cursor("afterAgentResponse")).toBe(1500);
    expect(cursor("sessionEnd")).toBe(1500);
    expect(cursor("beforeSubmitPrompt")).toBe(250);
    expect(cursor("preToolUse", { tool_name: "Shell" })).toBe(250);
    expect(cursor("preToolUse", { tool_name: "Task" })).toBe(1500);
    expect(cursor("postToolUseFailure", { tool_name: "Task" })).toBe(1500);
    // detected from the payload, without --client
    expect(lockWaitFor(JSON.stringify({ hook_event_name: "subagentStop" }), [])).toBe(1500);
  });

  it("a Cursor sessionStart records its session through a 1 s lock", async () => {
    const raw = JSON.stringify({
      hook_event_name: "sessionStart",
      conversation_id: "cur-lock-1",
      workspace_roots: [root],
    });
    const argv = ["--client", "cursor"];
    closeAllStorage();
    // what src/hook.ts does before dispatch
    setStorageBusyTimeout(lockWaitFor(raw, argv));
    const stop = await holdLock(getContext(root).dbPath, 1000);
    try {
      await dispatch(raw, argv, { budgetMs: 8000 });
    } finally {
      stop();
    }
    closeAllStorage();
    setStorageBusyTimeout(undefined);
    expect(
      getStorage(getContext(root), { vectors: false }).sessionGet?.("cur-lock-1"),
    ).toBeTruthy();
  }, 15000);

  it("the hook process (src/hook.ts) opens the database with that wait, Claude's and Cursor's", async () => {
    // The real entry point from source: a hook that ignored the event's wait (or read Cursor's
    // untranslated name) would skip the best-effort session row under this lock.
    const runHook = (raw: string, argv: string[]) =>
      new Promise<string>((res, rej) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", join(__dirname, "../../src/hook.ts"), ...argv],
          {
            cwd: join(__dirname, "../.."),
            env: { ...process.env, EMINIAR_PROJECT_ROOT: root },
            stdio: ["pipe", "pipe", "ignore"],
          },
        );
        let out = "";
        child.stdout.on("data", (d) => {
          out += String(d);
        });
        child.on("error", rej);
        child.on("close", () => res(out));
        child.stdin.end(raw);
      });
    const cases = [
      {
        id: "proc-claude",
        raw: { hook_event_name: "SessionStart", session_id: "proc-claude", cwd: root },
        argv: [],
      },
      {
        id: "proc-cursor",
        raw: {
          hook_event_name: "sessionStart",
          conversation_id: "proc-cursor",
          workspace_roots: [root],
        },
        argv: ["--client", "cursor"],
      },
    ];
    closeAllStorage();
    const dbPath = getContext(root).dbPath;
    for (const c of cases) {
      const stop = await holdLock(dbPath, 1200);
      try {
        expect(await runHook(JSON.stringify({ source: "startup", ...c.raw }), c.argv)).toMatch(
          /^\{/,
        );
      } finally {
        stop();
      }
    }
    const db = getStorage(getContext(root), { vectors: false });
    for (const c of cases) expect(db.sessionGet?.(c.id), c.id).toBeTruthy();
  }, 30000);

  it("a write survives a 1 s lock under the PreCompact wait but not under the short one", async () => {
    const hold = (ms: number) => holdLock(getContext(root).dbPath, ms);
    const snap = (id: string) => {
      const db = getStorage(getContext(root), { vectors: false });
      return () => db.snapshotInsert({ sessionId: id, trigger: "auto", body: "x" });
    };
    closeAllStorage();
    setStorageBusyTimeout(busyTimeoutFor("PreCompact"));
    let stop = await hold(1000);
    expect(snap("long")()).toBeGreaterThan(0);
    stop();
    closeAllStorage();
    setStorageBusyTimeout(busyTimeoutFor("UserPromptSubmit"));
    stop = await hold(1000);
    expect(snap("short")).toThrow();
    stop();
  }, 15000);
});

describe("SessionStart and PostToolUseFailure while another process holds the write lock", () => {
  async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    closeAllStorage();
    setStorageBusyTimeout(250);
    const ctx = getContext(root);
    getStorage(ctx, { vectors: false });
    const other = new Database(ctx.dbPath);
    other.exec("BEGIN IMMEDIATE");
    try {
      return await fn();
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  }
  it("SessionStart(startup) still returns the routing guidance and the brief", async () => {
    const out = await withLock(() =>
      handlers.SessionStart?.({
        session_id: "s-lock-start",
        cwd: root,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    );
    const text = ctxText(out);
    expect(text).toContain("eminiar is active");
    expect(text).toContain("eminiar index:");
  });
  it("SessionStart(compact) still returns the Session Guide", async () => {
    closeAllStorage();
    const ctx = getContext(root);
    const db = getStorage(ctx, { vectors: false });
    db.sessionUpsert({ id: "s-lock-compact", project_root: root });
    db.snapshotInsert({ sessionId: "s-lock-compact", trigger: "compact", body: "SNAPSHOT-BODY" });
    const out = await withLock(() =>
      handlers.SessionStart?.({
        session_id: "s-lock-compact",
        cwd: root,
        hook_event_name: "SessionStart",
        source: "compact",
      }),
    );
    expect(ctxText(out)).toContain("## Session Guide (eminiar)");
    expect(ctxText(out)).toContain("SNAPSHOT-BODY");
  });
  it("PostToolUseFailure still returns its recall", async () => {
    const out = await withLock(() =>
      handlers.PostToolUseFailure?.({
        session_id: "s-lock-fail",
        cwd: root,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "x" },
        error: "SQLite connection pool allow concurrent writers failed",
      }),
    );
    expect(ctxText(out)).toContain("decision/sqlite-connection-pool");
  });
});
