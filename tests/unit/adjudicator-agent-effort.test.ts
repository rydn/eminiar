/**
 * The agent file's frontmatter `effort` at dispatch (#170 G3): agent-pin reads it (AgentPin.effort),
 * onPreAgent stores it as scores.agentEffort and words the effort note by it. Advise mode never
 * injects effort (dispatchRule and the plan text are unchanged); apply mode sets the advised
 * effort itself and it wins over the agent file and the call (last describe).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentPin } from "../../src/adjudicator/agent-pin.js";
import { AGENT_EFFORT_FIELD, EFFORT_APPLIED_FIELD } from "../../src/adjudicator/effort.js";
import { onPreAgent } from "../../src/adjudicator/hooks.js";
import { EFFORTS } from "../../src/adjudicator/types.js";
import { getContext, resetContextCache } from "../../src/context.js";
import type { HookInput } from "../../src/hooks/types.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

let root: string;
let home: string;
let user: string;
let session = 0;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ROUTING_MODE",
  "EMINIAR_ADJUDICATOR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_DIRS",
];

for (const k of ENV_KEYS) saved[k] = process.env[k];
afterAll(() => {
  closeAllStorage();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  session++;
  closeAllStorage();
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "em-agent-effort-home-"));
  user = mkdtempSync(join(tmpdir(), "em-agent-effort-user-"));
  root = mkdtempSync(join(tmpdir(), "em-agent-effort-root-"));
  process.env.EMINIAR_HOME = home;
  process.env.HOME = user;
  writeFileSync(join(root, "package.json"), "{}");
  process.env.CLAUDE_PROJECT_DIR = root;
  resetContextCache();
});
afterEach(() => {
  closeAllStorage();
  resetContextCache();
  for (const d of [home, user, root]) rmSync(d, { recursive: true, force: true });
});

/** A project agent file with the given frontmatter lines (name is added). */
function agent(name: string, lines: string[] = [], dir = join(root, ".claude", "agents")): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, `---\nname: ${name}\n${lines.join("\n")}\n---\nbody\n`);
  return file;
}

const pinOf = (type: string) =>
  resolveAgentPin(type, { root, env: { HOME: user }, managedDir: null });

describe("agent-pin reads the frontmatter effort", () => {
  it("reads a known level: bare, quoted, with a comment, any case", () => {
    agent("a-bare", ["effort: high"]);
    agent("a-dq", ['effort: "medium"']);
    agent("a-sq", ["effort: 'xhigh'"]);
    agent("a-comment", ["effort: low # cheap"]);
    agent("a-case", ["effort: MAX"]);
    expect(pinOf("a-bare").effort).toBe("high");
    expect(pinOf("a-dq").effort).toBe("medium");
    expect(pinOf("a-sq").effort).toBe("xhigh");
    expect(pinOf("a-comment").effort).toBe("low");
    expect(pinOf("a-case").effort).toBe("max");
  });

  it("is set on every verdict: unpinned, pinned and unknown pins alike", () => {
    agent("a-unpinned", ["effort: low"]);
    agent("a-pinned", ["model: opus", "effort: high"]);
    expect(pinOf("a-unpinned")).toMatchObject({ status: "unpinned", effort: "low" });
    expect(pinOf("a-pinned")).toMatchObject({ status: "pinned", model: "opus", effort: "high" });
    // two definitions that disagree on the model: status unknown, but they agree on the effort
    agent("a-split", ["model: opus", "effort: medium"]);
    agent("a-split", ["model: haiku", "effort: medium"], join(root, ".claude", "agents", "sub"));
    expect(pinOf("a-split")).toMatchObject({ status: "unknown", effort: "medium" });
  });

  it("is omitted for auto, invalid, empty or missing values", () => {
    agent("a-auto", ["effort: auto"]);
    agent("a-bad", ["effort: turbo"]);
    agent("a-empty", ["effort:"]);
    agent("a-none", ["model: sonnet"]);
    for (const t of ["a-auto", "a-bad", "a-empty", "a-none"])
      expect(pinOf(t).effort, t).toBeUndefined();
    // the model verdict is untouched
    expect(pinOf("a-none")).toMatchObject({ status: "pinned", model: "sonnet" });
  });

  it("is omitted when two definitions at the winning location disagree, or only one sets it", () => {
    agent("a-dis", ["effort: low"]);
    agent("a-dis", ["effort: high"], join(root, ".claude", "agents", "sub"));
    expect(pinOf("a-dis").effort).toBeUndefined();
    agent("a-part", ["effort: low"]);
    agent("a-part", [], join(root, ".claude", "agents", "sub"));
    expect(pinOf("a-part").effort).toBeUndefined();
    // two definitions that agree keep it
    agent("a-same", ["effort: high"]);
    agent("a-same", ["effort: High"], join(root, ".claude", "agents", "sub"));
    expect(pinOf("a-same").effort).toBe("high");
  });

  it("reads a plugin agent's effort too", () => {
    const plugin = join(user, "plugins", "pl");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "pl" }));
    mkdirSync(join(plugin, "agents"), { recursive: true });
    writeFileSync(
      join(plugin, "agents", "helper.md"),
      "---\nname: helper\nmodel: sonnet\neffort: high\n---\nbody\n",
    );
    const sep = process.platform === "win32" ? ";" : ":";
    const p = resolveAgentPin("pl:helper", {
      root,
      env: { HOME: user, CLAUDE_CODE_PLUGIN_DIRS: [plugin].join(sep) },
      managedDir: null,
    });
    expect(p).toMatchObject({ status: "pinned", source: "plugin", effort: "high" });
  });

  it("built-ins, forks and unknown agents carry no effort", () => {
    expect(pinOf("general-purpose").effort).toBeUndefined();
    expect(pinOf("Explore").effort).toBeUndefined();
    expect(pinOf("fork").effort).toBeUndefined();
    expect(pinOf("ghost-plugin:helper").effort).toBeUndefined();
    expect(pinOf("nowhere").effort).toBeUndefined();
  });
});

