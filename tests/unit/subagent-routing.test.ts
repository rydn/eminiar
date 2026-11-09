import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import { agentLacksEmTools, agentLacksTool } from "../../src/hooks/routing.js";
import type { HookInput } from "../../src/hooks/types.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage } from "../../src/storage/index.js";
import { roleHasEmTool } from "../../src/swarm/agents.js";

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
  agent("with-em", `Read, Bash, ${EM}, mcp__eminiar__em_execute_file, ToolSearch`);
  agent("no-em", "Read, Bash, WebFetch");
  agent("listed-no-em", "[Read, Bash]");
  agent("inherits");
  // read-only em_* tools only, like a tools_profile: readonly worker
  agent("ro", `Read, WebFetch, ToolSearch, ${EM}, mcp__eminiar__em_history`);
  agent("all-em", "Read, WebFetch, mcp__plugin_eminiar_eminiar");
  writeFileSync(
    join(root, ".claude", "agents", "no-file-tool.md"),
    `---\nname: no-file-tool\ndescription: x\ndisallowedTools: mcp__eminiar__em_execute_file, mcp__plugin_eminiar_eminiar__em_execute_file\n---\nbody\n`,
  );
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

  it("keeps denying a subagent whose tools include the suggested em_* tool", async () => {
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

  it("lets a subagent through when it has em_* tools but not the suggested one", async () => {
    const r = await read({ agent_id: "a4", agent_type: "ro" });
    expect(r?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(String(r?.hookSpecificOutput?.additionalContext ?? "")).not.toContain("em_execute_file");
    const fetched = await handlers.PreToolUse!({
      session_id: "s1",
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/x" },
      agent_id: "a4",
      agent_type: "ro",
    });
    expect(fetched?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    // disallowedTools naming the suggested tool counts as lacking it
    const off = await read({ agent_id: "a5", agent_type: "no-file-tool" });
    expect(off?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    // a server-wide grant gives every em_* tool: keep denying
    const all = await read({ agent_id: "a6", agent_type: "all-em" });
    expect(all?.hookSpecificOutput?.permissionDecision).toBe("deny");
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

  it("parses the frontmatter as YAML: wrapped, folded, commented and server-wide forms", async () => {
    const forms: Record<string, string> = {
      "fm-flow-wrapped": "tools: [Read, Bash,\n  mcp__eminiar__em_execute_file]",
      "fm-folded": "tools: >-\n  Read,\n  mcp__eminiar__em_execute_file",
      "fm-comment": "tools:\n  # eminiar\n  - Read\n  - mcp__eminiar__em_execute_file # runner",
      "fm-server": "tools: Read, mcp__plugin_eminiar_eminiar",
      "fm-wildcard": "tools: Read, mcp__eminiar__*",
      "fm-quoted": "tools: ['Read', \"mcp__eminiar__em_execute_file\"]",
    };
    for (const [name, tools] of Object.entries(forms)) {
      writeFileSync(
        join(root, ".claude", "agents", `${name}.md`),
        `---\nname: ${name}\ndescription: x\n${tools}\n---\nbody\n`,
      );
      expect(agentLacksEmTools(root, name), name).toBe(false);
      const r = await read({ agent_id: "a7", agent_type: name });
      expect(r?.hookSpecificOutput?.permissionDecision, name).toBe("deny");
    }
  });

  it("keeps denying when the frontmatter does not parse or a tools value has another shape", async () => {
    const bad: Record<string, string> = {
      "fm-invalid": "tools: [Read, Bash",
      "fm-nested": "tools:\n  - [Read]\n  - Bash",
      "fm-empty": "tools:",
      "fm-number": "tools: 3",
      "fm-dup": "tools: Read\ntools: Bash",
    };
    for (const [name, tools] of Object.entries(bad)) {
      writeFileSync(
        join(root, ".claude", "agents", `${name}.md`),
        `---\nname: ${name}\ndescription: x\n${tools}\n---\nbody\n`,
      );
      expect(agentLacksEmTools(root, name), name).toBe(false);
      const r = await read({ agent_id: "a8", agent_type: name });
      expect(r?.hookSpecificOutput?.permissionDecision, name).toBe("deny");
    }
  });

  it("answers per tool (agentLacksTool)", () => {
    expect(agentLacksTool(root, "ro", "em_execute_file")).toBe("tool");
    expect(agentLacksTool(root, "ro", "em_fetch_and_index")).toBe("tool");
    expect(agentLacksTool(root, "ro", "em_history")).toBeUndefined();
    expect(agentLacksTool(root, "ro", "em_search")).toBeUndefined();
    expect(agentLacksTool(root, "no-em", "em_execute")).toBe("all");
    expect(agentLacksTool(root, "all-em", "em_execute_file")).toBeUndefined();
    expect(agentLacksTool(root, "no-file-tool", "em_execute_file")).toBe("tool");
    expect(agentLacksTool(root, "no-file-tool", "em_execute")).toBeUndefined();
    expect(agentLacksTool(root, "inherits", "em_execute")).toBeUndefined();
  });
});

describe("disallowedTools on an agent that inherits every tool", () => {
  const denied = (name: string, disallowed: string) =>
    writeFileSync(
      join(root, ".claude", "agents", `${name}.md`),
      `---\nname: ${name}\ndescription: x\ndisallowedTools: ${disallowed}\n---\nbody\n`,
    );

  it("keeps denying when an entry does not remove eminiar's tool under every install form", async () => {
    // Claude Code does not match a bare name or another server's tool to eminiar's tool, and
    // one install form's name leaves the other form reachable.
    const probes: Record<string, string> = {
      "dis-other-server": "mcp__other__em_execute_file",
      "dis-bare": "em_execute_file",
      "dis-settings-only": "mcp__eminiar__em_execute_file",
      "dis-plugin-only": "mcp__plugin_eminiar_eminiar__em_execute_file",
      "dis-settings-server": "mcp__eminiar__*",
      "dis-other-wide": "mcp__other__*, mcp__other",
      "dis-mixed": "mcp__other__em_execute_file, em_execute_file, mcp__eminiar__em_execute_file",
    };
    for (const [name, disallowed] of Object.entries(probes)) {
      denied(name, disallowed);
      expect(agentLacksTool(root, name, "em_execute_file"), name).toBeUndefined();
      expect(agentLacksEmTools(root, name), name).toBe(false);
      const r = await read({ agent_id: "a9", agent_type: name });
      expect(r?.hookSpecificOutput?.permissionDecision, name).toBe("deny");
      expect(String(r?.hookSpecificOutput?.additionalContext ?? ""), name).not.toContain(
        "no em_* tools",
      );
    }
  });

  it("counts the tool as removed when both install forms are named, by name or server-wide", async () => {
    const both: Record<string, string> = {
      "dis-both-names":
        "mcp__eminiar__em_execute_file, mcp__plugin_eminiar_eminiar__em_execute_file",
      "dis-name-and-server": "mcp__eminiar__em_execute_file, mcp__plugin_eminiar_eminiar__*",
    };
    for (const [name, disallowed] of Object.entries(both)) {
      denied(name, disallowed);
      expect(agentLacksTool(root, name, "em_execute_file"), name).toBe("tool");
      expect(agentLacksTool(root, name, "em_search"), name).toBeUndefined();
      const r = await read({ agent_id: "a10", agent_type: name });
      expect(r?.hookSpecificOutput?.permissionDecision, name).toBeUndefined();
    }
  });

  it("reports no em_* tools only when both eminiar servers are disallowed", async () => {
    for (const [name, disallowed] of Object.entries({
      "dis-both-servers": "mcp__eminiar__*, mcp__plugin_eminiar_eminiar__*",
      "dis-both-servers-bare": "mcp__eminiar, mcp__plugin_eminiar_eminiar",
    })) {
      denied(name, disallowed);
      expect(agentLacksTool(root, name, "em_execute_file"), name).toBe("all");
      expect(agentLacksEmTools(root, name), name).toBe(true);
      const r = await read({ agent_id: "a11", agent_type: name });
      expect(r?.hookSpecificOutput?.permissionDecision, name).toBeUndefined();
      expect(String(r?.hookSpecificOutput?.additionalContext), name).toContain("no em_* tools");
    }
    // one server-wide entry plus the other form's tools allowlist: still no em_* tool at all
    writeFileSync(
      join(root, ".claude", "agents", "dis-plugin-server-listed.md"),
      `---\nname: dis-plugin-server-listed\ntools: Read, ${EM}\ndisallowedTools: mcp__plugin_eminiar_eminiar__*\n---\n`,
    );
    expect(agentLacksTool(root, "dis-plugin-server-listed", "em_search")).toBe("all");
  });
});

describe("roleHasEmTool with disallowed_tools", () => {
  it("ignores bare names, other servers and a single install form", () => {
    for (const disallowedTools of [
      ["em_docs"],
      ["mcp__other__em_docs"],
      ["mcp__eminiar__em_docs"],
      ["mcp__plugin_eminiar_eminiar__em_docs"],
      ["mcp__eminiar__*"],
      ["mcp__other__*"],
    ])
      expect(roleHasEmTool({ disallowedTools }, "em_docs"), disallowedTools.join()).toBe(true);
  });

  it("removes the tool when both install forms are named, by name or server-wide", () => {
    for (const disallowedTools of [
      ["mcp__eminiar__em_docs", "mcp__plugin_eminiar_eminiar__em_docs"],
      ["mcp__eminiar", "mcp__plugin_eminiar_eminiar__*"],
    ])
      expect(roleHasEmTool({ disallowedTools }, "em_docs"), disallowedTools.join()).toBe(false);
    // the generated runner disallows (Bash off) still remove the command runners
    expect(roleHasEmTool({ disallowedTools: ["Bash"] }, "em_execute")).toBe(false);
  });
});
