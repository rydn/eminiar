import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { SwarmEvent } from "../api.js";
import { cls } from "../util.js";
import { Head, pure, RoleChip, useNow } from "./bits.js";
import { eventIo, KIND_GLYPH, KIND_GROUPS, rel, shortAgent } from "./style.js";

const SHOWN = 300;

function FeedView({
  events,
  roles,
  live,
  skew,
  behind,
  agent,
  onAgent,
}: {
  /** Oldest first, as the API returns them. */
  events: SwarmEvent[];
  roles: string[];
  live: boolean;
  skew: number;
  /** Newer events exist that the feed has not read yet (a burst it is paging through). */
  behind: boolean;
  /** Only this worker's events (picked on the topology canvas). */
  agent: string | null;
  onAgent: (a: string | null) => void;
}): JSX.Element {
  const now = useNow(5_000, live, skew);
  const [role, setRole] = useState("");
  const [group, setGroup] = useState("");
  const kinds = KIND_GROUPS.find(([id]) => id === group)?.[2];
  const seenRoles = [...new Set([...roles, ...events.map((e) => e.role ?? "").filter(Boolean)])];
  const rows = events
    .filter(
      (e) =>
        (!role || e.role === role) &&
        (!kinds || kinds.includes(e.kind)) &&
        (!agent || e.agent_id === agent),
    )
    .reverse();
  return (
    <div class="card sw-feed-card">
      <Head
        title="Activity"
        meta={`${rows.length}${rows.length !== events.length ? ` of ${events.length}` : ""} events`}
      />
      <div class="row sw-filters">
        <select value={role} onChange={(e) => setRole((e.target as HTMLSelectElement).value)}>
          <option value="">all roles</option>
          {seenRoles.map((r) => (
            <option value={r}>{r}</option>
          ))}
        </select>
        <select value={group} onChange={(e) => setGroup((e.target as HTMLSelectElement).value)}>
          <option value="">all kinds</option>
          {KIND_GROUPS.map(([id, label]) => (
            <option value={id}>{label}</option>
          ))}
        </select>
        {agent ? (
          <button type="button" class="chip on" onClick={() => onAgent(null)} title="clear">
            worker {shortAgent(agent)} ✕
          </button>
        ) : null}
      </div>
      <div class="sw-feed" role="log" aria-live="polite">
        {behind ? (
          <div class="sw-ev sw-gap" role="status">
            <span class="t">▲</span>
            <span class="x">
              catching up: newer events are still loading; the rows below are not the latest yet
            </span>
          </div>
        ) : null}
        {rows.length ? (
          rows.slice(0, SHOWN).map((e) => {
            const io = eventIo(e);
            return (
              <div
                key={e.id}
                class={cls("sw-ev", `k-${e.kind}`, `io-${io}`)}
                title={`${new Date(e.ts).toLocaleString()} · ${e.kind}${e.agent_id ? ` · ${e.agent_id}` : ""}`}
              >
                <span class="t">{rel(e.ts, now)}</span>
                <RoleChip role={e.role ?? "coordinator"} roles={roles} />
                <span class="g" title={e.kind}>
                  {KIND_GLYPH[e.kind] ?? "·"}
                </span>
                <span class="x">
                  {e.task_id ? <b>#{e.task_id} </b> : null}
                  {e.text ?? e.kind}
                </span>
              </div>
            );
          })
        ) : (
          <div class="empty small">no events{events.length ? " match the filter" : " yet"}</div>
        )}
        {rows.length > SHOWN ? (
          <div class="muted small sw-more">
            {rows.length - SHOWN} older events not shown; narrow the filter
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Re-rendered when its events or filters change and every 5 s while live. */
export const Feed = pure(FeedView);
