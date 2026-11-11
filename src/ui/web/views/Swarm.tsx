// The Swarms tab. #/swarm is the run dashboard (this file plus ../swarm/*); #/swarm/config
// is the Configuration Studio, mounted below at the marked line. Both share the SwarmNav and
// the GET /api/swarm overview read here. Polling budgets: list 15 s, events 2 s, snapshot 5 s.
import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  api,
  post,
  type SwarmDefUi,
  type SwarmEvent,
  type SwarmEventsPage,
  type SwarmIssue,
  type SwarmOverview,
  type SwarmRunDetail,
  type SwarmRunSummary,
  type SwarmSyncResult,
  type SwarmTask,
} from "../api.js";
import { ErrorBox, toast, useAsync } from "../components.js";
import { Badge, Card, EmptyState, SegBar, Segmented, Skeleton } from "../ds.js";
import { navigate } from "../router.js";
import { Blackboard } from "../swarm/Blackboard.js";
import { RoleChip, State } from "../swarm/bits.js";
import { ConfigTopology } from "../swarm/ConfigTopology.js";
import { Feed } from "../swarm/Feed.js";
import { type Finished, RunHero } from "../swarm/RunHero.js";
import {
  capacity,
  filterRuns,
  progress,
  RUN_FILTERS,
  type RunFilter,
  runFilterCounts,
  startCommand,
} from "../swarm/run-helpers.js";
import { SwarmNav } from "../swarm/SwarmNav.js";
import { FILE_STATE, GLYPH, STATE_TONE, shortAgent, TOPOLOGY_GLYPH } from "../swarm/style.js";
import { TaskBoard } from "../swarm/TaskBoard.js";
import { Timeline } from "../swarm/Timeline.js";
import { Topology } from "../swarm/Topology.js";
import { WorkerDrawer } from "../swarm/WorkerDrawer.js";
import { Workers } from "../swarm/Workers.js";
import { Yaml } from "../swarm/Yaml.js";
import { ago, cls } from "../util.js";
import { SwarmConfig } from "./SwarmConfig.js";

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
        {busy ? "Creating…" : "Create from the starter"}
      </button>
      {err ? <span class="bad small">{err}</span> : null}
    </span>
  );
}

function SyncButton({
  needed,
  disabled,
  onDone,
}: {
  needed: boolean;
  /** Swarms are off (`enabled: false`): the sync only removes the generated files. */
  disabled: boolean;
  onDone: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean }>();
  return (
    <div class="row tight sw-sync">
      <button
        type="button"
        class={cls("sm", needed && "primary")}
        disabled={busy}
        title={
          disabled
            ? "swarms are disabled: delete the generated .claude/agents/swarm-*.md files"
            : "write .claude/agents/swarm-<swarm>-<role>.md from the swarm file"
        }
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
        {busy ? "Syncing…" : disabled ? "Remove agent files" : "Sync agent files"}
      </button>
      {msg ? (
        <span class={cls("small", msg.bad ? "bad" : "muted")}>{msg.text}</span>
      ) : needed ? (
        <span class="small warn">
          {GLYPH.blocked} {disabled ? "agent files left to remove" : "out of date"}
        </span>
      ) : (
        <span class="small muted">{GLYPH.done} in sync</span>
      )}
    </div>
  );
}

/** A command on one line with a copy button (the clipboard may be unavailable: then a toast). */
function CopyLine({ text, label }: { text: string; label?: string }): JSX.Element {
  return (
    <div class="sw-copy">
      {label ? <span class="muted small">{label}</span> : null}
      <span class="sw-copy-row">
        <code>{text}</code>
        <button
          type="button"
          class="ghost sm"
          title="copy to the clipboard"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast("copied");
            } catch {
              toast("could not copy: select the line and copy it by hand", true);
            }
          }}
        >
          Copy
        </button>
      </span>
    </div>
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

const configureLink = (swarm?: string) => (
  <a
    class="ds-link"
    href={`#/swarm/config${swarm ? `?swarm=${encodeURIComponent(swarm)}` : ""}`}
    onClick={(e) => {
      e.preventDefault();
      navigate("swarm/config", { swarm });
    }}
  >
    Configure →
  </a>
);

