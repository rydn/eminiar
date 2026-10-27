import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import {
  detectClient,
  fromCursor,
  stashContext,
  takeContext,
  toCursor,
} from "../../src/hooks/cursor.js";
import { dispatch } from "../../src/hooks/dispatch.js";
import {
  CURSOR_HOOK_EVENTS,
  cursorHooksPath,
  cursorMcpPath,
  cursorSkillsDir,
  cursorStatus,
  registerCursor,
  unregisterCursor,
} from "../../src/install/cursor.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage } from "../../src/storage/index.js";

let root: string;
let cursorHome: string;
let unmark: () => void;

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_ROUTING_MODE = "enforce";
  cursorHome = mkdtempSync(join(tmpdir(), "em-cursor-"));
  process.env.CURSOR_CONFIG_DIR = cursorHome;
  root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  writeFileSync(join(root, "big.log"), "x".repeat(30 * 1024));
  resetContextCache();
  unmark = markServerAlive(getContext(root));
});
afterAll(() => {
  unmark();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_ROUTING_MODE;
  delete process.env.CURSOR_CONFIG_DIR;
});

/** A Cursor payload: the common fields every hook carries plus event-specific ones. */
const cursor = (event: string, extra: Record<string, unknown> = {}) => ({
  conversation_id: "conv-1",
  generation_id: "gen-1",
  model: "claude-opus-4-7",
  hook_event_name: event,
  cursor_version: "2.6.0",
  workspace_roots: [root],
  user_email: null,
  transcript_path: null,
  ...extra,
});

describe("client detection", () => {
  it("honours --client and otherwise recognises Cursor payloads", () => {
    expect(detectClient({}, ["--client", "cursor"])).toBe("cursor");
    expect(detectClient(cursor("preToolUse"), ["--client", "claude"])).toBe("claude");
    expect(detectClient(cursor("preToolUse"), [])).toBe("cursor");
    expect(detectClient({ conversation_id: "c", hook_event_name: "stop" }, [])).toBe("cursor");
    expect(detectClient({ session_id: "s", cwd: "/x", hook_event_name: "PreToolUse" }, [])).toBe(
      "claude",
    );
  });
});

