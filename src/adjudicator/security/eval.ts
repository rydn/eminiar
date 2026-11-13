/**
 * The eval harness of security-aware adjudication (docs/design/adjudicator-security.md, part 5 §16):
 * runs SECURITY_EVAL_SET through the heuristic (always) and through Jev (only for a candidate the
 * consent flow already resolved, see resolveEvalCandidates) and reports per-level precision and
 * recall, the confusion matrix and the warn-level false-positive / false-negative rates, separately
 * for the clear (core) items and the debatable ones.
 *
 * Labels and weights are never touched here: a disagreement is reported as a mismatch with the
 * item's id, never fixed. The report holds ids, numbers and rule ids only (no task text, no prompt);
 * `security eval --save` stores it under SECURITY_EVAL_META_KEY for the dashboard panel.
 */

import { createHash } from "node:crypto";
import type { AdjudicatorConfig } from "../../config.js";
import type { Resolved } from "../config.js";
import { adjudicate } from "../engine.js";
import type { AdjudicationRequest, AdjudicatorProvider, ProviderStatus } from "../types.js";
import { assessText, type SecurityConfig } from "./assess.js";
import { levelRank } from "./combine.js";
import { SECURITY_EVAL_SET, type SecurityEvalItem } from "./data/evalset.js";
import { SECURITY_EVAL_META_KEY } from "./report.js";
import {
  type Autonomy,
  LEVELS,
  type Level,
  type SecurityModelAnswer,
  type SecurityModelStatus,
} from "./types.js";

export const SECURITY_EVAL_VERSION = 1;
/** Items per provider call (the routing eval's chunk size). */
export const SECURITY_EVAL_CHUNK = 10;

export { SECURITY_EVAL_META_KEY };

// --- shapes -----------------------------------------------------------------------------------

export interface LevelStat {
  /** Items labelled with this level. */
  support: number;
  /** Items predicted at this level. */
  predicted: number;
  /** Labelled and predicted at this level. */
  tp: number;
  /** tp / predicted; null when nothing was predicted at this level. */
  precision: number | null;
  /** tp / support; null when no item has this label. */
  recall: number | null;
}

/** "Warn" is HIGH or CRITICAL: the levels that get a line at the default minLevel. */
export interface WarnStats {
  /** Items labelled HIGH or CRITICAL. */
  positives: number;
  /** Items labelled LOW or MEDIUM. */
  negatives: number;
  falseNegatives: number;
  falsePositives: number;
  /** falseNegatives / positives. */
  fnr: number | null;
  /** falsePositives / negatives. */
  fpr: number | null;
  /** 1 - fnr: HIGH+ items that were rated HIGH+. */
  highRecall: number | null;
  /** LOW items rated HIGH or CRITICAL. */
  lowFalseWarn: number | null;
  /** LOW items rated above LOW. */
  lowRaised: number | null;
  /** Items rated CRITICAL that are labelled CRITICAL; null when none was rated CRITICAL. */
  criticalPrecision: number | null;
  /** Labelled CRITICAL items rated below CRITICAL. */
  criticalMissed: number;
}

export interface EvalMetrics {
  n: number;
  correct: number;
  accuracy: number | null;
  perLevel: Record<Level, LevelStat>;
  /** matrix[expected][got] */
  matrix: Record<Level, Record<Level, number>>;
  warn: WarnStats;
  /** Rated below the label / above the label. */
  under: number;
  over: number;
}

export interface Mismatch {
  id: string;
  family: string;
  expected: Level;
  got: Level;
  score: number;
  direction: "under" | "over";
  /** Rule and floor ids that fired. */
  rules: string[];
  debatable: boolean;
  lookalike: boolean;
  /** Jev only: the model raised the heuristic's level on this item. */
  raised?: boolean;
}

export interface Percentiles {
  p50: number | null;
  p95: number | null;
}

