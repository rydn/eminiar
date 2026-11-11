// Hash routes of the dashboard, pure (no preact, no DOM): router.ts wraps them in a hook,
// and tests import this module directly without pulling DOM types into the node build.

export const VIEWS = [
  "overview",
  "usage",
  "explore",
  "galaxy",
  "history",
  "memory",
  "docs",
  "coverage",
  "sessions",
  "swarm",
  "playbooks",
  "adjudicator",
  "system",
] as const;
export type View = (typeof VIEWS)[number];

/**
 * The one sub-path segment each view accepts (`#/swarm/config`). The view stays the same,
 * so its top tab stays highlighted; an unknown sub-path falls back to null.
 */
export const SUBS: Partial<Record<View, readonly string[]>> = {
  swarm: ["config"],
};

export interface Route {
  view: View;
  /** The sub-path segment (`config` in `#/swarm/config`), or null. */
  sub: string | null;
  params: Record<string, string>;
}

/** The tabs of the Galaxy page: its two graph layouts, then the former Architecture panels. */
export const GALAXY_TABS = [
  "galaxy",
  "hierarchy",
  "map",
  "routes",
  "hotspots",
  "structure",
  "behavior",
] as const;
export type GalaxyTab = (typeof GALAXY_TABS)[number];

export const isGalaxyTab = (t: string | undefined): t is GalaxyTab =>
  (GALAXY_TABS as readonly string[]).includes(t ?? "");

/** An old `#/architecture?tab=x` tab → its Galaxy tab (the old "overview" is the folder map). */
export function legacyArchitectureTab(tab: string | undefined): GalaxyTab {
  if (tab === "overview" || !tab) return "map";
  return isGalaxyTab(tab) ? tab : "map";
}

/** `#/explore?file=src/x.ts` → { view: "explore", sub: null, params: { file } }. */
export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, "");
  const q = h.indexOf("?");
  const path = q < 0 ? h : h.slice(0, q);
  const qs = q < 0 ? "" : h.slice(q + 1);
  const [v = "", s = ""] = path.split("/");
  if (v === "architecture") {
    // The Architecture page was folded into Galaxy: old links land on the equivalent tab.
    const params: Record<string, string> = {};
    for (const [k, val] of new URLSearchParams(qs)) params[k] = val;
    params.tab = legacyArchitectureTab(params.tab);
    return { view: "galaxy", sub: null, params };
  }
  const view = (VIEWS as readonly string[]).includes(v) ? (v as View) : "overview";
  const sub = s && view === v && SUBS[view]?.includes(s) ? s : null;
  const params: Record<string, string> = {};
  for (const [k, val] of new URLSearchParams(qs)) params[k] = val;
  return { view, sub, params };
}

/** The hash for a view (optionally `view/sub`) and its params, without the leading `#`. */
export function routeHash(
  to: View | `${View}/${string}`,
  params: Record<string, string | undefined> = {},
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return `/${to}${s ? `?${s}` : ""}`;
}

/**
 * History position bookkeeping for the leave guard. Every accepted entry is stamped with a
 * `pos` in history.state; a vetoed move is undone by walking back by the distance travelled
 * (a plain replaceState would overwrite the entry we moved to and corrupt Back/Forward).
 */
export function entryPos(cur: number, statePos: number | undefined): number {
  // An unstamped entry was just pushed (hash assigned or link clicked): it follows the current.
  return statePos ?? cur + 1;
}

/** history.go() delta that returns to position `cur` after landing on `statePos`. */
export function leaveDelta(cur: number, statePos: number | undefined): number {
  return cur - entryPos(cur, statePos);
}

export function statePos(state: unknown): number | undefined {
  const p = (state as { pos?: unknown } | null)?.pos;
  return typeof p === "number" ? p : undefined;
}

/** history.state with `pos` set and every other field kept. */
export function withPos(state: unknown, pos: number): Record<string, unknown> {
  return { ...(state && typeof state === "object" ? state : {}), pos };
}

/** A walk back to the page shown, started after the leave guard vetoed a move. */
export interface Walk {
  target: number;
  /** Corrective history.go() calls made so far. */
  tries: number;
}

/** Corrective history.go() calls a walk may make before it gives up and restores the URL. */
export const WALK_TRIES = 3;
/** Quiet time after the last history event before a walk checks where it landed. */
export const SETTLE_MS = 250;

/**
 * What a popstate/hashchange means. Both events fire for one traversal (and Chrome fires no
 * hashchange when the query differs too), so the router reacts to whichever comes and reads
 * the live position: "same" is the second event of a pair, "home" ends a walk, "walking" is
 * an intermediate landing, "moved" is a real navigation to put to the guard.
 */
export function reconcile(
  cur: number,
  shownHash: string,
  walk: Walk | null,
  landed: number | undefined,
  hash: string,
): "same" | "home" | "walking" | "moved" {
  if (walk) return landed === walk.target ? "home" : "walking";
  return landed === cur && hash === shownHash ? "same" : "moved";
}

