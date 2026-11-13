import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type AdjSecurityAssessment,
  type AdjSecurityItem,
  type AdjSecurityReport,
  type AdjSecurityTryIt,
  fetchSecurity,
  fetchSecurityAssessment,
  runSecurityTryIt,
} from "../api.js";
import { ErrorBox, Spinner, Tag, useAsync } from "../components.js";
import { Card, EmptyState, Skeleton, Stat, StatRow } from "../ds.js";
import {
  LegsRow,
  ModelNote,
  RaisedMark,
  ReasonList,
  RemedyLine,
  RiskBadge,
  RulesList,
} from "../security.js";
import { ago, cls, fmt } from "../util.js";
import {
  autonomyLine,
  contributionLine,
  daySegments,
  evalFacts,
  evalTime,
  exposureGrid,
  itemHead,
  itemMeta,
  KINDS,
  LEVEL_ORDER,
  levelInfo,
  levelShares,
  matrixView,
  payloadActive,
  pct,
  ruleBars,
  ruleLabel,
  surfaceLabel,
  surfaceShares,
  tryItBody,
} from "./security-helpers.js";

type Range = "7d" | "30d" | "90d" | "all";

const when = (ts: number) =>
  new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// --- distribution ------------------------------------------------------------------------

function LevelBars({ r }: { r: AdjSecurityReport }): JSX.Element {
  const levels = levelShares(r.totals.byLevel);
  const surfaces = surfaceShares(r.totals.bySurface);
  return (
    <div class="sec-dist">
      <div class="sec-bars" role="list" aria-label="assessments by level">
        {levels.map((l) => (
          <div class="sec-bar-row" role="listitem" key={l.level}>
            <RiskBadge level={l.level} compact />
            <span class="sec-track" aria-hidden="true">
              <i
                class={`sec-fill sec-l-${l.level}`}
                style={{ width: `${Math.round(l.share * 100)}%` }}
              />
            </span>
            <span class="sec-n">
              {fmt(l.n)} <span class="muted small">{pct(l.share)}</span>
            </span>
          </div>
        ))}
      </div>
      <div class="sec-surfaces">
        <span class="muted small">by surface</span>
        {surfaces.length ? (
          surfaces.map((s) => (
            <Tag key={s.surface}>
              {surfaceLabel(s.surface)} {fmt(s.n)}
            </Tag>
          ))
        ) : (
          <span class="muted small">none</span>
        )}
      </div>
    </div>
  );
}