/**
 * Dispatch a swarm worker whose plan row advises `advised`. A plan row makes the advice
 * deterministic (the dispatch row copies its verdict).
 */
async function dispatch(opts: {
  advised?: string;
  agentLines?: string[] | null;
  call?: Record<string, unknown>;
  saturated?: boolean;
  env?: NodeJS.ProcessEnv;
  agentType?: string;
  mode?: "advise" | "apply";
  /** apply scope; default "swarm" (the dispatched worker is in scope either way). */
  scope?: "swarm" | "all";
  blocked?: boolean;
}) {
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      adjudicator: {
        enabled: true,
        mode: opts.mode ?? "advise",
        apply: { scope: opts.scope ?? "swarm", minConfidence: 0.5 },
      },
    }),
  );
  resetContextCache();
  const ctx = getContext(root);
  const db = getStorage(ctx, { vectors: false });
  const type = opts.agentType ?? "swarm-feature-coder";
  if (opts.agentLines !== null) agent(type, ["description: coder", ...(opts.agentLines ?? [])]);
  const sid = `AE${session}`;
  const run = db.swarm.runCreate({
    id: `run-${sid}-${Math.random()}`,
    swarm: "feature",
    goal: "g",
    topology: "hierarchical",
  });
  const task = db.swarm.taskAdd({
    run_id: run.id,
    title: "Rename a variable",
    detail: "one file",
    role: "coder",
  });
  db.adjudicator.insert({
    surface: "plan",
    inputHash: "h",
    runId: run.id,
    taskId: task.id,
    tier: "sonnet",
    confidence: 0.9,
    complexity: 2,
    effort: (opts.advised ?? "medium") as never,
    role: "coder",
    scores: JSON.stringify({
      units: {
        scored: 1,
        dropped: 0,
        skipped: 0,
        winner: 2,
        sum: 2,
        saturated: !!opts.saturated,
        roleConfidence: 0.9,
      },
    }),
  });
  const input: HookInput = {
    session_id: sid,
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: type, prompt: "task #x", ...(opts.call ?? {}) },
  };
  const advice = await onPreAgent(
    ctx,
    input,
    { kind: "worker", agentType: type, runId: run.id, taskId: task.id },
    opts.env ? { env: opts.env } : {},
    opts.blocked,
  );
  const row = db.adjudicator.get(advice!.rowId!)!;
  return { advice: advice!, scores: JSON.parse(row.scores ?? "{}") as Record<string, unknown> };
}

