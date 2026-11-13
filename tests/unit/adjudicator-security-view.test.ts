import { describe, expect, it } from "vitest";
import {
  autonomyLine,
  badgeLabel,
  contributionLine,
  daySegments,
  evalFacts,
  evalTime,
  exposureGrid,
  isFloor,
  itemHead,
  itemMeta,
  LEVEL_INFO,
  LEVEL_ORDER,
  legBand,
  legChips,
  levelRank,
  levelShares,
  matrixView,
  modelState,
  parseTools,
  payloadActive,
  pct,
  remedyText,
  ruleBars,
  ruleLabel,
  securityActive,
  surfaceShares,
  tryItBody,
} from "../../src/ui/web/views/security-helpers.js";

describe("security gate", () => {
  it("mounts only when the overview says security is enabled", () => {
    expect(securityActive(undefined)).toBe(false);
    expect(securityActive({})).toBe(false);
    expect(securityActive({ security: { enabled: false } })).toBe(false);
    expect(securityActive({ security: { enabled: true } })).toBe(true);
  });
  it("reads the API's `active` field, not `enabled`", () => {
    expect(payloadActive({ active: true })).toBe(true);
    expect(payloadActive({ active: false })).toBe(false);
    expect(payloadActive({ enabled: true } as { active?: boolean })).toBe(false);
    expect(payloadActive(undefined)).toBe(false);
  });
});

describe("levels never rely on colour alone", () => {
  it("has a distinct glyph and word per level", () => {
    const glyphs = LEVEL_ORDER.map((l) => LEVEL_INFO[l].glyph);
    expect(new Set(glyphs).size).toBe(4);
    expect(glyphs).toEqual(["○", "◐", "▲", "⬢"]);
    expect(LEVEL_ORDER.map((l) => LEVEL_INFO[l].label)).toEqual(LEVEL_ORDER);
  });
  it("ranks by level and labels the score", () => {
    expect(levelRank("critical")).toBeGreaterThan(levelRank("high"));
    expect(levelRank("nope")).toBe(-1);
    expect(badgeLabel("high", 61.6)).toBe("high risk, score 62");
    expect(badgeLabel("low")).toBe("low risk");
  });
});

describe("legs", () => {
  it("bands strength and builds U S E chips in order", () => {
    expect(legBand(0)).toBe("none");
    expect(legBand(0.3)).toBe("weak");
    expect(legBand(0.6)).toBe("mid");
    expect(legBand(0.9)).toBe("strong");
    const c = legChips({
      U: { e: 0.9, kind: "task", from: "text:url" },
      S: { e: 0.4 },
      E: { e: 0 },
    });
    expect(c.map((x) => x.cap)).toEqual(["U", "S", "E"]);
    expect(c[0]?.pct).toBe(90);
    expect(c[0]?.title).toContain("text:url");
    expect(c[2]?.band).toBe("none");
  });
  it("tolerates missing legs", () => {
    expect(legChips(undefined).every((x) => x.pct === 0)).toBe(true);
  });
});

describe("rules, remedy", () => {
  it("labels rules and floors, with a fallback", () => {
    expect(ruleLabel("R1")).toContain("trifecta");
    expect(ruleLabel("C3")).toContain("secret");
    expect(ruleLabel("zz")).toBe("a security rule");
    expect(isFloor("H-R1")).toBe(true);
    expect(isFloor("C4")).toBe(true);
    expect(isFloor("R1")).toBe(false);
  });
  it("reads a remedy from a string or a view object; text only", () => {
    expect(remedyText(null)).toBeNull();
    expect(remedyText("  ")).toBeNull();
    expect(remedyText("drop WebFetch")).toBe("drop WebFetch");
    expect(remedyText({ line: "drop egress" })).toBe("drop egress");
    expect(remedyText("<img onerror=x>")).toBe("<img onerror=x>");
  });
});

