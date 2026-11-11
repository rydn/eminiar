import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adjudicate } from "../../src/adjudicator/engine.js";
import { complexityBucket, topIntent } from "../../src/adjudicator/heuristic.js";
import {
  AGENT_IDLE_MS,
  applyFeedback,
  applyFeedbackResult,
  biasFor,
  biasFromRows,
  bucketsOf,
  computeBias,
  DEFAULT_LEARNING,
  decayFactor,
  EFFORT_BACKFILL_LIMIT,
  EFFORT_BACKFILL_SCAN,
  FINAL_AFTER_MS,
  feedbackOf,
  matchDispatches,
  posterior,
  reconcile,
  recordSignal,
  stepMedian,
  taughtOf,
  withTaught,
} from "../../src/adjudicator/learn.js";
import {
  FALLBACK_MODEL,
  isPinned,
  keptModel,
  keptPin,
  pinDeferred,
  promptWindows,
  repriceAt,
  resolveBaseline,
  savingsReport,
  tierOf,
  withKeptModel,
} from "../../src/adjudicator/savings.js";
import type { AdjudicatorProvider } from "../../src/adjudicator/types.js";
import { ConfigSchema } from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import type { AdjudicationInput, ApiCallInput, ApiCallRow } from "../../src/storage/types.js";
import { costOfCall, resolvePrice } from "../../src/usage/pricing.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
let NOW = 0;
let seq = 0;
let db: SqliteAdapter;

function call(over: Partial<ApiCallInput> = {}): ApiCallInput {
  seq++;
  return {
    request_id: `r${seq}`,
    message_id: `m${seq}`,
    session_id: "S",
    agent_id: null,
    sidechain: 0,
    ts: NOW - 5 * MIN,
    model: "claude-opus-5-5",
    input_tokens: 1000,
    output_tokens: 500,
    cache_create_5m: 0,
    cache_create_1h: 0,
    cache_read: 0,
    thinking_tokens: 0,
    web_searches: 0,
    web_fetches: 0,
    service_tier: null,
    speed: null,
    stop_reason: null,
    prompt_id: null,
    git_branch: null,
    cwd: null,
    effort: null,
    version: null,
    entrypoint: null,
    ...over,
  };
}

function row(over: Partial<AdjudicationInput> = {}): number {
  return db.adjudicator.insert({
    surface: "agent",
    inputHash: "h",
    ts: NOW - 10 * MIN,
    sessionId: "S",
    complexity: 1.2,
    tier: "haiku",
    role: "coder",
    scores: JSON.stringify({ features: { intents: { implement: 1 } } }),
    ...over,
  });
}

/** Run `fn` with these process.env values set, then restore what was there. */
function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// 1000 in / 500 out at list prices.
const OPUS = 0.004 + 0.01; // opus-5-5: $4 / $20
const HAIKU = 0.001 + 0.0025; // haiku alias → 4.5: $1 / $5
const SONNET = 0.002 + 0.005; // sonnet-5-5: $2 / $10

/** A run with one task claimed by `agent`, the task moved to `status`. */
function swarmTask(status: "done" | "failed" | "blocked" | "active", agent = "A1", runId = "R1") {
  if (!db.swarm.runGet(runId))
    db.swarm.runCreate({
      id: runId,
      swarm: "feature",
      goal: "g",
      topology: "hierarchical",
      session_id: "S",
    });
  const t = db.swarm.taskAdd({ run_id: runId, title: "t", role: "coder" });
  db.swarm.taskClaim(t.id, agent);
  db.swarm.workerUpsert({
    run_id: runId,
    agent_id: agent,
    agent_type: "swarm-feature-coder",
    role: "coder",
    session_id: "S",
    task_id: t.id,
  });
  if (status !== "active") db.swarm.taskUpdate(t.id, { status });
  return t.id;
}

beforeEach(() => {
  NOW = Date.now();
  seq = 0;
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-learn-")), "eminiar.db"), {
    vectors: false,
  });
});
afterEach(() => db.close());

describe("savings: tiers, baseline, repricing", () => {
  it("maps model ids to tiers", () => {
    expect(tierOf("claude-opus-5-5[1m]")).toBe("opus");
    expect(tierOf("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("sonnet");
    expect(tierOf("claude-haiku-4-5")).toBe("haiku");
    expect(tierOf("claude-mythos-5-1")).toBe("fable");
    expect(tierOf("gpt-4o")).toBeUndefined();
    expect(tierOf(null)).toBeUndefined();
  });

  it("resolves the baseline: pinned, then session model at ts, then the fallback", () => {
    expect(isPinned("inherit")).toBe(false);
    expect(isPinned("")).toBe(false);
    expect(isPinned("opus")).toBe(true);
    db.apiCallsUpsert([
      call({ ts: NOW - 30 * MIN, model: "claude-sonnet-5-5" }),
      call({ ts: NOW - 20 * MIN, model: "claude-opus-5-5" }),
      call({ ts: NOW - 15 * MIN, model: "claude-haiku-4-5", sidechain: 1, agent_id: "X" }),
      call({ ts: NOW - 5 * MIN, model: "claude-haiku-4-5" }),
    ]);
    const ts = NOW - 10 * MIN;
    expect(resolveBaseline(db, { pinned: "sonnet", sessionId: "S", ts })).toEqual({
      model: "sonnet",
      source: "pinned",
    });
    // inherit is not pinned; the latest main-thread call before ts wins (sidechain and later ignored).
    expect(resolveBaseline(db, { pinned: "inherit", sessionId: "S", ts })).toEqual({
      model: "claude-opus-5-5",
      source: "session",
    });
    expect(resolveBaseline(db, { sessionId: "other", ts })).toEqual({
      model: FALLBACK_MODEL,
      source: "fallback",
    });
    expect(resolveBaseline(db, { ts })).toEqual({ model: FALLBACK_MODEL, source: "fallback" });
  });

  it("reads CLAUDE_CODE_SUBAGENT_MODEL only from the env it is given, never process.env (#124)", () => {
    db.apiCallsUpsert([call({ ts: NOW - 20 * MIN, model: "claude-opus-5-5" })]);
    const ts = NOW - 10 * MIN;
    const session = { model: "claude-opus-5-5", source: "session" };
    const env = { CLAUDE_CODE_SUBAGENT_MODEL: " sonnet " };
    withEnv({ CLAUDE_CODE_SUBAGENT_MODEL: "haiku", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0" }, () => {
      // No env given: no env baseline, though this process sets the model with FORCE off.
      expect(resolveBaseline(db, { sessionId: "S", ts })).toEqual(session);
      expect(resolveBaseline(undefined, { ts })).toEqual({
        model: FALLBACK_MODEL,
        source: "fallback",
      });
      expect(resolveBaseline(db, { sessionId: "S", ts, env: {} })).toEqual(session);
    });
    withEnv({ CLAUDE_CODE_SUBAGENT_MODEL: "haiku", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" }, () => {
      // Opted in: the given env's model; this process's FORCE flag is not read either.
      expect(resolveBaseline(db, { sessionId: "S", ts, env })).toEqual({
        model: "sonnet",
        source: "env",
      });
      // "inherit" or an empty value names no model.
      for (const m of ["inherit", "", "  "])
        expect(
          resolveBaseline(db, { sessionId: "S", ts, env: { CLAUDE_CODE_SUBAGENT_MODEL: m } }),
          m,
        ).toEqual(session);
      // A pin and a ranged fallback outrank it.
      expect(resolveBaseline(db, { pinned: "opus", sessionId: "S", ts, env })).toEqual({
        model: "opus",
        source: "pinned",
      });
      expect(
        resolveBaseline(db, { fallbackPin: "haiku", pinned: "opus", sessionId: "S", ts, env }),
      ).toEqual({ model: "haiku", source: "ranged" });
    });
  });

  it("reads FORCE in that env with Claude Code's on/off rule (#124)", () => {
    db.apiCallsUpsert([call({ ts: NOW - 20 * MIN, model: "claude-opus-5-5" })]);
    const q = { sessionId: "S", ts: NOW - 10 * MIN };
    const withForce = (v: string) => ({
      ...q,
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "haiku", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: v },
    });
    // On: Claude Code sets the model, so the env model is no baseline (the hook passes it as the pin).
    for (const v of ["1", "true", "TRUE", "yes", "On", " on "])
      expect(resolveBaseline(db, withForce(v)), v).toEqual({
        model: "claude-opus-5-5",
        source: "session",
      });
    // Off, empty or undocumented ("2"): the env model is the baseline.
    for (const v of ["0", "false", "no", "off", "OFF", "", "2"])
      expect(resolveBaseline(db, withForce(v)), v).toEqual({ model: "haiku", source: "env" });
  });

  it("reprices the same token vector through usage pricing, honouring overrides", () => {
    const c = {
      ...call({ cache_read: 10_000, cache_create_1h: 2000 }),
      cost_usd: null,
      priced: 0,
    } as ApiCallRow;
    const expected = costOfCall(c, resolvePrice("claude-sonnet-5-5") as never).total;
    expect(repriceAt([c], "claude-sonnet-5-5")).toBeCloseTo(expected, 12);
    expect(repriceAt([c], "sonnet")).toBeCloseTo(expected, 12);
    expect(repriceAt([c], "sonnet", { sonnet: { input: 100, output: 100 } })).toBeGreaterThan(
      expected,
    );
    expect(repriceAt([c], "unknown-model-9")).toBeNull();
  });

  it("splits main-thread calls into prompt windows", () => {
    const prompts = [
      { id: 1, ts: 100, sessionId: "S" },
      { id: 2, ts: 200, sessionId: "S" },
      { id: 3, ts: 150, sessionId: "T" },
    ];
    const mk = (ts: number, session = "S", sidechain = 0) =>
      ({
        ...call({ ts, session_id: session, sidechain }),
        cost_usd: null,
        priced: 0,
      }) as ApiCallRow;
    const w = promptWindows(prompts, [
      mk(50),
      mk(100),
      mk(150),
      mk(199),
      mk(200),
      mk(250),
      mk(160, "S", 1),
      mk(160, "T"),
    ]);
    expect(w.get(1)?.map((c) => c.ts)).toEqual([100, 150, 199]);
    expect(w.get(2)?.map((c) => c.ts)).toEqual([200, 250]);
    expect(w.get(3)?.map((c) => c.ts)).toEqual([160]);
  });
});

describe("reconcile: swarm outcomes", () => {
  it("maps task status to outcome and links the worker's tokens", () => {
    const done = swarmTask("done", "A1");
    const failed = swarmTask("failed", "A2");
    const blocked = swarmTask("blocked", "A3");
    db.apiCallsUpsert([
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" }),
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" }),
      call({ agent_id: "A2", sidechain: 1 }),
      call({ agent_id: "A3", sidechain: 1 }),
    ]);
    const a = row({ runId: "R1", taskId: done, action: "advised" });
    const b = row({ runId: "R1", taskId: failed });
    const c = row({ runId: "R1", taskId: blocked });
    const res = reconcile(db, { now: NOW });
    expect(res.scanned).toBe(3);
    expect(res.finalized).toBe(3);
    const ra = db.adjudicator.get(a);
    expect(ra).toMatchObject({
      outcome: "success",
      outcomeSource: "swarm",
      agentId: "A1",
      actualModel: "claude-haiku-4-5",
      actualTokens: 3000,
      final: true,
    });
    expect(ra?.actualCostUsd).toBeCloseTo(2 * HAIKU, 10);
    expect(ra?.outcomeTs).toBe(NOW);
    // Advised (not followed or applied) earns no credit.
    expect(ra?.savingsUsd ?? null).toBeNull();
    expect(db.adjudicator.get(b)).toMatchObject({ outcome: "failure", agentId: "A2", final: true });
    expect(db.adjudicator.get(c)).toMatchObject({ outcome: "failure", agentId: "A3", final: true });
  });

  it("waits on an active task, and abandons it once the run finishes", () => {
    const t = swarmTask("active");
    const id = row({ runId: "R1", taskId: t, surface: "plan" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "pending", final: false });
    db.swarm.runUpdate("R1", { status: "done" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "abandoned", final: true });
  });

  it("finalises after 24 h whatever is known", () => {
    const t = swarmTask("active");
    const swarmRow = row({ runId: "R1", taskId: t, ts: NOW - FINAL_AFTER_MS - MIN });
    const plain = row({ ts: NOW - FINAL_AFTER_MS - MIN });
    const tool = row({ surface: "mcp" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(swarmRow)).toMatchObject({
      outcome: "abandoned",
      outcomeSource: "timeout",
      final: true,
    });
    expect(db.adjudicator.get(plain)).toMatchObject({ outcome: "n/a", final: true });
    expect(db.adjudicator.get(tool)).toMatchObject({ outcome: "n/a", final: true });
  });

  it("leaves rows younger than two minutes alone", () => {
    const id = row({ surface: "mcp", ts: NOW - MIN });
    expect(reconcile(db, { now: NOW }).scanned).toBe(0);
    expect(db.adjudicator.get(id)?.final).toBe(false);
  });

  it("keeps a done task open while usage ingestion lags behind it", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ ts: NOW - HOUR })]); // ingestion stopped an hour ago
    const id = row({ runId: "R1", taskId: t });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "success", final: false });
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, ts: NOW + 1000 })]);
    reconcile(db, { now: NOW + 2000 });
    expect(db.adjudicator.get(id)).toMatchObject({
      outcome: "success",
      final: true,
      actualTokens: 1500,
    });
  });
});

