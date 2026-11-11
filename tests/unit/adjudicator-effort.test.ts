/**
 * src/adjudicator/effort.ts (task #172): dominantEffort (mode, ties, unknowns), effortFollowOf
 * (every not-counted case, followed, ignored), rowEffort and withEffortScores (tolerance and
 * round trip), and swarm.ts still re-exporting the names that moved.
 */
import { describe, expect, it } from "vitest";
import {
  ACTUAL_EFFORT_FIELD,
  AGENT_EFFORT_FIELD,
  dominantEffort,
  EFFORT_APPLIED_FIELD,
  EFFORT_ENV_FIELD,
  EFFORT_ENV_OTHER,
  EFFORT_FOLLOW_FIELD,
  type EffortFacts,
  effortFactsRecorded,
  effortFollowOf,
  effortLevel,
  PASSED_EFFORT_FIELD,
  rowEffort,
  withEffortScores,
} from "../../src/adjudicator/effort.js";
import * as swarm from "../../src/adjudicator/swarm.js";

const calls = (...e: (string | null)[]) => e.map((effort) => ({ effort }));

describe("effortLevel", () => {
  it("normalises known levels and rejects everything else", () => {
    expect(effortLevel(" HIGH ")).toBe("high");
    expect(effortLevel("xhigh")).toBe("xhigh");
    for (const v of ["", "ultra", null, undefined, 3, {}, ["high"]]) {
      expect(effortLevel(v)).toBeUndefined();
    }
  });
});

describe("dominantEffort", () => {
  it("is undefined for no calls, null efforts and unknown levels", () => {
    expect(dominantEffort([])).toBeUndefined();
    expect(dominantEffort(calls(null, null))).toBeUndefined();
    expect(dominantEffort(calls("bogus", ""))).toBeUndefined();
  });
  it("takes the mode, ignoring nulls and unknowns", () => {
    expect(dominantEffort(calls("low", null, "high", "bogus", "high", "low", "high"))).toBe("high");
    expect(dominantEffort(calls("medium"))).toBe("medium");
  });
  it("normalises case and whitespace", () => {
    expect(dominantEffort(calls(" High", "HIGH", "low"))).toBe("high");
  });
  it("breaks a tie toward the level whose last occurrence is latest", () => {
    expect(dominantEffort(calls("low", "high"))).toBe("high");
    expect(dominantEffort(calls("high", "low"))).toBe("low");
    // low: 2 (last idx 3), high: 2 (last idx 2) -> low
    expect(dominantEffort(calls("low", "high", "high", "low"))).toBe("low");
    // high first-seen earlier but last later
    expect(dominantEffort(calls("high", "low", "low", "high"))).toBe("high");
    // a null at the end does not move the "last" of a level
    expect(dominantEffort(calls("low", "high", null))).toBe("high");
  });
  it("a strictly larger count beats a later tie-winner", () => {
    expect(dominantEffort(calls("high", "high", "low"))).toBe("high");
  });
});