describe("distribution", () => {
  it("stacks days and keeps the server's day order", () => {
    const d = daySegments([
      { day: "2026-11-01", low: 2, medium: 0, high: 1, critical: 0 },
      { day: "2026-11-02", low: 4, medium: 0, high: 0, critical: 0 },
    ]);
    expect(d.map((x) => x.day)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(d[1]?.total).toBe(4);
    expect(d[1]?.segs[0]?.share).toBe(1);
    expect(daySegments(undefined)).toEqual([]);
  });
  it("lists levels highest first and shares sum to 1", () => {
    const s = levelShares({ low: 6, medium: 2, high: 1, critical: 1 });
    expect(s.map((x) => x.level)).toEqual(["critical", "high", "medium", "low"]);
    expect(s.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1);
    expect(levelShares(undefined).every((x) => x.share === 0)).toBe(true);
  });
  it("orders surfaces by count then name and drops zeros", () => {
    expect(surfaceShares({ prompt: 2, agent: 5, plan: 0, mcp: 2 })).toEqual([
      { surface: "agent", n: 5 },
      { surface: "mcp", n: 2 },
      { surface: "prompt", n: 2 },
    ]);
  });
  it("bars rules relative to the most frequent and keeps the server order", () => {
    const b = ruleBars([
      { id: "R1", n: 4 },
      { id: "R2", n: 8 },
    ]);
    expect(b.map((x) => x.id)).toEqual(["R1", "R2"]);
    expect(b[1]?.share).toBe(1);
    expect(b[0]?.share).toBe(0.5);
  });
});

describe("heuristic vs model", () => {
  const matrix = {
    low: { low: 5, medium: 0, high: 0, critical: 0 },
    medium: { low: 0, medium: 3, high: 2, critical: 0 },
    high: { low: 0, medium: 0, high: 1, critical: 0 },
    critical: { low: 0, medium: 0, high: 0, critical: 1 },
  } as const;
  it("builds a 4x4 grid marking diagonal and raised cells", () => {
    const m = matrixView(matrix as never);
    expect(m.total).toBe(12);
    expect(m.max).toBe(5);
    const raised = m.rows[1]?.cells.find((c) => c.final === "high");
    expect(raised).toMatchObject({ n: 2, raised: true, diag: false });
    expect(m.rows[1]?.cells[1]?.diag).toBe(true);
  });
  it("tolerates a missing matrix", () => {
    expect(matrixView(undefined).total).toBe(0);
  });
  it("summarises the contribution, including no answers yet", () => {
    expect(
      contributionLine({
        heuristicOnly: 7,
        modelRaised: 2,
        modelLower: 1,
        modelAgreed: 5,
        raisedRate: 0.25,
      }),
    ).toContain("raised 2 (25%)");
    expect(
      contributionLine({
        heuristicOnly: 3,
        modelRaised: 0,
        modelLower: 0,
        modelAgreed: 0,
        raisedRate: null,
      }),
    ).toContain("has not answered");
    expect(pct(null)).toBe("—");
  });
  it("describes each model state", () => {
    const base = { setting: "provider" as const, provider: "typesafe", answered: 0 };
    expect(modelState({ ...base, status: "ready" }).tone).toBe("ok");
    expect(modelState({ ...base, status: "adjudicator-off" }).tone).toBe("warn");
    expect(modelState({ ...base, status: "unsupported" }).tone).toBe("warn");
    expect(modelState({ ...base, setting: "off", status: "off" }).label).toBe("heuristic only");
    expect(modelState(undefined).label).toBe("unknown");
  });
});

describe("items and the drawer", () => {
  it("builds the meta line from what is known", () => {
    expect(
      itemMeta({ surface: "agent", agentType: "explore", runId: "abcdef123456", taskId: 7 }),
    ).toBe("agent dispatch · explore · run abcdef12 · task #7");
    expect(itemMeta({ surface: "prompt", agentType: null, runId: null, taskId: null })).toBe(
      "prompt",
    );
  });
  it("keeps the head as text and caps it", () => {
    expect(itemHead(null)).toBe("(no text kept)");
    expect(itemHead("a\n\n b")).toBe("a b");
    expect(itemHead("x".repeat(200)).length).toBe(80);
  });
  it("groups exposures by capability and kind", () => {
    const g = exposureGrid([
      { cap: "E", e: 0.4, kind: "grant", from: "tool:WebFetch" },
      { cap: "E", e: 0.9, kind: "task", from: "text:egress" },
      { cap: "U", e: 0.7, kind: "latent", from: "tool:WebFetch" },
    ]);
    expect(g.map((r) => r.cap)).toEqual(["U", "E"]);
    const e = g[1];
    expect(e?.max).toBe(0.9);
    expect(e?.cells.map((c) => c.kind)).toEqual(["task", "grant", "latent", "taint"]);
    expect(e?.cells[0]?.from).toBe("text:egress");
    expect(exposureGrid(undefined)).toEqual([]);
    expect(autonomyLine(1.2, "autonomous")).toBe("autonomous · score scaled ×1.20");
  });
});

describe("try it", () => {
  it("parses tools, dedupes and caps", () => {
    expect(parseTools("Bash, WebFetch  Bash\nRead")).toEqual(["Bash", "WebFetch", "Read"]);
    expect(parseTools(Array.from({ length: 80 }, (_, i) => `t${i}`).join(",")).length).toBe(40);
  });
  it("makes no body without text and leaves default autonomy to the server", () => {
    expect(tryItBody({ text: "  ", tools: "Bash", autonomy: "default" })).toBeNull();
    expect(tryItBody({ text: "do it", tools: "", autonomy: "default" })).toEqual({ text: "do it" });
    expect(tryItBody({ text: "do it", tools: "Bash", autonomy: "autonomous" })).toEqual({
      text: "do it",
      tools: ["Bash"],
      autonomy: "autonomous",
    });
  });
});

describe("last eval", () => {
  it("prints top-level primitives only and formats rates", () => {
    const f = evalFacts({ accuracy: 0.8, n: 60, name: "heuristic", items: [1, 2], at: 5 });
    expect(f).toContainEqual(["accuracy", "80%"]);
    expect(f).toContainEqual(["n", "60"]);
    expect(f.some(([k]) => k === "items" || k === "at")).toBe(false);
    expect(evalFacts(null)).toEqual([]);
    expect(evalTime({ ts: 123 })).toBe(123);
    expect(evalTime({})).toBeNull();
  });
});
