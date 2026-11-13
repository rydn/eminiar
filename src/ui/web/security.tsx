/**
 * Shared risk components for the dashboard: the Adjudicator tab's security panel and the swarm
 * views reuse them, and the one `sec-*` section of styles.css styles them.
 *
 * Rules every component follows:
 *  - risk is a glyph and a word as well as a tone, never colour alone;
 *  - every string from the server (reasons, remedy, heads, rule ids) is rendered as a text node,
 *    never as HTML;
 *  - nothing here fetches: the callers decide when anything is requested.
 */
import type { JSX } from "preact";
import type { RiskBadge as RiskBadgeData } from "../../adjudicator/security/types.js";
import { Badge, EmptyState } from "./ds.js";
import { cls } from "./util.js";
import {
  badgeLabel,
  isFloor,
  type LegChip,
  legChips,
  levelInfo,
  type ModelInput,
  modelState,
  remedyText,
  ruleLabel,
} from "./views/security-helpers.js";

/** Glyph + word + tone for one level. `score` adds the number; `compact` drops the word's weight. */
export function RiskBadge({
  level,
  score,
  compact,
  title,
}: {
  level: string;
  score?: number | null | undefined;
  compact?: boolean | undefined;
  title?: string | undefined;
}): JSX.Element {
  const li = levelInfo(level);
  const hasScore = typeof score === "number" && Number.isFinite(score);
  return (
    <span
      class={cls("sec-badge", `sec-l-${level}`, compact && "compact")}
      title={title ?? `${badgeLabel(level, score)}: ${li.help}`}
      role="img"
      aria-label={badgeLabel(level, score)}
    >
      <span class="sec-glyph" aria-hidden="true">
        {li.glyph}
      </span>
      <span class="sec-word" aria-hidden="true">
        {li.label}
      </span>
      {hasScore ? (
        <span class="sec-score" aria-hidden="true">
          {Math.round(score as number)}
        </span>
      ) : null}
    </span>
  );
}

/** One leg chip: the letter, its strength as a number and a fill meter. */
export function LegChipView({ chip }: { chip: LegChip }): JSX.Element {
  return (
    <span
      class={cls("sec-leg", `sec-leg-${chip.band}`)}
      title={chip.title}
      role="img"
      aria-label={chip.title}
    >
      <b aria-hidden="true">{chip.cap}</b>
      <span class="sec-leg-n" aria-hidden="true">
        {chip.pct}
      </span>
      <i class="sec-leg-bar" aria-hidden="true">
        <i style={{ width: `${chip.pct}%` }} />
      </i>
    </span>
  );
}

/** The three trifecta legs U, S, E of a badge. */
export function LegsRow({ legs }: { legs: RiskBadgeData["legs"] | null | undefined }): JSX.Element {
  return (
    <span
      class="sec-legs"
      role="group"
      aria-label="trifecta legs: untrusted input, sensitive read, egress"
    >
      {legChips(legs).map((c) => (
        <LegChipView key={c.cap} chip={c} />
      ))}
    </span>
  );
}

/** Rule and floor chips (R1, H-R1, C3…). A floor is outlined: it is what decided the level. */
export function RulesList({
  rules,
  max,
}: {
  rules: string[] | null | undefined;
  max?: number | undefined;
}): JSX.Element | null {
  const list = rules ?? [];
  if (!list.length) return null;
  const shown = max ? list.slice(0, max) : list;
  return (
    <span class="sec-rules">
      {shown.map((id) => (
        <span key={id} class={cls("sec-rule", isFloor(id) && "floor")} title={ruleLabel(id)}>
          {id}
        </span>
      ))}
      {shown.length < list.length ? (
        <span class="sec-rule more" title={list.slice(shown.length).join(", ")}>
          +{list.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

/** The one-line "drop a leg" advice. Renders nothing without one. */
export function RemedyLine({
  remedy,
}: {
  remedy: string | { line?: string; text?: string } | null | undefined;
}): JSX.Element | null {
  const t = remedyText(remedy);
  if (!t) return null;
  return (
    <p class="sec-remedy">
      <b>to lower it</b>
      <span>{t}</span>
    </p>
  );
}

/** Up to `max` reasons as a list of text nodes. */
export function ReasonList({
  reasons,
  max = 5,
}: {
  reasons: string[] | null | undefined;
  max?: number | undefined;
}): JSX.Element | null {
  const list = (reasons ?? []).slice(0, max);
  if (!list.length) return null;
  return (
    <ul class="sec-reasons">
      {list.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

/** The model's status as a badge; its tooltip says what leaves the machine. */
export function ModelNote({ model }: { model: ModelInput | null | undefined }): JSX.Element {
  const m = modelState(model);
  return (
    <Badge tone={m.tone} title={m.help}>
      {m.label}
    </Badge>
  );
}

/** "Raised by the model" marker next to a level. */
export function RaisedMark({ raised }: { raised: boolean }): JSX.Element | null {
  return raised ? (
    <span class="sec-raised" title="the model raised this above the heuristic level">
      ↑ model
    </span>
  ) : null;
}

/** The shared empty state. */
export function SecEmpty({
  title,
  children,
}: {
  title: string;
  children?: JSX.Element | string | undefined;
}): JSX.Element {
  return (
    <EmptyState compact icon="○" title={title}>
      {children}
    </EmptyState>
  );
}

/**
 * A whole badge as one compact block: level, legs, rules, remedy and reasons. The swarm views use
 * it for a role or a task; `detail` adds the reasons and the remedy.
 */
export function RiskSummary({
  badge,
  detail,
}: {
  badge: RiskBadgeData;
  detail?: boolean | undefined;
}): JSX.Element {
  return (
    <div class="sec-summary">
      <div class="sec-row">
        <RiskBadge level={badge.level} score={badge.score} />
        <LegsRow legs={badge.legs} />
        <RulesList rules={badge.rules} max={detail ? undefined : 4} />
      </div>
      {detail ? (
        <>
          <ReasonList reasons={badge.reasons} />
          <RemedyLine remedy={badge.remedy} />
        </>
      ) : null}
    </div>
  );
}
