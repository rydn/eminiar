/**
 * The words of the security advice (docs/design/adjudicator-security.md, part 4 section 8): the
 * hook line, the message for the user, the plan block, the em_adjudicate block and the long
 * explanation. Every surface says the same things: the level and score, the three trifecta legs
 * with their sources (and the other legs when they fire), the rules and floors that fired, the one
 * leg to drop, and, when the model moved the level, by how much.
 *
 * Everything reads an AssessmentView, which is built from a live assessment (viewOf) or from a
 * stored row (viewOfRow) and carries exactly what a row's `detail` keeps, so a stored assessment
 * reads the same as the live one. Pure: no I/O, no regex built from input, and never matched text:
 * a view holds only ids, numbers, tags and reasons.
 */

import type { SecurityRow } from "../../storage/types.js";
import type { NotifyLevel, Reason } from "../types.js";
import { levelRank, meetsMinLevel, riskBadge, securityAction } from "./combine.js";
// Effect only: hands the prompt helpers to the engine, which must not import security/ itself.
import "./register.js";
import { FLOOR_NOTES, REMEDY_TEXT } from "./taxonomy.js";
import {
  AUTONOMIES,
  type Autonomy,
  CAPS,
  type Cap,
  type CueId,
  type Exposure,
  FLOOR_IDS,
  type FloorId,
  type GrantSource,
  type GrantStatus,
  type IntentCueId,
  LEVELS,
  type Level,
  type RemedyAction,
  type RiskBadge,
  type RuleHit,
  type SecurityAction,
  type SecurityAssessment,
  type SecurityModelAnswer,
  type TaskRisk,
  THREATS,
  type ToolGrant,
} from "./types.js";

/** The additionalContext line of a hook (the routing line has the same cap). */
export const HOOK_LINE_MAX = 220;
/** One task line of the plan block. */
export const PLAN_LINE_MAX = 240;
/** One item of the em_adjudicate block (em_adjudicate's COMPACT_MAX). */
export const MCP_BLOCK_MAX = 1000;
/** What the stored detail keeps, so a row stays far below its 8 KB cap. */
const DETAIL_EXPOSURES = 16;
const DETAIL_REASONS = 8;

/** Says in the plan lines and the hook note that the security floor raised a model. */
export const FLOOR_LABEL = "security floor";

// --- the view -------------------------------------------------------------------------------

/**
 * What a stored assessment keeps in `detail`, and all the text functions read. Ids, numbers and
 * tags only: the store drops argument-like keys (`text`, `path`, `url`, ...) at any depth, which is
 * why the remedy's sentence is `line` here and not `text`.
 */
export interface SecurityDetail {
  /** The format of this object, for readers of stored rows. */
  v: 1;
  /** The strongest exposures (at most 16), strongest first. */
  exposures: Exposure[];
  rules: RuleHit[];
  floors: FloorId[];
  /** The autonomy multiplier the score was scaled by. */
  a: number;
  cues: CueId[];
  intent: IntentCueId[];
  grant: {
    status: GrantStatus;
    source?: GrantSource;
    /** Provider-safe ids ("Bash", "em_execute", "mcp:saas:write"): never a raw MCP name. */
    tools: string[];
    mcpServers?: boolean;
    permissionMode?: string;
  };
  /** The untrusted-input tools the session had used, and whether the history could be read. */
  taint?: { tools: string[]; status: "ok" | "off" | "unavailable" };
  /** The model's answer, when there was one. */
  model?: { level: Level; score: number; answer: SecurityModelAnswer; raised: boolean };
  remedy?: { actions: RemedyAction[]; line: string };
  reasons: Reason[];
  /** The exact badge the dashboard and the swarm UI show (combine.ts riskBadge). */
  badge: RiskBadge;
}

/** A security assessment as the advice sees it: live (viewOf) or stored (viewOfRow). */
export interface AssessmentView {
  level: Level;
  score: number;
  action: SecurityAction;
  heuristicLevel: Level;
  heuristicScore: number;
  autonomy: Autonomy;
  /** ok, off, unsupported, none or a provider status. */
  modelStatus: string;
  /** heuristic, blend or plan (the model's answer came from the plan). */
  source: string;
  /** adjudicator_security.id, once it is stored. */
  id?: number;
  detail: SecurityDetail;
}

/** The grant as the view keeps it: ids and flags, never the raw local names. */
export type ViewGrant = Pick<ToolGrant, "tools" | "status"> &
  Partial<Pick<ToolGrant, "source" | "permissionMode" | "mcpServers">>;

/** " (MCP: github, slack)" in a reason names local servers: it is never kept. */
const LOCAL_SERVERS = / \(MCP: [^)]{0,300}\)/g;

const scrub = (s: string): string => s.replace(LOCAL_SERVERS, "");

