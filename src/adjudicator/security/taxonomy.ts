/**
 * The data of the heuristic risk engine (docs/design/adjudicator-security.md, design part 3 §5):
 * every number lives here and is a proposed default until the labelled eval set tunes it. Pure
 * data and two small path matchers: no I/O, no regex built from configuration text, and nothing
 * imported but types, so the hooks, the server and the dashboard can all load it.
 *
 * Each row names the framework it comes from: [Willison] lethal trifecta, [Meta] Rule of Two,
 * OWASP LLM Top 10 (LLM0x) and OWASP Agentic (ASIxx), MITRE ATLAS (Txxxx).
 */
import type {
  Autonomy,
  Cap,
  CueId,
  FloorId,
  GrantedTool,
  IntentCueId,
  McpClass,
  McpVerb,
  RuleId,
} from "./types.js";

// --- weights, bands, thresholds ----------------------------------------------------------------

/** Base weight per capability (sums to 1). Latent exposures never count in the base. */
export const WEIGHTS: Readonly<Record<Cap, number>> = {
  U: 0.15,
  S: 0.15,
  E: 0.15,
  X: 0.15,
  W: 0.08,
  D: 0.12,
  P: 0.1,
  T: 0.1,
};

/** Score multiplier by autonomy: nobody to confirm a call raises the risk, a prompt each call lowers it. */
export const AUTONOMY_MULT: Readonly<Record<Autonomy, number>> = {
  manual: 0.85,
  default: 1,
  autonomous: 1.25,
};

/** The score band stops at MEDIUM (D7): HIGH needs a complete combination, CRITICAL a fixed trigger. */
export const BAND_MEDIUM = 25;
/** A combination floors the level to HIGH when every one of its legs is at least this strong. */
export const LEG_MIN = 0.5;
/**
 * "Strong" legs: C2 (the trifecta in any mode, with the sensitive read or the egress also driven
 * by the task text at this strength) and the text-driven triggers C3 and C4.
 */
export const LEG_STRONG = 0.8;
/** A review, audit or test-for context multiplies every text cue by this (never a tool cap). */
export const REVIEW_DAMPEN = 0.5;
/** Session taint: an untrusted-input tool was used earlier in the session (U, kind taint). */
export const TAINT_U = 0.4;
/** A tool grant of at least this much S / E counts as "can read" / "can egress" (C3, C6). */
export const CAN_READ_MIN = 0.4;
export const CAN_EGRESS_MIN = 0.3;
/** Execution counts as granted from this exposure. */
export const CAN_EXEC_MIN = 0.8;
/**
 * A tool grant of at least this much U can fetch outside content itself (WebSearch .25, WebFetch
 * and em_docs .3, a browser .5, a SaaS read .7); em_search, em_recall and Skill (.2) cannot. Below
 * it, a URL in the task reaches the agent only through the shell's latent untrusted-input leg
 * (user decision T19: such a URL counts toward a floor only together with another cued leg).
 */
export const CAN_FETCH_MIN = 0.25;
/** R7 (secret egress) only fires while the untrusted-input leg is weaker than this. */
export const R7_MAX_U = LEG_MIN;
/** Output caps. */
export const MAX_EXPOSURES = 24;
export const MAX_REASONS = 12;

// --- tool exposures ----------------------------------------------------------------------------

/** What holding one tool exposes, by capability, 0..1. */
export interface ToolProfile {
  /** Exposure the grant itself gives. */
  grant?: Partial<Record<Cap, number>>;
  /** Raised exposure once a task cue puts untrusted content on the path ("WebFetch E .3, .6 when U is task-driven"). */
  whenU?: Partial<Record<Cap, number>>;
  /** Implied by code execution (counts in combinations, never in the base). */
  latent?: Partial<Record<Cap, number>>;
  /** Weak persistence (W*): memories later sessions trust (ASI06). */
  wstar?: number;
  /** Can put a file on disk (decides whether a persistence cue is reachable). */
  canWrite?: boolean;
}

/** Code execution: the shell and eminiar's own sandbox tools. */
const EXEC_PROFILE: ToolProfile = {
  grant: { X: 1 },
  latent: { S: 0.5, E: 0.5, D: 0.3, P: 0.2, U: 0.2 },
  canWrite: true,
};
const READ_PROFILE: ToolProfile = { grant: { S: 0.4 } };
const WRITE_PROFILE: ToolProfile = { grant: { W: 0.5 }, canWrite: true };
const FETCH_PROFILE: ToolProfile = { grant: { U: 0.3, E: 0.3 }, whenU: { E: 0.6 } };