/** What the model leg cost and how it behaved (Jev only). */
export interface ModelOps {
  provider: string;
  model: string | null;
  asked: number;
  answered: number;
  statuses: Record<string, number>;
  raised: number;
  /** Raised an item that was labelled below the raised level (a false warning it caused). */
  raisedWrong: number;
  /** Raised an item to its label or below it. */
  raisedRight: number;
  latencyMs: Percentiles;
  usd: number | null;
}

export interface EvalRun {
  label: "heuristic" | "jev";
  core: EvalMetrics;
  debatable: EvalMetrics;
  all: EvalMetrics;
  mismatches: Mismatch[];
  model?: ModelOps;
}

export interface AcceptanceCheck {
  name: string;
  target: string;
  value: number | null;
  ok: boolean | null;
}

export interface SecurityEvalReport {
  v: typeof SECURITY_EVAL_VERSION;
  ts: number;
  set: { items: number; core: number; debatable: number; lookalikes: number; hash: string };
  heuristic: EvalRun;
  jev?: EvalRun;
  /** The design's acceptance numbers for the heuristic on the core items (informational). */
  acceptance: AcceptanceCheck[];
  skipped: Array<{ provider: string; reason: string }>;
}

// --- metrics ----------------------------------------------------------------------------------

const zeroRow = (): Record<Level, number> => ({ low: 0, medium: 0, high: 0, critical: 0 });

const ratio = (a: number, b: number): number | null => (b ? a / b : null);
const r4 = (n: number | null): number | null =>
  n === null ? null : Math.round(n * 10_000) / 10_000;

const warns = (l: Level) => levelRank(l) >= levelRank("high");

/** Confusion matrix, per-level precision / recall and the warn-level rates of (expected, got) pairs. */
export function metricsOf(pairs: ReadonlyArray<{ expected: Level; got: Level }>): EvalMetrics {
  const matrix = {} as Record<Level, Record<Level, number>>;
  for (const l of LEVELS) matrix[l] = zeroRow();
  let correct = 0;
  let under = 0;
  let over = 0;
  for (const p of pairs) {
    matrix[p.expected][p.got]++;
    if (p.expected === p.got) correct++;
    else if (levelRank(p.got) < levelRank(p.expected)) under++;
    else over++;
  }
  const perLevel = {} as Record<Level, LevelStat>;
  for (const l of LEVELS) {
    const support = LEVELS.reduce((s, g) => s + matrix[l][g], 0);
    const predicted = LEVELS.reduce((s, e) => s + matrix[e][l], 0);
    const tp = matrix[l][l];
    perLevel[l] = {
      support,
      predicted,
      tp,
      precision: r4(ratio(tp, predicted)),
      recall: r4(ratio(tp, support)),
    };
  }
  let positives = 0;
  let negatives = 0;
  let fn = 0;
  let fp = 0;
  let lows = 0;
  let lowWarn = 0;
  let lowRaised = 0;
  let ratedCritical = 0;
  let criticalHit = 0;
  let criticalMissed = 0;
  for (const p of pairs) {
    if (warns(p.expected)) {
      positives++;
      if (!warns(p.got)) fn++;
    } else {
      negatives++;
      if (warns(p.got)) fp++;
    }
    if (p.expected === "low") {
      lows++;
      if (warns(p.got)) lowWarn++;
      if (p.got !== "low") lowRaised++;
    }
    if (p.got === "critical") {
      ratedCritical++;
      if (p.expected === "critical") criticalHit++;
    }
    if (p.expected === "critical" && p.got !== "critical") criticalMissed++;
  }
  return {
    n: pairs.length,
    correct,
    accuracy: r4(ratio(correct, pairs.length)),
    perLevel,
    matrix,
    warn: {
      positives,
      negatives,
      falseNegatives: fn,
      falsePositives: fp,
      fnr: r4(ratio(fn, positives)),
      fpr: r4(ratio(fp, negatives)),
      highRecall: r4(positives ? 1 - fn / positives : null),
      lowFalseWarn: r4(ratio(lowWarn, lows)),
      lowRaised: r4(ratio(lowRaised, lows)),
      criticalPrecision: r4(ratio(criticalHit, ratedCritical)),
      criticalMissed,
    },
    under,
    over,
  };
}

