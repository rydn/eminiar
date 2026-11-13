/**
 * Pure helpers for the security panel and the shared risk components (no Preact, no DOM) so the
 * node test suite covers them: the gate, the level table (glyph, word, tone), leg chips, rule and
 * floor labels, the distribution, the heuristic-vs-model matrix, the try-it input and the last
 * eval facts.
 *
 * Types are type-only and come from the web-safe leaf src/adjudicator/security/types.ts, so this
 * file loads under node. Ordering is always the server's (level, then score): nothing here
 * sorts by score alone.
 */
import type {
  Cap,
  CapTag,
  Level,
  RiskBadge,
  RiskLeg,
} from "../../../adjudicator/security/types.js";

export type SecTone = "ok" | "warn" | "bad" | "muted" | "accent";

/** The gate the panel reads; AdjOverview in ../api.ts satisfies it. */
export interface SecurityGateInput {
  security?: { enabled?: boolean } | undefined;
}

/**
 * Mount the panel only when the overview says security is on. The API answers `{active:false}`
 * when it is off; the panel also renders nothing for that.
 */
export function securityActive(ov: SecurityGateInput | null | undefined): boolean {
  return !!ov && ov.security?.enabled === true;
}

/** The API's own gate field: true only for an active report/assessment/try-it payload. */
export function payloadActive(p: { active?: boolean } | null | undefined): boolean {
  return !!p && p.active === true;
}

// --- levels ------------------------------------------------------------------------------

export const LEVEL_ORDER: readonly Level[] = ["low", "medium", "high", "critical"];

/** Glyph + word per level: risk never relies on colour alone. */
export const LEVEL_INFO: Record<
  Level,
  { glyph: string; label: string; tone: SecTone; help: string }
> = {
  low: { glyph: "○", label: "low", tone: "ok", help: "no complete risky combination" },
  medium: {
    glyph: "◐",
    label: "medium",
    tone: "warn",
    help: "some exposure; recorded, advice only",
  },
  high: {
    glyph: "▲",
    label: "high",
    tone: "bad",
    help: "a complete risky combination: review before it runs",
  },
  critical: {
    glyph: "⬢",
    label: "critical",
    tone: "bad",
    help: "a fixed critical trigger: do not run unattended",
  },
};

export function levelInfo(l: string | null | undefined) {
  return LEVEL_INFO[(l as Level) ?? "low"] ?? LEVEL_INFO.low;
}

export function levelRank(l: string | null | undefined): number {
  const i = LEVEL_ORDER.indexOf(l as Level);
  return i < 0 ? -1 : i;
}

/** The accessible text of a badge: "high risk, score 62". */
export function badgeLabel(level: string, score?: number | null): string {
  const li = levelInfo(level);
  return typeof score === "number" && Number.isFinite(score)
    ? `${li.label} risk, score ${Math.round(score)}`
    : `${li.label} risk`;
}

// --- legs --------------------------------------------------------------------------------

export const CAP_NAME: Record<Cap, string> = {
  U: "untrusted input",
  S: "sensitive read",
  E: "egress",
  X: "code execution",
  W: "local write",
  D: "destructive",
  P: "privilege",
  T: "tool supply",
};

export const CAP_TAG_LABEL: Record<CapTag, string> = {
  "untrusted-input": "untrusted input",
  "sensitive-read": "sensitive read",
  egress: "egress",
  "code-exec": "code execution",
  "local-write": "local write",
  destructive: "destructive",
  privilege: "privilege",
  "tool-supply": "tool supply",
};

/** none < .2, weak < .5, mid < .8, strong otherwise. */
export function legBand(e: number | null | undefined): "none" | "weak" | "mid" | "strong" {
  const v = typeof e === "number" && Number.isFinite(e) ? e : 0;
  if (v < 0.2) return "none";
  if (v < 0.5) return "weak";
  if (v < 0.8) return "mid";
  return "strong";
}

export interface LegChip {
  cap: "U" | "S" | "E";
  name: string;
  /** 0..100 */
  pct: number;
  band: "none" | "weak" | "mid" | "strong";
  /** Where the exposure came from, when known. */
  from: string | null;
  title: string;
}

const clampPct = (e: number | null | undefined): number =>
  typeof e === "number" && Number.isFinite(e) ? Math.max(0, Math.min(100, Math.round(e * 100))) : 0;

