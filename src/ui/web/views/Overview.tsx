import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { api, type Status, type SwarmOverview } from "../api.js";
import { ErrorBox, KV, Tag, useAsync } from "../components.js";
import {
  Badge,
  Card,
  ColumnChart,
  EmptyState,
  Gauge,
  GradientText,
  Hero,
  Meters,
  Pill,
  SegBar,
  Skeleton,
  Sparkline,
  Stat,
  StatRow,
  type Tone,
} from "../ds.js";
import { navigate } from "../router.js";
import { ago, basename, fmt, pct } from "../util.js";

interface ToolRow {
  tool: string;
  calls: number;
  raw_chars: number;
  returned_chars: number;
}
interface Totals {
  calls: number;
  savedTokens: number;
  efficiency: number;
}
interface Stats {
  project: string;
  dbPath: string;
  session: Totals & { id: string; tools: ToolRow[] };
  projectTotals: Totals;
  lifetime: Totals & { tools: ToolRow[] };
  daily: Array<{ day: string; calls: number; saved_chars: number }>;
  index: {
    documents: number;
    bySource: Record<string, number>;
    vectors: number;
    pendingEmbeddings: boolean;
    embeddings: string;
    memories: number;
    graph: { nodes: number; edges: number; byKind: Record<string, number> };
  };
  memoriesDir: string;
  onboarding: string[];
  routing: string;
  sessions: Array<{
    id: string;
    current: boolean;
    started_at: number | null;
    last_prompt: string | null;
    calls: number;
    savedTokens: number;
  }>;
}

const ONBOARDING = ["overview", "structure", "commands", "conventions"];
const tokens = (chars: number): number => Math.ceil(chars / 4);
/** A saved-token figure: an estimate (4 characters per token), hence the ≈. */
const est = (n: number): string => `≈${fmt(n)}`;

// --- skeleton -------------------------------------------------------------------------

