import type { JSX } from "preact";
import type { SwarmRunDetail, SwarmSegment } from "../api.js";
import { cls } from "../util.js";
import { Head, RoleChip } from "./bits.js";
import { dur, GLYPH, shortAgent } from "./style.js";

const segTitle = (s: SwarmSegment): string => {
  const io = Object.entries(s.io)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(" · ");
  return [
    `${new Date(s.start).toLocaleTimeString()} → ${s.open ? "now" : new Date(s.end).toLocaleTimeString()} (${dur(s.end - s.start)})`,
    `${s.n} events${io ? ` · ${io}` : ""}${s.errors ? ` · ${s.errors} errors` : ""}`,
  ].join("\n");
};

/** Dominant io of a segment, for its colour. */
const dominant = (s: SwarmSegment): string => {
  let best = "swarm";
  let n = -1;
  for (const [k, v] of Object.entries(s.io))
    if (v > n) {
      best = k;
      n = v;
    }
  return n > 0 ? best : "swarm";
};

export function Timeline({
  detail,
  roles,
  now,
}: {
  detail: SwarmRunDetail;
  roles: string[];
  now: number;
}): JSX.Element {
  const tl = detail.timeline;
  const live = detail.run.status === "active";
  const start = tl.start;
  const end = Math.max(live ? now : tl.end, start + 1000);
  const span = end - start;
  const pos = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / span) * 100))}%`;
  const width = (a: number, b: number) =>
    `${Math.max(0, Math.min(100, ((Math.min(b, end) - Math.max(a, start)) / span) * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div class="card">
      <Head
        title="Timeline"
        meta={`${dur(span)}${live ? " · live" : ""}${tl.cut ? " · oldest events cut" : ""}`}
      />
      {tl.workers.length ? (
        <div class="sw-tl">
          {tl.workers.map((w) => (
            <div class="sw-tl-row">
              <div class="who" title={w.agent_id}>
                <span class={cls("g", `sw-s-${w.status}`)}>{GLYPH[w.status]}</span>
                <RoleChip role={w.role} roles={roles} />
                <span class="id">{shortAgent(w.agent_id)}</span>
              </div>
              <div class="track" style={`--rc:var(--line)`}>
                {/* the worker's lifetime, busy or not */}
                <span
                  class="life"
                  style={{
                    left: pos(w.spawned_at),
                    width: width(w.spawned_at, w.ended_at ?? (live ? now : end)),
                  }}
                />
                {w.segments.map((s) => (
                  <span
                    class={cls("seg", `io-${dominant(s)}`, s.errors > 0 && "err", s.open && "open")}
                    style={{ left: pos(s.start), width: width(s.start, s.end) }}
                    title={segTitle(s)}
                  />
                ))}
              </div>
            </div>
          ))}
          <div class="sw-tl-row axis">
            <div class="who" />
            <div class="track">
              {ticks.map((f) => (
                <span class="tick" style={{ left: `${f * 100}%` }}>
                  {f === 0 ? new Date(start).toLocaleTimeString() : `+${dur(span * f)}`}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div class="empty small">No workers have started in this run.</div>
      )}
    </div>
  );
}