export interface ViewOptions {
  grant: ViewGrant;
  taint?: { tools: readonly string[]; status: "ok" | "off" | "unavailable" } | undefined;
  /** "history unavailable" is a reason of its own. */
  id?: number | undefined;
}

/** The view of a live assessment. */
export function viewOf(a: SecurityAssessment, o: ViewOptions): AssessmentView {
  const h = a.heuristic;
  const unavailable = o.taint?.status === "unavailable";
  // "history unavailable" is a reason of its own, so it keeps a slot in the stored reasons
  const reasons: Reason[] = h.reasons
    .slice(0, DETAIL_REASONS - (unavailable ? 1 : 0))
    .map((r) => ({ ...r, note: scrub(r.note) }));
  if (unavailable) reasons.push({ feature: "taint", weight: 0, note: "history unavailable" });
  const badge = riskBadge(a);
  badge.reasons = badge.reasons.map(scrub);
  const detail: SecurityDetail = {
    v: 1,
    exposures: h.exposures.slice(0, DETAIL_EXPOSURES),
    rules: h.rules,
    floors: h.floors,
    a: h.a,
    cues: h.cues,
    intent: h.intent,
    grant: {
      status: o.grant.status,
      tools: [...new Set(o.grant.tools.map((t) => t.id))].slice(0, 40),
    },
    reasons,
    badge,
  };
  if (o.grant.source) detail.grant.source = o.grant.source;
  if (o.grant.mcpServers) detail.grant.mcpServers = true;
  if (o.grant.permissionMode) detail.grant.permissionMode = o.grant.permissionMode;
  if (o.taint) detail.taint = { tools: [...o.taint.tools].slice(0, 8), status: o.taint.status };
  if (a.model) detail.model = a.model;
  if (h.remedy) detail.remedy = { actions: h.remedy.actions, line: h.remedy.text };
  const v: AssessmentView = {
    level: a.level,
    score: a.score,
    action: a.action,
    heuristicLevel: h.level,
    heuristicScore: h.score,
    autonomy: h.autonomy,
    modelStatus: a.modelStatus,
    source: a.source,
    detail,
  };
  if (o.id !== undefined) v.id = o.id;
  return v;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown, d = 0): number => (typeof x === "number" && Number.isFinite(x) ? x : d);
const strs = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
const oneOf = <T extends string>(list: readonly T[], x: unknown): T | undefined =>
  typeof x === "string" && (list as readonly string[]).includes(x) ? (x as T) : undefined;

function parseExposures(x: unknown): Exposure[] {
  if (!Array.isArray(x)) return [];
  const out: Exposure[] = [];
  for (const e of x) {
    if (!isObj(e)) continue;
    const cap = oneOf(CAPS, e.cap);
    const kind = oneOf(["task", "grant", "latent", "taint"] as const, e.kind);
    if (cap && kind && typeof e.from === "string")
      out.push({ cap, e: num(e.e), kind, from: e.from });
  }
  return out;
}

function parseRules(x: unknown): RuleHit[] {
  if (!Array.isArray(x)) return [];
  const out: RuleHit[] = [];
  for (const r of x) {
    if (!isObj(r) || typeof r.id !== "string") continue;
    const factors = Array.isArray(r.factors)
      ? r.factors.flatMap((f) => {
          const cap = isObj(f) ? oneOf(CAPS, f.cap) : undefined;
          return cap && isObj(f) ? [{ cap, e: num(f.e) }] : [];
        })
      : [];
    out.push({
      id: r.id as RuleHit["id"],
      factors,
      min: num(r.min),
      k: num(r.k),
      add: num(r.add),
    });
  }
  return out;
}

function parseAnswer(x: unknown): SecurityModelAnswer | undefined {
  if (!isObj(x)) return undefined;
  const threats: SecurityModelAnswer["threats"] = {};
  if (isObj(x.threats))
    for (const t of THREATS) {
      const p = (x.threats as Record<string, unknown>)[t];
      if (typeof p === "number" && Number.isFinite(p)) threats[t] = p;
    }
  const out: SecurityModelAnswer = { threats };
  if (
    isObj(x.severity) &&
    typeof x.severity.value === "number" &&
    Number.isFinite(x.severity.value)
  )
    out.severity = { value: x.severity.value, confidence: num(x.severity.confidence, 1) };
  return out;
}