/** How to undo a vetoed move: walk by the distance travelled, or rewrite the URL in place. */
export function vetoStep(
  cur: number,
  landed: number | undefined,
): { kind: "go"; delta: number } | { kind: "restore" } {
  const delta = leaveDelta(cur, landed);
  return delta === 0 ? { kind: "restore" } : { kind: "go", delta };
}

/**
 * Where a walk stands once history has been quiet for SETTLE_MS: home, another corrective
 * step from where it actually is (a go() can be dropped or land short when several traversals
 * are queued), "restore" when it ran out of tries (no entry at that distance), or "moved"
 * when an unstamped entry was pushed meanwhile, which is a new navigation.
 */
export function settleWalk(
  walk: Walk,
  landed: number | undefined,
  maxTries = WALK_TRIES,
):
  | { kind: "home" }
  | { kind: "go"; delta: number }
  | { kind: "restore"; pos: number }
  | {
      kind: "moved";
    } {
  if (landed === walk.target) return { kind: "home" };
  if (landed === undefined) return { kind: "moved" };
  if (walk.tries >= maxTries) return { kind: "restore", pos: landed };
  return { kind: "go", delta: walk.target - landed };
}

/**
 * What the project selector must do after the router accepted a move: the entry landed on may
 * carry a different ?root= than the project on screen (Back across a project switch). Switch to
 * the project the URL names once the leave guard allows it, or put the URL back when it does
 * not. `canLeave` is asked only when the roots differ. An entry without ?root= keeps the
 * project shown.
 */
export function rootSync(
  urlRoot: string | null,
  shown: string,
  canLeave: () => boolean,
): { kind: "keep" } | { kind: "switch"; root: string } | { kind: "restore"; root: string } {
  if (!urlRoot || urlRoot === shown) return { kind: "keep" };
  return canLeave() ? { kind: "switch", root: urlRoot } : { kind: "restore", root: shown };
}

/** The slice of window.history the router uses. */
export interface HistoryLike {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string): void;
  go(delta: number): void;
}

export interface RouteSyncDeps {
  history: HistoryLike;
  /** location.hash */
  hash(): string;
  /** The current URL with this fragment (to put the address bar back in place). */
  urlWithHash(hash: string): string;
  /** The leave guard; true when nothing guards. */
  allow(to: Route): boolean;
  /** Render this route. */
  show(to: Route): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(t: unknown): void;
}

export interface RouteSync {
  /** Stamp the current entry; call once on mount. */
  start(): void;
  /** Call on every popstate and hashchange. */
  onLocation(): void;
  stop(): void;
  /** The position of the page shown (for tests). */
  pos(): number;
  walking(): boolean;
}

/**
 * The router's history bookkeeping, free of DOM types so tests can drive it with a fake
 * history. A vetoed move walks back with history.go(); the walk ends when the page shown is
 * reached again, and a settle timer re-checks the landing so a go() that fires no event (no
 * entry at that distance, a dropped traversal) can never leave the router waiting.
 */
export function createRouteSync(d: RouteSyncDeps): RouteSync {
  let cur = 0;
  let shown = "";
  let walk: Walk | null = null;
  let timer: unknown;

  const stamp = (pos: number, url?: string) => {
    const data = withPos(d.history.state, pos);
    if (url === undefined) d.history.replaceState(data, "");
    else d.history.replaceState(data, "", url);
  };
  const arm = () => {
    d.clearTimer(timer);
    timer = d.setTimer(settle, SETTLE_MS);
  };
  const endWalk = () => {
    walk = null;
    d.clearTimer(timer);
    timer = undefined;
  };
  const move = () => {
    const landed = statePos(d.history.state);
    const next = parseHash(d.hash());
    if (!d.allow(next)) {
      const step = vetoStep(cur, landed);
      if (step.kind === "restore") {
        stamp(cur, d.urlWithHash(shown));
        return;
      }
      // Stamp a just-pushed entry so a slow walk still knows where it stands.
      if (landed === undefined) stamp(entryPos(cur, landed));
      walk = { target: cur, tries: 0 };
      d.history.go(step.delta);
      arm();
      return;
    }
    cur = entryPos(cur, landed);
    shown = d.hash();
    stamp(cur);
    d.show(next);
  };
  function settle(): void {
    timer = undefined;
    if (!walk) return;
    const step = settleWalk(walk, statePos(d.history.state));
    if (step.kind === "home") endWalk();
    else if (step.kind === "go") {
      walk.tries++;
      d.history.go(step.delta);
      arm();
    } else if (step.kind === "restore") {
      // No way back: this entry now shows the page on screen, under its own position.
      endWalk();
      cur = step.pos;
      stamp(cur, d.urlWithHash(shown));
    } else {
      endWalk();
      move();
    }
  }

  return {
    start() {
      endWalk();
      cur = statePos(d.history.state) ?? 0;
      shown = d.hash();
      stamp(cur);
    },
    onLocation() {
      const r = reconcile(cur, shown, walk, statePos(d.history.state), d.hash());
      if (r === "home") endWalk();
      else if (r === "walking") arm();
      else if (r === "moved") move();
    },
    stop: endWalk,
    pos: () => cur,
    walking: () => walk !== null,
  };
}
