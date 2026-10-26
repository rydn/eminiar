import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyPrompt, classifyToolCall } from "../../src/capture/classify.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import { literalOf, suggest } from "../../src/hooks/routing.js";
import type { HookInput } from "../../src/hooks/types.js";
import { search } from "../../src/search/pipeline.js";
import { renderWithin } from "../../src/session/guide.js";
import { liveServers, markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

let root: string;
let unmark: () => void;
const base = (over: Partial<HookInput>): HookInput => ({
  session_id: "s1",
  cwd: root,
  hook_event_name: "x",
  ...over,
});

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_ROUTING_MODE = "enforce";
  root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  // context-mode may be installed on the dev machine; the test wants hard routing regardless
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  writeFileSync(join(root, "big.log"), "x".repeat(30 * 1024));
  resetContextCache();
  // enforce only denies while a server is marked live for the project; this process stands in
  unmark = markServerAlive(getContext(root));
});
afterAll(() => {
  unmark();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_ROUTING_MODE;
});

describe("classify", () => {
  it("extracts decisions, constraints and intent from prompts", () => {
    const cats = classifyPrompt("Let's go with better-sqlite3. We must never commit secrets.").map(
      (d) => d.category,
    );
    expect(cats).toContain("user_prompt");
    expect(cats).toContain("decision");
    expect(cats).toContain("constraint");
    expect(cats).toContain("intent");
  });
  it("classifies tool calls", () => {
    const edit = classifyToolCall({
      toolName: "Edit",
      toolInput: { file_path: `${root}/src/a.ts` },
      root,
    });
    expect(edit.find((d) => d.category === "files")?.payload.path).toBe("src/a.ts");
    const git = classifyToolCall({
      toolName: "Bash",
      toolInput: { command: "git commit -m x" },
      root,
    });
    expect(git.map((d) => d.category)).toContain("git");
    const slowFail = classifyToolCall({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolResponse: { stdout: "", stderr: "boom", exit_code: 1 },
      durationMs: 9000,
      root,
    });
    expect(slowFail.map((d) => d.category)).toEqual(expect.arrayContaining(["latency", "error"]));
  });
});

describe("routing suggestions", () => {
  // Read routing reads ~/.claude/settings.json; keep the developer's own rules out of it.
  const home = process.env.HOME;
  beforeAll(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "em-userhome-"));
  });
  afterAll(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });

  it("flags heavy bash, big reads, content grep, webfetch and agents; leaves tiny calls alone", () => {
    expect(suggest("Bash", { command: "git log --oneline -50" }, root)?.tool).toBe("em_execute");
    expect(suggest("Bash", { command: "ls -la | grep foo" }, root)?.tool).toBe("em_execute");
    expect(suggest("Bash", { command: "git status" }, root)).toBeUndefined();
    expect(suggest("Bash", { command: "pwd" }, root)).toBeUndefined();
    expect(suggest("Read", { file_path: "big.log" }, root)?.tool).toBe("em_execute_file");
    expect(suggest("Read", { file_path: "package.json" }, root)).toBeUndefined();
    expect(suggest("Grep", { pattern: "x", output_mode: "content" }, root)?.tool).toBe(
      "em_execute",
    );
    expect(suggest("Grep", { pattern: "x" }, root)).toBeUndefined();
    expect(suggest("WebFetch", { url: "https://x" }, root)?.tool).toBe("em_fetch_and_index");
    expect(suggest("Agent", { prompt: "p" }, root)?.prefixPrompt).toBeDefined();
  });

  it("leaves a big Read to Claude Code when a Read deny or ask rule covers the file", () => {
    const guarded = mkdtempSync(join(tmpdir(), "em-root-guarded-"));
    mkdirSync(join(guarded, ".claude"));
    writeFileSync(
      join(guarded, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { deny: ["Read(**/secret.log)"], ask: ["Read(**/audit.log)"] },
      }),
    );
    for (const f of ["secret.log", "audit.log", "big.log"])
      writeFileSync(join(guarded, f), "x".repeat(30 * 1024));
    symlinkSync(join(guarded, "secret.log"), join(guarded, "shortcut.log"));
    expect(suggest("Read", { file_path: "secret.log" }, guarded)).toBeUndefined();
    expect(suggest("Read", { file_path: "audit.log" }, guarded)).toBeUndefined();
    expect(suggest("Read", { file_path: "shortcut.log" }, guarded)).toBeUndefined();
    expect(suggest("Read", { file_path: "big.log" }, guarded)?.tool).toBe("em_execute_file");
  });
});

