import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SwarmRunDetail, SwarmSegment } from "../api.js";
import { cls } from "../util.js";
import { Head, pure, RoleChip, useNow } from "./bits.js";
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

/** Two clicks: "release", then "confirm release" within a few seconds. */
function ReleaseButton({
  agent,
  onRelease,
}: {
  agent: string;
  onRelease: (agent: string) => Promise<void>;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      class={cls("sm sw-release", armed ? "danger" : "ghost")}
      disabled={busy}
      title="this worker went quiet with no SubagentStop: stop it and put its task back to pending (em_swarm release)"
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onRelease(agent);
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {busy ? "releasing…" : armed ? "confirm release" : "release"}
    </button>
  );
}

function TimelineView({
  timeline: tl,
  live,
  roles,
  skew,
  onRelease,
}: {
  timeline: SwarmRunDetail["timeline"];
  live: boolean;
  roles: string[];
  skew: number;
  /** Release a stale worker (live runs only). */
  onRelease?: ((agent: string) => Promise<void>) | undefined;
}): JSX.Element {
  const now = useNow(5_000, live, skew);
  const start = tl.start;
  const end = Math.max(live ? now : tl.end, start + 1000);
  const span = end - start;
  const pos = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / span) * 100))}%`;
  const width = (a: number, b: number) =>
    `${Math.max(0, Math.min(100, ((Math.min(b, end) - Math.max(a, start)) / span) * 100))}%`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // Drawn from the newest events only: before `from` the busy segments are missing.
  const from = tl.cut && tl.from ? tl.from : null;
  const cutTitle = from
    ? `The timeline is drawn from the newest events only; activity before ${new Date(from).toLocaleString()} is not drawn.`
    : undefined;
  return (
    <div class="card">
      <Head
        title="Timeline"
        meta={
          <span title={cutTitle}>
            {dur(span)}
            {live ? " · live" : ""}
            {tl.cut
              ? ` · oldest events cut${from ? `, drawn from ${new Date(from).toLocaleTimeString()}` : ""}`
              : ""}
          </span>
        }
      />
      {tl.workers.length ? (
        <div class="sw-tl">
          {tl.workers.map((w) => (
            <div class="sw-tl-row" key={w.agent_id}>
              <div class="who" title={w.agent_id}>
                <span class={cls("g", `sw-s-${w.status}`)}>{GLYPH[w.status]}</span>
                <RoleChip role={w.role} roles={roles} />
                <span class="id">{shortAgent(w.agent_id)}</span>
                {live && onRelease && w.status === "stale" ? (
                  <ReleaseButton agent={w.agent_id} onRelease={onRelease} />
                ) : null}
              </div>
              <div class="track" style={`--rc:var(--line)`}>
                {from && from > start ? (
                  <span
                    class="cut"
                    style={{ left: 0, width: width(start, from) }}
                    title={cutTitle}
                  />
                ) : null}
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

/** Re-rendered when the snapshot changes and every 5 s while live, not every second. */
export const Timeline = pure(TimelineView);
