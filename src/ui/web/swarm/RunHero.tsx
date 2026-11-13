import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { post, type SwarmFinishResult, type SwarmRunDetail } from "../api.js";
import { toast } from "../components.js";
import { Badge, Gauge, Hero, Pill, SegBar, Sparkline, Stat, StatRow } from "../ds.js";
import { ago, cls, fmt } from "../util.js";
import { State, useNow } from "./bits.js";
import { RunRiskMark } from "./RunRiskMark.js";
import { activityPerMinute, progress } from "./run-helpers.js";
import { dur, GLYPH, STATE_TONE, TOPOLOGY_GLYPH } from "./style.js";

/** What finishing the run from this tab did, shown under the hero once it closed. */
export interface Finished {
  status: string;
  memory: string | null;
  memoryError: string | null;
  remember: boolean;
}

function FinishNote({ f }: { f: Finished }): JSX.Element | null {
  if (f.memoryError)
    return (
      <div class="sw-note-box warn small" role="alert">
        <State s="blocked" word="memory not written" /> The run closed as <b>{f.status}</b>, but its
        outcome was not saved as a memory: {f.memoryError}. Record it with <code>em_remember</code>.
      </div>
    );
  if (f.remember && f.memory)
    return (
      <div class="sw-note-box small">
        <State s="done" word="memory written" /> <code>{f.memory}</code>
      </div>
    );
  return null;
}

