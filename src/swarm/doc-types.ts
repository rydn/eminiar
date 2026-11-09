/**
 * Types of the swarm file as the dashboard edits it: a structured draft that mirrors the raw
 * (snake_case) YAML of `.eminiar/swarm.yaml`.
 *
 * Types only, with no imports and no runtime code, so the browser bundle can import them.
 * edit.ts asserts at compile time that config.ts's `SwarmFileRaw` is assignable to `SwarmDoc`,
 * so a field added to the schema cannot silently go missing here.
 */

/** The model tiers a role's range is expressed in, lowest first. */
export type DocTier = "haiku" | "sonnet" | "opus" | "fable";

export interface SwarmDocContext {
  memories?: number | undefined;
  docs?: number | undefined;
  history?: boolean | undefined;
  structure?: boolean | undefined;
  insights?: boolean | undefined;
  max_chars?: number | undefined;
}

export interface SwarmDocModelRange {
  floor?: DocTier | undefined;
  ceiling?: DocTier | undefined;
}

export interface SwarmDocRole {
  description: string;
  prompt?: string | undefined;
  model?: string | undefined;
  model_range?: SwarmDocModelRange | undefined;
  tools?: string[] | undefined;
  tools_profile?: "readonly" | undefined;
  disallowed_tools?: string[] | undefined;
  skills?: string[] | undefined;
  /** Read-only in the dashboard: shown, never edited (edit it in the YAML). */
  hooks?: unknown;
  scope?: string[] | undefined;
  memory_tags?: string[] | undefined;
  count?: number | undefined;
  isolation?: "worktree" | undefined;
  max_turns?: number | undefined;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  color?: "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan" | undefined;
  context?: SwarmDocContext | undefined;
}

export interface SwarmDocSwarm {
  description: string;
  topology?: "hierarchical" | "mesh" | "pipeline" | undefined;
  max_agents?: number | undefined;
  stages?: string[] | undefined;
  instructions?: string | undefined;
  context?: SwarmDocContext | undefined;
  agents: Record<string, SwarmDocRole>;
}

export interface SwarmDocDefaults {
  model?: string | undefined;
  model_range?: SwarmDocModelRange | undefined;
  skills?: string[] | undefined;
  context?: SwarmDocContext | undefined;
}

export interface SwarmDoc {
  version?: 1 | undefined;
  enabled?: boolean | undefined;
  sync?: "auto" | "manual" | undefined;
  enforce?: boolean | undefined;
  allowed_agents?: string[] | undefined;
  defaults?: SwarmDocDefaults | undefined;
  swarms: Record<string, SwarmDocSwarm>;
  /** `x-*` keys hold YAML anchors; they pass through untouched and are never editable. */
  [extension: `x-${string}`]: unknown;
}

/**
 * Renaming a swarm (no `role`) or a role of a swarm. Renames in a list apply in order, so a
 * later one names things as the earlier ones left them.
 */
export interface SwarmDocRename {
  swarm: string;
  role?: string | undefined;
  to: string;
}

export type SwarmDocWarningKind =
  | "capacity"
  | "stages"
  | "active-run"
  | "enforce"
  | "disable"
  | "prompt";

/** A non-blocking note about a draft; `path` is a dotted path like an issue's. */
export interface SwarmDocWarning {
  path: string;
  kind: SwarmDocWarningKind;
  message: string;
}

/** A run the draft could affect, as the warnings need it. */
export interface SwarmDocActiveRun {
  id: string;
  swarm: string;
  goal?: string | undefined;
}

/** Which lines of a rendered text differ from the text it was edited from. */
export interface SwarmLineDiff {
  /** 1-based line numbers in the new text that were added or changed. */
  changed: number[];
  /** How many lines of the old text are gone. */
  removed: number;
}
