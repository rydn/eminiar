import type { Level, RunRisk } from "../../../adjudicator/security/types.js";
import { LEVEL_ORDER, levelInfo, levelRank } from "../views/security-helpers.js";

/**
 * Pure helpers of the swarm views' risk marks. Every risk field is optional on the wire: it is
 * absent unless adjudicator.security is on, and nothing here invents one.
 */

/** A role's badge is drawn in the swarms rail from this level up (design 14). */
export const RAIL_MIN_LEVEL: Level = "medium";

/** True when `level` is at or above the rail threshold. */
export function atLeastRail(level: string | null | undefined): boolean {
  return levelRank(level) >= levelRank(RAIL_MIN_LEVEL);
}

/** Level counts of a run, highest first, zero counts left out: "▲ 2 high · ○ 5 low". */
export function runRiskParts(risk: RunRisk | null | undefined): Array<{
  level: Level;
  n: number;
  glyph: string;
  word: string;
}> {
  if (!risk?.counts) return [];
  const out = [];
  for (const level of [...LEVEL_ORDER].reverse()) {
    const n = risk.counts[level] ?? 0;
    if (n > 0) out.push({ level, n, glyph: levelInfo(level).glyph, word: levelInfo(level).label });
  }
  return out;
}

/** Whether a run risk has anything to draw: the field present and at least one assessed task. */
export function hasRunRisk(risk: RunRisk | null | undefined): risk is RunRisk {
  return !!risk && risk.worst != null;
}

/** The run's tooltip / accessible line: "worst high; 2 high, 1 medium, 5 low (latest per task)". */
export function runRiskTitle(risk: RunRisk | null | undefined): string {
  if (!hasRunRisk(risk)) return "no task assessed yet";
  const parts = runRiskParts(risk).map((p) => `${p.n} ${p.word}`);
  return `worst ${risk.worst}; ${parts.join(", ")} (latest assessment per task)`;
}