/** The U, S, E chips of a badge, in that order. */
export function legChips(legs: RiskBadge["legs"] | null | undefined): LegChip[] {
  return (["U", "S", "E"] as const).map((cap) => {
    const leg: RiskLeg | undefined = legs?.[cap];
    const pct = clampPct(leg?.e);
    const from = leg?.from ? String(leg.from) : null;
    const kind = leg?.kind ? `${leg.kind}: ` : "";
    return {
      cap,
      name: CAP_NAME[cap],
      pct,
      band: legBand(leg?.e),
      from,
      title: from
        ? `${CAP_NAME[cap]} ${pct}% (${kind}${from})`
        : `${CAP_NAME[cap]} ${pct}%${pct ? "" : " (none)"}`,
    };
  });
}

// --- rules and floors --------------------------------------------------------------------

export const RULE_LABEL: Record<string, string> = {
  R1: "lethal trifecta: untrusted input, sensitive read and egress",
  R2: "rule of two: two of the three legs plus a risky capability",
  R3: "untrusted input that can execute code",
  R4: "tool supply that can execute code",
  R5: "untrusted input with destructive or privileged actions",
  R6: "untrusted input that can write a persistence path",
  R7: "sensitive read that can leave, with no untrusted input",
  "H-R1": "raised to HIGH by R1",
  "H-R2": "raised to HIGH by R2",
  "H-R3": "raised to HIGH by R3",
  "H-R6": "raised to HIGH by R6",
  C1: "the full trifecta, running without anyone to confirm",
  C2: "every trifecta leg is strong, and the task itself reads secrets or sends data out",
  C3: "a named secret can leave through an egress action",
  C4: "fetches remote code and runs it",
  C5: "untrusted input can write a persistence path, running without anyone to confirm",
  C6: "the text tries to override the rules, exfiltrate or hide what it does, and the grant can egress or execute",
};

export function ruleLabel(id: string): string {
  return RULE_LABEL[id] ?? "a security rule";
}

/** Floors (H-*, C*) are the ones that decide the level. */
export function isFloor(id: string): boolean {
  return /^(H-R\d|C\d)$/.test(id);
}

// --- remedy ------------------------------------------------------------------------------

/** The remedy as one line, or null. Text only: callers render it as a text node. */
export function remedyText(r: string | { line?: string; text?: string } | null | undefined) {
  if (!r) return null;
  const s = typeof r === "string" ? r : (r.line ?? r.text ?? "");
  const t = s.trim();
  return t ? t : null;
}

// --- surfaces and model state --------------------------------------------------------------

export const SURFACE_LABEL: Record<string, string> = {
  agent: "agent dispatch",
  plan: "swarm plan",
  prompt: "prompt",
  mcp: "MCP tool",
};

export function surfaceLabel(s: string): string {
  return SURFACE_LABEL[s] ?? s;
}

export interface ModelInput {
  setting: "off" | "provider";
  status: "off" | "ready" | "adjudicator-off" | "unsupported";
  provider: string;
  answered: number;
}

/** A short text and tone for the model status. */
export function modelState(m: ModelInput | null | undefined): {
  label: string;
  tone: SecTone;
  help: string;
} {
  if (!m) return { label: "unknown", tone: "muted", help: "no model information" };
  switch (m.status) {
    case "ready":
      return {
        label: `Jev ready (${m.provider})`,
        tone: "ok",
        help: "the provider answers security questions with its dispatch advice; it can only raise a level",
      };
    case "adjudicator-off":
      return {
        label: "needs the adjudicator",
        tone: "warn",
        help: "security.model is on but the adjudicator is disabled: the heuristic answers alone",
      };
    case "unsupported":
      return {
        label: "provider unsupported",
        tone: "warn",
        help: "the configured provider has no security questions: the heuristic answers alone",
      };
    default:
      return {
        label: "heuristic only",
        tone: "muted",
        help: "security.model is off: no text or tool ids leave the machine for security",
      };
  }
}

// --- distribution --------------------------------------------------------------------------

export interface DaySegments {
  day: string;
  total: number;
  /** Heights as a share of the tallest day (0..1), lowest level first. */
  segs: Array<{ level: Level; n: number; share: number }>;
}

