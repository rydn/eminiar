import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #66: lets a test make adjudicatePlan throw; `internal` makes the real one fail inside (a task
 * without `files`), so its own catch logs and calls onError. Every other call is untouched.
 */
const planFault = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  internal: false,
}));
vi.mock("../../src/adjudicator/swarm.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/adjudicator/swarm.js")>();
  return {
    ...real,
    adjudicatePlan: async (...args: Parameters<typeof real.adjudicatePlan>) => {
      if (planFault.error) throw planFault.error;
      if (planFault.internal) {
        const [c, d, r, sw, tasks, o] = args;
        const broken = tasks.map((t) => ({ ...t, files: undefined }) as unknown as TaskRow);
        return real.adjudicatePlan(c, d, r, sw, broken, o);
      }
      return real.adjudicatePlan(...args);
    },
  };
});

import { envFlagOn, subagentModelForced } from "../../src/adjudicator/env.js";
import { effortFor, MAX_EFFORT_AT } from "../../src/adjudicator/heuristic.js";
import {
  hasProvider,
  registerProvider,
  resetProviders,
} from "../../src/adjudicator/providers/index.js";
import {
  adjudicatePlan,
  dispatchRule,
  effortForced,
  keptModelOf,
  modelForced,
  type PlanAdvice,
  planAdviceBlock,
  planAdviceEnabled,
  planAdviceHead,
  planLines,
  planNextHint,
  planPassing,
  ROLE_NOTE_MIN,
  taskRequest,
} from "../../src/adjudicator/swarm.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  AGENT_EFFORT_SINCE,
  EFFORTS,
  TIERS,
} from "../../src/adjudicator/types.js";
import { type Config, ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";
import { type CallerStamp, resetSwarmSecret, signCaller } from "../../src/swarm/identity.js";
import type { SwarmSpec, TaskRow } from "../../src/swarm/types.js";
import {
  emAdjudicate,
  NOTE_MAX,
  registerServerProviders,
  runAdjudicate,
  type ServerProviderOptions,
  scoreLine,
  topReasons,
} from "../../src/tools/em_adjudicate.js";
import { emSwarm } from "../../src/tools/em_swarm.js";
import { tools } from "../../src/tools/index.js";
import { availableTools } from "../../src/tools/types.js";

const YAML = `
version: 1
swarms:
  feat:
    description: test swarm
    max_agents: 3
    agents:
      coder:
        description: writes and refactors code
        count: 2
      tester:
        description: writes and runs tests
`;
const SESSION = "sess-adj-swarm";

// The plan advice head reads CLAUDE_CODE_EFFORT_LEVEL from process.env: keep the caller's out.
const savedEffortLevel = process.env.CLAUDE_CODE_EFFORT_LEVEL;
beforeAll(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
});
afterAll(() => {
  if (savedEffortLevel !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = savedEffortLevel;
});

const configWith = (adjudicator: Record<string, unknown>): Config =>
  ConfigSchema.parse({ adjudicator });

/** A provider that answers every key with `tier` and counts its batched calls. */
function fakeProvider(tier = "opus", role?: string) {
  const calls: AdjudicationRequest[][] = [];
  const p: AdjudicatorProvider = {
    id: "embedding",
    remote: false,
    dims: role ? ["complexity", "tier", "role"] : ["complexity", "tier"],
    async adjudicate(reqs) {
      calls.push([...reqs]);
      return {
        answers: reqs.map((r) => ({
          key: r.key,
          complexity: { value: tier === "haiku" ? 0.5 : 3.6, confidence: 0.95 },
          tier: { probs: { [tier]: 1 }, confidence: 0.95, calibrated: true },
          ...(role ? { role: { probs: { [role]: 1 }, confidence: 0.95, calibrated: true } } : {}),
        })),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
        latencyMs: 3,
        model: "fake-embed",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 0, detail: "fake" };
    },
  };
  return { p, calls };
}

describe("ToolDef.available", () => {
  it("lists em_adjudicate only when the adjudicator is enabled", () => {
    const off = availableTools(tools, configWith({})).map((t) => t.name);
    const on = availableTools(tools, configWith({ enabled: true })).map((t) => t.name);
    expect(off).not.toContain("em_adjudicate");
    expect(on).toContain("em_adjudicate");
    // every other tool is listed either way
    expect(on.filter((n) => n !== "em_adjudicate")).toEqual(off);
    expect(off.length).toBe(tools.length - 1);
    expect(emAdjudicate.available?.(configWith({ enabled: true }))).toBe(true);
  });

  it("drops a tool whose check throws instead of failing the server", () => {
    const boom = [
      { available: () => true },
      {
        available: (): boolean => {
          throw new Error("x");
        },
      },
      {},
    ];
    expect(availableTools(boom, configWith({}))).toHaveLength(2);
  });
});

describe("plan advice helpers", () => {
  const swarm = {
    name: "feat",
    roles: [
      { role: "coder", agentType: "swarm-feat-coder", description: "writes code" },
      { role: "tester", agentType: "swarm-feat-tester", description: "tests code" },
    ],
  } as unknown as SwarmSpec;
  const task = (over: Partial<TaskRow> = {}): TaskRow => ({
    id: 5,
    run_id: "r1",
    title: "Add unit tests for the parser",
    detail: "cover the edge cases",
    role: "coder",
    status: "pending",
    agent_id: null,
    deps: [1, 2],
    files: ["src/a.ts"],
    result: null,
    auto_closed: false,
    created_by: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  });

  it("is enabled only with enabled + surfaces.plan", () => {
    expect(planAdviceEnabled(configWith({}))).toBe(false);
    expect(planAdviceEnabled(configWith({ enabled: true }))).toBe(true);
    expect(planAdviceEnabled(configWith({ enabled: true, surfaces: { plan: false } }))).toBe(false);
  });

  it("builds a plan request with the swarm's roles, files and deps as hints", () => {
    const r = taskRequest(task(), swarm);
    expect(r).toMatchObject({ key: "#5", surface: "plan" });
    expect(r.text).toBe("Add unit tests for the parser\ncover the edge cases");
    expect(r.hints).toMatchObject({ role: "coder", files: 1, deps: 2 });
    expect(r.hints?.roles?.map((x) => x.name)).toEqual(["coder", "tester"]);
  });

  it("prints one line per task, with a role-differs note from a confident role table", () => {
    const a: PlanAdvice[] = [
      {
        taskId: 5,
        role: "coder",
        suggestedRole: "tester",
        agentType: "swarm-feat-coder",
        model: "haiku",
        effort: "low",
        complexity: 1.2,
        confidence: 0.823,
        roleConfidence: 0.7,
      },
      {
        taskId: 6,
        role: "coder",
        suggestedRole: "coder",
        agentType: "swarm-feat-coder",
        model: "opus",
        effort: "high",
        complexity: 3.6,
        confidence: 0.7,
        roleConfidence: 0.95,
      },
      {
        taskId: 7,
        suggestedRole: "tester",
        agentType: "swarm-feat-tester",
        effort: "medium",
        complexity: 2,
        confidence: 0.5,
        roleConfidence: 0.9,
      },
    ];
    expect(planLines(a)).toEqual([
      "#5 → swarm-feat-coder · model haiku · effort low (complexity 1, conf 0.82); role suggested: tester (planned: coder)",
      "#6 → swarm-feat-coder · model opus · effort high (complexity 4, conf 0.70)",
      "#7 → swarm-feat-tester · effort medium (complexity 2, conf 0.50); role suggested: tester",
    ]);
    // Below ROLE_NOTE_MIN, or with no role confidence, no role note (S2: the planner knows more).
    expect(ROLE_NOTE_MIN).toBe(0.7);
    const quiet = [
      { ...a[0]!, roleConfidence: 0.69 },
      { ...a[2]!, roleConfidence: undefined },
    ];
    expect(planLines(quiet)).toEqual([
      "#5 → swarm-feat-coder · model haiku · effort low (complexity 1, conf 0.82)",
      "#7 → swarm-feat-tester · effort medium (complexity 2, conf 0.50)",
    ]);
    expect(planAdviceBlock([])).toBe("");
    expect(planAdviceBlock(a, {})).toMatch(/^Adjudicator suggestions: pass the model as `model`/);
    expect(planAdviceBlock(a, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" })).toMatch(
      /CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on/,
    );
    expect(modelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" })).toBe(false);
    expect(modelForced({})).toBe(false);
  });

  it("reads CLAUDE_CODE_SUBAGENT_MODEL_FORCE with Claude Code's on/off rule, like the hook (#43)", () => {
    const on = ["1", "true", "TRUE", "yes", "Yes", "on", "ON", " 1 "];
    const off = ["0", "false", "False", "no", "off", "OFF", "", " ", "2", "enabled"];
    for (const v of on) {
      expect(envFlagOn(v), v).toBe(true);
      expect(subagentModelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v }), v).toBe(true);
      expect(modelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v }), v).toBe(true);
    }
    for (const v of off) {
      expect(envFlagOn(v), v).toBe(false);
      expect(modelForced({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v }), v).toBe(false);
    }
    expect(envFlagOn(undefined)).toBe(false);
    const one: PlanAdvice[] = [
      { taskId: 1, agentType: "a", model: "haiku", effort: "low", complexity: 1, confidence: 0.9 },
    ];
    expect(planAdviceBlock(one, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "no" })).toMatch(
      /^Adjudicator suggestions: pass the model/,
    );
  });
});

