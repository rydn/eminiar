import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, getRoot, type Status, setRoot } from "./api.js";
import { ToastHost, useAsync } from "./components.js";
import { navigate, useRoute, type View } from "./router.js";
import { ago, cls } from "./util.js";
import { Architecture } from "./views/Architecture.js";
import { Coverage } from "./views/Coverage.js";
import { Docs } from "./views/Docs.js";
import { Explore } from "./views/Explore.js";
import { Galaxy } from "./views/Galaxy.js";
import { History } from "./views/History.js";
import { Memory } from "./views/Memory.js";
import { Overview } from "./views/Overview.js";
import { Sessions } from "./views/Sessions.js";
import { Swarm } from "./views/Swarm.js";
import { System } from "./views/System.js";
import { Usage } from "./views/Usage.js";

const TABS: Array<[View, string]> = [
  ["overview", "Overview"],
  ["usage", "Usage"],
  ["explore", "Explore"],
  ["galaxy", "Galaxy"],
  ["architecture", "Architecture"],
  ["history", "History"],
  ["memory", "Memory"],
  ["docs", "Docs"],
  ["coverage", "Coverage"],
  ["sessions", "Sessions"],
  ["swarm", "Swarms"],
  ["system", "System"],
];

/** Views that own the whole work area (split panes, graph canvases). */
const FILL: ReadonlySet<View> = new Set(["explore", "galaxy"]);

type Theme = "auto" | "light" | "dark";
function readTheme(): Theme {
  try {
    const t = localStorage.getItem("eminiar.theme");
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}
function applyTheme(t: Theme): void {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    if (t === "auto") localStorage.removeItem("eminiar.theme");
    else localStorage.setItem("eminiar.theme", t);
  } catch {
    // storage may be unavailable
  }
}

export function App(): JSX.Element {
  const route = useRoute();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [tick, setTick] = useState(0);
  // The selected project root lives in the api module (every request carries it); mirror it
  // in state so a change re-renders the shell and remounts the view below (`key={root}`).
  const [root, setRootState] = useState(getRoot);
  const changeRoot = (r: string) => {
    setRoot(r);
    setRootState(r);
  };
  const projects = useAsync(
    () =>
      api<{ current: string; projects: Array<{ id: string; root: string | null }> }>(
        "/api/projects",
      ),
    [tick],
  );
  const status = useAsync(() => api<Status>("/api/status"), [route.view, tick, root]);
  useEffect(() => {
    if (projects.data && !getRoot()) changeRoot(projects.data.current);
  }, [projects.data]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 45_000);
    return () => clearInterval(t);
  }, []);
  const roots = [
    ...new Set(
      [projects.data?.current, ...(projects.data?.projects.map((p) => p.root) ?? [])].filter(
        Boolean,
      ),
    ),
  ] as string[];
  const s = status.data;
  const view = route.view;
  return (
    <>
      <header class="top">
        <div class="brand">
          <span>em</span>iniar<small>{s?.version ? `v${s.version}` : ""}</small>
        </div>
        <nav class="tabs">
          {TABS.map(([id, label]) => (
            <button type="button" class={cls(view === id && "active")} onClick={() => navigate(id)}>
              {label}
            </button>
          ))}
        </nav>
        <span class="spacer" />
        <span
          class="small nowrap"
          title={
            s
              ? `${s.graph.nodes} nodes · ${s.freshness.dirty.length} changed · ${s.freshness.queued} queued`
              : ""
          }
        >
          <i class={cls("dot", s?.state)} />
          {s
            ? s.state === "empty"
              ? "no graph"
              : s.state === "stale"
                ? "index stale"
                : "index fresh"
            : "…"}
        </span>
        <button
          type="button"
          class="ghost sm"
          title="theme"
          onClick={() => {
            const next: Theme = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
            setTheme(next);
            applyTheme(next);
          }}
        >
          {theme === "auto" ? "◐ auto" : theme === "dark" ? "● dark" : "○ light"}
        </button>
        <select
          class="project"
          title={root}
          value={root}
          onChange={(e) => {
            changeRoot((e.target as HTMLSelectElement).value);
            setTick((x) => x + 1);
          }}
        >
          {roots.map((r) => (
            <option value={r}>{r.split("/").slice(-2).join("/")}</option>
          ))}
        </select>
      </header>
      <main class={cls("work", FILL.has(view) && "fill")} key={root}>
        {view === "overview" && <Overview />}
        {view === "usage" && <Usage params={route.params} />}
        {view === "explore" && <Explore params={route.params} />}
        {view === "galaxy" && <Galaxy params={route.params} />}
        {view === "architecture" && <Architecture params={route.params} />}
        {view === "history" && <History params={route.params} />}
        {view === "memory" && <Memory params={route.params} />}
        {view === "docs" && <Docs params={route.params} />}
        {view === "coverage" && <Coverage />}
        {view === "sessions" && <Sessions />}
        {view === "swarm" && <Swarm params={route.params} />}
        {view === "system" && <System onChanged={() => setTick((x) => x + 1)} />}
      </main>
      <footer class="status">
        <span>
          server <b class="ok">ready</b>
        </span>
        {s && (
          <>
            <span>
              <b>{s.graph.nodes}</b> nodes · <b>{s.graph.edges}</b> edges
            </span>
            <span>
              files: <b>{s.files.byStatus.indexed ?? 0}</b> indexed
              {s.files.byStatus.partial ? ` · ${s.files.byStatus.partial} partial` : ""}
              {s.files.byStatus.skipped ? ` · ${s.files.byStatus.skipped} skipped` : ""}
            </span>
            <span>
              git {s.freshness.head?.slice(0, 7) ?? "n/a"}
              {s.freshness.indexedHead && s.freshness.indexedHead !== s.freshness.head
                ? ` (signals at ${s.freshness.indexedHead.slice(0, 7)})`
                : ""}
            </span>
            <span>last index {s.freshness.lastRun ? ago(s.freshness.lastRun) : "never"}</span>
          </>
        )}
        <span class="spacer" />
        <span class="ellipsis">{root}</span>
      </footer>
      <ToastHost />
    </>
  );
}
