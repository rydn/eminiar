/**
 * Swarm decision view (task #139): plan advice next to what the dispatch ran, and whether it
 * followed. Pure over stubbed rows: no database, no env.
 */
import { describe, expect, it } from "vitest";
import { swarmDecisions } from "../../src/adjudicator/swarm-decisions.js";
import type { AdjudicationRow } from "../../src/adjudicator/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import type { TaskRow } from "../../src/swarm/types.js";

let n = 0;
function row(
  surface: "plan" | "agent",
  o: Partial<AdjudicationRow> & { s?: object },
): AdjudicationRow {
  const { s, ...rest } = o;
  return {
    id: ++n,
    ts: 1000 + n,
    surface,
    inputHash: "h",
    outcome: "pending",
    final: false,
    tier: "opus",
    effort: "high",
    complexity: 3,
    confidence: 0.9,
    scores: JSON.stringify(s ?? {}),
    ...rest,
  };
}
const task = (id: number, title = `t${id}`): TaskRow => ({
  id,
  run_id: "r",
  title,
  detail: null,
  role: "coder",
  status: "active",
  agent_id: null,
  deps: [],
  files: [],
  result: null,
  auto_closed: false,
  created_by: null,
  created_at: 1,
  updated_at: 1,
});
const dbOf = (tasks: TaskRow[], rows: Record<number, AdjudicationRow[]>): StorageAdapter =>
  ({
    swarm: { tasks: () => tasks },
    adjudicator: { forTask: (_r: string, id: number) => rows[id] ?? [] },
  }) as unknown as StorageAdapter;

