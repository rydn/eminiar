import type { JSX } from "preact";
import { useCallback, useEffect, useId, useRef, useState } from "preact/hooks";
import { ErrorBox, Spinner, toast, useAsync } from "../components.js";
import { Badge, Card, EmptyState, Hero, Segmented, type Tone } from "../ds.js";
import {
  fillPrompt,
  type PlaybookDraft,
  type PlaybookRunUi,
  type PlaybookScanResult,
  type PlaybookSuggestionUi,
  type PlaybookUi,
  playbooksApi,
} from "../playbooks-client.js";
import { playbookTab, type PlaybookTab as Tab } from "../route.js";
import { navigate, setLeaveGuard } from "../router.js";
import { ago } from "../util.js";

const LEAVE_MSG = "Discard the unsaved playbook?";

const STATUS_TONES: Record<string, Tone> = {
  started: "accent",
  done: "ok",
  failed: "bad",
  skipped: "muted",
};

const wrap = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" } as const;
const pre = {
  whiteSpace: "pre-wrap",
  background: "var(--code)",
  borderRadius: 6,
  padding: "8px 10px",
  margin: "6px 0",
  fontFamily: "var(--mono)",
  fontSize: 12,
  overflowWrap: "anywhere",
} as const;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** `name` or `name=default`, one per line, to parameters. */
function parseParamLines(text: string): PlaybookDraft["params"] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? { name: l } : { name: l.slice(0, i).trim(), default: l.slice(i + 1) };
    });
}

const paramLines = (p: PlaybookUi["params"]): string =>
  p.map((x) => (x.default === undefined ? x.name : `${x.name}=${x.default}`)).join("\n");

interface Form {
  /** The playbook being edited; undefined for a new one. */
  name: string | undefined;
  title: string;
  prompt: string;
  params: string;
  schedule: string;
  tags: string;
  private: boolean;
}

const emptyForm = (): Form => ({
  name: undefined,
  title: "",
  prompt: "",
  params: "",
  schedule: "",
  tags: "",
  private: false,
});

const formOf = (p: PlaybookUi): Form => ({
  name: p.name,
  title: p.title,
  prompt: p.prompt,
  params: paramLines(p.params),
  schedule: p.schedule ?? "",
  tags: p.tags.join(", "),
  private: p.private,
});