describe("reconcile: best-effort agent linking", () => {
  it("links the first sidechain agent starting within 60 s and skips taken ones", () => {
    const ts = NOW - 20 * MIN;
    db.apiCallsUpsert([
      call({ agent_id: "late", sidechain: 1, ts: ts + 90_000 }),
      call({ agent_id: "early", sidechain: 1, ts: ts + 30_000, model: "claude-sonnet-5-5" }),
      call({ agent_id: "before", sidechain: 1, ts: ts - 1000 }),
    ]);
    // Both windows hold "early": the tier each dispatch asked for settles which one it is.
    const a = row({ ts, modelRequested: "sonnet" });
    const b = row({ ts: ts + 1, modelRequested: "haiku" });
    const res = reconcile(db, { now: NOW });
    expect(res.linked).toBe(1);
    expect(db.adjudicator.get(a)).toMatchObject({
      agentId: "early",
      outcomeSource: "link",
      actualModel: "claude-sonnet-5-5",
      actualTokens: 1500,
      // The agent has been idle for well under 30 min: still open for more calls / feedback.
      final: false,
    });
    // "late" starts 90 s after b: outside the window. "early" is taken.
    expect(db.adjudicator.get(b)?.agentId ?? null).toBeNull();
    // Once the linked agent is idle, the row closes with outcome n/a.
    reconcile(db, { now: ts + 30_000 + AGENT_IDLE_MS + MIN });
    expect(db.adjudicator.get(a)).toMatchObject({ outcome: "n/a", final: true });
  });

  /** Two Agent dispatches from one assistant message: rows 3 ms apart, agents in parallel. */
  function parallel(
    first: { model: string; tier?: string; at: number },
    second: { model: string; tier?: string; at: number },
    action: "applied" | "advised" = "applied",
  ) {
    const t0 = NOW - 60 * MIN;
    db.apiCallsUpsert([
      call({ ts: t0 - 5000 }),
      call({ agent_id: "ag-1", sidechain: 1, model: first.model, ts: t0 + first.at }),
      call({ agent_id: "ag-1", sidechain: 1, model: first.model, ts: t0 + first.at + 2000 }),
      call({ agent_id: "ag-2", sidechain: 1, model: second.model, ts: t0 + second.at }),
      call({ agent_id: "ag-2", sidechain: 1, model: second.model, ts: t0 + second.at + 2000 }),
    ]);
    const common = { action, baselineModel: "claude-opus-5-5" } as const;
    const r1 = row({
      ...common,
      ts: t0,
      tier: first.tier ?? null,
      modelFinal: action === "applied" ? (first.tier ?? null) : null,
      modelRequested: action === "advised" ? (first.tier ?? null) : null,
    });
    const r2 = row({
      ...common,
      ts: t0 + 3,
      tier: second.tier ?? null,
      modelFinal: action === "applied" ? (second.tier ?? null) : null,
      modelRequested: action === "advised" ? (second.tier ?? null) : null,
    });
    return { r1, r2 };
  }

  it("links parallel dispatches by the tier each asked for, not by who started first (probe p6)", () => {
    // ag-2 (opus) makes its first call before ag-1 (haiku); the haiku row must still get ag-1.
    const { r1, r2 } = parallel(
      { model: "claude-haiku-4-5", tier: "haiku", at: 1400 },
      { model: "claude-opus-5-5", tier: "opus", at: 900 },
    );
    expect(reconcile(db, { now: NOW }).linked).toBe(2);
    expect(db.adjudicator.get(r1)).toMatchObject({ agentId: "ag-1", outcomeSource: "link" });
    expect(db.adjudicator.get(r1)?.actualModel).toContain("haiku");
    expect(db.adjudicator.get(r1)?.savingsUsd).toBeCloseTo(2 * (OPUS - HAIKU), 10);
    expect(db.adjudicator.get(r2)).toMatchObject({ agentId: "ag-2" });
    expect(db.adjudicator.get(r2)?.actualModel).toContain("opus");
    expect(db.adjudicator.summary()).toMatchObject({ applyIneffective: 0, applyChecked: 2 });
  });

  it("leaves parallel dispatches of the same tier unlinked rather than guess", () => {
    const { r1, r2 } = parallel(
      { model: "claude-haiku-4-5", tier: "haiku", at: 1400 },
      { model: "claude-haiku-4-5", tier: "haiku", at: 900 },
    );
    expect(reconcile(db, { now: NOW }).linked).toBe(0);
    for (const id of [r1, r2])
      expect(db.adjudicator.get(id)).toMatchObject({ agentId: null, actualModel: null });
    expect(db.adjudicator.summary()).toMatchObject({ applyIneffective: 0, applyChecked: 0 });
    // Still unlinked at 24 h: the rows close as n/a without a guessed agent.
    reconcile(db, { now: NOW - 60 * MIN + FINAL_AFTER_MS + MIN });
    expect(db.adjudicator.get(r1)).toMatchObject({ agentId: null, final: true, outcome: "n/a" });
  });

  it("leaves dispatches without a requested tier unlinked when several share a window", () => {
    const { r1, r2 } = parallel(
      { model: "claude-haiku-4-5", at: 1400 },
      { model: "claude-opus-5-5", at: 900 },
      "advised",
    );
    expect(reconcile(db, { now: NOW }).linked).toBe(0);
    expect(db.adjudicator.get(r1)?.agentId ?? null).toBeNull();
    expect(db.adjudicator.get(r2)?.agentId ?? null).toBeNull();
  });

  it("still links an apply that did not take effect once the other dispatch is settled", () => {
    // Applied haiku, but the agent ran sonnet; the opus row's agent is unambiguous, which
    // leaves one row and one agent: a genuine "apply did not take effect".
    const { r1, r2 } = parallel(
      { model: "claude-sonnet-5-5", tier: "haiku", at: 1400 },
      { model: "claude-opus-5-5", tier: "opus", at: 900 },
    );
    expect(reconcile(db, { now: NOW }).linked).toBe(2);
    expect(db.adjudicator.get(r1)?.agentId).toBe("ag-1");
    expect(db.adjudicator.get(r2)?.agentId).toBe("ag-2");
    expect(db.adjudicator.summary()).toMatchObject({ applyIneffective: 1, applyChecked: 2 });
  });

  it("waits while ingestion has not reached the end of the link window", () => {
    const ts = NOW - 5 * MIN;
    db.apiCallsUpsert([call({ agent_id: "x", sidechain: 1, ts: ts + 1000 })]);
    const id = row({ ts });
    expect(reconcile(db, { now: NOW }).linked).toBe(0);
    db.apiCallsUpsert([call({ ts: ts + 2 * MIN })]);
    expect(reconcile(db, { now: NOW + 1000 }).linked).toBe(1);
    expect(db.adjudicator.get(id)?.agentId).toBe("x");
  });
});

describe("matchDispatches", () => {
  const W = 60_000;
  const r = (id: number, ts: number, want?: string, settled = true) => ({ id, ts, want, settled });
  const a = (id: string, first: number, tier?: string) => ({ id, first, tier });

  it("pairs a lone row and agent, whatever their tiers", () => {
    expect([...matchDispatches([r(1, 0, "haiku")], [a("x", 10, "opus")], W)]).toEqual([[1, "x"]]);
  });

  it("pairs by requested tier across a component and peels what is left", () => {
    const m = matchDispatches(
      [r(1, 0, "haiku"), r(2, 3, "opus"), r(3, 5, "sonnet")],
      [a("o", 900, "opus"), a("h", 1400, "haiku"), a("s2", 1500, "opus")],
      W,
    );
    // haiku→h is unique; opus has two candidates (o, s2), so rows 2 and 3 stay unpaired.
    expect([...m]).toEqual([[1, "h"]]);
  });

  it("does not pair when a rival row could own the agent", () => {
    // Row 2 asked for nothing in particular: it could have started the haiku agent.
    expect(matchDispatches([r(1, 0, "haiku"), r(2, 3)], [a("h", 10, "haiku")], W).size).toBe(0);
  });

  it("skips a component with an unsettled row and ignores agents outside every window", () => {
    expect(matchDispatches([r(1, 0, "haiku", false)], [a("h", 10, "haiku")], W).size).toBe(0);
    expect(matchDispatches([r(1, 0)], [a("x", -1), a("y", W + 1)], W).size).toBe(0);
    // Separate components are decided independently.
    const m = matchDispatches([r(1, 0), r(2, 10 * W)], [a("x", 5), a("y", 10 * W + 5)], W);
    expect([...m].sort()).toEqual([
      [1, "x"],
      [2, "y"],
    ]);
  });
});

