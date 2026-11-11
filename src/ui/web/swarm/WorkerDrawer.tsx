import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { SwarmDecision, SwarmEvent, SwarmRoleUi, SwarmTask, SwarmWorkerUi } from "../api.js";
import { Badge, Drawer, EmptyState, Stat, StatRow } from "../ds.js";
import { cls, fmt } from "../util.js";
import { RoleChip, State, useNow } from "./bits.js";
import { DecisionSection, workerDecisions } from "./decision.js";
import { clip, heartbeat, workerTasks } from "./run-helpers.js";
import { dur, eventIo, GLYPH, KIND_GLYPH, rel, shortAgent } from "./style.js";

/** Events of the worker listed in the drawer (newest first). */
const EVENTS_SHOWN = 50;
const PROMPT_CLIP = 900;

/** The model ladder the range bar is drawn on (cheapest → strongest). */
const LADDER = ["haiku", "sonnet", "opus", "fable"];

function ModelRange({ role }: { role: SwarmRoleUi }): JSX.Element {
  const model = role.model ?? "inherit";
  if (!role.range)
    return (
      <div class="sw-wd-model">
        <Badge tone="purple">{model}</Badge>
        <span class="muted small">{role.model ? "fixed pin" : "inherits the session's model"}</span>
      </div>
    );
  const lo = LADDER.indexOf(role.range.floor);
  const hi = LADDER.indexOf(role.range.ceiling);
  const at = role.model ? LADDER.indexOf(role.model) : -1;
  return (
    <div class="sw-wd-model">
      <Badge tone="purple" title="fallback model inside the range">
        {model}
      </Badge>
      <span class="muted small">
        range {role.range.floor}..{role.range.ceiling}
      </span>
      {lo >= 0 && hi >= 0 ? (
        <div
          class="sw-ladder"
          role="img"
          aria-label={`model range ${role.range.floor} to ${role.range.ceiling}${role.model ? `, fallback ${role.model}` : ""}`}
        >
          {LADDER.map((m, i) => (
            <span class={cls("step", i >= lo && i <= hi && "in", i === at && "at")}>{m}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One worker in a right-hand sheet: what its role is configured to be (model, range, tools,
 * scope), its prompt and summary, the tasks it held and its latest events. Built from the
 * snapshot and the event feed the dashboard already holds.
 */
export function WorkerDrawer({
  worker: w,
  role,
  roles,
  tasks,
  events,
  live,
  skew,
  staleMs,
  onClose,
  decisions,
}: {
  decisions?: Record<number, SwarmDecision> | undefined;
  worker: SwarmWorkerUi;
  /** The role as configured now (absent when the swarm or role left the file). */
  role: SwarmRoleUi | undefined;
  roles: string[];
  tasks: SwarmTask[];
  events: SwarmEvent[];
  live: boolean;
  skew: number;
  staleMs: number;
  onClose: () => void;
}): JSX.Element {
  const now = useNow(5_000, live, skew);
  const [fullPrompt, setFullPrompt] = useState(false);
  const hb = heartbeat(w, now, staleMs);
  const mine = workerTasks(tasks, w.agent_id);
  const evs: SwarmEvent[] = [];
  for (let i = events.length - 1; i >= 0 && evs.length < EVENTS_SHOWN; i--)
    if (events[i]!.agent_id === w.agent_id) evs.push(events[i]!);
  const prompt = w.prompt ? clip(w.prompt, PROMPT_CLIP) : null;
  const ran = (w.ended_at ?? (live ? now : w.last_ts)) - w.spawned_at;
  return (
    <Drawer
      onClose={onClose}
      title={
        <span class="sw-wd-title">
          <RoleChip role={w.role} roles={roles} /> <code>{shortAgent(w.agent_id)}</code>
        </span>
      }
      actions={<State s={w.status} />}
      footer={
        <>
          <span class="muted small sw-wd-foot">the activity feed is filtered to this worker</span>
          <button type="button" class="sm" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <StatRow>
        <Stat
          label="tool calls"
          value={fmt(w.tool_calls)}
          tone="purple"
          sub={w.last_tool ? `last ${w.last_tool}` : "none yet"}
        />
        <Stat
          label="errors"
          value={fmt(w.errors)}
          tone={w.errors ? "bad" : "ok"}
          sub={
            w.tool_calls
              ? `${Math.round((100 * w.errors) / w.tool_calls)}% failed`
              : "failed tool calls"
          }
        />
        <Stat
          label={w.status === "done" ? "ran" : "heartbeat"}
          value={<span class="ds-mono">{w.status === "done" ? dur(ran) : dur(hb.age)}</span>}
          tone={hb.quiet ? "warn" : "muted"}
          sub={
            w.status === "done"
              ? "spawn to stop"
              : hb.quiet
                ? "quiet: no recent event"
                : "since the last event"
          }
        />
      </StatRow>

      <section class="sw-wd-sec">
        <h4>Role</h4>
        {role ? (
          <>
            {role.description ? <p class="small sw-wd-p">{role.description}</p> : null}
            <ModelRange role={role} />
            <div class="sw-wd-kv small">
              <span class="k">tools</span>
              <span>
                {role.tools ? role.tools.join(", ") : "all"}
                {role.disallowedTools?.length ? (
                  <span class="muted"> · not {role.disallowedTools.join(", ")}</span>
                ) : null}
              </span>
              {role.scope.length ? (
                <>
                  <span class="k">scope</span>
                  <span class="mono">{role.scope.join(", ")}</span>
                </>
              ) : null}
              {role.skills.length ? (
                <>
                  <span class="k">skills</span>
                  <span>{role.skills.join(", ")}</span>
                </>
              ) : null}
              <span class="k">agent</span>
              <span class="mono">{w.agent_type}</span>
              {role.isolation ? (
                <>
                  <span class="k">isolation</span>
                  <span>{role.isolation}</span>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <p class="small muted sw-wd-p">
            Role <b>{w.role}</b> is not in the swarm file any more; agent{" "}
            <code>{w.agent_type}</code>.
          </p>
        )}
      </section>

      <section class="sw-wd-sec">
        <h4>Decision</h4>
        <DecisionSection decisions={workerDecisions(decisions, w.agent_id, w.task_id)} />
      </section>

      {w.summary ? (
        <section class="sw-wd-sec">
          <h4>Summary</h4>
          <div class="sw-summary-text">{w.summary}</div>
        </section>
      ) : null}

      <section class="sw-wd-sec">
        <h4>Tasks {mine.length ? <span class="muted">({mine.length})</span> : null}</h4>
        {mine.length ? (
          <ul class="sw-wd-tasks">
            {mine.map((t) => (
              <li class={cls(`st-${t.status}`)}>
                <State s={t.status} />
                <span class="id">#{t.id}</span>
                <span class="t" title={t.title}>
                  {t.title}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div class="muted small">No task claimed by this worker.</div>
        )}
      </section>

      <section class="sw-wd-sec">
        <h4>Prompt</h4>
        {prompt ? (
          <>
            <pre class="sw-pre">{fullPrompt ? w.prompt : prompt.text}</pre>
            {prompt.clipped ? (
              <button type="button" class="ghost sm" onClick={() => setFullPrompt((x) => !x)}>
                {fullPrompt ? "Show less" : `Show all ${fmt(w.prompt?.length ?? 0)} characters`}
              </button>
            ) : null}
          </>
        ) : (
          <div class="muted small">The spawn prompt was not recorded.</div>
        )}
      </section>

      <section class="sw-wd-sec">
        <h4>
          Latest events <span class="muted">({evs.length})</span>
        </h4>
        {evs.length ? (
          <div class="sw-feed sw-wd-feed">
            {evs.map((e) => (
              <div
                key={e.id}
                class={cls("sw-ev sw-ev-mini", `k-${e.kind}`, `io-${eventIo(e)}`)}
                title={`${new Date(e.ts).toLocaleString()} · ${e.kind}`}
              >
                <span class="t">{rel(e.ts, now)}</span>
                <span class="g">{KIND_GLYPH[e.kind] ?? "·"}</span>
                <span class="x">
                  {e.task_id ? <b>#{e.task_id} </b> : null}
                  {e.text ?? e.kind}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState compact icon={GLYPH.idle} title="No events read yet">
            The feed keeps the newest events of the run; this worker has none among them.
          </EmptyState>
        )}
      </section>
    </Drawer>
  );
}
