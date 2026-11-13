import { forRemote } from "./redact.js";
import { sanitizeSecurityHint, securityQuestions } from "./security/prompt.js";
import { type AdjudicationRequest, DEFAULT_ROLES, type Tier, TOOL_IDS } from "./types.js";

/**
 * What the model providers are asked (docs/design/adjudicator.md §8): the static catalogue
 * (tiers, roles, tools), the rubric, the Jev question set and the OpenAI strict JSON schema.
 * Pure functions with no I/O. Only the catalogue and the redacted item text (forRemote) leave
 * the machine.
 */

/** The complexity rubric, levels 0..4 (Jev `score` criteria, OpenAI rubric). */
export const COMPLEXITY_CRITERIA = [
  "trivial chat or lookup",
  "small single-file change",
  "multi-step change in one area",
  "cross-cutting change",
  "architectural or multi-subsystem",
] as const;

/** One-line criteria per Claude tier. */
export const TIER_CRITERIA: Record<Tier, string> = {
  haiku: "fast and cheap: lookups, searches, small mechanical edits, summaries",
  sonnet: "default coder: features and fixes in one area, tests, ordinary reviews",
  opus: "hard reasoning: cross-cutting or architectural work, subtle debugging, design",
  fable: "largest model: only the hardest open-ended, multi-subsystem problems",
};

/** Descriptions of DEFAULT_ROLES; a swarm's roles carry their own from swarm.yaml. */
export const ROLE_DESCRIPTIONS: Record<(typeof DEFAULT_ROLES)[number], string> = {
  explorer: "finds where code lives and what depends on it",
  researcher: "reads documentation and external sources",
  coder: "implements and edits code",
  tester: "writes and runs tests",
  reviewer: "reviews changes for bugs and quality",
  architect: "designs and plans larger changes",
  ui: "builds user interface work",
  none: "no delegation needed",
};

export const TOOL_DESCRIPTIONS: Record<(typeof TOOL_IDS)[number], string> = {
  em_symbols: "find a symbol or list a file's symbols",
  em_search: "search indexed code, docs and past output",
  em_graph_impact: "what depends on or breaks from a change",
  em_history: "git history of a file or change",
  em_execute: "run a command or tests, keep output small",
  em_batch_execute: "run several commands in one call, keep output small",
  em_execute_file: "process a large file without reading it",
  em_docs: "answer from indexed library docs",
  em_fetch_and_index: "fetch and index a web page",
  em_recall: "recall past decisions and constraints",
  em_swarm: "plan and fan out work to agents",
  Edit: "edit a file directly",
  Bash: "run a short shell command",
  Agent: "delegate to a subagent",
  none: "no tool, just answer",
};

export interface CatalogueEntry {
  name: string;
  description: string;
}

export interface Catalogue {
  tiers: CatalogueEntry[];
  roles: CatalogueEntry[];
  tools: CatalogueEntry[];
}

/** Item ids are positional ("i0", "i1", ...) so no request key leaves the machine. */
export function itemId(i: number): string {
  return `i${i}`;
}

/** Roles sent per request, "none" included (task #56): swarm.yaml comes with the repo. */
export const MAX_ROLES = 16;
/** A role name sent to a provider: a short identifier. Others are left out. */
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/**
 * The catalogue for a batch: the configured tier ladder, the roles named in the requests'
 * hints (a swarm's own roles) or DEFAULT_ROLES, and the tool ids (narrowed by `tools` to the
 * registered ones). Every list is bounded, since each provider call carries all of it (task
 * #56): tiers are unique TIERS (deduped here too), at most MAX_ROLES roles with short identifier
 * names and one-line descriptions, and tools are the fixed TOOL_IDS.
 */
export function buildCatalogue(
  reqs: readonly AdjudicationRequest[],
  o: { tiers: readonly Tier[]; tools?: readonly string[] | undefined },
): Catalogue {
  const roles = new Map<string, string>();
  for (const r of reqs)
    for (const role of r.hints?.roles ?? []) {
      if (roles.size >= MAX_ROLES - 1) break;
      if (typeof role.name === "string" && ROLE_NAME.test(role.name) && !roles.has(role.name))
        roles.set(role.name, typeof role.description === "string" ? role.description : "");
    }
  if (roles.size === 0) for (const r of DEFAULT_ROLES) roles.set(r, ROLE_DESCRIPTIONS[r]);
  else if (!roles.has("none")) roles.set("none", ROLE_DESCRIPTIONS.none);

  const allowed = o.tools ? new Set(o.tools) : undefined;
  const tools = TOOL_IDS.filter((t) => !allowed || allowed.has(t) || t === "none");
  const tiers = [...new Set(o.tiers)].filter((t) => t in TIER_CRITERIA);
  return {
    tiers: tiers.map((t) => ({ name: t, description: TIER_CRITERIA[t] })),
    roles: [...roles].map(([name, description]) => ({ name, description: oneLine(description) })),
    tools: tools.map((t) => ({ name: t, description: TOOL_DESCRIPTIONS[t] })),
  };
}

export interface StateItem {
  id: string;
  text: string;
  role?: string;
  files?: number;
  deps?: number;
  /** Security questions only: provider-safe tool ids (MCP as mcp:<class>:<verb>), at most 40. */
  tools?: string[];
  /** Security questions only: capability tags of the grant. */
  capabilities?: string[];
}

/**
 * Items as sent: positional id, redacted text cut to maxChars, and the task hints when given.
 * With o.security, an item whose request carries hints.security also gets its sanitized tool ids
 * and capability tags (security/prompt.ts); nothing else is ever added, and without o.security
 * the items are exactly what they were before security existed.
 */