describe("reconcile: prompt windows", () => {
  it("takes the main-thread calls up to the next prompt row", () => {
    const p1 = row({ surface: "prompt", ts: NOW - 30 * MIN, tier: "haiku" });
    const p2 = row({ surface: "prompt", ts: NOW - 20 * MIN });
    db.apiCallsUpsert([
      call({ ts: NOW - 29 * MIN }),
      call({ ts: NOW - 25 * MIN }),
      call({ ts: NOW - 24 * MIN, sidechain: 1, agent_id: "Z" }), // not main thread
      call({ ts: NOW - 19 * MIN, model: "claude-sonnet-5-5" }),
    ]);
    reconcile(db, { now: NOW });
    const r1 = db.adjudicator.get(p1);
    expect(r1).toMatchObject({
      outcome: "n/a",
      outcomeSource: "window",
      actualTokens: 3000,
      final: true,
    });
    expect(r1?.actualCostUsd).toBeCloseTo(2 * OPUS, 10);
    expect(r1?.savingsUsd ?? null).toBeNull();
    // The last prompt's window is still open until the next prompt or 24 h.
    expect(db.adjudicator.get(p2)).toMatchObject({ actualTokens: 1500, final: false });
    expect(db.adjudicator.get(p2)?.actualCostUsd).toBeCloseTo(SONNET, 10);
    // Prompts never teach.
    expect(db.adjudicator.biasAll()).toEqual([]);
  });

  it("backfills a missing baseline from the session, not the reconciling process's env (#124)", () => {
    db.apiCallsUpsert([call({ ts: NOW - 40 * MIN, model: "claude-opus-5-5" })]);
    const agent = row({ ts: NOW - 30 * MIN });
    const prompt = row({ surface: "prompt", ts: NOW - 20 * MIN });
    withEnv({ CLAUDE_CODE_SUBAGENT_MODEL: "haiku" }, () => reconcile(db, { now: NOW }));
    // Before #124 both took "haiku" from this process's CLAUDE_CODE_SUBAGENT_MODEL.
    expect(db.adjudicator.get(agent)?.baselineModel).toBe("claude-opus-5-5");
    expect(db.adjudicator.get(prompt)?.baselineModel).toBe("claude-opus-5-5");
  });
});