/** Per normalised tool id (built-ins and bare em_* names). Anything missing here exposes nothing. */
export const TOOL_PROFILES: Readonly<Record<string, ToolProfile>> = {
  Read: READ_PROFILE,
  Grep: READ_PROFILE,
  Glob: READ_PROFILE,
  LSP: READ_PROFILE,
  Edit: WRITE_PROFILE,
  Write: WRITE_PROFILE,
  NotebookEdit: WRITE_PROFILE,
  Bash: EXEC_PROFILE,
  PowerShell: EXEC_PROFILE,
  Monitor: EXEC_PROFILE,
  em_execute: EXEC_PROFILE,
  em_execute_file: EXEC_PROFILE,
  em_batch_execute: EXEC_PROFILE,
  WebFetch: FETCH_PROFILE,
  em_fetch_and_index: FETCH_PROFILE,
  WebSearch: { grant: { U: 0.25, E: 0.15 }, whenU: { E: 0.3 } },
  em_search: { grant: { S: 0.4, U: 0.2 } },
  em_recall: { grant: { S: 0.4, U: 0.2 } },
  // D11: weak persistence leg .4 (at 1.0 every web-reading eminiar worker would be HIGH through R6)
  em_remember: { grant: { W: 0.4 }, wstar: 0.4 },
  em_memory: { grant: { W: 0.4 }, wstar: 0.4 },
  em_docs: { grant: { U: 0.3, E: 0.15 } },
  em_swarm: {},
  Skill: { grant: { U: 0.2 } },
  Agent: {},
  Task: {},
  ToolSearch: {},
  TodoWrite: {},
  TodoRead: {},
  AskUserQuestion: {},
};

/** Any other em_* tool: eminiar's own read side. */
const OTHER_EM_PROFILE: ToolProfile = { grant: { S: 0.4 } };

/** Class × verb of an MCP tool (the raw server name never matters here). */
export function mcpProfile(cls: McpClass, verb: McpVerb): ToolProfile {
  const out: ToolProfile = {};
  const grant: Partial<Record<Cap, number>> = {};
  switch (cls) {
    case "saas":
      if (verb === "read") {
        grant.S = 1;
        grant.U = 0.7;
      } else if (verb === "write") {
        grant.E = 1;
        grant.W = 0.5;
      } else if (verb === "exec") {
        grant.X = 0.5;
        grant.E = 1;
      }
      break;
    case "browser":
      grant.U = 0.5;
      grant.S = 1;
      grant.E = 1;
      grant.X = 0.5;
      break;
    case "cloud":
      // A read-only cloud tool is far weaker than one that changes infrastructure (my reading of
      // the design row "cloud P 1, D .7, X .8"; the design lists no verbs for it).
      if (verb === "read") {
        grant.S = 0.6;
        grant.P = 0.3;
      } else {
        grant.P = 1;
        grant.D = 0.7;
        grant.X = 0.8;
      }
      break;
    default:
      // first-party, trusted and unknown servers: by verb.
      if (verb === "read") grant.S = 0.4;
      else if (verb === "write") {
        grant.W = 0.5;
        grant.E = 0.3;
      } else if (verb === "exec") {
        grant.X = 0.8;
        out.latent = { S: 0.5, E: 0.5, D: 0.3, P: 0.2, U: 0.2 };
        out.canWrite = true;
      }
      // An unknown server can swap its tool definitions under us: the tool-supply leg.
      if (cls === "unknown") grant.T = 0.4;
  }
  if (verb === "delete") grant.D = 1;
  out.grant = grant;
  return out;
}

/** The profile of one granted tool; undefined when the tool exposes nothing. */
export function profileOf(tool: GrantedTool): ToolProfile | undefined {
  if (tool.kind === "mcp") return tool.mcp ? mcpProfile(tool.mcp.cls, tool.mcp.verb) : undefined;
  const hit = TOOL_PROFILES[tool.id];
  if (hit) return hit;
  return tool.kind === "em" || tool.id.startsWith("em_") ? OTHER_EM_PROFILE : undefined;
}

// --- text cue exposures ------------------------------------------------------------------------

export interface CueSpec {
  /** Exposure the cue adds to each capability (kind "task"). */
  caps?: Partial<Record<Cap, number>>;
  /** Names a secret (decides C3 and R7). */
  secret?: boolean;
  /** Names a persistence path (W*), counted only when the grant can write a file. */
  persist?: boolean;
  /** Fetch-and-execute of remote code (C4). */
  fetchExec?: boolean;
}