describe("effortFollowOf", () => {
  const base: Required<Omit<EffortFacts, "passed" | "agent" | "applied">> = {
    advised: "high",
    ran: "high",
    env: false,
    fork: false,
    saturated: false,
  };
  it("followed when it ran at the advised level", () => {
    expect(effortFollowOf(base)).toBe("followed");
    expect(effortFollowOf({ ...base, advised: " HIGH " })).toBe("followed");
  });
  it("ignored when it ran at another level and the call did not pass the advised one", () => {
    expect(effortFollowOf({ ...base, ran: "low" })).toBe("ignored");
    expect(effortFollowOf({ ...base, ran: "low", passed: "medium" })).toBe("ignored");
    expect(effortFollowOf({ ...base, ran: "max" })).toBe("ignored");
  });
  it("followed when the call passed the advised level but a lower one ran", () => {
    expect(effortFollowOf({ ...base, ran: "medium", passed: "high" })).toBe("followed");
  });
  it("followed when the agent file sets the advised level and nothing was passed", () => {
    expect(effortFollowOf({ ...base, advised: "xhigh", agent: "xhigh", ran: "high" })).toBe(
      "followed",
    );
  });
  it("the passed level wins over the agent file's", () => {
    // passed differs from the advice, agent equals it: the call's level is what was set
    expect(
      effortFollowOf({ ...base, advised: "xhigh", passed: "low", agent: "xhigh", ran: "high" }),
    ).toBe("ignored");
    // passed equals the advice, agent differs: followed
    expect(
      effortFollowOf({ ...base, advised: "xhigh", passed: "xhigh", agent: "low", ran: "high" }),
    ).toBe("followed");
  });
  it("an agent file level that differs from the advice is ignored when the run differs too", () => {
    expect(effortFollowOf({ ...base, advised: "xhigh", agent: "low", ran: "high" })).toBe(
      "ignored",
    );
    // but it ran at the advised level anyway: followed
    expect(effortFollowOf({ ...base, advised: "xhigh", agent: "low", ran: "xhigh" })).toBe(
      "followed",
    );
  });
  it("an agent file level never rescues a not-counted dispatch", () => {
    const f = { ...base, advised: "xhigh", agent: "xhigh" as const, ran: "high" as const };
    expect(effortFollowOf({ ...f, fork: true })).toBeUndefined();
    expect(effortFollowOf({ ...f, env: true })).toBeUndefined();
    expect(effortFollowOf({ ...f, saturated: true })).toBeUndefined();
    const { ran: _r, ...noRan } = f;
    expect(effortFollowOf(noRan)).toBeUndefined();
  });
  describe("with an applied effort (the hook set it on the call)", () => {
    it("followed iff the run level equals the advice", () => {
      expect(effortFollowOf({ ...base, applied: "high", ran: "high" })).toBe("followed");
      expect(effortFollowOf({ ...base, applied: "high", ran: "low" })).toBe("ignored");
    });
    it("beats the passed shortcut: passed == advice but the run differs is ignored", () => {
      expect(effortFollowOf({ ...base, applied: "high", passed: "high", ran: "low" })).toBe(
        "ignored",
      );
    });
    it("beats the agent-file shortcut: agent == advice but the run differs is ignored", () => {
      expect(
        effortFollowOf({
          ...base,
          advised: "xhigh",
          applied: "xhigh",
          agent: "xhigh",
          ran: "high",
        }),
      ).toBe("ignored");
    });
    it("is followed when the run matches even if passed/agent differ from the advice", () => {
      expect(
        effortFollowOf({ ...base, applied: "high", passed: "low", agent: "low", ran: "high" }),
      ).toBe("followed");
    });
    it("the skips still win: fork, env, saturated, no run, no advice", () => {
      const f = { ...base, applied: "high" as const };
      expect(effortFollowOf({ ...f, fork: true })).toBeUndefined();
      expect(effortFollowOf({ ...f, env: true })).toBeUndefined();
      expect(effortFollowOf({ ...f, saturated: true })).toBeUndefined();
      const { ran: _r, ...noRan } = f;
      expect(effortFollowOf(noRan)).toBeUndefined();
      expect(effortFollowOf({ ...f, advised: null })).toBeUndefined();
    });
  });
  it("is not counted without usable advice", () => {
    for (const advised of [null, "", "ultra", "   "]) {
      expect(effortFollowOf({ ...base, advised })).toBeUndefined();
    }
    const { advised: _a, ...noAdvice } = base;
    expect(effortFollowOf(noAdvice)).toBeUndefined();
  });
  it("is not counted when the actual level is unknown", () => {
    const { ran: _r, ...noRan } = base;
    expect(effortFollowOf(noRan)).toBeUndefined();
    expect(effortFollowOf({ ...noRan, passed: "high" })).toBeUndefined();
  });
  it("is not counted for a fork, an env override or a saturated brief", () => {
    expect(effortFollowOf({ ...base, fork: true })).toBeUndefined();
    expect(effortFollowOf({ ...base, env: true })).toBeUndefined();
    expect(effortFollowOf({ ...base, saturated: true })).toBeUndefined();
    expect(effortFollowOf({ ...base, ran: "low", env: true })).toBeUndefined();
  });
});

