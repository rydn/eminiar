import { describe, expect, it } from "vitest";
import {
  atLeastRail,
  hasRunRisk,
  runRiskParts,
  runRiskTitle,
} from "../../src/ui/web/swarm/security-helpers.js";

const risk = (worst: "low" | "medium" | "high" | "critical" | null, c: number[]) => ({
  worst,
  counts: { low: c[0] ?? 0, medium: c[1] ?? 0, high: c[2] ?? 0, critical: c[3] ?? 0 },
});

describe("swarm security view helpers", () => {
  it("draws nothing for an absent risk", () => {
    expect(runRiskParts(undefined)).toEqual([]);
    expect(runRiskParts(null)).toEqual([]);
    expect(hasRunRisk(undefined)).toBe(false);
    expect(runRiskTitle(undefined)).toBe("no task assessed yet");
  });

  it("lists non-zero levels highest first with glyph and word", () => {
    const parts = runRiskParts(risk("critical", [5, 0, 2, 1]));
    expect(parts.map((p) => [p.level, p.n])).toEqual([
      ["critical", 1],
      ["high", 2],
      ["low", 5],
    ]);
    for (const p of parts) {
      expect(p.glyph.length).toBeGreaterThan(0);
      expect(p.word).toBe(p.level);
    }
  });

  it("treats a null worst as not yet assessed", () => {
    expect(hasRunRisk(risk(null, []))).toBe(false);
    expect(hasRunRisk(risk("low", [1]))).toBe(true);
  });

  it("titles the run with the worst level and counts", () => {
    expect(runRiskTitle(risk("high", [1, 0, 2]))).toBe(
      "worst high; 2 high, 1 low (latest assessment per task)",
    );
  });

  it("shows role badges in the rail from medium up", () => {
    expect(atLeastRail("low")).toBe(false);
    expect(atLeastRail("medium")).toBe(true);
    expect(atLeastRail("critical")).toBe(true);
    expect(atLeastRail(undefined)).toBe(false);
  });
});