function parseBadge(x: unknown, fallback: RiskBadge): RiskBadge {
  if (!isObj(x) || !oneOf(LEVELS, x.level) || !isObj(x.legs)) return fallback;
  const leg = (k: "U" | "S" | "E"): RiskBadge["legs"]["U"] => {
    const l = (x.legs as Record<string, unknown>)[k];
    if (!isObj(l)) return { e: 0 };
    const out: RiskBadge["legs"]["U"] = { e: num(l.e) };
    const kind = oneOf(["task", "grant", "latent", "taint"] as const, l.kind);
    if (kind) out.kind = kind;
    if (typeof l.from === "string") out.from = l.from;
    return out;
  };
  const badge: RiskBadge = {
    level: x.level as Level,
    score: num(x.score),
    legs: { U: leg("U"), S: leg("S"), E: leg("E") },
    rules: strs(x.rules),
    reasons: strs(x.reasons).slice(0, 5),
  };
  if (typeof x.remedy === "string") badge.remedy = x.remedy;
  return badge;
}

/** The detail JSON of a stored row, checked; undefined when it is not ours (or an older format). */
export function parseDetail(raw: unknown, fallback: RiskBadge): SecurityDetail | undefined {
  if (!isObj(raw) || raw.v !== 1) return undefined;
  const g = isObj(raw.grant) ? raw.grant : {};
  const detail: SecurityDetail = {
    v: 1,
    exposures: parseExposures(raw.exposures),
    rules: parseRules(raw.rules),
    floors: strs(raw.floors).filter((f): f is FloorId => FLOOR_IDS.includes(f as FloorId)),
    a: num(raw.a, 1),
    cues: strs(raw.cues) as CueId[],
    intent: strs(raw.intent) as IntentCueId[],
    grant: {
      status: oneOf(["known", "inherit", "unknown"] as const, g.status) ?? "unknown",
      tools: strs(g.tools),
    },
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.flatMap((r) =>
          isObj(r) && typeof r.feature === "string" && typeof r.note === "string"
            ? [{ feature: r.feature, weight: num(r.weight), note: r.note }]
            : [],
        )
      : [],
    badge: parseBadge(raw.badge, fallback),
  };
  const source = oneOf(
    ["role", "agent-file", "builtin", "fork", "caller", "session"] as const,
    g.source,
  );
  if (source) detail.grant.source = source;
  if (g.mcpServers === true) detail.grant.mcpServers = true;
  if (typeof g.permissionMode === "string") detail.grant.permissionMode = g.permissionMode;
  if (isObj(raw.taint)) {
    const status = oneOf(["ok", "off", "unavailable"] as const, raw.taint.status);
    if (status) detail.taint = { tools: strs(raw.taint.tools), status };
  }
  if (isObj(raw.model)) {
    const level = oneOf(LEVELS, raw.model.level);
    const answer = parseAnswer(raw.model.answer);
    if (level && answer)
      detail.model = {
        level,
        score: num(raw.model.score),
        answer,
        raised: raw.model.raised === true,
      };
  }
  if (isObj(raw.remedy) && Array.isArray(raw.remedy.actions) && typeof raw.remedy.line === "string")
    detail.remedy = {
      actions: raw.remedy.actions.filter(isObj).map((a) => a as unknown as RemedyAction),
      line: raw.remedy.line,
    };
  return detail;
}

/** The badge a row without a readable detail can still show: its level, score and rule ids. */
function plainBadge(row: SecurityRow): RiskBadge {
  const badge: RiskBadge = {
    level: row.level,
    score: row.score,
    legs: { U: { e: 0 }, S: { e: 0 }, E: { e: 0 } },
    rules: row.rules,
    reasons: [],
  };
  return badge;
}

/**
 * The view of a stored row. A row whose detail is missing, truncated or from another format still
 * has its columns, so the view shows the level, score, rules and model status without the legs.
 */
export function viewOfRow(row: SecurityRow): AssessmentView {
  const plain = plainBadge(row);
  const detail = parseDetail(row.detail, plain) ?? {
    v: 1 as const,
    exposures: [],
    rules: [],
    floors: row.rules.filter((r): r is FloorId => FLOOR_IDS.includes(r as FloorId)),
    a: 1,
    cues: [],
    intent: [],
    grant: {
      status: oneOf(["known", "inherit", "unknown"] as const, row.grantStatus) ?? "unknown",
      tools: [],
    },
    reasons: [],
    badge: plain,
  };
  return {
    level: row.level,
    score: row.score,
    action: row.action,
    heuristicLevel: row.heuristicLevel,
    heuristicScore: row.heuristicScore,
    autonomy: oneOf(AUTONOMIES, row.autonomy) ?? "default",
    modelStatus: row.modelStatus,
    source: row.source,
    id: row.id,
    detail,
  };
}

/** The badge of a stored row (RoleRisk and TaskRisk are built from it). */
export function badgeOfRow(row: SecurityRow): RiskBadge {
  return viewOfRow(row).detail.badge;
}