describe("rowEffort", () => {
  const full = {
    [PASSED_EFFORT_FIELD]: "high",
    [EFFORT_ENV_FIELD]: "low",
    [AGENT_EFFORT_FIELD]: "medium",
    [ACTUAL_EFFORT_FIELD]: "max",
    [EFFORT_FOLLOW_FIELD]: "ignored",
  };
  it("reads every key from a string or an object", () => {
    const want = { passed: "high", env: "low", agent: "medium", actual: "max", follow: "ignored" };
    expect(rowEffort(JSON.stringify(full))).toEqual(want);
    expect(rowEffort(full)).toEqual(want);
  });
  it("reads effortApplied as a known level and drops anything else", () => {
    expect(rowEffort({ [EFFORT_APPLIED_FIELD]: " HIGH " }).applied).toBe("high");
    expect(rowEffort({ [EFFORT_APPLIED_FIELD]: "banana" }).applied).toBeUndefined();
    expect(rowEffort({ [EFFORT_APPLIED_FIELD]: 3 }).applied).toBeUndefined();
    expect(rowEffort({}).applied).toBeUndefined();
  });
  it("reads env as a known level or 'other'", () => {
    expect(rowEffort({ [EFFORT_ENV_FIELD]: "xhigh" }).env).toBe("xhigh");
    expect(rowEffort({ [EFFORT_ENV_FIELD]: EFFORT_ENV_OTHER }).env).toBe("other");
    expect(rowEffort({ [EFFORT_ENV_FIELD]: "banana" }).env).toBeUndefined();
    expect(rowEffort({ [EFFORT_ENV_FIELD]: 5 }).env).toBeUndefined();
  });
  it("drops unknown levels and bad follow values", () => {
    expect(
      rowEffort({
        [PASSED_EFFORT_FIELD]: "x",
        [AGENT_EFFORT_FIELD]: 1,
        [ACTUAL_EFFORT_FIELD]: null,
        [EFFORT_FOLLOW_FIELD]: "maybe",
      }),
    ).toEqual({});
  });
  it("never throws on garbage and reads it as empty", () => {
    for (const s of [
      null,
      undefined,
      "",
      "{not json",
      "[]",
      '["high"]',
      "7",
      '"high"',
      "null",
      {},
    ]) {
      expect(rowEffort(s as never)).toEqual({});
    }
  });
});