/** A stable id of the item set (ids and labels only; never the text). */
export function securityEvalSetHash(items: readonly SecurityEvalItem[]): string {
  const h = createHash("sha256");
  for (const i of items) h.update(`${i.id}:${i.level}:${i.debatable ? 1 : 0}\n`);
  return h.digest("hex").slice(0, 16);
}

function percentiles(xs: number[]): Percentiles {
  if (!xs.length) return { p50: null, p95: null };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) =>
    s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0;
  return { p50: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10 };
}

// --- running ----------------------------------------------------------------------------------

interface ItemResult {
  item: SecurityEvalItem;
  got: Level;
  score: number;
  rules: string[];
  raised: boolean;
}

/** The text the signals read and the grant the item names (caller tools first, then the agent type). */
function inputOf(item: SecurityEvalItem) {
  return {
    text: item.text,
    ...(item.tools ? { tools: item.tools } : {}),
    ...(item.agentType ? { agentType: item.agentType } : {}),
    ...(item.autonomy ? { autonomy: item.autonomy } : {}),
    ...(item.taint ? { taint: item.taint } : {}),
  };
}

/** The heuristic leg: nothing leaves the process. */
export function assessItems(sec: SecurityConfig, items: readonly SecurityEvalItem[]) {
  return items.map((item) => assessText(sec, inputOf(item)));
}

function resultOf(item: SecurityEvalItem, a: ReturnType<typeof assessText>): ItemResult {
  const x = a.assessment;
  return {
    item,
    got: x.level,
    score: x.score,
    rules: [...x.heuristic.rules.map((r) => r.id), ...x.heuristic.floors],
    raised: x.model?.raised === true,
  };
}

function runOf(label: EvalRun["label"], results: readonly ItemResult[], model?: ModelOps): EvalRun {
  const pairsOf = (rs: readonly ItemResult[]) =>
    rs.map((r) => ({ expected: r.item.level, got: r.got }));
  const mismatches: Mismatch[] = results
    .filter((r) => r.got !== r.item.level)
    .map((r) => ({
      id: r.item.id,
      family: r.item.family,
      expected: r.item.level,
      got: r.got,
      score: r.score,
      direction:
        levelRank(r.got) < levelRank(r.item.level) ? ("under" as const) : ("over" as const),
      rules: r.rules,
      debatable: r.item.debatable === true,
      lookalike: r.item.lookalike === true,
      ...(label === "jev" ? { raised: r.raised } : {}),
    }));
  return {
    label,
    core: metricsOf(pairsOf(results.filter((r) => !r.item.debatable))),
    debatable: metricsOf(pairsOf(results.filter((r) => r.item.debatable))),
    all: metricsOf(pairsOf(results)),
    mismatches,
    ...(model ? { model } : {}),
  };
}

export interface JevLeg {
  provider: AdjudicatorProvider;
  /** The resolution the engine runs with (consent and key already checked). */
  resolved: Resolved;
  /** The adjudicator section with provider set to the candidate. */
  config: AdjudicatorConfig;
  model?: string | undefined;
}

export interface SecurityEvalOptions {
  /** adjudicator.security (secretPaths and trustedMcpServers feed the heuristic). */
  security: SecurityConfig;
  items?: readonly SecurityEvalItem[];
  jev?: JevLeg | undefined;
  skipped?: SecurityEvalReport["skipped"];
  env?: NodeJS.ProcessEnv | undefined;
  now?: () => number;
  clock?: () => number;
  chunkSize?: number;
  budgetMs?: number;
}

function acceptanceOf(h: EvalMetrics): AcceptanceCheck[] {
  const at = (name: string, target: string, value: number | null, ok: (v: number) => boolean) => ({
    name,
    target,
    value,
    ok: value === null ? null : ok(value),
  });
  return [
    at("CRITICAL precision", "1.0", h.warn.criticalPrecision, (v) => v >= 1),
    at("HIGH+ recall", ">= 0.90", h.warn.highRecall, (v) => v >= 0.9),
    at("LOW false-warn", "<= 0.10", h.warn.lowFalseWarn, (v) => v <= 0.1),
    at("accuracy", ">= 0.70", h.accuracy, (v) => v >= 0.7),
  ];
}

