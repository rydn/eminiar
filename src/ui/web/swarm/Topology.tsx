import type { JSX } from "preact";
import type { SwarmEvent, SwarmRunDetail, SwarmTopology, SwarmWorkerUi } from "../api.js";
import { cls } from "../util.js";
import { onActivate, pure, useNow } from "./bits.js";
import { eventIo, GLYPH, roleColor, shortAgent } from "./style.js";

/** Coordination events that light the hub↔worker edge for a while. */
const EDGE_KINDS = new Set([
  "claim",
  "post",
  "update",
  "plan",
  "spawn",
  "start",
  "stop",
  "auto_close",
]);
const EDGE_HOT_MS = 10_000;
const FLASH_MS = 2_500;
/**
 * Above this many workers, each role's stale and done workers fold into one "+N" node and
 * at most RUNNING_CAP of its running workers get their own node (the rest join the fold).
 */
const FOLD_AT = 12;
const RUNNING_CAP = 6;
/** Hierarchical: nodes per row before the next row. */
const PER_ROW = 8;
const ROW_H = 110;
/**
 * The canvas never draws smaller than this (labels stay ~10px); a wider one scrolls
 * sideways inside `.sw-topo-wrap` instead.
 */
const MIN_SCALE = 0.95;

type Item =
  | { type: "worker"; id: string; role: string; w: SwarmWorkerUi }
  | {
      type: "group";
      id: string;
      role: string;
      n: number;
      running: number;
      stale: number;
      done: number;
    }
  | { type: "idle"; id: string; role: string };

interface Placed {
  item: Item;
  x: number;
  y: number;
}
interface Layout {
  w: number;
  h: number;
  hub: { x: number; y: number };
  nodes: Placed[];
  peers: Array<[Placed, Placed]>;
  lanes: Array<{ x: number; w: number; label: string; n: number }>;
}

function itemsByRole(roles: string[], workers: SwarmWorkerUi[]): Item[][] {
  const fold = workers.length > FOLD_AT;
  return roles.map((role) => {
    const mine = workers.filter((w) => w.role === role);
    const out: Item[] = [];
    // Spawn order, so nodes keep their place between snapshots.
    for (const w of mine)
      if (!fold || (w.status === "running" && out.length < RUNNING_CAP))
        out.push({ type: "worker", id: w.agent_id, role, w });
    if (fold && mine.length > out.length) {
      const folded = mine.filter((w) => !out.some((it) => it.id === w.agent_id));
      const count = (s: SwarmWorkerUi["status"]) => folded.filter((w) => w.status === s).length;
      out.push({
        type: "group",
        id: `fold:${role}`,
        role,
        n: folded.length,
        running: count("running"),
        stale: count("stale"),
        done: count("done"),
      });
    }
    if (!out.length) out.push({ type: "idle", id: `idle:${role}`, role });
    return out;
  });
}

const groupWords = (g: { running: number; stale: number; done: number }): string =>
  [
    g.running ? `${GLYPH.running}${g.running}` : "",
    g.stale ? `${GLYPH.stale}${g.stale}` : "",
    g.done ? `${GLYPH.done}${g.done}` : "",
  ]
    .filter(Boolean)
    .join(" ");

const SLOT = 116;
const MARGIN = 56;