describe("swarmDecisions", () => {
  it("followed / overrode / applied / none by what the call passed", () => {
    const plan = (): AdjudicationRow => row("plan", { s: { advisedPick: "sonnet" } });
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3), task(4), task(5)], {
        1: [plan(), row("agent", { modelRequested: "sonnet", s: { advisedPick: "sonnet" } })],
        2: [plan(), row("agent", { modelRequested: "opus", s: { advisedPick: "sonnet" } })],
        3: [
          plan(),
          row("agent", { action: "applied", modelFinal: "sonnet", s: { advisedPick: "sonnet" } }),
        ],
        4: [plan(), row("agent", { action: "advised", s: { advisedPick: "sonnet" } })],
        5: [plan()],
      }),
      "r",
    );
    expect(d.map((x) => x.follow)).toEqual(["followed", "overrode", "followed", "none", "none"]);
    expect(d[1]?.modelDiffers).toBe(true);
    expect(d[0]?.modelDiffers).toBe(false);
    expect(d[4]?.ran).toBeUndefined();
    expect(d[0]?.advice?.model).toBe("sonnet");
  });

  it("pinned, forced and fork keep the advice informational", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3)], {
        1: [
          row("plan", {}),
          row("agent", {
            actualModel: "claude-opus-4-1",
            s: { pinDeferred: true, pin: { status: "pinned", model: "opus" } },
          }),
        ],
        2: [row("plan", {}), row("agent", { modelRequested: "haiku", s: { forced: true } })],
        3: [row("plan", {}), row("agent", { s: { fork: true } })],
      }),
      "r",
    );
    expect(d.map((x) => x.follow)).toEqual(["pinned", "forced", "fork"]);
    expect(d[0]?.advice).toMatchObject({ pin: "pinned", pinnedModel: "opus", pinDeferred: true });
    expect(d[0]?.ran?.tier).toBe("opus");
    expect(d[1]?.advice?.forced).toBe(true);
  });

  it("a kept pin / forced / fork row never claims a model mismatch (#156)", () => {
    const sonnet = { advisedPick: "sonnet" };
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3), task(4)], {
        1: [
          row("plan", { s: sonnet }),
          row("agent", { actualModel: "claude-opus-4-1", s: { ...sonnet, pinDeferred: true } }),
        ],
        2: [
          row("plan", { s: sonnet }),
          row("agent", { actualModel: "claude-opus-4-1", s: { ...sonnet, forced: true } }),
        ],
        3: [
          row("plan", { s: sonnet }),
          row("agent", { actualModel: "claude-opus-4-1", s: { ...sonnet, fork: true } }),
        ],
        // a pinned agent whose call passed another model really ran off the advice
        4: [
          row("plan", { s: sonnet }),
          row("agent", { modelRequested: "opus", s: { ...sonnet, pinDeferred: true } }),
        ],
      }),
      "r",
    );
    expect(d.map((x) => x.advice?.model)).toEqual(["sonnet", "sonnet", "sonnet", "sonnet"]);
    expect(d.map((x) => x.ran?.tier)).toEqual(["opus", "opus", "opus", "opus"]);
    expect(d.map((x) => x.modelDiffers)).toEqual([false, false, false, true]);
  });

  it("a call that passed a model with no advice is never 'none' (#157)", () => {
    const [d] = swarmDecisions(
      dbOf([task(1)], { 1: [row("agent", { modelRequested: "opus", scores: "{}" })] }),
      "r",
    );
    expect(d?.follow).not.toBe("none");
    expect(d?.ran?.requestedModel).toBe("opus");
  });

  it("effort: env outranks the call; differs only when both are known", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3)], {
        1: [row("plan", { effort: "high" }), row("agent", { s: { passedEffort: "low" } })],
        2: [
          row("plan", { effort: "high" }),
          row("agent", { s: { passedEffort: "low", effortEnv: "max", bogus: 1 } }),
        ],
        3: [row("plan", { effort: "high" }), row("agent", { s: { passedEffort: "ludicrous" } })],
      }),
      "r",
    );
    expect(d[0]?.ran).toMatchObject({ effortEffective: "low", effortSource: "call" });
    expect(d[0]?.effortDiffers).toBe(true);
    expect(d[1]?.ran).toMatchObject({ effortEffective: "max", effortSource: "env" });
    expect(d[2]?.ran?.effortSource).toBe("agent-default");
    expect(d[2]?.effortDiffers).toBe(false);
  });

  it("ranged role carries its range and fallback", () => {
    const d = swarmDecisions(
      dbOf([task(1)], {
        1: [
          row("plan", {}),
          row("agent", {
            s: {
              ranged: true,
              fallbackPin: "sonnet",
              pinDeferred: true,
              pin: {
                status: "ranged",
                model: "sonnet",
                range: { floor: "haiku", ceiling: "opus" },
              },
            },
          }),
        ],
      }),
      "r",
    );
    expect(d[0]?.advice).toMatchObject({
      pin: "ranged",
      range: { floor: "haiku", ceiling: "opus", fallback: "sonnet" },
    });
  });

  it("redacts and clips text, keeps few reasons and no prompt, and fails open", () => {
    const secret = `title with ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jK5 ${"x".repeat(300)}`;
    const reasons = Array.from({ length: 9 }, (_, i) => ({
      feature: "f",
      weight: i,
      note: `r${i}`,
    }));
    const d = swarmDecisions(
      dbOf([task(1, secret)], {
        1: [row("plan", { inputHead: "RAW PROMPT", s: { complexityReasons: reasons } })],
      }),
      "r",
    );
    expect(d[0]?.title.length).toBeLessThanOrEqual(120);
    expect(d[0]?.title).not.toContain("aB3dE5gH");
    expect(d[0]?.advice?.reasons).toEqual(["r8", "r7", "r6", "r5"]);
    expect(JSON.stringify(d)).not.toContain("RAW PROMPT");
    const broken = {
      swarm: { tasks: () => [task(1)] },
      adjudicator: {
        forTask: () => {
          throw new Error("x");
        },
      },
    } as unknown as StorageAdapter;
    expect(swarmDecisions(broken, "r")[0]).toMatchObject({ follow: "none" });
    const none = {
      swarm: {
        tasks: () => {
          throw new Error("x");
        },
      },
    } as unknown as StorageAdapter;
    expect(swarmDecisions(none, "r")).toEqual([]);
  });
});

