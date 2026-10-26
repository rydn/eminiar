import type { StorageAdapter } from "../storage/adapter.js";
import type { EventRow } from "../storage/types.js";

/** Session-memory category of one routing decision (allow / annotate / deny) per native call. */
export const ROUTING_CATEGORY = "routing";

export type RoutingDecision = "allow" | "annotate" | "deny";

export interface RoutingEvent {
  /** The native tool Claude called (Bash, Read, Grep, WebFetch, WebSearch). */
  tool: string;
  decision: RoutingDecision;
  /** The em_* tool named in the suggestion, when there was one. */
  target?: string | undefined;
  /** Which rule produced the suggestion (heavy, pipe, big-read, history, …). */
  rule?: string | undefined;
  /** Why a suggestion did not become a denial (no-server, mode, annotate-only). */
  why?: string | undefined;
  /** The first characters of the command, path or pattern, for `eminiar routing --log`. */
  head?: string | undefined;
}

/**
 * Record what routing decided for a native call, so em_stats can report how often native
 * calls are intercepted and which rules do it. One row per Bash/Read/Grep/Web call.
 */
export function recordRouting(db: StorageAdapter, sessionId: string, e: RoutingEvent): void {
  db.eventInsert({
    sessionId,
    category: ROUTING_CATEGORY,
    priority: 4,
    tool: e.tool,
    payload: {
      tool: e.tool,
      decision: e.decision,
      ...(e.target ? { target: e.target } : {}),
      ...(e.rule ? { rule: e.rule } : {}),
      ...(e.why ? { why: e.why } : {}),
      ...(e.head ? { head: e.head.slice(0, 120) } : {}),
    },
  });
}

export interface RoutingToolStats {
  calls: number;
  denied: number;
  annotated: number;
  /** Denials per em_* target. */
  targets: Record<string, number>;
  /** Denials per rule. */
  rules: Record<string, number>;
}

export interface RoutingStats {
  decisions: number;
  byTool: Record<string, RoutingToolStats>;
}

/** Tally the recorded `routing` events: calls, denials and annotations per native tool. */
export function routingStats(events: EventRow[]): RoutingStats {
  const byTool: RoutingStats["byTool"] = {};
  let decisions = 0;
  for (const e of events) {
    if (e.category !== ROUTING_CATEGORY) continue;
    let p: RoutingEvent;
    try {
      p = JSON.parse(e.payload) as RoutingEvent;
    } catch {
      continue;
    }
    if (!p.tool) continue;
    decisions++;
    let row = byTool[p.tool];
    if (!row) {
      row = { calls: 0, denied: 0, annotated: 0, targets: {}, rules: {} };
      byTool[p.tool] = row;
    }
    row.calls++;
    if (p.decision === "deny") {
      row.denied++;
      if (p.target) row.targets[p.target] = (row.targets[p.target] ?? 0) + 1;
      if (p.rule) row.rules[p.rule] = (row.rules[p.rule] ?? 0) + 1;
    } else if (p.decision === "annotate") row.annotated++;
  }
  return { decisions, byTool };
}

const top = (m: Record<string, number>, n = 4): string =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ×${v}`)
    .join(", ");

export function formatRoutingStats(title: string, s: RoutingStats): string {
  if (!s.decisions) return `${title}: no routing decisions recorded yet`;
  const tools = Object.entries(s.byTool)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([tool, r]) => {
      const pct = Math.round((100 * r.denied) / r.calls);
      const parts = [`${tool} ${r.denied}/${r.calls} denied (${pct}%)`];
      if (r.annotated) parts.push(`${r.annotated} annotated`);
      return parts.join(", ");
    });
  const lines = [`${title}: ${s.decisions} native call(s) — ${tools.join(" · ")}`];
  const rules: Record<string, number> = {};
  const targets: Record<string, number> = {};
  for (const r of Object.values(s.byTool)) {
    for (const [k, v] of Object.entries(r.rules)) rules[k] = (rules[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.targets)) targets[k] = (targets[k] ?? 0) + v;
  }
  if (Object.keys(targets).length)
    lines.push(`  denied → ${top(targets)}; by rule: ${top(rules, 6)}`);
  return lines.join("\n");
}