export const CUE_EXPOSURE: Readonly<Record<CueId, CueSpec>> = {
  // U untrusted input
  url: { caps: { U: 0.8 } },
  "outsider-content": { caps: { U: 1 } },
  message: { caps: { U: 0.8 } },
  scrape: { caps: { U: 1 } },
  "third-party": { caps: { U: 0.6 } },
  "follow-steps": { caps: { U: 1 } },
  // S sensitive read
  "secret-file": { caps: { S: 1 }, secret: true },
  credential: { caps: { S: 1 }, secret: true },
  "sensitive-data": { caps: { S: 0.7 } },
  // E egress
  egress: { caps: { E: 0.8 } },
  "egress-public": { caps: { E: 1 } },
  // D destructive, P privilege
  destructive: { caps: { D: 0.8 } },
  "destructive-force": { caps: { D: 1 } },
  privilege: { caps: { P: 0.8 } },
  prod: { caps: { P: 0.7 } },
  // W* persistence
  persistence: { persist: true },
  // T tool supply (T also sets U)
  install: { caps: { T: 1 } },
  clone: { caps: { U: 0.8, T: 0.5 } },
  "add-mcp": { caps: { T: 1 } },
  "fetch-exec": { caps: { T: 1 }, fetchExec: true },
  // a modifier, not an exposure
  "review-context": {},
};

/** Intent cues (ASI01) steer or hide: their exposures are never dampened by a review context. */
export const INTENT_EXPOSURE: Readonly<Record<IntentCueId, Partial<Record<Cap, number>>>> = {
  "ignore-instructions": { U: 1 },
  exfiltrate: { E: 1, S: 0.7 },
  "encode-data": { E: 0.5 },
  "disable-safeguards": { P: 0.8 },
  conceal: {},
};

/** A flat addition to the base for an intent that has no capability of its own. */
export const INTENT_FLAT: Readonly<Partial<Record<IntentCueId, number>>> = { conceal: 0.1 };

/**
 * The intents that, with an egress or exec grant, trigger C6. Conceal joined by user decision
 * (T7d): a text that tells the agent to hide what it does from the user is an injection. Not
 * disable-safeguards: "--no-verify" or "skip the hooks" is routine and must not be CRITICAL.
 */
export const C6_INTENTS: readonly IntentCueId[] = ["ignore-instructions", "exfiltrate", "conceal"];

// --- combination rules, floors -----------------------------------------------------------------

/** A rule leg: a capability, "W*" (weak persistence) or "S*" (a named secret). */
export type LegKey = Cap | "W*" | "S*";

export interface RuleSpec {
  id: RuleId;
  /** add = k · min(legs); each leg is the largest exposure among its alternatives. */
  k: number;
  legs: ReadonlyArray<readonly LegKey[]>;
  /** Where the rule comes from. */
  source: string;
}

export const RULE_SPECS: readonly RuleSpec[] = [
  { id: "R1", k: 0.45, legs: [["U"], ["S"], ["E"]], source: "[Willison] lethal trifecta" },
  { id: "R2", k: 0.25, legs: [["U"], ["S"], ["E", "W", "D", "P"]], source: "[Meta] Rule of Two" },
  { id: "R3", k: 0.3, legs: [["U"], ["X"]], source: "[ASI05] untrusted input drives execution" },
  { id: "R4", k: 0.25, legs: [["T"], ["X"]], source: "[ASI04, LLM03] supply chain" },
  { id: "R5", k: 0.25, legs: [["U"], ["D", "P"]], source: "[T0101, ASI03] destroy or escalate" },
  { id: "R6", k: 0.2, legs: [["U"], ["W*"]], source: "[ASI06, T0081] persistence" },
  { id: "R7", k: 0.15, legs: [["S*"], ["E"]], source: "[LLM02] secret egress without U" },
];

/** The rules whose complete combination (every leg ≥ LEG_MIN) floors the level to HIGH. */
export const HIGH_FLOORS: ReadonlyArray<readonly [RuleId, FloorId]> = [
  ["R1", "H-R1"],
  ["R2", "H-R2"],
  ["R3", "H-R3"],
  ["R6", "H-R6"],
];

/** One line per floor, for reasons. */
export const FLOOR_NOTES: Readonly<Record<FloorId, string>> = {
  "H-R1": "untrusted input, sensitive data and egress all present",
  "H-R2": "untrusted input and sensitive data with a way to act",
  "H-R3": "untrusted input can drive code execution",
  "H-R6": "untrusted input can write a path that steers later sessions",
  C1: "the full trifecta, running without anyone to confirm",
  C2: "every trifecta leg is strong, and the task itself reads secrets or sends data out",
  C3: "a named secret can leave through an egress action",
  C4: "fetches remote code and runs it",
  C5: "untrusted input can write a persistence path, running without anyone to confirm",
  C6: "the text tries to override the rules, exfiltrate or hide what it does, and the grant can egress or execute",
};

// --- remedy text -------------------------------------------------------------------------------

