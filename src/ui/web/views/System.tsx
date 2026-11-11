import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { api, type IndexRun, post } from "../api.js";
import { ErrorBox, KV, Spinner, toast, useAsync } from "../components.js";
import { Badge, Card, EmptyState, Hero, Segmented, Skeleton } from "../ds.js";
import { ago, cls } from "../util.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function Doctor(): JSX.Element {
  const [fix, setFix] = useState(false);
  const q = useAsync(
    () => (fix ? post<Check[]>("/api/doctor", { fix: true }) : api<Check[]>("/api/doctor")),
    [fix],
  );
  const bad = (q.data ?? []).filter((c) => !c.ok).length;
  return (
    <>
      <div class="sy-bar">
        <button type="button" class="primary" onClick={() => q.reload()}>
          Re-run
        </button>
        <button
          type="button"
          onClick={() => {
            setFix(true);
            q.reload();
          }}
        >
          Run with --fix
        </button>
        {q.loading ? (
          <Spinner />
        ) : q.data ? (
          bad ? (
            <Badge tone="bad" dot>
              {bad} problem{bad > 1 ? "s" : ""}
            </Badge>
          ) : (
            <Badge tone="ok" dot>
              all checks pass
            </Badge>
          )
        ) : null}
      </div>
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data ? (
        <Card>
          <Skeleton h={14} />
        </Card>
      ) : (
        <Card flush title="Checks" right={`${q.data.length - bad}/${q.data.length} pass`}>
          <div class="ds-table-wrap">
            <table>
              <tbody>
                {q.data.map((c) => (
                  <tr>
                    <td class={cls(c.ok ? "ok" : "bad")} style={{ width: 24 }}>
                      {c.ok ? "✓" : "✗"}
                    </td>
                    <td class="nowrap">{c.name}</td>
                    <td class="break">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function Actions({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [scope, setScope] = useState("all");
  const [full, setFull] = useState(false);
  const [path, setPath] = useState("");
  const [glob, setGlob] = useState("");
  const [pscope, setPscope] = useState("index");
  const [pconfirm, setPconfirm] = useState("");
  const stats = useAsync(
    () =>
      api<{
        project: string;
        dbPath: string;
        memoriesDir: string;
        routing: string;
        index: { embeddings: string };
      }>("/api/stats"),
    [],
  );
  const run = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    const ts = new Date().toLocaleTimeString();
    setLog((l) => [...l, `[${ts}] ${label} …`]);
    try {
      const r = await post<{ ok: boolean; output: string; ms: number }>("/api/actions", body);
      setLog((l) => [...l, `${r.ok ? "✓" : "✗"} ${label} (${r.ms} ms)\n${r.output}`]);
      if (!r.ok) toast(r.output.split("\n")[0] ?? "failed", true);
      else toast(`${label} done`);
      onChanged();
    } catch (e) {
      setLog((l) => [...l, `✗ ${label} failed: ${(e as Error).message}`]);
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const B = ({
    label,
    body,
    cls: c,
  }: {
    label: string;
    body: Record<string, unknown>;
    cls?: string;
  }) => (
    <button type="button" class={c ?? "primary"} disabled={!!busy} onClick={() => run(label, body)}>
      {busy === label ? <Spinner /> : label}
    </button>
  );
  return (
    <>
      <div class="sy-actions">
        <Card title="Reindex">
          <p class="sy-desc">
            Rebuild the code graph, git signals, metrics, docs, memories or embeddings. Incremental
            unless full.
          </p>
          <div class="row">
            <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
              {["all", "code", "git", "metrics", "docs", "memories", "embeddings"].map((s) => (
                <option value={s}>{s}</option>
              ))}
            </select>
            <label class="small">
              <input
                type="checkbox"
                checked={full}
                onChange={(e) => setFull((e.target as HTMLInputElement).checked)}
              />{" "}
              full
            </label>
            <B label={`reindex ${scope}`} body={{ action: "reindex", scope, full }} />
          </div>
        </Card>
        <Card title="Index a path">
          <p class="sy-desc">
            Index files or a directory into search (markdown by default; pass globs for other
            files).
          </p>
          <div class="row sy-index">
            <input
              type="text"
              class="sy-index-path"
              placeholder="docs/ or README.md"
              value={path}
              onInput={(e) => setPath((e.target as HTMLInputElement).value)}
            />
            <input
              type="text"
              class="sy-index-globs"
              placeholder="globs, comma separated"
              value={glob}
              onInput={(e) => setGlob((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              class="primary"
              disabled={!!busy || !path.trim()}
              onClick={() => run("index", { action: "index", path, glob })}
            >
              Index
            </button>
          </div>
        </Card>
        <Card title="Embeddings">
          <p class="sy-desc">
            Embed every chunk that still has no vector. Loads the model on first use.{" "}
            {stats.data ? <span class="muted">({stats.data.index.embeddings})</span> : null}
          </p>
          <div class="row">
            <B label="embed pending" body={{ action: "embed" }} />
          </div>
        </Card>
        <Card title="Memories">
          <p class="sy-desc">
            Re-import memory files edited, added or removed by hand under{" "}
            <code>{stats.data?.memoriesDir ?? ".eminiar/memories"}</code>.
          </p>
          <div class="row">
            <B label="reconcile" body={{ action: "reconcile" }} />
          </div>
        </Card>
        <Card title="Purge">
          <p class="sy-desc">
            Permanently delete project data. Memory files stay on disk and are re-imported.
          </p>
          <div class="row">
            <select
              value={pscope}
              onChange={(e) => setPscope((e.target as HTMLSelectElement).value)}
            >
              {["index", "sessions", "graph", "memories", "all"].map((s) => (
                <option value={s}>{s}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder='type "purge" to confirm'
              style={{ maxWidth: 180 }}
              value={pconfirm}
              onInput={(e) => setPconfirm((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              class="danger"
              disabled={!!busy || pconfirm.trim() !== "purge"}
              onClick={() => {
                setPconfirm("");
                run(`purge ${pscope}`, { action: "purge", scope: pscope, confirm: true });
              }}
            >
              Purge
            </button>
            <B label="empty fetch cache" body={{ action: "purge-fetch-cache" }} cls="" />
          </div>
        </Card>
        <Card title="Server">
          {stats.data ? (
            <KV
              rows={[
                ["project", stats.data.project],
                ["database", stats.data.dbPath],
                ["routing", stats.data.routing],
              ]}
            />
          ) : (
            <Spinner />
          )}
        </Card>
      </div>
      <Card
        title="Action log"
        right={
          <button type="button" class="sm" onClick={() => setLog([])}>
            clear
          </button>
        }
      >
        <pre class="log">{log.length ? log.join("\n\n") : "ready."}</pre>
      </Card>
    </>
  );
}

function Runs(): JSX.Element {
  const q = useAsync(() => api<IndexRun[]>("/api/runs"), []);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Spinner />;
  return (
    <Card flush title="Index runs" right={q.data.length}>
      <div class="ds-table-wrap">
        <table>
          <thead>
            <tr>
              <th>started</th>
              <th>scope</th>
              <th class="num">scanned</th>
              <th class="num">indexed</th>
              <th class="num">unchanged</th>
              <th class="num">skipped</th>
              <th class="num">removed</th>
              <th class="num">errors</th>
              <th class="num">ms</th>
              <th>git</th>
              <th>detail</th>
            </tr>
          </thead>
          <tbody>
            {q.data.length ? (
              q.data.map((r) => (
                <tr>
                  <td class="muted nowrap" title={new Date(r.started_at).toLocaleString()}>
                    {ago(r.started_at)}
                  </td>
                  <td>{r.scope}</td>
                  <td class="num">{r.scanned}</td>
                  <td class="num">{r.indexed}</td>
                  <td class="num">{r.unchanged}</td>
                  <td class="num">{r.skipped}</td>
                  <td class="num">{r.removed}</td>
                  <td class={cls("num", r.errors > 0 && "bad")}>{r.errors}</td>
                  <td class="num">{r.finished_at ? r.finished_at - r.started_at : "…"}</td>
                  <td class="muted small">{r.head_sha?.slice(0, 7) ?? ""}</td>
                  <td class="muted small break">{r.detail ?? ""}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={11}>
                  <EmptyState compact icon="○" title="No runs logged yet" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const TAB_SUB = {
  actions: "Rebuild indexes, embed, reconcile memories and purge project data.",
  doctor: "Check that eminiar's runtime dependencies and storage are healthy.",
  runs: "Every indexing pass, newest first.",
} as const;

export function System({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [tab, setTab] = useState<"actions" | "doctor" | "runs">("actions");
  return (
    <div class="page ds-page">
      <Hero
        eyebrow="System"
        title="Maintenance"
        sub={TAB_SUB[tab]}
        aside={
          <Segmented<"actions" | "doctor" | "runs">
            label="system section"
            options={[
              { id: "actions", label: "Actions" },
              { id: "doctor", label: "Doctor" },
              { id: "runs", label: "Index runs" },
            ]}
            value={tab}
            onChange={setTab}
          />
        }
      />
      {tab === "actions" && <Actions onChanged={onChanged} />}
      {tab === "doctor" && <Doctor />}
      {tab === "runs" && <Runs />}
    </div>
  );
}
