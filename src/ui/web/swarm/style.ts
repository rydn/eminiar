import type {
  SwarmEvent,
  SwarmEventKind,
  SwarmFileAction,
  SwarmIo,
  SwarmRunStatus,
  SwarmTaskStatus,
  SwarmTopology,
  SwarmWorkerStatus,
} from "../api.js";

/**
 * Glyph + word for every state: colour is never the only cue.
 * ○ pending/idle · ● running/active · ◆ blocked · ✓ done · ✗ failed · ◌ stale · ★ coordinator
 */
export const GLYPH = {
  pending: "○",
  idle: "○",
  running: "●",
  active: "●",
  blocked: "◆",
  done: "✓",
  failed: "✗",
  cancelled: "✗",
  stale: "◌",
  coordinator: "★",
} as const;

export type StateWord =
  | SwarmTaskStatus
  | SwarmRunStatus
  | SwarmWorkerStatus
  | "idle"
  | "coordinator";

/** CSS class of a state (colour) — always rendered next to its glyph and word. */
export const stateClass = (s: StateWord): string => `sw-s-${s}`;

export const TOPOLOGY_GLYPH: Record<SwarmTopology, string> = {
  hierarchical: "⋔",
  mesh: "⬡",
  pipeline: "⇉",
};

/** Feed glyph per event kind (text-presentation characters only, no emoji). */
export const KIND_GLYPH: Record<SwarmEventKind, string> = {
  run_start: "▸",
  run_finish: "■",
  plan: "+",
  claim: "→",
  update: "✎",
  post: "≡",
  spawn: "⊕",
  deny: "⊘",
  start: "●",
  tool: "›",
  tool_error: "✗",
  stop: "□",
  auto_close: "↺",
};

export const KIND_GROUPS: Array<[string, string, SwarmEventKind[]]> = [
  ["tools", "tool calls", ["tool", "tool_error"]],
  ["tasks", "tasks", ["plan", "claim", "update", "auto_close"]],
  ["notes", "blackboard", ["post"]],
  ["workers", "workers", ["spawn", "deny", "start", "stop"]],
  ["run", "run", ["run_start", "run_finish"]],
  ["errors", "errors", ["tool_error", "deny"]],
];

/** Agent-file sync state: `word` for one file, `short` after a count ("3 in sync"). */
export const FILE_STATE: Record<
  SwarmFileAction,
  { glyph: string; word: string; short: string; cls: string }
> = {
  unchanged: { glyph: "✓", word: "agent file in sync", short: "in sync", cls: "sw-s-done" },
  create: { glyph: "○", word: "agent file missing", short: "missing", cls: "sw-s-pending" },
  update: { glyph: "◆", word: "agent file stale", short: "stale", cls: "sw-s-blocked" },
  conflict: {
    glyph: "✗",
    word: "conflict: a hand-written file has this name",
    short: "conflict (hand-written file)",
    cls: "sw-s-failed",
  },
  delete: {
    glyph: "◌",
    word: "generated file a sync will remove",
    short: "to be removed",
    cls: "sw-s-stale",
  },
  disabled: {
    glyph: "◌",
    word: "no agent file (swarms disabled)",
    short: "none (disabled)",
    cls: "sw-s-stale",
  },
};

/**
 * Categorical role colours from the theme's code tokens (they switch with the theme). The
 * accent comes first; amber and purple come last because they double as write/exec flashes.
 */
const ROLE_PALETTE = [
  "var(--accent)",
  "var(--tok-ty)",
  "var(--tok-str)",
  "var(--tok-kw)",
  "var(--tok-num)",
  "var(--muted)",
];

export function roleColor(role: string | null | undefined, roles: string[]): string {
  if (!role || role === "coordinator") return "var(--fg)";
  let i = roles.indexOf(role);
  if (i < 0) {
    i = 0;
    for (const ch of role) i = (i * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return ROLE_PALETTE[i % ROLE_PALETTE.length]!;
}

/** The event's io class (`payload.io`), or `swarm` for coordination events. */
export function eventIo(e: SwarmEvent): SwarmIo {
  const io = e.payload?.io;
  if (io === "read" || io === "write" || io === "exec" || io === "swarm" || io === "other")
    return io;
  return e.kind === "tool" || e.kind === "tool_error" ? "other" : "swarm";
}

/** `agent-a1b2c3d4e5…` → `a1b2c3d4` (the 8 characters the blackboard's authors use). */
export const shortAgent = (id: string | null | undefined): string =>
  id ? id.replace(/^agent-/, "").slice(0, 8) : "";

/** Compact duration: 42s, 12m, 3h 05m, 2d 4h. */
export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "n/a";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Relative age for the feed: 5s, 12m, 3h, 2d. */
export function rel(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / 86_400_000)}d`;
}
