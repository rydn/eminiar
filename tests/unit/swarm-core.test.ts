import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { getContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import {
  generatedState,
  planAgentSync,
  renderAgentFile,
  syncAgents,
  workerTools,
} from "../../src/swarm/agents.js";
import { coordinatorBrief, taskBrief, workerBrief } from "../../src/swarm/brief.js";
import {
  activeSwarmConfig,
  enforceIntent,
  findRole,
  loadSwarmConfig,
  parseSwarmYaml,
  resetSwarmConfigCache,
  STARTER_YAML,
} from "../../src/swarm/config.js";
import { capOutput, OUTPUT_MAX } from "../../src/swarm/format.js";
import { globMatch, inScope } from "../../src/swarm/glob.js";
import {
  addTasks,
  callerOf,
  claimTask,
  closeWorker,
  finishRun,
  postNote,
  recordActivity,
  registerWorker,
  reserveSpawn,
  runSnapshot,
  STALE_MS,
  SwarmError,
  startRun,
  taskRef,
  toolHead,
  updateTask,
} from "../../src/swarm/runtime.js";
import type { SwarmConfig } from "../../src/swarm/types.js";
import { ENFORCE_FORMS } from "./swarm-enforce-forms.js";

const parse = (yaml: string) =>
  parseSwarmYaml(yaml, "/x/.eminiar/swarm.yaml", ".eminiar/swarm.yaml");
const ok = (yaml: string): SwarmConfig => {
  const r = parse(yaml);
  if (r.state !== "ok") throw new Error(JSON.stringify(r));
  return r.config;
};

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
        memory_tags: [decision]
      tester:
        description: tests code
  line:
    description: pipeline swarm
    topology: pipeline
    stages: [plan, build, check]
    agents:
      plan: { description: plans }
      build: { description: builds }
      check: { description: checks }
  peers:
    description: mesh swarm
    topology: mesh
    agents:
      a: { description: peer a }
      b: { description: peer b }
`;

describe("swarm config", () => {
  it("parses the starter file", () => {
    const c = ok(STARTER_YAML);
    expect(c.swarms.map((s) => s.name)).toEqual(["feature", "review"]);
    const coder = findRole(c, "swarm-feature-coder");
    expect(coder?.role.count).toBe(2);
    expect(coder?.role.model).toBe("sonnet");
    expect(findRole(c, "swarm-feature-architect")?.role.model).toBe("opus");
    expect(c.swarms[1]!.topology).toBe("mesh");
  });

  it("resolves defaults, context layering and pipeline stages", () => {
    const c = ok(`
defaults:
  model: haiku
  context: { memories: 1, max_chars: 1000 }
swarms:
  s:
    description: d
    topology: pipeline
    context: { docs: 0 }
    agents:
      x: { description: dx, context: { history: false } }
      y: { description: dy, model: opus }
`);
    const s = c.swarms[0]!;
    expect(s.stages).toEqual(["x", "y"]);
    expect(s.roles[0]!.model).toBe("haiku");
    expect(s.roles[1]!.model).toBe("opus");
    expect(s.roles[0]!.context).toMatchObject({
      memories: 1,
      docs: 0,
      history: false,
      maxChars: 1000,
    });
    expect(c.enabled).toBe(true);
    expect(c.sync).toBe("auto");
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports typos, bad names and bad stages with paths and lines", () => {
    const r = parse(`swarms:
  s:
    description: d
    max_agent: 3
    agents:
      Bad_Name: { description: x }
`);
    expect(r.state).toBe("invalid");
    if (r.state !== "invalid") return;
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("swarms.s");
    expect(r.issues.some((i) => i.path.startsWith("swarms.s.agents") && i.line === 6)).toBe(true);

    const st = parse(`swarms:
  s:
    description: d
    topology: pipeline
    stages: [a, nope, a]
    agents:
      a: { description: x }
`);
    expect(st.state).toBe("invalid");
    if (st.state === "invalid") {
      expect(st.issues.map((i) => i.path)).toContain("swarms.s.stages.1");
      expect(st.issues.some((i) => /only once/.test(i.message))).toBe(true);
    }
  });

  it("rejects agent-name collisions and over-long names", () => {
    const r = parse(`swarms:
  a-b:
    description: d
    agents:
      c: { description: x }
  a:
    description: d
    agents:
      b-c: { description: x }
`);
    expect(r.state).toBe("invalid");
    if (r.state === "invalid") expect(r.issues[0]!.message).toMatch(/also produced by/);
    const long = parse(`swarms:
  ${"s".repeat(32)}:
    description: d
    agents:
      ${"r".repeat(32)}: { description: x }
`);
    expect(long.state).toBe("invalid");
  });

  it("rejects malformed hooks, unsafe scopes and YAML syntax errors", () => {
    expect(
      parse(`swarms:
  s:
    description: d
    agents:
      a:
        description: x
        hooks: { PostToolUse: [{ hooks: [] }] }
`).state,
    ).toBe("invalid");
    expect(
      parse(`swarms:
  s:
    description: d
    agents:
      a: { description: x, scope: ["../etc/**"] }
`).state,
    ).toBe("invalid");
    const syn = parse("swarms: [unclosed");
    expect(syn.state).toBe("invalid");
    if (syn.state === "invalid") expect(syn.issues[0]!.line).toBe(1);
    expect(parse("").state).toBe("invalid");
    expect(parse("swarms: {}").state).toBe("invalid");
  });
});

describe("swarm config written for a newer eminiar", () => {
  const FUTURE = `version: 1
background_default: true
defaults:
  model: sonnet
  later_default: 1
swarms:
  s:
    description: d
    retries: 2
    agents:
      a:
        description: x
        count: 2
        retry_policy: plan
        context: { docs: 1, rerank: true }
        hooks:
          SubagentStop: [{ hooks: [{ type: command, command: "echo" }] }]
          PostToolUse: [{ hooks: [{ type: command, command: "echo", async: true }] }]
`;

  const KNOWN = `version: 1
defaults:
  model: sonnet
swarms:
  s:
    description: d
    agents:
      a:
        description: x
        count: 2
        context: { docs: 1 }
        hooks:
          PostToolUse: [{ hooks: [{ type: command, command: "echo" }] }]
`;

  it("ignores unknown keys, one note per key in file order, and keeps every known setting", () => {
    const c = ok(FUTURE);
    expect(c.ignoredKeys.map((w) => [w.path, w.message.match(/"(.+?)"/)?.[1], w.line])).toEqual([
      ["", "background_default", 2],
      ["defaults", "later_default", 5],
      ["swarms.s", "retries", 9],
      ["swarms.s.agents.a", "retry_policy", 14],
      ["swarms.s.agents.a.context", "rerank", 15],
      ["swarms.s.agents.a.hooks", "SubagentStop", 17],
      ["swarms.s.agents.a.hooks.PostToolUse.0.hooks.0", "async", 18],
    ]);
    expect(c.ignoredKeys[1]!.message).toBe(
      'unknown key "later_default" ignored: not a setting in this eminiar version',
    );
    const role = c.swarms[0]!.roles[0]!;
    expect(role).toMatchObject({ model: "sonnet", count: 2 });
    expect(role.context).toMatchObject({ docs: 1 });
    expect(role.hooks).toEqual({
      PostToolUse: [{ hooks: [{ type: "command", command: "echo" }] }],
    });
    // the agent file is the one the same file without those keys gives
    const k = ok(KNOWN);
    expect(renderAgentFile(c, c.swarms[0]!, role)).toBe(
      renderAgentFile(k, k.swarms[0]!, k.swarms[0]!.roles[0]!),
    );
    expect(k.ignoredKeys).toEqual([]);
  });

  it("keeps a typo of a known key an error, with the key it is close to", () => {
    for (const [line, near] of [
      ["        disallowedTools: [Bash]", "disallowed_tools"],
      ["        Tools: [Read]", "tools"],
      ["        MAX_TURNS: 5", "max_turns"],
      ["        max_turn: 5", "max_turns"],
      ["        isolaton: worktree", "isolation"],
      // two edits, allowed for a key of 7+ characters
      ["        disalowed_tool: [Bash]", "disallowed_tools"],
      // the known limit: a new key this close to an existing one reads as a typo too
      ["        min_turns: 5", "max_turns"],
    ] as const) {
      const r = parse(
        `swarms:\n  s:\n    description: d\n    agents:\n      a:\n        description: x\n${line}\n`,
      );
      expect(r.state, line).toBe("invalid");
      if (r.state !== "invalid") continue;
      expect(r.issues).toEqual([
        {
          path: "swarms.s.agents.a",
          message: expect.stringContaining(`did you mean "${near}"?`),
          line: 7,
        },
      ]);
    }
    const top = parse(
      `enforced: true\nswarms:\n  s: { description: d, agents: { a: { description: x } } }\n`,
    );
    expect(top.state === "invalid" && top.issues[0]!.message).toBe(
      'unknown key "enforced" (did you mean "enforce"?)',
    );
  });

  it("still runs the refinements of an object that has an unknown key", () => {
    const r = parse(`swarms:
  s:
    description: d
    agents:
      a: { description: x, model: sonnet, model_range: { floor: opus, ceiling: haiku, step: 1 } }
`);
    expect(r.state).toBe("invalid");
    if (r.state === "invalid")
      expect(r.issues.map((i) => i.message)).toEqual([
        expect.stringMatching(/floor must not be above ceiling/),
      ]);
  });

  it("reads an object a YAML alias shares between two places", () => {
    const c = ok(`defaults: &d { future_knob: 1 }
swarms:
  s:
    description: d
    agents:
      a: { description: x, context: *d }
`);
    expect(c.ignoredKeys.map((w) => w.path).sort()).toEqual([
      "defaults",
      "swarms.s.agents.a.context",
    ]);
  });

  it("keeps a known key at the wrong level an error, not an ignored key", () => {
    const agent = "agents:\n      a: { description: x }\n";
    for (const [yaml, path] of [
      [
        `swarms:\n  s:\n    description: d\n    ${agent}defaults: { disallowed_tools: [Bash] }\n`,
        "defaults",
      ],
      [`swarms:\n  s:\n    description: d\n    tools: [Read]\n    ${agent}`, "swarms.s"],
      [`defaults: { enforce: true }\nswarms:\n  s:\n    description: d\n    ${agent}`, "defaults"],
    ] as const) {
      const r = parse(yaml);
      expect(r.state, yaml).toBe("invalid");
      if (r.state === "invalid")
        expect(r.issues).toEqual([
          { path, message: expect.stringContaining("not allowed here"), line: expect.any(Number) },
        ]);
    }
  });

  it("reports a typo and a bad value together, and no ignored key while the file is invalid", () => {
    const r = parse(
      "swarms:\n  s:\n    description: d\n    retries: 2\n    max_agent: 3\n    agents:\n      a: { description: x, count: 0 }\n",
    );
    expect(r.state).toBe("invalid");
    if (r.state === "invalid")
      expect(r.issues.map((i) => i.path)).toEqual(["swarms.s", "swarms.s.agents.a.count"]);
  });
});

describe("agent files under a swarm file with ignored keys", () => {
  it("keeps the files a newer eminiar generated unless forced, and still creates missing ones", () => {
    const root = mkdtempSync(join(tmpdir(), "em-held-"));
    // what the newer eminiar wrote: a generated file this version would render differently
    const newer = ok(
      "swarms:\n  s:\n    description: d\n    agents:\n      a: { description: newer }\n",
    );
    syncAgents(root, newer);
    const file = join(root, ".claude", "agents", "swarm-s-a.md");
    const before = readFileSync(file, "utf8");
    const c = ok(
      "swarms:\n  s:\n    description: d\n    agents:\n      a: { description: x, retry_policy: plan }\n      b: { description: y }\n",
    );
    const r = syncAgents(root, c);
    // a create has no newer file to lose; an update would rewrite one
    expect(r.changed).toBe(1);
    expect(r.actions.map((a) => [a.agentType, a.action, a.held])).toEqual([
      ["swarm-s-a", "conflict", true],
      ["swarm-s-b", "create", undefined],
    ]);
    expect(r.actions[0]!.reason).toMatch(
      /^kept: .*keys this eminiar version does not know.*--force/,
    );
    expect(readFileSync(file, "utf8")).toBe(before);
    // created in full: a valid generated file
    expect(
      generatedState(readFileSync(join(root, ".claude", "agents", "swarm-s-b.md"), "utf8")),
    ).toBe("generated");
    // a delete is never held: removing an agent only restricts
    const fewer = ok(
      "swarms:\n  s:\n    description: d\n    agents:\n      a: { description: newer, retry_policy: plan }\n",
    );
    expect(syncAgents(root, fewer).actions.find((a) => a.agentType === "swarm-s-b")).toMatchObject({
      action: "delete",
    });
    // --force writes anyway
    expect(syncAgents(root, c, { force: true }).changed).toBe(2);
    expect(readFileSync(file, "utf8")).not.toBe(before);
  });
});

describe("swarm globs", () => {
  it("matches scopes", () => {
    expect(inScope("src/ui/web/app.tsx", ["src/ui"])).toBe(true);
    expect(inScope("src/uix/a.ts", ["src/ui"])).toBe(false);
    expect(inScope("src/a/b/c.ts", ["src/**/*.ts"])).toBe(true);
    expect(inScope("src/c.ts", ["src/**/*.ts"])).toBe(true);
    expect(inScope("src/c.tsx", ["src/*.{ts,tsx}"])).toBe(true);
    expect(inScope("lib/c.ts", ["src/**"])).toBe(false);
    expect(inScope("anything", [])).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a.c", "abc")).toBe(false);
  });
});

describe("swarm agent files", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "em-swarm-agents-"));
  });

  it("renders valid frontmatter that survives hostile text", () => {
    const c = ok(`swarms:
  s:
    description: d
    agents:
      a:
        description: 'quotes " and: colons and # hashes'
        prompt: "---\\nname: evil\\n---"
        tools: [Read]
        skills: [eminiar:em-history]
        hooks:
          PostToolUse:
            - matcher: "Edit|Write"
              hooks: [{ type: command, command: "echo 'hi: there'" }]
`);
    const s = c.swarms[0]!;
    const text = renderAgentFile(c, s, s.roles[0]!);
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(m).not.toBeNull();
    const fm = parseYaml(m![1]!) as Record<string, unknown>;
    expect(fm.name).toBe("swarm-s-a");
    expect(String(fm.description)).toContain('quotes " and: colons and # hashes');
    expect(fm.name).toBe("swarm-s-a");
    expect(String(fm.tools)).toContain("mcp__plugin_eminiar_eminiar__em_swarm");
    expect(String(fm.tools)).toContain("mcp__eminiar__em_recall");
    expect(fm.skills).toEqual(["eminiar:em-history"]);
    expect(fm.disallowedTools).toBe("Agent");
    expect((fm.hooks as Record<string, unknown>).PostToolUse).toBeTruthy();
    expect(text).toContain("<!-- eminiar:swarm swarm=s role=a");
    expect(
      workerTools(["Read", "mcp__eminiar__em_swarm"]).filter((t) => t === "mcp__eminiar__em_swarm"),
    ).toHaveLength(1);
  });

  it("always disallows Agent so workers stay leaves, merged with disallowed_tools without duplicates", () => {
    const c = ok(`
version: 1
swarms:
  s:
    description: d
    agents:
      a:
        description: x
        disallowed_tools: [Write, Agent]
      b:
        description: y
`);
    const s = c.swarms[0]!;
    const dis = (i: number) => {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(renderAgentFile(c, s, s.roles[i]!));
      return (parseYaml(m![1]!) as Record<string, unknown>).disallowedTools;
    };
    expect(dis(0)).toBe("Write, Agent");
    expect(dis(1)).toBe("Agent");
  });

  it("gives the em_execute tools only to a role that keeps Bash", () => {
    const c = ok(`
swarms:
  s:
    description: d
    agents:
      reader: { description: x, tools: [Read, Grep] }
      shell: { description: x, tools: [Read, Bash] }
      shell-off: { description: x, tools: [Read, Bash], disallowed_tools: [Bash] }
      inherits: { description: x }
      inherits-off: { description: x, disallowed_tools: [Bash] }
`);
    const s = c.swarms[0]!;
    const fm = (role: string) => {
      const text = renderAgentFile(c, s, s.roles.find((r) => r.role === role)!);
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      const f = parseYaml(m![1]!) as Record<string, string | undefined>;
      const list = (v: string | undefined) => (v ? v.split(", ") : []);
      return { tools: list(f.tools), disallowed: list(f.disallowedTools) };
    };
    const exec = [
      "mcp__plugin_eminiar_eminiar__em_execute",
      "mcp__plugin_eminiar_eminiar__em_execute_file",
      "mcp__plugin_eminiar_eminiar__em_batch_execute",
      "mcp__eminiar__em_execute",
      "mcp__eminiar__em_execute_file",
      "mcp__eminiar__em_batch_execute",
    ];
    const reader = fm("reader");
    expect(reader.tools).toContain("mcp__eminiar__em_search");
    for (const t of exec) expect(reader.tools).not.toContain(t);
    expect(fm("shell").tools).toEqual(expect.arrayContaining(exec));
    for (const t of exec) expect(fm("shell-off").tools).not.toContain(t);
    // without a tools list the worker inherits every MCP tool: Bash off takes them off too
    expect(fm("inherits").disallowed).toEqual(["Agent"]);
    expect(fm("inherits-off").disallowed).toEqual(["Bash", "Agent", ...exec]);
    expect(fm("shell-off").disallowed).toEqual(["Bash", "Agent", ...exec]);
    expect(workerTools(["Read"]).some((t) => t.includes("em_execute"))).toBe(false);
    expect(workerTools(["Bash"]).filter((t) => t.includes("em_execute"))).toHaveLength(4);
  });

  it("tells shared-tree workers with a shell to leave git state alone; others are not told", () => {
    const c = ok(`
swarms:
  s:
    description: d
    agents:
      shared: { description: x }
      isolated: { description: x, isolation: worktree }
      listed: { description: x, tools: [Read, Bash] }
      no-shell: { description: x, tools: [Read, Edit] }
      bash-off: { description: x, disallowed_tools: [Bash] }
`);
    const s = c.swarms[0]!;
    const body = (i: number) => renderAgentFile(c, s, s.roles[i]!);
    for (const i of [0, 2]) {
      expect(body(i)).toMatch(/^3\. Other workers may be editing this working tree/m);
      expect(body(i)).toContain("Never run `git stash`, `git checkout`");
      expect(body(i)).toContain("`git add -A` or `git commit -a`");
      expect(body(i)).toMatch(/^7\. Your final message goes back/m);
    }
    // a worktree has no other workers in it, and a role without a shell cannot run git
    for (const i of [1, 3, 4]) {
      expect(body(i)).not.toContain("git stash");
      expect(body(i)).toMatch(/^6\. Your final message goes back/m);
    }
  });

  it("respects a role that lists Agent or Task in its own tools", () => {
    const c = ok(`
version: 1
swarms:
  s:
    description: d
    agents:
      a:
        description: x
        tools: [Read, Agent]
      b:
        description: y
        tools: [Read, Task]
        disallowed_tools: [Write]
      c:
        description: z
        tools: [Read]
`);
    const s = c.swarms[0]!;
    const fm = (i: number) => {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(renderAgentFile(c, s, s.roles[i]!));
      return parseYaml(m![1]!) as Record<string, unknown>;
    };
    expect(fm(0).disallowedTools).toBeUndefined();
    expect(String(fm(0).tools)).toContain("Agent");
    expect(fm(1).disallowedTools).toBe("Write");
    expect(fm(2).disallowedTools).toBe("Agent");
  });

  it("syncs, is idempotent, never touches hand-written files and prunes", () => {
    const c = ok(BASIC);
    const dir = join(root, ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "swarm-feat-tester.md"), "---\nname: swarm-feat-tester\n---\nmine");
    writeFileSync(join(dir, "other.md"), "---\nname: other\n---\nkeep");
    const first = syncAgents(root, c);
    expect(first.conflicts).toBe(1);
    expect(first.actions.find((a) => a.agentType === "swarm-feat-tester")?.action).toBe("conflict");
    expect(readFileSync(join(dir, "swarm-feat-tester.md"), "utf8")).toContain("mine");
    expect(existsSync(join(dir, "swarm-feat-coder.md"))).toBe(true);
    const again = syncAgents(root, c);
    expect(again.changed).toBe(0);
    // dropping a swarm prunes only its generated files
    const smaller = ok(`swarms:
  feat:
    description: test swarm
    agents:
      coder: { description: writes code }
`);
    const pruned = syncAgents(root, smaller);
    expect(
      pruned.actions
        .filter((a) => a.action === "delete")
        .map((a) => a.agentType)
        .sort(),
    ).toEqual([
      "swarm-line-build",
      "swarm-line-check",
      "swarm-line-plan",
      "swarm-peers-a",
      "swarm-peers-b",
    ]);
    expect(pruned.actions.find((a) => a.agentType === "swarm-feat-coder")?.action).toBe("update");
    // disabled → every generated file goes, hand-written ones stay
    syncAgents(root, undefined);
    expect(existsSync(join(dir, "swarm-feat-coder.md"))).toBe(false);
    expect(existsSync(join(dir, "swarm-feat-tester.md"))).toBe(true);
    expect(existsSync(join(dir, "other.md"))).toBe(true);
    expect(planAgentSync(root, undefined)).toEqual([]);
  });
});

describe("swarm runtime", () => {
  let root: string;
  let db: StorageAdapter;
  let cfg: SwarmConfig;
  const coordinator = () => callerOf(cfg, {});

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-swarm-rt-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), BASIC);
    resetContextCache();
    resetSwarmConfigCache();
    db = getStorage(getContext(root), { vectors: false });
    cfg = activeSwarmConfig(root)!;
  });
  afterAll(() => closeAllStorage());

  it("loads the project file and honours enabled: false", () => {
    expect(loadSwarmConfig(root).state).toBe("ok");
    const off = mkdtempSync(join(tmpdir(), "em-swarm-off-"));
    expect(loadSwarmConfig(off).state).toBe("absent");
    mkdirSync(join(off, ".eminiar"));
    writeFileSync(join(off, ".eminiar", "swarm.yml"), `enabled: false\n${BASIC}`);
    expect(loadSwarmConfig(off).state).toBe("ok");
    expect(activeSwarmConfig(off)).toBeUndefined();
  });

  it("plans with keys and deps, and enforces hierarchical roles", () => {
    const run = startRun(db, cfg, { swarm: "feat", goal: "add a widget", sessionId: "S" });
    const swarm = cfg.swarms[0]!;
    const [a, b] = addTasks(db, { root }, run, swarm, coordinator(), [
      { key: "impl", title: "implement", role: "coder", files: [join(root, "src/w.ts")] },
      { title: "test it", role: "tester", deps: ["impl"] },
    ]);
    expect(a!.files).toEqual(["src/w.ts"]);
    expect(b!.deps).toEqual([a!.id]);
    expect(() =>
      addTasks(db, { root }, run, swarm, coordinator(), [{ title: "x", role: "nope" }]),
    ).toThrow(SwarmError);
    expect(() =>
      addTasks(db, { root }, run, swarm, coordinator(), [{ title: "x", deps: ["later"] }]),
    ).toThrow(/neither/);

    const tester = callerOf(cfg, { agentId: "agent-t1", agentType: "swarm-feat-tester" });
    const coder = callerOf(cfg, { agentId: "agent-c1", agentType: "swarm-feat-coder" });
    // tester's task waits on the coder's
    expect(claimTask(db, run, swarm, tester).reason).toMatch(/waits on/);
    expect(() => claimTask(db, run, swarm, coder, b!.id)).toThrow(/waits on|tester role/);
    const got = claimTask(db, run, swarm, coder);
    expect(got.task?.id).toBe(a!.id);
    expect(claimTask(db, run, swarm, coder).already).toBe(true);
    // someone else cannot close it
    expect(() => updateTask(db, run, tester, { task: a!.id, status: "done" })).toThrow(
      /held by another/,
    );
    updateTask(db, run, coder, { task: a!.id, status: "done", result: "added src/w.ts" });
    expect(claimTask(db, run, swarm, tester).task?.id).toBe(b!.id);
    // coordinator can reopen; reopening releases the holder
    const reopened = updateTask(db, run, coordinator(), { task: b!.id, status: "pending" });
    expect(reopened.agent_id).toBeNull();
    expect(() => updateTask(db, run, coder, { task: b!.id, status: "active" })).toThrow(
      /status must be/,
    );
    finishRun(getContext(root), db, run, coordinator(), { status: "cancelled" });
  });

  it("gates pipeline stages and lets mesh peers take any task", () => {
    const line = cfg.swarms.find((s) => s.name === "line")!;
    const run = startRun(db, cfg, { swarm: "line", goal: "pipeline goal" });
    const [p, b] = addTasks(db, { root }, run, line, coordinator(), [
      { title: "plan", role: "plan" },
      { title: "build", role: "build" },
    ]);
    const builder = callerOf(cfg, { agentId: "agent-b", agentType: "swarm-line-build" });
    expect(claimTask(db, run, line, builder).reason).toMatch(/earlier stages/);
    const planner = callerOf(cfg, { agentId: "agent-p", agentType: "swarm-line-plan" });
    claimTask(db, run, line, planner);
    updateTask(db, run, planner, { task: p!.id, status: "done" });
    expect(claimTask(db, run, line, builder).task?.id).toBe(b!.id);

    const peers = cfg.swarms.find((s) => s.name === "peers")!;
    const mrun = startRun(db, cfg, { swarm: "peers", goal: "mesh goal" });
    const [t] = addTasks(db, { root }, mrun, peers, coordinator(), [{ title: "for a", role: "a" }]);
    const peerB = callerOf(cfg, { agentId: "agent-pb", agentType: "swarm-peers-b" });
    expect(claimTask(db, mrun, peers, peerB).task?.id).toBe(t!.id);
  });

  it("enforces max_agents and role count with spawn reservations", () => {
    const run = startRun(db, cfg, { swarm: "feat", goal: "capacity", sessionId: "CAP" });
    const spawn = (type: string, prompt = "go") =>
      reserveSpawn(db, cfg, { agentType: type, prompt, sessionId: "CAP" });
    expect(reserveSpawn(db, cfg, { agentType: "general-purpose" })).toBeUndefined();
    expect(spawn("swarm-feat-coder")?.decision).toBe("allow");
    expect(spawn("swarm-feat-coder")?.decision).toBe("allow");
    const third = spawn("swarm-feat-coder");
    expect(third?.decision).toBe("deny");
    if (third?.decision === "deny") expect(third.reason).toMatch(/count is 2/);
    expect(spawn("swarm-feat-tester")?.decision).toBe("allow");
    const over = spawn("swarm-feat-tester");
    expect(over?.decision).toBe("deny");
    if (over?.decision === "deny") expect(over.reason).toMatch(/max_agents is 3/);
    // reservations are consumed by SubagentStart; the workers then count as running
    registerWorker(db, cfg, {
      agentId: "agent-x1",
      agentType: "swarm-feat-coder",
      sessionId: "CAP",
    });
    expect(runSnapshot(db, run).counts.workers.running).toBe(1);
    // a stale worker stops counting
    db.swarm.workerUpdate(run.id, "agent-x1", {});
    (db as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
      .prepare("UPDATE swarm_agents SET last_ts = ? WHERE agent_id = ?")
      .run(Date.now() - STALE_MS - 1000, "agent-x1");
    expect(runSnapshot(db, run).workers[0]!.status).toBe("stale");
    finishRun(getContext(root), db, run, coordinator(), { status: "cancelled" });
  });

  it("registers a worker, which claims its task, records activity and auto-closes on stop", async () => {
    const swarm = cfg.swarms[0]!;
    const run = startRun(db, cfg, { swarm: "feat", goal: "lifecycle", sessionId: "LC" });
    const [t1, t2] = addTasks(db, { root }, run, swarm, coordinator(), [
      { title: "first", role: "coder", files: ["src/a.ts"] },
      { title: "second", role: "coder" },
    ]);
    expect(taskRef(`Please do task #${t1!.id} now`)).toBe(t1!.id);
    expect(taskRef("task 5")).toBeUndefined();
    const allow = reserveSpawn(db, cfg, {
      agentType: "swarm-feat-coder",
      prompt: `Work on task #${t1!.id}`,
      sessionId: "LC",
    });
    expect(allow?.decision === "allow" && allow.taskId).toBe(t1!.id);
    const started = registerWorker(db, cfg, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      sessionId: "LC",
    });
    expect(started?.run.id).toBe(run.id);
    // no hand-over at start: the worker claims the task its prompt names
    expect(started?.task).toBeUndefined();
    const brief = await workerBrief(getContext(root), db, started!);
    expect(brief).toMatch(/you are the "coder" worker/i);
    expect(brief).toContain('claim it first with em_swarm {action:"claim", task:N}');
    expect(brief).toContain(`#${t1!.id} first`);
    claimTask(
      db,
      run,
      swarm,
      callerOf(cfg, { agentId: "agent-w1", agentType: "swarm-feat-coder" }),
      t1!.id,
    );
    expect(db.swarm.taskGet(t1!.id)!.agent_id).toBe("agent-w1");
    expect(brief.length).toBeLessThanOrEqual(4000);

    recordActivity(db, cfg, root, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      tool: "Edit",
      input: { file_path: join(root, "src/a.ts") },
    });
    recordActivity(db, cfg, root, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      tool: "Bash",
      input: { command: "npm test" },
      failed: true,
      error: "exit 1",
    });
    const snap = runSnapshot(db, run);
    const w = snap.workers.find((x) => x.agent_id === "agent-w1")!;
    expect(w.tool_calls).toBe(2);
    expect(w.errors).toBe(1);
    expect(snap.events.some((e) => e.kind === "tool" && e.text === "Edit src/a.ts")).toBe(true);
    expect(snap.events.some((e) => e.kind === "tool_error" && e.payload?.io === "exec")).toBe(true);

    const closed = closeWorker(db, cfg, {
      agentId: "agent-w1",
      agentType: "swarm-feat-coder",
      message: "Done: edited src/a.ts",
    });
    expect(closed?.closed[0]?.status).toBe("done");
    expect(db.swarm.taskGet(t1!.id)!.auto_closed).toBe(true);
    expect(db.swarm.workerGet(run.id, "agent-w1")!.status).toBe("done");

    // a worker that stops silently releases its task
    const second = callerOf(cfg, { agentId: "agent-w2", agentType: "swarm-feat-coder" });
    registerWorker(db, cfg, {
      agentId: "agent-w2",
      agentType: "swarm-feat-coder",
      sessionId: "LC",
    });
    claimTask(db, run, swarm, second, t2!.id);
    closeWorker(db, cfg, { agentId: "agent-w2", agentType: "swarm-feat-coder", message: "" });
    expect(db.swarm.taskGet(t2!.id)).toMatchObject({ status: "pending", agent_id: null });

    // blackboard and briefs
    postNote(db, run, second, "design", "use a map");
    expect(postNote(db, run, coordinator(), "design", "use a set").version).toBe(2);
    expect(() => postNote(db, run, coordinator(), "bad key!", "x")).toThrow(/key must be/);
    const cb = await coordinatorBrief(getContext(root), db, cfg, swarm, run);
    expect(cb).toContain('subagent_type "swarm-feat-coder"');
    const tb = await taskBrief(db, run, swarm.roles[0], db.swarm.taskGet(t2!.id)!);
    expect(tb).toContain("second");

    // only the coordinator finishes; remember writes a memory
    expect(() => finishRun(getContext(root), db, run, second, { status: "done" })).toThrow(
      /coordinator/,
    );
    const fin = finishRun(getContext(root), db, run, coordinator(), {
      status: "done",
      summary: "all good",
      remember: true,
    });
    expect(fin.memory).toMatch(/^swarm\/run-\d{4}-\d{2}-\d{2}-lifecycle/);
    expect(db.memoryGetByName(fin.memory!)?.content).toContain("Outcome: all good");
    expect(() => addTasks(db, { root }, run, swarm, coordinator(), [{ title: "late" }])).toThrow(
      /is done/,
    );
  });

  it("opens an ad-hoc run for a worker spawned outside a run", () => {
    for (const r of db.swarm.runs({ swarm: "peers", status: "active" }))
      finishRun(getContext(root), db, r, coordinator(), { status: "cancelled" });
    const fresh = registerWorker(db, cfg, {
      agentId: "agent-adhoc",
      agentType: "swarm-peers-a",
      sessionId: "NEW",
    });
    expect(fresh?.run.goal).toMatch(/^\(ad hoc\)/);
    expect(registerWorker(db, cfg, { agentId: "agent-z", agentType: "Explore" })).toBeUndefined();
  });

  it("gives a claim the whole task detail and points the start brief at it", async () => {
    const swarm = cfg.swarms[0]!;
    const role = swarm.roles[0]!;
    const run = startRun(db, cfg, { swarm: "feat", goal: "long detail", sessionId: "LD" });
    // A detail at the plan limit (DETAIL_MAX 4000) whose last instruction must survive.
    const tail = "LAST-INSTRUCTION: run the tests.";
    const detail = `${"spec line. ".repeat(400).slice(0, 4000 - tail.length - 1)} ${tail}`;
    expect(detail.length).toBe(4000);
    const [long, short] = addTasks(db, { root }, run, swarm, coordinator(), [
      { title: "long", role: "coder", detail, files: ["src/a.ts"] },
      { title: "short", role: "coder", detail: "Do the small thing." },
    ]);
    const longTask = db.swarm.taskGet(long!.id)!;

    for (const maxChars of [500, 4000, 9000]) {
      const tb = await taskBrief(
        db,
        run,
        { ...role, context: { ...role.context, maxChars } },
        longTask,
      );
      expect(tb).toContain(detail);
      expect(tb).toContain("Files: src/a.ts");
      // The claim reply wraps the brief in a header and caps it at OUTPUT_MAX: nothing is cut.
      const header = `Claimed task #${longTask.id} (run ${run.id}). Report it with em_swarm {action:"update", task:${longTask.id}, status:"done"|"failed"|"blocked", result}.`;
      const reply = [header, tb].join("\n\n");
      expect(reply.length).toBeLessThanOrEqual(OUTPUT_MAX);
      expect(capOutput(reply)).toBe(reply);
    }

    // The start brief keeps the detail short but says where the rest is, ahead of the cut.
    const wb = await workerBrief(getContext(root), db, { run, swarm, role, task: longTask });
    expect(wb).not.toContain(tail);
    expect(wb).toContain(`em_swarm {action:"claim", task:${longTask.id}} returns it in full`);
    const small = await workerBrief(getContext(root), db, {
      run,
      swarm,
      role: { ...role, context: { ...role.context, maxChars: 500 } },
      task: longTask,
    });
    expect(small).toContain("returns it in full");

    // A short detail goes out as is, with no pointer.
    const sb = await workerBrief(getContext(root), db, {
      run,
      swarm,
      role,
      task: db.swarm.taskGet(short!.id)!,
    });
    expect(sb).toContain("Do the small thing.");
    expect(sb).not.toContain("returns it in full");
    finishRun(getContext(root), db, run, coordinator(), { status: "cancelled" });
  });

  it("describes tool calls compactly", () => {
    expect(toolHead(root, "Read", { file_path: join(root, "src/x.ts") })).toBe("Read src/x.ts");
    expect(toolHead(root, "mcp__plugin_eminiar_eminiar__em_search", { queries: ["a"] })).toBe(
      "em_search",
    );
    expect(toolHead(root, "Bash", { command: "npm test\necho hi" })).toBe("Bash npm test");
  });
});

