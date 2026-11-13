import { describe, expect, it } from "vitest";
import type { SwarmDecision } from "../../src/adjudicator/swarm-decisions.js";
import { effortLabel } from "../../src/ui/web/swarm/decision-helpers.js";

const dec = (p: Partial<SwarmDecision> & { ran?: unknown }): SwarmDecision =>
  ({
    title: "t",
    status: "done",
    follow: "followed",
    modelDiffers: false,
    effortDiffers: false,
    taskId: 1,
    ...p,
  }) as SwarmDecision;
// biome-ignore lint/suspicious/noExplicitAny: partial ran fixtures
const ran = (x: Record<string, unknown>): any => ({ effortSource: "agent-default", ...x });

describe("effortLabel with the recorded effort", () => {
  it("is undefined until dispatched", () => {
    expect(effortLabel(dec({}))).toBeUndefined();
  });
  it("shows the level the subagent actually ran at over the effective one", () => {
    const d = dec({ ran: ran({ effortEffective: "high", effortActual: "medium" }) });
    expect(effortLabel(d)).toBe("medium");
  });
  it("shows the agent file's level when nothing was passed", () => {
    const d = dec({ ran: ran({ effortEffective: "xhigh", effortSource: "agent-file" }) });
    expect(effortLabel(d)).toBe("xhigh");
  });
  it("marks an ignored effort advice, and only then", () => {
    const r = ran({ effortActual: "low" });
    expect(effortLabel(dec({ ran: r, effortFollow: "ignored" }))).toBe("low (ignored)");
    expect(effortLabel(dec({ ran: r, effortFollow: "followed" }))).toBe("low");
    expect(effortLabel(dec({ ran: r }))).toBe("low");
  });
  it("keeps the non-level labels", () => {
    expect(effortLabel(dec({ ran: ran({ effortSource: "env" }) }))).toBe("env override");
    expect(effortLabel(dec({ ran: ran({ effortSource: "fork" }) }))).toBe("session");
    expect(effortLabel(dec({ ran: ran({}) }))).toBe("default");
  });
});

describe("effortLabel with an applied effort", () => {
  it("marks a level apply mode set, unless it was ignored", () => {
    const r = ran({ effortSource: "applied", effortActual: "high" });
    expect(effortLabel(dec({ ran: r }))).toBe("high (applied)");
    expect(effortLabel(dec({ ran: r, effortFollow: "followed" }))).toBe("high (applied)");
    expect(effortLabel(dec({ ran: r, effortFollow: "ignored" }))).toBe("high (ignored)");
  });
  it("falls back to applied when no level is known", () => {
    expect(effortLabel(dec({ ran: ran({ effortSource: "applied" }) }))).toBe("applied");
  });
});
