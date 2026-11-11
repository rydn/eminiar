import type { JSX } from "preact";
import type { SwarmDecision } from "../api.js";
import { Badge } from "../ds.js";
import { cls } from "../util.js";
import {
  adviceVerb,
  effortLabel,
  followText,
  notDispatchedLabel,
  ranModel,
} from "./decision-helpers.js";

export {
  adviceKept,
  adviceVerb,
  effortLabel,
  followText,
  notDispatchedLabel,
  ranModel,
  workerDecisions,
} from "./decision-helpers.js";

const FOLLOW_TONE: Record<string, "ok" | "warn" | "muted" | "accent"> = {
  followed: "ok",
  overrode: "warn",
  pinned: "accent",
  forced: "warn",
  fork: "muted",
  none: "muted",
};

/** "model · effort" on a task card; a marker when it differs from the suggestion. */
export function DecisionChip({ d }: { d: SwarmDecision | undefined }): JSX.Element | null {
  if (!d?.ran) return null;
  const model = ranModel(d) ?? "n/a";
  const effort = effortLabel(d);
  const differs = d.modelDiffers || d.effortDiffers;
  const sug = d.advice
    ? `${adviceVerb(d)} ${d.advice.model ?? "n/a"}${d.advice.effort ? ` · ${d.advice.effort}` : ""}`
    : "no adjudicator suggestion";
  const differing = [d.modelDiffers && "model", d.effortDiffers && "effort"]
    .filter(Boolean)
    .join(" and ");
  const full = `ran ${model} · effort ${effort}; ${sug}.${differs ? ` Differs from the suggestion in ${differing}.` : ""} ${followText(d)}`;
  // The visible text is aria-hidden and a visually hidden sentence replaces it, so the details do not depend on hover.
  return (
    <span class={cls("sw-badge", "sw-dec", differs && "warn")} title={full}>
      <span aria-hidden="true">
        {model} · {effort}
        {differs ? " ≠" : ""}
      </span>
      <span class="sw-dec-sr">{full}</span>
    </span>
  );
}

/** Ran at / suggested / outcome, for the worker drawer and cards. */
export function DecisionSection({ decisions }: { decisions: SwarmDecision[] }): JSX.Element {
  const list = decisions.filter((d) => d.ran || d.advice);
  if (!list.length)
    return (
      <div class="muted small">
        No adjudicator decision was recorded for this worker (the adjudicator may be off).
      </div>
    );
  return (
    <>
      {list.map((d) => (
        <div class="sw-dec-box" key={d.taskId}>
          <div class="sw-dec-head small">
            <span class="id">#{d.taskId}</span> <span class="t">{d.title}</span>
            <Badge tone={FOLLOW_TONE[d.follow]}>{d.follow}</Badge>
          </div>
          <div class="sw-wd-kv small">
            <span class="k">ran at</span>
            <span>
              {d.ran ? `${ranModel(d) ?? "n/a"} · effort ${effortLabel(d)}` : notDispatchedLabel(d)}
            </span>
            <span class="k">{d.advice ? adviceVerb(d) : "suggested"}</span>
            <span>
              {d.advice ? (
                <>
                  {d.advice.model ?? "no model"} · effort {d.advice.effort ?? "n/a"}
                  {d.advice.confidence !== undefined ? (
                    <span class="muted">
                      {" "}
                      · confidence {Math.round(d.advice.confidence * 100)}%
                    </span>
                  ) : null}
                  {d.modelDiffers || d.effortDiffers ? (
                    <span class="muted">
                      {" "}
                      · differs (
                      {[d.modelDiffers && "model", d.effortDiffers && "effort"]
                        .filter(Boolean)
                        .join(", ")}
                      )
                    </span>
                  ) : null}
                </>
              ) : (
                <span class="muted">none</span>
              )}
            </span>
            <span class="k">outcome</span>
            <span>{followText(d)}</span>
            {d.advice?.reasons.length ? (
              <>
                <span class="k">why</span>
                <ul class="sw-dec-why">
                  {d.advice.reasons.map((r) => (
                    <li>{r}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}
