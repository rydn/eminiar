import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  api,
  post,
  type SwarmDefUi,
  type SwarmEvent,
  type SwarmEventsPage,
  type SwarmFinishResult,
  type SwarmIssue,
  type SwarmOverview,
  type SwarmRunDetail,
  type SwarmRunSummary,
  type SwarmSyncResult,
  type SwarmTask,
} from "../api.js";
import { ErrorBox, Spinner, toast, useAsync } from "../components.js";
import { Blackboard } from "../swarm/Blackboard.js";
import { Head, RoleChip, State, useNow } from "../swarm/bits.js";
import { Feed } from "../swarm/Feed.js";
import { dur, FILE_STATE, GLYPH, TOPOLOGY_GLYPH } from "../swarm/style.js";
import { TaskBoard } from "../swarm/TaskBoard.js";
import { Timeline } from "../swarm/Timeline.js";
import { Topology } from "../swarm/Topology.js";
import { Yaml } from "../swarm/Yaml.js";
import { ago, cls, fmt } from "../util.js";

const LIST_POLL_MS = 15_000;
const EVENTS_POLL_MS = 2_000;
const SNAPSHOT_POLL_MS = 5_000;
const KEEP_EVENTS = 800;
/** Event pages (200 each) read per poll; a bigger burst is read over the next polls. */
const EVENT_PAGES_PER_TICK = 5;
/** Runs in the rail per "show more". */
const RUNS_STEP = 30;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const visible = () => document.visibilityState === "visible";

function mergeEvents(prev: SwarmEvent[], next: SwarmEvent[]): SwarmEvent[] {
  if (!next.length) return prev;
  const byId = new Map(prev.map((e) => [e.id, e]));
  for (const e of next) byId.set(e.id, e);
  const out = [...byId.values()].sort((a, b) => a.id - b.id);
  return out.length > KEEP_EVENTS ? out.slice(-KEEP_EVENTS) : out;
}

// --- writes ---------------------------------------------------------------------------