function OverviewSkeleton(): JSX.Element {
  return (
    <div class="page ds-page" role="status" aria-busy="true">
      <section class="ds-hero">
        <div class="ds-hero-main">
          <Skeleton w={160} h={12} />
          <Skeleton w="min(420px, 80%)" h={34} />
          <Skeleton w="min(320px, 60%)" h={14} />
        </div>
        <div class="ds-hero-aside">
          <Skeleton w={92} h={92} class="sk-round" />
        </div>
      </section>
      <StatRow>
        {[0, 1, 2, 3, 4].map(() => (
          <div class="ds-stat">
            <Skeleton w={90} h={11} />
            <Skeleton w={110} h={28} />
            <Skeleton w={140} h={11} />
          </div>
        ))}
      </StatRow>
      <div class="ds-grid main-side">
        <Card>
          <div class="ds-skel-stack">
            <Skeleton w={180} h={14} />
            <Skeleton h={132} />
          </div>
        </Card>
        <Card>
          <div class="ds-skel-stack">
            <Skeleton w={120} h={14} />
            <Skeleton h={14} />
            <Skeleton w="70%" h={14} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// --- tool table -----------------------------------------------------------------------

function ToolTable({ rows }: { rows: ToolRow[] }): JSX.Element {
  const sorted = [...rows].sort((a, b) => b.raw_chars - a.raw_chars);
  const saved = (r: ToolRow) => Math.max(0, tokens(r.raw_chars) - tokens(r.returned_chars));
  const max = Math.max(1, ...sorted.map(saved));
  return (
    <div class="ds-table-wrap">
      <table>
        <thead>
          <tr>
            <th>tool</th>
            <th class="num">calls</th>
            <th class="num">seen</th>
            <th class="num">returned</th>
            <th class="num">saved</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length ? (
            sorted.map((r) => {
              const s = saved(r);
              return (
                <tr>
                  <td>{r.tool}</td>
                  <td class="num">{r.calls}</td>
                  <td class="num">{fmt(tokens(r.raw_chars))}</td>
                  <td class="num">{fmt(tokens(r.returned_chars))}</td>
                  <td class="num">
                    <span class="ov-saved-cell">
                      <span class="ds-meter-track ds-t-ok">
                        <i style={{ width: `${s ? Math.max(3, (100 * s) / max) : 0}%` }} />
                      </span>
                      <b>{est(s)}</b>
                    </span>
                  </td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td class="muted" colSpan={5}>
                no calls yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// --- swarms mini-card -----------------------------------------------------------------

function SwarmsCard(): JSX.Element {
  const q = useAsync(() => api<SwarmOverview>("/api/swarm", { limit: 5 }), []);
  const reload = q.reload;
  // Keep an active run current without a full-page poll; skip while the tab is hidden.
  const active = q.data?.runs.some((r) => r.status === "active") ?? false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (!document.hidden) reload();
    }, 15_000);
    return () => clearInterval(t);
  }, [active, reload]);

  const open = (
    <a class="ds-link" onClick={() => navigate("swarm")}>
      open →
    </a>
  );
  const o = q.data;
  let body: JSX.Element;
  let right: JSX.Element | null = open;
  if (q.error) {
    body = (
      <EmptyState compact icon="!" tone="bad" title="Swarm status unavailable">
        {q.error}
      </EmptyState>
    );
  } else if (!o) {
    body = (
      <div class="ds-skel-stack">
        <Skeleton h={14} />
        <Skeleton w="75%" h={14} />
        <Skeleton h={8} />
      </div>
    );
    right = null;
  } else if (o.state === "absent") {
    body = (
      <EmptyState compact icon="⋔" title="Swarms are not set up">
        No <code>{o.file}</code> yet. Pick a template on the Swarms tab to define roles and a
        topology.
      </EmptyState>
    );
  } else if (o.state === "invalid") {
    body = (
      <EmptyState compact icon="!" tone="bad" title="Swarm file has problems">
        {o.issues.length} issue{o.issues.length === 1 ? "" : "s"} in <code>{o.file}</code>
        {o.issues[0] ? `: ${o.issues[0].message}` : ""}
      </EmptyState>
    );
  } else if (!o.enabled) {
    body = (
      <EmptyState compact icon="⏸" title="Swarms are disabled">
        <code>{o.file}</code> sets <code>enabled: false</code>, so no agent files are generated.
      </EmptyState>
    );
  } else {
    const run = o.runs.find((r) => r.status === "active");
    if (run) {
      const t = run.counts.tasks;
      const w = run.counts.workers;
      body = (
        <div
          class="ov-swarm-run"
          role="link"
          tabIndex={0}
          onClick={() => navigate("swarm", { run: run.id })}
          onKeyDown={(e) => e.key === "Enter" && navigate("swarm", { run: run.id })}
        >
          <div class="ov-row">
            <Pill tone="accent" pulse>
              running
            </Pill>
            <Badge>{run.swarm}</Badge>
            <span class="ds-card-sub">started {ago(run.created_at)}</span>
          </div>
          <div class="ov-swarm-goal">{run.goal}</div>
          <SegBar
            total={t.total}
            title={`${t.done} of ${t.total} tasks done`}
            segments={[
              { value: t.done, tone: "ok", label: `${t.done} done` },
              { value: t.active, tone: "accent", label: `${t.active} active` },
              { value: t.blocked, tone: "warn", label: `${t.blocked} blocked` },
              { value: t.failed, tone: "bad", label: `${t.failed} failed` },
            ]}
          />
          <div class="ds-card-sub">
            {t.total ? `${t.done}/${t.total} tasks done` : "no tasks planned yet"} · {w.running}{" "}
            worker{w.running === 1 ? "" : "s"} running
            {w.stale ? ` · ${w.stale} stale` : ""}
          </div>
        </div>
      );
    } else {
      const last = o.runs[0];
      body = (
        <div class="ds-skel-stack">
          <div class="ov-row">
            <Badge tone="ok" dot>
              ready
            </Badge>
            <span class="ds-card-sub">
              {o.swarms.length} swarm{o.swarms.length === 1 ? "" : "s"} defined:{" "}
              {o.swarms.map((s) => s.name).join(", ")}
            </span>
          </div>
          {last ? (
            <div class="ds-card-sub">
              Last run <b>{last.swarm}</b> {last.status} {ago(last.updated_at)}:{" "}
              {last.goal.slice(0, 80)}
            </div>
          ) : (
            <div class="ds-card-sub">
              No runs yet. Start one from Claude Code with <code>/eminiar:em-swarm</code>.
            </div>
          )}
          {o.syncNeeded ? <Badge tone="warn">agent files need a sync</Badge> : null}
        </div>
      );
    }
  }
  return (
    <Card title="Swarms" right={right}>
      {body}
    </Card>
  );
}

// --- view -----------------------------------------------------------------------------

function freshness(s: Status | undefined): JSX.Element {
  if (!s) return <Badge tone="muted">checking index…</Badge>;
  const tone: Tone = s.state === "fresh" ? "ok" : s.state === "stale" ? "warn" : "bad";
  const word =
    s.state === "fresh" ? "index fresh" : s.state === "stale" ? "index stale" : "no graph";
  const title = `${s.graph.nodes} nodes · ${s.freshness.dirty.length} changed · ${s.freshness.queued} queued`;
  return (
    <Pill tone={tone} title={title}>
      {word}
    </Pill>
  );
}

export function Overview(): JSX.Element {
  const q = useAsync(() => api<Stats>("/api/stats"), []);
  const status = useAsync(() => api<Status>("/api/status"), []);
  if (q.error)
    return (
      <div class="page ds-page">
        <ErrorBox error={q.error} />
      </div>
    );
  const s = q.data;
  if (!s) return <OverviewSkeleton />;

  const missing = ONBOARDING.filter((n) => !s.onboarding.includes(n));
  const dailyTokens = s.daily.map((d) => tokens(d.saved_chars));
  const savedAll = s.lifetime.savedTokens;
  const first = s.daily[0];
  const lastDay = s.daily[s.daily.length - 1];
  const bySource = Object.entries(s.index.bySource)
    .filter(([, v]) => v)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));
  const byKind = Object.entries(s.index.graph.byKind ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value, text: fmt(value) }));

  return (
    <div class="page ds-page">
      <Hero
        eyebrow={
          <>
            <span>{basename(s.project)}</span>
            {freshness(status.data)}
          </>
        }
        title={
          savedAll > 0 ? (
            <>
              <GradientText>{est(savedAll)} tokens</GradientText> kept out of context
            </>
          ) : (
            "Nothing kept out of context yet"
          )
        }
        sub={
          savedAll > 0
            ? `${s.lifetime.calls} tool calls compacted to ${pct(1 - s.lifetime.efficiency)} of their raw size. ${s.session.savedTokens > 0 ? `${est(s.session.savedTokens)} saved this session.` : ""} Token figures are estimates (4 characters per token).`
            : "Run tools through the eminiar sandbox and the savings will show up here."
        }
        meta={
          <>
            <Badge tone="accent" title="routing mode">
              routing {s.routing}
            </Badge>
            <Badge tone="purple" title="embedding backend">
              {s.index.embeddings}
            </Badge>
            {missing.length ? (
              <Badge tone="warn" title={`missing: ${missing.join(", ")}`}>
                onboarding {s.onboarding.length}/4
              </Badge>
            ) : (
              <Badge tone="ok" dot>
                onboarded
              </Badge>
            )}
          </>
        }
        aside={
          <>
            <Gauge
              class="ov-hero-gauge"
              size={92}
              thickness={10}
              tone={savedAll > 0 ? "accent" : "muted"}
              value={s.lifetime.efficiency}
              label={pct(s.lifetime.efficiency)}
              caption="efficient"
              title={`lifetime efficiency ${pct(s.lifetime.efficiency)}`}
            />
            <div class="ov-hero-kpi">
              <b>{est(s.session.savedTokens)}</b>
              <span>saved this session</span>
              <span>{s.session.calls} calls</span>
            </div>
          </>
        }
      />

      <StatRow>
        <Stat
          label="session saved"
          value={est(s.session.savedTokens)}
          sub={`${pct(s.session.efficiency)} efficient · ${s.session.calls} calls`}
        >
          <SegBar total={1} segments={[{ value: s.session.efficiency, tone: "accent" }]} />
        </Stat>
        <Stat
          label="project saved"
          value={est(s.projectTotals.savedTokens)}
          sub={`${pct(s.projectTotals.efficiency)} efficient · ${s.projectTotals.calls} calls`}
        >
          <SegBar total={1} segments={[{ value: s.projectTotals.efficiency, tone: "purple" }]} />
        </Stat>
        <Stat
          label="lifetime saved"
          value={est(savedAll)}
          sub={`${pct(s.lifetime.efficiency)} efficient · ${s.lifetime.calls} calls`}
          onClick={() => navigate("usage")}
          title="open Usage"
        >
          {dailyTokens.length > 1 ? (
            <Sparkline values={dailyTokens} title="tokens saved per day (estimated)" />
          ) : (
            <SegBar total={1} segments={[{ value: s.lifetime.efficiency, tone: "ok" }]} />
          )}
        </Stat>
        <Stat
          label="documents"
          value={fmt(s.index.documents)}
          tone={s.index.pendingEmbeddings ? "warn" : undefined}
          sub={
            <>
              {fmt(s.index.vectors)} vectors
              {s.index.pendingEmbeddings ? " · embedding backlog" : ""}
            </>
          }
        />
        <Stat
          label="memories"
          value={fmt(s.index.memories)}
          sub={`${s.onboarding.length}/4 onboarding`}
          onClick={() => navigate("memory")}
          title="open Memory"
        >
          <SegBar
            total={ONBOARDING.length}
            segments={[{ value: s.onboarding.length, tone: missing.length ? "warn" : "ok" }]}
          />
        </Stat>
        <Stat
          label="graph"
          value={`${fmt(s.index.graph.nodes)} nodes`}
          sub={`${fmt(s.index.graph.edges)} edges`}
          onClick={() => navigate("galaxy", { tab: "map" })}
          title="open the Galaxy folder map"
        />
      </StatRow>

      <div class="ds-grid main-side">
        <Card
          title="Tokens saved per day (estimated)"
          right={first && lastDay ? `${first.day} → ${lastDay.day}` : undefined}
        >
          {s.daily.length ? (
            <ColumnChart
              data={s.daily.map((d) => ({
                value: d.saved_chars,
                tip: `${d.day}: ${est(tokens(d.saved_chars))} tokens · ${d.calls} calls`,
              }))}
              startLabel={first?.day}
              endLabel={lastDay?.day}
            />
          ) : (
            <EmptyState compact icon="▁" title="No daily data yet">
              Savings are recorded per day once tools run through eminiar.
            </EmptyState>
          )}
        </Card>
        <SwarmsCard />
      </div>

      <div class="ds-grid cols-2">
        <Card flush title="This session · by tool" right={`${s.session.tools.length} tools`}>
          <ToolTable rows={s.session.tools} />
        </Card>
        <Card flush title="Lifetime · by tool" right={`${s.lifetime.tools.length} tools`}>
          <ToolTable rows={s.lifetime.tools} />
        </Card>
      </div>

      <div class="ds-grid cols-3">
        <Card title="Index by source" right={`${fmt(s.index.documents)} docs`}>
          <Meters rows={bySource} tone="accent" empty="nothing indexed yet" />
        </Card>
        <Card title="Graph by edge kind" right={`${fmt(s.index.graph.edges)} edges`}>
          <Meters rows={byKind} tone="purple" empty="no graph edges yet" />
        </Card>
        <Card title="System">
          <KV
            rows={[
              ["project", s.project],
              ["database", s.dbPath],
              ["routing", s.routing],
              ["embeddings", s.index.embeddings],
              ["memories dir", s.memoriesDir],
              [
                "onboarding",
                missing.length ? (
                  <span class="warn">missing: {missing.join(", ")} — run /eminiar:em-onboard</span>
                ) : (
                  <span class="ok">complete</span>
                ),
              ],
              ["session", s.session.id],
            ]}
          />
        </Card>
      </div>

      <Card
        flush
        title="Recent sessions"
        right={
          <a class="ds-link" onClick={() => navigate("sessions")}>
            all →
          </a>
        }
      >
        <div class="ds-table-wrap">
          <table>
            <thead>
              <tr>
                <th>started</th>
                <th>session</th>
                <th>last prompt</th>
                <th class="num">calls</th>
                <th class="num">saved</th>
              </tr>
            </thead>
            <tbody>
              {s.sessions.length ? (
                s.sessions.map((x) => (
                  <tr>
                    <td class="muted">
                      {ago(x.started_at)} {x.current ? <Tag>current</Tag> : null}
                    </td>
                    <td>
                      <code>{x.id.slice(0, 8)}</code>
                    </td>
                    <td class="muted">
                      <div class="ov-prompt">{(x.last_prompt ?? "").slice(0, 90)}</div>
                    </td>
                    <td class="num">{x.calls}</td>
                    <td class="num">{est(x.savedTokens)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td class="muted" colSpan={5}>
                    no sessions recorded yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