describe("withEffortScores", () => {
  it("treats null, undefined and '' as {}", () => {
    for (const s of [null, undefined, ""]) {
      expect(withEffortScores(s, { actual: "high", follow: "followed" })).toBe(
        '{"actualEffort":"high","effortFollow":"followed"}',
      );
      expect(withEffortScores(s, {})).toBe("{}");
    }
  });
  it("returns undefined for unparseable, array and non-object scores", () => {
    for (const s of ["{nope", "[]", "[1]", "7", '"x"', "null"]) {
      expect(withEffortScores(s, { actual: "low" })).toBeUndefined();
    }
    expect(withEffortScores([] as never, { actual: "low" })).toBeUndefined();
  });
  it("sets actualEffort only when actual is given", () => {
    const s = JSON.stringify({ actualEffort: "low", other: 1 });
    expect(JSON.parse(withEffortScores(s, { follow: "followed" }) as string)).toEqual({
      actualEffort: "low",
      other: 1,
      effortFollow: "followed",
    });
    expect(JSON.parse(withEffortScores(s, { actual: "max" }) as string).actualEffort).toBe("max");
  });
  it("deletes effortFollow when follow is undefined and keeps other keys", () => {
    const s = { effortFollow: "ignored", passedEffort: "high", n: 2 };
    expect(JSON.parse(withEffortScores(s, { actual: "low" }) as string)).toEqual({
      passedEffort: "high",
      n: 2,
      actualEffort: "low",
    });
  });
  it("does not mutate an object input and keeps key order (deterministic)", () => {
    const s = { b: 1, a: 2 };
    const a = withEffortScores(s, { actual: "high", follow: "followed" });
    expect(s).toEqual({ b: 1, a: 2 });
    expect(a).toBe('{"b":1,"a":2,"actualEffort":"high","effortFollow":"followed"}');
    expect(withEffortScores(s, { actual: "high", follow: "followed" })).toBe(a);
  });
  it("round-trips through rowEffort", () => {
    const out = withEffortScores(
      { passedEffort: "medium", effortEnv: "other" },
      { actual: "high", follow: "ignored" },
    );
    expect(rowEffort(out)).toEqual({
      passed: "medium",
      env: "other",
      actual: "high",
      follow: "ignored",
    });
    const cleared = withEffortScores(out, {});
    expect(rowEffort(cleared)).toEqual({ passed: "medium", env: "other", actual: "high" });
  });
});

describe("effortFactsRecorded", () => {
  it("is false for a row with none of the dispatch-fact keys", () => {
    expect(effortFactsRecorded({})).toBe(false);
    expect(effortFactsRecorded(rowEffort(null))).toBe(false);
    expect(effortFactsRecorded(rowEffort({ features: { intents: { implement: 1 } } }))).toBe(false);
  });

  it("actual and follow alone are not dispatch facts", () => {
    expect(effortFactsRecorded({ actual: "low" })).toBe(false);
    expect(
      effortFactsRecorded(
        rowEffort({ [ACTUAL_EFFORT_FIELD]: "low", [EFFORT_FOLLOW_FIELD]: "ignored" }),
      ),
    ).toBe(false);
  });

  it("is true when any one of applied, agent, passed or env is recorded", () => {
    expect(effortFactsRecorded({ applied: "high" })).toBe(true);
    expect(effortFactsRecorded({ agent: "low" })).toBe(true);
    expect(effortFactsRecorded({ passed: "medium" })).toBe(true);
    expect(effortFactsRecorded({ env: "max" })).toBe(true);
    expect(effortFactsRecorded({ env: EFFORT_ENV_OTHER })).toBe(true);
  });

  it("reads the scores keys through rowEffort", () => {
    for (const [k, v] of [
      [EFFORT_APPLIED_FIELD, "high"],
      [AGENT_EFFORT_FIELD, "low"],
      [PASSED_EFFORT_FIELD, "medium"],
      [EFFORT_ENV_FIELD, "xhigh"],
      [EFFORT_ENV_FIELD, EFFORT_ENV_OTHER],
    ] as const) {
      expect(effortFactsRecorded(rowEffort({ [k]: v, actualEffort: "low" }))).toBe(true);
    }
  });

  it("an unknown level in a key does not count as recorded", () => {
    expect(effortFactsRecorded(rowEffort({ [PASSED_EFFORT_FIELD]: "ultra" }))).toBe(false);
    expect(effortFactsRecorded(rowEffort({ [EFFORT_APPLIED_FIELD]: "" }))).toBe(false);
  });
});

describe("swarm.ts re-exports", () => {
  it("still exposes the names that moved to effort.ts", () => {
    expect(swarm.effortLevel).toBe(effortLevel);
    expect(swarm.PASSED_EFFORT_FIELD).toBe(PASSED_EFFORT_FIELD);
    expect(swarm.EFFORT_ENV_FIELD).toBe(EFFORT_ENV_FIELD);
    expect(swarm.EFFORT_ENV_OTHER).toBe(EFFORT_ENV_OTHER);
  });
});