function CreateButton({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <span class="row tight">
      <button
        type="button"
        class="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(undefined);
          try {
            const r = await post<{ created: string; sync: SwarmSyncResult }>("/api/swarm/init", {});
            toast(`created ${r.created} · ${r.sync.changed} agent file(s) written`);
            onCreated();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Creating…" : "Create .eminiar/swarm.yaml"}
      </button>
      {err ? <span class="bad small">{err}</span> : null}
    </span>
  );
}

function SyncButton({ needed, onDone }: { needed: boolean; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean }>();
  return (
    <div class="row tight sw-sync">
      <button
        type="button"
        class={cls("sm", needed && "primary")}
        disabled={busy}
        title="write .claude/agents/swarm-<swarm>-<role>.md from the swarm file"
        onClick={async () => {
          setBusy(true);
          setMsg(undefined);
          try {
            const r = await post<SwarmSyncResult>("/api/swarm/sync", {});
            const text = `${r.changed} file(s) changed${r.conflicts ? ` · ${r.conflicts} conflict(s) left alone` : ""}`;
            setMsg({ text, bad: r.conflicts > 0 });
            onDone();
          } catch (e) {
            setMsg({ text: (e as Error).message, bad: true });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Syncing…" : "Sync agent files"}
      </button>
      {msg ? (
        <span class={cls("small", msg.bad ? "bad" : "muted")}>{msg.text}</span>
      ) : needed ? (
        <span class="small warn">{GLYPH.blocked} out of date</span>
      ) : (
        <span class="small muted">{GLYPH.done} in sync</span>
      )}
    </div>
  );
}

/** What finishing the run from this tab did, shown under the run header once it closed. */
interface Finished {
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
      <button type="button" class="sm" onClick={() => setOpen(true)}>
        Finish run…
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

// --- left rail ------------------------------------------------------------------------

function Issues({ issues }: { issues: SwarmIssue[] }): JSX.Element {
  return (
    <ul class="sw-issues">
      {issues.map((i) => (
        <li>
          <span class="g sw-s-failed">{GLYPH.failed}</span>
          <span class="ln mono">{i.line ? `line ${i.line}` : "file"}</span>
          {i.path ? <code>{i.path}</code> : null} <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

function SwarmCard({ s }: { s: SwarmDefUi }): JSX.Element {
  const [open, setOpen] = useState(false);
  const roles = s.roles.map((r) => r.role);
  const byState = new Map<string, number>();
  for (const r of s.roles) byState.set(r.file.action, (byState.get(r.file.action) ?? 0) + 1);
  return (
    <div class={cls("sw-swarm", open && "open")}>
      <button
        type="button"
        class="sw-btn h"
        aria-expanded={open}
        title={open ? "hide the roles" : "show the roles, models and tools"}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="topo" title={s.topology}>
          {TOPOLOGY_GLYPH[s.topology]}
        </span>
        <b>{s.name}</b>
        <span class="muted small">
          {s.topology} · max {s.maxAgents}
        </span>
        <span class="caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      <div class="d small muted">{s.description}</div>
      <div class="chips">
        {s.roles.map((r) => {
          const f = FILE_STATE[r.file.action];
          return (
            <RoleChip
              role={r.role}
              roles={roles}
              title={`${r.description}\n${r.agentType} · ${f.word}${r.file.reason ? ` (${r.file.reason})` : ""}`}
            >
              {r.count > 1 ? <span class="n">×{r.count}</span> : null}
              <span class={cls("fs", f.cls)}>{f.glyph}</span>
            </RoleChip>
          );
        })}
      </div>
      <div class="files small">
        <span class="muted">agent files</span>
        {[...byState.entries()].map(([a, n]) => {
          const f = FILE_STATE[a as keyof typeof FILE_STATE];
          return (
            <span class={f.cls}>
              {f.glyph} {n} {f.short}
            </span>
          );
        })}
      </div>
      {s.topology === "pipeline" && s.stages.length ? (
        <div class="small muted mono">stages {s.stages.join(" → ")}</div>
      ) : null}
      {open ? (
        <div class="more">
          <table class="sw-roles">
            <thead>
              <tr>
                <th>role</th>
                <th>model</th>
                <th class="num">count</th>
                <th>tools</th>
              </tr>
            </thead>
            <tbody>
              {s.roles.map((r) => (
                <tr title={r.description}>
                  <td>
                    <RoleChip role={r.role} roles={roles} />
                    {r.hasHooks ? <span class="sw-badge">hooks</span> : null}
                    {r.isolation ? <span class="sw-badge">{r.isolation}</span> : null}
                  </td>
                  <td class="mono">{r.model ?? "inherit"}</td>
                  <td class="num">{r.count}</td>
                  <td class="small">
                    {r.tools ? r.tools.join(", ") : "all"}
                    {r.disallowedTools?.length ? (
                      <span class="muted"> · not {r.disallowedTools.join(", ")}</span>
                    ) : null}
                    {r.skills.length ? <div class="muted">skills {r.skills.join(", ")}</div> : null}
                    {r.scope.length ? <div class="muted">scope {r.scope.join(", ")}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.instructions ? <pre class="sw-pre">{s.instructions}</pre> : null}
          <div class="small muted">
            spawn with <code>subagent_type: swarm-{s.name}-&lt;role&gt;</code>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConfigPanel({ o, onChanged }: { o: SwarmOverview; onChanged: () => void }): JSX.Element {
  if (o.state === "absent")
    return (
      <div class="card">
        <Head title="Swarms" meta="not opted in" />
        <p class="small muted sw-p">
          Agent swarms are off for this project: no <code>{o.file}</code>.
        </p>
        <CreateButton onCreated={onChanged} />
      </div>
    );
  if (o.state === "invalid")
    return (
      <div class="card">
        <Head title="Swarms" meta={<State s="failed" word="invalid" />} />
        <div class="small mono">{o.file}</div>
        <Issues issues={o.issues} />
        <p class="small muted sw-p">
          While the file is invalid, hooks ignore it and no agent files are written. This tab
          re-reads it every 15 s.
        </p>
      </div>
    );
  return (
    <div class="card">
      <Head title="Swarms" meta={`${o.swarms.length} defined`} />
      <div class="small muted mono sw-file">
        {o.file} · sync {o.sync ?? "n/a"}
      </div>
      {!o.enabled ? (
        <div class="sw-note-box">
          <State s="stale" word="disabled" /> <code>enabled: false</code>: hooks ignore the swarms
          and a sync removes the generated agent files. Shown read-only.
        </div>
      ) : null}
      {o.swarms.map((s) => (
        <SwarmCard s={s} />
      ))}
      {o.orphans.length ? (
        <div class="small sw-orphans">
          {o.orphans.map((x) => (
            <div>
              <span class="sw-s-stale">{GLYPH.stale}</span> <code>{x.path}</code>{" "}
              <span class="muted">{x.reason ?? "will be removed"}</span>
            </div>
          ))}
        </div>
      ) : null}
      {o.enabled ? <SyncButton needed={o.syncNeeded} onDone={onChanged} /> : null}
    </div>
  );
}

function RunList({
  runs,
  selected,
  more,
  loading,
  onMore,
}: {
  runs: SwarmRunSummary[];
  selected: string | undefined;
  /** Older runs exist that the list leaves out. */
  more: boolean;
  loading: boolean;
  onMore: () => void;
}): JSX.Element {
  const active = runs.filter((r) => r.status === "active").length;
  return (
    <div class="card flush">
      <div class="sw-pad">
        <Head
          title="Runs"
          meta={runs.length ? `${active} active · ${runs.length}${more ? "+" : ""}` : "none"}
        />
      </div>
      {runs.length ? (
        <div class="list sw-runs">
          {runs.map((r) => {
            const t = r.counts.tasks;
            return (
              <a
                key={r.id}
                class={cls("item", r.id === selected && "sel")}
                href={`#/swarm?run=${encodeURIComponent(r.id)}`}
                aria-current={r.id === selected ? "page" : undefined}
              >
                <div class="row tight">
                  <State s={r.status} />
                  <span class="spacer" />
                  <span class="muted small" title={new Date(r.created_at).toLocaleString()}>
                    {ago(r.created_at)}
                  </span>
                </div>
                <div class="n sw-goal" title={r.goal}>
                  {r.goal}
                </div>
                <div class="p">
                  {TOPOLOGY_GLYPH[r.topology]} {r.swarm} ·{" "}
                  {t.total ? `${t.done}/${t.total} tasks` : "no tasks"}
                  {r.counts.workers.running ? ` · ${r.counts.workers.running} running` : ""}
                  {t.failed + t.blocked ? ` · ${t.failed + t.blocked} failed/blocked` : ""}
                </div>
                {t.total ? (
                  <div class="sw-progress" title={`${t.done} of ${t.total} done`}>
                    <span class="done" style={{ width: `${(100 * t.done) / t.total}%` }} />
                    <span class="active" style={{ width: `${(100 * t.active) / t.total}%` }} />
                    <span
                      class="bad"
                      style={{ width: `${(100 * (t.failed + t.blocked)) / t.total}%` }}
                    />
                  </div>
                ) : null}
              </a>
            );
          })}
          {more ? (
            <div class="sw-more">
              <button type="button" class="ghost sm" disabled={loading} onClick={onMore}>
                {loading ? "Loading…" : `Show ${RUNS_STEP} older runs`}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div class="empty small">No runs yet.</div>
      )}
    </div>
  );
}

// --- main panels without a run --------------------------------------------------------

function Commands({ swarms }: { swarms: string[] }): JSX.Element {
  const name = swarms[0] ?? "feature";
  return (
    <div class="sw-cmds">
      <div>
        <span class="muted small">in a terminal</span>
        <code>eminiar swarm init</code>
      </div>
      <div>
        <span class="muted small">in Claude Code</span>
        <code>/eminiar:em-swarm {name} &lt;goal&gt;</code>
      </div>
    </div>
  );
}

function OptIn({ o, onCreated }: { o: SwarmOverview; onCreated: () => void }): JSX.Element {
  return (
    <div class="card sw-optin">
      <Head title="Agent swarms" meta="opt-in · off for this project" />
      <p>
        A swarm is a team of Claude Code subagents defined in <code>{o.file}</code>: named roles
        with their prompts, models, tools, skills and hooks, and how they coordinate (hierarchical,
        mesh or pipeline). Your main session leads the run; each worker starts with what eminiar
        knows about the project (memories, history, structure), and this tab shows the run live.
      </p>
      <p class="muted small">
        Nothing changes until the file exists: no agent files, no swarm work in any hook. Creating
        it writes the starter below and generates one agent file per role under{" "}
        <code>.claude/agents/</code>.
      </p>
      <div class="row">
        <CreateButton onCreated={onCreated} />
      </div>
      <Commands swarms={[]} />
      <Head title="Starter" meta={`${o.file} · read-only preview`} />
      {o.starter ? <Yaml text={o.starter} /> : null}
    </div>
  );
}

function NoRun({ o }: { o: SwarmOverview }): JSX.Element {
  if (o.state === "invalid")
    return (
      <div class="card sw-optin">
        <Head title="Swarm file is invalid" meta={o.file} />
        <p>Fix these and the swarms appear here:</p>
        <Issues issues={o.issues} />
      </div>
    );
  return (
    <div class="card sw-optin">
      <Head title="No runs yet" meta={o.enabled ? "ready" : "disabled"} />
      <p>
        Start a run from Claude Code. The coordinator (your session) plans tasks and spawns the
        workers; they appear here as they start.
      </p>
      <Commands swarms={o.swarms.map((s) => s.name)} />
    </div>
  );
}

// --- one run --------------------------------------------------------------------------

function Stat({
  label,
  value,
  sub,
  tone,
  children,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: string | false;
  children?: JSX.Element | null;
}): JSX.Element {
  return (
    <div class="card sw-stat">
      <h3>{label}</h3>
      <div class={cls("big", tone || undefined)}>{value}</div>
      <div class="sub">{sub}</div>
      {children}
    </div>
  );
}

/** The elapsed tile, the only part of the run view that ticks every second. */
function Elapsed({ run, skew }: { run: SwarmRunDetail["run"]; skew: number }): JSX.Element {
  const live = run.status === "active";
  const now = useNow(1000, live, skew);
  const elapsed = live ? now - run.created_at : run.ended_at ? run.ended_at - run.created_at : null;
  return (
    <Stat
      label="elapsed"
      value={dur(elapsed)}
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

const sameList = (a: string[] | undefined, b: string[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

function RunView({ id, onChanged }: { id: string; onChanged: () => void }): JSX.Element {
  const [detail, setDetail] = useState<SwarmRunDetail>();
  const [error, setError] = useState<string>();
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [behind, setBehind] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [skew, setSkew] = useState(0);
  const [finished, setFinished] = useState<Finished>();
  /** The feed's cursor: every event of the run up to this id has been read, in order. */
  const lastId = useRef(0);
  const loaded = useRef(false);
  /** Tasks by id, merged from full snapshots and deltas (`tasksSince`). */
  const tasks = useRef(new Map<number, SwarmTask>());
  const tasksList = useRef<SwarmTask[]>([]);
  const tasksMax = useRef(0);
  const roles = useRef<string[]>();
  const status = useRef("");
  const behindRef = useRef(false);
  const busy = useRef(false);
  const alive = useRef(true);

  /** Fetch the snapshot; false when it failed (the error is shown). */
  const load = useCallback(
    async (full = false): Promise<boolean> => {
      // After the first snapshot: only the tasks changed since, and no events (the feed
      // follows /api/swarm/events, which never skips any).
      const delta = loaded.current && !full && tasksMax.current > 0;
      let d: SwarmRunDetail;
      try {
        d = await api<SwarmRunDetail>("/api/swarm/run", {
          id,
          tasksSince: delta ? tasksMax.current : undefined,
          events: loaded.current ? 0 : undefined,
        });
      } catch (e) {
        if (alive.current) setError((e as Error).message);
        return false;
      }
      if (!alive.current) return true;
      let changed = !d.tasksPartial;
      if (d.tasksPartial) {
        for (const t of d.tasks) {
          const had = tasks.current.get(t.id);
          if (!had || had.updated_at !== t.updated_at || had.status !== t.status) changed = true;
          tasks.current.set(t.id, t);
        }
        // A task missed by the delta (should not happen): take them all again.
        if (d.taskCount !== undefined && tasks.current.size !== d.taskCount) return load(true);
      } else tasks.current = new Map(d.tasks.map((t) => [t.id, t]));
      if (changed) {
        tasksList.current = [...tasks.current.values()].sort((a, b) => a.id - b.id);
        tasksMax.current = tasksList.current.reduce((m, t) => Math.max(m, t.updated_at), 0);
      }
      if (!sameList(roles.current, d.roles)) roles.current = d.roles;
      const s = d.now - Date.now();
      setSkew((old) => (Math.abs(old - s) > 1000 ? s : old));
      const was = status.current;
      status.current = d.run.status;
      if (!loaded.current) {
        loaded.current = true;
        lastId.current = d.events.length ? d.events[d.events.length - 1]!.id : 0;
        setEvents(d.events);
      }
      setDetail({ ...d, tasks: tasksList.current, roles: roles.current ?? d.roles });
      setError(undefined);
      setRetryIn(null);
      if (was === "active" && d.run.status !== "active") {
        // Read the feed to its end once more (the finish event and anything before it).
        behindRef.current = true;
        onChanged();
      }
      return true;
    },
    [id],
  );

  const release = useCallback(
    async (agent: string) => {
      try {
        const r = await post<{ released: string[] }>("/api/swarm/release", { id, agent });
        toast(`released ${r.released.join(", ")}; its task is pending again`);
        void load(true);
      } catch (e) {
        toast(`release failed: ${(e as Error).message}`, true);
      }
    },
    [id, load],
  );

  useEffect(() => {
    alive.current = true;
    // A failed first load is retried with backoff until a snapshot arrives.
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_MIN_MS;
    const first = async () => {
      if ((await load()) || !alive.current || loaded.current) return;
      setRetryIn(delay);
      retry = setTimeout(first, delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };
    void first();
    const poll = setInterval(async () => {
      if (!loaded.current || busy.current || !visible()) return;
      // A finished run is still read to its end if a burst was being paged through.
      if (status.current !== "active" && !behindRef.current) return;
      busy.current = true;
      try {
        let more = true;
        let over = false;
        // Contiguous pages from the cursor, a few per tick: a burst is caught up in order.
        for (let i = 0; i < EVENT_PAGES_PER_TICK && more; i++) {
          const page = await api<SwarmEventsPage>("/api/swarm/events", {
            id,
            after: lastId.current,
          });
          if (!alive.current) return;
          if (page.events.length) {
            lastId.current = page.last;
            setEvents((prev) => mergeEvents(prev, page.events));
          }
          more = page.more;
          over = page.run.status !== "active";
        }
        behindRef.current = more;
        setBehind(more);
        if (over && !more && status.current === "active") void load();
      } catch {
        // transient; the snapshot refresh reports lasting errors
      } finally {
        busy.current = false;
      }
    }, EVENTS_POLL_MS);
    const snap = setInterval(() => {
      if (loaded.current && status.current === "active" && visible()) void load();
    }, SNAPSHOT_POLL_MS);
    return () => {
      alive.current = false;
      clearTimeout(retry);
      clearInterval(poll);
      clearInterval(snap);
    };
  }, [id]);

  if (!detail)
    return error ? (
      <div class="card">
        <ErrorBox error={error} />
        <div class="small muted sw-retry">
          {retryIn ? `retrying in ${Math.round(retryIn / 1000)} s…` : "retrying…"}
        </div>
      </div>
    ) : (
      <div class="empty">
        <Spinner />
      </div>
    );
  const { run, counts } = detail;
  const live = run.status === "active";
  const runRoles = detail.roles;
  const workersTotal = detail.workers.length;
  const tasksTotal = detail.tasks.length;
  return (
    <div class="sw-run">
      {error ? <div class="sw-note-box bad small">refresh failed: {error}</div> : null}
      <div class="card sw-runhead">
        <div class="row">
          <State s={run.status} />
          <h2 class="goal">{run.goal}</h2>
          <span class="spacer" />
          {live ? (
            <FinishForm
              id={run.id}
              onDone={(f) => {
                setFinished(f);
                void load(true);
                onChanged();
              }}
            />
          ) : null}
        </div>
        <div class="meta small muted">
          <code>{run.id}</code>
          <span>
            swarm <b>{run.swarm}</b>
          </span>
          <span>
            {TOPOLOGY_GLYPH[run.topology]} {run.topology}
          </span>
          <span title={new Date(run.created_at).toLocaleString()}>
            started {ago(run.created_at)}
          </span>
          <span>session {run.session_id ? <code>{run.session_id.slice(0, 8)}</code> : "n/a"}</span>
          {!detail.configured ? (
            <span class="warn">swarm "{run.swarm}" is no longer in the swarm file</span>
          ) : null}
        </div>
        {run.summary ? <div class="sw-summary-text">{run.summary}</div> : null}
        {finished ? <FinishNote f={finished} /> : null}
      </div>

      <div class="sw-stats">
        <Stat
          label="workers running"
          value={`${counts.workers.running}${detail.maxAgents ? ` / ${detail.maxAgents}` : ""}`}
          sub={
            workersTotal
              ? `${workersTotal} spawned · ${counts.workers.stale} stale · ${counts.workers.done} done`
              : "none spawned yet"
          }
        />
        <Stat
          label="tasks done"
          value={`${counts.tasks.done} / ${tasksTotal}`}
          sub={
            tasksTotal
              ? `${counts.tasks.active} active · ${counts.tasks.pending} pending · ${counts.tasks.failed + counts.tasks.blocked} failed/blocked${counts.staleHeld ? ` · ${counts.staleHeld} held by a quiet worker` : ""}`
              : "none planned"
          }
        >
          {tasksTotal ? (
            <div class="sw-progress">
              <span class="done" style={{ width: `${(100 * counts.tasks.done) / tasksTotal}%` }} />
              <span
                class="active"
                style={{ width: `${(100 * counts.tasks.active) / tasksTotal}%` }}
              />
              <span
                class="bad"
                style={{
                  width: `${(100 * (counts.tasks.failed + counts.tasks.blocked)) / tasksTotal}%`,
                }}
              />
            </div>
          ) : null}
        </Stat>
        <Stat
          label="tool calls"
          value={fmt(counts.toolCalls)}
          sub={
            workersTotal
              ? `by ${workersTotal} worker${workersTotal === 1 ? "" : "s"}${counts.autoClosed ? ` · ${counts.autoClosed} auto-closed` : ""}`
              : "no workers yet"
          }
        />
        <Stat
          label="errors"
          value={fmt(counts.errors)}
          sub="failed tool calls"
          tone={counts.errors > 0 && "bad"}
        />
        <Elapsed run={run} skew={skew} />
      </div>

      <div class="card">
        <Head
          title="Topology"
          meta={`${TOPOLOGY_GLYPH[run.topology]} ${run.topology} · ${workersTotal} worker${workersTotal === 1 ? "" : "s"}${live ? " · live" : ""}`}
        />
        <Topology
          detail={detail}
          events={events}
          skew={skew}
          roles={runRoles}
          picked={picked}
          onPick={setPicked}
        />
      </div>

      <TaskBoard
        tasks={detail.tasks}
        workers={detail.workers}
        roles={runRoles}
        live={live}
        skew={skew}
      />
      <Timeline
        timeline={detail.timeline}
        live={live}
        roles={runRoles}
        skew={skew}
        onRelease={release}
      />

      <div class="sw-two">
        <Feed
          events={events}
          roles={runRoles}
          live={live}
          skew={skew}
          behind={behind}
          agent={picked}
          onAgent={setPicked}
        />
        <Blackboard notes={detail.notes} roles={runRoles} live={live} skew={skew} />
      </div>
    </div>
  );
}

// --- the tab --------------------------------------------------------------------------

export function Swarm({ params }: { params: Record<string, string> }): JSX.Element {
  const [limit, setLimit] = useState(RUNS_STEP);
  const ov = useAsync(() => api<SwarmOverview>("/api/swarm", { limit }), [limit]);
  useEffect(() => {
    const t = setInterval(() => {
      if (visible()) ov.reload();
    }, LIST_POLL_MS);
    return () => clearInterval(t);
  }, []);
  const o = ov.data;
  if (!o) return <div class="page">{ov.error ? <ErrorBox error={ov.error} /> : <Spinner />}</div>;
  const runs = o.runs;
  // Active runs come first, so the default is the newest active run, else the newest one.
  const selected = params.run || (runs.find((r) => r.status === "active") ?? runs[0])?.id;
  return (
    <div class="page sw-page">
      {ov.error ? <ErrorBox error={ov.error} /> : null}
      <div class="sw-layout">
        <aside class="sw-rail">
          <ConfigPanel o={o} onChanged={ov.reload} />
          <RunList
            runs={runs}
            selected={selected}
            more={!!o.runsMore}
            loading={ov.loading}
            onMore={() => setLimit((n) => n + RUNS_STEP)}
          />
        </aside>
        <section class="sw-main">
          {selected ? (
            <RunView key={selected} id={selected} onChanged={ov.reload} />
          ) : o.state === "absent" ? (
            <OptIn o={o} onCreated={ov.reload} />
          ) : (
            <NoRun o={o} />
          )}
        </section>
      </div>
    </div>
  );
}
