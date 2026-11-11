import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  it("keeps denying, fast, when the frontmatter is too big to parse on the hook path", async () => {
    // yaml's duplicate-key check is quadratic: 8k keys took ~250 ms per hook process.
    const keys = Array.from({ length: 8000 }, (_, i) => `k${i}: v`).join("\n");
    const big: Record<string, string> = {
      "fm-8k-keys": `tools: Read, Bash\n${keys}`,
      // under the size cap but over the line cap
      "fm-many-lines": `tools: Read, Bash\n${Array.from({ length: 450 }, (_, i) => `k${i}: v`).join("\n")}`,
      // one line over the size cap
      "fm-long-line": `tools: Read, Bash\nx: {${Array.from({ length: 2500 }, (_, i) => `k${i}: v`).join(", ")}}`,
    };
    for (const [name, fm] of Object.entries(big)) {
      writeFileSync(
        join(root, ".claude", "agents", `${name}.md`),
        `---\nname: ${name}\ndescription: x\n${fm}\n---\nbody\n`,
      );
      const t0 = performance.now();
      expect(agentLacksTool(root, name, "em_execute_file"), name).toBeUndefined();
      expect(performance.now() - t0, name).toBeLessThan(100);
      const r = await read({ agent_id: "a12", agent_type: name });
      expect(r?.hookSpecificOutput?.permissionDecision, name).toBe("deny");
    }
    // a normal-size frontmatter with the same tools is still read
    writeFileSync(
      join(root, ".claude", "agents", "fm-small-keys.md"),
      `---\nname: fm-small-keys\ntools: Read, Bash\n${Array.from({ length: 300 }, (_, i) => `k${i}: v`).join("\n")}\n---\n`,
    );
    expect(agentLacksTool(root, "fm-small-keys", "em_execute_file")).toBe("all");
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

describe("roleHasEmTool with a tools list", () => {
  it("grants only the worker em_* tools, not every one the server has", () => {
    expect(roleHasEmTool({ tools: ["Read"] }, "em_search")).toBe(true);
    expect(roleHasEmTool({ tools: ["Read"] }, "em_graph_changes")).toBe(false);
    expect(roleHasEmTool({ tools: ["Read"] }, "em_stats")).toBe(false);
    // no tools key: every tool is inherited
    expect(roleHasEmTool({}, "em_stats")).toBe(true);
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

describe("finding the agent file by its frontmatter name", () => {
  const raw = (dir: string, file: string, name: string, tools: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, file),
      `---\nname: ${name}\ndescription: x\ntools: ${tools}\n---\nbody\n`,
    );
  };

  it("matches a project agent whose file name differs from its `name`", () => {
    raw(join(root, ".claude", "agents"), "code-reviewer.md", "reviewer", "Read, Grep, Glob");
    expect(agentLacksTool(root, "code-reviewer", "em_symbols")).toBe("all");
    expect(agentLacksTool(root, "reviewer", "em_symbols")).toBe("all");
    expect(agentLacksEmTools(root, "reviewer")).toBe(true);
  });

  it("reads a quoted name with a trailing comment", () => {
    raw(join(root, ".claude", "agents"), "quoted.md", '"fancy-name" # shown in the list', "Read");
    expect(agentLacksTool(root, "fancy-name", "em_symbols")).toBe("all");
  });

  it("looks in the user's agents directory too", () => {
    const home = mkdtempSync(join(tmpdir(), "em-sar-claude-"));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      raw(join(home, "agents"), "mine.md", "user-agent", "Read");
      expect(agentLacksTool(root, "user-agent", "em_symbols")).toBe("all");
      raw(join(home, "agents"), "user-direct.md", "other", "Read");
      expect(agentLacksTool(root, "user-direct", "em_symbols")).toBe("all");
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps denying for an unknown type, a plugin-namespaced type and an empty tools list", () => {
    expect(agentLacksTool(root, "nobody", "em_symbols")).toBeUndefined();
    expect(agentLacksTool(root, "myplugin:reviewer", "em_symbols")).toBeUndefined();
    raw(join(root, ".claude", "agents"), "empty-list.md", "empty-list", "[]");
    expect(agentLacksTool(root, "empty-list", "em_symbols")).toBeUndefined();
  });

  it("treats a bare or foreign-server name in `tools:` as unsure, so it keeps denying", () => {
    raw(join(root, ".claude", "agents"), "bare.md", "bare", "Read, em_execute_file");
    raw(
      join(root, ".claude", "agents"),
      "foreign.md",
      "foreign",
      "Read, mcp__other__em_execute_file",
    );
    expect(agentLacksTool(root, "bare", "em_execute_file")).toBeUndefined();
    expect(agentLacksTool(root, "foreign", "em_execute_file")).toBeUndefined();
  });
});

describe("the prompt prefix on a spawn", () => {
  const spawn = (type: string) =>
    handlers.PreToolUse!({
      session_id: "s1",
      cwd: root,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: type, description: "d", prompt: "look at it" },
    });
  const promptOf = (out: Awaited<ReturnType<typeof spawn>>): string | undefined =>
    (out?.hookSpecificOutput as { updatedInput?: { prompt?: string } } | undefined)?.updatedInput
      ?.prompt;

  it("leaves the prompt alone for an agent that has no em_* tools", async () => {
    expect(promptOf(await spawn("no-em"))).toBeUndefined();
  });

  it("prefixes an agent that has them", async () => {
    expect(promptOf(await spawn("inherits"))).toMatch(/^Use the eminiar tools \(em_execute,/);
  });

  it("leaves out the runners an agent's own tools list lacks", async () => {
    const out = promptOf(await spawn("ro"));
    expect(out).toMatch(/^Use the eminiar tools \(/);
    expect(out).not.toMatch(/^Use the eminiar tools \(em_execute/);
  });
});