/** Stacked LOW to CRITICAL columns for the per-day chart. */
export function daySegments(
  rows: Array<{ day: string } & Record<Level, number>> | null | undefined,
): DaySegments[] {
  const list = rows ?? [];
  const totals = list.map((r) => LEVEL_ORDER.reduce((s, l) => s + (r[l] || 0), 0));
  const max = Math.max(0, ...totals);
  return list.map((r, i) => ({
    day: r.day,
    total: totals[i] ?? 0,
    segs: LEVEL_ORDER.map((level) => ({
      level,
      n: r[level] || 0,
      share: max > 0 ? (r[level] || 0) / max : 0,
    })),
  }));
}

export interface LevelShare {
  level: Level;
  n: number;
  /** 0..1 of all assessments */
  share: number;
}

/** The level split, highest first so the worst reads first. */
export function levelShares(byLevel: Record<Level, number> | null | undefined): LevelShare[] {
  const total = LEVEL_ORDER.reduce((s, l) => s + (byLevel?.[l] || 0), 0);
  return [...LEVEL_ORDER].reverse().map((level) => ({
    level,
    n: byLevel?.[level] || 0,
    share: total > 0 ? (byLevel?.[level] || 0) / total : 0,
  }));
}

/** Surfaces by count, largest first (ties by name so the order is stable). */
export function surfaceShares(
  bySurface: Record<string, number> | null | undefined,
): Array<{ surface: string; n: number }> {
  return Object.entries(bySurface ?? {})
    .filter(([, n]) => n > 0)
    .map(([surface, n]) => ({ surface, n }))
    .sort((a, b) => b.n - a.n || a.surface.localeCompare(b.surface));
}

/** Rules fired with a bar share relative to the most frequent one (the server's order is kept). */
export function ruleBars(
  rules: Array<{ id: string; n: number }> | null | undefined,
): Array<{ id: string; n: number; share: number; label: string }> {
  const list = rules ?? [];
  const max = Math.max(0, ...list.map((r) => r.n));
  return list.map((r) => ({
    id: r.id,
    n: r.n,
    share: max > 0 ? r.n / max : 0,
    label: ruleLabel(r.id),
  }));
}

// --- heuristic vs model --------------------------------------------------------------------

export interface MatrixView {
  total: number;
  max: number;
  /** Cells whose final level equals the heuristic's are the diagonal. */
  rows: Array<{
    heuristic: Level;
    cells: Array<{ final: Level; n: number; diag: boolean; raised: boolean; lowered: boolean }>;
  }>;
}

/** matrix[heuristic][final] as a 4×4 grid, tolerant of missing rows. */
export function matrixView(m: Record<Level, Record<Level, number>> | null | undefined): MatrixView {
  let total = 0;
  let max = 0;
  const rows = LEVEL_ORDER.map((heuristic) => ({
    heuristic,
    cells: LEVEL_ORDER.map((final) => {
      const n = m?.[heuristic]?.[final] || 0;
      total += n;
      if (n > max) max = n;
      return {
        final,
        n,
        diag: heuristic === final,
        raised: levelRank(final) > levelRank(heuristic),
        lowered: levelRank(final) < levelRank(heuristic),
      };
    }),
  }));
  return { total, max, rows };
}

/** "—" or "12%". */
export function pct(x: number | null | undefined): string {
  return typeof x === "number" && Number.isFinite(x) ? `${Math.round(x * 100)}%` : "—";
}

export interface ContributionInput {
  heuristicOnly: number;
  modelRaised: number;
  modelLower: number;
  modelAgreed: number;
  raisedRate: number | null;
}

/** The one-line summary under the matrix. */
export function contributionLine(c: ContributionInput | null | undefined): string {
  if (!c) return "";
  const answered = c.modelRaised + c.modelLower + c.modelAgreed;
  if (!answered) {
    return c.heuristicOnly
      ? `${c.heuristicOnly} assessed by the heuristic alone; the model has not answered yet`
      : "";
  }
  return `the model answered ${answered}: raised ${c.modelRaised} (${pct(c.raisedRate)}) · agreed ${c.modelAgreed}${
    c.modelLower ? ` · answered lower ${c.modelLower} (the heuristic level stood)` : ""
  } · heuristic alone ${c.heuristicOnly}`;
}

// --- items ---------------------------------------------------------------------------------

/** "agent dispatch · explore · run 3f2a · task 12" with only what is known. */
export function itemMeta(i: {
  surface: string;
  agentType: string | null;
  runId: string | null;
  taskId: number | null;
}): string {
  const parts = [surfaceLabel(i.surface)];
  if (i.agentType) parts.push(i.agentType);
  if (i.runId) parts.push(`run ${i.runId.slice(0, 8)}`);
  if (i.taskId !== null && i.taskId !== undefined) parts.push(`task #${i.taskId}`);
  return parts.join(" · ");
}

