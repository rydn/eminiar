import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
// Shared with the node side so the dashboard and the text views print the same figures.
import { formatUsd } from "../../../usage/pricing.js";
import { api } from "../api.js";
import { Empty, ErrorBox, Spinner, SubTabs, Tag, useAsync, useSort } from "../components.js";
import { useWidth } from "../history/charts.js";
import { navigate } from "../router.js";
import { ago, cls, fmt, pct } from "../util.js";
import {
  buildPalette,
  type ColorFn,
  fillDays,
  type ModelSlice,
  modelColor,
  type PeriodRow,
  shortModel,
  type Totals,
} from "./usage-helpers.js";

// --- payload shapes (mirror src/tools/em_usage.ts) --------------------------------------

interface ModelRow extends ModelSlice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  share: number;
}
interface Block {
  id: string;
  start: number;
  end: number;
  firstCall: number;
  lastCall: number;
  calls: number;
  tokens: { input: number; output: number; cacheCreate: number; cacheRead: number };
  costUsd: number;
  unpricedCalls: number;
  models: string[];
  active: boolean;
  gapBefore?: number;
}
interface Burn {
  tokensPerMin: number;
  usdPerHour: number;
  /** null until the block has enough calls over enough minutes to project from. */
  projectedBlockUsd: number | null;
  windowMinutes: number;
  reliable: boolean;
}
interface Snapshot {
  ts: number;
  cost_usd: number | null;
  ctx_used_pct: number | null;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  seven_day_pct: number | null;
  seven_day_resets_at: number | null;
}
interface Insight {
  id: string;
  severity: "info" | "warn" | "high";
  title: string;
  reason: string;
  evidence?: Record<string, number | string>;
  estimatedSavingsUsd?: number;
  recommendation?: string;
  scope: "session" | "project";
  sessionId?: string;
}
interface Score {
  id: string;
  value: number;
  reasons: string[];
}
interface Savings {
  savedTokens: number;
  directUsd: number;
  compoundingUsd: number;
  laterCallsPerSession: number;
  model: string;
  assumptions: string[];
}
interface Summary {
  sessionId: string;
  totals: Totals;
  today: Totals;
  last7d: Totals;
  last30d: Totals;
  cache: { hitRate: number; cacheWrites: number; cacheReads: number; coldCalls: number };
  models: ModelRow[];
  burn: Burn;
  block: Block | null;
  insights: Insight[];
  scores: Score[];
  savings: Savings;
  snapshot: Snapshot | null;
  enabled: boolean;
}
interface ToolRow {
  tool: string;
  calls: number;
  chars: number;
  estTokens: number;
  avgChars: number;
  errors: number;
}
interface SessionRow {
  session: string;
  startedAt: number | null;
  firstCall: number;
  lastCall: number;
  branch: string | null;
  lastPrompt: string | null;
  totals: Totals;
}
interface TimelinePoint {
  ts: number;
  requestId: string;
  model: string;
  contextTokens: number;
  output: number;
  costUsd: number;
  compactBefore?: boolean;
}
interface SessionDetail {
  session: string;
  totals: Totals;
  timeline: TimelinePoint[];
  contextEvents: Array<{ ts: number; kind: string; trigger: string | null }>;
  toolUses: ToolRow[];
  insights: Insight[];
  scores: Score[];
  snapshot: Snapshot | null;
}
interface All {
  summary: Summary;
  daily: { rows: PeriodRow[] };
  models: { rows: ModelRow[] };
  blocks: { rows: Block[]; burn: Burn };
  tools: { rows: ToolRow[]; totalChars: number };
  sessions: { rows: SessionRow[] };
  insights: { insights: Insight[]; scores: Score[] };
}

// --- helpers -----------------------------------------------------------------------------

const usd = (n: number | null | undefined): string => formatUsd(n ?? 0);
/** Local wall-clock time (the context timeline). */
const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** UTC time, for the billing-block table whose block ids are UTC hours. */
const hhmmUtc = (ts: number) => new Date(ts).toISOString().slice(11, 16);
const RANGES: Array<["7d" | "30d" | "90d", string]> = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
];
const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

function SevTag({ s }: { s: Insight["severity"] }): JSX.Element {
  return <span class={cls("tag", `sev-${s}`)}>{s}</span>;
}