function PlaybookForm({
  initial,
  onDone,
  onCancel,
  onDirty,
}: {
  initial: Form;
  onDone: () => void;
  onCancel: () => void;
  /** Told whenever the form differs from what it opened with (the leave guard reads it). */
  onDirty: (dirty: boolean) => void;
}): JSX.Element {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const first = useRef<HTMLInputElement>(null);
  // Opening the form puts the cursor in its first field.
  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    onDirty(JSON.stringify(f) !== JSON.stringify(initial));
  }, [f, initial, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const editing = initial.name !== undefined;
  const save = async () => {
    setBusy(true);
    try {
      const r = await playbooksApi.save({
        name: f.name,
        title: f.title,
        prompt: f.prompt,
        params: parseParamLines(f.params),
        schedule: f.schedule.trim() || undefined,
        tags: f.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        private: f.private,
        replace: editing,
      });
      toast(`${r.created ? "added" : "saved"} ${r.name}`);
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={editing ? `Edit ${f.name}` : "New playbook"}>
      <div class="field">
        <label for={`${uid}-title`}>title</label>
        <input
          id={`${uid}-title`}
          ref={first}
          type="text"
          placeholder="Review open PRs"
          value={f.title}
          onInput={(e) => set("title", (e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="field">
        <label for={`${uid}-prompt`}>prompt — use {"{{param}}"} for parameters</label>
        <textarea
          id={`${uid}-prompt`}
          rows={7}
          value={f.prompt}
          placeholder="Check Slack for PRs that need review and review each one."
          onInput={(e) => set("prompt", (e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div
        class="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}
      >
        <div class="field">
          <label for={`${uid}-params`}>parameters — one per line: name or name=default</label>
          <textarea
            id={`${uid}-params`}
            rows={3}
            value={f.params}
            onInput={(e) => set("params", (e.target as HTMLTextAreaElement).value)}
          />
        </div>
        <div class="field">
          <label for={`${uid}-schedule`}>
            schedule hint (a note for people; nothing is scheduled)
          </label>
          <input
            id={`${uid}-schedule`}
            type="text"
            placeholder="every weekday 9am"
            value={f.schedule}
            onInput={(e) => set("schedule", (e.target as HTMLInputElement).value)}
          />
          <label for={`${uid}-tags`}>tags (comma separated)</label>
          <input
            id={`${uid}-tags`}
            type="text"
            value={f.tags}
            onInput={(e) => set("tags", (e.target as HTMLInputElement).value)}
          />
        </div>
      </div>
      <label class="small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={f.private}
          onChange={(e) => set("private", (e.target as HTMLInputElement).checked)}
        />
        private (kept in a git-ignored folder)
      </label>
      <div class="row" style={{ marginTop: 8, gap: 8 }}>
        <button
          type="button"
          class="primary"
          disabled={busy || !f.title.trim() || !f.prompt.trim()}
          onClick={save}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

function PlaybookCard({
  p,
  adding,
  onEdit,
  onChanged,
}: {
  p: PlaybookUi;
  adding: boolean;
  onEdit: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const [vals, setVals] = useState<Record<string, string>>({});
  const text = fillPrompt(p.prompt, p.params, vals);
  const copy = async () => {
    const copied = await copyText(text);
    toast(copied ? "prompt copied: paste it into Claude" : "copy failed: select the text", !copied);
    // record the use; eminiar never runs a playbook itself
    playbooksApi.recordRun(p.name).then(onChanged, () => undefined);
  };
  const remove = async () => {
    if (!confirm(`Delete playbook "${p.name}"? Its file is removed.`)) return;
    try {
      await playbooksApi.remove(p.name);
      toast(`deleted ${p.name}`);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Card
      title={p.title}
      sub={<span class="mono small">{p.name}</span>}
      right={
        <span style={wrap}>
          {p.private && <Badge tone="warn">private</Badge>}
          {p.source === "suggested" && <Badge tone="purple">suggested</Badge>}
          {p.schedule && <Badge tone="accent">{p.schedule}</Badge>}
        </span>
      }
    >
      <div style={wrap}>
        {p.tags.map((t) => (
          <Badge tone="muted">{t}</Badge>
        ))}
        <span class="muted small">
          {p.runs
            ? `${p.runs} use${p.runs === 1 ? "" : "s"}, last ${ago(p.lastRun)}`
            : "never used"}
          {" · updated "}
          {ago(p.updated)}
        </span>
      </div>
      {open && (
        <>
          {p.params.length > 0 && (
            <div
              class="grid"
              style={{
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 8,
                marginTop: 8,
              }}
            >
              {p.params.map((x) => (
                <div class="field">
                  <label for={`${uid}-${x.name}`}>{x.name}</label>
                  <input
                    id={`${uid}-${x.name}`}
                    type="text"
                    placeholder={x.default ?? ""}
                    value={vals[x.name] ?? ""}
                    onInput={(e) =>
                      setVals({ ...vals, [x.name]: (e.target as HTMLInputElement).value })
                    }
                  />
                </div>
              ))}
            </div>
          )}
          <pre style={pre}>{text}</pre>
          <div class="small muted">{p.path}</div>
        </>
      )}
      <div class="row" style={{ marginTop: 8, gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          class="primary"
          onClick={copy}
          title="copy the prompt to paste into Claude"
        >
          Copy run prompt
        </button>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide prompt" : "Show prompt"}
        </button>
        {adding && (
          <>
            <button type="button" aria-label={`Edit ${p.name}`} onClick={onEdit}>
              Edit
            </button>
            <button type="button" class="danger" aria-label={`Delete ${p.name}`} onClick={remove}>
              Delete
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

const OUTCOMES = ["done", "failed", "skipped"] as const;

/** Mark done / failed / skipped for a run that is still `started`. */
function CloseRun({ r, onChanged }: { r: PlaybookRunUi; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const close = async (status: (typeof OUTCOMES)[number]) => {
    setBusy(true);
    try {
      await playbooksApi.closeRun(r.id, status);
      toast(`marked ${status}`);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <span style={wrap} role="group" aria-label={`Mark run ${r.id} of ${r.playbook}`}>
      {OUTCOMES.map((o) => (
        <button type="button" class="sm" disabled={busy} onClick={() => close(o)}>
          {o}
        </button>
      ))}
    </span>
  );
}

function History({
  runs,
  titles,
  adding,
  onChanged,
}: {
  runs: PlaybookRunUi[];
  titles: Map<string, string>;
  adding: boolean;
  onChanged: () => void;
}): JSX.Element {
  if (!runs.length)
    return (
      <EmptyState title="No runs recorded yet">
        Copying a playbook's run prompt, or Claude using one, records a run here.
      </EmptyState>
    );
  return (
    <Card flush>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>when</th>
              <th>playbook</th>
              <th>status</th>
              <th>by</th>
              <th>note</th>
              {adding && <th>mark</th>}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td class="nowrap" title={new Date(r.ts).toLocaleString()}>
                  {ago(r.ts)}
                </td>
                <td title={r.playbook}>{titles.get(r.playbook) ?? r.playbook}</td>
                <td>
                  <Badge tone={STATUS_TONES[r.status] ?? "muted"}>{r.status}</Badge>
                </td>
                <td>{r.trigger}</td>
                <td class="muted">{r.note ?? ""}</td>
                {adding && (
                  <td>{r.status === "started" && <CloseRun r={r} onChanged={onChanged} />}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Suggested({
  items,
  adding,
  onChanged,
}: {
  items: PlaybookSuggestionUi[];
  adding: boolean;
  onChanged: () => void;
}): JSX.Element {
  if (!items.length)
    return (
      <EmptyState title="No suggestions yet">
        Recurring tasks eminiar spots in your sessions show up here for you to accept or dismiss.
      </EmptyState>
    );
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {items.map((s) => (
        <Card
          key={s.id}
          title={s.title}
          sub={<span class="mono small">{s.name}</span>}
          right={<span class="muted small">{ago(s.ts)}</span>}
        >
          {s.evidence && <div class="small muted">{s.evidence}</div>}
          <pre style={pre}>{s.prompt}</pre>
          {adding && (
            <div class="row" style={{ gap: 8 }}>
              <button
                type="button"
                class="primary"
                aria-label={`Accept ${s.name}`}
                onClick={() => act(() => playbooksApi.accept(s.id), `accepted ${s.name}`)}
              >
                Accept
              </button>
              <button
                type="button"
                aria-label={`Dismiss ${s.name}`}
                onClick={() => act(() => playbooksApi.dismiss(s.id), "dismissed")}
              >
                Dismiss
              </button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function ScanPanel({
  found,
  adding,
  onClose,
  onSaved,
}: {
  found: PlaybookScanResult;
  adding: boolean;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const n = found.candidates.length;
  const save = async () => {
    setBusy(true);
    try {
      const r = await playbooksApi.scan(false);
      toast(`saved ${r.suggested} suggestion${r.suggested === 1 ? "" : "s"}`);
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Card
      title="Scan history"
      sub={`Looked at ${found.prompts} prompts (${found.mode} matching). Nothing is saved yet.`}
    >
      {n ? (
        <>
          <div class="small">
            Found {n} new recurring task{n === 1 ? "" : "s"}
            {found.known ? `; ${found.known} already seen before` : ""}.
          </div>
          <ul class="small" style={{ margin: "6px 0", paddingLeft: 18 }}>
            {found.candidates.map((c) => (
              <li key={c.title}>
                {c.title}{" "}
                <span class="muted">
                  ({c.sessions} sessions on {c.days} days)
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div class="small muted">
          No new recurring tasks found{found.known ? ` (${found.known} already seen before)` : ""}.
        </div>
      )}
      <div class="row" style={{ gap: 8 }}>
        {n > 0 && adding && (
          <button type="button" class="primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : `Save ${n} as suggestion${n === 1 ? "" : "s"}`}
          </button>
        )}
        <button type="button" disabled={busy} onClick={onClose}>
          {n > 0 && adding ? "Cancel" : "Close"}
        </button>
      </div>
    </Card>
  );
}

export function Playbooks({ params }: { params: Record<string, string> }): JSX.Element {
  const q = useAsync(() => playbooksApi.overview(), []);
  const [tab, setTab] = useState<Tab>(playbookTab(params.tab));
  // The section lives in the URL (#/playbooks?tab=history), so Back, Forward and reload keep it.
  // A hash-only change does not remount the view, and no tab param is the first section.
  useEffect(() => setTab(playbookTab(params.tab)), [params.tab]);
  const goTab = (t: Tab) => {
    setTab(t);
    navigate("playbooks", { tab: t });
  };
  const [form, setForm] = useState<Form | null>(null);
  const [found, setFound] = useState<PlaybookScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  // Leaving the page with an edited, unsaved form asks first (the router asks before it
  // re-renders, so the form is still mounted). Moving between sections stays on this page.
  const dirty = useRef(false);
  const onDirty = useCallback((v: boolean) => {
    dirty.current = v;
  }, []);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const unguard = setLeaveGuard(
      (to) => !dirty.current || to.view === "playbooks" || window.confirm(LEAVE_MSG),
    );
    window.addEventListener("beforeunload", unload);
    return () => {
      unguard();
      window.removeEventListener("beforeunload", unload);
    };
  }, []);
  const d = q.data;
  if (q.error && !d) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!d)
    return (
      <div class="empty">
        <Spinner /> loading playbooks…
      </div>
    );
  if (!d.viewing)
    return (
      <EmptyState title="Playbooks are turned off">
        Set <code>playbooks.viewing</code> to true in the eminiar config to list stored recurring
        tasks here.
      </EmptyState>
    );
  const changed = () => q.reload();
  const startScan = async () => {
    setScanning(true);
    try {
      setFound(await playbooksApi.scan(true));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setScanning(false);
    }
  };
  const titles = new Map(d.playbooks.map((p) => [p.name, p.title]));
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "playbooks", label: `Playbooks (${d.playbooks.length})` },
    { id: "history", label: `Run history (${d.runs.length})` },
  ];
  if (d.extraction) tabs.push({ id: "suggested", label: `Suggested (${d.suggestions.length})` });
  const shown: Tab = tabs.some((t) => t.id === tab) ? tab : "playbooks";
  return (
    <div class="ds-page" style={{ display: "grid", gap: 12 }}>
      <Hero
        eyebrow="Playbooks"
        title="Recurring tasks"
        sub="Stored prompts for work you repeat. eminiar keeps them and shows them: copy a run prompt into Claude to use one. Nothing here runs or schedules anything."
        meta={
          <>
            <Badge>{d.dir}</Badge>
            {!d.adding && <Badge tone="warn">read-only</Badge>}
            <Badge tone={d.extraction ? "ok" : "muted"} dot>
              suggestions {d.extraction ? "on" : "off"}
            </Badge>
          </>
        }
        aside={
          <div class="row" style={{ gap: 8 }}>
            {d.extraction && (
              <button type="button" disabled={scanning} onClick={startScan}>
                {scanning ? "Scanning…" : "Scan history"}
              </button>
            )}
            {d.adding && !form && (
              <button type="button" class="primary" onClick={() => setForm(emptyForm())}>
                New playbook
              </button>
            )}
          </div>
        }
      />
      {d.skipped.length > 0 && (
        <div class="small muted">
          Skipped (unreadable or not a valid name): {d.skipped.join(", ")}
        </div>
      )}
      {found && d.extraction && (
        <ScanPanel
          found={found}
          adding={d.adding}
          onClose={() => setFound(null)}
          onSaved={() => {
            setFound(null);
            goTab("suggested");
            changed();
          }}
        />
      )}
      {form && (
        <PlaybookForm
          initial={form}
          onDirty={onDirty}
          onCancel={() => setForm(null)}
          onDone={() => {
            setForm(null);
            changed();
          }}
        />
      )}
      <Segmented options={tabs} value={shown} onChange={goTab} label="Playbooks sections" />
      <div role="tabpanel" aria-label={tabs.find((t) => t.id === shown)?.label as string}>
        {shown === "playbooks" &&
          (d.playbooks.length ? (
            <div style={{ display: "grid", gap: 10 }}>
              {d.playbooks.map((p) => (
                <PlaybookCard
                  key={p.name}
                  p={p}
                  adding={d.adding}
                  onEdit={() => setForm(formOf(p))}
                  onChanged={changed}
                />
              ))}
            </div>
          ) : (
            <EmptyState title="No playbooks yet">
              {d.adding
                ? "Add one with New playbook, or ask Claude to save a recurring task as a playbook."
                : "Playbooks are read-only here (playbooks.adding is false). Add files under "}
              {!d.adding && <code>{d.dir}</code>}
            </EmptyState>
          ))}
        {shown === "history" && (
          <History runs={d.runs} titles={titles} adding={d.adding} onChanged={changed} />
        )}
        {shown === "suggested" && (
          <Suggested items={d.suggestions} adding={d.adding} onChanged={changed} />
        )}
      </div>
    </div>
  );
}