describe("plan advice: model pins and the Agent call's effort (#68)", () => {
  const base: PlanAdvice = {
    taskId: 3,
    role: "coder",
    agentType: "swarm-feat-coder",
    model: "haiku",
    effort: "low",
    complexity: 1,
    confidence: 0.9,
  };

  it("names a respected pin and the pick instead of a model to pass", () => {
    expect(
      planLines([
        { ...base, pin: { status: "pinned", model: "opus", source: "project" } },
        {
          ...base,
          taskId: 4,
          pin: { status: "pinned", model: "claude-haiku-4-5", source: "project" },
        },
        { ...base, taskId: 5, pin: { status: "unknown" } },
        { ...base, taskId: 6, pin: { status: "pinned", model: "sonnet", source: "user" } },
        { ...base, taskId: 7 },
      ]),
    ).toEqual([
      "#3 → swarm-feat-coder · pinned opus (adjudicator would pick haiku; remove the pin in swarm.yaml to let it choose) · effort low (complexity 1, conf 0.90)",
      "#4 → swarm-feat-coder · pinned claude-haiku-4-5 (matches the adjudicator's pick) · effort low (complexity 1, conf 0.90)",
      "#5 → swarm-feat-coder · model pin is unknown (adjudicator would pick haiku; not overridden while the agent's definition cannot be read) · effort low (complexity 1, conf 0.90)",
      "#6 → swarm-feat-coder · pinned sonnet (adjudicator would pick haiku; remove the user agent's model pin to let it choose) · effort low (complexity 1, conf 0.90)",
      "#7 → swarm-feat-coder · model haiku · effort low (complexity 1, conf 0.90)",
    ]);
  });

  it("tells the coordinator to pass effort, unless CLAUDE_CODE_EFFORT_LEVEL outranks it", () => {
    expect(AGENT_EFFORT_SINCE).toBe("2.1.292");
    expect(planAdviceHead([base], {})).toBe(
      "Adjudicator suggestions: pass the model as `model` and the effort as `effort` on each Agent call (`effort` needs Claude Code 2.1.292 or later):",
    );
    expect(planAdviceHead([{ ...base, pin: { status: "pinned", model: "opus" } }], {})).toMatch(
      /; a pinned agent keeps its model: pass no `model`:$/,
    );
    expect(effortForced({ CLAUDE_CODE_EFFORT_LEVEL: "high" })).toBe(true);
    expect(effortForced({ CLAUDE_CODE_EFFORT_LEVEL: " " })).toBe(false);
    expect(planAdviceHead([base], { CLAUDE_CODE_EFFORT_LEVEL: "high" })).toBe(
      "Adjudicator suggestions: pass the model as `model` on each Agent call (effort is informational: CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`):",
    );
    const forced = planAdviceHead([base], { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    expect(forced).toMatch(/CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on/);
    expect(forced).toMatch(/pass the effort as `effort` \(Claude Code 2\.1\.292 or later\)/);
    expect(planAdviceBlock([base], {})).not.toMatch(/set only in the agent file/);
  });

  it("one rule table decides model and effort for every surface (#73-#76)", () => {
    // fork > FORCE > pin > pass; effort is informational with the env or an effort on the call
    expect(dispatchRule({ fork: true, forced: true, pin: true, effortSet: false })).toEqual({
      model: "fork",
      effort: "fork",
    });
    expect(dispatchRule({ forced: true, pin: true, effortSet: false })).toEqual({
      model: "forced",
      effort: "pass",
    });
    expect(dispatchRule({ forced: false, pin: true, effortSet: true })).toEqual({
      model: "pin",
      effort: "informational",
    });
    expect(dispatchRule({ forced: false, effortSet: false })).toEqual({
      model: "pass",
      effort: "pass",
    });
    expect(
      (["pass", "pin", "forced", "fork"] as const).map((model) =>
        keptModelOf({ model, effort: "pass" }),
      ),
    ).toEqual([undefined, "pin", "force", "fork"]);
  });

  it("apply mode: the rule table says the hook sets the effort (applied), unless the env outranks it", () => {
    expect(dispatchRule({ forced: false, effortApply: true, effortSet: false })).toEqual({
      model: "pass",
      effort: "applied",
    });
    // a pinned agent, FORCE and a ranged role change the model, not who sets the effort
    expect(
      dispatchRule({ forced: false, effortApply: true, effortSet: false, pin: true }).effort,
    ).toBe("applied");
    expect(dispatchRule({ forced: true, effortApply: true, effortSet: false })).toEqual({
      model: "forced",
      effort: "applied",
    });
    expect(
      dispatchRule({ forced: false, effortApply: true, effortSet: false, ranged: true }).effort,
    ).toBe("applied");
    // a saturated brief does not make it informational: the hook sets it anyway
    expect(
      dispatchRule({ forced: false, effortApply: true, effortSet: false, saturated: true }).effort,
    ).toBe("applied");
    // only CLAUDE_CODE_EFFORT_LEVEL outranks the hook (the caller passes just the env as effortSet)
    expect(dispatchRule({ forced: false, effortApply: true, effortSet: true }).effort).toBe(
      "informational",
    );
    // a fork takes no effort whatever the mode
    expect(
      dispatchRule({ forced: false, effortApply: true, fork: true, effortSet: false }),
    ).toEqual({
      model: "fork",
      effort: "fork",
    });
    // without effortApply nothing changes
    expect(dispatchRule({ forced: false, effortApply: false, effortSet: false }).effort).toBe(
      "pass",
    );
    expect(dispatchRule({ forced: false, effortSet: false, saturated: true }).effort).toBe(
      "informational",
    );
  });

  it("apply mode: plan lines say 'applied by the hook'; the head and Next say to pass no effort", () => {
    const applied: PlanAdvice = { ...base, effortApplied: true };
    expect(
      planLines([applied, { ...base, taskId: 4, saturated: true, effortApplied: true }]),
    ).toEqual([
      "#3 → swarm-feat-coder · model haiku · effort low (applied by the hook) (complexity 1, conf 0.90)",
      "#4 → swarm-feat-coder · model haiku · effort low (applied by the hook) (brief saturated; complexity 1, conf 0.90)",
    ]);
    expect(planAdviceHead([applied], {})).toBe(
      "Adjudicator suggestions: pass the model as `model` on each Agent call (the hook sets `effort` on the Agent call in apply mode, so pass no `effort`):",
    );
    expect(planNextHint([applied], {})).toBe(
      ", passing `model` as each suggestion below says; the hook sets `effort` (apply mode): pass no `effort`",
    );
    expect(planPassing([applied], {})).toMatchObject({ model: true, effort: false, applied: true });

    // every role pinned: no model to pass either, and still no effort
    const pinned: PlanAdvice = {
      ...applied,
      pin: { status: "pinned", model: "opus", source: "project" },
    };
    const head = planAdviceHead([pinned], {});
    expect(head).toContain("the hook sets `effort` on the Agent call in apply mode");
    expect(head).toMatch(/; a pinned agent keeps its model: pass no `model`:$/);
    expect(head).not.toMatch(/pass the model as `model`|as `effort`/);
    const next = planNextHint([pinned], {});
    expect(next).toContain("leave `model` unset for pinned agents");
    expect(next).toContain("the hook sets `effort` (apply mode): pass no `effort`");
    expect(next).not.toMatch(/passing `/);

    // FORCE: the model is informational, the hook still sets the effort
    const forced = planAdviceHead([{ ...applied, forced: true }], {
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
    expect(forced).toMatch(/the model is informational; the hook sets `effort`/);
    expect(forced).not.toMatch(/pass the effort as `effort`/);

    // a mixed plan (one task with the hook's effort, one without) still names effort for the rest
    expect(planPassing([applied, { ...base, taskId: 4 }], {})).toMatchObject({
      effort: true,
      applied: true,
    });
    expect(planNextHint([applied, { ...base, taskId: 4 }], {})).toBe(
      ", passing `model` and `effort` as each suggestion below says",
    );

    // advise mode (no effortApplied) is exactly as before
    expect(planLines([base])[0]).toBe(
      "#3 → swarm-feat-coder · model haiku · effort low (complexity 1, conf 0.90)",
    );
    expect(planAdviceHead([base], {})).toMatch(
      /pass the model as `model` and the effort as `effort`/,
    );
    expect(planPassing([base], {}).applied).toBe(false);
  });

  it("the Next hint and the head agree for pins, FORCE and the effort env (#73)", () => {
    const pinned: PlanAdvice = { ...base, pin: { status: "pinned", model: "opus" } };
    const cases: Array<{
      advice: PlanAdvice[];
      env: NodeJS.ProcessEnv;
      next: string;
      head: RegExp;
    }> = [
      {
        advice: [base],
        env: {},
        next: ", passing `model` and `effort` as each suggestion below says",
        head: /pass the model as `model` and the effort as `effort`/,
      },
      {
        advice: [pinned, { ...pinned, taskId: 4 }],
        env: {},
        next: ", passing `effort` as each suggestion below says; leave `model` unset for pinned agents",
        head: /^Adjudicator suggestions: pass the effort as `effort` \(Claude Code 2\.1\.292 or later\) on each Agent call; a pinned agent keeps its model: pass no `model`:$/,
      },
      {
        advice: [pinned, { ...base, taskId: 4 }],
        env: {},
        next: ", passing `model` and `effort` as each suggestion below says; leave `model` unset for pinned agents",
        head: /pass the model as `model` and the effort as `effort`.*; a pinned agent keeps its model: pass no `model`:$/,
      },
      {
        advice: [pinned],
        env: { CLAUDE_CODE_EFFORT_LEVEL: "high" },
        next: "; the suggestions below are informational: leave `model` unset for pinned agents and pass no `effort` (CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`)",
        head: /^Adjudicator suggestions: informational only \(effort: CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`\); a pinned agent keeps its model: pass no `model`:$/,
      },
      {
        advice: [{ ...base, forced: true }],
        env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" },
        next: ", passing `effort` as each suggestion below says; leave `model` unset (CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets it)",
        head: /the model is informational; pass the effort as `effort`/,
      },
      {
        advice: [{ ...base, forced: true }],
        env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_EFFORT_LEVEL: "max" },
        next: "; the suggestions below are informational: leave `model` unset (CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets it) and pass no `effort` (CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`)",
        head: /the model is informational; CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`, so effort is too/,
      },
    ];
    for (const c of cases) {
      const label = JSON.stringify({ env: c.env, pins: c.advice.map((a) => !!a.pin) });
      expect(planNextHint(c.advice, c.env), label).toBe(c.next);
      expect(planAdviceHead(c.advice, c.env), label).toMatch(c.head);
      const p = planPassing(c.advice, c.env);
      // the Next hint names `model` exactly when the head tells the coordinator to pass it
      expect(/passing `model`/.test(planNextHint(c.advice, c.env)), label).toBe(p.model);
      expect(/pass the model as `model`/.test(planAdviceHead(c.advice, c.env)), label).toBe(
        p.model,
      );
    }
    expect(planNextHint([], {})).toBe("");
    // under FORCE a line names the model as informational and never a pin
    expect(planLines([{ ...base, forced: true }])[0]).toBe(
      "#3 → swarm-feat-coder · model haiku (informational) · effort low (complexity 1, conf 0.90)",
    );
  });

  it("the effort ladder reaches max only at the top of the scale", () => {
    expect(EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect([3.5, 3.6, MAX_EFFORT_AT - 0.01, MAX_EFFORT_AT, 4].map(effortFor)).toEqual([
      "xhigh",
      "xhigh",
      "xhigh",
      "max",
      "max",
    ]);
  });

  describe("adjudicatePlan resolves each agent's pin", () => {
    let root: string;
    let db: StorageAdapter;
    const savedHome = process.env.HOME;
    beforeAll(() => {
      process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-adj-pin-"));
      process.env.HOME = mkdtempSync(join(tmpdir(), "em-user-adj-pin-"));
      root = mkdtempSync(join(tmpdir(), "em-adj-pin-"));
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, ".claude", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".claude", "agents", "pinned.md"),
        "---\nname: pin-coder\nmodel: opus\n---\nb\n",
      );
      writeFileSync(
        join(root, ".claude", "agents", "free.md"),
        "---\nname: free-coder\nmodel: inherit\n---\nb\n",
      );
      resetContextCache();
      db = getStorage(getContext(root), { vectors: false });
    });
    afterAll(() => {
      closeAllStorage();
      delete process.env.EMINIAR_HOME;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    });

    const spec = {
      name: "pins",
      roles: [
        { role: "pinned", agentType: "pin-coder", description: "pinned coder" },
        { role: "free", agentType: "free-coder", description: "free coder" },
        { role: "ghost", agentType: "ghost-coder", description: "no file" },
      ],
    } as unknown as SwarmSpec;

    const plan = async (adjudicator: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) => {
      const ctx = { root, config: configWith({ enabled: true, ...adjudicator }) };
      const run = db.swarm.runCreate({
        id: `pins-${Math.random().toString(36).slice(2, 8)}`,
        swarm: "pins",
        goal: "g",
        topology: "hierarchical",
      });
      const tasks = ["pinned", "free", "ghost"].map((role) =>
        db.swarm.taskAdd({
          run_id: run.id,
          title: `Rename a variable in the ${role} module`,
          role,
        }),
      );
      return adjudicatePlan(ctx, db, run, spec, tasks, { provider: null, env });
    };

    it("apply mode marks every task effortApplied, pinned or not; advise mode marks none", async () => {
      const a = await plan({ mode: "apply" });
      expect(a.map((x) => x.effortApplied)).toEqual([true, true, true]);
      // the pins are still respected: the hook sets the effort, never a pinned model
      expect(a.map((x) => x.pin?.status)).toEqual(["pinned", undefined, "unknown"]);
      const lines = planLines(a);
      expect(lines[0]).toMatch(
        /^#\d+ → pin-coder · pinned opus \(.*\) · effort \w+ \(applied by the hook\) \(complexity/,
      );
      expect(lines[1]).toMatch(
        /^#\d+ → free-coder · model (haiku|sonnet|opus|fable) · effort \w+ \(applied by the hook\) \(/,
      );
      expect(lines[2]).toMatch(/ · effort \w+ \(applied by the hook\) \(/);
      const block = planAdviceBlock(a, {});
      expect(block).toMatch(/the hook sets `effort` on the Agent call in apply mode/);
      expect(block).not.toMatch(/pass the effort as `effort`|the effort as `effort`/);
      expect(planPassing(a, {})).toMatchObject({ applied: true, effort: false });

      const advise = await plan({ mode: "advise" });
      expect(advise.every((x) => x.effortApplied === undefined)).toBe(true);
      expect(planLines(advise).join("\n")).not.toMatch(/applied by the hook/);
      expect(planPassing(advise, {})).toMatchObject({ applied: false, effort: true });
    });

    it("apply mode under CLAUDE_CODE_EFFORT_LEVEL does not claim the hook sets the effort", async () => {
      const env = { CLAUDE_CODE_EFFORT_LEVEL: "high" };
      const a = await plan({ mode: "apply" }, env);
      expect(a.every((x) => x.effortApplied === undefined)).toBe(true);
      expect(planLines(a).join("\n")).not.toMatch(/applied by the hook/);
      expect(planAdviceBlock(a, env)).not.toMatch(/the hook sets/);
      expect(planPassing(a, env).applied).toBe(false);
    });

    it("apply mode with surfaces.agent off does not claim the hook sets the effort (#245)", async () => {
      // onPreAgent returns early when surfaces.agent is off, so the hook sets nothing
      const surfaces = { prompt: true, agent: false, plan: true, tools: false };
      const a = await plan({ mode: "apply", surfaces });
      expect(a).toHaveLength(3);
      expect(a.every((x) => !x.effortApplied)).toBe(true);
      expect(planPassing(a, {})).toMatchObject({ applied: false, effort: true });
      const text = [planAdviceHead(a, {}), planNextHint(a, {}), ...planLines(a)].join("\n");
      expect(text).not.toMatch(/applied by the hook|the hook sets/);
      // the coordinator passes the effort itself, as in advise mode
      expect(planAdviceHead(a, {})).toMatch(/the effort as `effort`/);
      expect(planNextHint(a, {})).toMatch(
        /passing `[^`]+`( and `effort`)? as each suggestion below says/,
      );
      expect(planNextHint(a, {})).toContain("`effort`");
      expect(planLines(a).join("\n")).toMatch(/ · effort \w+ \(/);
      // the full block agrees with advise mode on the effort wording
      const advise = await plan({ mode: "advise" });
      const ids = (s: string) => s.replace(/#\d+/g, "#N");
      expect(ids(planAdviceBlock(a, {}))).toBe(ids(planAdviceBlock(advise, {})));

      // surfaces.agent on (and the unset default) still applies the effort
      for (const on of [
        { ...surfaces, agent: true },
        { prompt: true, plan: true },
      ]) {
        const applied = await plan({ mode: "apply", surfaces: on });
        expect(applied.map((x) => x.effortApplied)).toEqual([true, true, true]);
        expect(planAdviceBlock(applied, {})).toMatch(/the hook sets `effort`/);
        expect(planLines(applied).join("\n")).toMatch(/applied by the hook/);
      }
    });

    it("pinned and unknown pins are kept; an unpinned agent gets a model", async () => {
      const a = await plan({});
      expect(a.map((x) => x.pin)).toEqual([
        { status: "pinned", model: "opus", source: "project" },
        undefined,
        { status: "unknown", source: undefined },
      ]);
      const lines = planLines(a);
      expect(lines[0]).toMatch(/^#\d+ → pin-coder · pinned opus \(/);
      expect(lines[1]).toMatch(/^#\d+ → free-coder · model (haiku|sonnet|opus|fable) · effort /);
      expect(lines[2]).toMatch(/^#\d+ → ghost-coder · model pin is unknown \(/);
      for (const l of [lines[0], lines[2]])
        expect(l).not.toMatch(/ · model (haiku|sonnet|opus|fable) /);
    });

    it("apply.respectFrontmatter false advises over every pin", async () => {
      const a = await plan({ apply: { respectFrontmatter: false } });
      expect(a.every((x) => x.pin === undefined)).toBe(true);
      expect(planLines(a).every((l) => / · model \w+ · effort /.test(l))).toBe(true);
    });

    it("flags the plan rows of kept pins (pinDeferred) and leaves the others alone", async () => {
      const a = await plan({});
      const flags = a.map((x) => JSON.parse(db.adjudicator.get(x.rowId!)?.scores ?? "{}"));
      expect(flags.map((f) => f.pinDeferred)).toEqual([true, undefined, true]);
      expect(flags[0].pin).toMatchObject({ status: "pinned", model: "opus" });
      expect(flags.every((f) => f.forced === undefined)).toBe(true);
    });

    it("names no pin under CLAUDE_CODE_SUBAGENT_MODEL_FORCE and flags the rows forced (#75)", async () => {
      const ctx = { root, config: configWith({ enabled: true }) };
      const run = db.swarm.runCreate({
        id: `force-${Math.random().toString(36).slice(2, 8)}`,
        swarm: "pins",
        goal: "g",
        topology: "hierarchical",
      });
      const tasks = ["pinned", "free", "ghost"].map((role) =>
        db.swarm.taskAdd({ run_id: run.id, title: `Rename a thing in ${role}`, role }),
      );
      const env = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" };
      const a = await adjudicatePlan(ctx, db, run, spec, tasks, { provider: null, env });
      expect(a.every((x) => x.pin === undefined && x.forced === true)).toBe(true);
      const block = planAdviceBlock(a, env);
      expect(block).not.toMatch(/pinned|pin is unknown|remove the pin/);
      expect(block).toMatch(/· model \w+ \(informational\) · effort /);
      for (const x of a) {
        const sc = JSON.parse(db.adjudicator.get(x.rowId!)?.scores ?? "{}");
        expect(sc.forced).toBe(true);
        expect(sc.pinDeferred).toBeUndefined();
      }
    });

    it("logs and reports an internal advice error instead of swallowing it", async () => {
      const ctx = { root, config: configWith({ enabled: true }) };
      const run = db.swarm.runCreate({
        id: `err-${Math.random().toString(36).slice(2, 8)}`,
        swarm: "pins",
        goal: "g",
        topology: "hierarchical",
      });
      const task = db.swarm.taskAdd({ run_id: run.id, title: "x", role: "free" });
      const logs: string[] = [];
      const errors: unknown[] = [];
      const broken = { ...task, files: undefined } as unknown as TaskRow;
      const a = await adjudicatePlan(ctx, db, run, spec, [broken], {
        provider: null,
        env: {},
        log: (l) => logs.push(l),
        onError: (e) => errors.push(e),
      });
      expect(a).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(logs.join("\n")).toMatch(/^adjudicator: plan advice skipped: /);
    });
  });
});

describe("em_swarm plan advice and em_adjudicate", () => {
  let root: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;
  let main: CallerStamp;
  const baseConfig = () => ConfigSchema.parse({});
  type Args = Parameters<typeof emSwarm.handler>[0];
  const call = async (args: Args) => {
    const r = await emSwarm.handler({ ...args, ...main }, ctx);
    return r.content.map((c) => c.text).join("\n");
  };
  const finishAll = async () => {
    for (const r of db.swarm.runs({ status: "active", limit: 50 }))
      await call({ action: "finish", run: r.id, status: "cancelled" });
  };
  const enable = (over: Record<string, unknown> = {}) => {
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({ enabled: true, provider: "embedding", ...over }).adjudicator,
    };
  };

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-adj-swarm-"));
    resetSwarmSecret();
    main = signCaller({ kind: "main", sessionId: SESSION });
    root = mkdtempSync(join(tmpdir(), "em-adj-swarm-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), YAML);
    resetContextCache();
    resetSwarmConfigCache();
    ctx = getContext(root);
    db = getStorage(ctx, { vectors: false });
  });
  afterAll(() => {
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
  });
  beforeEach(() => {
    resetProviders();
    ctx.config = baseConfig();
  });
  afterEach(async () => {
    await finishAll();
    resetProviders();
  });

  it("leaves start and plan untouched while the adjudicator is off", async () => {
    const { p, calls } = fakeProvider();
    registerProvider("embedding", () => p);
    const start = await call({ action: "start", swarm: "feat", goal: "off goal" });
    expect(start).not.toContain("Adjudicator on");
    const before = db.adjudicator.list().total;
    const out = await call({
      action: "plan",
      tasks: [{ title: "Refactor the storage layer", role: "coder" }],
    });
    expect(out).not.toMatch(/Adjudicator|model/);
    expect(calls).toHaveLength(0);
    expect(db.adjudicator.list().total).toBe(before);
  });

  it("adds one coordinatorBrief line when enabled", async () => {
    enable();
    const start = await call({ action: "start", swarm: "feat", goal: "on goal" });
    expect(start.match(/Adjudicator on:/g)).toHaveLength(1);
    expect(start).toContain(
      "says exactly what to pass on the Agent call (`model` and/or `effort`; pinned agents, CLAUDE_CODE_SUBAGENT_MODEL_FORCE and CLAUDE_CODE_EFFORT_LEVEL change what it asks for)",
    );
  });

  it("scores a plan in ONE batched provider call, prints a line per task and stores rows by (run, task)", async () => {
    enable();
    const { p, calls } = fakeProvider("opus", "tester");
    registerProvider("embedding", () => p);
    await call({ action: "start", swarm: "feat", goal: "plan goal" });
    const out = await call({
      action: "plan",
      tasks: [
        { title: "Redesign the storage layer across every adapter and migration", role: "coder" },
        { title: "Write integration tests for the new migration path", role: "tester" },
        {
          // Every statement is test work (per-statement scoring, units.ts, where "run the test
          // suite until the tests pass" alone is boilerplate and moves nothing).
          title: "Unit tests, integration tests and regression tests for the parser",
          detail: "Snapshot tests for the printer. Test coverage for every branch of the lexer.",
          role: "coder",
        },
        {
          // The same work with no planned role: nothing argues for another role.
          title: "Unit tests, integration tests and regression tests for the lexer",
          detail: "Snapshot tests for the printer. Test coverage for every branch of the parser.",
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
    expect(calls[0]?.every((r) => r.surface === "plan")).toBe(true);
    expect(out).toContain(
      'names "task #N" (the worker claims it), passing `model` and `effort` as each suggestion below says; run_in_background',
    );
    expect(out).toContain(
      "Adjudicator suggestions: pass the model as `model` and the effort as `effort` on each Agent call",
    );
    const lines = out.split("\n").filter((l) => /^#\d+ → /.test(l));
    expect(lines).toHaveLength(4);
    // A saturated brief (units.ts) shows its effort as informational.
    for (const l of lines)
      expect(l).toMatch(
        /^#\d+ → swarm-feat-(coder|tester) · model (haiku|sonnet|opus|fable) · effort (low|medium|high|xhigh|max)(: informational)? \((brief saturated; )?complexity \d, conf \d\.\d\d\)/,
      );

    const run = db.swarm.runs({ status: "active", limit: 1 })[0]!;
    const tasks = db.swarm.tasks(run.id);
    for (const t of tasks) {
      const rows = db.adjudicator.forTask(run.id, t.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        surface: "plan",
        runId: run.id,
        taskId: t.id,
        action: "advised",
        sessionId: SESSION,
      });
      expect((TIERS as readonly string[]).includes(rows[0]!.tier ?? "")).toBe(true);
      expect(lines.some((l) => l.startsWith(`#${t.id} → `))).toBe(true);
    }
    // A role note needs a role table at ROLE_NOTE_MIN (the heuristic's role: the embedding
    // provider has no role weight). The planned role's hint votes in every statement, so the
    // coder task's tester table stays below it and gets no note; the unplanned task gets one.
    const roleConf = (id: number) =>
      JSON.parse(db.adjudicator.forTask(run.id, id)[0]!.scores!).role.confidence as number;
    const [coder, , testWork, unplanned] = tasks;
    const lineOf = (id: number) => lines.find((l) => l.startsWith(`#${id} `)) ?? "";
    expect(roleConf(testWork!.id)).toBeLessThan(ROLE_NOTE_MIN);
    expect(lineOf(testWork!.id), lines.join("\n")).not.toMatch(/role suggested/);
    expect(roleConf(unplanned!.id)).toBeGreaterThanOrEqual(ROLE_NOTE_MIN);
    expect(lineOf(unplanned!.id)).toMatch(
      /^#\d+ → swarm-feat-tester · .*; role suggested: tester$/,
    );
    expect(lineOf(coder!.id)).not.toMatch(/role suggested/);
  });

  it("falls back to the heuristic when the provider fails, still within one call", async () => {
    enable();
    let n = 0;
    registerProvider("embedding", () => ({
      id: "embedding",
      remote: false,
      dims: ["tier"],
      async adjudicate() {
        n++;
        throw new Error("boom");
      },
      async probe() {
        return { ok: false, latencyMs: 0, detail: "x" };
      },
    }));
    await call({ action: "start", swarm: "feat", goal: "fail goal" });
    const out = await call({
      action: "plan",
      tasks: [
        { title: "Fix a typo in the README", role: "coder" },
        { title: "Add a test", role: "tester" },
      ],
    });
    expect(n).toBe(1);
    expect(out.split("\n").filter((l) => /^#\d+ → /.test(l))).toHaveLength(2);
  });

  it("fails open when the advice step throws: the plan reports its tasks once (#66)", async () => {
    enable();
    const { p } = fakeProvider();
    registerProvider("embedding", () => p);
    await call({ action: "start", swarm: "feat", goal: "advice throws" });
    const run = db.swarm.runs({ status: "active", limit: 1 })[0]!;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    planFault.error = new Error("Cannot find module app-swarm-X.js");
    let out: string;
    try {
      out = await call({
        action: "plan",
        tasks: [{ title: "Implement exponential backoff in the downloader", role: "coder" }],
      });
    } finally {
      planFault.error = undefined;
      spy.mockRestore();
    }
    expect(out).not.toMatch(/failed|Cannot find module/);
    expect(out).toMatch(/^Planned 1 task\(s\) in run /);
    expect(out).toContain("Implement exponential backoff in the downloader (coder)");
    expect(out).not.toContain("Adjudicator suggestions");
    expect(out).not.toContain("as each suggestion below says");
    expect(out.split("\n").at(-1)).toBe(
      "Adjudicator advice unavailable for this plan (the tasks are planned).",
    );
    expect(writes.join("")).toContain("adjudicator plan advice skipped: Cannot find module");
    const tasks = db.swarm.tasks(run.id);
    expect(tasks).toHaveLength(1);
  });

  it("reports advice unavailable when adjudicatePlan fails inside, on stderr too (#73)", async () => {
    enable();
    const { p } = fakeProvider();
    registerProvider("embedding", () => p);
    await call({ action: "start", swarm: "feat", goal: "advice fails inside" });
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    planFault.internal = true;
    let out: string;
    try {
      out = await call({ action: "plan", tasks: [{ title: "Add a retry", role: "coder" }] });
    } finally {
      planFault.internal = false;
      spy.mockRestore();
    }
    expect(out).toMatch(/^Planned 1 task\(s\) in run /);
    expect(out).not.toContain("Adjudicator suggestions");
    expect(out).not.toContain("as each suggestion below says");
    expect(out.split("\n").at(-1)).toBe(
      "Adjudicator advice unavailable for this plan (the tasks are planned).",
    );
    expect(writes.join("")).toMatch(/eminiar: adjudicator: plan advice skipped: /);
  });

  it("skips plan advice when surfaces.plan is off, and adjudicatePlan is a no-op when disabled", async () => {
    enable({ surfaces: { plan: false } });
    const { p, calls } = fakeProvider();
    registerProvider("embedding", () => p);
    const start = await call({ action: "start", swarm: "feat", goal: "plan off" });
    expect(start).not.toContain("Adjudicator on");
    const out = await call({
      action: "plan",
      tasks: [{ title: "Refactor everything", role: "coder" }],
    });
    expect(out).not.toContain("Adjudicator suggestions");
    expect(calls).toHaveLength(0);

    const run = db.swarm.runs({ status: "active", limit: 1 })[0]!;
    const off = { ...ctx, config: baseConfig() };
    const spec = { name: "feat", roles: [] } as unknown as SwarmSpec;
    expect(await adjudicatePlan(off, db, run, spec, db.swarm.tasks(run.id))).toEqual([]);
  });

  it("score: one compact line per item, recorded with surface mcp; explain shows the tables", async () => {
    enable({ provider: "heuristic" });
    const before = db.adjudicator.list().total;
    const r = await runAdjudicate(
      {
        action: "score",
        tasks: [
          { key: "a", title: "Rename a variable in src/util.ts" },
          {
            key: "b",
            title: "Design the new storage architecture and migration plan",
            role: "architect",
          },
        ],
      },
      ctx,
      { db },
    );
    expect(r.isError).toBeFalsy();
    const text = r.content[0]!.text;
    expect(text.length).toBeLessThanOrEqual(1000);
    const lines = text.split("\n").filter((l) => /^\[\d+\] [ab]: /.test(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /complexity \d \(\d\.\d\d\) · (haiku|sonnet|opus|fable)\/\w+ · tool \S+ · role \S+ · conf \d\.\d\d/,
    );
    expect(db.adjudicator.list().total).toBe(before + 2);
    const id = Number(/^\[(\d+)\]/.exec(lines[1]!)![1]);
    expect(db.adjudicator.get(id)?.surface).toBe("mcp");

    const ex = (await runAdjudicate({ action: "explain", id }, ctx, { db })).content[0]!.text;
    expect(ex).toContain(`Decision ${id}`);
    expect(ex).toMatch(/^tier: \w+ \(conf/m);
    expect(ex).toMatch(/^role: \w+ \(conf/m);
    expect(ex).toMatch(/^tool: \S+ \(conf/m);
    expect(ex).toContain("now: provider heuristic");
    expect(ex).toContain("outcome pending");

    expect((await runAdjudicate({ action: "explain", id: 999999 }, ctx, { db })).isError).toBe(
      true,
    );
    expect((await runAdjudicate({ action: "score" }, ctx, { db })).isError).toBe(true);
  });

  it("score with text, and stays under 1 KB for a full batch of 20", async () => {
    enable({ provider: "heuristic" });
    const one = (
      await runAdjudicate({ action: "score", text: "why does the build fail on CI?" }, ctx, { db })
    ).content[0]!.text;
    expect(one).toMatch(/^\[\d+\] text: complexity/);
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      title: `Refactor module ${i} and update every caller across the codebase`,
    }));
    const many = (await runAdjudicate({ action: "score", tasks }, ctx, { db })).content[0]!.text;
    expect(many.length).toBeLessThanOrEqual(1000);
  });

  it("feedback sets the outcome and teaches the bias; stats summarises", async () => {
    enable({ provider: "heuristic" });
    const r = await runAdjudicate(
      { action: "score", text: "Refactor the session store and its tests" },
      ctx,
      { db },
    );
    const id = Number(/^\[(\d+)\]/.exec(r.content[0]!.text)![1]);
    const fb = await runAdjudicate(
      { action: "feedback", id, outcome: "too_small", note: "needed opus" },
      ctx,
      { db },
    );
    expect(fb.content[0]!.text).toMatch(
      new RegExp(
        `^Feedback too_small on decision ${id} .*outcome failure, final; the learned bias was updated\\. Note: needed opus$`,
      ),
    );
    expect(db.adjudicator.get(id)).toMatchObject({
      outcome: "failure",
      outcomeSource: "feedback:too_small",
      final: true,
    });
    expect(db.adjudicator.biasAll().some((b) => b.dimension === "tier")).toBe(true);
    // Review #30 / task #39: re-sending the same feedback (a retried tool call) is idempotent.
    const bias = db.adjudicator.biasAll();
    for (let i = 0; i < 5; i++) {
      const again = await runAdjudicate({ action: "feedback", id, outcome: "too_small" }, ctx, {
        db,
      });
      expect(again.content[0]!.text).toContain("the learned bias already reflects this");
    }
    expect(db.adjudicator.biasAll()).toEqual(bias);
    expect((await runAdjudicate({ action: "feedback", id }, ctx, { db })).isError).toBe(true);
    expect(
      (await runAdjudicate({ action: "feedback", id: 999999, outcome: "good" }, ctx, { db }))
        .isError,
    ).toBe(true);

    const st = (await runAdjudicate({ action: "stats", since: "7d" }, ctx, { db })).content[0]!
      .text;
    expect(st).toMatch(/^Adjudicator since \d{4}-\d{2}-\d{2}: \d+ decision\(s\)/);
    expect(st).toContain("outcomes ");
    expect(st).toContain("spend ");
    expect(st.length).toBeLessThanOrEqual(1000);
    expect((await runAdjudicate({ action: "stats", since: "lately" }, ctx, { db })).isError).toBe(
      true,
    );
  });

  it("stores the feedback note redacted and capped, and shows it in explain", async () => {
    enable({ provider: "heuristic" });
    const r = await runAdjudicate({ action: "score", text: "Rename the flag in the CLI" }, ctx, {
      db,
    });
    const id = Number(/^\[(\d+)\]/.exec(r.content[0]!.text)![1]);
    await runAdjudicate(
      {
        action: "feedback",
        id,
        outcome: "too_big",
        note: "haiku was enough; token sk-abcdefghijklmnopqrstuvwx leaked in the log",
      },
      ctx,
      { db },
    );
    const note = db.adjudicator.get(id)?.feedbackNote;
    expect(note).toBe("haiku was enough; token sk-*** leaked in the log");
    const ex = (await runAdjudicate({ action: "explain", id }, ctx, { db })).content[0]!.text;
    expect(ex).toContain(`feedback note: "${note}"`);

    await runAdjudicate(
      { action: "feedback", id, outcome: "good", note: `${"long note ".repeat(100)}end` },
      ctx,
      { db },
    );
    const long = db.adjudicator.get(id)?.feedbackNote ?? "";
    expect(Array.from(long)).toHaveLength(NOTE_MAX);
    expect(long.endsWith("…")).toBe(true);
    // Feedback without a note keeps the earlier one.
    await runAdjudicate({ action: "feedback", id, outcome: "good" }, ctx, { db });
    expect(db.adjudicator.get(id)?.feedbackNote).toBe(long);
  });

  it("score and feedback refuse while off; explain and stats still read", async () => {
    expect(
      (await runAdjudicate({ action: "score", text: "x y z" }, ctx, { db })).content[0]!.text,
    ).toMatch(/adjudicator is off/);
    expect(
      (await runAdjudicate({ action: "feedback", id: 1, outcome: "good" }, ctx, { db })).content[0]!
        .text,
    ).toMatch(/adjudicator is off/);
    expect((await runAdjudicate({ action: "stats" }, ctx, { db })).isError).toBeFalsy();
  });
});

describe("em_swarm plan with pinned swarm agents (#73, #75)", () => {
  const PINNED_YAML = `
version: 1
swarms:
  pin:
    description: pinned swarm
    max_agents: 3
    agents:
      coder:
        description: writes and refactors code
        model: opus
      reviewer:
        description: reviews changes
        model: opus
`;
  let ctx: ProjectContext;
  let main: CallerStamp;
  const saved = {
    force: process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE,
    sub: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
    home: process.env.HOME,
  };
  type Args = Parameters<typeof emSwarm.handler>[0];
  const call = async (args: Args) => {
    const r = await emSwarm.handler({ ...args, ...main }, ctx);
    return r.content.map((c) => c.text).join("\n");
  };
  const plan = async (env: Record<string, string>) => {
    Object.assign(process.env, env);
    try {
      await call({ action: "start", swarm: "pin", goal: `pins ${Object.keys(env).join(",")}` });
      const out = await call({
        action: "plan",
        tasks: [
          { title: "Rename the helper in utils", role: "coder" },
          { title: "Review the change for security issues", role: "reviewer" },
        ],
      });
      const db = getStorage(ctx, { vectors: false });
      for (const r of db.swarm.runs({ status: "active", limit: 50 }))
        await call({ action: "finish", run: r.id, status: "cancelled" });
      return out;
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };
  const nextOf = (out: string) => out.split("\n").find((l) => l.startsWith("Next:")) ?? "";
  const headOf = (out: string) =>
    out.split("\n").find((l) => l.startsWith("Adjudicator suggestions")) ?? "";

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-adj-pinswarm-"));
    process.env.HOME = mkdtempSync(join(tmpdir(), "em-user-adj-pinswarm-"));
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    resetSwarmSecret();
    main = signCaller({ kind: "main", sessionId: "sess-adj-pinswarm" });
    const root = mkdtempSync(join(tmpdir(), "em-adj-pinswarm-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), PINNED_YAML);
    resetContextCache();
    resetSwarmConfigCache();
    ctx = getContext(root);
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({ enabled: true, provider: "heuristic" }).adjudicator,
    };
  });
  afterAll(() => {
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
    for (const [k, v] of [
      ["CLAUDE_CODE_SUBAGENT_MODEL_FORCE", saved.force],
      ["CLAUDE_CODE_SUBAGENT_MODEL", saved.sub],
      ["HOME", saved.home],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it("never tells the coordinator to pass `model` to pinned agents", async () => {
    const out = await plan({});
    expect(headOf(out)).toMatch(/a pinned agent keeps its model: pass no `model`:$/);
    expect(headOf(out)).not.toMatch(/pass the model as `model`/);
    expect(nextOf(out)).toContain(
      "passing `effort` as each suggestion below says; leave `model` unset for pinned agents",
    );
    expect(nextOf(out)).not.toMatch(/passing `model`|suggested model/);
    expect(out).toMatch(/ · pinned opus \(/);
  });

  it("with CLAUDE_CODE_EFFORT_LEVEL set, Next passes nothing, like the head", async () => {
    const out = await plan({ CLAUDE_CODE_EFFORT_LEVEL: "high" });
    expect(headOf(out)).toMatch(/^Adjudicator suggestions: informational only/);
    expect(nextOf(out)).toContain(
      "the suggestions below are informational: leave `model` unset for pinned agents and pass no `effort`",
    );
    expect(nextOf(out)).not.toMatch(/passing `/);
  });

  it("in apply mode the head and Next say the hook sets the effort: pass no `effort`", async () => {
    const advise = ctx.config.adjudicator;
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({ enabled: true, provider: "heuristic", mode: "apply" }).adjudicator,
    };
    try {
      const out = await plan({});
      expect(headOf(out)).toContain("the hook sets `effort` on the Agent call in apply mode");
      expect(headOf(out)).not.toMatch(/pass the effort as `effort`/);
      expect(nextOf(out)).toContain("the hook sets `effort` (apply mode): pass no `effort`");
      expect(nextOf(out)).not.toMatch(/passing `effort`|passing `model` and `effort`/);
      expect(out).toMatch(/ · pinned opus \(.*\) · effort \w+ \(applied by the hook\) \(/);
      // CLAUDE_CODE_EFFORT_LEVEL outranks the hook: back to the informational wording
      const env = await plan({ CLAUDE_CODE_EFFORT_LEVEL: "high" });
      expect(headOf(env)).toMatch(/^Adjudicator suggestions: informational only/);
      expect(env).not.toMatch(/applied by the hook/);
      expect(nextOf(env)).not.toMatch(/the hook sets/);
    } finally {
      ctx.config = { ...ctx.config, adjudicator: advise };
    }
  });

  it("in apply mode with surfaces.agent off the head and Next tell the coordinator to pass the effort (#245)", async () => {
    const advise = ctx.config.adjudicator;
    const apply = configWith({ enabled: true, provider: "heuristic", mode: "apply" }).adjudicator;
    ctx.config = {
      ...ctx.config,
      adjudicator: { ...apply, surfaces: { ...apply.surfaces, agent: false } },
    };
    try {
      const out = await plan({});
      expect(headOf(out)).not.toMatch(/the hook sets/);
      expect(nextOf(out)).not.toMatch(/the hook sets/);
      expect(out).not.toMatch(/applied by the hook/);
      expect(nextOf(out)).toContain("`effort`");
      expect(nextOf(out)).not.toMatch(/pass no `effort`/);
    } finally {
      ctx.config = { ...ctx.config, adjudicator: advise };
    }
  });

  it("under FORCE names no pin and calls the model informational everywhere", async () => {
    const out = await plan({
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
    });
    expect(headOf(out)).toMatch(/the model is informational/);
    expect(out).not.toMatch(/pinned opus|remove the pin/);
    expect(out).toMatch(/ · model \w+ \(informational\) · /);
    expect(nextOf(out)).toContain(
      "passing `effort` as each suggestion below says; leave `model` unset (CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets it)",
    );
    expect(nextOf(out)).not.toMatch(/passing `model`/);
  });
});

describe("registerServerProviders", () => {
  beforeEach(() => resetProviders());
  afterEach(() => resetProviders());

  it("registers the embedding provider only when it is the effective provider", async () => {
    expect(await registerServerProviders(configWith({ provider: "embedding" }))).toBe(false);
    expect(hasProvider("embedding")).toBe(false);
    expect(
      await registerServerProviders(configWith({ enabled: true, provider: "heuristic" })),
    ).toBe(false);
    expect(hasProvider("embedding")).toBe(false);
    expect(
      await registerServerProviders(configWith({ enabled: true, provider: "embedding" })),
    ).toBe(true);
    expect(hasProvider("embedding")).toBe(true);
  });

  it("warms the exemplars and then the model in the background, never before returning", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const factory = (() => ({
      id: "embedding",
      remote: false,
      dims: ["tier", "complexity"],
      async adjudicate() {
        throw new Error("not called");
      },
      async warm() {
        order.push("exemplars");
        await gate;
      },
    })) as unknown as NonNullable<ServerProviderOptions["factory"]>;
    const embedder = async () => ({ warm: () => void order.push("model") });
    const cfg = configWith({ enabled: true, provider: "embedding" });

    expect(await registerServerProviders(cfg, { warm: true, factory, embedder })).toBe(true);
    expect(hasProvider("embedding")).toBe(true);
    expect(order).toEqual(["exemplars"]); // registered while the exemplar load is still running
    release();
    await new Promise((res) => setTimeout(res, 0));
    expect(order).toEqual(["exemplars", "model"]);

    // A failing warm-up is swallowed; without warm nothing is loaded.
    order.length = 0;
    const failing = (() => ({
      async warm() {
        order.push("fail");
        throw new Error("no model");
      },
    })) as unknown as NonNullable<ServerProviderOptions["factory"]>;
    expect(await registerServerProviders(cfg, { warm: true, factory: failing, embedder })).toBe(
      true,
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(order).toEqual(["fail"]);
    order.length = 0;
    expect(await registerServerProviders(cfg, { factory, embedder })).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(order).toEqual([]);
    // Disabled: no registration and no warm-up.
    resetProviders();
    expect(
      await registerServerProviders(configWith({ provider: "embedding" }), {
        warm: true,
        factory,
        embedder,
      }),
    ).toBe(false);
    expect(hasProvider("embedding")).toBe(false);
    expect(order).toEqual([]);
  });
});

describe("score line helpers", () => {
  it("keeps the three strongest reasons", () => {
    const r = topReasons([
      { feature: "a", weight: 0.1, note: "small" },
      { feature: "b", weight: -0.9, note: "big negative" },
      { feature: "c", weight: 0.5, note: "mid" },
      { feature: "d", weight: 0.3, note: "" },
    ]);
    expect(r).toEqual(["big negative", "mid", "d"]);
    expect(typeof scoreLine).toBe("function");
  });
});
