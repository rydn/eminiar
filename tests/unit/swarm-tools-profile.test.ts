import { describe, expect, it } from "vitest";
import {
  EM_MCP_PREFIXES,
  READONLY_BUILTINS,
  READONLY_EM_TOOLS,
  renderAgentFile,
} from "../../src/swarm/agents.js";
import { parseSwarmYaml } from "../../src/swarm/config.js";
import type { SwarmConfig } from "../../src/swarm/types.js";
import { tools } from "../../src/tools/index.js";

const parse = (yaml: string) =>
  parseSwarmYaml(yaml, "/x/.eminiar/swarm.yaml", ".eminiar/swarm.yaml");
const file = (role: string) =>
  `version: 1\nswarms:\n  s:\n    description: d\n    agents:\n      r:\n        description: x\n${role}`;
const ok = (yaml: string): SwarmConfig => {
  const r = parse(yaml);
  if (r.state !== "ok") throw new Error(JSON.stringify(r));
  return r.config;
};
const render = (role: string) => {
  const c = ok(file(role));
  return renderAgentFile(c, c.swarms[0]!, c.swarms[0]!.roles[0]!);
};
const fmLine = (out: string, key: string) =>
  out
    .split("\n")
    .find((l) => l.startsWith(`${key}: `))
    ?.slice(key.length + 2);

describe("tools_profile: readonly", () => {
  it("is off by default: no tools line, no restriction", () => {
    const out = render("");
    expect(fmLine(out, "tools")).toBeUndefined();
    expect(fmLine(out, "disallowedTools")).toBe("Agent");
    expect(out).toContain("em_remember");
  });

  it("allowlists read-only built-ins and read-only em_* tools only", () => {
    const out = render("        tools_profile: readonly\n");
    const allowed = fmLine(out, "tools")!.split(", ");
    for (const t of READONLY_BUILTINS) expect(allowed).toContain(t);
    for (const p of EM_MCP_PREFIXES)
      for (const t of READONLY_EM_TOOLS) expect(allowed).toContain(p + t);
    for (const bad of ["Bash", "Edit", "Write", "NotebookEdit", "Agent"])
      expect(allowed).not.toContain(bad);
    expect(
      allowed.filter((t) =>
        /em_(execute|execute_file|batch_execute|remember|memory|docs)$/.test(t),
      ),
    ).toEqual([]);
    expect(fmLine(out, "disallowedTools")).toBe("Agent, Edit, Write, NotebookEdit");
    expect(out).not.toContain("git stash");
    expect(out).not.toContain("`em_remember` so later");
  });

  it("keeps the em_* list equal to the READ_ONLY annotated tools plus em_swarm", () => {
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    // em_doctor, em_stats, em_index_status and em_graph_changes are read-only but not worker tools.
    for (const t of READONLY_EM_TOOLS) {
      const def = tools.find((d) => d.name === t);
      expect(def, t).toBeDefined();
      if (t !== "em_swarm") expect(readOnly, t).toContain(t);
    }
    expect(tools.find((d) => d.name === "em_swarm")?.annotations.readOnlyHint).toBe(false);
  });

  it("a tools list narrows the built-ins", () => {
    const allowed = fmLine(
      render("        tools_profile: readonly\n        tools: [Read]\n"),
      "tools",
    )!.split(", ");
    expect(allowed).toContain("Read");
    expect(allowed).not.toContain("Grep");
    expect(allowed).toContain("ToolSearch");
  });

  it("rejects a tool that can write and a bad value", () => {
    const r = parse(file("        tools_profile: readonly\n        tools: [Read, Bash]\n"));
    expect(r.state).toBe("invalid");
    if (r.state === "invalid")
      expect(
        r.issues.some((i) => i.path.endsWith("agents.r.tools") && i.message.includes("Bash")),
      ).toBe(true);
    const bad = parse(file("        tools_profile: readwrite\n"));
    expect(bad.state).toBe("invalid");
  });
});