/** The id and head the list shows; the head is already redacted server-side and capped at 80. */
export function itemHead(head: string | null | undefined): string {
  const h = (head ?? "").replace(/\s+/g, " ").trim();
  return h ? (h.length > 80 ? `${h.slice(0, 79)}…` : h) : "(no text kept)";
}

// --- try it --------------------------------------------------------------------------------

export interface TryItForm {
  text: string;
  tools: string;
  autonomy: "manual" | "default" | "autonomous";
}

export interface TryItBody {
  text: string;
  tools?: string[];
  autonomy?: "manual" | "default" | "autonomous";
}

/** Split a comma, space or newline separated tool list; at most 40, each at most 80 chars. */
export function parseTools(s: string): string[] {
  const seen = new Set<string>();
  for (const t of s.split(/[\s,]+/)) {
    const v = t.trim();
    if (v && v.length <= 80) seen.add(v);
    if (seen.size >= 40) break;
  }
  return [...seen];
}

/** The POST body: null when there is no text. "default" autonomy is left to the server. */
export function tryItBody(f: TryItForm): TryItBody | null {
  const text = f.text.trim();
  if (!text) return null;
  const tools = parseTools(f.tools);
  const body: TryItBody = { text: f.text.slice(0, 20000) };
  if (tools.length) body.tools = tools;
  if (f.autonomy !== "default") body.autonomy = f.autonomy;
  return body;
}

// --- last eval -----------------------------------------------------------------------------

/**
 * A few facts of the last `security eval` report. Its shape is owned by security/eval.ts, so
 * this reads only top-level primitives (and a `ts`/`at` time) and shows nothing it cannot print.
 */
export function evalFacts(r: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!r || typeof r !== "object") return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(r)) {
    if (out.length >= 10) break;
    if (k === "ts" || k === "at" || k === "now") continue;
    const label = k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
    if (typeof v === "number" && Number.isFinite(v)) {
      const asRate = v >= 0 && v <= 1 && /acc|recall|precision|rate|fpr|fnr|warn/i.test(k);
      out.push([label, asRate ? pct(v) : String(Math.round(v * 100) / 100)]);
    } else if (typeof v === "string" && v.length <= 60) {
      out.push([label, v]);
    } else if (typeof v === "boolean") {
      out.push([label, v ? "yes" : "no"]);
    }
  }
  return out;
}

/** The time of the last eval, when the report carries one. */
export function evalTime(r: Record<string, unknown> | null | undefined): number | null {
  if (!r) return null;
  for (const k of ["ts", "at", "ranAt"]) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// --- the drawer ----------------------------------------------------------------------------

export const KINDS = ["task", "grant", "latent", "taint"] as const;
export const ALL_CAPS: readonly Cap[] = ["U", "S", "E", "X", "W", "D", "P", "T"];

export interface ExposureRow {
  cap: Cap;
  name: string;
  /** Strongest exposure per kind (0..1), and where it came from. */
  cells: Array<{ kind: (typeof KINDS)[number]; e: number; from: string | null }>;
  /** The largest of the four: the capability's exposure. */
  max: number;
}

/**
 * The legs table of the drawer: one row per capability that has any exposure (U S E X W D P T),
 * one column per kind (task, grant, latent, taint).
 */
export function exposureGrid(
  exposures: Array<{ cap: Cap; e: number; kind: string; from: string }> | null | undefined,
): ExposureRow[] {
  const rows: ExposureRow[] = [];
  for (const cap of ALL_CAPS) {
    const mine = (exposures ?? []).filter((x) => x.cap === cap);
    if (!mine.length) continue;
    const cells = KINDS.map((kind) => {
      const best = mine.filter((x) => x.kind === kind).sort((a, b) => b.e - a.e)[0];
      return { kind, e: best?.e ?? 0, from: best?.from ?? null };
    });
    rows.push({ cap, name: CAP_NAME[cap], cells, max: Math.max(...cells.map((c) => c.e)) });
  }
  return rows;
}

/** "×1.20 (autonomous)". */
export function autonomyLine(a: number, autonomy: string): string {
  return `${autonomy} · score scaled ×${(Number.isFinite(a) ? a : 1).toFixed(2)}`;
}