function DayColumns({ rows }: { rows: AdjSecurityReport["perDay"] }): JSX.Element {
  const days = daySegments(rows);
  return (
    <div class="sec-days" role="img" aria-label="assessments per day by level">
      {days.map((d) => {
        const text = LEVEL_ORDER.map(
          (l) => `${l} ${d.segs.find((s) => s.level === l)?.n ?? 0}`,
        ).join(" · ");
        return (
          <div class="sec-day" key={d.day} title={`${d.day} (UTC): ${d.total} — ${text}`}>
            <div class="sec-col">
              {[...d.segs]
                .reverse()
                .map((s) =>
                  s.n ? (
                    <i
                      key={s.level}
                      class={`sec-seg sec-l-${s.level}`}
                      style={{ height: `${Math.max(2, s.share * 100)}%` }}
                    />
                  ) : null,
                )}
            </div>
            <span class="sec-day-l">{d.day.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function RuleBars({ rules }: { rules: AdjSecurityReport["rules"] }): JSX.Element {
  const bars = ruleBars(rules);
  if (!bars.length) return <EmptyState compact icon="○" title="No rule fired in this range" />;
  return (
    <div class="sec-bars" role="list" aria-label="rules fired">
      {bars.map((b) => (
        <div class="sec-bar-row" role="listitem" key={b.id} title={b.label}>
          <span class="sec-rule">{b.id}</span>
          <span class="sec-track" aria-hidden="true">
            <i class="sec-fill sec-fill-rule" style={{ width: `${Math.round(b.share * 100)}%` }} />
          </span>
          <span class="sec-n">{fmt(b.n)}</span>
          <span class="sec-rule-label muted small">{b.label}</span>
        </div>
      ))}
    </div>
  );
}

// --- heuristic vs Jev --------------------------------------------------------------------

function ContributionMatrix({ c }: { c: AdjSecurityReport["contribution"] }): JSX.Element {
  const m = matrixView(c.matrix);
  const line = contributionLine(c);
  return (
    <>
      {m.total ? (
        <div class="adj-scroll">
          <table class="adj-matrix sec-matrix">
            <thead>
              <tr>
                <th class="corner">heuristic ↓ · final →</th>
                {LEVEL_ORDER.map((l) => (
                  <th class="num" key={l}>
                    {levelInfo(l).glyph} {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.heuristic}>
                  <th>
                    {levelInfo(r.heuristic).glyph} {r.heuristic}
                  </th>
                  {r.cells.map((cell) => {
                    const a = cell.n && m.max ? 0.08 + 0.82 * (cell.n / m.max) : 0;
                    return (
                      <td
                        key={cell.final}
                        class={cls(
                          "num cell",
                          cell.diag && "diag",
                          cell.raised && cell.n > 0 && "sec-up",
                          a > 0.55 && "strong",
                        )}
                        style={
                          a
                            ? {
                                background: `color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)`,
                              }
                            : undefined
                        }
                        title={`${cell.n} assessments: heuristic ${r.heuristic}, final ${cell.final}${
                          cell.raised && cell.n ? " (raised by the model)" : ""
                        }`}
                      >
                        {cell.n ? (
                          <>
                            {cell.raised ? <span aria-hidden="true">↑ </span> : null}
                            {cell.n}
                          </>
                        ) : (
                          ""
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState compact icon="▦" title="No assessments to compare yet" />
      )}
      <div class="sub">
        model raised {pct(c.raisedRate)} · ↑ marks cells the model raised · outlined cells are
        agreement
      </div>
      {line ? <div class="muted small sec-note">{line}</div> : null}
    </>
  );
}

// --- lists -------------------------------------------------------------------------------

function ItemList({
  items,
  empty,
  onOpen,
}: {
  items: AdjSecurityItem[];
  empty: string;
  onOpen: (id: number) => void;
}): JSX.Element {
  if (!items.length) return <EmptyState compact icon="○" title={empty} />;
  // The server's order (level, then score) is kept: never re-sorted by score here.
  return (
    <ul class="sec-list">
      {items.map((i) => (
        <li key={i.id}>
          <button
            type="button"
            class="sec-item"
            onClick={() => onOpen(i.id)}
            aria-label={`open assessment ${i.id}: ${i.level} risk`}
          >
            <span class="sec-row">
              <RiskBadge level={i.level} score={i.score} />
              <LegsRow legs={i.legs} />
              <RulesList rules={i.rules} max={4} />
              <RaisedMark raised={i.raised} />
              <span class="spacer" />
              <span class="muted small" title={new Date(i.ts).toISOString()}>
                {ago(i.ts)}
              </span>
            </span>
            <span class="sec-meta muted small">{itemMeta(i)}</span>
            <span class="sec-head">{itemHead(i.head)}</span>
            {i.reasons.length ? <ReasonList reasons={i.reasons} max={2} /> : null}
            <RemedyLine remedy={i.remedy} />
          </button>
        </li>
      ))}
    </ul>
  );
}

// --- the drawer --------------------------------------------------------------------------

function AssessmentBody({ a }: { a: AdjSecurityAssessment }): JSX.Element {
  const v = a.view;
  const d = v.detail;
  const grid = exposureGrid(d.exposures);
  return (
    <>
      <section>
        <h4 class="adj-h">verdict</h4>
        <div class="sec-row">
          <RiskBadge level={v.level} score={v.score} />
          <LegsRow legs={d.badge.legs} />
          <RaisedMark raised={!!d.model?.raised} />
        </div>
        <div class="muted small sec-note">
          heuristic <RiskBadge level={v.heuristicLevel} score={v.heuristicScore} compact /> · action{" "}
          {v.action} · {autonomyLine(d.a, v.autonomy)} · source {v.source}
        </div>
        <ReasonList reasons={d.badge.reasons} />
        <RemedyLine remedy={d.remedy?.line ?? d.badge.remedy} />
      </section>
      <section>
        <h4 class="adj-h">legs by source</h4>
        {grid.length ? (
          <div class="adj-scroll">
            <table class="sec-table">
              <thead>
                <tr>
                  <th>leg</th>
                  {KINDS.map((k) => (
                    <th class="num" key={k}>
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((r) => (
                  <tr key={r.cap}>
                    <th title={r.name}>
                      {r.cap} <span class="muted small">{r.name}</span>
                    </th>
                    {r.cells.map((c) => (
                      <td
                        class={cls("num", c.e === r.max && c.e > 0 && "sec-max")}
                        key={c.kind}
                        title={c.from ?? ""}
                      >
                        {c.e ? Math.round(c.e * 100) : "·"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="muted small">no exposure recorded</div>
        )}
        <div class="muted small sec-note">
          task = the text · grant = the tools it holds · latent = what a granted tool implies ·
          taint = what the session already read
        </div>
      </section>
      <section>
        <h4 class="adj-h">rules and floors</h4>
        {d.rules.length || d.floors.length ? (
          <ul class="sec-rulelist">
            {d.rules.map((r) => (
              <li key={r.id}>
                <span class="sec-rule" title={ruleLabel(r.id)}>
                  {r.id}
                </span>{" "}
                {ruleLabel(r.id)}
                <span class="muted small">
                  {" "}
                  · {r.factors.map((f) => `${f.cap} ${Math.round(f.e * 100)}`).join(" + ")} · adds{" "}
                  {Math.round(r.add)}
                </span>
              </li>
            ))}
            {d.floors.map((f) => (
              <li key={f}>
                <span class="sec-rule floor" title={ruleLabel(f)}>
                  {f}
                </span>{" "}
                {ruleLabel(f)}
              </li>
            ))}
          </ul>
        ) : (
          <div class="muted small">none fired</div>
        )}
        {d.cues.length || d.intent.length ? (
          <div class="sec-chips">
            {d.cues.map((c) => (
              <Tag key={c}>{c}</Tag>
            ))}
            {d.intent.map((c) => (
              <Tag key={c}>{c}</Tag>
            ))}
          </div>
        ) : null}
      </section>
      <section>
        <h4 class="adj-h">tool grant</h4>
        <div class="muted small">
          {d.grant.status}
          {d.grant.source ? ` · ${d.grant.source}` : ""}
          {d.grant.permissionMode ? ` · ${d.grant.permissionMode}` : ""}
          {d.grant.mcpServers ? " · names MCP servers (their tools are not listed)" : ""}
        </div>
        {d.grant.tools.length ? (
          <div class="sec-chips">
            {d.grant.tools.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </div>
        ) : null}
        {d.taint ? (
          <div class="muted small sec-note">
            session taint {d.taint.status}
            {d.taint.tools.length ? `: ${d.taint.tools.join(", ")}` : ""}
          </div>
        ) : null}
      </section>
      {d.model ? (
        <section>
          <h4 class="adj-h">model answer</h4>
          <div class="sec-row">
            <RiskBadge level={d.model.level} score={d.model.score} compact />
            <span class="muted small">
              {d.model.raised ? "raised the level" : "did not raise the level"}
              {d.model.answer.severity
                ? ` · severity ${d.model.answer.severity.value}/4 (confidence ${pct(d.model.answer.severity.confidence)})`
                : ""}
            </span>
          </div>
          <div class="sec-chips">
            {Object.entries(d.model.answer.threats).map(([k, p]) => (
              <Tag key={k}>
                {k.replace(/_/g, " ")} {pct(p)}
              </Tag>
            ))}
          </div>
        </section>
      ) : (
        <section>
          <h4 class="adj-h">model answer</h4>
          <div class="muted small">no model answer ({v.modelStatus})</div>
        </section>
      )}
      <section>
        <h4 class="adj-h">as the hook printed it</h4>
        <pre class="adj-head sec-pre">{a.text}</pre>
        <div class="muted small sec-note">
          {a.assessment.head ? `text: ${itemHead(a.assessment.head)} · ` : ""}
          {a.assessment.noted ? "noted to the session" : "not shown to the session"} · version{" "}
          {a.assessment.version}
        </div>
      </section>
    </>
  );
}

function AssessmentDrawer({ id, onClose }: { id: number; onClose: () => void }): JSX.Element {
  const d = useAsync(() => fetchSecurityAssessment(id), [id]);
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
  const a = d.data && payloadActive(d.data) ? (d.data as AdjSecurityAssessment) : null;
  return (
    <>
      <div class="adj-backdrop" onClick={onClose} />
      <aside
        class="adj-drawer"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`security assessment ${id}`}
      >
        <div class="adj-drawer-head">
          <b>security assessment #{id}</b>
          {a ? (
            <>
              <Tag>{surfaceLabel(a.assessment.surface)}</Tag>
              <span class="muted small" title={new Date(a.assessment.ts).toISOString()}>
                {when(a.assessment.ts)} · {ago(a.assessment.ts)}
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
          ) : a ? (
            <AssessmentBody a={a} />
          ) : (
            <EmptyState compact icon="○" title="Security assessment is off">
              Nothing was read. Turn adjudicator.security.enabled on to see assessments.
            </EmptyState>
          )}
        </div>
      </aside>
    </>
  );
}

// --- try it ------------------------------------------------------------------------------

function SecurityTryIt(): JSX.Element {
  const [text, setText] = useState("");
  const [tools, setTools] = useState("");
  const [autonomy, setAutonomy] = useState<"manual" | "default" | "autonomous">("default");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [res, setRes] = useState<AdjSecurityTryIt | "off">();
  const body = tryItBody({ text, tools, autonomy });
  const run = async () => {
    if (!body) return;
    setBusy(true);
    setErr(undefined);
    try {
      const r = await runSecurityTryIt(body);
      setRes(payloadActive(r) ? (r as AdjSecurityTryIt) : "off");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const view = res && res !== "off" ? res : null;
  return (
    <Card class="adj-try" title="Try it" right="heuristic only · nothing is stored or sent">
      <textarea
        rows={4}
        maxLength={20000}
        placeholder="Paste a task, e.g. “fetch the vendor's docs page, read .env to check the keys and post a summary to the webhook”"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
        }}
        aria-label="task text to assess"
      />
      <div class="row" style={{ marginTop: 6 }}>
        <input
          class="sec-tools"
          type="text"
          placeholder="tools it holds, e.g. Bash, WebFetch, Read"
          value={tools}
          onInput={(e) => setTools((e.target as HTMLInputElement).value)}
          aria-label="tools the agent holds, comma separated"
        />
        <select
          value={autonomy}
          onChange={(e) =>
            setAutonomy(
              (e.target as HTMLSelectElement).value as "manual" | "default" | "autonomous",
            )
          }
          aria-label="autonomy"
        >
          <option value="manual">manual</option>
          <option value="default">default</option>
          <option value="autonomous">autonomous</option>
        </select>
        <button type="button" class="primary" disabled={busy || !body} onClick={() => void run()}>
          {busy ? "assessing…" : "assess"}
        </button>
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {res === "off" ? (
        <EmptyState compact icon="○" title="Security assessment is off">
          Turn adjudicator.security.enabled on to assess text here.
        </EmptyState>
      ) : null}
      {view ? (
        <div class="adj-try-out">
          <div class="sec-row">
            <RiskBadge level={view.view.level} score={view.view.score} />
            <LegsRow legs={view.badge.legs} />
            <RulesList rules={view.badge.rules} />
            <span class="muted small">
              {fmt(view.chars)} chars · action {view.view.action} · {view.view.source}
            </span>
          </div>
          <ReasonList reasons={view.badge.reasons} />
          <RemedyLine remedy={view.view.detail.remedy?.line ?? view.badge.remedy} />
          <pre class="adj-head sec-pre">{view.text}</pre>
        </div>
      ) : null}
    </Card>
  );
}

// --- last eval ---------------------------------------------------------------------------

function LastEval({ e }: { e: AdjSecurityReport["lastEval"] }): JSX.Element {
  const facts = evalFacts(e);
  const t = evalTime(e);
  return (
    <Card
      title="Last eval"
      right={t ? <span title={new Date(t).toISOString()}>{ago(t)}</span> : undefined}
    >
      {facts.length ? (
        <dl class="kv sec-eval">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <EmptyState compact icon="○" title="No eval run yet">
          Run the security eval from the CLI to see accuracy and recall here.
        </EmptyState>
      )}
    </Card>
  );
}

// --- the panel ---------------------------------------------------------------------------

/**
 * Mount only when securityActive(overview). It makes no request of its own until it is mounted,
 * and renders nothing when the API answers {active:false}.
 */
export function SecurityPanel({ range, tick }: { range: Range; tick: number }): JSX.Element | null {
  const r = useAsync(() => fetchSecurity(range), [range, tick]);
  const [open, setOpen] = useState<number | null>(null);

  if (r.error)
    return (
      <Card title="Security">
        <ErrorBox error={r.error} />
      </Card>
    );
  if (!r.data) {
    return (
      <Card title="Security">
        <Skeleton h={140} />
      </Card>
    );
  }
  if (!payloadActive(r.data)) return null;
  const s = r.data as AdjSecurityReport;
  const t = s.totals;
  const hasData = t.n > 0;
  const high = t.byLevel.high || 0;
  const crit = t.byLevel.critical || 0;
  const answered =
    s.contribution.modelRaised + s.contribution.modelLower + s.contribution.modelAgreed;

  return (
    <section class="sec-panel" aria-label="security">
      <h3 class="sec-title">
        Security{" "}
        <span class="muted small">risk of the tools, the task and the data it can reach</span>
      </h3>
      <StatRow>
        <Stat
          label="assessments"
          value={fmt(t.n)}
          sub={
            surfaceShares(t.bySurface)
              .map((x) => `${surfaceLabel(x.surface)} ${x.n}`)
              .join(" · ") || "none in range"
          }
        />
        <Stat
          label="high"
          value={fmt(high)}
          tone={high ? "warn" : undefined}
          sub={`${levelInfo("high").glyph} complete risky combination`}
        />
        <Stat
          label="critical"
          value={fmt(crit)}
          tone={crit ? "bad" : undefined}
          sub={`${levelInfo("critical").glyph} fixed critical triggers`}
        />
        <Stat
          label="model raised"
          value={answered ? pct(s.contribution.raisedRate) : "—"}
          sub={
            answered ? `${s.contribution.modelRaised} of ${answered} answers` : "no model answers"
          }
          title="share of model answers that raised the level above the heuristic's"
        />
        <Stat
          label="model"
          value={<ModelNote model={s.model} />}
          sub={`${s.model.answered} answered`}
        />
      </StatRow>

      {!hasData ? (
        <Card title="Risk">
          <EmptyState icon="○" title="No assessments in this range yet">
            They are recorded as agents are dispatched and prompts are sent. The heuristic runs
            locally; nothing needs a provider.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div class="ds-grid cols-2">
            <Card title="Risk by level" right="all assessments in range">
              <LevelBars r={s} />
            </Card>
            <Card title="Per day" right="UTC days · low at the bottom">
              {s.perDay.length ? (
                <DayColumns rows={s.perDay} />
              ) : (
                <EmptyState compact icon="▁" title="No days yet" />
              )}
            </Card>
          </div>
          <div class="ds-grid cols-2">
            <Card title="Rules fired" right="hover for what each one means">
              <RuleBars rules={s.rules} />
            </Card>
            <Card title="Heuristic vs Jev" right="the model can only raise a level">
              <ContributionMatrix c={s.contribution} />
            </Card>
          </div>
          <div class="ds-grid cols-2">
            <Card title="Recent high and critical" right="newest first">
              <ItemList
                items={s.recent}
                empty="Nothing high or critical in this range"
                onOpen={setOpen}
              />
            </Card>
            <Card title="Worst" right="by level, then score">
              <ItemList
                items={s.worst}
                empty="Nothing high or critical in this range"
                onOpen={setOpen}
              />
            </Card>
          </div>
        </>
      )}
      <div class="ds-grid cols-2">
        <LastEval e={s.lastEval} />
        <SecurityTryIt />
      </div>
      {open !== null ? <AssessmentDrawer id={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}