function ScoreRow({ s }: { s: Score }): JSX.Element {
  const v = Math.max(0, Math.min(100, Math.round(s.value)));
  return (
    <div class="score">
      <div class="row tight">
        <b>{s.id}</b>
        <span class="spacer" />
        <span class={cls(v >= 70 ? "ok" : v >= 40 ? "warn" : "bad")}>{v}</span>
      </div>
      <span class="scorebar">
        <i class={cls(v >= 70 ? "ok" : v >= 40 ? "warn" : "bad")} style={{ width: `${v}%` }} />
      </span>
      {s.reasons.length ? (
        <ul class="reasons">
          {s.reasons.map((r) => (
            <li>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function InsightList({ items, empty }: { items: Insight[]; empty: string }): JSX.Element {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <div class="insights">
      {items.map((i) => (
        <div class={cls("insight", i.severity)}>
          <div class="row tight">
            <SevTag s={i.severity} />
            <b>{i.title}</b>
            <span class="spacer" />
            {i.estimatedSavingsUsd ? (
              <span class="muted small">≈ {usd(i.estimatedSavingsUsd)}</span>
            ) : null}
            <span class="muted small">{i.scope}</span>
          </div>
          <div class="p">{i.reason}</div>
          {i.recommendation ? <div class="p muted">→ {i.recommendation}</div> : null}
        </div>
      ))}
    </div>
  );
}

// --- charts ------------------------------------------------------------------------------

function DailyChart({
  rows,
  models,
  color,
}: {
  rows: PeriodRow[];
  models: string[];
  color: ColorFn;
}): JSX.Element {
  const [box, width] = useWidth<HTMLDivElement>();
  const H = 170;
  const PAD = { l: 48, r: 8, t: 8, b: 22 };
  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;
  const n = rows.length;
  const bw = n ? plotW / n : plotW;
  const gap = bw >= 6 ? 2 : bw >= 3 ? 1 : 0;
  const max = Math.max(0.01, ...rows.map((r) => r.totals.costUsd));
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const [hover, setHover] = useState<number | null>(null);
  const every = Math.max(1, Math.ceil(n / Math.max(2, plotW / 70)));
  const hr = hover !== null ? rows[hover] : undefined;
  return (
    <div class="hist-chart usage-chart" ref={box}>
      <svg
        width={width}
        height={H}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.floor((e.clientX - r.left - PAD.l) / bw);
          setHover(i >= 0 && i < n ? i : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <title>cost per day by model</title>
        {[0, 0.5, 1].map((f) => (
          <g>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(max * f)} y2={y(max * f)} class="grid" />
            <text x={PAD.l - 6} y={y(max * f) + 3} class="axis" text-anchor="end">
              {usd(max * f)}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % every === 0 ? (
            <text x={PAD.l + i * bw} y={H - 6} class="axis">
              {r.key.slice(5)}
            </text>
          ) : null,
        )}
        {rows.map((r, i) => {
          let acc = 0;
          return (
            <g opacity={hover !== null && hover !== i ? 0.55 : 1}>
              {models.map((m) => {
                const v = r.models.find((s) => s.model === m)?.costUsd ?? 0;
                if (!v) return null;
                const y1 = y(acc + v);
                const y0 = y(acc);
                acc += v;
                return (
                  <rect
                    x={PAD.l + i * bw + gap / 2}
                    y={y1}
                    width={Math.max(0.5, bw - gap)}
                    height={Math.max(0, y0 - y1)}
                    fill={color(m)}
                    rx={bw >= 6 ? 1.5 : 0}
                  />
                );
              })}
              {r.totals.unpricedCalls && !r.totals.costUsd ? (
                <rect
                  x={PAD.l + i * bw + gap / 2}
                  y={PAD.t + plotH - 3}
                  width={Math.max(0.5, bw - gap)}
                  height={3}
                  fill="#6b7280"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      {hr ? (
        <div class="tip" style={{ left: Math.min(width - 220, PAD.l + hover! * bw + 10), top: 4 }}>
          <b>{hr.key}</b> · {hr.totals.calls} calls · {usd(hr.totals.costUsd)}
          {hr.totals.unpricedCalls ? ` · ${hr.totals.unpricedCalls} unpriced` : ""}
          <div class="row tight" style={{ marginTop: 4, flexWrap: "wrap" }}>
            {hr.models.map((m) => (
              <span class="kdot-lbl">
                <i class="kdot" style={{ background: color(m.model) }} />
                {shortModel(m.model)} {usd(m.costUsd)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ContextChart({ points, color }: { points: TimelinePoint[]; color: ColorFn }): JSX.Element {
  const [box, width] = useWidth<HTMLDivElement>();
  const H = 170;
  const PAD = { l: 48, r: 8, t: 8, b: 22 };
  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;
  const n = points.length;
  const max = Math.max(1000, ...points.map((p) => p.contextTokens));
  const x = (i: number) => PAD.l + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const [hover, setHover] = useState<number | null>(null);
  const hp = hover !== null ? points[hover] : undefined;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.contextTokens)}`).join(" ");
  return (
    <div class="hist-chart usage-chart" ref={box}>
      <svg
        width={width}
        height={H}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left - PAD.l;
          const i = n > 1 ? Math.round((px / plotW) * (n - 1)) : 0;
          setHover(i >= 0 && i < n ? i : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <title>context tokens per API call, with compactions</title>
        {[0, 0.5, 1].map((f) => (
          <g>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(max * f)} y2={y(max * f)} class="grid" />
            <text x={PAD.l - 6} y={y(max * f) + 3} class="axis" text-anchor="end">
              {fmt(max * f)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          p.compactBefore ? (
            <g>
              <line x1={x(i)} x2={x(i)} y1={PAD.t} y2={PAD.t + plotH} class="compact" />
              <text x={x(i) + 3} y={PAD.t + 10} class="axis">
                compact
              </text>
            </g>
          ) : null,
        )}
        <path d={path} class="line" />
        {points.map((p, i) => (
          <circle
            cx={x(i)}
            cy={y(p.contextTokens)}
            r={hover === i ? 4 : 2.2}
            fill={color(p.model)}
            class="dot"
          />
        ))}
        {n ? (
          <text x={PAD.l} y={H - 6} class="axis">
            {hhmm(points[0]!.ts)}
          </text>
        ) : null}
        {n > 1 ? (
          <text x={width - PAD.r} y={H - 6} class="axis" text-anchor="end">
            {hhmm(points[n - 1]!.ts)}
          </text>
        ) : null}
      </svg>
      {hp ? (
        <div class="tip" style={{ left: Math.min(width - 240, x(hover!) + 10), top: 4 }}>
          <b>{hhmm(hp.ts)}</b> · {shortModel(hp.model)}
          <div class="muted">
            context {fmt(hp.contextTokens)} · output {fmt(hp.output)} · {usd(hp.costUsd)}
            {hp.compactBefore ? " · compacted before this call" : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- tables ------------------------------------------------------------------------------

function ModelsTable({ rows, color }: { rows: ModelRow[]; color: ColorFn }): JSX.Element {
  const { sorted, th } = useSort(rows, "costUsd");
  return (
    <table>
      <thead>
        <tr>
          {th("model", "model")}
          {th("calls", "calls", true)}
          {th("costUsd", "cost", true)}
          {th("share", "share", true)}
          {th("input", "in", true)}
          {th("output", "out", true)}
          {th("cacheRead", "cache rd", true)}
          {th("cacheWrite", "cache wr", true)}
        </tr>
      </thead>
      <tbody>
        {sorted.length ? (
          sorted.map((m) => (
            <tr>
              <td class="nowrap">
                <i class="kdot" style={{ background: color(m.model) }} /> {shortModel(m.model)}
                {m.unpricedCalls ? (
                  <span class="warn small" title="no bundled price; add config.usage.pricing">
                    {" "}
                    unpriced
                  </span>
                ) : null}
              </td>
              <td class="num">{m.calls}</td>
              <td class="num">{usd(m.costUsd)}</td>
              <td class="num">{pct(m.share)}</td>
              <td class="num">{fmt(m.input)}</td>
              <td class="num">{fmt(m.output)}</td>
              <td class="num">{fmt(m.cacheRead)}</td>
              <td class="num">{fmt(m.cacheWrite)}</td>
            </tr>
          ))
        ) : (
          <tr>
            <td class="muted" colSpan={8}>
              no API calls in this range
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function ToolsTable({ rows }: { rows: ToolRow[] }): JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.chars));
  return (
    <table>
      <thead>
        <tr>
          <th>tool</th>
          <th class="num">calls</th>
          <th class="num">est. tokens</th>
          <th class="num">avg chars</th>
          <th class="num">errors</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.length ? (
          rows.map((r) => (
            <tr>
              <td>{r.tool}</td>
              <td class="num">{r.calls}</td>
              <td class="num">{fmt(r.estTokens)}</td>
              <td class="num">{fmt(r.avgChars)}</td>
              <td class={cls("num", r.errors > 0 && "warn")}>{r.errors}</td>
              <td>
                <span class="bar" style={{ width: `${Math.max(2, (r.chars / max) * 80)}px` }} />
              </td>
            </tr>
          ))
        ) : (
          <tr>
            <td class="muted" colSpan={6}>
              no tool results recorded
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function BlocksTable({ rows, color }: { rows: Block[]; color: ColorFn }): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          <th>block (UTC)</th>
          <th>calls at (UTC)</th>
          <th class="num">calls</th>
          <th class="num">cost</th>
          <th class="num">tokens</th>
          <th>models</th>
        </tr>
      </thead>
      <tbody>
        {rows.length ? (
          rows.map((b) => (
            <tr>
              <td class="nowrap">
                {b.id.slice(0, 16).replace("T", " ")} {b.active ? <Tag>active</Tag> : null}
              </td>
              <td class="nowrap muted">
                {hhmmUtc(b.firstCall)}–{hhmmUtc(b.lastCall)}
              </td>
              <td class="num">{b.calls}</td>
              <td class="num">{usd(b.costUsd)}</td>
              <td class="num">
                {fmt(b.tokens.input + b.tokens.output + b.tokens.cacheCreate + b.tokens.cacheRead)}
              </td>
              <td>
                {b.models.map((m) => (
                  <span class="kdot-lbl">
                    <i class="kdot" style={{ background: color(m) }} />
                    {shortModel(m)}
                  </span>
                ))}
              </td>
            </tr>
          ))
        ) : (
          <tr>
            <td class="muted" colSpan={6}>
              no blocks in this range
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// --- the view ----------------------------------------------------------------------------

export function Usage({ params }: { params: Record<string, string> }): JSX.Element {
  const range = (RANGES.find(([r]) => r === params.range)?.[0] ?? "30d") as "7d" | "30d" | "90d";
  const [sel, setSel] = useState<string | null>(params.session ?? null);
  // Follow the hash both ways: a session arriving selects it, one disappearing clears it
  // (the default pick below then falls back to the current / most recent session).
  useEffect(() => {
    setSel(params.session ?? null);
  }, [params.session]);
  const all = useAsync(async (): Promise<All> => {
    const get = <T,>(view: string) => api<T>("/api/usage", { view, since: range, limit: 30 });
    const [summary, daily, models, blocks, tools, sessions, insights] = await Promise.all([
      get<Summary>("summary"),
      get<{ rows: PeriodRow[] }>("daily"),
      get<{ rows: ModelRow[] }>("models"),
      get<{ rows: Block[]; burn: Burn }>("blocks"),
      get<{ rows: ToolRow[]; totalChars: number }>("tools"),
      get<{ rows: SessionRow[] }>("sessions"),
      get<{ insights: Insight[]; scores: Score[] }>("insights"),
    ]);
    return { summary, daily, models, blocks, tools, sessions, insights };
  }, [range]);
  // Default to the current session when it has calls, else the most recent one.
  useEffect(() => {
    const d = all.data;
    if (sel || !d) return;
    const cur = d.sessions.rows.find((s) => s.session === d.summary.sessionId);
    const first = cur ?? d.sessions.rows[0];
    if (first) setSel(first.session);
  }, [all.data, sel]);
  const detail = useAsync(
    () =>
      sel
        ? api<SessionDetail>("/api/usage/session", { id: sel })
        : Promise.resolve(undefined as SessionDetail | undefined),
    [sel],
  );
  const models = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of all.data?.daily.rows ?? [])
      for (const m of r.models) seen.set(m.model, (seen.get(m.model) ?? 0) + m.costUsd);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }, [all.data]);
  const dailyRows = useMemo(
    () => fillDays(all.data?.daily.rows ?? [], RANGE_DAYS[range] ?? 30),
    [all.data, range],
  );
  // One colour per model id seen anywhere on the page (daily bars, tables, blocks, timeline).
  const palette = useMemo(() => {
    const d = all.data;
    const ids = [
      ...models,
      ...(d?.models.rows.map((m) => m.model) ?? []),
      ...(d?.blocks.rows.flatMap((b) => b.models) ?? []),
      ...(detail.data?.timeline.map((p) => p.model) ?? []),
    ];
    return buildPalette(ids);
  }, [all.data, models, detail.data]);
  const color: ColorFn = (m) => palette.get(m) ?? modelColor(m);

  if (all.error)
    return (
      <div class="page">
        <ErrorBox error={all.error} />
      </div>
    );
  const d = all.data;
  if (!d)
    return (
      <div class="page">
        <Spinner />
      </div>
    );
  const s = d.summary;
  const snap = s.snapshot;
  const sessionTotals = detail.data?.totals;
  const kpis: Array<[string, string, JSX.Element | string]> = [
    [
      "today",
      usd(s.today.costUsd),
      `${s.today.calls} calls · ${pct(s.today.cacheHitRate)} cache hits`,
    ],
    [
      "last 7 days",
      usd(s.last7d.costUsd),
      `${s.last7d.calls} calls · 30d ${usd(s.last30d.costUsd)}`,
    ],
    [
      "session",
      usd(sessionTotals?.costUsd ?? 0),
      sel ? `${sel.slice(0, 8)} · ${sessionTotals?.calls ?? 0} calls` : "no session selected",
    ],
    [
      "cache hit rate",
      pct(s.cache.hitRate),
      `${fmt(s.cache.cacheReads)} read · ${fmt(s.cache.cacheWrites)} written · ${s.cache.coldCalls} cold`,
    ],
    [
      "burn rate",
      !s.block ? "idle" : s.burn.reliable ? `${usd(s.burn.usdPerHour)}/h` : "n/a",
      !s.block
        ? "no calls in the current 5-hour block"
        : s.burn.reliable
          ? `block ${usd(s.block.costUsd)} → ${usd(s.burn.projectedBlockUsd)} projected`
          : `block ${usd(s.block.costUsd)} · too few calls or minutes to project`,
    ],
    [
      "plan use",
      snap && snap.five_hour_pct != null
        ? snap.seven_day_pct != null
          ? `${snap.five_hour_pct}% · ${snap.seven_day_pct}%`
          : `${snap.five_hour_pct}%`
        : "n/a",
      snap && snap.five_hour_pct != null
        ? `${snap.seven_day_pct != null ? "5h · 7d windows" : "5h window"}${snap.ctx_used_pct != null ? ` · ctx ${snap.ctx_used_pct}%` : ""} · ${ago(snap.ts)}`
        : "statusline snapshots carry plan limits for subscribers",
    ],
  ];
  const go = (session: string | null, r = range) =>
    navigate("usage", { session: session ?? undefined, range: r });
  return (
    <div class="page">
      {!s.enabled ? (
        <div class="empty warn">usage ingest is off (config.usage.enabled = false)</div>
      ) : null}
      <div class="row" style={{ marginBottom: 10 }}>
        <SubTabs tabs={RANGES} value={range} onChange={(r) => go(sel, r)} />
        <span class="spacer" />
        <span class="muted small">
          {s.totals.calls} calls · {usd(s.totals.costUsd)} in range
          {s.totals.unpricedCalls ? (
            <span class="warn">
              {" "}
              · {s.totals.unpricedCalls} unpriced (see config.usage.pricing)
            </span>
          ) : null}
          {" · estimates at list price"}
        </span>
      </div>
      <div class="grid">
        {kpis.map(([h, v, sub]) => (
          <div class="card">
            <h3>{h}</h3>
            <div class="big">{v}</div>
            <div class="sub">{sub}</div>
          </div>
        ))}
      </div>
      <div class="grid wide">
        <div class="card">
          <h3>
            cost per day by model
            <span class="right usage-legend">
              {models.map((m) => (
                <span class="kdot-lbl">
                  <i class="kdot" style={{ background: color(m) }} />
                  {shortModel(m)}
                </span>
              ))}
            </span>
          </h3>
          {d.daily.rows.length ? (
            <DailyChart rows={dailyRows} models={models} color={color} />
          ) : (
            <Empty>no API calls in this range</Empty>
          )}
        </div>
        <div class="card">
          <h3>scores</h3>
          {s.scores.length ? (
            s.scores.map((sc) => <ScoreRow s={sc} />)
          ) : (
            <Empty>no scores yet</Empty>
          )}
        </div>
      </div>
      <div class="grid wide">
        <div class="card">
          <h3>
            context timeline
            <span class="right">
              <select
                value={sel ?? ""}
                onChange={(e) => go((e.target as HTMLSelectElement).value || null)}
              >
                {!sel ? <option value="">pick a session</option> : null}
                {d.sessions.rows.map((r) => (
                  <option value={r.session}>
                    {r.session.slice(0, 8)} · {ago(r.lastCall)} · {usd(r.totals.costUsd)}
                    {r.session === s.sessionId ? " · current" : ""}
                  </option>
                ))}
                {sel && !d.sessions.rows.some((r) => r.session === sel) ? (
                  <option value={sel}>{sel.slice(0, 8)}</option>
                ) : null}
              </select>
            </span>
          </h3>
          {detail.error ? (
            <ErrorBox error={detail.error} />
          ) : detail.data?.timeline.length ? (
            <>
              <ContextChart points={detail.data.timeline} color={color} />
              <div class="muted small">
                {detail.data.timeline.length} calls · {detail.data.contextEvents.length} compaction
                {detail.data.contextEvents.length === 1 ? "" : "s"} ·{" "}
                {usd(detail.data.totals.costUsd)} · {pct(detail.data.totals.cacheHitRate)} cache
                hits · times local
              </div>
            </>
          ) : sel ? (
            <Empty>{detail.loading ? <Spinner /> : "no API calls recorded for this session"}</Empty>
          ) : (
            <Empty>no sessions with API calls yet</Empty>
          )}
        </div>
        <div class="card">
          <h3>session insights</h3>
          <InsightList
            items={detail.data?.insights.filter((i) => i.scope === "session") ?? []}
            empty={sel ? "nothing to flag in this session" : "pick a session"}
          />
        </div>
      </div>
      <div class="grid two">
        <div class="card">
          <h3>models</h3>
          <ModelsTable rows={d.models.rows} color={color} />
        </div>
        <div class="card">
          <h3>
            tool results in context
            <span class="right">{fmt(Math.ceil(d.tools.totalChars / 4))} est. tokens</span>
          </h3>
          <ToolsTable rows={d.tools.rows} />
        </div>
      </div>
      <div class="grid two">
        <div class="card">
          <h3>
            insights <span class="right">{d.insights.insights.length}</span>
          </h3>
          <InsightList items={d.insights.insights} empty="nothing to flag in this range" />
        </div>
        <div class="card">
          <h3>eminiar savings</h3>
          <div class="row" style={{ gap: 24, marginBottom: 8 }}>
            <div>
              <div class="big">{usd(s.savings.directUsd)}</div>
              <div class="sub">
                direct · {fmt(s.savings.savedTokens)} tokens never written to cache
              </div>
            </div>
            <div>
              <div class="big">{usd(s.savings.compoundingUsd)}</div>
              <div class="sub">
                compounding · re-read on {s.savings.laterCallsPerSession.toFixed(1)} later calls per
                session
              </div>
            </div>
          </div>
          <ul class="reasons">
            {s.savings.assumptions.map((a) => (
              <li>{a}</li>
            ))}
          </ul>
        </div>
      </div>
      <div class="grid">
        <div class="card" style={{ gridColumn: "1 / -1" }}>
          <h3>
            5-hour billing blocks
            {d.blocks.rows.some((b) => b.active) ? (
              <span class="right">
                {d.blocks.burn.reliable
                  ? `${usd(d.blocks.burn.usdPerHour)}/h · ${fmt(Math.round(d.blocks.burn.tokensPerMin))} tok/min`
                  : "burn rate n/a"}
              </span>
            ) : null}
          </h3>
          <BlocksTable rows={d.blocks.rows} color={color} />
        </div>
      </div>
    </div>
  );
}