describe("swarm enforcement config", () => {
  const saved = {
    EMINIAR_PROJECT_ROOT: process.env.EMINIAR_PROJECT_ROOT,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  };
  beforeEach(() => {
    delete process.env.EMINIAR_PROJECT_ROOT;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const BODY = `swarms:
  s:
    description: d
    agents:
      a: { description: x }
`;
  const issuesOf = (yaml: string) => {
    const r = parse(yaml);
    return r.state === "invalid" ? r.issues : [];
  };

  it("defaults enforce to false and parses enforce and allowed_agents", () => {
    const off = ok(BODY);
    expect(off.enforce).toBe(false);
    expect(off.allowedAgents).toEqual([]);
    const on = ok(
      `enforce: true\nallowed_agents: [statusline-setup, my-plugin:reviewer, statusline-setup]\n${BODY}`,
    );
    expect(on.enforce).toBe(true);
    expect(on.allowedAgents).toEqual(["statusline-setup", "my-plugin:reviewer"]);
  });

  it("accepts allowed_agents without enforce, and enforce with enabled: false", () => {
    const c = ok(`allowed_agents: [Explore]\n${BODY}`);
    expect(c.enforce).toBe(false);
    expect(ok(`enabled: false\nenforce: true\n${BODY}`).enabled).toBe(false);
  });

  it("rejects a swarm- entry in allowed_agents and the typo `enforced:`", () => {
    const sw = issuesOf(`enforce: true\nallowed_agents: [swarm-s-a]\n${BODY}`);
    expect(
      sw.some(
        (i) => i.path.startsWith("allowed_agents") && /swarm workers need no entry/.test(i.message),
      ),
    ).toBe(true);
    const typo = issuesOf(`enforced: true\n${BODY}`);
    expect(typo.some((i) => /unknown key "enforced"/.test(i.message))).toBe(true);
    expect(parse(`enforce: yes-please\n${BODY}`).state).toBe("invalid");
    expect(parse(`allowed_agents: "Explore"\n${BODY}`).state).toBe("invalid");
  });

  it("keeps the enforce intent of an invalid file, including a YAML syntax error", () => {
    const bad = parse(`enforce: true\nswarms: {}\nmax_agent: 3\n${BODY}`);
    expect(bad.state === "invalid" && bad.enforce).toBe(true);
    const syntax = parse("enforce: true\nswarms: [oops\n");
    expect(syntax.state === "invalid" && syntax.enforce).toBe(true);
    const commented = parse("enforce: true   # on\nswarms: [oops\n");
    expect(commented.state === "invalid" && commented.enforce).toBe(true);
    const notMap = parse("- enforce\n");
    expect(notMap.state === "invalid" && notMap.enforce).toBe(false);
  });

  it("gives an invalid file no enforce when enabled: false or enforce is not true", () => {
    const disabled = parse("enabled: false\nenforce: true\nswarms: [oops\n");
    expect(disabled.state === "invalid" && disabled.enforce).toBe(false);
    const disabledMapping = parse(`enabled: false\nenforce: true\nmax_agent: 1\n${BODY}`);
    expect(disabledMapping.state === "invalid" && disabledMapping.enforce).toBe(false);
    const off = parse("enforce: false\nswarms: [oops\n");
    expect(off.state === "invalid" && off.enforce).toBe(false);
    const quoted = parse('enforce: "true"\nswarms: [oops\n');
    expect(quoted.state === "invalid" && quoted.enforce).toBe(false);
  });

  it("does not change the hash", () => {
    const base = ok(BODY);
    expect(ok(`enforce: true\nallowed_agents: [Explore]\n${BODY}`).hash).toBe(base.hash);
  });

  it("keeps STARTER_YAML valid and enforce off, and the commented keys switch on cleanly", () => {
    expect(ok(STARTER_YAML).enforce).toBe(false);
    expect(STARTER_YAML).toContain("# enforce: true");
    const on = STARTER_YAML.replace("# enforce: true", "enforce: true").replace(
      "# allowed_agents: []",
      "allowed_agents: [statusline-setup]",
    );
    const c = ok(on);
    expect(c.enforce).toBe(true);
    expect(c.allowedAgents).toEqual(["statusline-setup"]);
  });

  it("shows enforce in the list header, the enforceNote and `swarm validate`", async () => {
    const { enforceNote, formatSwarmList } = await import("../../src/swarm/format.js");
    const { swarmCommand } = await import("../../src/swarm/cli.js");
    const on = ok(`enforce: true\nallowed_agents: [statusline-setup]\n${BODY}`);
    expect(enforceNote(on)).toBe(" · enforce on (also allowed: statusline-setup)");
    expect(enforceNote(ok(`enforce: true\n${BODY}`))).toBe(" · enforce on");
    expect(enforceNote(ok(BODY))).toBe("");
    expect(enforceNote({ ...on, enabled: false })).toBe("");
    expect(formatSwarmList(on, [], [])).toContain(
      "· enforce on (also allowed: statusline-setup) ·",
    );
    expect(formatSwarmList(ok(BODY), [], [])).not.toContain("enforce");

    const root = mkdtempSync(join(tmpdir(), "em-swc-cli-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"));
    const file = join(root, ".eminiar", "swarm.yaml");
    const run = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await swarmCommand(args, getContext(root), {
        out: (s) => out.push(s),
        err: (s) => err.push(s),
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    writeFileSync(file, `enforce: true\nallowed_agents: [statusline-setup]\n${BODY}`);
    resetSwarmConfigCache();
    const text = await run(["validate"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("enforce on (also allowed: statusline-setup)");
    const json = JSON.parse((await run(["validate", "--json"])).out);
    expect(json).toMatchObject({
      state: "ok",
      enforce: true,
      allowed_agents: ["statusline-setup"],
    });
    writeFileSync(file, `enforce: true\nswarms: [oops\n`);
    resetSwarmConfigCache();
    const bad = await run(["validate", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.out)).toMatchObject({ state: "invalid", enforce: true });
    writeFileSync(file, BODY);
    resetSwarmConfigCache();
    expect(JSON.parse((await run(["validate", "--json"])).out)).toMatchObject({
      enforce: false,
      allowed_agents: [],
    });
  });
});

describe("enforceIntent", () => {
  for (const c of ENFORCE_FORMS)
    it(`${c.name}`, () => {
      expect(enforceIntent(c.text)).toBe(c.intent);
    });

  it("on a syntax error still denies the spellings the parser would read as enforce: true", () => {
    for (const head of ["enforce: True", '"enforce": true', "enforce : TRUE # x"]) {
      const r = parseSwarmYaml(`version: 1\n${head}\nswarms: [oops\n`, "f", "r");
      expect(r.state).toBe("invalid");
      expect(r.state === "invalid" && r.enforce).toBe(true);
    }
  });

  it("agrees with the parsed value whenever the document parses", () => {
    for (const c of ENFORCE_FORMS) {
      const r = parseSwarmYaml(c.text, "f", "r");
      const parsed =
        r.state === "ok"
          ? r.config.enforce && r.config.enabled
          : r.state === "invalid" && r.enforce === true;
      expect(parsed, c.name).toBe(c.intent);
    }
  });
});

describe("swarm model_range display", () => {
  const RANGED = `
version: 1
swarms:
  feat:
    description: test swarm
    max_agents: 3
    agents:
      coder:
        description: writes code
        model: sonnet
        model_range: { floor: haiku, ceiling: opus }
        count: 2
      tester:
        description: tests code
        model: haiku
`;

  it("shows the range next to the model in the list, the coordinator brief and the JSON", async () => {
    const { formatSwarmList } = await import("../../src/swarm/format.js");
    const { swarmCommand } = await import("../../src/swarm/cli.js");
    const c = ok(RANGED);
    const list = formatSwarmList(c, [], []);
    expect(list).toContain("  coder → swarm-feat-coder · sonnet (haiku..opus) · ×2 · n/a");
    expect(list).toContain("  tester → swarm-feat-tester · haiku · ×1 · n/a");

    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    const root = mkdtempSync(join(tmpdir(), "em-swarm-range-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"));
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), RANGED);
    resetContextCache();
    resetSwarmConfigCache();
    try {
      const db = getStorage(getContext(root), { vectors: false });
      const cfg = activeSwarmConfig(root)!;
      const run = startRun(db, cfg, { swarm: "feat", goal: "range", sessionId: "R" });
      const cb = await coordinatorBrief(getContext(root), db, cfg, cfg.swarms[0]!, run);
      expect(cb).toContain(
        '- coder → subagent_type "swarm-feat-coder" (sonnet, range haiku..opus, up to 2 at once): writes code',
      );
      expect(cb).toContain(
        '- tester → subagent_type "swarm-feat-tester" (haiku, up to 1 at once): tests code',
      );

      const out: string[] = [];
      const code = await swarmCommand(["list", "--json"], getContext(root), {
        out: (s) => out.push(s),
        err: () => {},
      });
      expect(code).toBe(0);
      const roles = JSON.parse(out.join("\n")).swarms[0].roles;
      expect(roles).toMatchObject([
        { role: "coder", model: "sonnet", range: { floor: "haiku", ceiling: "opus" } },
        { role: "tester", model: "haiku", range: null },
      ]);
    } finally {
      closeAllStorage();
    }
  });

  it("tells the coordinator how to read a ranged role's line while the adjudicator is on (#108)", async () => {
    const SENTENCE =
      "Roles listed with a range run on their fallback model unless their line says `model X (range …)`: then pass model X.";
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    const root = mkdtempSync(join(tmpdir(), "em-swarm-range-brief-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"));
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), RANGED);
    resetContextCache();
    resetSwarmConfigCache();
    try {
      const ctx = getContext(root);
      const db = getStorage(ctx, { vectors: false });
      const cfg = activeSwarmConfig(root)!;
      const swarm = cfg.swarms[0]!;
      const run = startRun(db, cfg, { swarm: "feat", goal: "range brief", sessionId: "RB" });
      const on = {
        ...ctx,
        config: { ...ctx.config, adjudicator: { ...ctx.config.adjudicator, enabled: true } },
      };
      expect(await coordinatorBrief(on, db, cfg, swarm, run)).toContain(
        `Follow each line as written. ${SENTENCE}`,
      );
      // Adjudicator off, or no ranged role: the line (and the sentence) stay out.
      expect(await coordinatorBrief(ctx, db, cfg, swarm, run)).not.toContain(SENTENCE);
      const unranged = { ...swarm, roles: swarm.roles.map((r) => ({ ...r, range: undefined })) };
      const plain = await coordinatorBrief(on, db, cfg, unranged, run);
      expect(plain).toContain("Follow each line as written.");
      expect(plain).not.toContain(SENTENCE);
    } finally {
      closeAllStorage();
    }
  });
});

describe("hold scope and tightening (task #66)", () => {
  const setup = (older: string) => {
    const root = mkdtempSync(join(tmpdir(), "em-hold-"));
    syncAgents(root, ok(older));
    return root;
  };
  const AGENTS = (a: string, b: string) =>
    `swarms:\n  s:\n    description: d\n    agents:\n      a: { description: x${a} }\n      b: { description: y${b} }\n`;

  it("holds only the role whose own settings carry an ignored key", () => {
    const root = setup(AGENTS("", ""));
    const c = ok(AGENTS(", retries: 3, tools: [Read]", ", tools: [Read]"));
    const r = syncAgents(root, c, { dryRun: true });
    const a = r.actions.find((x) => x.agentType === "swarm-s-a")!;
    const b = r.actions.find((x) => x.agentType === "swarm-s-b")!;
    // a's update tightens (a first allowlist), so it applies even with the key
    expect(a.action).toBe("update");
    expect(b.action).toBe("update");
    // a widening update is held for a, not for b
    const root2 = setup(AGENTS(", tools: [Read]", ", tools: [Read]"));
    const c2 = ok(AGENTS(", retries: 3, tools: [Read, Bash]", ", tools: [Read, Bash]"));
    const r2 = syncAgents(root2, c2, { dryRun: true });
    expect(r2.actions.find((x) => x.agentType === "swarm-s-a")).toMatchObject({
      action: "conflict",
      held: true,
    });
    expect(r2.actions.find((x) => x.agentType === "swarm-s-b")!.action).toBe("update");
    expect(r2.actions.find((x) => x.agentType === "swarm-s-a")!.reason).toContain("retries");
  });

  it("never holds an update that only tightens: fewer tools, more disallowed tools, more hooks", () => {
    const root = setup(AGENTS(", tools: [Read, Bash], disallowed_tools: [Edit]", ""));
    const c = ok(AGENTS(", retries: 3, tools: [Read], disallowed_tools: [Edit, Write]", ""));
    expect(
      syncAgents(root, c, { dryRun: true }).actions.find((x) => x.agentType === "swarm-s-a")!
        .action,
    ).toBe("update");
    // dropping a restriction (disallowed_tools) is a widening: held
    const wide = ok(AGENTS(", retries: 3, tools: [Read]", ""));
    expect(
      syncAgents(root, wide, { dryRun: true }).actions.find((x) => x.agentType === "swarm-s-a"),
    ).toMatchObject({ action: "conflict", held: true });
  });

  it("deletes a removed role and cleans up under enabled: false despite ignored keys", () => {
    const root = setup(AGENTS("", ""));
    const off = ok(`${AGENTS("", ", retries: 3")}enabled: false\n`);
    const r = syncAgents(root, off, { dryRun: true });
    expect(r.actions.map((x) => x.action)).toEqual(["delete", "delete"]);
  });
});

describe("restriction-like unknown keys in a role are errors", () => {
  const role = (line: string) =>
    parseSwarmYaml(
      `swarms:\n  s:\n    description: d\n    agents:\n      a:\n        description: x\n        ${line}\n`,
      "/x/swarm.yaml",
      "swarm.yaml",
    );
  it("rejects scp and other short typos, and any key naming a restriction", () => {
    for (const k of [
      "scp: [src]",
      "scpe: [src]",
      "toolz: [Read]",
      "allowed_tools: [Read]",
      "deny_paths: [a]",
      "toolzz: 1",
      "permission_mode: plan",
      "hook: 1",
      "models: 1",
      "max_count: 1",
    ])
      expect(role(k).state, k).toBe("invalid");
  });
  it("still ignores a genuinely new unrelated key, with a note", () => {
    const r = role("retries: 3");
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.config.ignoredKeys).toHaveLength(1);
  });
  it("outside agents a new key is still ignored", () => {
    const r = parseSwarmYaml(
      "swarms:\n  s:\n    description: d\n    permission_mode: plan\n    agents:\n      a: { description: x }\n",
      "/x/swarm.yaml",
      "swarm.yaml",
    );
    expect(r.state).toBe("ok");
  });
});

describe("typo length boundary for a non-restriction key (task #66)", () => {
  const agent = (line: string) =>
    parseSwarmYaml(
      `swarms:\n  s:\n    description: d\n    agents:\n      a:\n        description: x\n        ${line}\n`,
      "/x/swarm.yaml",
      "swarm.yaml",
    );
  it("6 characters, two edits from color is a new key; 7 is a typo", () => {
    expect(agent("zolorz: 1").state).toBe("ok");
    expect(agent("colorzz: 1").state).toBe("invalid");
  });
  it("a key the schema knows at another level is misplaced, not new", () => {
    expect(agent("defaults: 1").state).toBe("invalid");
  });
});