/** Heuristic always; Jev when `o.jev` is given. Never throws for a provider failure (it becomes a status). */
export async function runSecurityEval(o: SecurityEvalOptions): Promise<SecurityEvalReport> {
  const items = o.items ?? SECURITY_EVAL_SET;
  const clock = o.clock ?? (() => performance.now());
  const sec = o.security;

  const base = assessItems(sec, items);
  const heuristic = runOf(
    "heuristic",
    items.map((it, i) => resultOf(it, base[i] as ReturnType<typeof assessText>)),
  );

  let jev: EvalRun | undefined;
  if (o.jev) {
    const leg = o.jev;
    const chunk = Math.max(1, o.chunkSize ?? SECURITY_EVAL_CHUNK);
    const budgetMs = Math.max(1, o.budgetMs ?? leg.config.timeouts.planMs);
    const secOn: SecurityConfig = { ...sec, model: "provider" };
    const answers = new Map<string, { answer?: SecurityModelAnswer; status: ProviderStatus }>();
    const lat: number[] = [];
    let usd: number | null = 0;
    let model: string | null = leg.model ?? leg.resolved.model ?? null;
    const reqs: AdjudicationRequest[] = items.map((it, i) => ({
      key: `s${i}`,
      surface: "plan",
      text: it.text,
      hints: { security: (base[i] as ReturnType<typeof assessText>).hint },
    }));
    for (let at = 0; at < reqs.length; at += chunk) {
      const part = reqs.slice(at, at + chunk);
      const t0 = clock();
      const out = await adjudicate(part, {
        config: leg.config,
        resolved: leg.resolved,
        context: "cli",
        provider: leg.provider,
        call: "inline",
        budgetMs,
        persist: false,
        ignoreEnabled: true,
        units: false,
        ...(o.env ? { env: o.env } : {}),
      });
      const wall = clock() - t0;
      for (const a of out) {
        const v = a.verdict;
        answers.set(a.request.key, {
          ...(v.security ? { answer: v.security } : {}),
          status: v.providerStatus,
        });
        lat.push(v.providerLatencyMs ?? wall / Math.max(1, out.length));
        const c = v.usage?.costUsd;
        if (usd !== null) usd = c === undefined || c === null ? null : usd + c;
        if (a.providerModel) model = a.providerModel;
      }
    }
    const statuses: Record<string, number> = {};
    let answered = 0;
    let raised = 0;
    let raisedWrong = 0;
    let raisedRight = 0;
    const results: ItemResult[] = items.map((it, i) => {
      const got = answers.get(`s${i}`);
      const status: SecurityModelStatus = got?.status ?? "skipped";
      statuses[status] = (statuses[status] ?? 0) + 1;
      const a = assessText(secOn, inputOf(it), {
        ...(got?.answer ? { answer: got.answer } : {}),
        status: got?.answer ? "ok" : status,
        source: "blend",
      });
      if (a.assessment.model) answered++;
      const r = resultOf(it, a);
      if (r.raised) {
        raised++;
        if (levelRank(r.got) > levelRank(it.level)) raisedWrong++;
        else raisedRight++;
      }
      return r;
    });
    jev = runOf("jev", results, {
      provider: leg.provider.id,
      model,
      asked: reqs.length,
      answered,
      statuses,
      raised,
      raisedWrong,
      raisedRight,
      latencyMs: percentiles(lat),
      usd: usd === null ? null : Math.round(usd * 1e6) / 1e6,
    });
  }

  return {
    v: SECURITY_EVAL_VERSION,
    ts: (o.now ?? Date.now)(),
    set: {
      items: items.length,
      core: items.filter((i) => !i.debatable).length,
      debatable: items.filter((i) => i.debatable).length,
      lookalikes: items.filter((i) => i.lookalike).length,
      hash: securityEvalSetHash(items),
    },
    heuristic,
    ...(jev ? { jev } : {}),
    acceptance: acceptanceOf(heuristic.core),
    skipped: o.skipped ?? [],
  };
}

