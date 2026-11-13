/**
 * Pure helpers of the dashboard decision view (task #141): effort/model labels, the follow
 * sentence and the per-worker decision filter. No DOM.
 */
import { describe, expect, it } from "vitest";

import type { SwarmDecision } from "../../src/adjudicator/swarm-decisions.js";
import {
  adviceVerb,
  effortLabel,
  followText,
  notDispatchedLabel,
  ranModel,
  workerDecisions,
} from "../../src/ui/web/swarm/decision-helpers.js";

const dec = (o: Partial<SwarmDecision> & { taskId: number }): SwarmDecision =>
  ({
    title: "t",
    status: "active",
    follow: "none",
    modelDiffers: false,
    effortDiffers: false,
    ...o,
  }) as SwarmDecision;
// biome-ignore lint/suspicious/noExplicitAny: partial ran/advice fixtures
const any = (x: unknown): any => x;

describe("effortLabel / ranModel", () => {
  it("is undefined until dispatched", () => {
    expect(effortLabel(dec({ taskId: 1 }))).toBeUndefined();
    expect(ranModel(dec({ taskId: 1 }))).toBeUndefined();
  });
  it("shows the effective effort, or 'default' when the agent file's own ran", () => {
    expect(effortLabel(dec({ taskId: 1, ran: any({ effortEffective: "high" }) }))).toBe("high");
    expect(effortLabel(dec({ taskId: 1, ran: any({}) }))).toBe("default");
  });
  it("prefers the tier, then the final, then the requested model", () => {
    expect(ranModel(dec({ taskId: 1, ran: any({ tier: "haiku", finalModel: "x" }) }))).toBe(
      "haiku",
    );
    expect(ranModel(dec({ taskId: 1, ran: any({ finalModel: "f", requestedModel: "r" }) }))).toBe(
      "f",
    );
    expect(ranModel(dec({ taskId: 1, ran: any({ requestedModel: "r" }) }))).toBe("r");
  });
});

describe("followText", () => {
  const a = any({ model: "sonnet", reasons: [] });
  it("names the advised tier for followed and overrode", () => {
    expect(followText(dec({ taskId: 1, follow: "followed", advice: a }))).toContain("(sonnet)");
    expect(followText(dec({ taskId: 1, follow: "overrode", advice: a }))).toContain("overridden");
  });
  it("omits the tier when there is no advice", () => {
    expect(followText(dec({ taskId: 1, follow: "followed" }))).toBe(
      "Ran on the tier the adjudicator advised.",
    );
  });
  it("covers pinned, forced and fork", () => {
    expect(followText(dec({ taskId: 1, follow: "pinned" }))).toMatch(/pins its model/);
    expect(followText(dec({ taskId: 1, follow: "forced" }))).toMatch(/FORCE/);
    expect(followText(dec({ taskId: 1, follow: "fork" }))).toMatch(/fork/);
  });
  it("pinned does not say the advice named no model (#156)", () => {
    const t = followText(dec({ taskId: 1, follow: "pinned", advice: any({ model: "sonnet" }) }));
    expect(t).not.toMatch(/named no model/);
    expect(t).toMatch(/would have picked sonnet/);
  });
  it("never says no model was passed when the call passed one (#157)", () => {
    const ran = any({ requestedModel: "opus" });
    expect(followText(dec({ taskId: 1, ran }))).toBe(
      "The call passed opus; the adjudicator named no model.",
    );
    expect(followText(dec({ taskId: 1, ran, follow: "overrode" }))).toBe(
      "The call passed opus; the adjudicator named no model.",
    );
  });
  it("none: not dispatched yet vs the agent file's model ran", () => {
    expect(followText(dec({ taskId: 1, status: "pending" }))).toBe("Not dispatched yet.");
    expect(followText(dec({ taskId: 1, ran: any({}) }))).toMatch(/agent file's model/);
  });
});

describe("workerDecisions", () => {
  const all: Record<number, SwarmDecision> = {
    1: dec({ taskId: 1, agentId: "a1" }),
    2: dec({ taskId: 2, ran: any({ agentId: "a1" }) }),
    3: dec({ taskId: 3, agentId: "a2" }),
    4: dec({ taskId: 4 }), // unassigned, held by the worker's current task
  };
  it("matches by agent id (task or dispatch) newest task first", () => {
    expect(workerDecisions(all, "a1", null).map((d) => d.taskId)).toEqual([2, 1]);
  });
  it("adds the current task when it has no agent of its own", () => {
    expect(workerDecisions(all, "a1", 4).map((d) => d.taskId)).toEqual([4, 2, 1]);
    // a task owned by someone else is not borrowed
    expect(workerDecisions(all, "a1", 3).map((d) => d.taskId)).toEqual([2, 1]);
  });
  it("is empty without decisions", () => {
    expect(workerDecisions(undefined, "a1", 1)).toEqual([]);
    expect(workerDecisions({}, "a1", 1)).toEqual([]);
  });
});

describe("adviceVerb", () => {
  it("says 'would pick' when the pin, FORCE or fork kept the model (#156)", () => {
    expect(adviceVerb(dec({ taskId: 1, follow: "pinned" }))).toBe("would pick (pin kept)");
    expect(adviceVerb(dec({ taskId: 1, follow: "forced" }))).toBe("would pick (forced)");
    expect(adviceVerb(dec({ taskId: 1, follow: "fork" }))).toBe("would pick (fork)");
    expect(adviceVerb(dec({ taskId: 1, follow: "followed" }))).toBe("suggested");
    expect(adviceVerb(dec({ taskId: 1, follow: "overrode" }))).toBe("suggested");
  });
});

describe("review round 2 labels", () => {
  it("env source with unknown level reads 'env override', not 'default' (#163)", () => {
    expect(effortLabel(dec({ taskId: 1, ran: any({ effortSource: "env" }) }))).toBe("env override");
  });
  it("a claimed task with no agent row is not 'Not dispatched yet' (#164)", () => {
    const d = dec({ taskId: 1, status: "done", agentId: "agent-1" });
    expect(followText(d)).toMatch(/No dispatch recorded/);
    expect(notDispatchedLabel(d)).toBe("no dispatch recorded");
    expect(followText(dec({ taskId: 3, status: "done" }))).toMatch(/No dispatch recorded/);
    expect(followText(dec({ taskId: 2, status: "pending" }))).toBe("Not dispatched yet.");
  });
  it("forced / fork never fall back to the requested model; a pin shows its model", () => {
    const ran = any({ requestedModel: "haiku", finalModel: "haiku" });
    expect(ranModel(dec({ taskId: 1, follow: "forced", ran }))).toBeUndefined();
    expect(ranModel(dec({ taskId: 1, follow: "fork", ran }))).toBeUndefined();
    expect(
      ranModel(
        dec({ taskId: 1, follow: "pinned", ran: any({}), advice: any({ pinnedModel: "opus" }) }),
      ),
    ).toBe("opus");
  });
});