/** A task's latest stored assessment as the swarm UI shows it. */
export function taskRiskOfRow(row: SecurityRow): TaskRisk {
  return {
    ...badgeOfRow(row),
    surface: row.surface === "agent" ? "agent" : "plan",
    id: row.id,
    ts: row.ts,
    modelRaised:
      row.modelLevel !== null && levelRank(row.modelLevel) > levelRank(row.heuristicLevel),
  };
}

// --- who sees a line --------------------------------------------------------------------------

/** Is a line shown at all? LOW never is, MEDIUM only with minLevel "medium". */
export function showsLine(level: Level, minLevel: "medium" | "high" | "critical"): boolean {
  return level !== "low" && meetsMinLevel(level, minLevel);
}

/** Does `security.notifyUser` also send this level to the user? */
export function notifiesUser(level: Level, setting: NotifyLevel): boolean {
  return setting !== "off" && levelRank(level) >= levelRank(setting);
}

// --- vocabulary ---------------------------------------------------------------------------------

const CUE_LABEL: Readonly<Record<string, string>> = {
  url: "URL",
  "outsider-content": "outsider content",
  message: "messages",
  scrape: "web content",
  "third-party": "third party",
  "follow-steps": "follow-the-steps",
  "secret-file": "secret file",
  credential: "credential",
  "sensitive-data": "sensitive data",
  egress: "egress",
  "egress-public": "public egress",
  destructive: "delete",
  "destructive-force": "force delete",
  privilege: "privilege",
  prod: "prod",
  persistence: "persistence path",
  install: "install",
  clone: "clone",
  "add-mcp": "add MCP",
  "fetch-exec": "fetch+run",
  "review-context": "review wording",
  "ignore-instructions": "override text",
  exfiltrate: "exfiltrate",
  "encode-data": "encode data",
  "disable-safeguards": "disable safeguards",
  conceal: "conceal",
};

/** The short name of a floor on a line. */
const FLOOR_SHORT: Readonly<Record<FloorId, string>> = {
  "H-R1": "trifecta",
  "H-R2": "rule of two",
  "H-R3": "untrusted→exec",
  "H-R6": "untrusted→persistence",
  C1: "trifecta, unattended",
  C2: "trifecta, every leg strong",
  C3: "secret→egress",
  C4: "fetch→exec",
  C5: "persistence, unattended",
  C6: "injection or exfiltration text",
};

const THREAT_SHORT: Readonly<Record<string, string>> = {
  exfiltration: "exfil",
  malicious_code: "malicious code",
  destructive: "destructive",
  credential_access: "credentials",
  injected_instructions: "injection",
  untrusted_action: "untrusted",
};

const up = (l: Level): string => l.toUpperCase();