export const REMEDY_TEXT = {
  "drop-egress": (tools: readonly string[]) =>
    `drop E: no ${tools.join("/") || "egress tools"} for this agent`,
  "sandbox-network": () => "drop E: run it in a network-off sandbox",
  "drop-exec": (tools: readonly string[]) =>
    `drop X: no ${tools.join("/") || "shell"} (use the em_* read tools)`,
  "drop-secrets": () => "drop S: a scoped token or a fixture instead of real secrets",
  "drop-untrusted": (tools: readonly string[]) =>
    `drop U: no ${tools.join("/") || "web tools"} (do not feed it outside content)`,
  split: () => "split: a read-only researcher hands notes to a writer in a fresh context",
  hitl: () => "keep a human in the loop: confirm each step",
  "review-first": () => "review first: pin the version and install with --ignore-scripts",
  "do-not-run": () => "do not run unattended: confirm with the user",
} as const;

// --- path patterns -----------------------------------------------------------------------------

/**
 * Secret file patterns, `*` the only wildcard, matched case-insensitively against a path, its
 * basename, and every run of trailing or leading path segments (see pathMatches).
 */
export const BUILTIN_SECRET_PATHS: readonly string[] = [
  ".env",
  ".env*",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "id_dsa*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  ".ssh",
  ".ssh/*",
  ".aws",
  ".aws/*",
  ".gnupg",
  ".gnupg/*",
  ".kube/config",
  ".docker/config.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "service-account*.json",
  "kubeconfig",
];

/** Paths that steer later sessions or run code on their own (W*). */
export const PERSISTENCE_PATHS: readonly string[] = [
  ".claude",
  ".claude/*",
  "claude.md",
  "agents.md",
  ".mcp.json",
  ".cursor/*",
  ".cursorrules",
  ".eminiar",
  ".eminiar/*",
  ".git/hooks/*",
  ".github/workflows/*",
  ".gitlab-ci.yml",
  ".husky/*",
  ".vscode/tasks.json",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".profile",
  "authorized_keys",
  "crontab",
  "launchagents/*",
  "launchdaemons/*",
];

/** Longest path and pattern the matchers look at (the rest is ignored, keeping the cost bounded). */
const MAX_PATH = 512;
const MAX_PATTERN = 256;
const MAX_SEGMENTS = 16;

/**
 * Glob match with `*` as the only wildcard (it matches anything, `/` included), case-insensitive.
 * Built from the literal pieces between the stars, found left to right: no regex is ever built
 * from the pattern, so no pattern can backtrack catastrophically.
 */
export function globMatch(pattern: string, text: string): boolean {
  const p = (pattern.length > MAX_PATTERN ? pattern.slice(0, MAX_PATTERN) : pattern).toLowerCase();
  const t = (text.length > MAX_PATH ? text.slice(0, MAX_PATH) : text).toLowerCase();
  if (p.indexOf("*") < 0) return p === t;
  const parts = p.split("*");
  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  if (t.length < first.length + last.length) return false;
  if (!t.startsWith(first) || !t.endsWith(last)) return false;
  let pos = first.length;
  const end = t.length - last.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i] as string;
    if (seg === "") continue;
    const at = t.indexOf(seg, pos);
    if (at < 0 || at + seg.length > end) return false;
    pos = at + seg.length;
  }
  return true;
}

/**
 * Does `path` match any of `patterns`? The pattern is tried on the whole path and on each run of
 * leading or trailing segments, so ".ssh/*" hits "~/.ssh/id_rsa" and "*.pem" hits "/a/b/c.pem".
 */
export function pathMatches(path: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0 || path === "") return false;
  const clipped = path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path;
  const segs = clipped.split("/").filter((s) => s !== "");
  const tail = segs.length > MAX_SEGMENTS ? segs.slice(segs.length - MAX_SEGMENTS) : segs;
  const candidates: string[] = [clipped];
  for (let i = 0; i < tail.length; i++) {
    candidates.push(tail.slice(i).join("/"));
    if (i < tail.length - 1) candidates.push(tail.slice(0, i + 1).join("/"));
  }
  for (const pattern of patterns) {
    if (pattern === "") continue;
    for (const c of candidates) if (globMatch(pattern, c)) return true;
  }
  return false;
}

/** Is `path` a secret file? `extra` is security.secretPaths from the personal config. */
export function isSecretPath(path: string, extra: readonly string[] = []): boolean {
  return pathMatches(path, BUILTIN_SECRET_PATHS) || (extra.length > 0 && pathMatches(path, extra));
}

/** Is `path` one that steers later sessions or runs code by itself (W*)? */
export function isPersistencePath(path: string): boolean {
  return pathMatches(path, PERSISTENCE_PATHS);
}