/** One configured swarm in the rail: shape, size and agent-file state; editing is on Configure. */
function SwarmRow({ s }: { s: SwarmDefUi }): JSX.Element {
  const roles = s.roles.map((r) => r.role);
  const cap = capacity(s.roles, s.maxAgents);
  const drift = s.roles.filter(
    (r) => r.file.action !== "unchanged" && r.file.action !== "disabled",
  );
  return (
    <a
      class="sw-swarm-row"
      href={`#/swarm/config?swarm=${encodeURIComponent(s.name)}`}
      title={s.description || `edit ${s.name} in the configuration studio`}
    >
      <span class="sw-swarm-glyph" aria-hidden="true">
        {TOPOLOGY_GLYPH[s.topology]}
      </span>
      <span class="sw-swarm-main">
        <span class="sw-swarm-name">
          <b>{s.name}</b>
          <span class="muted small">
            {s.topology} · {s.roles.length} role{s.roles.length === 1 ? "" : "s"} · {cap.total}/
            {s.maxAgents} slots
          </span>
        </span>
        <span class="sw-swarm-chips">
          {s.roles.map((r) => (
            <RoleChip
              role={r.role}
              roles={roles}
              title={`${r.description}\n${r.agentType} · ${FILE_STATE[r.file.action].word}`}
            >
              {r.count > 1 ? <span class="n">×{r.count}</span> : null}
            </RoleChip>
          ))}
        </span>
        {drift.length || cap.over ? (
          <span class="sw-swarm-badges">
            {drift.length ? (
              <Badge
                tone="warn"
                title={drift.map((r) => `${r.role}: ${FILE_STATE[r.file.action].word}`).join("\n")}
              >
                {GLYPH.blocked} {drift.length} agent file{drift.length === 1 ? "" : "s"} to sync
              </Badge>
            ) : null}
            {cap.over ? (
              <Badge
                tone="muted"
                title="more worker slots than max_agents: only max_agents run at once"
              >
                {cap.total} &gt; max {cap.max}
              </Badge>
            ) : null}
          </span>
        ) : null}
      </span>
    </a>
  );
}

function SwarmsCard({ o, onChanged }: { o: SwarmOverview; onChanged: () => void }): JSX.Element {
  if (o.state === "absent")
    return (
      <Card title="Swarms" right={<Badge tone="muted">not opted in</Badge>}>
        <p class="small muted sw-p">
          No <code>{o.file}</code> yet, so swarms are off for this project.
        </p>
        {configureLink()}
      </Card>
    );
  if (o.state === "invalid")
    return (
      <Card
        title="Swarms"
        right={
          <Badge tone="bad">
            {GLYPH.failed} {o.issues.length} issue{o.issues.length === 1 ? "" : "s"}
          </Badge>
        }
      >
        <p class="small muted sw-p">
          <code>{o.file}</code> is invalid: hooks ignore it and no agent files are written until it
          parses.
        </p>
        {configureLink()}
      </Card>
    );
  return (
    <Card title="Swarms" sub={`${o.swarms.length} defined`} right={configureLink()}>
      {!o.enabled ? (
        <div class="sw-note-box">
          <State s="stale" word="disabled" /> <code>enabled: false</code>: hooks ignore the swarms
          and a sync removes the generated agent files.
        </div>
      ) : null}
      <div class="sw-swarm-list">
        {o.swarms.map((s) => (
          <SwarmRow s={s} />
        ))}
      </div>
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
      {/* Disabled swarms still get the button while generated files are left to remove. */}
      {o.enabled || o.syncNeeded ? (
        <SyncButton needed={o.syncNeeded} disabled={!o.enabled} onDone={onChanged} />
      ) : null}
    </Card>
  );
}