export function buildItems(
  reqs: readonly AdjudicationRequest[],
  maxChars: number,
  offset = 0,
  o: { security?: boolean } = {},
): StateItem[] {
  return reqs.map((r, i) => {
    const item: StateItem = { id: itemId(offset + i), text: forRemote(r.text, maxChars) };
    if (r.hints?.role) item.role = r.hints.role;
    if (r.hints?.files !== undefined) item.files = r.hints.files;
    if (r.hints?.deps !== undefined) item.deps = r.hints.deps;
    const sec = o.security ? sanitizeSecurityHint(r.hints?.security) : undefined;
    if (sec) {
      item.tools = sec.tools;
      item.capabilities = sec.caps;
    }
    return item;
  });
}

// ---------------------------------------------------------------------------------------------
// Jev (typesafe): typed questions over a state

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

/** The per-item question names; ids are "<item>.<name>", e.g. "i3.complexity". */
export const JEV_QUESTIONS = ["complexity", "tier", "role", "risky", "needs_plan", "tool"] as const;
export type JevQuestionName = (typeof JEV_QUESTIONS)[number];

export function jevQuestionId(item: string, q: JevQuestionName): string {
  return `${item}.${q}`;
}

/** The Jev state: {catalogue, items}. */
export function jevState(cat: Catalogue, items: StateItem[]): unknown {
  return {
    catalogue: {
      tiers: cat.tiers.map((t) => t.name),
      roles: cat.roles,
      tools: cat.tools.map((t) => t.name),
    },
    items,
  };
}

/** Questions for every item; `tool` only when askTool (weights.features.toolProvider > 0). */
export function jevQuestions(
  items: readonly StateItem[],
  cat: Catalogue,
  o: { askTool: boolean },
): Record<string, JevQuestion> {
  const tierCriteria = Object.fromEntries(cat.tiers.map((t) => [t.name, t.description]));
  const roleCriteria = Object.fromEntries(
    cat.roles.map((r) => [r.name, r.description || `the ${r.name} role`]),
  );
  const toolCriteria = Object.fromEntries(cat.tools.map((t) => [t.name, t.description]));
  const out: Record<string, JevQuestion> = {};
  for (const { id } of items) {
    const it = `item "${id}" in state.items`;
    out[jevQuestionId(id, "complexity")] = {
      type: "score",
      instructions: `How complex is the software work described by ${it}?`,
      criteria: [...COMPLEXITY_CRITERIA],
    };
    out[jevQuestionId(id, "tier")] = {
      type: "choice",
      instructions: `Which Claude model tier is the smallest that can do ${it} well?`,
      criteria: tierCriteria,
    };
    out[jevQuestionId(id, "role")] = {
      type: "choice",
      instructions: `Which agent role (state.catalogue.roles) fits ${it} best?`,
      criteria: roleCriteria,
    };
    out[jevQuestionId(id, "risky")] = {
      type: "noul",
      instructions: `Is ${it} risky: could it break shared code, data, security or a release?`,
    };
    out[jevQuestionId(id, "needs_plan")] = {
      type: "noul",
      instructions: `Does ${it} need a plan split into several tasks before any code is written?`,
    };
    if (o.askTool)
      out[jevQuestionId(id, "tool")] = {
        type: "choice",
        instructions: `Which tool should be used first for ${it}?`,
        criteria: toolCriteria,
      };
  }
  // Security questions only for items that carry tools (buildItems, with a security hint).
  Object.assign(out, securityQuestions(items));
  return out;
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible: rubric + strict JSON schema

/** Cerebras rejects strict schemas whose text is longer than this. */
export const SCHEMA_MAX_CHARS = 5000;

/** The strict-mode schema: every field required, additionalProperties false, enums for choices. */
export function openaiSchema(
  cat: Catalogue,
  ids: readonly string[],
  o: { askTool: boolean },
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: { type: "string", enum: [...ids] },
    complexity: { type: "integer", enum: [0, 1, 2, 3, 4] },
    tier: { type: "string", enum: cat.tiers.map((t) => t.name) },
    role: { type: "string", enum: cat.roles.map((r) => r.name) },
  };
  if (o.askTool) item.tool = { type: "string", enum: cat.tools.map((t) => t.name) };
  item.risky = { type: "boolean" };
  item.confidence = { type: "number" };
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: item,
          required: Object.keys(item),
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
  // Long custom role names could push the text past the limit; the id enum is the first to go.
  if (schemaText(schema).length > SCHEMA_MAX_CHARS) item.id = { type: "string" };
  return schema;
}

export function schemaText(schema: unknown): string {
  return JSON.stringify(schema);
}

/** The system message: rubric and catalogue; with withSchema, the schema text for json_object mode. */
export function rubric(cat: Catalogue, o: { askTool: boolean; schema?: unknown }): string {
  const lines = [
    "You route software-engineering requests for a coding assistant. For each item in the user's JSON, judge the work it describes.",
    "complexity (integer):",
    ...COMPLEXITY_CRITERIA.map((c, i) => `  ${i} = ${c}`),
    "tier: the smallest Claude model that does the item well:",
    ...cat.tiers.map((t) => `  ${t.name}: ${t.description}`),
    "role: the agent role that fits best:",
    ...cat.roles.map((r) => `  ${r.name}${r.description ? `: ${r.description}` : ""}`),
  ];
  if (o.askTool)
    lines.push(
      "tool: the tool to use first:",
      ...cat.tools.map((t) => `  ${t.name}: ${t.description}`),
    );
  lines.push(
    "risky: true when the work could break shared code, data, security or a release.",
    "confidence: 0..1, how sure you are of tier and complexity.",
    "Answer every item, once, with its id. Reply with JSON only.",
  );
  if (o.schema !== undefined)
    lines.push(`The JSON must match this schema: ${schemaText(o.schema)}`);
  return lines.join("\n");
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}
