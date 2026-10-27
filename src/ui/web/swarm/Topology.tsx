import type { JSX } from "preact";
import type { SwarmEvent, SwarmRunDetail, SwarmTopology, SwarmWorkerUi } from "../api.js";
import { cls } from "../util.js";
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
/** Above this many worker nodes, finished workers of a role fold into one node. */
const FOLD_AT = 12;

type Item =
  | { type: "worker"; id: string; role: string; w: SwarmWorkerUi }
  | { type: "group"; id: string; role: string; n: number }
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
    for (const w of mine)
      if (!fold || w.status !== "done") out.push({ type: "worker", id: w.agent_id, role, w });
    const done = fold ? mine.filter((w) => w.status === "done").length : 0;
    if (done) out.push({ type: "group", id: `done:${role}`, role, n: done });
    if (!out.length) out.push({ type: "idle", id: `idle:${role}`, role });
    return out;
  });
}

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
        label: stages.includes(role) ? `${stages.indexOf(role) + 1} · ${role}` : role,
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
  // hierarchical: the coordinator on top, workers below grouped by role.
  const n = flat.length;
  const w = Math.max(640, n * SLOT + 2 * MARGIN);
  const left = (w - n * SLOT) / 2;
  const nodes = flat.map((item, i) => ({ item, x: left + SLOT * (i + 0.5), y: 200 }));
  return { w, h: 286, hub: { x: w / 2, y: 58 }, nodes, peers: [], lanes: [] };
}

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

export function Topology({
  detail,
  events,
  now,
  roles,
  picked,
  onPick,
}: {
  detail: SwarmRunDetail;
  events: SwarmEvent[];
  /** Server-clock now (client clock corrected by the snapshot's skew). */
  now: number;
  roles: string[];
  picked: string | null;
  onPick: (agentId: string | null) => void;
}): JSX.Element {
  const topology = detail.run.topology;
  const groups = itemsByRole(roles, detail.workers);
  const L = layout(topology, groups, detail.stages, roles);
  const live = detail.run.status === "active";

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
        style={{ maxWidth: `${L.w}px` }}
        role="img"
        aria-label={`${topology} topology: coordinator and ${detail.workers.length} workers`}
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
          if (item.type !== "worker")
            return (
              <g class={cls("sw-node", item.type)} transform={`translate(${x},${y})`}>
                <circle class="sw-core" r={16} style={{ stroke: color }} />
                <text class="sw-glyph" dy={5} style={{ fill: color }}>
                  {item.type === "group" ? GLYPH.done : GLYPH.idle}
                </text>
                <text class="sw-l1" y={32} style={{ fill: color }}>
                  {item.role}
                </text>
                <text class="sw-l2" y={46}>
                  {item.type === "group" ? `${GLYPH.done} ${item.n} done` : `${GLYPH.idle} idle`}
                </text>
                <title>
                  {item.type === "group"
                    ? `${item.n} finished ${item.role} worker(s)`
                    : `${item.role}: no worker spawned in this run yet`}
                </title>
              </g>
            );
          const w = item.w;
          const f = flash.get(w.agent_id);
          const task = w.task_id ? `#${w.task_id}` : "";
          return (
            <g
              class={cls("sw-node worker", `st-${w.status}`, picked === w.agent_id && "picked")}
              transform={`translate(${x},${y})`}
              onClick={() => onPick(picked === w.agent_id ? null : w.agent_id)}
            >
              {w.status === "running" && live ? (
                <circle class="sw-halo" r={24} style={{ stroke: color }} />
              ) : null}
              {f ? <circle key={f.id} class={cls("sw-flash", `io-${eventIo(f)}`)} r={20} /> : null}
              <circle class="sw-core" r={17} style={{ stroke: color }} />
              <text class="sw-glyph" dy={5} style={{ fill: color }}>
                {GLYPH[w.status]}
              </text>
              <text class="sw-l1" y={33}>
                <tspan style={{ fill: color }}>{w.role}</tspan>
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
                  "click to filter the activity feed",
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
        </span>
      </div>
    </div>
  );
}