describe("swarm decision view: review findings", () => {
  it("a pinned or ranged-fallback agent dispatched with an explicit model is not 'pinned' (#152)", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2)], {
        1: [
          row("plan", { s: { advisedPick: "sonnet" } }),
          row("agent", {
            modelRequested: "haiku",
            actualModel: "claude-haiku-4-5",
            action: "respected",
            s: {
              advisedPick: "sonnet",
              pinDeferred: true,
              pin: { status: "pinned", model: "opus" },
            },
          }),
        ],
        2: [
          row("plan", {}),
          row("agent", {
            modelRequested: "haiku",
            action: "respected",
            s: {
              advisedPick: "sonnet",
              pinDeferred: true,
              pin: {
                status: "ranged",
                model: "sonnet",
                range: { floor: "haiku", ceiling: "opus" },
              },
              ranged: true,
              fallbackPin: "sonnet",
            },
          }),
        ],
      }),
      "r",
    );
    expect(d[0]?.follow).toBe("overrode");
    expect(d[1]?.follow).toBe("overrode");
  });

  it("rows without advisedPick fall back to the verdict tier and never read 'none' (#153)", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2)], {
        1: [
          row("plan", { tier: "sonnet" }),
          row("agent", { modelRequested: "sonnet", action: "followed" }),
        ],
        2: [
          row("plan", { tier: "opus" }),
          row("agent", { modelRequested: "haiku", action: "ignored" }),
        ],
      }),
      "r",
    );
    expect(d[0]?.follow).toBe("followed");
    expect(d[0]?.advice?.model).toBe("sonnet");
    expect(d[1]?.follow).toBe("overrode");
    expect(d[1]?.modelDiffers).toBe(true);
    const noAdvice = swarmDecisions(
      dbOf([task(1)], { 1: [row("agent", { modelRequested: "haiku", tier: null as never })] }),
      "r",
    );
    expect(noAdvice[0]?.follow).toBe("overrode");
  });

  it("an env effort level outside EFFORTS outranks the call, effective unknown (#154)", () => {
    const d = swarmDecisions(
      dbOf([task(1)], {
        1: [
          row("plan", { effort: "high" }),
          row("agent", {
            modelRequested: "sonnet",
            s: { passedEffort: "low", effortEnv: "other" },
          }),
        ],
      }),
      "r",
    );
    expect(d[0]?.ran?.effortSource).toBe("env");
    expect(d[0]?.ran?.effortEffective).toBeUndefined();
    expect(d[0]?.effortDiffers).toBe(false);
  });
});

describe("swarm decision view: review round 2", () => {
  it("FORCE / fork never take the call's model as the tier that ran (#161)", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3), task(4)], {
        1: [
          row("agent", {
            action: "advised",
            modelRequested: "haiku",
            modelFinal: "haiku",
            s: { forced: true },
          }),
        ],
        2: [
          row("agent", {
            action: "advised",
            modelRequested: "haiku",
            modelFinal: "haiku",
            s: { fork: true },
          }),
        ],
        3: [
          row("agent", {
            action: "respected",
            modelRequested: "haiku",
            modelFinal: "sonnet",
            s: { forced: true },
          }),
        ],
        4: [
          row("agent", {
            action: "advised",
            modelRequested: "haiku",
            actualModel: "opus",
            s: { forced: true },
          }),
        ],
      }),
      "r",
    );
    expect(d[0]?.ran?.tier).toBeUndefined();
    expect(d[1]?.ran?.tier).toBeUndefined();
    expect(d[2]?.ran?.tier).toBe("sonnet");
    expect(d[3]?.ran?.tier).toBe("opus");
  });

  it("a fork's passed effort is not effective and does not differ (#162)", () => {
    const d = swarmDecisions(
      dbOf([task(1)], {
        1: [
          row("plan", { effort: "high" }),
          row("agent", { s: { fork: true, passedEffort: "low" } }),
        ],
      }),
      "r",
    );
    expect(d[0]?.ran?.effortEffective).toBeUndefined();
    expect(d[0]?.ran?.effortSource).toBe("fork");
    expect(d[0]?.effortDiffers).toBe(false);
  });
});

