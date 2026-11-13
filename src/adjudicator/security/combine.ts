/**
 * Blend the heuristic assessment with the model's answer (design part 3 §7). The model can only
 * raise: level = max(heuristic, model), score = max(heuristic, model score), and the model never
 * produces CRITICAL (only the fixed heuristic floors do), so injected text that steers the
 * model low changes nothing. A missing or failed model answer leaves the heuristic as it was.
 *
 * Pure: no I/O.
 */

import type { MinLevel } from "../types.js";
import { TIERS, type Tier } from "../types.js";
import {
  type Cap,
  type HeuristicAssessment,
  LEVELS,
  type Level,
  type RiskBadge,
  type RiskLeg,
  SECURITY_VERSION,
  type SecurityAction,
  type SecurityAssessment,
  type SecurityModelAnswer,
  type SecurityModelStatus,
  THREATS,
} from "./types.js";

/** A model that says "high" needs a severity at least this and one threat at least NOUL_HIGH. */
export const SEVERITY_HIGH = 3;
export const SEVERITY_MEDIUM = 2;
export const NOUL_HIGH = 0.7;

export const levelRank = (level: Level): number => LEVELS.indexOf(level);
export const maxLevel = (a: Level, b: Level): Level => (levelRank(b) > levelRank(a) ? b : a);

/** low → allow, medium → advise, high and critical → warn. Advice only: nothing is ever denied. */
export function securityAction(level: Level): SecurityAction {
  if (level === "low") return "allow";
  return level === "medium" ? "advise" : "warn";
}

/** Is `level` at or above the configured line threshold (security.minLevel)? */
export function meetsMinLevel(level: Level, min: MinLevel): boolean {
  return levelRank(level) >= levelRank(min);
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The model's answer cleaned up: severity clamped to 0..4, threats to 0..1, junk dropped. */
export function cleanAnswer(
  answer: SecurityModelAnswer | undefined,
): SecurityModelAnswer | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const threats: SecurityModelAnswer["threats"] = {};
  let any = false;
  for (const t of THREATS) {
    const v = answer.threats?.[t];
    if (typeof v === "number" && Number.isFinite(v)) {
      threats[t] = clamp(v, 0, 1);
      any = true;
    }
  }
  const sev = answer.severity;
  const out: SecurityModelAnswer = { threats };
  if (sev && typeof sev.value === "number" && Number.isFinite(sev.value)) {
    const conf =
      typeof sev.confidence === "number" && Number.isFinite(sev.confidence) ? sev.confidence : 1;
    out.severity = { value: clamp(sev.value, 0, 4), confidence: clamp(conf, 0, 1) };
    any = true;
  }
  return any ? out : undefined;
}

/**
 * The level the model alone gives: HIGH when severity ≥ 3 and some threat ≥ .7, MEDIUM when
 * severity ≥ 2 or some threat ≥ .7, else LOW. Never CRITICAL. Expects a cleaned answer.
 */
export function modelLevel(answer: SecurityModelAnswer): Level {
  const sev = answer.severity?.value ?? 0;
  let top = 0;
  for (const t of THREATS) top = Math.max(top, answer.threats[t] ?? 0);
  if (sev >= SEVERITY_HIGH && top >= NOUL_HIGH) return "high";
  if (sev >= SEVERITY_MEDIUM || top >= NOUL_HIGH) return "medium";
  return "low";
}

export interface CombineOptions {
  /**
   * Why there may be no model answer: "off", "unsupported", "none" or a provider status. A status
   * other than "ok" discards the answer. Default: "ok" when the answer is usable, else "none".
   */
  status?: SecurityModelStatus;
  /** Where the assessment was made; default "blend" when the model answered, else "heuristic". */
  source?: SecurityAssessment["source"];
}

/** Blend: the model can raise the level and score, never lower them and never reach CRITICAL. */
export function combine(
  h: HeuristicAssessment,
  answer?: SecurityModelAnswer,
  opts: CombineOptions = {},
): SecurityAssessment {
  const cleaned = opts.status && opts.status !== "ok" ? undefined : cleanAnswer(answer);
  const status: SecurityModelStatus = cleaned
    ? "ok"
    : opts.status && opts.status !== "ok"
      ? opts.status
      : "none";
  if (!cleaned) {
    return {
      version: SECURITY_VERSION,
      level: h.level,
      score: h.score,
      action: securityAction(h.level),
      heuristic: h,
      modelStatus: status,
      source: opts.source ?? "heuristic",
    };
  }
  const level = modelLevel(cleaned);
  const score = Math.round(25 * (cleaned.severity?.value ?? 0));
  const raised = levelRank(level) > levelRank(h.level);
  const final = maxLevel(h.level, level);
  return {
    version: SECURITY_VERSION,
    level: final,
    score: Math.max(h.score, score),
    action: securityAction(final),
    heuristic: h,
    model: { level, score, answer: cleaned, raised },
    modelStatus: "ok",
    source: opts.source ?? "blend",
  };
}

/**
 * On HIGH and CRITICAL, model advice never names a smaller tier than `modelFloor` (D6): returns
 * the larger of `tier` and `floor`; below HIGH the tier is returned unchanged.
 */
export function floorTier(level: Level, tier: Tier, floor: Tier): Tier {
  if (levelRank(level) < levelRank("high")) return tier;
  return TIERS.indexOf(floor) > TIERS.indexOf(tier) ? floor : tier;
}

// --- the UI badge --------------------------------------------------------------------------------

const KIND_ORDER = { task: 0, taint: 1, grant: 2, latent: 3 } as const;

function leg(h: HeuristicAssessment, cap: Cap): RiskLeg {
  const k = h.caps[cap];
  const e = Math.max(k.task, k.grant, k.taint, k.latent);
  let best: HeuristicAssessment["exposures"][number] | undefined;
  for (const x of h.exposures) {
    if (x.cap !== cap) continue;
    if (!best || x.e > best.e || (x.e === best.e && KIND_ORDER[x.kind] < KIND_ORDER[best.kind]))
      best = x;
  }
  return best ? { e, kind: best.kind, from: best.from } : { e };
}

const fmtW = (w: number): string => `${w >= 0 ? "+" : ""}${w.toFixed(2)}`;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The shape the dashboard and the swarm UI show: legs U S E, the rules and floors fired, the remedy, the top reasons. */
export function riskBadge(a: SecurityAssessment): RiskBadge {
  const h = a.heuristic;
  const reasons: string[] = [];
  if (a.model?.raised) {
    const sev = a.model.answer.severity?.value;
    reasons.push(
      clip(
        `jev raised ${h.level.toUpperCase()}→${a.model.level.toUpperCase()}${sev === undefined ? "" : ` (sev ${sev.toFixed(1)})`}`,
        120,
      ),
    );
  }
  for (const r of h.reasons) {
    if (reasons.length >= 5) break;
    reasons.push(clip(`${r.feature} ${fmtW(r.weight)} ${r.note}`, 120));
  }
  const badge: RiskBadge = {
    level: a.level,
    score: a.score,
    legs: { U: leg(h, "U"), S: leg(h, "S"), E: leg(h, "E") },
    rules: [...h.rules.map((r) => r.id), ...h.floors],
    reasons,
  };
  if (h.remedy) badge.remedy = h.remedy.text;
  return badge;
}