describe("fromCursor", () => {
  it("maps events, session, cwd and tool names to the Claude Code shape", () => {
    const i = fromCursor(
      cursor("preToolUse", {
        tool_name: "Shell",
        tool_input: { command: "npm test", working_directory: root },
        tool_use_id: "t1",
        cwd: root,
      }),
    );
    expect(i.hook_event_name).toBe("PreToolUse");
    expect(i.session_id).toBe("conv-1");
    expect(i.cwd).toBe(root);
    expect(i.tool_name).toBe("Bash");
    expect(i.tool_input?.command).toBe("npm test");
    expect(i.tool_use_id).toBe("t1");
  });

  it("parses the stringified tool result, renames duration and error fields", () => {
    const post = fromCursor(
      cursor("postToolUse", {
        tool_name: "Shell",
        tool_input: { command: "npm test" },
        tool_output: JSON.stringify({ exitCode: 0, stdout: "ok" }),
        duration: 1234,
      }),
    );
    expect(post.tool_response).toEqual({ exitCode: 0, stdout: "ok" });
    expect(post.duration_ms).toBe(1234);
    const fail = fromCursor(
      cursor("postToolUseFailure", {
        tool_name: "Read",
        tool_input: { path: "/x/y.ts" },
        error_message: "ENOENT",
        failure_type: "error",
      }),
    );
    expect(fail.error).toBe("ENOENT");
    expect(fail.tool_input?.file_path).toBe("/x/y.ts");
  });

  it("falls back to workspace_roots for cwd and maps the assistant text onto Stop", () => {
    const s = fromCursor(cursor("sessionStart", { session_id: "conv-1", composer_mode: "agent" }));
    expect(s.hook_event_name).toBe("SessionStart");
    expect(s.source).toBe("startup");
    expect(s.cwd).toBe(root);
    const r = fromCursor(cursor("afterAgentResponse", { text: "We decided to use sqlite." }));
    expect(r.hook_event_name).toBe("Stop");
    expect(r.last_assistant_message).toBe("We decided to use sqlite.");
    const sub = fromCursor(
      cursor("subagentStop", {
        subagent_type: "explore",
        status: "completed",
        summary: "found it",
      }),
    );
    expect(sub.agent_type).toBe("explore");
    expect(sub.last_assistant_message).toBe("found it");
    const mcp = fromCursor(cursor("preToolUse", { tool_name: "MCP:em_execute", tool_input: {} }));
    expect(mcp.tool_name).toBe("mcp__cursor__em_execute");
    const edit = fromCursor(
      cursor("afterFileEdit", {
        file_path: "/x/a.ts",
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    );
    expect(edit.hook_event_name).toBe("PostToolUse");
    expect(edit.tool_name).toBe("Edit");
    expect(edit.tool_input?.file_path).toBe("/x/a.ts");
  });
});

describe("toCursor", () => {
  const scope = () => ({ root, sessionId: `s-${Math.random().toString(36).slice(2)}` });

  it("always answers preToolUse with a permission", () => {
    expect(toCursor("PreToolUse", undefined, scope())).toEqual({ permission: "allow" });
    expect(toCursor("PreToolUse", {}, scope())).toEqual({ permission: "allow" });
  });

  it("denies only when Cursor has the eminiar server; otherwise allows and parks the hint", () => {
    const deny = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny" as const,
        permissionDecisionReason: "eminiar: big output. Retry with em_execute.",
      },
    };
    const sc = scope();
    // no ~/.cursor/mcp.json yet → allow, hint parked for the next tool result
    expect(toCursor("PreToolUse", deny, sc)).toEqual({ permission: "allow" });
    const flushed = toCursor("PostToolUse", undefined, sc);
    expect(flushed.additional_context).toContain("big output");
    expect(flushed.additional_context).toContain("install --cursor");

    mkdirSync(cursorHome, { recursive: true });
    writeFileSync(
      cursorMcpPath(),
      JSON.stringify({ mcpServers: { eminiar: { command: "/stable/bin/em-server" } } }),
    );
    const out = toCursor("PreToolUse", deny, scope());
    expect(out.permission).toBe("deny");
    expect(out.agent_message).toContain("Retry with em_execute");
    expect(out.user_message).toContain("eminiar");
  });

  it("carries updated_input and parks preToolUse context for the next postToolUse", () => {
    const sc = scope();
    const out = toCursor(
      "PreToolUse",
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { prompt: "prefixed" },
          additionalContext: "eminiar memory: src/a.ts is covered by decision/x",
        },
      },
      sc,
    );
    expect(out).toEqual({ permission: "allow", updated_input: { prompt: "prefixed" } });
    const post = toCursor(
      "PostToolUse",
      { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "fresh" } },
      sc,
    );
    expect(post.additional_context).toBe(
      "eminiar memory: src/a.ts is covered by decision/x\n\nfresh",
    );
    // taken once
    expect(toCursor("PostToolUse", undefined, sc)).toEqual({});
  });

  it("answers beforeSubmitPrompt with continue and parks the recall", () => {
    const sc = scope();
    const out = toCursor(
      "UserPromptSubmit",
      { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "recalled" } },
      sc,
    );
    expect(out).toEqual({ continue: true });
    expect(takeContext(root, sc.sessionId)).toBe("recalled");
  });

  it("gives sessionStart the context plus session env", () => {
    const sc = scope();
    const out = toCursor(
      "SessionStart",
      { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "brief" } },
      sc,
    );
    expect(out.additional_context).toBe("brief");
    expect(out.env).toEqual({ EMINIAR_SESSION_ID: sc.sessionId, EMINIAR_PROJECT_ROOT: root });
    expect(toCursor("SessionStart", undefined, sc).additional_context).toBeUndefined();
    expect(toCursor("Stop", undefined, sc)).toEqual({});
    expect(toCursor("PreCompact", { systemMessage: "x" }, sc)).toEqual({});
  });

  it("deduplicates parked context and drops nothing fresh", () => {
    const sc = scope();
    stashContext(root, sc.sessionId, "same");
    stashContext(root, sc.sessionId, "same");
    stashContext(root, sc.sessionId, "other");
    expect(takeContext(root, sc.sessionId)).toBe("same\n\nother");
    expect(takeContext(root, sc.sessionId)).toBeUndefined();
  });
});

