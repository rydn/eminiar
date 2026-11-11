import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.js";
import { ErrorBox, useAsync } from "../components.js";
import { Badge, Card, EmptyState, Hero, Skeleton } from "../ds.js";
import { ago, cls, fmt, pct, time } from "../util.js";

interface Session {
  id: string;
  current: boolean;
  started_at: number | null;
  ended_at: number | null;
  source: string | null;
  last_prompt: string | null;
  calls: number;
  savedTokens: number;
  efficiency: number;
}
interface Event {
  id: number;
  ts: number;
  session: string;
  category: string;
  priority: number;
  tool: string | null;
  payload: unknown;
}

export function Sessions(): JSX.Element {
  const sessions = useAsync(() => api<Session[]>("/api/sessions", { limit: 60 }), []);
  const [sel, setSel] = useState<string | null>(null);
  const [cat, setCat] = useState("");
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    if (!sel && sessions.data?.[0]) setSel(sessions.data[0].id);
  }, [sessions.data]);
  const events = useAsync(
    () =>
      sel
        ? api<Event[]>("/api/events", { session: sel, category: cat || undefined, limit })
        : Promise.resolve([] as Event[]),
    [sel, cat, limit],
  );
  const cats = [...new Set((events.data ?? []).map((e) => e.category))].sort();
  if (sessions.error)
    return (
      <div class="page ds-page">
        <ErrorBox error={sessions.error} />
      </div>
    );
  const list = sessions.data;
  const current = list?.find((x) => x.current);
  return (
    <div class="page ds-page">
      <Hero
        eyebrow="Sessions"
        title={list ? `${list.length} recent session${list.length === 1 ? "" : "s"}` : "Sessions"}
        sub="Pick a session to read the events eminiar recorded for it."
        meta={
          current ? (
            <Badge tone="ok" dot>
              current {current.id.slice(0, 8)}
            </Badge>
          ) : null
        }
      />
      <div class="ds-grid ss-split">
        <Card flush title="Sessions" right={list?.length ?? 0}>
          <div class="ss-list">
            {!list ? (
              <div class="ss-skel">
                <Skeleton h={14} />
                <Skeleton w="70%" h={12} />
                <Skeleton h={14} />
              </div>
            ) : list.length ? (
              list.map((s) => (
                <div
                  class={cls("ss-item", sel === s.id && "sel")}
                  role="button"
                  tabIndex={0}
                  aria-pressed={sel === s.id}
                  onClick={() => setSel(s.id)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      setSel(s.id);
                    }
                  }}
                >
                  <div class="ss-item-head">
                    <code>{s.id.slice(0, 8)}</code>
                    {s.current ? (
                      <Badge tone="ok" dot>
                        current
                      </Badge>
                    ) : null}
                    <a class="small" href={`#/usage?session=${s.id}`}>
                      usage →
                    </a>
                    <span class="muted small ss-ago">{ago(s.started_at)}</span>
                  </div>
                  <div class="ss-prompt">{(s.last_prompt ?? "(no prompt yet)").slice(0, 100)}</div>
                  <div class="muted small">
                    {s.calls} calls · ≈{fmt(s.savedTokens)} saved (estimated) · {pct(s.efficiency)}
                    {s.source ? ` · ${s.source}` : ""}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState compact icon="○" title="No sessions yet" />
            )}
          </div>
        </Card>
        <Card
          flush
          title={`Events · ${sel ? sel.slice(0, 8) : "all"}`}
          right={
            <span class="ss-filters">
              <select
                aria-label="category"
                value={cat}
                onChange={(e) => setCat((e.target as HTMLSelectElement).value)}
              >
                <option value="">all categories</option>
                {cats.map((c) => (
                  <option value={c}>{c}</option>
                ))}
              </select>
              <label class="muted small">
                limit{" "}
                <select
                  value={String(limit)}
                  onChange={(e) => setLimit(Number((e.target as HTMLSelectElement).value))}
                >
                  {[100, 300, 1000].map((n) => (
                    <option value={String(n)}>{n}</option>
                  ))}
                </select>
              </label>
              <span class="muted small">{events.data?.length ?? 0} shown</span>
            </span>
          }
        >
          {events.error ? (
            <div class="ss-pad">
              <ErrorBox error={events.error} />
            </div>
          ) : (events.data ?? []).length ? (
            <div class="ds-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>time</th>
                    <th>category</th>
                    <th>tool</th>
                    <th>payload</th>
                  </tr>
                </thead>
                <tbody>
                  {(events.data ?? []).map((e) => (
                    <tr>
                      <td class="muted nowrap" title={new Date(e.ts).toLocaleString()}>
                        {time(e.ts)}
                      </td>
                      <td class="nowrap">
                        <Badge>P{e.priority}</Badge> {e.category}
                      </td>
                      <td>{e.tool ?? ""}</td>
                      <td>
                        <pre class="json">{JSON.stringify(e.payload).slice(0, 400)}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : events.loading ? (
            <div class="ss-skel">
              <Skeleton h={14} />
              <Skeleton w="80%" h={14} />
            </div>
          ) : (
            <EmptyState compact icon="○" title="No events" />
          )}
        </Card>
      </div>
    </div>
  );
}