describe("onPreAgent: the agent file's effort in the note and the row", () => {
  it("agent file equals the advice: says the file already sets it, nothing to pass", async () => {
    const { advice, scores } = await dispatch({ advised: "high", agentLines: ["effort: high"] });
    expect(advice.note).toContain("effort high: the agent file already sets it");
    expect(advice.note).not.toMatch(/pass effort/);
    expect(scores[AGENT_EFFORT_FIELD]).toBe("high");
  });

  it("agent file differs: still says to pass the advice, over the file's level", async () => {
    const { advice, scores } = await dispatch({ advised: "low", agentLines: ["effort: high"] });
    expect(advice.note).toMatch(
      /pass effort:'low' \(Claude Code 2\.1\.292\+\) over the agent file's high/,
    );
    expect(scores[AGENT_EFFORT_FIELD]).toBe("high");
  });

  it("agent file sets no effort: the wording and the row are as before", async () => {
    const { advice, scores } = await dispatch({ advised: "low", agentLines: [] });
    expect(advice.note).toMatch(/pass effort:'low' \(Claude Code 2\.1\.292\+\), role coder/);
    expect(advice.note).not.toMatch(/agent file/);
    expect(scores[AGENT_EFFORT_FIELD]).toBeUndefined();
    // an unusable level counts as none
    const auto = await dispatch({ advised: "low", agentLines: ["effort: auto"] });
    expect(auto.advice.note).not.toMatch(/agent file/);
    expect(auto.scores[AGENT_EFFORT_FIELD]).toBeUndefined();
  });

  it("a saturated brief stays informational and names the file's level", async () => {
    const { advice, scores } = await dispatch({
      advised: "max",
      agentLines: ["effort: medium"],
      saturated: true,
    });
    expect(advice.note).toContain(
      "effort max: informational (brief saturated); the agent file runs medium",
    );
    expect(scores[AGENT_EFFORT_FIELD]).toBe("medium");
    const plain = await dispatch({ advised: "max", agentLines: [], saturated: true });
    expect(plain.advice.note).toContain("effort max: informational (brief saturated)");
    expect(plain.advice.note).not.toMatch(/agent file/);
  });

  it("an effort on the call keeps the old wording, and the row records both", async () => {
    const { advice, scores } = await dispatch({
      advised: "low",
      agentLines: ["effort: high"],
      call: { effort: "medium" },
    });
    expect(advice.note).toMatch(/suggested effort low/);
    expect(advice.note).not.toMatch(/pass effort|agent file/);
    expect(scores.passedEffort).toBe("medium");
    expect(scores[AGENT_EFFORT_FIELD]).toBe("high");
  });

  it("CLAUDE_CODE_EFFORT_LEVEL keeps the old wording", async () => {
    const { advice, scores } = await dispatch({
      advised: "low",
      agentLines: ["effort: high"],
      env: { CLAUDE_CODE_EFFORT_LEVEL: "max" },
    });
    expect(advice.note).toMatch(/suggested effort low/);
    expect(advice.note).not.toMatch(/pass effort|agent file/);
    expect(scores.effortEnv).toBe("max");
    expect(scores[AGENT_EFFORT_FIELD]).toBe("high");
  });

  it("a fork has no agent file: no agentEffort even when a file is named fork", async () => {
    const { advice, scores } = await dispatch({
      advised: "low",
      agentType: "fork",
      agentLines: ["effort: high"],
    });
    expect(advice.note).toMatch(/^adjudicator: fork runs on the main session's model/);
    expect(scores[AGENT_EFFORT_FIELD]).toBeUndefined();
  });

  it("advise mode never injects effort: the advice carries no effort field", async () => {
    const { advice } = await dispatch({ advised: "low", agentLines: ["effort: high"] });
    expect(Object.keys(advice).sort()).not.toContain("effort");
  });
});

describe("onPreAgent in apply mode: the hook sets the advised effort", () => {
  const apply = (o: Parameters<typeof dispatch>[0]) => dispatch({ ...o, mode: "apply" });

  it("sets the advised effort and records it; the note says applied", async () => {
    const { advice, scores } = await apply({ advised: "high", agentLines: [] });
    expect(advice.effort).toBe("high");
    expect(advice.note).toMatch(/effort high applied, role coder/);
    expect(advice.note).not.toMatch(/pass effort|suggested effort/);
    expect(scores[EFFORT_APPLIED_FIELD]).toBe("high");
  });

  it("every level of EFFORTS is passed through unchanged", async () => {
    for (const level of EFFORTS) {
      const { advice, scores } = await apply({ advised: level, agentLines: [] });
      expect(advice.effort, level).toBe(level);
      expect(scores[EFFORT_APPLIED_FIELD], level).toBe(level);
    }
  });

  it("overrides the agent file's own effort, and records both", async () => {
    const same = await apply({ advised: "high", agentLines: ["effort: high"] });
    expect(same.advice.effort).toBe("high");
    const diff = await apply({ advised: "low", agentLines: ["effort: high"] });
    expect(diff.advice.effort).toBe("low");
    expect(diff.advice.note).toMatch(/effort low applied/);
    expect(diff.scores[AGENT_EFFORT_FIELD]).toBe("high");
    expect(diff.scores[EFFORT_APPLIED_FIELD]).toBe("low");
  });

  it("overrides an effort the call passed, and records both", async () => {
    const { advice, scores } = await apply({
      advised: "low",
      agentLines: [],
      call: { effort: "max" },
    });
    expect(advice.effort).toBe("low");
    expect(advice.note).toMatch(/effort low applied/);
    expect(scores.passedEffort).toBe("max");
    expect(scores[EFFORT_APPLIED_FIELD]).toBe("low");
  });

  it("sets it when the model is not applied: an explicit model, a respected pin, FORCE", async () => {
    const own = await apply({ advised: "low", agentLines: [], call: { model: "opus" } });
    expect(own.advice.model).toBeUndefined();
    expect(own.advice.effort).toBe("low");
    // (a fresh agent name: two files of one name that disagree on the model are an unknown pin)
    const pinned = await apply({
      advised: "low",
      agentType: "swarm-feature-pinned",
      agentLines: ["model: opus"],
    });
    expect(pinned.advice.model).toBeUndefined();
    expect(pinned.advice.action).toBe("respected");
    expect(pinned.advice.effort).toBe("low");
    expect(pinned.scores[EFFORT_APPLIED_FIELD]).toBe("low");
    const forced = await apply({
      advised: "low",
      agentLines: [],
      env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" },
    });
    expect(forced.advice.model).toBeUndefined();
    expect(forced.advice.effort).toBe("low");
  });

  it("a saturated brief still gets the effort (apply mode sets it unconditionally)", async () => {
    const { advice } = await apply({ advised: "max", agentLines: [], saturated: true });
    expect(advice.effort).toBe("max");
    expect(advice.note).toMatch(/effort max applied/);
  });

  it("CLAUDE_CODE_EFFORT_LEVEL outranks it: nothing is sent, the note says why", async () => {
    for (const level of ["max", "auto"]) {
      const { advice, scores } = await apply({
        advised: "low",
        agentLines: ["effort: high"],
        env: { CLAUDE_CODE_EFFORT_LEVEL: level },
      });
      expect(advice.effort, level).toBeUndefined();
      expect(advice.note, level).toContain(
        "effort low not applied: CLAUDE_CODE_EFFORT_LEVEL is set and outranks it",
      );
      expect(scores[EFFORT_APPLIED_FIELD], level).toBeUndefined();
      expect(scores.effortEnv, level).toBe(level === "auto" ? "other" : level);
    }
    // the model is still applied under the env var
    const m = await apply({
      advised: "low",
      agentLines: [],
      env: { CLAUDE_CODE_EFFORT_LEVEL: "max" },
    });
    expect(m.advice.model).toBeDefined();
  });

  it("never sends a level outside EFFORTS", async () => {
    for (const bad of ["auto", "turbo", "", "none"]) {
      const { advice, scores } = await apply({ advised: bad, agentLines: [] });
      expect(advice.effort, JSON.stringify(bad)).toBeUndefined();
      expect(scores[EFFORT_APPLIED_FIELD], JSON.stringify(bad)).toBeUndefined();
      expect(advice.note, JSON.stringify(bad)).not.toMatch(/applied, role|effort \w+ applied/);
    }
  });

  it("a fork gets no effort and the note says a fork takes none", async () => {
    const { advice, scores } = await apply({ advised: "low", agentType: "fork", agentLines: [] });
    expect(advice.effort).toBeUndefined();
    expect(advice.note).toMatch(/^adjudicator: fork runs on the main session's model/);
    expect(advice.note).toMatch(/effort not applied \(a fork takes none/);
    expect(scores[EFFORT_APPLIED_FIELD]).toBeUndefined();
  });

  it("a blocked (denied or asked) call gets no effort and no applied record", async () => {
    const { advice, scores } = await apply({ advised: "low", agentLines: [], blocked: true });
    expect(advice.effort).toBeUndefined();
    expect(advice.note).not.toMatch(/effort low applied/);
    expect(scores[EFFORT_APPLIED_FIELD]).toBeUndefined();
  });

  it("advise mode sends none and records none, whatever the call or the file says", async () => {
    for (const o of [
      { agentLines: [] },
      { agentLines: ["effort: high"] },
      { agentLines: [], call: { effort: "medium" } },
    ]) {
      const { advice, scores } = await dispatch({ advised: "low", mode: "advise", ...o });
      expect(advice.effort).toBeUndefined();
      expect(advice.note).not.toMatch(/effort low applied/);
      expect(scores[EFFORT_APPLIED_FIELD]).toBeUndefined();
    }
  });
});