describe("dispatch", () => {
  it("runs the real handlers for a Cursor payload and answers in Cursor's dialect", async () => {
    const start = JSON.parse(
      await dispatch(JSON.stringify(cursor("sessionStart", { session_id: "conv-1" })), [
        "--client",
        "cursor",
      ]),
    );
    expect(start.additional_context).toContain("eminiar is active");
    expect(start.env.EMINIAR_PROJECT_ROOT).toBe(getContext(root).root);

    // enforce routing denies a big Read through Cursor's `Read` tool (server marked live, mcp.json present)
    const read = JSON.parse(
      await dispatch(
        JSON.stringify(
          cursor("preToolUse", {
            tool_name: "Read",
            tool_input: { file_path: join(root, "big.log") },
            cwd: root,
          }),
        ),
        [],
      ),
    );
    expect(read.permission).toBe("deny");
    expect(read.agent_message).toContain("em_execute_file");

    const small = JSON.parse(
      await dispatch(
        JSON.stringify(
          cursor("preToolUse", { tool_name: "Shell", tool_input: { command: "ls" }, cwd: root }),
        ),
        [],
      ),
    );
    expect(small.permission).toBe("allow");
  });

  it("keeps the Claude Code path unchanged and survives bad input", async () => {
    expect(await dispatch("not json", [])).toBe("{}");
    expect(JSON.parse(await dispatch("{}", ["--selftest"]))).toEqual({
      systemMessage: "eminiar hook ok",
    });
    const claude = JSON.parse(
      await dispatch(
        JSON.stringify({
          session_id: "s9",
          cwd: root,
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: join(root, "big.log") },
        }),
        [],
      ),
    );
    expect(claude.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("registerCursor", () => {
  it("writes hooks, MCP server and skills, is idempotent and leaves other entries alone", () => {
    const stable = mkdtempSync(join(tmpdir(), "em-stable-"));
    mkdirSync(join(stable, "bin"));
    mkdirSync(join(stable, "skills", "em-docs"), { recursive: true });
    writeFileSync(join(stable, "skills", "em-docs", "SKILL.md"), "---\nname: em-docs\n---\n");
    mkdirSync(cursorHome, { recursive: true });
    writeFileSync(
      cursorHooksPath(),
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: "./hooks/mine.sh" }],
          afterFileEdit: [{ command: "fmt" }],
        },
      }),
    );
    writeFileSync(
      cursorMcpPath(),
      JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app" } } }),
    );

    const wrote = registerCursor(stable);
    registerCursor(stable); // second run must not duplicate
    expect(wrote.hookEvents).toEqual(CURSOR_HOOK_EVENTS);
    expect(wrote.skills).toEqual(["em-docs"]);
    const hooks = JSON.parse(readFileSync(cursorHooksPath(), "utf8"));
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.preToolUse).toHaveLength(2);
    expect(hooks.hooks.preToolUse[0].command).toBe("./hooks/mine.sh");
    expect(hooks.hooks.preToolUse[1].command).toContain("--client cursor");
    expect(hooks.hooks.preToolUse[1].matcher).toContain("Shell");
    expect(hooks.hooks.afterFileEdit).toEqual([{ command: "fmt" }]);
    expect(hooks.hooks.sessionStart).toHaveLength(1);
    const mcp = JSON.parse(readFileSync(cursorMcpPath(), "utf8"));
    expect(mcp.mcpServers.linear.url).toBe("https://mcp.linear.app");
    expect(mcp.mcpServers.eminiar.command).toBe(join(stable, "bin", "em-server"));
    expect(existsSync(join(cursorSkillsDir(), "em-docs", "SKILL.md"))).toBe(true);
    const status = cursorStatus();
    expect(status.hooks && status.mcp).toBe(true);
    expect(status.events.sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());

    unregisterCursor(stable, wrote);
    const after = JSON.parse(readFileSync(cursorHooksPath(), "utf8"));
    expect(after.hooks.preToolUse).toEqual([{ command: "./hooks/mine.sh" }]);
    expect(after.hooks.sessionStart).toBeUndefined();
    expect(after.hooks.afterFileEdit).toEqual([{ command: "fmt" }]);
    const mcpAfter = JSON.parse(readFileSync(cursorMcpPath(), "utf8"));
    expect(mcpAfter.mcpServers.eminiar).toBeUndefined();
    expect(mcpAfter.mcpServers.linear).toBeDefined();
    expect(existsSync(join(cursorSkillsDir(), "em-docs"))).toBe(false);
    expect(cursorStatus().hooks).toBe(false);
  });
});
