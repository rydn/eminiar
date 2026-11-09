import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import { agentLacksEmTools } from "../../src/hooks/routing.js";
import type { HookInput } from "../../src/hooks/types.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage } from "../../src/storage/index.js";

const savedEnv = {
  EMINIAR_HOME: process.env.EMINIAR_HOME,
  EMINIAR_ROUTING_MODE: process.env.EMINIAR_ROUTING_MODE,
  EMINIAR_PROJECT_ROOT: process.env.EMINIAR_PROJECT_ROOT,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
};
let root: string;
let unmark: () => void;

const EM = "mcp__plugin_eminiar_eminiar__em_search";

function agent(name: string, tools?: string): void {
  const fm = tools === undefined ? "" : `tools: ${tools}\n`;
  writeFileSync(
    join(root, ".claude", "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: x\n${fm}---\nbody\n`,
  );
}

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-sar-home-"));
  process.env.EMINIAR_ROUTING_MODE = "enforce";
  root = realpathSync(mkdtempSync(join(tmpdir(), "em-sar-")));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  agent("with-em", `Read, Bash, ${EM}, ToolSearch`);
  agent("no-em", "Read, Bash, WebFetch");
  agent("listed-no-em", "[Read, Bash]");
  agent("inherits");
  writeFileSync(join(root, ".claude", "agents", "broken.md"), "no frontmatter at all");
  mkdirSync(join(root, ".claude", "agents", "unreadable.md"));
  writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.EMINIAR_PROJECT_ROOT = root;
  resetContextCache();
  unmark = markServerAlive(getContext(root));
});

afterAll(() => {
  unmark();
  closeAllStorage();
  for (const [k, v] of Object.entries(savedEnv))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const read = (over: Partial<HookInput>) =>
  handlers.PreToolUse!({
    session_id: "s1",
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: join(root, "big.txt") },
    ...over,
  });

describe("enforce routing inside subagents without em_* tools", () => {
  it("keeps denying the main session", async () => {
    const r = await read({});
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("keeps denying a subagent whose tools include an em_* tool", async () => {
    const r = await read({ agent_id: "a1", agent_type: "with-em" });
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("annotates instead of denying a subagent whose tools list has no em_* tool", async () => {
    for (const type of ["no-em", "listed-no-em"]) {
      const r = await read({ agent_id: "a2", agent_type: type });
      expect(r?.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(String(r?.hookSpecificOutput?.additionalContext)).toContain("no em_* tools");
    }
  });

  it("does not treat the main session's agent_type alone as a subagent", async () => {
    const r = await read({ agent_type: "no-em" });
    expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("fails open to denying when the agent file is missing, unreadable or has no tools key", async () => {
    for (const type of ["inherits", "broken", "unreadable", "ghost", "../evil"]) {
      const r = await read({ agent_id: "a3", agent_type: type });
      expect(r?.hookSpecificOutput?.permissionDecision).toBe("deny");
    }
  });
});

describe("agentLacksEmTools", () => {
  it("reads the frontmatter tools list, list form included", () => {
    expect(agentLacksEmTools(root, "no-em")).toBe(true);
    expect(agentLacksEmTools(root, "with-em")).toBe(false);
    writeFileSync(
      join(root, ".claude", "agents", "yaml-list.md"),
      `---\nname: yaml-list\ntools:\n  - Read\n  - mcp__eminiar__em_execute\n---\n`,
    );
    expect(agentLacksEmTools(root, "yaml-list")).toBe(false);
    expect(agentLacksEmTools(root, undefined)).toBe(false);
    expect(agentLacksEmTools(join(root, "nope"), "no-em")).toBe(false);
  });
});
