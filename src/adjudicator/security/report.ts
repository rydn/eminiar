/**
 * Payload builders of the Adjudicator tab's security panel (docs/design/adjudicator-security.md
 * part 5, §13). Pure over what is already stored: they read db.security and one meta key and
 * answer counts, ids, tags, reason codes and the 80-char redacted head a row kept; never a tool
 * argument, a path, a matched text or a raw MCP server name.
 *
 * The routes live in src/ui/security-api.ts; the web client mirrors these shapes in
 * src/ui/web/api.ts (that bundle cannot import this file: it pulls node modules in).
 */

import type { AdjudicatorConfig } from "../../config.js";
import type { StorageAdapter } from "../../storage/adapter.js";
import type { SecurityRow, SecuritySummary } from "../../storage/types.js";
import { type AssessmentView, explain, viewOfRow } from "./advice.js";
import { levelRank } from "./combine.js";
import type { Level, RiskBadge, SecurityModelSetting, SecuritySurface } from "./types.js";

/** The meta key `security eval` saves its report under (shown on the panel). */
export const SECURITY_EVAL_META_KEY = "adjudicator:security:eval:last";
/** The list of newest HIGH and CRITICAL assessments. */
export const RECENT_MAX = 20;
/** The list of the worst assessments of the window. */
export const WORST_MAX = 10;
/** How many of the newest HIGH+ rows `worst` is picked from. */
export const WORST_SCAN = 500;

/**
 * Whether the model part can run: off · ready (security.model "provider" with the adjudicator on
 * and Jev, its only provider with the security questions, configured) · adjudicator-off ·
 * unsupported (another provider is configured). Config only; no key or consent is looked at here.
 */
export type SecurityModelState = "off" | "ready" | "adjudicator-off" | "unsupported";

export function modelState(a: Pick<AdjudicatorConfig, "enabled" | "provider" | "security">) {
  if (a.security.model !== "provider") return "off" satisfies SecurityModelState;
  if (!a.enabled) return "adjudicator-off" satisfies SecurityModelState;
  return a.provider === "typesafe"
    ? ("ready" satisfies SecurityModelState)
    : ("unsupported" satisfies SecurityModelState);
}

/** The gate the dashboard reads from the overview (GET /api/adjudicator). */
export interface SecurityOverviewFlag {
  enabled: boolean;
  model: SecurityModelSetting;
}

export function overviewFlag(a: Pick<AdjudicatorConfig, "security">): SecurityOverviewFlag {
  return { enabled: a.security.enabled, model: a.security.model };
}

/** Security is off: nothing was read. */
export interface SecurityInactive {
  active: false;
  reason: "disabled";
  now: number;
}

export type RiskLegs = RiskBadge["legs"];

/** One HIGH or CRITICAL assessment of the lists. */
export interface SecurityRecentItem {
  id: number;
  ts: number;
  surface: SecuritySurface;
  level: Level;
  score: number;
  /** The agent type or role, reduced to [A-Za-z0-9_.:@/-]. */
  agentType: string | null;
  runId: string | null;
  taskId: number | null;
  /** The redacted head of the assessed text (at most 80 characters); null when it is not kept. */
  head: string | null;
  legs: RiskLegs;
  /** Rule and floor ids that fired. */
  rules: string[];
  remedy: string | null;
  /** At most 5 reasons. */
  reasons: string[];
  /** The model's level is above the heuristic's. */
  raised: boolean;
  modelStatus: string;
}

export interface SecurityContribution {
  /** Assessments without a model answer. */
  heuristicOnly: number;
  modelRaised: number;
  modelLower: number;
  modelAgreed: number;
  /** modelRaised / answered assessments; null before any answer. */
  raisedRate: number | null;
  /** matrix[heuristic level][final level]. */
  matrix: SecuritySummary["matrix"];
  byStatus: Record<string, number>;
}

export interface SecurityReport {
  active: true;
  model: {
    /** security.model as configured. */
    setting: SecurityModelSetting;
    status: SecurityModelState;
    /** The configured adjudicator provider id. */
    provider: string;
    /** Assessments in the window the model answered. */
    answered: number;
  };
  totals: {
    n: number;
    byLevel: SecuritySummary["byLevel"];
    bySurface: SecuritySummary["bySurface"];
  };
  perDay: SecuritySummary["perDay"];
  rules: SecuritySummary["rules"];
  contribution: SecurityContribution;
  /** The newest HIGH and CRITICAL assessments, newest first. */
  recent: SecurityRecentItem[];
  /** The worst ones of the window: by level, then score (a CRITICAL can score below a HIGH). */
  worst: SecurityRecentItem[];
  /** The last `security eval` report without item text, or null. */
  lastEval: Record<string, unknown> | null;
  since: number | null;
  now: number;
}

/** What the assessment drawer shows: the stored row's columns and its full view. */
export interface SecurityAssessmentPayload {
  active: true;
  assessment: {
    id: number;
    ts: number;
    surface: SecuritySurface;
    agentType: string | null;
    runId: string | null;
    taskId: number | null;
    adjudicationId: number | null;
    head: string | null;
    noted: boolean;
    version: string;
  };
  view: AssessmentView;
  /** explain(view): the long text form. */
  text: string;
  now: number;
}

