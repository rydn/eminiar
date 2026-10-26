import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api.js";
import { Empty, ErrorBox, Spinner, Tag, useAsync } from "../components.js";
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
      <div class="page">
        <ErrorBox error={sessions.error} />
      </div>
    );
  return (
    <div class="page">
      <div
        class="grid wide"
        style={{ gridTemplateColumns: "minmax(280px,1fr) minmax(0,2fr)", alignItems: "start" }}
      >
        <div class="card flush">
          <div class="list">
            {!sessions.data ? (
              <Empty>
                <Spinner />
              </Empty>
            ) : sessions.data.length ? (
              sessions.data.map((s) => (
                <div class={cls("item", sel === s.id && "sel")} onClick={() => setSel(s.id)}>
                  <div class="n">
                    <code>{s.id.slice(0, 8)}</code> {s.current ? <Tag>current</Tag> : null}{" "}
                    <a class="small" href={`#/usage?session=${s.id}`}>
                      usage →
                    </a>
                    <span class="muted" style={{ float: "right", fontWeight: 400 }}>
                      {ago(s.started_at)}
                    </span>
                  </div>
                  <div class="p">{(s.last_prompt ?? "(no prompt yet)").slice(0, 100)}</div>
                  <div class="p">
                    {s.calls} calls · {fmt(s.savedTokens)} saved · {pct(s.efficiency)}
                    {s.source ? ` · ${s.source}` : ""}
                  </div>
                </div>
              ))
            ) : (
              <Empty>no sessions yet</Empty>
            )}
          </div>
        </div>
        <div class="card">
          <h3>
            events · {sel ? sel.slice(0, 8) : "all"} · {events.data?.length ?? 0}
          </h3>
          <div class="row" style={{ marginBottom: 8 }}>
            <select value={cat} onChange={(e) => setCat((e.target as HTMLSelectElement).value)}>
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
          </div>
          {events.error ? (
            <ErrorBox error={events.error} />
          ) : (
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
                {(events.data ?? []).length ? (
                  (events.data ?? []).map((e) => (
                    <tr>
                      <td class="muted nowrap" title={new Date(e.ts).toLocaleString()}>
                        {time(e.ts)}
                      </td>
                      <td class="nowrap">
                        <Tag>P{e.priority}</Tag>
                        {e.category}
                      </td>
                      <td>{e.tool ?? ""}</td>
                      <td>
                        <pre class="json">{JSON.stringify(e.payload).slice(0, 400)}</pre>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} class="muted">
                      no events
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