describe("reconcile: savings credit", () => {
  it("credits applied dispatches: baseline repriced minus actual", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const id = row({
      runId: "R1",
      taskId: t,
      action: "applied",
      modelFinal: "haiku",
      baselineModel: "claude-opus-5-5",
    });
    reconcile(db, { now: NOW });
    const r = db.adjudicator.get(id);
    expect(r?.baselineCostUsd).toBeCloseTo(OPUS, 10);
    expect(r?.actualCostUsd).toBeCloseTo(HAIKU, 10);
    expect(r?.savingsUsd).toBeCloseTo(OPUS - HAIKU, 10);
  });

  it("detects followed advice (requested = advice ≠ baseline) and credits it; ignored is not", () => {
    // Baseline from the session: main thread runs opus before the dispatch.
    db.apiCallsUpsert([call({ ts: NOW - 40 * MIN })]);
    const t1 = swarmTask("done", "F1");
    const t2 = swarmTask("done", "I1");
    db.apiCallsUpsert([
      call({ agent_id: "F1", sidechain: 1, model: "claude-haiku-4-5" }),
      call({ agent_id: "I1", sidechain: 1, model: "claude-sonnet-5-5" }),
    ]);
    const plan = row({
      surface: "plan",
      runId: "R1",
      taskId: t1,
      tier: "haiku",
      action: "advised",
    });
    const followed = row({
      runId: "R1",
      taskId: t1,
      parentId: plan,
      action: "advised",
      modelRequested: "haiku",
    });
    const ignored = row({
      runId: "R1",
      taskId: t2,
      action: "advised",
      tier: "haiku",
      modelRequested: "sonnet",
    });
    reconcile(db, { now: NOW });
    const f = db.adjudicator.get(followed);
    expect(f).toMatchObject({ action: "followed", baselineModel: "claude-opus-5-5" });
    expect(f?.savingsUsd).toBeCloseTo(OPUS - HAIKU, 10);
    const i = db.adjudicator.get(ignored);
    expect(i?.action).toBe("ignored");
    expect(i?.savingsUsd ?? null).toBeNull();
    // The plan row is advice only.
    expect(db.adjudicator.get(plan)?.savingsUsd ?? null).toBeNull();
  });

  it("credits nothing for a dispatch whose advice kept the agent's model pin (#68)", () => {
    db.apiCallsUpsert([call({ ts: NOW - 40 * MIN })]);
    const t = swarmTask("done", "P1");
    db.apiCallsUpsert([call({ agent_id: "P1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const plan = row({ surface: "plan", runId: "R1", taskId: t, tier: "haiku", action: "advised" });
    // The coordinator passed the plan's tier anyway, over a pin the advice kept.
    const pinned = row({
      runId: "R1",
      taskId: t,
      parentId: plan,
      action: "advised",
      modelRequested: "haiku",
      scores: JSON.stringify({ pin: { status: "pinned", model: "opus" }, pinDeferred: true }),
    });
    reconcile(db, { now: NOW });
    const r = db.adjudicator.get(pinned);
    expect(r?.action).toBe("advised");
    expect(r?.actualCostUsd).toBeCloseTo(HAIKU, 10);
    expect(r?.savingsUsd ?? null).toBeNull();
    expect(savingsReport(db).creditedRows).toBe(0);

    expect(pinDeferred({ scores: JSON.stringify({ pinDeferred: true }) })).toBe(true);
    expect(pinDeferred({ scores: JSON.stringify({ pin: { status: "pinned" } }) })).toBe(false);
    expect(pinDeferred({ scores: "not json" })).toBe(false);
    expect(pinDeferred({ scores: null })).toBe(false);
  });

  it("credits nothing under CLAUDE_CODE_SUBAGENT_MODEL_FORCE or for a fork (#76, #74)", () => {
    // The main session is on sonnet; the forced worker ran on haiku (FORCE's model).
    db.apiCallsUpsert([call({ ts: NOW - 40 * MIN, model: "claude-sonnet-5-5" })]);
    const t = swarmTask("done", "F1");
    db.apiCallsUpsert([call({ agent_id: "F1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const plan = row({ surface: "plan", runId: "R1", taskId: t, tier: "haiku", action: "advised" });
    const forced = row({
      runId: "R1",
      taskId: t,
      parentId: plan,
      action: "advised",
      tier: "haiku",
      modelRequested: "haiku",
      scores: JSON.stringify({ pin: { status: "unpinned" }, forced: true }),
    });
    reconcile(db, { now: NOW });
    const r = db.adjudicator.get(forced);
    expect(r?.action).toBe("advised");
    expect(r?.actualCostUsd).toBeCloseTo(HAIKU, 10);
    expect(r?.savingsUsd ?? null).toBeNull();
    expect(savingsReport(db).creditedRows).toBe(0);
    expect(
      savingsReport(db).assumptions.some((a) => a.includes("CLAUDE_CODE_SUBAGENT_MODEL_FORCE")),
    ).toBe(true);

    expect(keptModel({ scores: JSON.stringify({ forced: true }) })).toBe("force");
    expect(keptModel({ scores: JSON.stringify({ fork: true }) })).toBe("fork");
    expect(keptModel({ scores: JSON.stringify({ pinDeferred: true }) })).toBe("pin");
    expect(keptModel({ scores: JSON.stringify({ forced: false }) })).toBeUndefined();
    expect(keptModel({ scores: "[1]" })).toBeUndefined();
    // withKeptModel sets one flag, clears the others and keeps the rest
    expect(JSON.parse(withKeptModel('{"a":1,"pinDeferred":true}', "force", { pin: 2 })!)).toEqual({
      a: 1,
      pin: 2,
      forced: true,
    });
    expect(withKeptModel("[]", "pin")).toBeUndefined();
    expect(JSON.parse(withKeptModel(null, undefined)!)).toEqual({});
  });

  it("charges a redone failed attempt its full cost", () => {
    const t = swarmTask("active", "A1");
    db.apiCallsUpsert([
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5", ts: NOW - 9 * MIN }),
    ]);
    const first = row({
      runId: "R1",
      taskId: t,
      action: "applied",
      baselineModel: "claude-opus-5-5",
      ts: NOW - 10 * MIN,
    });
    // Attempt fails and is finalised before the redo exists.
    db.swarm.taskUpdate(t, { status: "failed" });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(first)?.final).toBe(true);
    expect(db.adjudicator.get(first)?.savingsUsd).toBeCloseTo(OPUS - HAIKU, 10);
    // Redo: a second dispatch for the same task by a new worker.
    db.swarm.taskUpdate(t, { status: "done", agent_id: "A2" });
    db.swarm.workerUpsert({
      run_id: "R1",
      agent_id: "A2",
      agent_type: "x",
      role: "coder",
      session_id: "S",
      task_id: t,
    });
    db.apiCallsUpsert([
      call({ agent_id: "A2", sidechain: 1, model: "claude-opus-5-5", ts: NOW - 2 * MIN }),
    ]);
    const second = row({
      runId: "R1",
      taskId: t,
      action: "advised",
      ts: NOW - 4 * MIN,
      baselineModel: "claude-opus-5-5",
    });
    reconcile(db, { now: NOW });
    const f = db.adjudicator.get(first);
    expect(f).toMatchObject({ outcome: "failure" });
    expect(f?.savingsUsd).toBeCloseTo(-HAIKU, 10);
    expect(db.adjudicator.get(second)).toMatchObject({
      outcome: "success",
      agentId: "A2",
      final: true,
    });
  });

  it("labels an earlier attempt reconciled after its redo as a redo failure", () => {
    const t = swarmTask("done", "A2");
    db.swarm.workerUpsert({
      run_id: "R1",
      agent_id: "A0",
      agent_type: "x",
      role: "coder",
      session_id: "S",
      task_id: t,
    });
    db.apiCallsUpsert([call({ agent_id: "A2", sidechain: 1 })]);
    const first = row({
      runId: "R1",
      taskId: t,
      ts: NOW - 30 * MIN,
      action: "applied",
      agentId: "A0",
    });
    const second = row({ runId: "R1", taskId: t, ts: NOW - 10 * MIN });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(first)).toMatchObject({
      outcome: "failure",
      outcomeSource: "redo",
      final: true,
    });
    expect(db.adjudicator.get(second)).toMatchObject({ outcome: "success", agentId: "A2" });
  });
});

describe("savingsReport", () => {
  it("nets credited savings against the adjudicator's spend and keeps potential separate", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    row({
      runId: "R1",
      taskId: t,
      action: "applied",
      baselineModel: "claude-opus-5-5",
      costUsd: 0.001,
    });
    // A prompt where haiku was advised but opus ran: potential only.
    row({ surface: "prompt", ts: NOW - 50 * MIN, tier: "haiku", costUsd: 0.0005 });
    row({ surface: "prompt", ts: NOW - 40 * MIN, tier: "opus" });
    db.apiCallsUpsert([call({ ts: NOW - 45 * MIN }), call({ ts: NOW - 35 * MIN })]);
    row({ surface: "mcp", costUsd: 0.0002 });
    reconcile(db, { now: NOW });
    const rep = savingsReport(db);
    expect(rep.usageAvailable).toBe(true);
    expect(rep.realisedUsd).toBeCloseTo(OPUS - HAIKU, 10);
    expect(rep.creditedRows).toBe(1);
    expect(rep.spendUsd).toBeCloseTo(0.0017, 10);
    expect(rep.netUsd).toBeCloseTo(OPUS - HAIKU - 0.0017, 10);
    expect(rep.potentialRows).toBe(1);
    expect(rep.potentialUsd).toBeCloseTo(OPUS - HAIKU, 10);
    expect(rep.tokensPerSuccessByTier.haiku).toMatchObject({
      tasks: 1,
      tokens: 1500,
      tokensPerTask: 1500,
    });
    expect(rep.matrix).toContainEqual({ suggested: "haiku", actual: "haiku", n: 1 });
    expect(rep.assumptions.length).toBeGreaterThanOrEqual(5);
    // The store's summary agrees on realised and net.
    const s = db.adjudicator.summary();
    expect(s.savingsUsd).toBeCloseTo(rep.realisedUsd, 10);
    expect(s.netUsd).toBeCloseTo(rep.netUsd, 10);
  });

  it("counts each swarm task once: its agent row, else its plan row (probe p11)", () => {
    // Three tasks, each with a plan row and an applied agent row, one haiku worker each.
    for (const i of [1, 2, 3]) {
      const t = swarmTask("done", `A${i}`);
      db.apiCallsUpsert([
        call({ agent_id: `A${i}`, sidechain: 1, model: "claude-haiku-4-5" }),
        call({ agent_id: `A${i}`, sidechain: 1, model: "claude-haiku-4-5", ts: NOW - 4 * MIN }),
      ]);
      row({ surface: "plan", runId: "R1", taskId: t, action: "advised", ts: NOW - 12 * MIN });
      row({ runId: "R1", taskId: t, action: "applied", modelFinal: "haiku", agentId: `A${i}` });
    }
    // A fourth task only planned (no Agent dispatch row): its plan row stands in for it.
    const t4 = swarmTask("done", "A4");
    db.apiCallsUpsert([call({ agent_id: "A4", sidechain: 1, model: "claude-sonnet-5-5" })]);
    row({ surface: "plan", runId: "R1", taskId: t4, tier: "haiku", ts: NOW - 12 * MIN });
    reconcile(db, { now: NOW });
    // Both rows of a dispatched task carry the worker's model; only one is counted.
    expect(
      db.adjudicator.list({ surface: "plan" }).rows.filter((r) => r.actualModel?.includes("haiku")),
    ).toHaveLength(3);
    const rep = savingsReport(db);
    expect(rep.matrix).toEqual([
      { suggested: "haiku", actual: "haiku", n: 3 },
      { suggested: "haiku", actual: "sonnet", n: 1 },
    ]);
    expect(rep.tokensPerSuccessByTier.haiku).toMatchObject({ tasks: 3, tokens: 9000 });
    expect(rep.tokensPerSuccessByTier.sonnet).toMatchObject({ tasks: 1, tokens: 1500 });
  });

  it("counts a dispatch that kept its pin apart from the matrix and the follow rate (#78)", () => {
    const pinScores = JSON.stringify({
      pin: { status: "pinned", model: "opus" },
      pinDeferred: true,
    });
    // P1 kept its opus pin and ran on it: out of the matrix, counted as kept.
    const t1 = swarmTask("done", "P1");
    db.apiCallsUpsert([call({ agent_id: "P1", sidechain: 1, model: "claude-opus-5-5" })]);
    const plan1 = row({
      surface: "plan",
      runId: "R1",
      taskId: t1,
      tier: "haiku",
      action: "advised",
    });
    row({ runId: "R1", taskId: t1, parentId: plan1, action: "advised", scores: pinScores });
    // P2's coordinator passed haiku over the kept pin: it stays in the matrix.
    const t2 = swarmTask("done", "P2");
    db.apiCallsUpsert([call({ agent_id: "P2", sidechain: 1, model: "claude-haiku-4-5" })]);
    const plan2 = row({
      surface: "plan",
      runId: "R1",
      taskId: t2,
      tier: "haiku",
      action: "advised",
    });
    row({
      runId: "R1",
      taskId: t2,
      parentId: plan2,
      action: "advised",
      modelRequested: "haiku",
      scores: pinScores,
    });
    // F1 ran under FORCE, K1 was a fork: both counted apart.
    const t3 = swarmTask("done", "F1");
    db.apiCallsUpsert([call({ agent_id: "F1", sidechain: 1, model: "claude-sonnet-5-5" })]);
    row({ runId: "R1", taskId: t3, tier: "haiku", action: "advised", scores: '{"forced":true}' });
    const t4 = swarmTask("done", "K1");
    db.apiCallsUpsert([call({ agent_id: "K1", sidechain: 1, model: "claude-sonnet-5-5" })]);
    row({ runId: "R1", taskId: t4, tier: "opus", action: "advised", scores: '{"fork":true}' });
    // A followed unpinned dispatch, so the follow rate has a numerator.
    const t5 = swarmTask("done", "U1");
    db.apiCallsUpsert([call({ agent_id: "U1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const plan5 = row({
      surface: "plan",
      runId: "R1",
      taskId: t5,
      tier: "haiku",
      action: "advised",
    });
    row({ runId: "R1", taskId: t5, parentId: plan5, action: "advised", modelRequested: "haiku" });
    reconcile(db, { now: NOW });

    const rep = savingsReport(db);
    expect(rep.matrix).toEqual([{ suggested: "haiku", actual: "haiku", n: 2 }]);
    expect(rep.keptModel).toEqual({ pin: 1, force: 1, fork: 1 });

    const s = db.adjudicator.summary();
    expect(s.byAction).toMatchObject({ advised: 7, followed: 1 });
    // The summary counts dispatches like the report (#81): P2 passed a model over its kept pin,
    // so it is no kept pin (it sits in the matrix).
    expect(s.keptModel).toEqual(rep.keptModel);
    // Dispatches: the agent rows P1, P2, F1, K1, U1 (each plan row has one). P1, P2, F1 and K1
    // carry a KeptModel flag (nothing to follow), so U1 followed of U1 = 1.
    expect(s.rates.follow).toBe(1);

    expect(
      keptPin({ scores: pinScores, modelRequested: null, actualModel: "claude-opus-5-5" }),
    ).toBe(true);
    expect(
      keptPin({ scores: pinScores, modelRequested: null, actualModel: "claude-haiku-4-5" }),
    ).toBe(false);
    expect(keptPin({ scores: pinScores, modelRequested: "haiku", actualModel: null })).toBe(false);
    expect(
      keptPin({
        scores: JSON.stringify({ pin: { status: "unknown" }, pinDeferred: true }),
        modelRequested: null,
        actualModel: "claude-sonnet-5-5",
      }),
    ).toBe(true);
  });

  for (const c of [
    {
      name: "kept pins",
      // coder pinned (opus), architect unpinned, reviewer pin unknown (ran on haiku)
      tasks: [
        { scores: { pin: { status: "pinned", model: "opus" }, pinDeferred: true }, ran: "opus" },
        { scores: {}, ran: "sonnet", requested: "haiku" },
        { scores: { pin: { status: "unknown" }, pinDeferred: true }, ran: "haiku" },
      ],
      kept: { pin: 2, force: 0, fork: 0 },
    },
    {
      name: "FORCE",
      tasks: [1, 2, 3].map(() => ({ scores: { forced: true }, ran: "sonnet" as const })),
      kept: { pin: 0, force: 3, fork: 0 },
    },
  ] as const)
    it(`summary.keptModel equals savingsReport.keptModel (${c.name}, #81)`, () => {
      const ID = {
        haiku: "claude-haiku-4-5",
        sonnet: "claude-sonnet-5-5",
        opus: "claude-opus-5-5",
      };
      c.tasks.forEach((t, i) => {
        const agent = `W${i + 1}`;
        const task = swarmTask("done", agent);
        db.apiCallsUpsert([call({ agent_id: agent, sidechain: 1, model: ID[t.ran] })]);
        // Plan and agent rows both carry the flag, as plan advice and onPreAgent store it.
        const scores = JSON.stringify(t.scores);
        const plan = row({ surface: "plan", runId: "R1", taskId: task, action: "advised", scores });
        row({
          runId: "R1",
          taskId: task,
          parentId: plan,
          action: "advised",
          scores,
          modelRequested: "requested" in t ? t.requested : null,
        });
      });
      // A fork outside the swarm that has not run yet: neither report counts it.
      row({ action: "advised", scores: '{"fork":true}' });
      reconcile(db, { now: NOW });
      const rep = savingsReport(db);
      const s = db.adjudicator.summary();
      expect(rep.keptModel).toEqual(c.kept);
      expect(s.keptModel).toEqual(rep.keptModel);
    });

  it("says so when no usage is recorded", () => {
    row({ surface: "mcp" });
    const rep = savingsReport(db);
    expect(rep.usageAvailable).toBe(false);
    expect(rep.assumptions.some((a) => a.includes("No API calls"))).toBe(true);
  });
});

describe("learning: bias math", () => {
  const L = { ...DEFAULT_LEARNING };

  it("uses a Beta(2,2) posterior and halfLife decay", () => {
    expect(posterior(0, 0)).toBe(0.5);
    expect(posterior(10, 10)).toBeCloseTo(12 / 14, 12);
    expect(decayFactor(50) ** 50).toBeCloseTo(0.5, 12);
    expect(decayFactor(0)).toBe(1);
  });

  it("is zero below minSamples, clamps to ±maxBias, and penalises cost", () => {
    expect(computeBias({ n: 4, s: 4, costMedian: null }, null, L)).toBe(0);
    // n=5 all good: 7/9 − 0.8
    expect(computeBias({ n: 5, s: 5, costMedian: null }, null, L)).toBeCloseTo(7 / 9 - 0.8, 12);
    // n=20 all failures: 2/24 − 0.8 → clamped at −0.3
    expect(computeBias({ n: 20, s: 0, costMedian: null }, null, L)).toBe(-0.3);
    // n=1000 all good: 1002/1004 − 0.8 ≈ 0.198 → clamped at +0.1
    expect(computeBias({ n: 1000, s: 1000, costMedian: null }, null, { ...L, maxBias: 0.1 })).toBe(
      0.1,
    );
    // Twice the bucket's median cost costs costWeight · log2(2).
    const base = computeBias({ n: 10, s: 10, costMedian: 1 }, 1, L);
    const pricey = computeBias({ n: 10, s: 10, costMedian: 2 }, 1, L);
    expect(base - pricey).toBeCloseTo(L.costWeight, 12);
  });

  it("steps the cost median by at most ×1.2 and never past the sample", () => {
    expect(stepMedian(null, 3)).toBe(3);
    expect(stepMedian(1, 10)).toBeCloseTo(1.2, 12);
    expect(stepMedian(1, 1.1)).toBe(1.1);
    expect(stepMedian(1, 0.1)).toBeCloseTo(1 / 1.2, 12);
  });

  it("records decayed counts and exposes biases keyed by dimension once n ≥ minSamples", () => {
    for (let i = 0; i < 4; i++)
      recordSignal(db, { dimension: "tier", bucket: "1", option: "haiku", success: false }, L, NOW);
    expect(biasFor(db, L, { complexity: 1.2, intent: "implement" })).toEqual({});
    recordSignal(db, { dimension: "tier", bucket: "1", option: "haiku", success: false }, L, NOW);
    const [r] = db.adjudicator.biasAll();
    const d = decayFactor(L.halfLife);
    // Five updates: n = 1 + d + d² + d³ + d⁴.
    expect(r?.n).toBeCloseTo(1 + d + d ** 2 + d ** 3 + d ** 4, 12);
    expect(r?.f).toBeCloseTo(r?.n ?? 0, 12);
    expect(r?.s).toBe(0);
    expect(r?.n).toBeLessThan(5);
    // Decay keeps n under the raw count; minSamples needs a sixth signal here.
    recordSignal(db, { dimension: "tier", bucket: "1", option: "haiku", success: false }, L, NOW);
    const bias = biasFor(db, L, { complexity: 1.2, intent: "implement" });
    expect(bias["tier:haiku"]).toBeLessThan(0);
    expect(bias["tier:haiku"]).toBeGreaterThanOrEqual(-L.maxBias);
    // Other complexity buckets and the role dimension are untouched.
    expect(biasFor(db, L, { complexity: 3 })).toEqual({});
    expect(biasFor(db, { enabled: false }, { complexity: 1.2 })).toEqual({});
    expect(
      biasFromRows(db.adjudicator.biasAll(), { ...L, enabled: false }, { complexity: 1.2 }),
    ).toEqual({});
  });

  it("does nothing when learning is disabled", () => {
    recordSignal(
      db,
      { dimension: "tier", bucket: "1", option: "haiku", success: true },
      { ...L, enabled: false },
    );
    expect(db.adjudicator.biasAll()).toEqual([]);
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    row({ runId: "R1", taskId: t });
    reconcile(db, { now: NOW, config: { adjudicator: { learning: { enabled: false } } } });
    expect(db.adjudicator.biasAll()).toEqual([]);
  });
});

describe("learning: reconcile signals and idempotency", () => {
  it("credits the tier that actually ran and the task's role, once", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-sonnet-5-5" })]);
    // Advised haiku, but sonnet ran: sonnet gets the credit.
    row({ surface: "plan", runId: "R1", taskId: t, tier: "haiku" });
    row({ runId: "R1", taskId: t, tier: "haiku" });
    const first = reconcile(db, { now: NOW });
    expect(first.learned).toBe(2);
    const bias = db.adjudicator.biasAll();
    expect(bias.map((b) => `${b.dimension}/${b.bucket}/${b.option}/${b.s}`).sort()).toEqual([
      "role/implement/coder/1",
      "tier/1/sonnet/1",
    ]);
    expect(bias.find((b) => b.dimension === "tier")?.costMedian).toBeCloseTo(SONNET, 10);
    // Re-running changes nothing.
    const again = reconcile(db, { now: NOW + 1000 });
    expect(again).toMatchObject({ scanned: 0, updated: 0, learned: 0 });
    expect(db.adjudicator.biasAll()).toEqual(bias);
  });

  it("re-running over still-pending rows writes nothing new", () => {
    const t = swarmTask("active");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1 })]);
    row({ runId: "R1", taskId: t, action: "applied" });
    const a = reconcile(db, { now: NOW });
    expect(a.updated).toBe(1);
    const b = reconcile(db, { now: NOW + 1000 });
    expect(b).toMatchObject({ scanned: 1, updated: 0, finalized: 0 });
  });
});

describe("feedback", () => {
  it("maps good / too_small / too_big to outcomes and bias signals", () => {
    const L = { ...DEFAULT_LEARNING, minSamples: 0 };
    const good = row({ surface: "mcp", tier: "sonnet", role: "reviewer" });
    const small = row({ surface: "mcp", tier: "haiku" });
    const big = row({ surface: "mcp", tier: "opus", actualModel: "claude-opus-5-5" });

    expect(applyFeedback(db, good, "good", { learning: L, now: NOW })).toMatchObject({
      outcome: "success",
      outcomeSource: "feedback:good",
      outcomeTs: NOW,
      final: true,
    });
    expect(applyFeedback(db, small, "too_small", { learning: L })?.outcome).toBe("failure");
    expect(
      applyFeedback(db, big, "too_big", { learning: L, tiers: ["haiku", "sonnet", "opus"] })
        ?.outcome,
    ).toBe("success");
    expect(applyFeedback(db, 9999, "good")).toBeUndefined();

    const rows = db.adjudicator.biasAll();
    const get = (dim: string, opt: string) =>
      rows.find((r) => r.dimension === dim && r.option === opt);
    // good + too_big's lower tier: two decayed successes.
    const d = decayFactor(L.halfLife);
    expect(get("tier", "sonnet")).toMatchObject({ bucket: "1", f: 0 });
    expect(get("tier", "sonnet")?.n).toBeCloseTo(1 + d, 12);
    expect(get("tier", "sonnet")?.s).toBeCloseTo(1 + d, 12);
    expect(get("tier", "haiku")).toMatchObject({ n: 1, s: 0, f: 1 });
    expect(get("tier", "opus")).toMatchObject({ n: 1, s: 1 });
    expect(get("role", "reviewer")).toMatchObject({ bucket: "implement", s: 1 });
  });

  it("records the outcome but no bias with learning off", () => {
    const id = row({ surface: "mcp" });
    expect(applyFeedback(db, id, "good", { learning: { enabled: false } })?.outcome).toBe(
      "success",
    );
    expect(db.adjudicator.biasAll()).toEqual([]);
  });
});

describe("bias bucket: taught and looked up on the heuristic complexity (task #40)", () => {
  it("bucketsOf prefers scores.heuristicComplexity and falls back to the row complexity", () => {
    const intents = { features: { intents: { implement: 1 } } };
    const withHeuristic = JSON.stringify({ ...intents, heuristicComplexity: 1.74 });
    expect(bucketsOf({ complexity: 2.74, scores: withHeuristic }).tier).toBe("2");
    expect(bucketsOf({ complexity: 2.74, scores: JSON.stringify(intents) }).tier).toBe("3");
    expect(bucketsOf({ complexity: 2.74, scores: "not json" }).tier).toBe("3");
    expect(bucketsOf({ complexity: null, scores: null }).tier).toBeUndefined();
  });

  it("a provider that moves complexity across a bucket: feedback lands where the next lookup reads", async () => {
    const cfg = ConfigSchema.parse({
      adjudicator: {
        enabled: true,
        provider: "openai-compatible",
        openai: { preset: "ollama" },
        learning: { minSamples: 0 },
      },
    }).adjudicator;
    const provider: AdjudicatorProvider = {
      id: "openai-compatible",
      remote: false,
      dims: ["complexity", "tier"],
      async adjudicate(reqs) {
        return {
          answers: reqs.map((r) => ({ key: r.key, complexity: { value: 3.5, confidence: 0.95 } })),
          usage: { inTok: 1, outTok: 1, costUsd: 0 },
          latencyMs: 5,
          model: "m",
        };
      },
      async probe() {
        return { ok: true, latencyMs: 1, detail: "" };
      },
    };
    const text = "add a --json flag to the status command and update its test";
    let heuristic = Number.NaN;
    const [a] = await adjudicate([{ key: "a", surface: "mcp", text }], {
      config: cfg,
      store: db.adjudicator,
      provider,
      context: "server",
      bias: (_req, f, h) => {
        heuristic = h.complexity;
        return biasFor(db, cfg.learning, { complexity: h.complexity, intent: topIntent(f) });
      },
    });
    expect(a?.verdict.source).toBe("blend");
    // The provider pushed the blended complexity into another bucket than the heuristic's.
    expect(complexityBucket(a?.verdict.complexity as number)).not.toBe(complexityBucket(heuristic));
    expect(a?.verdict.heuristicComplexity).toBe(heuristic);
    const id = a?.rowId as number;
    const stored = db.adjudicator.get(id);
    expect(stored && bucketsOf(stored).tier).toBe(String(complexityBucket(heuristic)));

    for (let i = 0; i < 6; i++) applyFeedback(db, id, "too_small", { learning: cfg.learning });
    const taught = db.adjudicator.biasAll().filter((r) => r.dimension === "tier");
    expect(taught.map((r) => r.bucket)).toEqual([String(complexityBucket(heuristic))]);
    const looked = biasFor(db, cfg.learning, { complexity: heuristic, intent: "none" });
    expect(looked[`tier:${a?.verdict.tier.choice}`]).toBeLessThan(0);
  });
});

describe("feedback is idempotent per decision (task #39)", () => {
  const L = { ...DEFAULT_LEARNING, minSamples: 0 };
  const opt = (dim: string, option: string) =>
    db.adjudicator.biasAll().find((b) => b.dimension === dim && b.option === option);

  it("the same feedback six times teaches once (probe p3: n stayed 5.8, bias hit −0.30)", () => {
    const id = row({ surface: "mcp", tier: "sonnet", complexity: 1.74 });
    const first = applyFeedbackResult(db, id, "too_small", { learning: L, now: NOW });
    expect(first?.learned).toBe(1);
    const bias = db.adjudicator.biasAll();
    for (let i = 1; i < 6; i++)
      expect(applyFeedbackResult(db, id, "too_small", { learning: L, now: NOW + i })?.learned).toBe(
        0,
      );
    expect(db.adjudicator.biasAll()).toEqual(bias);
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 0, f: 1 });
    // The first feedback's time is kept.
    expect(db.adjudicator.get(id)).toMatchObject({
      outcomeSource: "feedback:too_small",
      outcomeTs: NOW,
    });
  });

  it("a different feedback replaces the earlier one's lesson instead of adding to it", () => {
    const id = row({ surface: "mcp", tier: "sonnet", role: "reviewer" });
    const tiers = ["haiku", "sonnet", "opus"];
    applyFeedback(db, id, "good", { learning: L, tiers });
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 1, f: 0 });
    expect(opt("role", "reviewer")).toMatchObject({ n: 1, s: 1 });

    // good → too_small: the tier success is relabelled a failure, the role success retracted.
    applyFeedback(db, id, "too_small", { learning: L, tiers });
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 0, f: 1 });
    expect(opt("role", "reviewer")).toMatchObject({ n: 0, s: 0, f: 0, bias: 0 });

    // too_small → too_big: sonnet back to a success, plus one success for haiku.
    applyFeedback(db, id, "too_big", { learning: L, tiers });
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 1, f: 0 });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 1 });

    // too_big → good: the lower-tier success goes, the role success comes back.
    applyFeedback(db, id, "good", { learning: L, tiers });
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 1, f: 0 });
    expect(opt("tier", "haiku")).toMatchObject({ n: 0, s: 0 });
    expect(opt("role", "reviewer")).toMatchObject({ n: 1, s: 1 });
    expect(db.adjudicator.get(id)?.outcomeSource).toBe("feedback:good");
  });

  it("does not re-teach a row reconcile already learned from; a disagreement relabels it", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const id = row({ runId: "R1", taskId: t, action: "applied", role: "reviewer" });
    expect(reconcile(db, { now: NOW, learning: L }).learned).toBe(2);
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "success", outcomeSource: "swarm" });
    const bias = db.adjudicator.biasAll();

    // Agreeing feedback changes nothing (the role that ran, coder, is the one taught).
    expect(applyFeedbackResult(db, id, "good", { learning: L })?.learned).toBe(0);
    expect(db.adjudicator.biasAll()).toEqual(bias);
    expect(opt("role", "reviewer")).toBeUndefined();

    // Disagreeing feedback flips the tier signal (n unchanged) and retracts the role success.
    applyFeedback(db, id, "too_small", { learning: L });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 0, f: 1 });
    expect(opt("role", "coder")).toMatchObject({ n: 0, s: 0 });
    // Repeating it, or reconciling again, adds nothing.
    applyFeedback(db, id, "too_small", { learning: L });
    reconcile(db, { now: NOW + MIN, learning: L });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 0, f: 1 });
  });

  it("a redo relabel turns the attempt's taught success into a failure, n unchanged", () => {
    const t = swarmTask("done", "A0");
    db.apiCallsUpsert([
      call({ agent_id: "A0", sidechain: 1, model: "claude-haiku-4-5", ts: NOW - 25 * MIN }),
    ]);
    const first = row({ runId: "R1", taskId: t, ts: NOW - 30 * MIN, action: "applied" });
    reconcile(db, { now: NOW, learning: L });
    expect(db.adjudicator.get(first)).toMatchObject({ outcome: "success", final: true });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 1, f: 0 });

    // The task is dispatched again (a sonnet worker): the first attempt did not hold.
    db.swarm.workerUpsert({
      run_id: "R1",
      agent_id: "A2",
      agent_type: "swarm-feature-coder",
      role: "coder",
      session_id: "S",
      task_id: t,
    });
    db.apiCallsUpsert([
      call({ agent_id: "A2", sidechain: 1, model: "claude-sonnet-5-5", ts: NOW - 3 * MIN }),
    ]);
    row({ runId: "R1", taskId: t, ts: NOW - 4 * MIN, action: "applied" });
    reconcile(db, { now: NOW + 10 * MIN, learning: L });
    expect(db.adjudicator.get(first)).toMatchObject({ outcome: "failure", outcomeSource: "redo" });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 0, f: 1 });
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 1 });

    // Feedback on the relabelled attempt replaces the redo lesson, it does not add one.
    applyFeedback(db, first, "good", { learning: L });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 1, f: 0 });
  });

  it("explicit feedback is not overwritten by a later redo relabel", () => {
    const t = swarmTask("done", "A0");
    db.apiCallsUpsert([
      call({ agent_id: "A0", sidechain: 1, model: "claude-haiku-4-5", ts: NOW - 25 * MIN }),
    ]);
    const first = row({ runId: "R1", taskId: t, ts: NOW - 30 * MIN, action: "applied" });
    reconcile(db, { now: NOW, learning: L });
    applyFeedback(db, first, "good", { learning: L });
    db.swarm.workerUpsert({
      run_id: "R1",
      agent_id: "A2",
      agent_type: "x",
      role: "coder",
      session_id: "S",
      task_id: t,
    });
    db.apiCallsUpsert([call({ agent_id: "A2", sidechain: 1, ts: NOW - 3 * MIN })]);
    row({ runId: "R1", taskId: t, ts: NOW - 4 * MIN, action: "applied" });
    reconcile(db, { now: NOW + 10 * MIN, learning: L });
    expect(db.adjudicator.get(first)).toMatchObject({
      outcome: "success",
      outcomeSource: "feedback:good",
    });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 1, f: 0 });
  });

  it('reads a legacy bare "feedback" label by its outcome', () => {
    expect(feedbackOf({ outcome: "failure", outcomeSource: "feedback" })).toBe("too_small");
    expect(feedbackOf({ outcome: "success", outcomeSource: "feedback" })).toBe("good");
    expect(feedbackOf({ outcome: "success", outcomeSource: "feedback:too_big" })).toBe("too_big");
    expect(feedbackOf({ outcome: "success", outcomeSource: "swarm" })).toBeUndefined();
    expect(feedbackOf({ outcome: "success", outcomeSource: "feedback:bogus" })).toBeUndefined();
  });
});