/** The try-it answer: the heuristic assessment of a text; nothing was stored and the text is not echoed. */
export interface SecurityTryItPayload {
  active: true;
  view: AssessmentView;
  badge: RiskBadge;
  text: string;
  persisted: false;
  chars: number;
  now: number;
}

// --- helpers ----------------------------------------------------------------------------------

/** Names that came from outside never reach the page with markup or control characters in them. */
export function safeName(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s.replace(/[^A-Za-z0-9_.:@/-]/g, "").slice(0, 128);
  return out || null;
}

/** Worst first: by level, then score, then newest. Score alone would rank a low-scoring CRITICAL under a HIGH. */
export function compareRisk(
  a: Pick<SecurityRecentItem, "level" | "score" | "ts" | "id">,
  b: Pick<SecurityRecentItem, "level" | "score" | "ts" | "id">,
): number {
  return levelRank(b.level) - levelRank(a.level) || b.score - a.score || b.ts - a.ts || b.id - a.id;
}

export function recentItem(row: SecurityRow): SecurityRecentItem {
  const badge = viewOfRow(row).detail.badge;
  return {
    id: row.id,
    ts: row.ts,
    surface: row.surface,
    level: row.level,
    score: row.score,
    agentType: safeName(row.agentType),
    runId: row.runId,
    taskId: row.taskId,
    head: row.inputHead,
    legs: badge.legs,
    rules: badge.rules,
    remedy: badge.remedy ?? null,
    reasons: badge.reasons.slice(0, 5),
    raised: row.modelLevel !== null && levelRank(row.modelLevel) > levelRank(row.heuristicLevel),
    modelStatus: row.modelStatus,
  };
}

/** Drop any `text` / `input` / `prompt` string field: a stored report must not carry item text. */
function stripText(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => stripText(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if ((k === "text" || k === "input" || k === "prompt") && typeof x === "string") continue;
    out[k] = stripText(x, depth + 1);
  }
  return out;
}

/** The last `security eval` report from the meta table; null when absent or not JSON. */
export function lastEvalOf(db: Pick<StorageAdapter, "metaGet">): Record<string, unknown> | null {
  const raw = db.metaGet(SECURITY_EVAL_META_KEY);
  if (!raw) return null;
  try {
    const v = stripText(JSON.parse(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --- the report -------------------------------------------------------------------------------

/**
 * GET /api/adjudicator/security: the window's totals, rules fired, what the model added over the
 * heuristic, the newest and the worst HIGH+ assessments and the last eval. Three indexed reads
 * (summary, the newest 20 HIGH+, the newest 500 HIGH+) and one meta read.
 */
export function securityReport(
  db: StorageAdapter,
  a: Pick<AdjudicatorConfig, "enabled" | "provider" | "security">,
  o: { since?: number | undefined; now: number },
): SecurityReport {
  const since = o.since;
  const s = db.security.summary(since);
  const filter = { minLevel: "high" as const, ...(since !== undefined ? { since } : {}) };
  const recent = db.security.list({ ...filter, limit: RECENT_MAX }).rows.map(recentItem);
  const scan = db.security.list({ ...filter, limit: WORST_SCAN }).rows.map(recentItem);
  const worst = scan.sort(compareRisk).slice(0, WORST_MAX);
  const answered = s.modelRaised + s.modelLower + s.modelAgreed;
  return {
    active: true,
    model: {
      setting: a.security.model,
      status: modelState(a),
      provider: a.provider,
      answered,
    },
    totals: { n: s.total, byLevel: s.byLevel, bySurface: s.bySurface },
    perDay: s.perDay,
    rules: s.rules,
    contribution: {
      heuristicOnly: s.heuristicOnly,
      modelRaised: s.modelRaised,
      modelLower: s.modelLower,
      modelAgreed: s.modelAgreed,
      raisedRate: answered ? s.modelRaised / answered : null,
      matrix: s.matrix,
      byStatus: s.byStatus,
    },
    recent,
    worst,
    lastEval: lastEvalOf(db),
    since: since ?? null,
    now: o.now,
  };
}

/** GET /api/adjudicator/security/assessment: one stored row, rebuilt through viewOfRow. */
export function assessmentPayload(row: SecurityRow, now: number): SecurityAssessmentPayload {
  const view = viewOfRow(row);
  const agentType = safeName(row.agentType);
  return {
    active: true,
    assessment: {
      id: row.id,
      ts: row.ts,
      surface: row.surface,
      agentType,
      runId: row.runId,
      taskId: row.taskId,
      adjudicationId: row.adjudicationId,
      head: row.inputHead,
      noted: row.noted,
      version: row.version,
    },
    view,
    text: explain(view, {
      surface: row.surface,
      ts: row.ts,
      agentType,
      runId: row.runId,
      taskId: row.taskId,
    }),
    now,
  };
}