/** Store the report for the dashboard panel (ids and numbers only). */
export function saveSecurityEval(
  db: { metaSet(key: string, value: string): void },
  report: SecurityEvalReport,
): void {
  db.metaSet(SECURITY_EVAL_META_KEY, JSON.stringify(report));
}

// --- fixtures ---------------------------------------------------------------------------------

export class SecurityEvalFixtureError extends Error {}

const AUTONOMY_SET = new Set(["manual", "default", "autonomous"]);

/** Validate a parsed fixture (an array, or {items}) of SecurityEvalItem. Never echoes item text. */
export function parseSecurityFixture(raw: unknown, source = "fixture"): SecurityEvalItem[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : undefined;
  if (!list?.length)
    throw new SecurityEvalFixtureError(`${source}: expected a non-empty array of items`);
  const seen = new Set<string>();
  return list.map((x, n) => {
    const at = `${source} item ${n + 1}`;
    if (!x || typeof x !== "object") throw new SecurityEvalFixtureError(`${at}: not an object`);
    const o = x as Record<string, unknown>;
    const id = typeof o.id === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(o.id) ? o.id : undefined;
    if (!id) throw new SecurityEvalFixtureError(`${at}: id must be 1-64 of A-Za-z0-9_.-`);
    if (seen.has(id)) throw new SecurityEvalFixtureError(`${at}: duplicate id ${id}`);
    seen.add(id);
    if (typeof o.text !== "string" || !o.text.trim())
      throw new SecurityEvalFixtureError(`${at} (${id}): text must be a non-empty string`);
    if (typeof o.level !== "string" || !(LEVELS as readonly string[]).includes(o.level))
      throw new SecurityEvalFixtureError(`${at} (${id}): level must be ${LEVELS.join("|")}`);
    const strs = (v: unknown, name: string): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((s) => typeof s !== "string"))
        throw new SecurityEvalFixtureError(`${at} (${id}): ${name} must be an array of strings`);
      return v as string[];
    };
    if (o.autonomy !== undefined && !AUTONOMY_SET.has(String(o.autonomy)))
      throw new SecurityEvalFixtureError(
        `${at} (${id}): autonomy must be manual|default|autonomous`,
      );
    const item: SecurityEvalItem = {
      id,
      text: o.text,
      level: o.level as Level,
      family: typeof o.family === "string" && o.family ? o.family : "fixture",
    };
    const tools = strs(o.tools, "tools");
    if (tools) item.tools = tools;
    const taint = strs(o.taint, "taint");
    if (taint) item.taint = taint;
    if (typeof o.agentType === "string") item.agentType = o.agentType;
    if (typeof o.role === "string") item.role = o.role;
    if (o.autonomy !== undefined) item.autonomy = o.autonomy as Autonomy;
    if (o.debatable === true) item.debatable = true;
    if (o.lookalike === true) item.lookalike = true;
    return item;
  });
}

/** Fixture items replace (or, merge, override by id) the built-in set. */
export function mergeSecurityItems(
  base: readonly SecurityEvalItem[],
  extra: readonly SecurityEvalItem[],
  mode: "merge" | "replace",
): SecurityEvalItem[] {
  if (mode === "replace") return [...extra];
  const ids = new Set(extra.map((i) => i.id));
  return [...base.filter((i) => !ids.has(i.id)), ...extra];
}

