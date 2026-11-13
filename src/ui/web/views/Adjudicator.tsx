import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
// Shared with the node side so the dashboard and the CLI print the same figures.
import { formatUsd } from "../../../usage/pricing.js";
import {
  type AdjDayBucket,
  type AdjDecisionDetail,
  type AdjDecisionRow,
  type AdjDecisionsPage,
  type AdjEvalPayload,
  type AdjHealth,
  type AdjOverview,
  type AdjReason,
  type AdjSavings,
  type AdjScores,
  type AdjScoreTable,
  type AdjTryIt,
  api,
  post,
} from "../api.js";
import { ErrorBox, KV, Spinner, Tag, useAsync } from "../components.js";
import {
  Badge,
  Card,
  EmptyState,
  GradientText,
  Hero,
  Pill,
  Segmented,
  Skeleton,
  Stat,
  StatRow,
} from "../ds.js";
import { useWidth } from "../history/charts.js";
import { navigate } from "../router.js";
import { ago, cls, fmt } from "../util.js";
import {
  actionInfo,
  breakerInfo,
  COMPLEXITY_LABELS,
  complexityBreakdown,
  complexityLabel,
  countTicks,
  DEGRADED_HELP,
  dayMax,
  decisionParams,
  evalFacts,
  evalTable,
  featureFacts,
  featureLabel,
  heat,
  type KeptModelCounts,
  keptModelLabel,
  type LogFilters,
  matrixGrid,
  ms,
  OUTCOME_INFO,
  outcomeTone,
  PART_COLORS,
  PART_HELP,
  PARTS,
  pageLabel,
  rate,
  SOURCE_COLORS,
  SOURCE_HELP,
  SOURCES,
  type SplitTable,
  savingsNote,
  signed,
  splitTable,
  statusTone,
  type Tone,
  topIntents,
  topReasons,
  tryItReason,
  usageGapNote,
} from "./adjudicator-helpers.js";
import { JevImpact } from "./JevImpact.js";
import { jevActive } from "./jev-helpers.js";
import { SecurityPanel } from "./SecurityPanel.js";
import { securityActive } from "./security-helpers.js";
import { shortModel } from "./usage-helpers.js";

// --- small bits --------------------------------------------------------------------------

const usd = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : formatUsd(n);
const RANGES: Array<["7d" | "30d" | "90d" | "all", string]> = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["all", "all"],
];
type Range = (typeof RANGES)[number][0];
const PAGE = 50;
/** Score-table options below this share are folded behind a "more options" link. */
const MIN_SHOWN = 0.01;
const when = (ts: number) =>
  new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function ToneTag({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ComponentChildren;
  title?: string;
}): JSX.Element {
  return (
    <span class={cls("tag", `adj-t-${tone}`)} title={title}>
      {children}
    </span>
  );
}

function Swatch({
  color,
  label,
  title,
}: {
  color: string;
  label: string;
  title?: string;
}): JSX.Element {
  return (
    <span class="kdot-lbl" title={title}>
      <i class="kdot" style={{ background: color }} />
      {label}
    </span>
  );
}

function Code({ children }: { children: ComponentChildren }): JSX.Element {
  return <code class="adj-cmd">{children}</code>;
}

/** A section heading inside the drawer. */
function H({
  children,
  right,
}: {
  children: ComponentChildren;
  right?: ComponentChildren;
}): JSX.Element {
  return (
    <h4 class="adj-h">
      {children}
      {right ? <span class="right">{right}</span> : null}
    </h4>
  );
}

// --- charts ------------------------------------------------------------------------------