describe("swarm decision view: agent-file effort and follow-through", () => {
  const plan = (effort = "high"): AdjudicationRow => row("plan", { effort });

  it("an agent file's effort is effective with source agent-file; call and env outrank it", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3), task(4)], {
        1: [plan(), row("agent", { s: { agentEffort: "medium" } })],
        2: [plan(), row("agent", { s: { agentEffort: "medium", passedEffort: "low" } })],
        3: [
          plan(),
          row("agent", { s: { agentEffort: "medium", passedEffort: "low", effortEnv: "max" } }),
        ],
        4: [plan(), row("agent", { s: { agentEffort: "medium", effortEnv: "other" } })],
      }),
      "r",
    );
    expect(d[0]?.ran).toMatchObject({ effortEffective: "medium", effortSource: "agent-file" });
    expect(d[0]?.effortDiffers).toBe(true);
    expect(d[1]?.ran).toMatchObject({ effortEffective: "low", effortSource: "call" });
    expect(d[2]?.ran).toMatchObject({ effortEffective: "max", effortSource: "env" });
    expect(d[3]?.ran?.effortSource).toBe("env");
    expect(d[3]?.ran?.effortEffective).toBeUndefined();
  });

  it("a fork ignores the agent file's effort", () => {
    const [d] = swarmDecisions(
      dbOf([task(1)], {
        1: [
          plan("high"),
          row("agent", { s: { fork: true, agentEffort: "low", actualEffort: "low" } }),
        ],
      }),
      "r",
    );
    expect(d?.ran?.effortEffective).toBeUndefined();
    expect(d?.ran?.effortActual).toBe("low");
    expect(d?.ran?.effortSource).toBe("fork");
    // a fork inherits the parent's effort: advice does not apply, so no mismatch even though
    // the level it ran at (low) differs from the advice (high)
    expect(d?.effortDiffers).toBe(false);
  });

  it("an unrecognised agent file level is ignored", () => {
    const [d] = swarmDecisions(
      dbOf([task(1)], { 1: [plan(), row("agent", { s: { agentEffort: "ludicrous" } })] }),
      "r",
    );
    expect(d?.ran?.effortSource).toBe("agent-default");
    expect(d?.ran?.effortEffective).toBeUndefined();
  });

  it("effortActual is read from scores and beats the intended level for effortDiffers", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3), task(4)], {
        // intended differs, actual matches the advice: no mismatch
        1: [plan("high"), row("agent", { s: { passedEffort: "low", actualEffort: "high" } })],
        // intended matches, actual differs: mismatch
        2: [plan("high"), row("agent", { s: { passedEffort: "high", actualEffort: "low" } })],
        // no actual: falls back to effective
        3: [plan("high"), row("agent", { s: { passedEffort: "low" } })],
        // invalid actual is dropped, effective is used
        4: [plan("high"), row("agent", { s: { passedEffort: "high", actualEffort: "bogus" } })],
      }),
      "r",
    );
    expect(d[0]?.ran).toMatchObject({ effortActual: "high", effortEffective: "low" });
    expect(d[0]?.effortDiffers).toBe(false);
    expect(d[1]?.ran?.effortActual).toBe("low");
    expect(d[1]?.effortDiffers).toBe(true);
    expect(d[2]?.ran?.effortActual).toBeUndefined();
    expect(d[2]?.effortDiffers).toBe(true);
    expect(d[3]?.ran?.effortActual).toBeUndefined();
    expect(d[3]?.effortDiffers).toBe(false);
  });

  it("effortDiffers needs advice: an actual level with no advised effort never differs", () => {
    const [d] = swarmDecisions(
      dbOf([task(1)], { 1: [row("agent", { effort: null as never, s: { actualEffort: "low" } })] }),
      "r",
    );
    expect(d?.ran?.effortActual).toBe("low");
    expect(d?.effortDiffers).toBe(false);
  });

  it("effortFollow comes from the dispatch row; anything else is absent", () => {
    const d = swarmDecisions(
      dbOf([task(1), task(2), task(3), task(4)], {
        1: [plan(), row("agent", { s: { effortFollow: "followed" } })],
        2: [plan(), row("agent", { s: { effortFollow: "ignored" } })],
        3: [plan(), row("agent", { s: { effortFollow: "maybe" } })],
        4: [plan()],
      }),
      "r",
    );
    expect(d.map((x) => x.effortFollow)).toEqual(["followed", "ignored", undefined, undefined]);
  });
});