// --- formatting -------------------------------------------------------------------------------

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${(n * 100).toFixed(1)}%`;
const up = (l: string) => l.toUpperCase();

function matrixText(m: EvalMetrics): string[] {
  const head = ["expected \\ got", ...LEVELS.map(up)];
  const rows = LEVELS.map((e) => [up(e), ...LEVELS.map((g) => String(m.matrix[e][g]))]);
  const w = head.map((_, c) => Math.max(...[head, ...rows].map((r) => (r[c] as string).length)));
  const fmt = (r: string[]) => r.map((x, c) => x.padEnd(w[c] as number)).join("  ");
  return [fmt(head), ...rows.map(fmt)].map((l) => `    ${l}`);
}

function metricsText(title: string, m: EvalMetrics): string[] {
  if (!m.n) return [`  ${title}: no items`];
  const out = [
    `  ${title} (${m.n} items): accuracy ${pct(m.accuracy)} · rated lower ${m.under} · higher ${m.over}`,
    "    level     support  predicted  precision  recall",
  ];
  for (const l of LEVELS) {
    const s = m.perLevel[l];
    out.push(
      `    ${up(l).padEnd(8)}  ${String(s.support).padStart(7)}  ${String(s.predicted).padStart(9)}  ${pct(s.precision).padStart(9)}  ${pct(s.recall).padStart(6)}`,
    );
  }
  const w = m.warn;
  out.push(
    `    warn (HIGH+): false negatives ${w.falseNegatives}/${w.positives} (FNR ${pct(w.fnr)}) · false positives ${w.falsePositives}/${w.negatives} (FPR ${pct(w.fpr)})`,
    `    HIGH+ recall ${pct(w.highRecall)} · LOW false-warn ${pct(w.lowFalseWarn)} (LOW raised at all ${pct(w.lowRaised)}) · CRITICAL precision ${pct(w.criticalPrecision)}${w.criticalMissed ? ` · CRITICAL missed ${w.criticalMissed}` : ""}`,
    "    confusion matrix",
    ...matrixText(m),
  );
  return out;
}

function runText(r: EvalRun): string[] {
  const out = [
    r.label === "jev" ? "Jev (heuristic + model, the model can only raise)" : "heuristic",
  ];
  out.push(...metricsText("core (clear cases)", r.core));
  out.push(...metricsText("debatable", r.debatable));
  const m = r.model;
  if (m)
    out.push(
      `  model: ${m.provider}${m.model ? `:${m.model}` : ""} · answered ${m.answered}/${m.asked} · raised ${m.raised} (toward the label ${m.raisedRight}, above it ${m.raisedWrong}) · latency p50 ${m.latencyMs.p50 ?? "–"} ms p95 ${m.latencyMs.p95 ?? "–"} ms · cost ${m.usd === null ? "unknown" : `$${m.usd.toFixed(4)}`} · ${Object.entries(
        m.statuses,
      )
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}`,
    );
  if (r.mismatches.length) {
    out.push(
      `  mismatches with the labels (${r.mismatches.length}; labels and weights were not touched):`,
    );
    for (const x of r.mismatches)
      out.push(
        `    ${x.id.padEnd(10)} labelled ${up(x.expected).padEnd(8)} rated ${up(x.got).padEnd(8)} score ${String(x.score).padStart(3)}  ${x.direction === "under" ? "UNDER" : "OVER "}  [${x.rules.join(" ") || "-"}]${x.debatable ? " debatable" : ""}${x.lookalike ? " lookalike" : ""}${x.raised ? " model-raised" : ""}`,
      );
  } else out.push("  no mismatches with the labels");
  return out;
}

export function formatSecurityEval(r: SecurityEvalReport): string {
  const lines = [
    `security eval · ${r.set.items} items (${r.set.core} core, ${r.set.debatable} debatable, ${r.set.lookalikes} look-alikes) · set ${r.set.hash} · ${new Date(r.ts).toISOString()}`,
    "advice only: nothing here changes labels or weights",
    "",
    ...runText(r.heuristic),
  ];
  if (r.jev) lines.push("", ...runText(r.jev));
  for (const s of r.skipped) lines.push("", `skipped ${s.provider}: ${s.reason}`);
  lines.push("", "design targets (heuristic, core items):");
  for (const c of r.acceptance)
    lines.push(
      `  ${c.ok === null ? "n/a " : c.ok ? "pass" : "FAIL"}  ${c.name} ${pct(c.value)} (target ${c.target})`,
    );
  return lines.join("\n");
}
