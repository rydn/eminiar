/**
 * Shared types and constants of the security-aware adjudication (docs/design/adjudicator-security.md).
 * A web-safe leaf: declarations and constants only, no I/O, and nothing imported or re-exported
 * but the pure ../types.js, so the hook bundle, the server and the dashboard bundle can all import
 * it for free.
 * The numbers (weights, exposures, bands) live in taxonomy.ts, not here.
 */
import type { ProviderStatus, Reason } from "../types.js";

/** Bump when scoring changes so stored assessments and cached verdicts from older scorers are told apart. */
export const SECURITY_VERSION = "1";

export type { MinLevel, NotifyLevel, SecurityModelSetting } from "../types.js";
// --- config enums ---------------------------------------------------------------------------
// Defined in ../types.ts, which src/config.ts already imports: the hooks boot with no other
// src/adjudicator module while the adjudicator and security are off (adjudicator-hooks-off test).
export {
  MIN_LEVELS,
  NOTIFY_LEVELS,
  SECURITY_MODEL_SETTINGS,
} from "../types.js";

// --- levels, actions, autonomy -----------------------------------------------------------------

/** The risk tier, lowest first. Only fixed heuristic floors produce "critical". */
export const LEVELS = ["low", "medium", "high", "critical"] as const;
export type Level = (typeof LEVELS)[number];

/** low → allow, medium → advise, high/critical → warn. Advice only: nothing is ever denied. */
export const SECURITY_ACTIONS = ["allow", "advise", "warn"] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

export const AUTONOMIES = ["manual", "default", "autonomous"] as const;
export type Autonomy = (typeof AUTONOMIES)[number];

/** Where an assessment came from (the adjudicator surfaces that run it; a subset of Surface). */
export const SECURITY_SURFACES = ["agent", "plan", "prompt", "mcp"] as const;
export type SecuritySurface = (typeof SECURITY_SURFACES)[number];

// --- capabilities (the legs) -------------------------------------------------------------------

/**
 * U untrusted input · S sensitive read · E egress · X code execution · W local write ·
 * D destructive · P privilege · T tool supply. U, S and E are the lethal trifecta.
 */
export const CAPS = ["U", "S", "E", "X", "W", "D", "P", "T"] as const;
export type Cap = (typeof CAPS)[number];

/** The provider-safe name of each capability (what hints.security.caps carries). */
export const CAP_TAG = {
  U: "untrusted-input",
  S: "sensitive-read",
  E: "egress",
  X: "code-exec",
  W: "local-write",
  D: "destructive",
  P: "privilege",
  T: "tool-supply",
} as const satisfies Record<Cap, string>;
export type CapTag = (typeof CAP_TAG)[Cap];

/** Where an exposure comes from: the task text, the tool grant, what a granted tool implies, session taint. */
export const EXPOSURE_KINDS = ["task", "grant", "latent", "taint"] as const;
export type ExposureKind = (typeof EXPOSURE_KINDS)[number];

/**
 * One source of one capability. `from` names where it came from: "tool:WebFetch", "text:url",
 * "taint:WebFetch", "role:description". Never matched text, never a path or an argument.
 */
export interface Exposure {
  cap: Cap;
  /** 0..1 */
  e: number;
  kind: ExposureKind;
  from: string;
}

/** The exposure of one capability per kind (0 = none); e_c is the largest of the four. */
export interface CapExposure {
  task: number;
  grant: number;
  latent: number;
  taint: number;
}

// --- the tool grant ----------------------------------------------------------------------------

export const GRANT_KINDS = ["builtin", "em", "mcp"] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

/** first-party = eminiar's own server; trusted = security.trustedMcpServers; unknown adds the tool-supply leg. */
export const MCP_CLASSES = [
  "first-party",
  "trusted",
  "saas",
  "browser",
  "cloud",
  "unknown",
] as const;
export type McpClass = (typeof MCP_CLASSES)[number];

export const MCP_VERBS = ["read", "write", "delete", "exec"] as const;
export type McpVerb = (typeof MCP_VERBS)[number];

/**
 * One granted tool by its provider-safe id: "Bash", "em_execute", "mcp:saas:write". The raw
 * MCP server name never appears here (it stays in ToolGrant.local).
 */
export interface GrantedTool {
  id: string;
  kind: GrantKind;
  /** Set when kind is "mcp". */
  mcp?: { cls: McpClass; verb: McpVerb };
}

