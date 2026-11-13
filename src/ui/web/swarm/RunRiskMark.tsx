import type { JSX } from "preact";
import type { RunRisk } from "../api.js";
import { RiskBadge } from "../security.js";
import { hasRunRisk, runRiskParts, runRiskTitle } from "./security-helpers.js";

/**
 * A run's worst risk plus per-level counts. Renders nothing when the server sent no `risk`
 * (security off). A run with the field but no assessment says "no assessment" in words, except
 * with `quiet` (the run list), where a run nobody assessed is not news and nothing shows.
 */
export function RunRiskMark({
  risk,
  compact,
  quiet,
}: {
  risk: RunRisk | null | undefined;
  compact?: boolean;
  quiet?: boolean;
}): JSX.Element | null {
  if (!risk) return null;
  const worst = risk.worst;
  if (!hasRunRisk(risk) || !worst)
    return quiet ? null : (
      <span class="muted small" title="security is on; no task of this run has been assessed">
        no assessment
      </span>
    );
  const title = runRiskTitle(risk);
  return (
    <span class="sec-row" title={title}>
      <RiskBadge level={worst} compact={compact} title={title} />
      {runRiskParts(risk).map((p) => (
        <span key={p.level} class="small muted" title={`${p.n} ${p.word}`}>
          {p.glyph}
          {p.n}
        </span>
      ))}
    </span>
  );
}