function FinishForm({ id, onDone }: { id: string; onDone: (f: Finished) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"done" | "failed" | "cancelled">("done");
  const [summary, setSummary] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  if (!open)
    return (
      <button type="button" class="sm sw-finish-btn" onClick={() => setOpen(true)}>
        ■ Finish run…
      </button>
    );
  return (
    <form
      class="sw-finish"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(undefined);
        try {
          const r = await post<SwarmFinishResult>("/api/swarm/finish", {
            id,
            status,
            summary: summary.trim() || undefined,
            remember,
          });
          const memoryError = r.memoryError ?? null;
          toast(
            memoryError
              ? `run finished as ${status} · its memory was NOT written`
              : `run finished as ${status}${r.memory ? ` · memory ${r.memory}` : ""}`,
            !!memoryError,
          );
          setOpen(false);
          onDone({ status, memory: r.memory, memoryError, remember });
        } catch (ex) {
          setErr((ex as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div class="row">
        <span class="small muted">close the run as</span>
        {(["done", "failed", "cancelled"] as const).map((s) => (
          <label class={cls("sw-radio", status === s && "on")}>
            <input
              type="radio"
              name={`finish-${id}`}
              checked={status === s}
              onChange={() => setStatus(s)}
            />
            <State s={s} />
          </label>
        ))}
      </div>
      <textarea
        class="sw-summary"
        placeholder="Summary (optional): the outcome in a sentence or two"
        value={summary}
        maxLength={4000}
        onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
      />
      <label class="small row tight">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
        />
        also write the outcome as a project memory (<code>swarm/run-…</code>)
      </label>
      <div class="row">
        <button type="submit" class="primary sm" disabled={busy}>
          {busy ? "Finishing…" : `Finish as ${status}`}
        </button>
        <button type="button" class="ghost sm" onClick={() => setOpen(false)}>
          Keep running
        </button>
        {err ? <span class="bad small">{err}</span> : null}
      </div>
    </form>
  );
}

const elapsedOf = (run: SwarmRunDetail["run"], now: number): number | null =>
  run.status === "active"
    ? now - run.created_at
    : run.ended_at
      ? run.ended_at - run.created_at
      : null;

/** The live elapsed counter: the only part of the hero that ticks every second. */
function ElapsedStat({ run, skew }: { run: SwarmRunDetail["run"]; skew: number }): JSX.Element {
  const live = run.status === "active";
  const now = useNow(1000, live, skew);
  return (
    <Stat
      label="elapsed"
      value={<span class="ds-mono">{dur(elapsedOf(run, now))}</span>}
      tone={live ? "accent" : "muted"}
      sub={
        live
          ? `since ${new Date(run.created_at).toLocaleTimeString()}`
          : run.ended_at
            ? `ended ${ago(run.ended_at)}`
            : "end time not recorded"
      }
    />
  );
}

/**
 * The run's header band: goal, state, swarm and topology, the finish action, two gauges
 * (tasks closed, worker capacity) and the stat row. Everything comes from the snapshot the
 * dashboard already polls; nothing here fetches.
 */
export function RunHero({
  detail,
  skew,
  finished,
  onFinished,
}: {
  detail: SwarmRunDetail;
  skew: number;
  finished: Finished | undefined;
  onFinished: (f: Finished) => void;
}): JSX.Element {
  const { run, counts } = detail;
  const live = run.status === "active";
  const tasksTotal = detail.tasks.length;
  const bad = counts.tasks.failed + counts.tasks.blocked;
  const workersTotal = detail.workers.length;
  const running = counts.workers.running;
  const cap = detail.maxAgents ?? 0;
  const activity = activityPerMinute(detail.timeline);
  const done = progress({ done: counts.tasks.done, total: tasksTotal });
  const errorRate = counts.toolCalls > 0 ? counts.errors / counts.toolCalls : 0;
  return (
    <div class={cls("sw-hero", live && "is-live")}>
      <Hero
        eyebrow={
          <>
            <span class="sw-hero-topo" title={run.topology}>
              {TOPOLOGY_GLYPH[run.topology]}
            </span>
            <span>
              {run.topology} swarm <b class="sw-hero-swarm">{run.swarm}</b>
            </span>
            <code class="sw-hero-id" title="run id">
              {run.id}
            </code>
          </>
        }
        title={<span class="sw-hero-goal">{run.goal}</span>}
        sub={
          run.summary ? (
            <span class="sw-hero-summary">{run.summary}</span>
          ) : (
            <span title={new Date(run.created_at).toLocaleString()}>
              started {ago(run.created_at)}
              {run.session_id ? (
                <>
                  {" "}
                  by session <code>{run.session_id.slice(0, 8)}</code>
                </>
              ) : null}
            </span>
          )
        }
        meta={
          <>
            <Pill tone={STATE_TONE[run.status]} pulse={live} title={`run ${run.status}`}>
              {/* the pill's dot is the glyph while active; other states keep their own */}
              {live ? "" : `${GLYPH[run.status]} `}
              {run.status}
            </Pill>
            {!detail.configured ? (
              <Badge tone="warn" title="the run's swarm was removed from the swarm file">
                {GLYPH.blocked} swarm no longer configured
              </Badge>
            ) : null}
            {counts.staleHeld ? (
              <Badge tone="warn" title="active tasks held by a worker that went quiet or stopped">
                {GLYPH.stale} {counts.staleHeld} held by a quiet worker
              </Badge>
            ) : null}
            {counts.autoClosed ? (
              <Badge
                tone="warn"
                title="tasks closed by SubagentStop: the worker stopped without reporting"
              >
                ↺ {counts.autoClosed} auto-closed
              </Badge>
            ) : null}
            {live ? <FinishForm id={run.id} onDone={onFinished} /> : null}
          </>
        }
        aside={
          <>
            <Gauge
              class="sw-hero-gauge"
              value={done}
              size={104}
              tone={bad && !counts.tasks.done ? "bad" : "ok"}
              label={tasksTotal ? `${Math.round(done * 100)}%` : "–"}
              caption={tasksTotal ? "done" : "no tasks"}
              title={`${counts.tasks.done} of ${tasksTotal} tasks done`}
            />
            <Gauge
              value={cap ? running / cap : running ? 1 : 0}
              size={80}
              tone={live ? "accent" : "muted"}
              label={cap ? `${running}/${cap}` : String(running)}
              caption="running"
              title={
                cap
                  ? `${running} of at most ${cap} workers running at once (max_agents)`
                  : `${running} workers running`
              }
            />
          </>
        }
      />
      {finished ? <FinishNote f={finished} /> : null}
      <StatRow>
        <Stat
          label="workers"
          value={
            <>
              {running}
              <span class="sw-stat-of">/{cap || workersTotal}</span>
            </>
          }
          tone={running ? "accent" : "muted"}
          sub={
            workersTotal
              ? `${workersTotal} spawned · ${counts.workers.stale} stale · ${counts.workers.done} done`
              : "none spawned yet"
          }
        />
        <Stat
          label="tasks"
          value={
            <>
              {counts.tasks.done}
              <span class="sw-stat-of">/{tasksTotal}</span>
            </>
          }
          tone={bad ? "warn" : "ok"}
          sub={
            tasksTotal
              ? `${counts.tasks.active} active · ${counts.tasks.pending} pending · ${bad} failed/blocked`
              : "none planned"
          }
        >
          {tasksTotal ? (
            <SegBar
              total={tasksTotal}
              title={`${counts.tasks.done} done · ${counts.tasks.active} active · ${bad} failed/blocked of ${tasksTotal}`}
              segments={[
                { value: counts.tasks.done, tone: "ok", label: `${counts.tasks.done} done` },
                {
                  value: counts.tasks.active,
                  tone: "accent",
                  label: `${counts.tasks.active} active`,
                },
                { value: bad, tone: "bad", label: `${bad} failed/blocked` },
              ]}
            />
          ) : null}
        </Stat>
        <Stat
          label="tool calls"
          value={fmt(counts.toolCalls)}
          tone="purple"
          sub={
            activity.total
              ? `peak ${fmt(Math.round(activity.peak))}/min`
              : workersTotal
                ? "no activity drawn yet"
                : "no workers yet"
          }
        >
          {activity.values.length > 1 ? (
            <Sparkline
              values={activity.values}
              tone="purple"
              height={30}
              title={`events per minute, ${activity.values.length} buckets of ${Math.round(activity.bucketMs / 60_000)} min`}
            />
          ) : null}
        </Stat>
        <Stat
          label="errors"
          value={fmt(counts.errors)}
          tone={counts.errors > 0 ? "bad" : "ok"}
          sub={
            counts.toolCalls
              ? `${(errorRate * 100).toFixed(errorRate < 0.1 ? 1 : 0)}% of tool calls failed`
              : "failed tool calls"
          }
        />
        <ElapsedStat run={run} skew={skew} />
        {detail.risk ? (
          <Stat
            label="risk"
            value={<RunRiskMark risk={detail.risk} />}
            tone="muted"
            sub="worst of the latest assessment per task"
          />
        ) : null}
      </StatRow>
    </div>
  );
}