function layout(
  topology: SwarmTopology,
  groups: Item[][],
  stages: string[],
  roles: string[],
): Layout {
  const flat = groups.flat();
  if (topology === "pipeline") {
    // Lanes left → right by stage; roles outside the stages follow as their own lanes.
    const order = [...stages, ...roles.filter((r) => !stages.includes(r))];
    const cols = order.map((r) => groups[roles.indexOf(r)] ?? []);
    const rowH = 84;
    const tallest = Math.max(1, ...cols.map((c) => c.length));
    const h = Math.max(240, 96 + tallest * rowH);
    const colW = 150;
    const x0 = 150;
    const w = x0 + cols.length * colW + 10;
    const nodes: Placed[] = [];
    const lanes: Layout["lanes"] = [];
    cols.forEach((col, i) => {
      const cx = x0 + i * colW + colW / 2;
      const top = 60 + (h - 60 - col.length * rowH) / 2;
      col.forEach((item, j) => {
        nodes.push({ item, x: cx, y: top + j * rowH + 22 });
      });
      const role = order[i]!;
      lanes.push({
        x: x0 + i * colW + 6,
        w: colW - 12,
        label: clipLabel(
          stages.includes(role) ? `${stages.indexOf(role) + 1} · ${role}` : role,
          20,
        ),
        n: col.length,
      });
    });
    return { w, h, hub: { x: 60, y: h / 2 }, nodes, peers: [], lanes };
  }
  if (topology === "mesh") {
    const n = flat.length;
    const r = Math.max(100, (n * 120) / (2 * Math.PI));
    const w = Math.max(640, 2 * r + 2 * MARGIN + 120);
    const h = 2 * r + 130;
    const cx = w / 2;
    const cy = r + 46;
    const nodes = flat.map((item, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
      return { item, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    const peers: Array<[Placed, Placed]> = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        // Every pair while it stays readable; ring neighbours only for a crowded ring.
        if (n <= 8 || j === i + 1 || (i === 0 && j === n - 1)) peers.push([nodes[i]!, nodes[j]!]);
    return { w, h, hub: { x: cx, y: cy }, nodes, peers, lanes: [] };
  }
  // hierarchical: the coordinator on top, workers below grouped by role, in rows of
  // PER_ROW; a role that does not fit in what is left of a row starts the next one.
  const rows: Item[][] = [[]];
  for (const g of groups) {
    const cur = rows[rows.length - 1]!;
    if (cur.length && cur.length + g.length > PER_ROW) rows.push([]);
    for (const item of g) {
      if (rows[rows.length - 1]!.length >= PER_ROW) rows.push([]);
      rows[rows.length - 1]!.push(item);
    }
  }
  const widest = Math.max(1, ...rows.map((r) => r.length));
  const w = Math.max(640, widest * SLOT + 2 * MARGIN);
  const nodes = rows.flatMap((row, r) => {
    const left = (w - row.length * SLOT) / 2;
    return row.map((item, i) => ({ item, x: left + SLOT * (i + 0.5), y: 200 + r * ROW_H }));
  });
  return {
    w,
    h: 286 + (rows.length - 1) * ROW_H,
    hub: { x: w / 2, y: 58 },
    nodes,
    peers: [],
    lanes: [],
  };
}

/** Clip a label to `n` characters (11px mono is ~6.6px a character: a node slot holds ~17). */
const clipLabel = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function spoke(topology: SwarmTopology, a: { x: number; y: number }, b: { x: number; y: number }) {
  if (topology === "hierarchical") {
    const my = (a.y + b.y) / 2;
    return `M${a.x},${a.y} C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
  }
  if (topology === "pipeline") {
    const mx = (a.x + b.x) / 2;
    return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`;
  }
  return `M${a.x},${a.y} L${b.x},${b.y}`;
}

function TopologyView({
  detail,
  events,
  skew,
  roles,
  picked,
  onPick,
}: {
  detail: SwarmRunDetail;
  events: SwarmEvent[];
  /** Server clock minus client clock. */
  skew: number;
  roles: string[];
  picked: string | null;
  onPick: (agentId: string | null) => void;
}): JSX.Element {
  const topology = detail.run.topology;
  const live = detail.run.status === "active";
  // Flashes and hot edges are short-lived: this canvas alone ticks every second.
  const now = useNow(1000, live, skew);
  const groups = itemsByRole(roles, detail.workers);
  const L = layout(topology, groups, detail.stages, roles);
  const folded = groups.flat().some((it) => it.type === "group");

  // Recent activity per worker / role, newest last (events are oldest first).
  const flash = new Map<string, SwarmEvent>();
  const hot = new Set<string>();
  const hotRole = new Set<string>();
  for (const e of events) {
    const age = now - e.ts;
    if (e.agent_id && age < FLASH_MS && age > -FLASH_MS) flash.set(e.agent_id, e);
    if (age < EDGE_HOT_MS && EDGE_KINDS.has(e.kind)) {
      if (e.agent_id) hot.add(e.agent_id);
      else if (e.role) hotRole.add(e.role);
    }
  }
  const taskTitle = new Map(detail.tasks.map((t) => [t.id, t.title]));
  const isHot = (it: Item) =>
    live && (it.type === "worker" ? hot.has(it.id) : it.type === "idle" && hotRole.has(it.role));

  return (
    <div class="sw-topo-wrap">
      <svg
        class={cls("sw-topo", `topo-${topology}`)}
        viewBox={`0 0 ${L.w} ${L.h}`}
        style={{ maxWidth: `${L.w}px`, minWidth: `${Math.round(L.w * MIN_SCALE)}px` }}
        role="group"
        aria-label={`${topology} topology: coordinator and ${detail.workers.length} workers${folded ? ", quiet workers folded per role" : ""}`}
      >
        {L.lanes.map((lane, i) => (
          <g class="sw-lane">
            <rect x={lane.x} y={8} width={lane.w} height={L.h - 16} rx={8} />
            <text x={lane.x + lane.w / 2} y={26}>
              {lane.label}
            </text>
            {i < L.lanes.length - 1 ? (
              <text class="arrow" x={lane.x + lane.w + 6} y={26}>
                →
              </text>
            ) : null}
          </g>
        ))}
        {L.peers.map(([a, b]) => (
          <line
            class={cls("sw-edge peer", (isHot(a.item) || isHot(b.item)) && "hot")}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
          />
        ))}
        {L.nodes.map((n) => (
          <path
            key={n.item.id}
            class={cls(
              "sw-edge spoke",
              isHot(n.item) && "hot",
              n.item.type !== "worker" && "ghost",
            )}
            d={spoke(topology, L.hub, n)}
            style={{ stroke: isHot(n.item) ? roleColor(n.item.role, roles) : undefined }}
          />
        ))}
        <g
          class={cls("sw-node hub", live && "live")}
          transform={`translate(${L.hub.x},${L.hub.y})`}
        >
          {live ? <circle class="sw-halo" r={30} /> : null}
          <circle class="sw-core" r={22} />
          <text class="sw-glyph" dy={6}>
            {GLYPH.coordinator}
          </text>
          <text class="sw-l1" y={topology === "hierarchical" ? -32 : 40}>
            coordinator
          </text>
          <title>coordinator: the main Claude Code session leads the run</title>
        </g>
        {L.nodes.map(({ item, x, y }) => {
          const color = roleColor(item.role, roles);
          if (item.type === "group")
            return (
              <g key={item.id} class="sw-node group" transform={`translate(${x},${y})`}>
                <circle class="sw-core" r={17} style={{ stroke: color }} />
                <text class="sw-glyph sw-plus" dy={4} style={{ fill: color }}>
                  +{item.n}
                </text>
                <text class="sw-l1" y={33} style={{ fill: color }}>
                  {clipLabel(item.role, 16)}
                </text>
                <text class="sw-l2" y={47}>
                  {groupWords(item)}
                </text>
                <title>
                  {`${item.n} more ${item.role} worker(s), folded: ${item.running} running · ${item.stale} stale · ${item.done} done. Every worker is listed in the timeline.`}
                </title>
              </g>
            );
          if (item.type === "idle")
            return (
              <g key={item.id} class="sw-node idle" transform={`translate(${x},${y})`}>
                <circle class="sw-core" r={16} style={{ stroke: color }} />
                <text class="sw-glyph" dy={5} style={{ fill: color }}>
                  {GLYPH.idle}
                </text>
                <text class="sw-l1" y={32} style={{ fill: color }}>
                  {clipLabel(item.role, 16)}
                </text>
                <text class="sw-l2" y={46}>
                  {`${GLYPH.idle} idle`}
                </text>
                <title>{`${item.role}: no worker spawned in this run yet`}</title>
              </g>
            );
          const w = item.w;
          const f = flash.get(w.agent_id);
          const task = w.task_id ? `#${w.task_id}` : "";
          const isPicked = picked === w.agent_id;
          const toggle = () => onPick(isPicked ? null : w.agent_id);
          return (
            <g
              key={item.id}
              class={cls("sw-node worker", `st-${w.status}`, isPicked && "picked")}
              transform={`translate(${x},${y})`}
              // lowercase: on SVG, Preact sets attributes verbatim and `tabIndex` is ignored
              tabindex={0}
              role="button"
              aria-pressed={isPicked}
              aria-label={`${w.role} worker ${shortAgent(w.agent_id)}, ${w.status}${task ? `, task ${task}` : ""}: ${isPicked ? "show every worker's" : "show only its"} activity`}
              onClick={toggle}
              onKeyDown={onActivate(toggle)}
            >
              <circle class="sw-focus" r={27} />
              {w.status === "running" && live ? (
                <circle class="sw-halo" r={24} style={{ stroke: color }} />
              ) : null}
              {f ? <circle key={f.id} class={cls("sw-flash", `io-${eventIo(f)}`)} r={20} /> : null}
              <circle class="sw-core" r={17} style={{ stroke: color }} />
              <text class="sw-glyph" dy={5} style={{ fill: color }}>
                {GLYPH[w.status]}
              </text>
              <text class="sw-l1" y={33}>
                <tspan style={{ fill: color }}>{clipLabel(w.role, 8)}</tspan>
                <tspan class="id">·{shortAgent(w.agent_id)}</tspan>
              </text>
              <text class={cls("sw-l2", `sw-s-${w.status}`)} y={47}>
                {GLYPH[w.status]} {w.status}
                {task ? ` ${task}` : ""}
              </text>
              <title>
                {[
                  `${w.role} worker ${w.agent_id}`,
                  `${w.status}${w.task_id ? ` · task #${w.task_id} ${taskTitle.get(w.task_id) ?? ""}` : ""}`,
                  `${w.tool_calls} tool calls · ${w.errors} errors${w.last_tool ? ` · last ${w.last_tool}` : ""}`,
                  "click (or Enter) to filter the activity feed",
                ].join("\n")}
              </title>
            </g>
          );
        })}
      </svg>
      <div class="sw-legend small muted">
        <span>
          <i class="sw-sw io-read" /> read
        </span>
        <span>
          <i class="sw-sw io-write" /> write
        </span>
        <span>
          <i class="sw-sw io-exec" /> exec
        </span>
        <span>
          <i class="sw-sw io-swarm" /> swarm
        </span>
        <span class="sep">·</span>
        <span>
          {GLYPH.running} running · {GLYPH.stale} stale · {GLYPH.done} done · {GLYPH.idle} idle
          {folded ? " · +N folded" : ""}
        </span>
      </div>
    </div>
  );
}

/** Re-rendered on new events or a new snapshot, and every second while live. */
export const Topology = pure(TopologyView);
