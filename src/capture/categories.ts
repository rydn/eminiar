/**
 * Session-memory categories. Priority decides what survives the 2 KB PreCompact
 * snapshot: P1 always, then P2, P3, P4 as space allows.
 */
export type Priority = 1 | 2 | 3 | 4;

export const CATEGORIES = {
  // P1
  files: 1,
  tasks: 1,
  plans: 1,
  rules: 1,
  user_prompt: 1,
  // P2
  decision: 2,
  git: 2,
  error: 2,
  error_resolution: 2,
  constraint: 2,
  blocker: 2,
  rejected: 2,
  environment: 2,
  agent_findings: 2,
  iteration_loop: 2,
  assistant_summary: 2,
  // P3
  latency: 3,
  mcp_tool: 3,
  subagent: 3,
  skill: 3,
  external_ref: 3,
  role: 3,
  // P4
  intent: 4,
  data: 4,
  tool_call: 4,
  session_start: 4,
  /** A proactive recall decision (fired or quiet) and what it showed; never in the guide. */
  recall: 4,
  /** A routing decision (allow / annotate / deny) for one native call; never in the guide. */
  routing: 4,
} as const satisfies Record<string, Priority>;

export type Category = keyof typeof CATEGORIES;

export const GUIDE_ORDER: Array<{ title: string; categories: Category[] }> = [
  { title: "Last Request", categories: ["user_prompt"] },
  { title: "Tasks", categories: ["tasks"] },
  { title: "Plans", categories: ["plans"] },
  { title: "Key Decisions", categories: ["decision"] },
  { title: "Files Modified", categories: ["files"] },
  { title: "Unresolved Errors", categories: ["error"] },
  { title: "Resolved", categories: ["error_resolution"] },
  { title: "Constraints", categories: ["constraint"] },
  { title: "Blockers", categories: ["blocker"] },
  { title: "Git", categories: ["git"] },
  { title: "Project Rules", categories: ["rules"] },
  { title: "Loops", categories: ["iteration_loop"] },
  { title: "Last Reply", categories: ["assistant_summary"] },
  { title: "MCP Tools Used", categories: ["mcp_tool"] },
  { title: "Subagent Tasks", categories: ["subagent", "agent_findings"] },
  { title: "Skills", categories: ["skill"] },
  { title: "Rejected Approaches", categories: ["rejected"] },
  { title: "External Refs", categories: ["external_ref"] },
  { title: "Environment", categories: ["environment"] },
  { title: "Slow Calls", categories: ["latency"] },
  { title: "Data refs", categories: ["data"] },
  { title: "Intent", categories: ["intent"] },
];