describe("feedback retracts exactly what was taught (task #53)", () => {
  const L = { ...DEFAULT_LEARNING, minSamples: 0 };
  const OFF = { ...L, enabled: false };
  const tierRows = () =>
    db.adjudicator
      .biasAll()
      .filter((b) => b.dimension === "tier")
      .map((b) => ({
        option: b.option,
        n: +b.n.toFixed(2),
        s: +b.s.toFixed(2),
        f: +b.f.toFixed(2),
      }))
      .sort((a, b) => a.option.localeCompare(b.option));
  const opt = (dim: string, option: string) =>
    db.adjudicator.biasAll().find((b) => b.dimension === dim && b.option === option);
  const scores = JSON.stringify({
    heuristicComplexity: 2.0,
    features: { intents: { implement: 1 } },
  });

  it("feedback given with learning off retracts nothing later (probe f1 A)", () => {
    const R = row({ tier: "sonnet", scores, action: "advised" });
    applyFeedback(db, R, "too_big", { learning: OFF });
    expect(taughtOf(db.adjudicator.get(R) as never)).toEqual([]);
    for (let i = 0; i < 6; i++)
      applyFeedback(db, row({ tier: "haiku", scores, action: "advised" }), "good", { learning: L });
    const haiku = opt("tier", "haiku");
    expect(haiku?.n).toBeCloseTo(5.8, 1);

    applyFeedback(db, R, "too_small", { learning: L });
    // haiku keeps every real success; R's own lesson (a sonnet failure) is recorded.
    expect(opt("tier", "haiku")).toMatchObject({ n: haiku?.n, s: haiku?.s, f: haiku?.f });
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 0, f: 1 });
    expect(taughtOf(db.adjudicator.get(R) as never)).toEqual([
      { dimension: "tier", bucket: "2", option: "sonnet", success: false },
    ]);
  });

  it("a long feedback sequence on one row ends holding exactly its last lesson (probe f1 B)", () => {
    const R = row({ tier: "opus", role: null, scores });
    for (const fb of [
      "too_big",
      "too_small",
      "good",
      "too_big",
      "too_big",
      "too_small",
      "too_big",
      "good",
      "too_small",
    ] as const)
      applyFeedback(db, R, fb, { learning: L });
    expect(tierRows()).toEqual([
      { option: "opus", n: 1, s: 0, f: 1 },
      { option: "sonnet", n: 0, s: 0, f: 0 },
    ]);
    expect(db.adjudicator.biasAll().every((b) => b.n >= 0 && b.s >= 0 && b.f >= 0)).toBe(true);
  });

  it("a changed tier ladder retracts the lower tier too_big actually taught", () => {
    const R = row({ tier: "sonnet", role: null, scores });
    applyFeedback(db, R, "too_big", { learning: L, tiers: ["haiku", "sonnet", "opus"] });
    expect(opt("tier", "haiku")).toMatchObject({ n: 1, s: 1 });
    // The ladder no longer has a tier below sonnet; the haiku success R taught still goes.
    applyFeedback(db, R, "good", { learning: L, tiers: ["sonnet", "opus"] });
    expect(opt("tier", "haiku")).toMatchObject({ n: 0, s: 0 });
    expect(opt("tier", "sonnet")).toMatchObject({ n: 1, s: 1, f: 0 });
  });

  it("a row reconcile finalised with learning off does not flip another row's lesson", () => {
    // Another decision taught a haiku success and a coder success.
    applyFeedback(db, row({ tier: "haiku" }), "good", { learning: L });
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const id = row({ runId: "R1", taskId: t, action: "applied" });
    expect(reconcile(db, { now: NOW, learning: OFF }).learned).toBe(0);
    expect(db.adjudicator.get(id)).toMatchObject({ outcome: "success", final: true });
    expect(taughtOf(db.adjudicator.get(id) as never)).toEqual([]);

    applyFeedback(db, id, "too_small", { learning: L });
    // The other row's success stays; this row's failure is added.
    expect(opt("tier", "haiku")).toMatchObject({ n: 1 + decayFactor(L.halfLife), f: 1 });
    expect(opt("role", "coder")).toMatchObject({ n: 1, s: 1 });
  });

  it("records what reconcile taught on the row and keeps the rest of the scores", () => {
    const t = swarmTask("done");
    db.apiCallsUpsert([call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5" })]);
    const id = row({ runId: "R1", taskId: t, action: "applied", scores });
    reconcile(db, { now: NOW, learning: L });
    const r = db.adjudicator.get(id);
    expect(JSON.parse(r?.scores ?? "{}")).toMatchObject({ heuristicComplexity: 2 });
    expect(taughtOf(r as never)).toEqual([
      { dimension: "tier", bucket: "2", option: "haiku", success: true },
      { dimension: "role", bucket: "implement", option: "coder", success: true },
    ]);
  });

  it("a flip whose option row is gone records the new signal instead of dropping it", () => {
    const R = row({ tier: "opus", role: null, scores });
    applyFeedback(db, R, "good", { learning: L });
    db.adjudicator.biasReset();
    applyFeedback(db, R, "too_small", { learning: L });
    expect(opt("tier", "opus")).toMatchObject({ n: 1, s: 0, f: 1 });
  });

  it("withTaught leaves scores that are not a JSON object alone", () => {
    expect(withTaught("not json", [])).toBeUndefined();
    expect(withTaught("[1]", [])).toBeUndefined();
    expect(JSON.parse(withTaught(null, []) as string)).toEqual({ taught: [] });
    expect(taughtOf({ scores: JSON.stringify({ features: {} }) })).toBeUndefined();
  });
});