describe("hook handlers end to end", () => {
  it("records a session, routes in enforce mode, snapshots and replays a guide", async () => {
    const start = await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(start?.hookSpecificOutput?.additionalContext).toContain(
      "eminiar is active (routing: enforce)",
    );

    await handlers.UserPromptSubmit!(
      base({
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix the flaky test; let's go with vitest",
      }),
    );
    await handlers.PostToolUse!(
      base({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: `${root}/src/x.ts` },
        tool_response: {},
      }),
    );
    for (let i = 0; i < 3; i++) {
      await handlers.PostToolUse!(
        base({
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
          tool_response: { exit_code: 1, stderr: "fail" },
        }),
      );
    }
    await handlers.Stop!(
      base({
        hook_event_name: "Stop",
        last_assistant_message: "Fixed the flaky test by awaiting the promise.",
      }),
    );

    const deny = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git log" },
      }),
    );
    expect(deny?.hookSpecificOutput?.permissionDecision).toBe("deny");
    const agent = await handlers.PreToolUse!(
      base({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt: "do x" } }),
    );
    expect(agent?.hookSpecificOutput?.updatedInput?.prompt).toMatch(/^Use the eminiar tools/);

    await handlers.PreCompact!(base({ hook_event_name: "PreCompact", trigger: "auto" }));
    const db = getStorage(getContext(root), { vectors: false });
    const snap = db.snapshotLatestUnconsumed("s1");
    expect(snap).toBeDefined();
    expect(snap!.bytes).toBeLessThanOrEqual(2048);
    expect(snap!.body).toMatch(/\*\*Files Modified\*\*: .*src\/x\.ts/);
    expect(snap!.body).toContain("**Loops**");
    expect(snap!.body).toContain("**Key Decisions**");

    const resume = await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "compact" }),
    );
    expect(resume?.hookSpecificOutput?.additionalContext).toContain("## Session Guide (eminiar)");
    expect(db.snapshotLatestUnconsumed("s1")).toBeUndefined();
  });
});