function RunItem({ r, selected }: { r: SwarmRunSummary; selected: boolean }): JSX.Element {
  const t = r.counts.tasks;
  const bad = t.failed + t.blocked;
  const p = progress(t);
  return (
    <a
      key={r.id}
      class={cls("sw-run-item", selected && "sel", r.status === "active" && "is-live")}
      href={`#/swarm?run=${encodeURIComponent(r.id)}`}
      aria-current={selected ? "page" : undefined}
    >
      <div class="sw-run-top">
        <Badge tone={STATE_TONE[r.status]}>
          {GLYPH[r.status]} {r.status}
        </Badge>
        <span class="muted small">
          {TOPOLOGY_GLYPH[r.topology]} {r.swarm}
        </span>
        <span class="spacer" />
        <span class="muted small" title={new Date(r.created_at).toLocaleString()}>
          {ago(r.created_at)}
        </span>
      </div>
      <div class="sw-goal" title={r.goal}>
        {r.goal}
      </div>
      <div class="sw-run-foot small muted">
        <span>{t.total ? `${t.done}/${t.total} tasks` : "no tasks"}</span>
        {r.counts.workers.running ? (
          <span class="sw-s-running">
            {GLYPH.running} {r.counts.workers.running} running
          </span>
        ) : null}
        {bad ? (
          <span class="sw-s-failed">
            {GLYPH.failed} {bad}
          </span>
        ) : null}
        {t.total ? <span class="spacer" /> : null}
        {t.total ? <span class="ds-num">{Math.round(p * 100)}%</span> : null}
      </div>
      {t.total ? (
        <SegBar
          total={t.total}
          title={`${t.done} done · ${t.active} active · ${bad} failed/blocked of ${t.total}`}
          segments={[
            { value: t.done, tone: "ok" },
            { value: t.active, tone: "accent" },
            { value: bad, tone: "bad" },
          ]}
        />
      ) : null}
    </a>
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
  const [filter, setFilter] = useState<RunFilter>("all");
  const counts = runFilterCounts(runs);
  const shown = filterRuns(runs, filter);
  return (
    <Card
      flush
      class="sw-runs-card"
      title="Runs"
      sub={runs.length ? `${counts.active} active · ${runs.length}${more ? "+" : ""}` : "none"}
    >
      {runs.length ? (
        <>
          <div class="sw-run-filter">
            <Segmented<RunFilter>
              label="filter runs by status"
              value={filter}
              onChange={setFilter}
              options={RUN_FILTERS.map((f) => ({
                id: f,
                title: f === "failed" ? "failed or cancelled" : `${f} runs`,
                label: (
                  <>
                    {f}
                    <span class="sw-count">{counts[f]}</span>
                  </>
                ),
              }))}
            />
          </div>
          <div class="sw-runs">
            {shown.length ? (
              shown.map((r) => <RunItem r={r} selected={r.id === selected} />)
            ) : (
              <div class="empty small">
                No {filter} runs among the {runs.length} listed.
              </div>
            )}
            {more ? (
              <div class="sw-more">
                <button type="button" class="ghost sm" disabled={loading} onClick={onMore}>
                  {loading ? "Loading…" : `Show ${RUNS_STEP} older runs`}
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div class="sw-pad">
          <EmptyState compact icon="▸" title="No runs yet">
            Runs appear here as soon as the coordinator starts one.
          </EmptyState>
        </div>
      )}
    </Card>
  );
}

// --- main panels without a run --------------------------------------------------------

function OptIn({ o, onCreated }: { o: SwarmOverview; onCreated: () => void }): JSX.Element {
  return (
    <div class="sw-run">
      <Card class="sw-optin" raised>
        <EmptyState
          icon={TOPOLOGY_GLYPH.hierarchical}
          title="Agent swarms are off for this project"
          action={
            <div class="row sw-optin-actions">
              <button type="button" class="primary" onClick={() => navigate("swarm/config")}>
                Open the Configuration Studio
              </button>
              <CreateButton onCreated={onCreated} />
            </div>
          }
        >
          A swarm is a team of Claude Code subagents defined in <code>{o.file}</code>: named roles
          with their prompts, models, tools and skills, and how they coordinate (hierarchical, mesh
          or pipeline). Your main session leads the run and this page shows it live. Nothing changes
          until the file exists: no agent files, no swarm work in any hook.
        </EmptyState>
      </Card>
      {o.starter ? (
        <Card title="Starter" sub={`${o.file} · read-only preview`}>
          <Yaml text={o.starter} />
        </Card>
      ) : null}
    </div>
  );
}

function NoRun({ o }: { o: SwarmOverview }): JSX.Element {
  if (o.state === "invalid")
    return (
      <Card class="sw-optin" title="The swarm file is invalid" sub={o.file} right={configureLink()}>
        <p class="small">Fix these and the swarms appear here:</p>
        <Issues issues={o.issues} />
      </Card>
    );
  return (
    <div class="sw-run">
      <EmptyState
        icon="▸"
        title={o.enabled ? "No runs yet" : "Swarms are disabled"}
        action={o.swarms[0] ? <CopyLine text={startCommand(o.swarms[0].name)} /> : null}
      >
        {o.enabled ? (
          <>
            Start a run from Claude Code. The coordinator (your session) plans the tasks and spawns
            the workers; the topology, task board and activity feed fill in here live.
          </>
        ) : (
          <>
            <code>enabled: false</code> in <code>{o.file}</code>: the hooks ignore the swarms below
            until it is switched back on in {configureLink()}
          </>
        )}
      </EmptyState>
      {o.swarms.length ? (
        <div class="sw-previews">
          {o.swarms.map((s) => {
            const cap = capacity(s.roles, s.maxAgents);
            return (
              <Card
                raised
                class="sw-preview"
                title={
                  <>
                    <span class="sw-swarm-glyph">{TOPOLOGY_GLYPH[s.topology]}</span> {s.name}
                  </>
                }
                sub={`${s.topology} · ${s.roles.length} roles · ${cap.total} slots · max ${s.maxAgents}`}
                right={configureLink(s.name)}
              >
                {s.description ? <p class="small muted sw-p">{s.description}</p> : null}
                <ConfigTopology
                  topology={s.topology}
                  roles={s.roles.map((r) => ({ name: r.role, count: r.count }))}
                  stages={s.stages}
                  maxAgents={s.maxAgents}
                />
                <CopyLine label="in Claude Code" text={startCommand(s.name)} />
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// --- loading --------------------------------------------------------------------------

function RunSkeleton(): JSX.Element {
  return (
    <div class="sw-run" role="status" aria-busy="true" aria-label="loading the run">
      <div class="sw-skel-hero">
        <div class="ds-skel-stack">
          <Skeleton w={180} h={12} />
          <Skeleton w="70%" h={30} />
          <Skeleton w="40%" h={14} />
        </div>
        <Skeleton class="sk-round" w={104} h={104} />
      </div>
      <div class="ds-stats">
        {[0, 1, 2, 3, 4].map(() => (
          <div class="ds-stat">
            <Skeleton w={70} h={10} />
            <Skeleton w={90} h={26} />
            <Skeleton w="80%" h={10} />
          </div>
        ))}
      </div>
      <div class="sw-grid">
        <Skeleton h={320} class="sw-skel-card" />
        <Skeleton h={320} class="sw-skel-card" />
      </div>
    </div>
  );
}

function DashboardSkeleton(): JSX.Element {
  return (
    <div class="sw-layout">
      <aside class="sw-rail">
        <Skeleton h={180} class="sw-skel-card" />
        <Skeleton h={320} class="sw-skel-card" />
      </aside>
      <section class="sw-main">
        <RunSkeleton />
      </section>
    </div>
  );
}

// --- one run --------------------------------------------------------------------------

const sameList = (a: string[] | undefined, b: string[]): boolean =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

function RunView({
  id,
  swarms,
  onChanged,
}: {
  id: string;
  /** The configured swarms, for the worker drawer's role details. */
  swarms: SwarmDefUi[];
  onChanged: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<SwarmRunDetail>();
  const [error, setError] = useState<string>();
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [events, setEvents] = useState<SwarmEvent[]>([]);
  const [behind, setBehind] = useState(false);
  /** The worker the topology, the workers panel and the feed are focused on. */
  const [picked, setPicked] = useState<string | null>(null);
  /** The worker open in the drawer. */
  const [inspect, setInspect] = useState<string | null>(null);
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
  /** Decisions keyed by the server's hash: sent back each poll, the map comes only when it changed. */
  const decisionsRef = useRef<{ hash: string | undefined; value: SwarmRunDetail["decisions"] }>();
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
          decisionsHash: decisionsRef.current?.hash,
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
      // An unchanged map is left out; an older server sends it whole with no hash (always take it).
      if (!(d.decisionsUnchanged && decisionsRef.current))
        decisionsRef.current = { hash: d.decisionsHash, value: d.decisions };
      setDetail({
        ...d,
        tasks: tasksList.current,
        roles: roles.current ?? d.roles,
        decisions: decisionsRef.current?.value,
      });
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

  /** A worker card opens the drawer and focuses the canvas and the feed on that worker. */
  const openWorker = useCallback((agent: string) => {
    setPicked(agent);
    setInspect(agent);
  }, []);
  const closeDrawer = useCallback(() => setInspect(null), []);

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
      <Card>
        <ErrorBox error={error} />
        <div class="small muted sw-retry">
          {retryIn ? `retrying in ${Math.round(retryIn / 1000)} s…` : "retrying…"}
        </div>
      </Card>
    ) : (
      <RunSkeleton />
    );
  const { run } = detail;
  const live = run.status === "active";
  const runRoles = detail.roles;
  const decisions = detail.decisions;
  const workersTotal = detail.workers.length;
  const inspected = inspect ? detail.workers.find((w) => w.agent_id === inspect) : undefined;
  const swarmDef = swarms.find((s) => s.name === run.swarm);
  return (
    <div class={cls("sw-run", live && "is-live")}>
      {error ? <div class="sw-note-box bad small">refresh failed: {error}</div> : null}
      <RunHero
        detail={detail}
        skew={skew}
        finished={finished}
        onFinished={(f) => {
          setFinished(f);
          void load(true);
          onChanged();
        }}
      />

      <div class="sw-grid-box">
        <div class="sw-grid">
          <Card
            class="sw-topo-card"
            title="Topology"
            sub={`${TOPOLOGY_GLYPH[run.topology]} ${run.topology} · ${workersTotal} worker${workersTotal === 1 ? "" : "s"}`}
            right={
              picked ? (
                <button
                  type="button"
                  class="chip on"
                  title="show every worker again"
                  onClick={() => setPicked(null)}
                >
                  focus {shortAgent(picked)} ✕
                </button>
              ) : live ? (
                <Badge tone="accent" dot>
                  live
                </Badge>
              ) : null
            }
          >
            <Topology
              detail={detail}
              events={events}
              skew={skew}
              roles={runRoles}
              picked={picked}
              onPick={setPicked}
            />
          </Card>
          <Workers
            decisions={decisions}
            workers={detail.workers}
            tasks={detail.tasks}
            roles={runRoles}
            live={live}
            skew={skew}
            staleMs={detail.staleMs}
            picked={picked}
            onPick={openWorker}
            onRelease={release}
          />
        </div>
      </div>

      <TaskBoard
        decisions={decisions}
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

      {inspected ? (
        <WorkerDrawer
          decisions={decisions}
          worker={inspected}
          role={swarmDef?.roles.find((r) => r.role === inspected.role)}
          roles={runRoles}
          tasks={detail.tasks}
          events={events}
          live={live}
          skew={skew}
          staleMs={detail.staleMs}
          onClose={closeDrawer}
        />
      ) : null}
    </div>
  );
}

// --- the run dashboard (#/swarm) -------------------------------------------------------

function RunDashboard({
  o,
  params,
  loading,
  onChanged,
  onMore,
}: {
  o: SwarmOverview;
  params: Record<string, string>;
  loading: boolean;
  onChanged: () => void;
  onMore: () => void;
}): JSX.Element {
  const runs = o.runs;
  // Active runs come first, so the default is the newest active run, else the newest one.
  const selected = params.run || (runs.find((r) => r.status === "active") ?? runs[0])?.id;
  return (
    <div class="sw-layout">
      <aside class="sw-rail">
        <SwarmsCard o={o} onChanged={onChanged} />
        <RunList
          runs={runs}
          selected={selected}
          more={!!o.runsMore}
          loading={loading}
          onMore={onMore}
        />
      </aside>
      <section class="sw-main">
        {selected ? (
          <RunView key={selected} id={selected} swarms={o.swarms} onChanged={onChanged} />
        ) : o.state === "absent" ? (
          <OptIn o={o} onCreated={onChanged} />
        ) : (
          <NoRun o={o} />
        )}
      </section>
    </div>
  );
}

// --- the tab --------------------------------------------------------------------------

export function Swarm({
  params,
  sub,
}: {
  params: Record<string, string>;
  /** `config` for #/swarm/config (the Configuration Studio), else null (the run dashboard). */
  sub?: string | null | undefined;
}): JSX.Element {
  const [limit, setLimit] = useState(RUNS_STEP);
  const ov = useAsync(() => api<SwarmOverview>("/api/swarm", { limit }), [limit]);
  useEffect(() => {
    const t = setInterval(() => {
      if (visible()) ov.reload();
    }, LIST_POLL_MS);
    return () => clearInterval(t);
  }, []);
  const o = ov.data;
  const page = sub === "config" ? "config" : "runs";
  return (
    <div class="page ds-page sw-page">
      <SwarmNav page={page} o={o} />
      {ov.error ? <ErrorBox error={ov.error} /> : null}
      {page === "config" ? (
        // The Configuration Studio (task #207): it reads GET /api/swarm/config itself; `o`
        // only feeds the agent-file sync state, and a save re-reads the overview.
        <SwarmConfig o={o} params={params} onChanged={ov.reload} />
      ) : !o ? (
        ov.error ? null : (
          <DashboardSkeleton />
        )
      ) : (
        <RunDashboard
          o={o}
          params={params}
          loading={ov.loading}
          onChanged={ov.reload}
          onMore={() => setLimit((n) => n + RUNS_STEP)}
        />
      )}
    </div>
  );
}
