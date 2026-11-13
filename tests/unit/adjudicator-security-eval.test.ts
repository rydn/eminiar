import { describe, expect, it, vi } from "vitest";
import {
  SECURITY_EVAL_CORE,
  SECURITY_EVAL_LOOKALIKES,
  SECURITY_EVAL_SET,
  type SecurityEvalItem,
} from "../../src/adjudicator/security/data/evalset.js";
import {
  formatSecurityEval,
  mergeSecurityItems,
  metricsOf,
  parseSecurityFixture,
  runSecurityEval,
  SECURITY_EVAL_META_KEY,
  SecurityEvalFixtureError,
  saveSecurityEval,
  securityEvalSetHash,
} from "../../src/adjudicator/security/eval.js";
import { SECURITY_EVAL_META_KEY as REPORT_KEY } from "../../src/adjudicator/security/report.js";
import { LEVELS } from "../../src/adjudicator/security/types.js";
import { ConfigSchema } from "../../src/config.js";

const sec = ConfigSchema.parse({}).adjudicator.security;

// --- the shape of the labelled set (T6 left this test out) ---------------------------------------

describe("security eval set shape", () => {
  it("has 60 items, 15 per level", () => {
    expect(SECURITY_EVAL_SET).toHaveLength(60);
    for (const l of LEVELS)
      expect(
        SECURITY_EVAL_SET.filter((i) => i.level === l),
        l,
      ).toHaveLength(15);
  });

  it("has unique, well-formed ids and a prefix per level", () => {
    const ids = SECURITY_EVAL_SET.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prefix = { low: "low-", medium: "med-", high: "high-", critical: "crit-" } as const;
    for (const i of SECURITY_EVAL_SET) {
      expect(i.id, i.id).toMatch(/^[a-z]+-\d{2}$/);
      expect(i.id.startsWith(prefix[i.level]), i.id).toBe(true);
      expect(i.text.trim().length, i.id).toBeGreaterThan(10);
      expect(i.family, i.id).toBeTruthy();
    }
  });

  it("uses only *.example.test / *.invalid hosts, never a real third-party host", () => {
    const FILE_EXT = new Set([
      "md",
      "ts",
      "tsx",
      "js",
      "mjs",
      "json",
      "sh",
      "yml",
      "yaml",
      "toml",
      "env",
      "txt",
      "py",
      "lock",
      "cfg",
      "ini",
      "csv",
      "log",
    ]);
    const hostOk = (h: string) => /(^|\.)example\.test$/i.test(h) || /\.invalid$/i.test(h);
    for (const i of SECURITY_EVAL_SET) {
      for (const m of i.text.matchAll(/\bhttps?:\/\/([^\s/:'"),;]+)/gi))
        expect(hostOk(m[1] as string), `${i.id}: ${m[1]}`).toBe(true);
      for (const m of i.text.matchAll(/\b(?:[a-z0-9-]+\.)+([a-z]{2,})\b/gi)) {
        const tld = (m[1] as string).toLowerCase();
        if (FILE_EXT.has(tld)) continue;
        expect(hostOk(m[0]), `${i.id}: ${m[0]}`).toBe(true);
      }
    }
  });

  it("carries no real-looking secret or token", () => {
    for (const i of SECURITY_EVAL_SET) {
      expect(i.text, i.id).not.toMatch(/\b(ghp|gho|sk|xox[bp]|AKIA)[-_A-Za-z0-9]{12,}/);
      expect(i.text, i.id).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });

  it("has look-alikes (benign items that borrow attack words) and a debatable minority", () => {
    expect(SECURITY_EVAL_LOOKALIKES.length).toBeGreaterThanOrEqual(3);
    for (const i of SECURITY_EVAL_LOOKALIKES) expect(["low", "medium"], i.id).toContain(i.level);
    const debatable = SECURITY_EVAL_SET.filter((i) => i.debatable);
    expect(debatable.length).toBeGreaterThan(0);
    expect(debatable.length).toBeLessThanOrEqual(12);
    expect(SECURITY_EVAL_CORE).toHaveLength(60 - debatable.length);
    for (const i of SECURITY_EVAL_CORE) expect(i.debatable, i.id).toBeFalsy();
  });

  it("gives every item a grant source", () => {
    for (const i of SECURITY_EVAL_SET)
      expect(Boolean(i.tools?.length || i.agentType || i.role), i.id).toBe(true);
  });
});

// --- metrics ----------------------------------------------------------------------------------

const P = (expected: string, got: string) =>
  ({ expected, got }) as { expected: (typeof LEVELS)[number]; got: (typeof LEVELS)[number] };

describe("metricsOf", () => {
  it("computes precision, recall, the matrix and the warn rates by hand", () => {
    const m = metricsOf([
      P("low", "low"),
      P("low", "high"), // false warn
      P("medium", "medium"),
      P("high", "high"),
      P("high", "medium"), // false negative
      P("critical", "critical"),
      P("high", "critical"), // over: critical precision drops
    ]);
    expect(m.n).toBe(7);
    expect(m.correct).toBe(4);
    expect(m.accuracy).toBeCloseTo(4 / 7, 3);
    expect(m.matrix.low.high).toBe(1);
    expect(m.matrix.high.medium).toBe(1);
    expect(m.matrix.high.critical).toBe(1);
    // HIGH: predicted 2 (low->high, high->high), tp 1, support 3
    expect(m.perLevel.high).toMatchObject({ support: 3, predicted: 2, tp: 1 });
    expect(m.perLevel.high.precision).toBe(0.5);
    expect(m.perLevel.high.recall).toBeCloseTo(1 / 3, 3);
    expect(m.perLevel.critical.precision).toBe(0.5);
    expect(m.perLevel.critical.recall).toBe(1);
    // positives are labelled HIGH+: 4 (3 high + 1 critical); one is rated MEDIUM
    expect(m.warn).toMatchObject({
      positives: 4,
      falseNegatives: 1,
      negatives: 3,
      falsePositives: 1,
    });
    expect(m.warn.fnr).toBe(0.25);
    expect(m.warn.highRecall).toBe(0.75);
    expect(m.warn.fpr).toBeCloseTo(1 / 3, 3);
    expect(m.warn.lowFalseWarn).toBe(0.5);
    expect(m.warn.criticalPrecision).toBe(0.5);
    expect(m.under).toBe(1);
    expect(m.over).toBe(2);
  });

  it("returns null rates, not zero, for empty denominators", () => {
    const m = metricsOf([]);
    expect(m.accuracy).toBeNull();
    expect(m.warn.fnr).toBeNull();
    expect(m.warn.highRecall).toBeNull();
    expect(m.perLevel.low.precision).toBeNull();
    const only = metricsOf([P("low", "low")]);
    expect(only.perLevel.critical.recall).toBeNull();
    expect(only.warn.criticalPrecision).toBeNull();
  });
});

// --- the run ----------------------------------------------------------------------------------

describe("runSecurityEval", () => {
  it("runs the heuristic over the whole set, split into core and debatable", async () => {
    const r = await runSecurityEval({ security: sec, now: () => 1_700_000_000_000 });
    const debatable = SECURITY_EVAL_SET.filter((i) => i.debatable).length;
    expect(r.v).toBe(1);
    expect(r.ts).toBe(1_700_000_000_000);
    expect(r.set).toMatchObject({ items: 60, core: 60 - debatable, debatable });
    expect(r.set.hash).toBe(securityEvalSetHash(SECURITY_EVAL_SET));
    expect(r.heuristic.all.n).toBe(60);
    expect(r.heuristic.core.n).toBe(60 - debatable);
    expect(r.heuristic.debatable.n).toBe(debatable);
    expect(r.heuristic.core.n + r.heuristic.debatable.n).toBe(r.heuristic.all.n);
    expect(r.jev).toBeUndefined();
    expect(r.acceptance.map((a) => a.name)).toContain("HIGH+ recall");
    // Every LOW item (including the security-review look-alikes) stays quiet.
    expect(r.heuristic.all.warn.lowFalseWarn).toBe(0);
  });

  it("reports mismatches by item id and never changes a label", async () => {
    const before = JSON.stringify(SECURITY_EVAL_SET);
    const r = await runSecurityEval({ security: sec });
    expect(JSON.stringify(SECURITY_EVAL_SET)).toBe(before);
    const byId = new Map(SECURITY_EVAL_SET.map((i) => [i.id, i]));
    for (const m of r.heuristic.mismatches) {
      const it = byId.get(m.id) as SecurityEvalItem;
      expect(it, m.id).toBeDefined();
      expect(m.expected).toBe(it.level);
      expect(m.got).not.toBe(it.level);
      expect(m.debatable).toBe(it.debatable === true);
    }
    expect(r.heuristic.mismatches.length).toBe(r.heuristic.all.n - r.heuristic.all.correct);
  });

  it("holds no task text or prompt anywhere in the report", async () => {
    const r = await runSecurityEval({ security: sec });
    const json = JSON.stringify(r);
    for (const i of SECURITY_EVAL_SET) {
      expect(json).not.toContain(i.text);
      expect(json).not.toContain(i.text.slice(0, 40));
    }
    expect(json).not.toMatch(/"(text|prompt|input)":/);
  });

  it("formats numbers, the matrix, mismatches and the design targets", async () => {
    const out = formatSecurityEval(await runSecurityEval({ security: sec }));
    expect(out).toContain("confusion matrix");
    expect(out).toContain("expected \\ got");
    expect(out).toContain("HIGH+ recall");
    expect(out).toContain("mismatches with the labels");
    expect(out).toContain("design targets");
    expect(out).toContain("labels and weights were not touched");
  });

  it("asks a Jev leg only when given one, blends its answer (raise only) and reports its cost", async () => {
    const asked: string[] = [];
    const hintsSeen: unknown[] = [];
    const provider = {
      id: "typesafe" as const,
      remote: true,
      dims: ["complexity", "tier"] as Array<"complexity" | "tier">,
      probe: async () => ({ ok: true, latencyMs: 1, detail: "ok" }),
      adjudicate: vi.fn(async (reqs: Array<{ key: string; text: string; hints?: unknown }>) => {
        for (const r of reqs) {
          asked.push(r.key);
          hintsSeen.push(r.hints);
        }
        return {
          answers: reqs.map((r) => ({
            key: r.key,
            // severity 4 / threat 1: the strongest answer: raise-only, never CRITICAL.
            security: { severity: { value: 4, confidence: 1 }, threats: { exfiltration: 1 } },
          })),
          usage: { inTok: 100, outTok: 10, costUsd: 0.001 },
          latencyMs: 5,
          model: "jev-test",
        };
      }),
    };
    const cfg = ConfigSchema.parse({
      adjudicator: {
        enabled: true,
        provider: "typesafe",
        security: { enabled: true, model: "provider" },
      },
    }).adjudicator;
    const small: SecurityEvalItem[] = SECURITY_EVAL_SET.slice(0, 12).map((i) => ({ ...i }));
    const r = await runSecurityEval({
      security: cfg.security,
      items: small,
      jev: {
        provider: provider as never,
        resolved: {
          enabled: true,
          configured: "typesafe",
          provider: "typesafe",
          remote: true,
          configuredRemote: true,
          keySource: "none",
          keyMasked: "",
          consent: true,
          local: false,
        } as never,
        config: cfg,
      },
    });
    expect(asked).toHaveLength(12);
    // hints carry tool ids and capability tags only
    for (const h of hintsSeen) expect(Object.keys(h as object).sort()).toEqual(["security"]);
    expect(r.jev?.model?.asked).toBe(12);
    expect(r.jev?.model?.answered).toBe(12);
    expect(r.jev?.model?.usd).not.toBeNull();
    expect(r.jev?.all.n).toBe(12);
    // raise only: never more UNDER-rated items than the heuristic, and no CRITICAL it did not reach
    expect(r.jev?.all.under).toBeLessThanOrEqual(r.heuristic.all.under);
    expect(r.jev?.all.perLevel.critical.predicted).toBe(
      r.heuristic.all.perLevel.critical.predicted,
    );
    expect(r.jev?.model?.raised).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(small[0]?.text);
  });
});

// --- saving and fixtures ------------------------------------------------------------------------

describe("saving and fixtures", () => {
  it("uses the meta key report.ts exports", () => {
    expect(SECURITY_EVAL_META_KEY).toBe(REPORT_KEY);
    expect(SECURITY_EVAL_META_KEY).toBe("adjudicator:security:eval:last");
  });

  it("saves the report under that key as JSON", async () => {
    const store = new Map<string, string>();
    const r = await runSecurityEval({ security: sec });
    saveSecurityEval({ metaSet: (k, v) => void store.set(k, v) }, r);
    expect([...store.keys()]).toEqual([REPORT_KEY]);
    expect(JSON.parse(store.get(REPORT_KEY) as string).set.items).toBe(60);
  });

  it("validates fixtures without echoing their text, and merges or replaces by id", () => {
    const good = [
      {
        id: "x-01",
        text: "Rename a variable in the parser module.",
        level: "low",
        tools: ["Read"],
      },
    ];
    expect(parseSecurityFixture(good)).toHaveLength(1);
    expect(parseSecurityFixture({ items: good })).toHaveLength(1);
    const secretText = "SECRET-FIXTURE-TEXT-DO-NOT-ECHO";
    for (const bad of [
      [],
      "nope",
      [{ id: "bad id", text: secretText, level: "low" }],
      [{ id: "a", text: secretText, level: "severe" }],
      [{ id: "a", text: "", level: "low" }],
      [{ id: "a", text: secretText, level: "low", tools: "Read" }],
      [{ id: "a", text: secretText, level: "low", autonomy: "wild" }],
      [good[0], good[0]],
    ]) {
      let msg = "";
      try {
        parseSecurityFixture(bad);
      } catch (err) {
        expect(err).toBeInstanceOf(SecurityEvalFixtureError);
        msg = (err as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain(secretText);
    }
    const extra = parseSecurityFixture([
      {
        id: "low-01",
        text: "Overridden item text for the first LOW id.",
        level: "medium",
        tools: ["Bash"],
      },
      ...good,
    ]);
    const merged = mergeSecurityItems(SECURITY_EVAL_SET, extra, "merge");
    expect(merged).toHaveLength(61);
    expect(merged.find((i) => i.id === "low-01")?.level).toBe("medium");
    expect(mergeSecurityItems(SECURITY_EVAL_SET, extra, "replace")).toHaveLength(2);
  });
});