describe("reconcile: effort follow-through (#170)", () => {
  const SATURATED_UNITS = {
    scored: 3,
    dropped: 0,
    skipped: 0,
    winner: 2,
    sum: 5,
    saturated: true,
    roleConfidence: 0.6,
  };
  const sc = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ features: { intents: { implement: 1 } }, ...extra });
  const scoresOf = (id: number) => JSON.parse(db.adjudicator.get(id)?.scores ?? "{}");

  /** A done task whose worker ran `n` calls at these efforts, after an opus main thread. */
  function ran(agent: string, efforts: Array<string | null>, model = "claude-haiku-4-5") {
    const t = swarmTask("done", agent);
    db.apiCallsUpsert(
      efforts.map((e) => call({ agent_id: agent, sidechain: 1, model, effort: e })),
    );
    return t;
  }

  it("(a) ignored effort is recorded, and the model follow and savings stay as before", () => {
    db.apiCallsUpsert([call({ ts: NOW - 40 * MIN })]);
    const t = ran("A1", ["medium", "medium", "medium"]);
    const id = row({
      runId: "R1",
      taskId: t,
      action: "advised",
      tier: "haiku",
      modelRequested: "haiku",
      effort: "high",
      scores: sc(),
    });
    reconcile(db, { now: NOW });
    const r = db.adjudicator.get(id);
    expect(scoresOf(id)).toMatchObject({ actualEffort: "medium", effortFollow: "ignored" });
    // The model follow and its credit are untouched by the effort verdict.
    expect(r?.action).toBe("followed");
    expect(r?.savingsUsd).toBeCloseTo(3 * (OPUS - HAIKU), 10);
    expect(r?.actualCostUsd).toBeCloseTo(3 * HAIKU, 10);
  });

  it("(a) the actual effort is the mode of the calls; null and unknown values are skipped", () => {
    const t = ran("A1", [null, "low", "bogus", "high", "high"]);
    const id = row({ runId: "R1", taskId: t, effort: "high", scores: sc() });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
  });

  it("(b) passed effort equal to the advice and to what ran is followed", () => {
    const t = ran("A1", ["high", "high"]);
    const id = row({
      runId: "R1",
      taskId: t,
      effort: "high",
      scores: sc({ passedEffort: "high" }),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({
      passedEffort: "high",
      actualEffort: "high",
      effortFollow: "followed",
    });
  });

  it("(c) advised max, passed max, ran high (the model's cap) is followed", () => {
    const t = ran("A1", ["high", "high"]);
    const id = row({
      runId: "R1",
      taskId: t,
      effort: "max",
      scores: sc({ passedEffort: "max" }),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
  });

  it("ignored when the advised level was neither passed nor run", () => {
    const t = ran("A1", ["low"]);
    const id = row({
      runId: "R1",
      taskId: t,
      effort: "high",
      scores: sc({ passedEffort: "medium" }),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "low", effortFollow: "ignored" });
  });

  it("(d) a fork, the env override and a saturated brief keep actualEffort but no verdict", () => {
    const fork = row({
      runId: "R1",
      taskId: ran("F", ["low"]),
      effort: "high",
      scores: sc({ fork: true }),
    });
    const env = row({
      runId: "R1",
      taskId: ran("E", ["low"]),
      effort: "high",
      scores: sc({ effortEnv: "low" }),
    });
    const envOther = row({
      runId: "R1",
      taskId: ran("O", ["low"]),
      effort: "high",
      scores: sc({ effortEnv: "other" }),
    });
    const satPlanTask = ran("S", ["low"]);
    const plan = row({
      surface: "plan",
      runId: "R1",
      taskId: satPlanTask,
      scores: sc({ units: SATURATED_UNITS }),
    });
    const sat = row({
      runId: "R1",
      taskId: satPlanTask,
      parentId: plan,
      effort: "high",
      scores: sc(),
    });
    reconcile(db, { now: NOW });
    for (const id of [fork, env, envOther, sat]) {
      const s = scoresOf(id);
      expect(s.actualEffort).toBe("low");
      expect(s.effortFollow).toBeUndefined();
    }
  });

  it("no advice, or no effort data on the calls: no verdict, and no actualEffort without data", () => {
    const noAdvice = row({ runId: "R1", taskId: ran("N", ["high"]), scores: sc() });
    const noData = row({
      runId: "R1",
      taskId: ran("D", [null, null]),
      effort: "high",
      scores: sc(),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(noAdvice)).toMatchObject({ actualEffort: "high" });
    expect(scoresOf(noAdvice).effortFollow).toBeUndefined();
    expect(scoresOf(noData).actualEffort).toBeUndefined();
    expect(scoresOf(noData).effortFollow).toBeUndefined();
    // the rest of the reconcile still ran for it
    expect(db.adjudicator.get(noData)).toMatchObject({ final: true, outcome: "success" });
  });

  it("(e) the finalising commit keeps taught AND the effort keys", () => {
    const t = ran("A1", ["medium"]);
    const id = row({ runId: "R1", taskId: t, effort: "high", scores: sc() });
    reconcile(db, { now: NOW });
    const s = scoresOf(id);
    expect(db.adjudicator.get(id)?.final).toBe(true);
    expect(s).toMatchObject({ actualEffort: "medium", effortFollow: "ignored" });
    expect(Array.isArray(s.taught)).toBe(true);
    expect(s.taught.length).toBeGreaterThan(0);
    expect(taughtOf(db.adjudicator.get(id) as never)?.length).toBe(s.taught.length);
    // the original scores survive too
    expect(s.features).toEqual({ intents: { implement: 1 } });
  });

  it("(e) learning off: taught is empty but the effort keys are still kept", () => {
    const t = ran("A1", ["medium"]);
    const id = row({ runId: "R1", taskId: t, effort: "high", scores: sc() });
    reconcile(db, { now: NOW, learning: { enabled: false } });
    expect(scoresOf(id)).toMatchObject({
      actualEffort: "medium",
      effortFollow: "ignored",
      taught: [],
    });
  });

  it("(f) a second reconcile writes nothing", () => {
    // not yet final: the task is active, calls keep arriving
    const t = swarmTask("active", "A1");
    db.apiCallsUpsert([
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5", effort: "low" }),
    ]);
    const id = row({ runId: "R1", taskId: t, effort: "high", scores: sc() });
    const first = reconcile(db, { now: NOW });
    expect(first.updated).toBe(1);
    expect(scoresOf(id)).toMatchObject({ actualEffort: "low", effortFollow: "ignored" });
    expect(db.adjudicator.get(id)?.final).toBe(false);
    const before = db.adjudicator.get(id);
    const second = reconcile(db, { now: NOW });
    expect(second.updated).toBe(0);
    expect(db.adjudicator.get(id)).toEqual(before);
  });

  it("a verdict that changes as more calls arrive is rewritten", () => {
    const t = swarmTask("active", "A1");
    db.apiCallsUpsert([
      call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5", effort: "low" }),
    ]);
    const id = row({ runId: "R1", taskId: t, effort: "high", scores: sc() });
    reconcile(db, { now: NOW });
    expect(scoresOf(id).effortFollow).toBe("ignored");
    db.apiCallsUpsert(
      [1, 2, 3].map(() =>
        call({ agent_id: "A1", sidechain: 1, model: "claude-haiku-4-5", effort: "high" }),
      ),
    );
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
  });

  it("a stale verdict that no longer applies is removed", () => {
    const t = ran("A1", ["high"]);
    // the verdict was written before the env override showed up: it is not counted any more
    const id = row({
      runId: "R1",
      taskId: t,
      effort: "high",
      scores: sc({ effortEnv: "low", effortFollow: "followed" }),
    });
    reconcile(db, { now: NOW });
    const s = scoresOf(id);
    expect(s.effortFollow).toBeUndefined();
    expect(s.actualEffort).toBe("high");
    expect(s.effortEnv).toBe("low");
  });

  it("the agent file's effort equal to the advice counts as followed when nothing was passed", () => {
    const t = ran("A1", ["high", "high"]);
    const id = row({
      runId: "R1",
      taskId: t,
      effort: "xhigh",
      scores: sc({ agentEffort: "xhigh" }),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
  });

  it("the agent file's effort is ignored when the call passed another level", () => {
    const t = ran("A1", ["high"]);
    const id = row({
      runId: "R1",
      taskId: t,
      effort: "xhigh",
      scores: sc({ agentEffort: "xhigh", passedEffort: "low" }),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "high", effortFollow: "ignored" });
  });

  it("(g) a plan row with worker calls gets actualEffort and no verdict", () => {
    const t = ran("A1", ["high", "high"]);
    const plan = row({ surface: "plan", runId: "R1", taskId: t, effort: "high", scores: sc() });
    reconcile(db, { now: NOW });
    const s = scoresOf(plan);
    expect(s.actualEffort).toBe("high");
    expect(s.effortFollow).toBeUndefined();
  });

  it("a linked non-swarm agent row gets the verdict too", () => {
    const start = NOW - 10 * MIN;
    db.apiCallsUpsert([
      call({
        ts: start + 5_000,
        agent_id: "G1",
        sidechain: 1,
        model: "claude-haiku-4-5",
        effort: "low",
      }),
    ]);
    // ingestion has passed the row's 60 s link window
    db.apiCallsUpsert([call({ ts: start + 2 * MIN })]);
    const id = row({ ts: start, effort: "high", scores: sc() });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)?.agentId).toBe("G1");
    expect(scoresOf(id)).toMatchObject({ actualEffort: "low", effortFollow: "ignored" });
  });

  it("a prompt row gets no effort keys", () => {
    db.apiCallsUpsert([call({ ts: NOW - 5 * MIN, effort: "high" })]);
    const id = row({ surface: "prompt", ts: NOW - 6 * MIN, effort: "high", scores: sc() });
    reconcile(db, { now: NOW });
    expect(db.adjudicator.get(id)?.scores).toBe(sc());
  });
});

describe("reconcile: applied effort (effortPatch passes applied)", () => {
  const sc = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ features: { intents: { implement: 1 } }, ...extra });
  const scoresOf = (id: number) => JSON.parse(db.adjudicator.get(id)?.scores ?? "{}");
  function ran(agent: string, efforts: string[]) {
    const t = swarmTask("done", agent);
    db.apiCallsUpsert(
      efforts.map((e) =>
        call({ agent_id: agent, sidechain: 1, model: "claude-haiku-4-5", effort: e }),
      ),
    );
    return t;
  }

  it("applied == advised but a lower level ran is ignored (passed alone would say followed)", () => {
    const id = row({
      runId: "R1",
      taskId: ran("A1", ["low", "low"]),
      effort: "high",
      scores: sc({ passedEffort: "high", effortApplied: "high" }),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "low", effortFollow: "ignored" });
  });

  it("applied == advised and it ran there is followed", () => {
    const id = row({
      runId: "R1",
      taskId: ran("A1", ["high", "high"]),
      effort: "high",
      scores: sc({ effortApplied: "high" }),
    });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
  });
});

describe("reconcile: effort backfill of final agent rows", () => {
  const sc = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ features: { intents: { implement: 1 } }, ...extra });
  const scoresOf = (id: number) => JSON.parse(db.adjudicator.get(id)?.scores ?? "{}");
  const OFF = { adjudicator: { learning: { enabled: false } } };

  /** A final agent row for `agent` with calls at `effort`; `rowOver` overrides the row. */
  function finalRow(
    agent: string,
    effort: string | null,
    rowOver: Partial<AdjudicationInput> = {},
    session = "S",
  ): number {
    const ts = rowOver.ts ?? NOW - 10 * MIN;
    db.apiCallsUpsert([
      call({ session_id: session, agent_id: agent, sidechain: 1, ts: ts + 1000, effort }),
    ]);
    return row({
      ts,
      sessionId: session,
      agentId: agent,
      final: true,
      effort: "high",
      action: "followed",
      savingsUsd: 0.5,
      scores: sc(),
      ...rowOver,
    });
  }

  it("repairs a final row that lacks actualEffort and touches only the effort keys", () => {
    const id = finalRow("G1", "low", { scores: sc({ passedEffort: "medium" }) });
    const before = db.adjudicator.get(id);
    reconcile(db, { now: NOW });
    const after = db.adjudicator.get(id);
    expect(scoresOf(id)).toMatchObject({
      actualEffort: "low",
      effortFollow: "ignored",
      passedEffort: "medium",
      features: { intents: { implement: 1 } },
    });
    expect({ ...after, scores: null, updatedAt: null }).toEqual({
      ...before,
      scores: null,
      updatedAt: null,
    });
    expect(after?.final).toBe(true);
    expect(after?.action).toBe("followed");
    expect(after?.savingsUsd).toBe(0.5);
  });

  it("uses applied: ran at the advised level is followed", () => {
    const id = finalRow("G1", "high", { scores: sc({ effortApplied: "high" }) });
    reconcile(db, { now: NOW });
    expect(scoresOf(id)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
  });

  it("is idempotent: a second pass updates nothing and the scores do not change", () => {
    const id = finalRow("G1", "low");
    reconcile(db, { now: NOW });
    const first = db.adjudicator.get(id)?.scores;
    const r2 = reconcile(db, { now: NOW });
    expect(r2.updated).toBe(0);
    expect(db.adjudicator.get(id)?.scores).toBe(first);
  });

  it("skips rows with an actualEffort key, no agentId, no calls with an effort, or non-final", () => {
    const has = finalRow("G1", "low", { scores: sc({ actualEffort: "high" }) });
    const noAgent = finalRow("G2", "low", { agentId: null });
    const noCalls = row({ ts: NOW - 10 * MIN, agentId: "G3", final: true, scores: sc() });
    const noEffort = finalRow("G4", null);
    const prompt = finalRow("G5", "low", { surface: "prompt" });
    expect(reconcile(db, { now: NOW }).updated).toBe(0);
    expect(scoresOf(has).actualEffort).toBe("high");
    expect(scoresOf(noAgent).actualEffort).toBeUndefined();
    expect(scoresOf(noCalls).actualEffort).toBeUndefined();
    expect(scoresOf(noEffort).actualEffort).toBeUndefined();
    expect(scoresOf(prompt).actualEffort).toBeUndefined();
  });

  it("matches calls by agent: another agent's effort is not used", () => {
    db.apiCallsUpsert([call({ agent_id: "OTHER", sidechain: 1, effort: "max" })]);
    const id = finalRow("G1", "low");
    reconcile(db, { now: NOW });
    expect(scoresOf(id).actualEffort).toBe("low");
  });

  it("learning disabled is a no-op", () => {
    const id = finalRow("G1", "low");
    const before = db.adjudicator.get(id)?.scores;
    expect(reconcile(db, { now: NOW, config: OFF }).updated).toBe(0);
    expect(db.adjudicator.get(id)?.scores).toBe(before);
  });

  it("also runs when there are pending rows to reconcile (not only the early return)", () => {
    const id = finalRow("G1", "low");
    row({ ts: NOW - 20 * MIN, scores: sc() });
    reconcile(db, { now: NOW });
    expect(scoresOf(id).actualEffort).toBe("low");
  });

  it("repairs at most EFFORT_BACKFILL_LIMIT rows per pass, newest first, the rest next pass", () => {
    const extra = 30;
    const total = EFFORT_BACKFILL_LIMIT + extra;
    const ids: number[] = [];
    for (let i = 0; i < total; i++)
      ids.push(finalRow(`G${i}`, "low", { ts: NOW - HOUR + i * 1000 }));
    const r1 = reconcile(db, { now: NOW });
    expect(r1.updated).toBe(EFFORT_BACKFILL_LIMIT);
    const done = ids.filter((id) => scoresOf(id).actualEffort === "low");
    expect(done.length).toBe(EFFORT_BACKFILL_LIMIT);
    // the oldest `extra` rows are the ones left
    for (const id of ids.slice(0, extra)) expect(scoresOf(id).actualEffort).toBeUndefined();
    const r2 = reconcile(db, { now: NOW });
    expect(r2.updated).toBe(extra);
    expect(ids.every((id) => scoresOf(id).actualEffort === "low")).toBe(true);
    expect(reconcile(db, { now: NOW }).updated).toBe(0);
  });

  describe("a row that records no dispatch facts is legacy (effortFactsRecorded)", () => {
    it("gets actualEffort but no effortFollow even when advised != ran", () => {
      // advised "high" (finalRow default), ran at "low": with a verdict this would be "ignored"
      const id = finalRow("G1", "low", { scores: sc() });
      reconcile(db, { now: NOW });
      const s = scoresOf(id);
      expect(s.actualEffort).toBe("low");
      expect(s).not.toHaveProperty("effortFollow");
    });

    it("agentEffort alone is a recorded fact: the verdict is written", () => {
      const ign = finalRow("G1", "low", { scores: sc({ agentEffort: "high" }) });
      const fol = finalRow("G2", "high", { scores: sc({ agentEffort: "high" }) });
      // the agent file sets the advised level, so it counts as followed even though it ran lower
      reconcile(db, { now: NOW });
      expect(scoresOf(ign)).toMatchObject({ actualEffort: "low", effortFollow: "followed" });
      expect(scoresOf(fol)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
      const other = finalRow("G3", "low", {
        effort: "high",
        scores: sc({ agentEffort: "medium" }),
      });
      reconcile(db, { now: NOW });
      expect(scoresOf(other)).toMatchObject({ actualEffort: "low", effortFollow: "ignored" });
    });

    it("passedEffort alone is a recorded fact: followed or ignored", () => {
      const fol = finalRow("G1", "low", { scores: sc({ passedEffort: "high" }) });
      const ign = finalRow("G2", "low", { scores: sc({ passedEffort: "medium" }) });
      reconcile(db, { now: NOW });
      expect(scoresOf(fol)).toMatchObject({ actualEffort: "low", effortFollow: "followed" });
      expect(scoresOf(ign)).toMatchObject({ actualEffort: "low", effortFollow: "ignored" });
    });

    it("effortApplied alone is a recorded fact: the exact verdict is written", () => {
      const ign = finalRow("G1", "low", { scores: sc({ effortApplied: "high" }) });
      reconcile(db, { now: NOW });
      expect(scoresOf(ign)).toMatchObject({ actualEffort: "low", effortFollow: "ignored" });
    });

    it("effortEnv alone is a recorded fact, but the env override is not counted: actualEffort, no verdict", () => {
      const a = finalRow("G1", "low", { scores: sc({ effortEnv: "low" }) });
      const b = finalRow("G2", "low", { scores: sc({ effortEnv: "other" }) });
      reconcile(db, { now: NOW });
      for (const id of [a, b]) {
        expect(scoresOf(id).actualEffort).toBe("low");
        expect(scoresOf(id)).not.toHaveProperty("effortFollow");
      }
    });

    it("a legacy row repaired once is idempotent: the second pass writes nothing", () => {
      const id = finalRow("G1", "low");
      reconcile(db, { now: NOW });
      const first = db.adjudicator.get(id)?.scores;
      expect(reconcile(db, { now: NOW }).updated).toBe(0);
      expect(db.adjudicator.get(id)?.scores).toBe(first);
    });
  });

  describe("an old row of a busy session is not starved by a newer unrepairable one (#251)", () => {
    const HAIKU = "claude-haiku-4-5";
    /**
     * Session S: final agent row B (14 h old) whose agent ran at effort high, and a newer final
     * row A (1 h old) whose only call is a haiku call with no effort, so A can never be repaired.
     * A pass keyed to the newest row's window never loaded B's calls.
     */
    function seed(): { a: number; b: number } {
      const bTs = NOW - 14 * HOUR;
      const aTs = NOW - 1 * HOUR;
      db.apiCallsUpsert([
        call({ session_id: "S", agent_id: "B", sidechain: 1, ts: bTs + 1000, effort: "high" }),
        call({
          session_id: "S",
          agent_id: "A",
          sidechain: 1,
          ts: aTs + 1000,
          model: HAIKU,
          effort: null,
        }),
      ]);
      const mk = (agent: string, ts: number) =>
        row({
          ts,
          sessionId: "S",
          agentId: agent,
          final: true,
          effort: "high",
          action: "followed",
          scores: sc({ passedEffort: "high" }),
        });
      return { b: mk("B", bTs), a: mk("A", aTs) };
    }

    it("idle path: repairs B, leaves A untouched, and the second pass writes nothing", () => {
      const { a, b } = seed();
      const aBefore = db.adjudicator.get(a);
      expect(reconcile(db, { now: NOW }).updated).toBe(1);
      expect(scoresOf(b)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
      expect(db.adjudicator.get(a)).toEqual(aBefore);
      expect(scoresOf(a).actualEffort).toBeUndefined();
      const bAfter = db.adjudicator.get(b)?.scores;
      expect(reconcile(db, { now: NOW }).updated).toBe(0);
      expect(db.adjudicator.get(b)?.scores).toBe(bAfter);
      expect(db.adjudicator.get(a)).toEqual(aBefore);
    });

    it("pending path: a pending row in the same session does not change that", () => {
      const { a, b } = seed();
      const aBefore = db.adjudicator.get(a);
      const pending = row({ ts: NOW - 20 * MIN, sessionId: "S", scores: sc() });
      reconcile(db, { now: NOW });
      expect(scoresOf(b)).toMatchObject({ actualEffort: "high", effortFollow: "followed" });
      expect(db.adjudicator.get(a)).toEqual(aBefore);
      // the pending row was scanned by the main pass, not repaired by the backfill
      expect(db.adjudicator.get(pending)).toBeDefined();
      const bAfter = db.adjudicator.get(b)?.scores;
      reconcile(db, { now: NOW });
      expect(db.adjudicator.get(b)?.scores).toBe(bAfter);
      expect(db.adjudicator.get(a)).toEqual(aBefore);
    });

    it("a row older than the session's other candidates keeps its own 5 s slack", () => {
      // two repairable rows of one session; the older one's call precedes its ts by 3 s
      const ts1 = NOW - 6 * HOUR;
      const ts2 = NOW - 1 * HOUR;
      db.apiCallsUpsert([
        call({ session_id: "S", agent_id: "P", sidechain: 1, ts: ts1 - 3000, effort: "medium" }),
        call({ session_id: "S", agent_id: "Q", sidechain: 1, ts: ts2 + 1000, effort: "low" }),
      ]);
      const mk = (agent: string, ts: number) =>
        row({
          ts,
          sessionId: "S",
          agentId: agent,
          final: true,
          scores: sc({ passedEffort: "low" }),
        });
      const p = mk("P", ts1);
      const q = mk("Q", ts2);
      reconcile(db, { now: NOW });
      expect(scoresOf(p).actualEffort).toBe("medium");
      expect(scoresOf(q).actualEffort).toBe("low");
    });

    it("different sessions are loaded independently", () => {
      const ts = NOW - 10 * HOUR;
      const s1 = finalRow("X1", "high", { ts, scores: sc({ passedEffort: "high" }) }, "S1");
      const s2 = finalRow(
        "X2",
        "low",
        { ts: NOW - 2 * HOUR, scores: sc({ passedEffort: "low" }) },
        "S2",
      );
      reconcile(db, { now: NOW });
      expect(scoresOf(s1).actualEffort).toBe("high");
      expect(scoresOf(s2).actualEffort).toBe("low");
    });
  });

  it("scans at most EFFORT_BACKFILL_SCAN agent rows: a repairable row past the window waits", () => {
    const old = finalRow("OLD", "low", { ts: NOW - 5 * HOUR });
    // EFFORT_BACKFILL_SCAN newer rows that are already repaired, so they fill the scan window
    for (let i = 0; i < EFFORT_BACKFILL_SCAN; i++) {
      row({
        ts: NOW - 4 * HOUR + i,
        agentId: `D${i}`,
        final: true,
        scores: sc({ actualEffort: "high" }),
      });
    }
    expect(reconcile(db, { now: NOW }).updated).toBe(0);
    expect(scoresOf(old).actualEffort).toBeUndefined();
  });
});