function DayChart({ rows }: { rows: AdjDayBucket[] }): JSX.Element {
  const [box, width] = useWidth<HTMLDivElement>();
  const H0 = 170;
  const PAD = { l: 34, r: 8, t: 8, b: 22 };
  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const plotH = H0 - PAD.t - PAD.b;
  const n = rows.length;
  const bw = n ? plotW / n : plotW;
  const gap = bw >= 6 ? 2 : bw >= 3 ? 1 : 0;
  const ticks = countTicks(dayMax(rows));
  const max = ticks[ticks.length - 1]!;
  const y = (v: number) => PAD.t + plotH - (v / max) * plotH;
  const [hover, setHover] = useState<number | null>(null);
  const every = Math.max(1, Math.ceil(n / Math.max(2, plotW / 70)));
  const hr = hover !== null ? rows[hover] : undefined;
  return (
    <div class="hist-chart" ref={box}>
      <svg
        width={width}
        height={H0}
        role="img"
        aria-label="decisions per day, stacked by verdict source"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.floor((e.clientX - r.left - PAD.l) / bw);
          setHover(i >= 0 && i < n ? i : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} class="grid" />
            <text x={PAD.l - 6} y={y(t) + 3} class="axis" text-anchor="end">
              {t}
            </text>
          </g>
        ))}
        {rows.map((r, i) =>
          i % every === 0 ? (
            <text x={PAD.l + i * bw} y={H0 - 6} class="axis">
              {r.day.slice(5)}
            </text>
          ) : null,
        )}
        {rows.map((r, i) => {
          let acc = 0;
          return (
            <g opacity={hover !== null && hover !== i ? 0.55 : 1}>
              {SOURCES.map((s) => {
                const v = r[s];
                if (!v) return null;
                const y1 = y(acc + v);
                const y0 = y(acc);
                acc += v;
                return (
                  <rect
                    x={PAD.l + i * bw + gap / 2}
                    y={y1}
                    width={Math.max(0.5, bw - gap)}
                    height={Math.max(0, y0 - y1 - (bw >= 6 ? 1 : 0))}
                    fill={SOURCE_COLORS[s]}
                    rx={bw >= 6 ? 1.5 : 0}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      {hr ? (
        <div
          class="tip"
          style={{ left: Math.max(0, Math.min(width - 200, PAD.l + hover! * bw + 10)), top: 4 }}
        >
          <b>{hr.day}</b> · {hr.total} decision{hr.total === 1 ? "" : "s"}
          <div class="stack" style={{ gap: 1, marginTop: 4 }}>
            {SOURCES.filter((s) => hr[s]).map((s) => (
              <Swatch color={SOURCE_COLORS[s]} label={`${s} ${hr[s]}`} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ComplexityHistogram({ counts }: { counts: number[] }): JSX.Element {
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div class="adj-hist" role="img" aria-label="decisions by complexity bucket">
      {counts.map((c, i) => (
        <div class="adj-hist-col" title={`${c} decision${c === 1 ? "" : "s"} at complexity ${i}`}>
          <span class="n">{c}</span>
          <div class="adj-hist-track">
            <div class="adj-hist-bar" style={{ height: `${(c / max) * 100}%` }} />
          </div>
          <span class="k">{i}</span>
          <span class="lbl">{COMPLEXITY_LABELS[i]}</span>
          <span class="lbl muted">{total ? `${Math.round((c / total) * 100)}%` : ""}</span>
        </div>
      ))}
    </div>
  );
}

function MatrixHeat({
  matrix,
  kept,
}: {
  matrix: AdjSavings["matrix"];
  /** Dispatches left out of the matrix: the advice named no model (pin, FORCE, fork). */
  kept?: KeptModelCounts | undefined;
}): JSX.Element {
  const g = matrixGrid(matrix);
  const outside = keptModelLabel(kept);
  if (!g.total)
    return (
      <EmptyState compact icon="▦" title="No dispatches to compare">
        {outside
          ? `No dispatch ran on a model the advice chose (${outside}).`
          : "No agent or plan dispatches with a known model yet."}
      </EmptyState>
    );
  return (
    <>
      <div class="adj-scroll">
        <table class="adj-matrix">
          <thead>
            <tr>
              <th class="corner">suggested ↓ · ran →</th>
              {g.cols.map((c) => (
                <th class="num">{shortModel(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {g.rows.map((r) => (
              <tr>
                <th>{r}</th>
                {g.cols.map((c) => {
                  const n = g.cell(r, c);
                  const a = heat(n, g.max);
                  return (
                    <td
                      class={cls("num", "cell", r === c && "diag", a > 0.55 && "strong")}
                      style={
                        a
                          ? {
                              background: `color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)`,
                            }
                          : undefined
                      }
                      title={`${n} suggested ${r}, ran on ${c}`}
                    >
                      {n || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="sub">
        {g.agree} of {g.total} ran on the suggested tier ({Math.round((g.agree / g.total) * 100)}%)
        · outlined cells are agreement
        {outside ? ` · not counted: ${outside} (the advice named no model)` : ""}
      </div>
    </>
  );
}

// --- score tables (drawer + try-it) ------------------------------------------------------

function ReasonBars({
  reasons,
  limit = Infinity,
}: {
  reasons: AdjReason[];
  limit?: number;
}): JSX.Element {
  const list = topReasons(reasons, limit);
  if (!list.length) return <div class="muted small">no recorded reasons</div>;
  const maxAbs = Math.max(0.01, ...list.map((r) => Math.abs(r.weight)));
  return (
    <ul class="adj-reasons">
      {list.map((r) => {
        const w = (Math.abs(r.weight) / maxAbs) * 50;
        return (
          <li>
            <span class="f" title={r.feature}>
              {featureLabel(r.feature)}
            </span>
            <span class="adj-div" aria-hidden="true">
              <i
                class={cls(
                  r.weight < 0 ? "neg" : "pos",
                  r.feature === "provider" && "prov",
                  r.feature === "bias" && "learn",
                )}
                style={
                  r.weight < 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }
                }
              />
            </span>
            <span class="w mono">{signed(r.weight)}</span>
            {r.note ? <span class="note">{r.note}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ScoreTableView({
  title,
  table,
  alpha,
  ladder,
}: {
  title: string;
  table: AdjScoreTable | undefined;
  alpha: number;
  ladder?: (option: string) => string | null;
}): JSX.Element {
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [all, setAll] = useState(false);
  if (!table?.entries?.length)
    return (
      <div class="adj-table">
        <H>{title}</H>
        <div class="muted small">not scored</div>
      </div>
    );
  const t: SplitTable = splitTable(table, alpha);
  const expanded = open ?? new Set([t.choice, ...(t.runnerUp ? [t.runnerUp] : [])]);
  const shown = (o: string) => expanded.has(o);
  const hidden = t.entries.filter((e) => !e.chosen && !e.runnerUp && e.score < MIN_SHOWN).length;
  const toggle = (o: string) => {
    const next = new Set(expanded);
    if (next.has(o)) next.delete(o);
    else next.add(o);
    setOpen(next);
  };
  return (
    <div class="adj-table">
      <H
        right={
          <span class="muted small">
            confidence {Math.round(t.confidence * 100)}%
            {t.margin !== null ? ` · margin ${Math.round(t.margin * 100)} pts` : ""}
          </span>
        }
      >
        {title}
      </H>
      <div class="adj-verdict-line">
        <b class="adj-choice">{t.choice}</b>
        {ladder?.(t.choice) ? <span class="muted small"> → {ladder(t.choice)}</span> : null}
        {t.runnerUp ? <span class="muted small"> · runner-up {t.runnerUp}</span> : null}
        {t.roundedUp ? (
          <ToneTag
            tone="warn"
            title="confidence was below weights.lowConfidence, so the tier was rounded up one step"
          >
            rounded up
          </ToneTag>
        ) : null}
        {alpha > 0 ? (
          <span class="muted small">
            {" "}
            · provider weight α {alpha.toFixed(2)} · {Math.round(t.providerShare * 100)}% of the
            winning score
          </span>
        ) : (
          <span class="muted small"> · heuristic only</span>
        )}
      </div>
      <div class="adj-entries">
        {(all
          ? t.entries
          : t.entries.filter((e) => e.chosen || e.runnerUp || e.score >= MIN_SHOWN)
        ).map((e) => (
          <div class={cls("adj-entry", e.chosen && "chosen", e.runnerUp && "runner")}>
            <button
              type="button"
              class="adj-entry-row"
              aria-expanded={shown(e.option)}
              onClick={() => toggle(e.option)}
              title="show the reasons for this option"
            >
              <span class="opt">
                {e.chosen ? (
                  <span class="mark" title="chosen">
                    ✓
                  </span>
                ) : e.runnerUp ? (
                  <span class="mark ru">2</span>
                ) : (
                  <span class="mark none" />
                )}
                {e.option}
              </span>
              <span class="adj-sbar" aria-hidden="true">
                {PARTS.map((p) =>
                  e.parts[p] > 0.0005 ? (
                    <i
                      style={{ width: `${e.parts[p] * 100}%`, background: PART_COLORS[p] }}
                      title={`${p} ${Math.round(e.parts[p] * 100)}%`}
                    />
                  ) : null,
                )}
              </span>
              <span class="pc mono">{Math.round(e.score * 100)}%</span>
            </button>
            {shown(e.option) ? <ReasonBars reasons={e.reasons} limit={8} /> : null}
          </div>
        ))}
        {hidden ? (
          <button type="button" class="adj-link small adj-more-opts" onClick={() => setAll(!all)}>
            {all
              ? "hide options under 1%"
              : `+ ${hidden} more option${hidden === 1 ? "" : "s"} under 1%`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PartsLegend(): JSX.Element {
  return (
    <div class="row tight adj-legend">
      {PARTS.map((p) => (
        <Swatch color={PART_COLORS[p]} label={p} title={PART_HELP[p]} />
      ))}
      <span class="muted small">· ✓ chosen · 2 runner-up · click an option for its reasons</span>
    </div>
  );
}

function ComplexityView({
  value,
  reasons,
  alpha,
}: {
  value: number;
  reasons: AdjReason[];
  alpha?: number | undefined;
}): JSX.Element {
  const b = complexityBreakdown(value, reasons);
  const pos = (v: number) => `${(Math.max(0, Math.min(4, v)) / 4) * 100}%`;
  return (
    <div>
      <div class="adj-verdict-line">
        <b class="adj-choice">{value.toFixed(2)}</b>
        <span class="muted small">
          {" "}
          / 4 · {complexityLabel(value)}
          {b.provider
            ? ` · heuristic ${b.heuristic.toFixed(2)}, provider ${signed(b.provider)}${alpha ? ` (α ${alpha.toFixed(2)})` : ""}`
            : " · heuristic only"}
        </span>
      </div>
      <div class="adj-scale" role="img" aria-label={`complexity ${value.toFixed(2)} of 4`}>
        {COMPLEXITY_LABELS.map((l, i) => (
          <span class={cls(Math.round(value) === i && "on")}>
            {i} {l}
          </span>
        ))}
        {b.provider ? (
          <i
            class="mk heur"
            style={{ left: pos(b.heuristic) }}
            title={`heuristic ${b.heuristic.toFixed(2)}`}
          />
        ) : null}
        <i class="mk" style={{ left: pos(value) }} title={`final ${value.toFixed(2)}`} />
      </div>
      {b.providerNote ? <div class="muted small">provider: {b.providerNote}</div> : null}
      <ReasonBars reasons={b.terms} limit={12} />
    </div>
  );
}

// --- decision drawer ---------------------------------------------------------------------

function DecisionDrawer({ id, onClose }: { id: number; onClose: () => void }): JSX.Element {
  const d = useAsync(() => api<AdjDecisionDetail>("/api/adjudicator/decision", { id }), [id]);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      prev?.focus?.();
    };
  }, [id]);
  return (
    <>
      <div class="adj-backdrop" onClick={onClose} />
      <aside
        class="adj-drawer"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`decision ${id}`}
      >
        <div class="adj-drawer-head">
          <b>decision #{id}</b>
          {d.data ? (
            <>
              <Tag>{d.data.row.surface}</Tag>
              <span class="muted small" title={new Date(d.data.row.ts).toISOString()}>
                {when(d.data.row.ts)} · {ago(d.data.row.ts)}
              </span>
            </>
          ) : null}
          <span class="spacer" />
          <button type="button" class="ghost sm" onClick={onClose} aria-label="close">
            ✕ close
          </button>
        </div>
        <div class="adj-drawer-body">
          {d.error ? (
            <ErrorBox error={d.error} />
          ) : !d.data ? (
            <Spinner />
          ) : (
            <DecisionBody row={d.data.row} scores={d.data.scores} />
          )}
        </div>
      </aside>
    </>
  );
}

function DecisionBody({
  row,
  scores,
}: {
  row: AdjDecisionDetail["row"];
  scores: AdjScores | null;
}): JSX.Element {
  const act = actionInfo(row.action);
  const out = OUTCOME_INFO[row.outcome] ?? { tone: "muted" as Tone, help: "" };
  const alpha = scores?.alpha ?? {};
  const bias = Object.entries(scores?.bias ?? {}).filter(([, v]) => v);
  const intents = topIntents(scores?.features);
  const facts = featureFacts(scores?.features);
  const tierModel = (t: string) =>
    row.modelFinal && row.tier === t ? shortModel(row.modelFinal) : null;
  return (
    <>
      <section>
        <H
          right={
            row.inputChars ? <span class="muted small">{fmt(row.inputChars)} chars in</span> : null
          }
        >
          input
        </H>
        {row.inputHead ? (
          <blockquote class="adj-head">
            {row.inputHead}
            {row.inputChars && row.inputChars > row.inputHead.length ? "…" : ""}
          </blockquote>
        ) : (
          <div class="muted small">not stored (privacy.storeHead is off): only a hash is kept</div>
        )}
        <div class="muted small">
          redacted, at most 80 characters are ever stored · hash {row.inputHash.slice(0, 12)}
        </div>
      </section>

      <section class="adj-summary">
        <div>
          <span class="k">complexity</span>
          <b>{typeof row.complexity === "number" ? row.complexity.toFixed(1) : "—"}</b>
          <span class="s">{complexityLabel(row.complexity)}</span>
        </div>
        <div>
          <span class="k">model tier</span>
          <b>{row.tier ?? "—"}</b>
          <span class="s">effort {row.effort ?? "—"}</span>
        </div>
        <div>
          <span class="k">tool</span>
          <b>{row.tool ?? "—"}</b>
        </div>
        <div>
          <span class="k">role</span>
          <b>{row.role ?? "—"}</b>
        </div>
        <div>
          <span class="k">confidence</span>
          <b>{typeof row.confidence === "number" ? `${Math.round(row.confidence * 100)}%` : "—"}</b>
          <span class="s">tier</span>
        </div>
      </section>

      <section>
        <H>how it decided</H>
        <div class="row tight" style={{ marginBottom: 6 }}>
          <Swatch
            color={
              SOURCE_COLORS[(row.source ?? "heuristic") as keyof typeof SOURCE_COLORS] ?? "#94a3b8"
            }
            label={row.source ?? "heuristic"}
            title={SOURCE_HELP[(row.source ?? "heuristic") as keyof typeof SOURCE_HELP]}
          />
          <span class="muted small">
            {SOURCE_HELP[(row.source ?? "heuristic") as keyof typeof SOURCE_HELP] ?? ""}
          </span>
        </div>
        <KV
          rows={[
            [
              "provider",
              <>
                {row.provider ?? "heuristic"}
                {row.providerModel ? <span class="muted"> · {row.providerModel}</span> : null}
              </>,
            ],
            [
              "provider status",
              <ToneTag tone={statusTone(row.providerStatus)}>
                {row.providerStatus ?? "n/a"}
              </ToneTag>,
            ],
            [
              "provider weight α",
              Object.keys(alpha).length ? (
                <span class="row tight">
                  {(["complexity", "tier", "tool", "role"] as const).map((k) => (
                    <span class="adj-alpha" title={`${k}: ${(alpha[k] ?? 0).toFixed(2)}`}>
                      {k}
                      <span class="scorebar">
                        <i
                          style={{
                            width: `${(alpha[k] ?? 0) * 100}%`,
                            background: PART_COLORS.provider,
                          }}
                        />
                      </span>
                      <span class="mono small">{(alpha[k] ?? 0).toFixed(2)}</span>
                    </span>
                  ))}
                </span>
              ) : (
                <span class="muted">0 everywhere: the heuristic decided alone</span>
              ),
            ],
            [
              "learned bias",
              bias.length ? (
                <span class="row tight">
                  {bias.map(([k, v]) => (
                    <span class="tag mono">
                      {k} {signed(v)}
                    </span>
                  ))}
                </span>
              ) : (
                <span class="muted">none applied</span>
              ),
            ],
          ]}
        />
      </section>

      {scores ? (
        <>
          <section>
            <H>complexity</H>
            <ComplexityView
              value={scores.complexity}
              reasons={scores.complexityReasons ?? []}
              alpha={alpha.complexity}
            />
          </section>
          <section>
            <PartsLegend />
            <ScoreTableView
              title="model tier"
              table={scores.tier}
              alpha={alpha.tier ?? 0}
              ladder={tierModel}
            />
            <ScoreTableView title="tool" table={scores.tool} alpha={alpha.tool ?? 0} />
            <ScoreTableView title="agent role" table={scores.role} alpha={alpha.role ?? 0} />
          </section>
        </>
      ) : (
        <section>
          <div class="muted small">
            this row has no score tables (older scorer or a cache hit stored without them)
          </div>
        </section>
      )}

      <section>
        <H>cost and speed</H>
        <div class="adj-summary small4">
          <div>
            <span class="k">latency</span>
            <b>{ms(row.latencyMs)}</b>
            <span class="s">end to end</span>
          </div>
          <div>
            <span class="k">provider</span>
            <b>{ms(row.providerLatencyMs)}</b>
            <span class="s">round trip</span>
          </div>
          <div>
            <span class="k">tokens</span>
            <b>
              {row.tokensIn != null ? `${fmt(row.tokensIn)} / ${fmt(row.tokensOut ?? 0)}` : "—"}
            </b>
            <span class="s">in / out</span>
          </div>
          <div>
            <span class="k">cost</span>
            <b>
              {row.costUsd === null || row.costUsd === undefined
                ? row.tokensIn != null
                  ? "unpriced"
                  : "$0"
                : usd(row.costUsd)}
            </b>
            <span class="s">adjudicator spend</span>
          </div>
        </div>
      </section>

      <section>
        <H>what happened</H>
        <KV
          rows={[
            [
              "advice",
              <>
                <ToneTag tone={act.tone}>{act.label}</ToneTag>{" "}
                <span class="muted small">{act.help}</span>
              </>,
            ],
            [
              "model",
              <span>
                {row.modelRequested ? (
                  <>
                    requested <b>{shortModel(row.modelRequested)}</b> ·{" "}
                  </>
                ) : null}
                {row.modelFinal ? (
                  <>
                    set <b>{shortModel(row.modelFinal)}</b> ·{" "}
                  </>
                ) : null}
                ran on <b>{row.actualModel ? shortModel(row.actualModel) : "—"}</b>
              </span>,
            ],
            [
              "baseline",
              row.baselineModel ? shortModel(row.baselineModel) : <span class="muted">—</span>,
            ],
            [
              "actual usage",
              row.actualTokens != null ? (
                `${fmt(row.actualTokens)} tokens · ${usd(row.actualCostUsd)}`
              ) : (
                <span class="muted">—</span>
              ),
            ],
            [
              "outcome",
              <>
                <ToneTag tone={out.tone}>{row.outcome}</ToneTag>{" "}
                <span class="muted small">
                  {out.help}
                  {row.outcomeSource ? ` · via ${row.outcomeSource}` : ""}
                  {row.outcomeTs ? ` · ${ago(row.outcomeTs)}` : ""}
                  {row.final ? " · final" : " · still open"}
                </span>
              </>,
            ],
          ]}
        />
      </section>

      <section>
        <H>savings for this decision</H>
        <div class="adj-savings-row">
          <div>
            <span class="k">baseline cost</span>
            <b>{usd(row.baselineCostUsd)}</b>
          </div>
          <span class="op">−</span>
          <div>
            <span class="k">actual cost</span>
            <b>{usd(row.actualCostUsd)}</b>
          </div>
          <span class="op">=</span>
          <div>
            <span class="k">saved</span>
            <b
              class={cls(
                row.savingsUsd != null &&
                  (row.savingsUsd > 0 ? "ok" : row.savingsUsd < 0 ? "bad" : ""),
              )}
            >
              {usd(row.savingsUsd)}
            </b>
          </div>
        </div>
        <div class="muted small">{savingsNote(row)}</div>
      </section>

      {scores?.features ? (
        <section>
          <H>features the heuristic saw</H>
          {intents.length ? (
            <div class="adj-intents">
              {intents.map(([k, v]) => (
                <span class="adj-alpha" title={`intent ${k}: ${v.toFixed(2)}`}>
                  {k}
                  <span class="scorebar">
                    <i style={{ width: `${Math.min(1, v) * 100}%` }} />
                  </span>
                  <span class="mono small">{v.toFixed(2)}</span>
                </span>
              ))}
            </div>
          ) : (
            <div class="muted small">no intent detected</div>
          )}
          <div class="row tight" style={{ marginTop: 6 }}>
            {facts.map(([k, v]) => (
              <span class="tag">
                {k} <b>{v}</b>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <H>ids</H>
        <KV
          rows={[
            [
              "session",
              row.sessionId ? <span class="mono">{row.sessionId.slice(0, 8)}</span> : "—",
            ],
            ["agent", row.agentId ?? "—"],
            [
              "swarm",
              row.runId ? (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("swarm", { run: row.runId ?? undefined });
                  }}
                >
                  {row.runId}
                  {row.taskId ? ` · task #${row.taskId}` : ""}
                </a>
              ) : (
                "—"
              ),
            ],
            ["parent", row.parentId ? `#${row.parentId}` : "—"],
            ["scorer", row.version ?? "—"],
          ]}
        />
      </section>
    </>
  );
}

// --- call log ----------------------------------------------------------------------------

function CallLog({
  ov,
  since,
  tick,
  selected,
  onOpen,
}: {
  ov: AdjOverview;
  since: Range;
  tick: number;
  selected: number | null;
  onOpen: (id: number) => void;
}): JSX.Element {
  const [f, setF] = useState<LogFilters>({});
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [since, f.surface, f.provider, f.outcome]);
  const page = useAsync(
    () =>
      api<AdjDecisionsPage>(
        "/api/adjudicator/decisions",
        decisionParams({ ...f, since }, PAGE, offset),
      ),
    [since, f.surface, f.provider, f.outcome, offset, tick],
  );
  const sel = (key: keyof LogFilters, label: string, opts: string[]) => (
    <label class="adj-filter">
      <span class="muted small">{label}</span>
      <select
        value={f[key] ?? ""}
        onChange={(e) => setF({ ...f, [key]: (e.target as HTMLSelectElement).value || undefined })}
      >
        <option value="">all</option>
        {opts.map((o) => (
          <option value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
  const p = page.data;
  return (
    <Card
      class="adj-log"
      title="Call log"
      right={p ? pageLabel(p.offset, p.rows.length, p.total) : ""}
    >
      <div class="row adj-filters">
        {sel(
          "surface",
          "surface",
          ov.filters.surfaces.filter((s) => s !== "test"),
        )}
        {sel("provider", "provider", ov.filters.providers)}
        {sel("outcome", "outcome", ov.filters.outcomes)}
        {f.surface || f.provider || f.outcome ? (
          <button type="button" class="ghost sm" onClick={() => setF({})}>
            clear
          </button>
        ) : null}
        <span class="spacer" />
        {page.loading ? <Spinner /> : null}
      </div>
      {page.error ? (
        <ErrorBox error={page.error} />
      ) : !p ? (
        <Spinner />
      ) : !p.rows.length ? (
        <EmptyState compact icon="▁" title="No decisions">
          {p.total || f.surface || f.provider || f.outcome
            ? "None match these filters."
            : "Nothing was recorded in this range."}
        </EmptyState>
      ) : (
        <div class="adj-scroll">
          <table class="adj-calls">
            <thead>
              <tr>
                <th>when</th>
                <th>surface</th>
                <th>input</th>
                <th class="num">cx</th>
                <th>tier</th>
                <th>tool</th>
                <th>role</th>
                <th>source</th>
                <th class="num">latency</th>
                <th class="num">cost</th>
                <th>advice</th>
                <th>outcome</th>
                <th class="num">saved</th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r) => (
                <LogRow r={r} selected={selected === r.id} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p && p.total > PAGE ? (
        <div class="row adj-pager">
          <button
            type="button"
            class="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            ← newer
          </button>
          <span class="muted small">
            page {Math.floor(offset / PAGE) + 1} of {Math.ceil(p.total / PAGE)}
          </span>
          <button
            type="button"
            class="sm"
            disabled={offset + PAGE >= p.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            older →
          </button>
        </div>
      ) : null}
    </Card>
  );
}

function LogRow({
  r,
  selected,
  onOpen,
}: {
  r: AdjDecisionRow;
  selected: boolean;
  onOpen: (id: number) => void;
}): JSX.Element {
  const act = actionInfo(r.action);
  const src = (r.source ?? "heuristic") as keyof typeof SOURCE_COLORS;
  const cx = typeof r.complexity === "number" ? r.complexity : null;
  return (
    <tr
      class={cls("click", selected && "sel")}
      tabIndex={0}
      onClick={() => onOpen(r.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(r.id);
        }
      }}
      aria-label={`decision ${r.id}`}
    >
      <td class="nowrap muted" title={new Date(r.ts).toISOString()}>
        {when(r.ts)}
      </td>
      <td>{r.surface}</td>
      <td class="adj-headcell" title={r.inputHead ?? ""}>
        {r.inputHead ?? <span class="muted">—</span>}
      </td>
      <td class="num nowrap" title={complexityLabel(cx)}>
        {cx !== null ? (
          <>
            <span class="adj-cx">
              <i style={{ width: `${(cx / 4) * 100}%` }} />
            </span>
            {cx.toFixed(1)}
          </>
        ) : (
          "—"
        )}
      </td>
      <td>
        <b>{r.tier ?? "—"}</b>
      </td>
      <td class="mono small">{r.tool ?? "—"}</td>
      <td>{r.role ?? "—"}</td>
      <td
        class="nowrap"
        title={`${SOURCE_HELP[src] ?? ""}${r.provider ? ` · ${r.provider}` : ""} · ${r.providerStatus ?? "n/a"}`}
      >
        <i class="kdot" style={{ background: SOURCE_COLORS[src] ?? "#94a3b8" }} />
        {src}
        {r.providerStatus && r.providerStatus !== "ok" && r.providerStatus !== "n/a" ? (
          <span class={cls("small", `adj-t-${statusTone(r.providerStatus)}`)}>
            {" "}
            {r.providerStatus}
          </span>
        ) : null}
      </td>
      <td class="num nowrap">{ms(r.latencyMs)}</td>
      <td class="num nowrap">
        {r.costUsd != null ? usd(r.costUsd) : <span class="muted">—</span>}
      </td>
      <td>
        <span class={cls("small", `adj-t-${act.tone}`)} title={act.help}>
          {act.label}
        </span>
      </td>
      <td>
        <span class={cls("small", `adj-t-${outcomeTone(r.outcome)}`)}>{r.outcome}</span>
      </td>
      <td
        class={cls(
          "num nowrap",
          r.savingsUsd != null && r.savingsUsd > 0 && "ok",
          r.savingsUsd != null && r.savingsUsd < 0 && "bad",
        )}
      >
        {r.savingsUsd != null ? usd(r.savingsUsd) : <span class="muted">—</span>}
      </td>
    </tr>
  );
}

// --- cards -------------------------------------------------------------------------------

type HealthOverview = AdjOverview;

/** The adjudicator keys a projectIgnored line names, e.g. ["keyEnv", "provider"]. */
function ignoredKeysOf(line: string | null | undefined): string[] {
  if (!line) return [];
  const head = line.split(":")[0] ?? "";
  return [...head.matchAll(/adjudicator\.([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

function HealthCard({ ov }: { ov: HealthOverview }): JSX.Element {
  const p = ov.provider;
  const configured = ov.health.find((h) => h.configured);
  const others = ov.health.filter((h) => !h.configured);
  const ignored = ignoredKeysOf(ov.projectIgnored);
  return (
    <Card
      title="Provider"
      right={
        <>
          {ov.projectIgnored ? (
            <Badge tone="warn" title={ov.projectIgnored}>
              project config ignored: {ignored.length ? ignored.join(", ") : "some keys"}
            </Badge>
          ) : null}
          <Badge
            tone={ov.mode === "apply" ? "accent" : "muted"}
            title={
              ov.mode === "apply"
                ? "sets the Agent model within the configured floor and ceiling"
                : "suggests only; Claude decides"
            }
          >
            {ov.mode} mode
          </Badge>
        </>
      }
    >
      <KV
        rows={[
          [
            "configured",
            <>
              <b>{p.configured}</b>
              {p.preset ? <span class="muted"> · {p.preset}</span> : null}
              {p.model ? <span class="muted"> · {p.model}</span> : null}
            </>,
          ],
          [
            "in use",
            p.effective === p.configured ? (
              <span class="ok">{p.effective}</span>
            ) : (
              <span>
                <b class="warn">{p.effective}</b>
                <span class="muted small">
                  {" "}
                  · {p.degraded ? (DEGRADED_HELP[p.degraded] ?? p.degraded) : ""}
                </span>
              </span>
            ),
          ],
          ...(p.detail && p.effective !== p.configured
            ? ([["why", <span class="small">{p.detail}</span>]] as Array<
                [string, ComponentChildren]
              >)
            : []),
          [
            "where",
            p.configuredRemote ? (
              <span>remote{p.baseUrl ? <span class="muted"> · {p.baseUrl}</span> : null}</span>
            ) : (
              "on this machine"
            ),
          ],
          [
            "key",
            p.configuredRemote ? (
              <span>
                {ov.keySource === "none" ? <span class="warn">none</span> : `from ${ov.keySource}`}
                {ov.keyFileRefused ? (
                  <span class="bad small"> · key file refused (permissions)</span>
                ) : null}
                <span class="muted small">
                  {" "}
                  · consent {ov.consent ? "given" : "not given"}
                  {ov.origin ? ` for ${ov.origin}` : ""}
                </span>
              </span>
            ) : (
              <span class="muted">not needed</span>
            ),
          ],
          [
            "apply effective",
            ov.apply.checked ? (
              <span>
                {ov.apply.effective} of {ov.apply.checked}
                {ov.apply.ineffective ? (
                  <span class="warn small"> · {ov.apply.ineffective} ran on another model</span>
                ) : null}
              </span>
            ) : (
              <span class="muted">no applied dispatches checked yet</span>
            ),
          ],
        ]}
      />
      {configured ? (
        <HealthRow h={configured} now={ov.now} />
      ) : p.configured === "heuristic" ? (
        <div class="muted small adj-health">the heuristic runs locally: no breaker, no spend</div>
      ) : null}
      {others.length ? (
        <details class="adj-more">
          <summary class="muted small">
            {others.length} other provider{others.length === 1 ? "" : "s"} with history
          </summary>
          {others.map((h) => (
            <HealthRow h={h} now={ov.now} />
          ))}
        </details>
      ) : null}
    </Card>
  );
}

function HealthRow({ h, now }: { h: AdjHealth; now: number }): JSX.Element {
  const b = breakerInfo(h.state);
  const cap = h.dailyCapUsd;
  const used = cap ? Math.min(1, h.spendTodayUsd / cap) : 0;
  return (
    <div class="adj-health">
      <div class="row tight">
        <b>{h.provider}</b>
        <ToneTag tone={b.tone} title={b.help}>
          {b.label}
        </ToneTag>
        {h.failures ? (
          <span class="muted small">
            {h.failures} recent failure{h.failures === 1 ? "" : "s"}
          </span>
        ) : null}
        <span class="spacer" />
        {h.retryAt && h.retryAt > now ? (
          <span class="warn small">retry in {ms(h.retryAt - now)}</span>
        ) : null}
      </div>
      <div class="adj-health-grid">
        <span class="muted">latency</span>
        <span>
          {h.latency.n ? `p50 ${ms(h.latency.p50)} · p95 ${ms(h.latency.p95)}` : "no calls"}
          {h.latency.n ? <span class="muted small"> · last {h.latency.n}</span> : null}
        </span>
        <span class="muted">last ok</span>
        <span>{h.lastOkAt ? ago(h.lastOkAt) : "—"}</span>
        <span class="muted">last error</span>
        <span>
          {h.lastErrorClass ? <span class="bad">{h.lastErrorClass}</span> : "—"}
          {h.lastErrorAt ? <span class="muted small"> · {ago(h.lastErrorAt)}</span> : null}
        </span>
        <span class="muted">spend today</span>
        <span>
          {cap === null ? (
            <span class="muted">local · no cap</span>
          ) : (
            <>
              {usd(h.spendTodayUsd)} of {usd(cap)}
              <span class="scorebar" style={{ maxWidth: 160 }}>
                <i
                  class={cls(used >= 0.9 ? "bad" : used >= 0.6 ? "warn" : "ok")}
                  style={{ width: `${used * 100}%` }}
                />
              </span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function SavingsPanel({ s }: { s: AdjSavings }): JSX.Element {
  const tiers = Object.entries(s.tokensPerSuccessByTier).filter(([, v]) => v?.tasks);
  const maxTok = Math.max(1, ...tiers.map(([, v]) => v?.tokensPerTask ?? 0));
  const gap = usageGapNote(s);
  const figures: Array<[string, number, string, string]> = [
    [
      "realised",
      s.realisedUsd,
      `${s.creditedRows} followed/applied dispatches${s.redoPenaltyUsd ? ` · ${usd(s.redoPenaltyUsd)} redo penalty` : ""}`,
      "ok",
    ],
    ["potential", s.potentialUsd, `${s.potentialRows} main-session prompts · not in net`, "muted"],
    ["spend", -s.spendUsd, "the adjudicator's own provider calls", "bad"],
    ["net", s.netUsd, "realised − spend", s.netUsd >= 0 ? "ok" : "bad"],
  ];
  return (
    <Card
      title="Savings"
      right={
        gap ? (
          <Badge tone="warn" title={gap.help}>
            {gap.label}
          </Badge>
        ) : undefined
      }
    >
      <div class="adj-figs">
        {figures.map(([k, v, sub, tone]) => (
          <div>
            <div class="sub">{k}</div>
            <div class={cls("big", tone !== "muted" && v !== 0 && tone)}>
              {usd(k === "spend" ? s.spendUsd : v)}
            </div>
            <div class="sub">{sub}</div>
          </div>
        ))}
      </div>
      <h4 class="adj-h">tokens per successful task, by tier</h4>
      {tiers.length ? (
        <table class="adj-tiers">
          <tbody>
            {tiers.map(([t, v]) => (
              <tr>
                <td>{t}</td>
                <td class="num">
                  {v!.tasks} task{v!.tasks === 1 ? "" : "s"}
                </td>
                <td style={{ width: "40%" }}>
                  <span
                    class="bar"
                    style={{ width: `${Math.max(2, ((v!.tokensPerTask ?? 0) / maxTok) * 100)}%` }}
                  />
                </td>
                <td class="num">{v!.tokensPerTask != null ? fmt(v!.tokensPerTask) : "—"}</td>
                <td class="num muted">{usd(v!.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="muted small">no successful agent tasks with usage yet</div>
      )}
      <div class="muted small" style={{ marginTop: 6 }}>
        smaller tiers can need more turns: if haiku needs far more tokens per task than sonnet, the
        savings above overstate.
      </div>
    </Card>
  );
}

function Assumptions({ list }: { list: string[] }): JSX.Element {
  return (
    <Card class="adj-assume ds-block" title="How savings are computed">
      <ul class="reasons" id="adj-assumptions">
        {list.map((a) => (
          <li>{a}</li>
        ))}
      </ul>
    </Card>
  );
}

function TryIt({ ov }: { ov: AdjOverview | undefined }): JSX.Element {
  const [text, setText] = useState("");
  const [useProvider, setUseProvider] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [res, setRes] = useState<AdjTryIt>();
  const canProvider = !!ov?.enabled && ov.provider.configured !== "heuristic";
  const run = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(undefined);
    try {
      setRes(
        await post<AdjTryIt>("/api/adjudicator/test", {
          text,
          useProvider: canProvider && useProvider,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const v = res?.verdict;
  return (
    <Card class="adj-try" title="Try it" right="nothing is stored · the text is not sent back">
      <textarea
        rows={4}
        maxLength={20000}
        placeholder="Paste a prompt or task, e.g. “refactor the session store to batch writes and add tests”"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
        }}
      />
      <div class="row" style={{ marginTop: 6 }}>
        <label
          class={cls("row tight small", !canProvider && "muted")}
          title={canProvider ? "" : "needs the adjudicator enabled with a provider configured"}
        >
          <input
            type="checkbox"
            checked={canProvider && useProvider}
            disabled={!canProvider}
            onChange={(e) => setUseProvider((e.target as HTMLInputElement).checked)}
          />
          use the provider{ov && canProvider ? ` (${ov.provider.configured})` : ""}
        </label>
        {canProvider && useProvider && ov?.provider.configuredRemote ? (
          <span class="warn small">
            sends redacted text to {ov.provider.baseUrl ?? "the provider"} and counts toward today's
            cap
          </span>
        ) : null}
        <span class="spacer" />
        <button
          type="button"
          class="primary"
          disabled={busy || !text.trim()}
          onClick={() => void run()}
        >
          {busy ? "scoring…" : "score"}
        </button>
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {res && v ? (
        <div class="adj-try-out">
          <div class="row tight">
            <ToneTag tone={res.usedProvider ? "accent" : "muted"}>{v.source}</ToneTag>
            <span class="muted small">
              {tryItReason(res.reason)} · {ms(v.latencyMs)}
              {v.providerStatus && v.providerStatus !== "n/a"
                ? ` · provider ${v.providerStatus}`
                : ""}
              {res.providerModel ? ` · ${res.providerModel}` : ""}
              {v.usage?.costUsd ? ` · ${usd(v.usage.costUsd)}` : ""}
            </span>
          </div>
          {res.advice ? <blockquote class="adj-head">{res.advice}</blockquote> : null}
          <ComplexityView
            value={v.complexity}
            reasons={v.complexityReasons ?? []}
            alpha={v.alpha?.complexity}
          />
          <PartsLegend />
          <ScoreTableView title="model tier" table={v.tier} alpha={v.alpha?.tier ?? 0} />
          <ScoreTableView title="tool" table={v.tool} alpha={v.alpha?.tool ?? 0} />
          <ScoreTableView title="agent role" table={v.role} alpha={v.alpha?.role ?? 0} />
        </div>
      ) : null}
    </Card>
  );
}

function EvalCard(): JSX.Element {
  const e = useAsync(() => api<AdjEvalPayload>("/api/adjudicator/eval"), []);
  const report = e.data?.report ?? null;
  const t = evalTable(report);
  const facts = evalFacts(report);
  const verdict = facts.find(([k]) => k === "verdict");
  return (
    <Card title="Last eval">
      {e.error ? (
        <ErrorBox error={e.error} />
      ) : !e.data ? (
        <Spinner />
      ) : !report ? (
        <EmptyState compact icon="○" title="No eval yet">
          Run <Code>eminiar adjudicator eval</Code> to compare the heuristic and your provider on
          the labelled set.
          {e.data.error ? <div class="bad small">{e.data.error}</div> : null}
        </EmptyState>
      ) : (
        <>
          {verdict ? (
            <div class="adj-verdict-line">
              <b>{verdict[1]}</b>
            </div>
          ) : null}
          <KV rows={facts.filter(([k]) => k !== "verdict").map(([k, v]) => [k, v])} />
          {t ? (
            <div class="adj-scroll" style={{ marginTop: 8 }}>
              <table class="adj-eval">
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th class={cls(c !== t.columns[0] && "num")}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r) => (
                    <tr>
                      {t.columns.map((c, i) => (
                        <td class={cls(i > 0 && "num", "nowrap")}>{r[c] ?? "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function AdjSkeleton(): JSX.Element {
  return (
    <div class="page ds-page adj-page" aria-busy="true">
      <section class="ds-hero">
        <div class="ds-hero-main ds-skel-stack">
          <Skeleton w={140} h={12} />
          <Skeleton w="60%" h={30} />
          <Skeleton w="40%" h={14} />
        </div>
      </section>
      <div class="ds-stats">
        {[0, 1, 2, 3, 4, 5].map(() => (
          <div class="ds-stat">
            <Skeleton w={70} h={10} />
            <Skeleton w={90} h={26} />
            <Skeleton w="80%" h={10} />
          </div>
        ))}
      </div>
      <div class="ds-grid main-side">
        <Skeleton h={260} class="adj-skel-card" />
        <Skeleton h={260} class="adj-skel-card" />
      </div>
    </div>
  );
}

function DisabledIntro(): JSX.Element {
  return (
    <Card class="adj-intro ds-block" title="Adjudicator is off">
      <p>
        The adjudicator scores each request's complexity and suggests the eminiar tool, the Claude
        model size (haiku, sonnet, opus) and the swarm role that fit it, so small work goes to small
        models and large work gets the right help. It is optional and off by default.
      </p>
      <ul class="reasons">
        <li>
          <b>local by default</b>: the heuristic runs on this machine; nothing leaves it.
        </li>
        <li>
          <b>remote providers only with consent and a key</b>: text is redacted and capped
          (privacy.maxChars) before it is sent; keys live in <Code>~/.eminiar</Code>, never in
          config.
        </li>
        <li>
          <b>what is stored</b>: a hash and at most 80 redacted characters per decision
          (privacy.storeHead).
        </li>
        <li>
          <b>advise vs apply</b>: advise only suggests; apply sets the Agent model within a floor
          and ceiling.
        </li>
      </ul>
      <div class="row" style={{ marginTop: 8 }}>
        <span>Turn it on with</span>
        <Code>eminiar adjudicator enable</Code>
        <span class="muted small">
          then /mcp reconnect. This page updates without restarting the server.
        </span>
      </div>
    </Card>
  );
}

// --- the view ----------------------------------------------------------------------------

export function Adjudicator({ params }: { params: Record<string, string> }): JSX.Element {
  const range = (RANGES.find(([r]) => r === params.range)?.[0] ?? "30d") as Range;
  const id = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const [tick, setTick] = useState(0);
  const [showHow, setShowHow] = useState(false);
  const ov = useAsync(() => api<AdjOverview>("/api/adjudicator", { since: range }), [range, tick]);
  const sav = useAsync(
    () => api<AdjSavings>("/api/adjudicator/savings", { since: range }),
    [range, tick],
  );
  const go = (p: { range?: Range; id?: number | null }) =>
    navigate("adjudicator", {
      range: (p.range ?? range) === "30d" ? undefined : (p.range ?? range),
      id: p.id === undefined ? (id ? String(id) : undefined) : p.id ? String(p.id) : undefined,
    });

  if (ov.error)
    return (
      <div class="page ds-page adj-page">
        <ErrorBox error={ov.error} />
      </div>
    );
  const o = ov.data;
  if (!o) return <AdjSkeleton />;
  const s = o.summary;
  const hasData = s.total > 0;
  const statusCounts = Object.entries(s.byProviderStatus).filter(
    ([k, n]) => n && k !== "ok" && k !== "n/a",
  );
  const kpis: Array<[string, string, ComponentChildren, string?]> = [
    [
      "decisions",
      fmt(s.total),
      Object.entries(s.bySurface)
        .filter(([, n]) => n)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(" · ") || "none in range",
    ],
    [
      "advice followed",
      rate(s.rates.follow),
      [
        `apply ${rate(s.rates.apply)} · respected ${rate(s.rates.respect)}`,
        `effort ${rate(s.rates.effortFollow)}`,
        s.effortChecked && s.effortIneffective
          ? `effort set but not run ${s.effortIneffective} of ${s.effortChecked}`
          : "",
        keptModelLabel(s.keptModel),
      ]
        .filter(Boolean)
        .join(" · "),
      "followed ÷ (advised + followed + ignored), leaving out advised dispatches whose advice named no model (a kept pin, CLAUDE_CODE_SUBAGENT_MODEL_FORCE, a fork); apply = applied ÷ (applied + respected); effort = followed ÷ (followed + ignored), where followed means: when apply mode set the effort, the subagent ran at the advised level (the level set is always the advised one, so only the level that ran counts); otherwise it ran at the advised level or the effort set for the call was the advised level (the level passed, else the agent file's level), and ignored means anything else, read from the subagent's transcript as it is reconciled (a verdict can land before the row is final), leaving out forks, CLAUDE_CODE_EFFORT_LEVEL and saturated briefs, so it reads n/a until a dispatch has been reconciled; effort set but not run counts calls whose set effort (the level apply mode set, else the level passed) differs from the level that ran",
    ],
    [
      "fallback rate",
      rate(o.fallbackRate),
      statusCounts.length
        ? statusCounts.map(([k, n]) => `${k} ${n}`).join(" · ")
        : "no provider errors",
      "decisions where the provider failed or was skipped and the heuristic answered",
    ],
    [
      "provider latency",
      s.providerLatency.n ? `${ms(s.providerLatency.p50)}` : "—",
      s.providerLatency.n
        ? `p95 ${ms(s.providerLatency.p95)} · end to end p50 ${ms(s.latency.p50)}`
        : `end to end p50 ${ms(s.latency.p50)} · p95 ${ms(s.latency.p95)}`,
      "p50 of the provider round trip; end to end includes the heuristic and blending",
    ],
    [
      "adjudicator spend",
      usd(s.costUsd),
      `${o.provider.configuredRemote ? "remote provider" : "local: free"} · in range`,
    ],
    [
      "net savings",
      usd(sav.data ? sav.data.netUsd : s.netUsd),
      <>
        saved {usd(sav.data ? sav.data.realisedUsd : s.savingsUsd)} − spend {usd(s.costUsd)} ·{" "}
        <button
          type="button"
          class="adj-link"
          aria-expanded={showHow}
          onClick={() => setShowHow(!showHow)}
        >
          how is this computed?
        </button>
      </>,
    ],
  ];

  return (
    <div class="page ds-page adj-page">
      <Hero
        eyebrow={
          <>
            <span>Adjudicator</span>
            {o.enabled ? (
              <Pill tone="ok" title="the adjudicator is enabled">
                on
              </Pill>
            ) : (
              <Pill tone="muted" title="the adjudicator is disabled">
                off
              </Pill>
            )}
          </>
        }
        title={
          hasData ? (
            <>
              <GradientText>{fmt(s.total)} decisions</GradientText> in {range}
            </>
          ) : (
            "No decisions in this range"
          )
        }
        sub={
          o.enabled
            ? "Complexity, tool, model tier and role advice for each request, with the cost and savings it brings."
            : hasData
              ? "Showing decisions recorded while it was on."
              : "Turn it on to see routing advice for each request."
        }
        meta={
          <>
            {o.enabled ? (
              <>
                <Badge tone={o.mode === "apply" ? "accent" : "muted"} title="advise or apply">
                  {o.mode} mode
                </Badge>
                <Badge tone="purple" title="the provider in use">
                  {o.provider.effective}
                </Badge>
              </>
            ) : null}
            {"reconcile" in o && o.reconcile && "error" in o.reconcile ? (
              <Badge tone="warn">reconcile failed: {o.reconcile.error}</Badge>
            ) : null}
            {o.chartsCut ? <Badge tone="warn">charts drawn from the newest 20k rows</Badge> : null}
          </>
        }
        aside={
          <div class="adj-hero-actions">
            <Segmented<Range>
              label="time range"
              options={RANGES.map(([id, label]) => ({ id: id as Range, label }))}
              value={range}
              onChange={(r) => go({ range: r })}
            />
            <button
              type="button"
              class="ghost sm"
              onClick={() => setTick((t) => t + 1)}
              disabled={ov.loading}
            >
              {ov.loading ? "…" : "↻ refresh"}
            </button>
          </div>
        }
      />

      {!o.enabled ? <DisabledIntro /> : null}

      {securityActive(o) ? <SecurityPanel range={range} tick={tick} /> : null}

      {o.enabled || hasData ? (
        <>
          <StatRow>
            {kpis.map(([h, v, sub, title]) => (
              <Stat label={h} value={v} sub={sub} title={title} />
            ))}
          </StatRow>
          {showHow ? <Assumptions list={sav.data?.assumptions ?? []} /> : null}
          {jevActive(o) ? (
            <JevImpact range={range} tick={tick} ov={o} onOpen={(n) => go({ id: n })} />
          ) : null}

          <div class="ds-grid main-side">
            <Card
              title="Decisions per day"
              right={
                <span class="usage-legend">
                  {SOURCES.map((k) => (
                    <Swatch color={SOURCE_COLORS[k]} label={k} title={SOURCE_HELP[k]} />
                  ))}
                </span>
              }
            >
              {o.charts.perDay.length ? (
                <DayChart rows={o.charts.perDay} />
              ) : (
                <EmptyState compact icon="▁" title="No decisions yet">
                  {o.enabled
                    ? "They appear as you prompt and dispatch agents."
                    : "Nothing was recorded in this range."}
                </EmptyState>
              )}
              <div class="muted small">UTC days</div>
            </Card>
            <HealthCard ov={o} />
          </div>

          <div class="ds-grid cols-2">
            <Card title="Complexity" right="0 trivial → 4 very complex">
              {hasData ? (
                <ComplexityHistogram counts={o.charts.complexity} />
              ) : (
                <EmptyState compact icon="▁" title="No decisions yet" />
              )}
            </Card>
            <Card title="Suggested tier × model that ran">
              {sav.error ? (
                <ErrorBox error={sav.error} />
              ) : !sav.data ? (
                <Spinner />
              ) : (
                <MatrixHeat matrix={sav.data.matrix} kept={sav.data.keptModel} />
              )}
            </Card>
          </div>

          <CallLog ov={o} since={range} tick={tick} selected={id} onOpen={(n) => go({ id: n })} />

          <div class="ds-grid cols-2">
            {sav.error ? (
              <Card title="Savings">
                <ErrorBox error={sav.error} />
              </Card>
            ) : sav.data ? (
              <SavingsPanel s={sav.data} />
            ) : (
              <Card title="Savings">
                <Skeleton h={120} />
              </Card>
            )}
            <TryIt ov={o} />
          </div>
          <div class="ds-grid">
            <EvalCard />
          </div>
        </>
      ) : (
        <div class="ds-grid cols-2">
          <TryIt ov={o} />
          <EvalCard />
        </div>
      )}
      {id !== null ? <DecisionDrawer id={id} onClose={() => go({ id: null })} /> : null}
    </div>
  );
}