/** .91, .5, 1: a 0..1 number the short way. */
function frac(n: number): string {
  if (n >= 0.995) return "1";
  return String(Math.round(n * 100) / 100).replace(/^0(?=\.)/, "");
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A name that came from outside (an agent type the model typed, a role) as it may appear in a line
 * the user reads: plain characters only, so it cannot carry a second line or a lookalike sentence.
 */
const label = (s: string): string => s.replace(/[^A-Za-z0-9_.:@/-]/g, "?").slice(0, 64);

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

function toolLabel(id: string): string {
  const m = /^mcp:([a-z-]+):([a-z-]+)$/.exec(id);
  return m ? `mcp ${m[1]} ${m[2]}` : id;
}

/** One way a leg is held, as a short label, with its strength and the kind it comes from. */
interface Source {
  label: string;
  e: number;
  /** task, taint, grant, latent: the order sources are shown in. */
  rank: number;
}

/** The label of one exposure: a cue, a session tool, a granted tool, or what a shell implies. */
function sourceLabel(x: Exposure): string {
  if (x.kind === "task") return CUE_LABEL[x.from.slice(5)] ?? x.from.slice(5);
  if (x.kind === "taint") return `session ${x.from.slice(6)}`;
  if (x.kind === "latent") return "shell";
  return toolLabel(x.from.startsWith("tool:") ? x.from.slice(5) : x.from);
}

/**
 * How a leg is held: "task URL+WebFetch+shell". The three strongest sources, shown in the order
 * task text, session taint, granted tools, then what code execution implies.
 */
function sources(v: AssessmentView, cap: Cap): string {
  const xs = v.detail.exposures.filter((x) => x.cap === cap && x.e >= 0.3);
  const found: Source[] = [];
  const rank = { task: 0, taint: 1, grant: 2, latent: 3 } as const;
  const tasks = xs.filter((x) => x.kind === "task").sort((a, b) => b.e - a.e);
  if (tasks.length)
    found.push({
      label: `task ${uniq(tasks.map(sourceLabel)).slice(0, 2).join("/")}`,
      e: tasks[0]?.e ?? 0,
      rank: rank.task,
    });
  const seen = new Set<string>();
  for (const x of xs.filter((y) => y.kind !== "task")) {
    const label = sourceLabel(x);
    if (seen.has(label)) continue;
    seen.add(label);
    found.push({ label, e: x.e, rank: rank[x.kind] });
  }
  return found
    .sort((a, b) => b.e - a.e || a.rank - b.rank)
    .slice(0, 3)
    .sort((a, b) => a.rank - b.rank || b.e - a.e)
    .map((s) => s.label)
    .join("+");
}

/** The strongest exposure of a capability, any kind. */
const strength = (v: AssessmentView, cap: Cap): number =>
  v.detail.exposures.reduce((m, x) => (x.cap === cap && x.e > m ? x.e : m), 0);

/** A leg is shown from this strength; the trifecta legs earlier than the rest. */
const LEG_FROM: Readonly<Record<Cap, number>> = {
  U: 0.3,
  S: 0.3,
  E: 0.3,
  X: 0.5,
  W: 0.5,
  D: 0.5,
  P: 0.5,
  T: 0.4,
};

interface Leg {
  cap: Cap;
  e: number;
  text: string;
}

/** The legs to show: U S E first, then X W D P T when they fire. */
function legs(v: AssessmentView): { main: Leg[]; extra: Leg[] } {
  const out = { main: [] as Leg[], extra: [] as Leg[] };
  for (const cap of ["U", "S", "E", "X", "W", "D", "P", "T"] as const) {
    const e = strength(v, cap);
    if (e < LEG_FROM[cap]) continue;
    const src = sources(v, cap);
    (cap === "U" || cap === "S" || cap === "E" ? out.main : out.extra).push({
      cap,
      e,
      text: `${cap} ${src || "tools"}`,
    });
  }
  return out;
}

// --- the model note ---------------------------------------------------------------------------

/** "jev raised MEDIUM→HIGH (sev 3.6, exfil .91)", only when the model moved the level. */
export function modelRaiseNote(v: AssessmentView): string | undefined {
  const m = v.detail.model;
  if (!m?.raised) return undefined;
  const bits: string[] = [];
  const sev = m.answer.severity?.value;
  if (sev !== undefined) bits.push(`sev ${sev.toFixed(1)}`);
  let top: { t: string; p: number } | undefined;
  for (const t of THREATS) {
    const p = m.answer.threats[t];
    if (p !== undefined && (!top || p > top.p)) top = { t, p };
  }
  if (top && top.p >= 0.5) bits.push(`${THREAT_SHORT[top.t] ?? top.t} ${frac(top.p)}`);
  return `jev raised ${up(v.heuristicLevel)}→${up(m.level)}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

// --- the remedy ---------------------------------------------------------------------------------

/** The tools a swarm role names in `disallowed_tools`: Bash covers the exec em tools. */
function disallowList(tools: readonly string[] | undefined): string[] {
  const list = uniq(tools ?? []);
  if (list.includes("Bash")) return ["Bash"];
  const builtin = list.filter((t) => !t.startsWith("em_") && !t.startsWith("mcp:"));
  return (builtin.length ? builtin : list).slice(0, 3);
}

export type AdviceSurface = "agent" | "prompt" | "plan" | "mcp";

function actionPhrase(a: RemedyAction, surface: AdviceSurface, role: string | undefined): string {
  const tools = a.tools?.length ? a.tools.join("/") : undefined;
  if (surface === "plan" && role && a.tools?.length && a.id !== "sandbox-network")
    return `drop ${a.leg ?? ""}: disallowed_tools: [${disallowList(a.tools).join(", ")}] for ${label(role)}`.replace(
      "drop :",
      "drop:",
    );
  if (surface === "prompt") {
    switch (a.id) {
      case "drop-egress":
        return `drop E: run it in an agent without ${tools ?? "egress tools"}`;
      case "drop-exec":
        return `drop X: delegate the web reading to an agent without ${tools ?? "a shell"}`;
      case "drop-tool":
        return a.leg === "S"
          ? "drop S: give it a scoped token or a fixture, not real secrets"
          : `drop U: do not feed it outside content${tools ? ` (no ${tools})` : ""}`;
      case "split":
        return "split: a read-only agent reads it and hands notes to a writer in a fresh context";
      case "hitl":
        return "keep a human in the loop: confirm each step";
      default:
        break;
    }
  }
  switch (a.id) {
    case "drop-egress":
      return REMEDY_TEXT["drop-egress"](a.tools ?? []);
    case "sandbox-network":
      return REMEDY_TEXT["sandbox-network"]();
    case "drop-exec":
      return REMEDY_TEXT["drop-exec"](a.tools ?? []);
    case "drop-tool":
      return a.leg === "S"
        ? REMEDY_TEXT["drop-secrets"]()
        : REMEDY_TEXT["drop-untrusted"](a.tools ?? []);
    case "split":
      return REMEDY_TEXT.split();
    case "hitl":
      return REMEDY_TEXT.hitl();
    case "review-first":
      return REMEDY_TEXT["review-first"]();
    case "do-not-run":
      return REMEDY_TEXT["do-not-run"]();
    default:
      return "";
  }
}

/**
 * The remedy as a surface words it: the agent hook says what T2's engine said; the prompt speaks to
 * the session ("delegate the web reading to an agent without Bash"); the plan names the swarm.yaml
 * edit ("disallowed_tools: [Bash] for researcher"). Undefined when nothing fired.
 */
export function remedyLines(
  v: AssessmentView,
  surface: AdviceSurface = "agent",
  role?: string,
): string[] {
  const r = v.detail.remedy;
  if (!r)
    return levelRank(v.level) >= levelRank("high") && v.detail.model?.raised
      ? [REMEDY_TEXT.hitl()]
      : [];
  if (surface === "agent" || surface === "mcp") return [r.line];
  const lines = r.actions.map((a) => actionPhrase(a, surface, role)).filter(Boolean);
  return lines.length ? lines : [r.line];
}

// --- the lines ----------------------------------------------------------------------------------

/** Rule ids behind a HIGH: those whose combination is complete, else the ones that fired. */
function ruleIds(v: AssessmentView): string[] {
  const complete = v.detail.floors.filter((f) => f.startsWith("H-")).map((f) => f.slice(2));
  if (complete.length) return complete;
  return v.detail.rules.map((r) => r.id).slice(0, 4);
}

/** The CRITICAL floors that fired, the most specific first: what the text asks for before how complete the legs are. */
const CRITICAL_ORDER: readonly FloorId[] = ["C4", "C3", "C6", "C5", "C2", "C1"];

function criticalFloors(v: AssessmentView): FloorId[] {
  return CRITICAL_ORDER.filter((f) => v.detail.floors.includes(f));
}

interface Composed {
  head: string;
  /** Right after the head: the CRITICAL floor and what it is. */
  floor?: string | undefined;
  legs: string[];
  extras: string[];
  rules?: string | undefined;
  model?: string | undefined;
  remedy?: string | undefined;
}

/** Join the parts, dropping the least important until the line fits `max`. */
function squeeze(c: Composed, max: number): string {
  const build = (o: { extras: boolean; model: boolean; rules: boolean; remedy?: string }): string =>
    [
      c.head,
      c.floor,
      ...c.legs,
      ...(o.extras ? c.extras : []),
      o.rules ? c.rules : undefined,
      o.model ? c.model : undefined,
      o.remedy,
    ]
      .filter((p): p is string => !!p)
      .join(" · ");
  const base = { extras: true, model: true, rules: true };
  const full = build({ ...base, ...(c.remedy ? { remedy: c.remedy } : {}) });
  if (full.length <= max) return full;
  const steps: Array<Partial<typeof base>> = [
    { extras: false },
    { extras: false, model: false },
    { extras: false, model: false, rules: false },
  ];
  for (const s of steps) {
    const o = { ...base, ...s };
    const line = build({ ...o, ...(c.remedy ? { remedy: c.remedy } : {}) });
    if (line.length <= max) return line;
    // keep what is left for the remedy: a shortened remedy still says which leg to drop
    const bare = build(o).length;
    const room = max - bare - 3;
    if (c.remedy && room >= 40) return build({ ...o, remedy: clip(c.remedy, room) });
  }
  return clip(build({ extras: false, model: false, rules: false }), max);
}

function compose(
  v: AssessmentView,
  head: string,
  surface: AdviceSurface,
  role: string | undefined,
): Composed {
  const l = legs(v);
  const crit = criticalFloors(v);
  const c: Composed = {
    head,
    legs: l.main.map((x) => x.text),
    extras: l.extra.map((x) => x.text),
  };
  if (crit.length) {
    const [first, ...rest] = crit as [FloorId, ...FloorId[]];
    c.floor = `${first} ${FLOOR_SHORT[first]}${rest.length ? ` +${rest.join(" ")}` : ""}`;
  }
  const ids = crit.length ? [] : ruleIds(v);
  if (ids.length) c.rules = ids.join(" ");
  const note = modelRaiseNote(v);
  if (note) c.model = note;
  const rem = remedyLines(v, surface, role);
  if (rem.length) c.remedy = rem.join("; ");
  return c;
}

/**
 * The hook line, at most HOOK_LINE_MAX characters:
 *   eminiar security: HIGH 71 · U task URL · S Read+shell · E WebFetch · R1 R3 · drop E: ...
 *   eminiar security: CRITICAL 96 · C3 secret→egress · S task secret file · E task public egress · do not run unattended: confirm with the user
 * `surface` words the remedy for who reads it: "prompt" speaks to the session.
 */
export function hookLine(
  v: AssessmentView,
  o: { surface?: AdviceSurface; role?: string; max?: number } = {},
): string {
  const head = `eminiar security: ${up(v.level)} ${v.score}`;
  return squeeze(compose(v, head, o.surface ?? "agent", o.role), o.max ?? HOOK_LINE_MAX);
}

/** Why an assessment is what it is, in a clause for the user message. */
function whyClause(v: AssessmentView): string {
  const crit = criticalFloors(v);
  const first = crit[0] ?? v.detail.floors[0];
  if (first) return FLOOR_NOTES[first];
  const note = modelRaiseNote(v);
  if (note) return note;
  const rule = v.detail.rules[0];
  return rule ? `rule ${rule.id} fired` : "a risky combination";
}

/**
 * The message for the user (security.notifyUser), after the advice line went to the agent:
 *   eminiar security: CRITICAL on swarm-feature-coder (task #12): a named secret can leave through
 *   an egress action. Advice only, nothing was blocked; `eminiar adjudicator security explain 57`.
 */
export function userMessage(
  v: AssessmentView,
  o: { who?: string | undefined; taskId?: number | undefined } = {},
): string {
  const where = o.who
    ? `on ${label(o.who)}${o.taskId !== undefined ? ` (task #${o.taskId})` : ""}`
    : "in this prompt";
  const tail = v.id !== undefined ? `; \`eminiar adjudicator security explain ${v.id}\`` : "";
  return `eminiar security: ${up(v.level)} ${where}: ${whyClause(v)}. Advice only, nothing was blocked${tail}.`;
}

/** The plan's first line: counts per level and what answered ("model jev ok" or "heuristic"). */
export function planHead(
  levels: readonly Level[],
  model: { answered: number; asked: boolean; status?: string | undefined },
): string {
  const parts: string[] = [];
  for (const l of ["critical", "high", "medium"] as const) {
    const n = levels.filter((x) => x === l).length;
    if (n) parts.push(`${n} ${l}`);
  }
  const counts = parts.length ? parts.join(", ") : "nothing above low";
  let how = "heuristic";
  if (model.answered > 0) how = "model jev ok";
  else if (model.asked)
    how = `heuristic (jev ${model.status && model.status !== "none" ? model.status : "gave no answer"})`;
  return `Security (advice only): ${counts} · ${how}`;
}

/**
 * One line per task, at most PLAN_LINE_MAX characters:
 *   #12 security HIGH 71 · U task URL · S Read+shell · E WebFetch · R1 R3 · drop E: disallowed_tools: [WebFetch] for researcher
 */
export function planLine(
  v: AssessmentView,
  o: { taskId: number; role?: string | undefined; max?: number },
): string {
  const head = `#${o.taskId} security ${up(v.level)} ${v.score}`;
  return squeeze(compose(v, head, "plan", o.role), o.max ?? PLAN_LINE_MAX);
}

// --- em_adjudicate security and explain ---------------------------------------------------------

function legsDetail(v: AssessmentView): string[] {
  const l = legs(v);
  return [...l.main, ...l.extra].map((x) => `${x.text} ${frac(x.e)}`);
}

function ruleDetail(v: AssessmentView): string {
  const rules = v.detail.rules.map((r) => `${r.id} +${frac(r.add)}`);
  const floors = v.detail.floors;
  return [
    rules.length ? `rules: ${rules.join(", ")}` : "",
    floors.length ? `floors: ${floors.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function grantDetail(v: AssessmentView): string {
  const g = v.detail.grant;
  const tools = g.tools.length ? g.tools.slice(0, 12).join(", ") : "none";
  const more = g.tools.length > 12 ? ` +${g.tools.length - 12}` : "";
  const src = g.source ? ` (${g.source})` : "";
  const mode = g.permissionMode ? `, permissionMode ${g.permissionMode}` : "";
  const mcp = g.mcpServers ? ", names MCP servers" : "";
  return `grant: ${g.status}${src}: ${tools}${more}${mode}${mcp}`;
}

function modelDetail(v: AssessmentView): string {
  const m = v.detail.model;
  if (!m) return `model: ${v.modelStatus === "none" ? "no answer" : v.modelStatus}`;
  const sev = m.answer.severity?.value;
  const threats = THREATS.filter((t) => (m.answer.threats[t] ?? 0) >= 0.3).map(
    (t) => `${THREAT_SHORT[t] ?? t} ${frac(m.answer.threats[t] ?? 0)}`,
  );
  const how = m.raised
    ? `raised ${up(v.heuristicLevel)}→${up(m.level)}`
    : levelRank(m.level) < levelRank(v.heuristicLevel)
      ? "lower, ignored"
      : "agrees";
  return `model: jev ${sev !== undefined ? `sev ${sev.toFixed(1)} → ` : ""}${up(m.level)} (${how})${threats.length ? ` · ${threats.join(", ")}` : ""}`;
}

/**
 * One block per item for em_adjudicate security, at most `max` characters (default MCP_BLOCK_MAX):
 * the level, score and action, the legs with their sources and strengths, the rules and floors, the
 * autonomy, the grant, the model, the remedy and the assessment id.
 */
export function mcpBlock(v: AssessmentView, o: { label?: string; max?: number } = {}): string {
  const label = o.label ? `${o.label} ` : "";
  const first = `${label}security ${up(v.level)} ${v.score} (${securityAction(v.level)}) · advice only${
    v.id !== undefined ? ` · assessment ${v.id}` : ""
  }`;
  const lines = [
    first,
    `  legs: ${legsDetail(v).join(" · ") || "none above .3"}`,
    `  ${ruleDetail(v) || "no rule fired"}`,
    `  autonomy: ${v.autonomy} ×${v.detail.a}${
      v.detail.taint?.tools.length ? ` · session used ${v.detail.taint.tools.join(", ")}` : ""
    }`,
    `  ${grantDetail(v)}`,
    `  ${modelDetail(v)}`,
  ];
  const rem = remedyLines(v, "mcp");
  if (rem.length) lines.push(`  remedy: ${rem.join("; ")}`);
  const max = o.max ?? MCP_BLOCK_MAX;
  let out = lines.join("\n");
  if (out.length > max) {
    // the grant list and the autonomy line go first; the legs, rules, model and remedy stay
    out = lines.filter((l) => !l.startsWith("  grant:") && !l.startsWith("  autonomy:")).join("\n");
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * The long explanation of one assessment (`eminiar adjudicator security explain <id>`, the
 * dashboard drawer, em_adjudicate explain): every exposure by kind, every rule, floor and reason.
 */
export function explain(
  v: AssessmentView,
  o: {
    surface?: string;
    ts?: number;
    agentType?: string | null;
    runId?: string | null;
    taskId?: number | null;
  } = {},
): string {
  const where = [
    o.surface ? `surface ${o.surface}` : "",
    o.agentType ? `agent ${label(o.agentType)}` : "",
    o.runId ? `run ${o.runId}${o.taskId != null ? ` task #${o.taskId}` : ""}` : "",
    o.ts !== undefined ? new Date(o.ts).toISOString() : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [
    `security assessment${v.id !== undefined ? ` ${v.id}` : ""}: ${up(v.level)} ${v.score} (${securityAction(v.level)}) · advice only`,
    ...(where ? [where] : []),
    `heuristic ${up(v.heuristicLevel)} ${v.heuristicScore} · source ${v.source} · ${modelDetail(v)}`,
    `autonomy ${v.autonomy} ×${v.detail.a}`,
    grantDetail(v),
  ];
  const t = v.detail.taint;
  if (t)
    lines.push(
      t.tools.length
        ? `session taint: used ${t.tools.join(", ")}`
        : t.status === "unavailable"
          ? "session taint: history unavailable"
          : t.status === "off"
            ? "session taint: off"
            : "session taint: none",
    );
  const cues = [...v.detail.cues, ...v.detail.intent].map((c) => CUE_LABEL[c] ?? c);
  if (cues.length) lines.push(`text cues: ${cues.join(", ")}`);
  lines.push("legs:");
  for (const cap of CAPS) {
    const xs = v.detail.exposures.filter((x) => x.cap === cap);
    if (!xs.length) continue;
    lines.push(
      `  ${cap} ${frac(strength(v, cap))}: ${xs
        .map(
          (x) => `${frac(x.e)} ${x.kind === "latent" ? "latent from" : x.kind} ${sourceLabel(x)}`,
        )
        .join(", ")}`,
    );
  }
  if (v.detail.rules.length) {
    lines.push("rules:");
    for (const r of v.detail.rules)
      lines.push(
        `  ${r.id} +${frac(r.add)} (k ${frac(r.k)} × min ${frac(r.min)}: ${r.factors.map((f) => `${f.cap} ${frac(f.e)}`).join(", ")})`,
      );
  }
  if (v.detail.floors.length) {
    lines.push("floors:");
    for (const f of v.detail.floors) lines.push(`  ${f}: ${FLOOR_NOTES[f]}`);
  }
  const rem = remedyLines(v, "agent");
  if (rem.length) lines.push(`remedy: ${rem.join("; ")}`);
  if (v.detail.reasons.length) {
    lines.push("reasons:");
    for (const r of v.detail.reasons)
      lines.push(`  ${r.feature} ${r.weight >= 0 ? "+" : ""}${r.weight.toFixed(2)} ${r.note}`);
  }
  return lines.join("\n");
}
