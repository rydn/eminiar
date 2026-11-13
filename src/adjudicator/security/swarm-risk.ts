/**
 * The swarm dashboard's security fields: a role's risk, a task's latest assessment and a run's
 * worst level. Pure builders over the heuristic engine and the stored rows; the API
 * (src/ui/swarm-api.ts) calls them only when `adjudicator.security.enabled`, so with the option off
 * no field exists at all. Rows are read through the view helpers of advice.ts (never the raw
 * detail), and a role's risk is the heuristic over its grant and description at default autonomy
 * (no model, nothing stored).
 */
import type { StorageAdapter } from "../../storage/adapter.js";
import type { SecurityRow } from "../../storage/types.js";
import type { RoleSpec } from "../../swarm/types.js";
import { taskRiskOfRow } from "./advice.js";
import { blend, type SecurityConfig, scoreInput } from "./assess.js";
import { riskBadge } from "./combine.js";
import { grantFromRole } from "./grant.js";
import { LEVELS, type Level, type RoleRisk, type RunRisk, type TaskRisk } from "./types.js";

const rank = (l: Level): number => LEVELS.indexOf(l);

/** Higher level first, then higher score: scores are not ordered by level (a CRITICAL can score low). */
export function compareRisk(a: { level: Level; score: number }, b: typeof a): number {
  return rank(b.level) - rank(a.level) || b.score - a.score;
}

/** A role's risk: its grant plus its description, heuristic only, default autonomy. */
export function roleRisk(
  sec: SecurityConfig,
  role: Pick<RoleSpec, "tools" | "disallowedTools" | "description">,
): RoleRisk {
  const grant = grantFromRole(role, sec.trustedMcpServers);
  const scored = scoreInput(sec, { grant, texts: [role.description], autonomy: "default" });
  const { assessment } = blend(sec, scored);
  return { ...riskBadge(assessment), grantStatus: grant.status };
}

/** The run's latest assessment per task (the agent row, else the plan row); [] on a read failure. */
export function runRows(db: Pick<StorageAdapter, "security">, runId: string): SecurityRow[] {
  try {
    return db.security.forRun(runId);
  } catch {
    return [];
  }
}

/** Worst level (ties are the same level) and how many tasks sit at each level. */
export function runRiskOf(rows: readonly SecurityRow[]): RunRisk {
  const counts: Record<Level, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let worst: Level | null = null;
  for (const r of rows) {
    counts[r.level]++;
    if (worst === null || rank(r.level) > rank(worst)) worst = r.level;
  }
  return { worst, counts };
}

/** Task id -> its risk. */
export function taskRisksOf(rows: readonly SecurityRow[]): Map<number, TaskRisk> {
  const out = new Map<number, TaskRisk>();
  for (const r of rows) if (r.taskId !== null) out.set(r.taskId, taskRiskOfRow(r));
  return out;
}