/** known = read from the definition · inherit = the parent's tools (the INHERIT set) · unknown = unreadable or contradictory. */
export const GRANT_STATUSES = ["known", "inherit", "unknown"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const GRANT_SOURCES = [
  "role",
  "agent-file",
  "builtin",
  "fork",
  "caller",
  "session",
] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

export interface ToolGrant {
  tools: GrantedTool[];
  status: GrantStatus;
  source: GrantSource;
  permissionMode?: string;
  /** The definition names mcpServers (their tools are not enumerated). */
  mcpServers?: boolean;
  /** Signal text only (the agent's or role's description): never stored, never sent. */
  description?: string;
  /** Raw local names: never sent to a provider, never stored. */
  local?: { servers: string[] };
}

// --- text cues ---------------------------------------------------------------------------------

/**
 * Cue ids found in the task text (signals.ts); only ids are kept, never the matched text.
 * Grouped by the capability they drive; taxonomy.ts gives each id its exposure value.
 */
export const CUE_IDS = [
  // U untrusted input
  "url",
  "outsider-content",
  "message",
  "scrape",
  "third-party",
  "follow-steps",
  // S sensitive read
  "secret-file",
  "credential",
  "sensitive-data",
  // E egress
  "egress",
  "egress-public",
  // D destructive
  "destructive",
  "destructive-force",
  // P privilege
  "privilege",
  "prod",
  // W* persistence (a path that steers later sessions)
  "persistence",
  // T tool supply, and fetch-and-execute
  "install",
  "clone",
  "add-mcp",
  "fetch-exec",
  // modifier: a review, audit or test-for context halves the text cues, never the tool caps
  "review-context",
] as const;
export type CueId = (typeof CUE_IDS)[number];

/** Intent cues (OWASP ASI01): the text itself tries to steer or hide. */
export const INTENT_CUE_IDS = [
  "ignore-instructions",
  "exfiltrate",
  "encode-data",
  "disable-safeguards",
  "conceal",
] as const;
export type IntentCueId = (typeof INTENT_CUE_IDS)[number];

// --- rules, floors, remedies -------------------------------------------------------------------

/** R1 trifecta U,S,E · R2 rule of two · R3 U,X · R4 T,X · R5 U,D|P · R6 U,W* · R7 S,E without U. */
export const RULE_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** H-* raise a complete combination to HIGH; C1..C6 are the fixed CRITICAL triggers (heuristic only). */
export const FLOOR_IDS = [
  "H-R1",
  "H-R2",
  "H-R3",
  "H-R6",
  "C1",
  "C2",
  "C3",
  "C4",
  "C5",
  "C6",
] as const;
export type FloorId = (typeof FLOOR_IDS)[number];

/** One fired combination rule: its factors (the capability that gave each one), the smallest, k and k·min. */
export interface RuleHit {
  id: RuleId;
  factors: Array<{ cap: Cap; e: number }>;
  min: number;
  k: number;
  add: number;
}

export const REMEDY_ACTION_IDS = [
  "drop-tool",
  "drop-egress",
  "drop-exec",
  "sandbox-network",
  "split",
  "review-first",
  "hitl",
  "do-not-run",
] as const;
export type RemedyActionId = (typeof REMEDY_ACTION_IDS)[number];

export interface RemedyAction {
  id: RemedyActionId;
  /** The leg it drops, when it drops one. */
  leg?: Cap;
  tools?: string[];
}

/** The "drop a leg" advice: at most two actions and one line of text. */
export interface Remedy {
  actions: RemedyAction[];
  text: string;
}

// --- the heuristic and the blend ---------------------------------------------------------------

export interface HeuristicAssessment {
  /** 0..100 */
  score: number;
  /** The score band alone: only "low" or "medium" (HIGH and CRITICAL come from floors). */
  band: "low" | "medium";
  level: Level;
  caps: Record<Cap, CapExposure>;
  /** The largest exposures, at most 24, strongest first. */
  exposures: Exposure[];
  rules: RuleHit[];
  floors: FloorId[];
  autonomy: Autonomy;
  /** The autonomy multiplier. */
  a: number;
  cues: CueId[];
  intent: IntentCueId[];
  reasons: Reason[];
  remedy?: Remedy;
  grantStatus: GrantStatus;
}

/** What the provider's security questions return, per item. */
export const THREATS = [
  "exfiltration",
  "malicious_code",
  "destructive",
  "credential_access",
  "injected_instructions",
  "untrusted_action",
] as const;
export type Threat = (typeof THREATS)[number];

export interface SecurityModelAnswer {
  /** 0..4 */
  severity?: { value: number; confidence: number };
  /** P(yes) per threat, 0..1. */
  threats: Partial<Record<Threat, number>>;
}

/**
 * ok = the provider answered · off = security.model is "off" · unsupported = the provider has no
 * security questions · none = no answer was available · otherwise why the call gave none.
 */
export type SecurityModelStatus = "off" | "unsupported" | "none" | ProviderStatus;

export interface SecurityAssessment {
  version: string;
  level: Level;
  /** 0..100 */
  score: number;
  action: SecurityAction;
  heuristic: HeuristicAssessment;
  /** Present when the model answered; it can only raise (level = max(heuristic, model)). */
  model?: { level: Level; score: number; answer: SecurityModelAnswer; raised: boolean };
  modelStatus: SecurityModelStatus;
  source: "heuristic" | "blend" | "plan";
}

/**
 * What a provider may see besides the text that already goes: provider-safe tool ids (MCP
 * normalised, at most 40) and the capability tags of the grant exposures at or above .3. Never
 * arguments, paths, MCP server names, session history or our own verdict.
 */
export interface SecurityHint {
  tools: string[];
  caps: CapTag[];
}

// --- UI payloads (dashboard and swarm API; leaf types shared with src/ui/web) -------------------

/** One of the three trifecta legs as shown: its strength and where it came from. */
export interface RiskLeg {
  /** 0..1 */
  e: number;
  kind?: ExposureKind;
  from?: string;
}

export interface RiskBadge {
  level: Level;
  /** 0..100 */
  score: number;
  legs: { U: RiskLeg; S: RiskLeg; E: RiskLeg };
  /** Rule and floor ids that fired. */
  rules: string[];
  remedy?: string;
  /** At most 5, each at most 120 characters. */
  reasons: string[];
}

/** A swarm role's risk at default autonomy. */
export interface RoleRisk extends RiskBadge {
  grantStatus: GrantStatus;
}

/** A task's latest assessment: the agent row when one exists, else the plan row. */
export interface TaskRisk extends RiskBadge {
  surface: "plan" | "agent";
  /** adjudicator_security.id */
  id: number;
  ts: number;
  modelRaised: boolean;
}

/** A run's worst level and how many tasks sit at each level; worst is null before any assessment. */
export interface RunRisk {
  worst: Level | null;
  counts: Record<Level, number>;
}