describe("graph context in hooks", () => {
  it("hints matching symbols for Grep, coverage gaps for Read, and briefs subagents", async () => {
    const ctx = getContext(root);
    const db = getStorage(ctx, { vectors: false });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/x.ts"), "export function parseThing() {}\n");
    writeFileSync(join(root, "src/ok.ts"), "export const ok = 1;\n");
    db.graphUpsertNodes([
      {
        id: "file:src/x.ts",
        kind: "file",
        name: "src/x.ts",
        path: "src/x.ts",
        source: "tree-sitter",
      },
      {
        id: "sym:src/x.ts#parseThing",
        kind: "function",
        name: "parseThing",
        path: "src/x.ts",
        startLine: 7,
        endLine: 9,
        source: "tree-sitter",
      },
    ]);
    db.fileIndexSet({
      path: "src/x.ts",
      hash: "h",
      mtime: 0,
      size: 1,
      language: "typescript",
      document_id: null,
      status: "partial",
      reason: "2 syntax errors recovered",
    });
    db.fileIndexSet({
      path: "src/ok.ts",
      hash: "h",
      mtime: 0,
      size: 1,
      language: "typescript",
      document_id: null,
    });
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
    expect(literalOf("parse\\w+Thing")).toBe("parse");
    expect(literalOf("\\.ts$")).toBeUndefined();

    const grep = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "parseTh", output_mode: "files_with_matches" },
      }),
    );
    expect(grep?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(grep?.hookSpecificOutput?.additionalContext).toContain(
      "function parseThing (src/x.ts:7)",
    );
    // a denied content grep still carries the hint in its reason
    const denied = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "parseThing", output_mode: "content" },
      }),
    );
    expect(denied?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(denied?.hookSpecificOutput?.permissionDecisionReason).toContain("parseThing");

    const read = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: `${root}/src/x.ts` },
      }),
    );
    expect(read?.hookSpecificOutput?.additionalContext).toContain("src/x.ts is partial");
    const readOk = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: `${root}/src/ok.ts` },
      }),
    );
    expect(readOk).toBeUndefined();

    const agent = await handlers.PreToolUse!(
      base({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt: "do y" } }),
    );
    const prompt = String(agent?.hookSpecificOutput?.updatedInput?.prompt);
    expect(prompt).toMatch(/^Use the eminiar tools/);
    expect(prompt).toContain("Project brief (eminiar)");
    expect(prompt).toContain("Hot files (fan-in × churn): src/x.ts");
    expect(prompt.endsWith("do y")).toBe(true);

    const start = await handlers.SessionStart!(
      base({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(start?.hookSpecificOutput?.additionalContext).toContain("Code graph: 1 files indexed");
    expect(start?.hookSpecificOutput?.additionalContext).toContain("1 with gaps");
  });
});

describe("subagent findings", () => {
  it("indexes SubagentStop messages so em_recall can find them", async () => {
    await handlers.SubagentStop!(
      base({
        hook_event_name: "SubagentStop",
        agent_type: "Explore",
        last_assistant_message: "The leak is in pool.ts where connections are never released.",
      }),
    );
    const db = getStorage(getContext(root), { vectors: false });
    const r = await search(db, "pool leak", { mode: "lexical", filters: { source: ["session"] } });
    expect(r.hits.some((h) => h.chunk.body.includes("pool.ts"))).toBe(true);
    expect(r.hits[0]?.chunk.document.title).toBe("agent_findings");
  });
});

describe("server liveness", () => {
  it("drops markers for dead pids and keeps live ones", () => {
    const ctx = getContext(root);
    // 2^22 is above the default pid_max on Linux and macOS, so it is never a live process
    const dead = markServerAlive(ctx, 4_194_304);
    expect(liveServers(ctx)).toContain(process.pid);
    expect(liveServers(ctx)).not.toContain(4_194_304);
    dead();
  });

  it("annotates instead of denying in enforce mode when no server is running", async () => {
    const other = mkdtempSync(join(tmpdir(), "em-root-noserver-"));
    writeFileSync(join(other, "package.json"), "{}");
    writeFileSync(
      join(other, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
    );
    const out = await handlers.PreToolUse!(
      base({
        hook_event_name: "PreToolUse",
        cwd: other,
        tool_name: "Bash",
        tool_input: { command: "git log" },
      }),
    );
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out?.hookSpecificOutput?.additionalContext).toContain("em_execute");
    expect(out?.hookSpecificOutput?.additionalContext).toContain("not running");
  });
});

describe("renderWithin", () => {
  it("drops low-priority sections and trims to the budget", () => {
    const sections = [
      { title: "Last Request", priority: 1, items: ["a".repeat(500)] },
      {
        title: "Files Modified",
        priority: 1,
        items: Array.from({ length: 50 }, (_, i) => `file${i}.ts`),
      },
      { title: "Intent", priority: 4, items: ["x".repeat(900)] },
      { title: "Slow Calls", priority: 3, items: ["y".repeat(900)] },
    ];
    const out = renderWithin(sections, 1024);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(1024);
    expect(out).not.toContain("Intent");
    expect(out).toContain("Last Request");
  });
});
