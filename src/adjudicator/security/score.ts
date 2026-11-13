/**
 * The heuristic risk engine (design part 3 §5): from a tool grant, the text cues, the session
 * taint and the autonomy, work out which capabilities the agent holds (U untrusted input, S
 * sensitive read, E egress, X code execution, W local write, D destructive, P privilege, T tool
 * supply), which dangerous combinations they form, and how risky that is.
 *
 * Pure and deterministic: no I/O, no regex, no clock, and the same input always gives the same
 * answer, in well under a millisecond. Cues arrive as ids (signals.ts finds them), so no
 * matched text ever reaches the output. The level is rule driven (D7): the score band stops at
 * MEDIUM, HIGH needs a complete combination, and CRITICAL comes only from the fixed triggers
 * C1-C6.
 */
import type { Reason } from "../types.js";
import {
  AUTONOMY_MULT,
  BAND_MEDIUM,
  C6_INTENTS,
  CAN_EGRESS_MIN,
  CAN_EXEC_MIN,
  CAN_READ_MIN,
  CUE_EXPOSURE,
  FLOOR_NOTES,
  HIGH_FLOORS,
  INTENT_EXPOSURE,
  INTENT_FLAT,
  LEG_MIN,
  LEG_STRONG,
  type LegKey,
  MAX_EXPOSURES,
  MAX_REASONS,
  profileOf,
  R7_MAX_U,
  REMEDY_TEXT,
  REVIEW_DAMPEN,
  RULE_SPECS,
  TAINT_U,
  type ToolProfile,
  WEIGHTS,
} from "./taxonomy.js";
import {
  type Autonomy,
  CAP_TAG,
  CAPS,
  type Cap,
  type CapExposure,
  CUE_IDS,
  type CueId,
  type Exposure,
  type ExposureKind,
  type FloorId,
  type GrantedTool,
  type GrantStatus,
  type HeuristicAssessment,
  type IntentCueId,
  type Level,
  type Remedy,
  type RemedyAction,
  type RuleHit,
  type RuleId,
  type ToolGrant,
} from "./types.js";

/** What assessHeuristic reads. `grant` is the tool grant (grant.ts), `cues` and `intent` come from signals.ts. */
export interface HeuristicInput {
  grant: Pick<ToolGrant, "tools"> & Partial<ToolGrant>;
  cues?: readonly CueId[];
  intent?: readonly IntentCueId[];
  /** Untrusted-input tools the session already used (signals.ts taint), by tool id. */
  taint?: readonly string[];
  /** Default "default". */
  autonomy?: Autonomy;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

// --- evaluation --------------------------------------------------------------------------------

interface Ctx {
  tools: readonly GrantedTool[];
  cues: ReadonlySet<CueId>;
  intent: readonly IntentCueId[];
  taint: readonly string[];
  autonomous: boolean;
  /** Remedy simulation: a network-off sandbox (the latent egress of code execution drops to .05). */
  netOff?: boolean;
}

interface Eval {
  exposures: Exposure[];
  caps: Record<Cap, CapExposure>;
  /** The largest exposure of each capability over all kinds (U already takes T into account). */
  eff: Record<Cap, number>;
  /** The same without latent exposures: what the base score is made of. */
  effBase: Record<Cap, number>;
  wstar: number;
  flat: number;
  rules: RuleHit[];
  floors: FloorId[];
}

function emptyCaps(): Record<Cap, CapExposure> {
  const out = {} as Record<Cap, CapExposure>;
  for (const c of CAPS) out[c] = { task: 0, grant: 0, latent: 0, taint: 0 };
  return out;
}

function evaluate(ctx: Ctx): Eval {
  const seen = new Map<string, Exposure>();
  let uTask = false;
  const add = (cap: Cap, e: number, kind: ExposureKind, from: string): void => {
    if (!(e > 0)) return;
    if (cap === "U" && kind === "task") uTask = true;
    const key = `${cap}|${kind}|${from}`;
    const prev = seen.get(key);
    if (!prev || prev.e < e) seen.set(key, { cap, e, kind, from });
    // T also sets U = max(U, T).
    if (cap === "T") add("U", e, kind, from);
  };

  const profiles: Array<[GrantedTool, ToolProfile]> = [];
  const ids = new Set<string>();
  for (const tool of ctx.tools) {
    if (ids.has(tool.id)) continue;
    ids.add(tool.id);
    const profile = profileOf(tool);
    if (profile) profiles.push([tool, profile]);
  }
  const canWrite = profiles.some(([, p]) => p.canWrite === true);

  // text cues (a review, audit or test-for context halves them)
  const damp = ctx.cues.has("review-context") ? REVIEW_DAMPEN : 1;
  let wstar = 0;
  for (const id of CUE_IDS) {
    if (!ctx.cues.has(id)) continue;
    const spec = CUE_EXPOSURE[id];
    for (const cap of CAPS) {
      const e = spec.caps?.[cap];
      if (e) add(cap, e * damp, "task", `text:${id}`);
    }
    if (spec.persist && canWrite) {
      wstar = Math.max(wstar, damp);
      add("W", damp, "task", `text:${id}`);
    }
  }
  let flat = 0;
  for (const id of ctx.intent) {
    const caps = INTENT_EXPOSURE[id];
    for (const cap of CAPS) {
      const e = caps[cap];
      if (e) add(cap, e, "task", `text:${id}`);
    }
    flat += INTENT_FLAT[id] ?? 0;
  }

  // the tool grant
  const netCap = (cap: Cap, e: number): number =>
    ctx.netOff && cap === "E" ? Math.min(e, 0.05) : e;
  for (const [tool, p] of profiles) {
    const from = `tool:${tool.id}`;
    for (const cap of CAPS) {
      const g = p.grant?.[cap];
      if (g) add(cap, g, "grant", from);
      const w = p.whenU?.[cap];
      if (w && uTask) add(cap, w, "grant", from);
      const l = p.latent?.[cap];
      if (l) add(cap, netCap(cap, l), "latent", from);
    }
    if (p.wstar) wstar = Math.max(wstar, p.wstar);
  }
  if (ctx.taint.length > 0) add("U", TAINT_U, "taint", `taint:${ctx.taint[0]}`);

  const exposures = [...seen.values()];
  const caps = emptyCaps();
  for (const x of exposures) if (x.e > caps[x.cap][x.kind]) caps[x.cap][x.kind] = x.e;
  const eff = {} as Record<Cap, number>;
  const effBase = {} as Record<Cap, number>;
  for (const c of CAPS) {
    const k = caps[c];
    effBase[c] = Math.max(k.task, k.grant, k.taint);
    eff[c] = Math.max(effBase[c], k.latent);
  }

  const secret = secretExposure(ctx.cues, damp);
  const rules = findRules(eff, wstar, secret);
  const floors = findFloors(
    ctx,
    caps,
    rules,
    profiles.map(([, p]) => p),
    secret,
    damp,
  );
  return { exposures, caps, eff, effBase, wstar, flat, rules, floors };
}

/** How strongly the text names a secret (a secret-file or credential cue), after dampening. */
function secretExposure(cues: ReadonlySet<CueId>, damp: number): number {
  for (const id of CUE_IDS) if (cues.has(id) && CUE_EXPOSURE[id].secret) return damp;
  return 0;
}

function legValue(
  key: LegKey,
  eff: Record<Cap, number>,
  wstar: number,
  secret: number,
): { cap: Cap; e: number } {
  if (key === "W*") return { cap: "W", e: wstar };
  if (key === "S*") return { cap: "S", e: secret };
  return { cap: key, e: eff[key] };
}

function findRules(eff: Record<Cap, number>, wstar: number, secret: number): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const spec of RULE_SPECS) {
    const factors: Array<{ cap: Cap; e: number }> = [];
    let min = 1;
    for (const alts of spec.legs) {
      let best = { cap: "U" as Cap, e: 0 };
      for (const key of alts) {
        const v = legValue(key, eff, wstar, secret);
        if (v.e > best.e) best = v;
      }
      if (best.e <= 0) {
        min = 0;
        break;
      }
      factors.push(best);
      if (best.e < min) min = best.e;
    }
    if (min <= 0) continue;
    // R7 only covers what R1 does not: it fires without an untrusted-input leg.
    if (spec.id === "R7" && eff.U >= R7_MAX_U) continue;
    hits.push({ id: spec.id, factors, min: r4(min), k: spec.k, add: r4(spec.k * min) });
  }
  return hits;
}

function findFloors(
  ctx: Ctx,
  caps: Record<Cap, CapExposure>,
  rules: RuleHit[],
  profiles: ToolProfile[],
  secret: number,
  damp: number,
): FloorId[] {
  const floors: FloorId[] = [];
  const hit = (id: RuleId): RuleHit | undefined => rules.find((r) => r.id === id);
  const full = (id: RuleId): RuleHit | undefined => {
    const h = hit(id);
    return h && h.min >= LEG_MIN ? h : undefined;
  };
  for (const [rule, floor] of HIGH_FLOORS) if (full(rule)) floors.push(floor);

  const hasX = profiles.some((p) => (p.grant?.X ?? 0) >= CAN_EXEC_MIN);
  const canRead = hasX || profiles.some((p) => (p.grant?.S ?? 0) >= CAN_READ_MIN);
  const canEgress = hasX || profiles.some((p) => (p.grant?.E ?? 0) >= CAN_EGRESS_MIN);
  const fetchExec = ctx.cues.has("fetch-exec") ? damp : 0;

  const r1 = hit("R1");
  const r6 = hit("R6");
  if (r1 && r1.min >= LEG_MIN && ctx.autonomous) floors.push("C1");
  // C2 (user decision, T7d): every trifecta leg strong AND the text itself drives the sensitive
  // read or the egress. A grant alone (a SaaS read is S 1, a browser S 1 and E 1) stays HIGH.
  if (r1 && r1.min >= LEG_STRONG && Math.max(caps.S.task, caps.E.task) >= LEG_STRONG)
    floors.push("C2");
  if (secret >= LEG_STRONG && caps.E.task >= LEG_STRONG && canRead && canEgress) floors.push("C3");
  if (fetchExec >= LEG_STRONG && hasX) floors.push("C4");
  if (r6 && r6.min >= LEG_MIN && ctx.autonomous) floors.push("C5");
  if (ctx.intent.some((i) => C6_INTENTS.includes(i)) && canEgress) floors.push("C6");
  return floors;
}

function levelOf(floors: readonly FloorId[], band: "low" | "medium"): Level {
  if (floors.some((f) => f.startsWith("C"))) return "critical";
  if (floors.length > 0) return "high";
  return band;
}

// --- reasons -----------------------------------------------------------------------------------

const KIND_ORDER: Record<ExposureKind, number> = { task: 0, taint: 1, grant: 2, latent: 3 };

function strongest(
  exposures: readonly Exposure[],
  cap: Cap,
  kinds?: readonly ExposureKind[],
): Exposure | undefined {
  let best: Exposure | undefined;
  for (const x of exposures) {
    if (x.cap !== cap) continue;
    if (kinds && !kinds.includes(x.kind)) continue;
    if (
      !best ||
      x.e > best.e ||
      (x.e === best.e && KIND_ORDER[x.kind] < KIND_ORDER[best.kind]) ||
      (x.e === best.e && x.kind === best.kind && x.from < best.from)
    )
      best = x;
  }
  return best;
}

const describe = (x: Exposure): string =>
  x.kind === "latent" ? `latent ${x.from}` : `${x.kind} ${x.from}`;

function localServers(grant: HeuristicInput["grant"]): string {
  const names = grant.local?.servers ?? [];
  return names.length > 0 ? ` (MCP: ${names.slice(0, 4).join(", ")})` : "";
}

function buildReasons(
  ev: Eval,
  grant: HeuristicInput["grant"],
  status: GrantStatus,
  autonomy: Autonomy,
  a: number,
  sum: number,
  intent: readonly IntentCueId[],
  review: boolean,
): Reason[] {
  const out: Reason[] = [];
  for (const c of CAPS) {
    const w = WEIGHTS[c] * ev.effBase[c];
    if (w < 0.005) continue;
    const x = strongest(ev.exposures, c, ["task", "taint", "grant"]);
    out.push({ feature: `cap:${c}`, weight: r2(w), note: x ? describe(x) : CAP_TAG[c] });
  }
  for (const r of ev.rules) {
    const parts = r.factors.map((f) => CAP_TAG[f.cap]).join(" × ");
    const via = r.factors
      .map((f) => {
        const x = strongest(ev.exposures, f.cap);
        return x ? describe(x) : f.cap;
      })
      .join(", ");
    out.push({ feature: `rule:${r.id}`, weight: r2(r.add), note: `${parts} (${via})` });
  }
  for (const f of ev.floors) {
    out.push({
      feature: `floor:${f}`,
      weight: f.startsWith("C") ? 1 : 0.9,
      note: FLOOR_NOTES[f],
    });
  }
  if (a !== 1) {
    out.push({
      feature: "autonomy",
      weight: r2((a - 1) * Math.min(1, sum)),
      note: `×${a} ${grant.permissionMode ?? autonomy}`,
    });
  }
  for (const i of intent) {
    const flat = INTENT_FLAT[i];
    if (flat)
      out.push({
        feature: `intent:${i}`,
        weight: flat,
        note: "the text tries to hide what it does",
      });
  }
  if (review)
    out.push({ feature: "review-context", weight: 0, note: "review wording halves the text cues" });
  if (status !== "known") {
    out.push({
      feature: "grant",
      weight: 0,
      note:
        status === "inherit"
          ? `inherits the parent's tools and every MCP server (not enumerated)${localServers(grant)}`
          : "the tool definition is unreadable or contradictory: assumed to inherit everything",
    });
  } else if (grant.mcpServers) {
    out.push({
      feature: "grant",
      weight: 0,
      note: "the definition names MCP servers (not enumerated)",
    });
  }
  out.sort(
    (x, y) =>
      Math.abs(y.weight) - Math.abs(x.weight) ||
      (x.feature < y.feature ? -1 : x.feature > y.feature ? 1 : 0),
  );
  return out.slice(0, MAX_REASONS);
}

// --- remedy ------------------------------------------------------------------------------------

interface Candidate {
  action: RemedyAction;
  text: string;
  kills: Set<string>;
  rank: number;
}

const issuesOf = (ev: Eval): Set<string> =>
  new Set<string>([...ev.floors, ...ev.rules.map((r) => r.id)]);

/**
 * At most two actions, each simulated by re-running the evaluation without the leg, ranked by how
 * many of the fired floors and rules it kills (ties: the cheapest leg first, E then X then S then U).
 * A leg the task text itself drives is never offered for dropping.
 */
function buildRemedy(ctx: Ctx, ev: Eval): Remedy | undefined {
  const before = issuesOf(ev);
  if (before.size === 0) return undefined;
  const killed = (over: Partial<Ctx>): Set<string> => {
    const after = issuesOf(evaluate({ ...ctx, ...over }));
    return new Set([...before].filter((i) => !after.has(i)));
  };
  const without = (min: number, cap: Cap): GrantedTool[] =>
    ctx.tools.filter((t) => (profileOf(t)?.grant?.[cap] ?? 0) >= min);
  const kept = (drop: readonly GrantedTool[]): GrantedTool[] =>
    ctx.tools.filter((t) => !drop.includes(t));
  const ids = (list: readonly GrantedTool[]): string[] =>
    [...new Set(list.map((t) => t.id))].slice(0, 6);

  const cands: Candidate[] = [];
  const push = (c: Candidate): void => {
    if (c.kills.size > 0) cands.push(c);
  };

  if (ev.caps.E.task === 0) {
    const egress = without(CAN_EGRESS_MIN, "E");
    if (egress.length > 0) {
      const tools = ids(egress);
      push({
        action: { id: "drop-egress", leg: "E", tools },
        text: REMEDY_TEXT["drop-egress"](tools),
        kills: killed({ tools: kept(egress) }),
        rank: 0,
      });
    } else if (ev.caps.E.latent > 0.05) {
      push({
        action: { id: "sandbox-network", leg: "E" },
        text: REMEDY_TEXT["sandbox-network"](),
        kills: killed({ netOff: true }),
        rank: 1,
      });
    }
  }
  const exec = without(CAN_EXEC_MIN, "X");
  if (exec.length > 0) {
    const tools = ids(exec);
    push({
      action: { id: "drop-exec", leg: "X", tools },
      text: REMEDY_TEXT["drop-exec"](tools),
      kills: killed({ tools: kept(exec) }),
      rank: 2,
    });
  }
  if (ev.caps.S.task === 0) {
    const reads = without(CAN_READ_MIN, "S");
    if (reads.length > 0) {
      push({
        action: { id: "drop-tool", leg: "S", tools: ids(reads) },
        text: REMEDY_TEXT["drop-secrets"](),
        kills: killed({ tools: kept(reads) }),
        rank: 3,
      });
    }
  }
  if (ev.caps.U.task === 0 && ev.caps.U.taint === 0) {
    const outside = without(0.25, "U");
    if (outside.length > 0) {
      const tools = ids(outside);
      push({
        action: { id: "drop-tool", leg: "U", tools },
        text: REMEDY_TEXT["drop-untrusted"](tools),
        kills: killed({ tools: kept(outside) }),
        rank: 4,
      });
    }
  }
  const unattended = ev.floors.filter((f) => f === "C3" || f === "C4" || f === "C6");
  const doNotRun: Candidate | undefined =
    unattended.length > 0
      ? {
          action: { id: "do-not-run" },
          text: REMEDY_TEXT["do-not-run"](),
          kills: new Set(unattended),
          rank: 6,
        }
      : undefined;
  const reviewFirst: Candidate | undefined = ev.rules.some((r) => r.id === "R4")
    ? {
        action: { id: "review-first", leg: "T" },
        text: REMEDY_TEXT["review-first"](),
        kills: new Set(["R4"]),
        rank: 5,
      }
    : undefined;

  // Floors come first: a candidate counts by the fired floors it kills, then by all issues.
  const firedFloors = new Set<string>(ev.floors);
  const floorKills = (c: Candidate): number =>
    [...c.kills].filter((k) => firedFloors.has(k)).length;
  const useful = (c: Candidate): boolean =>
    firedFloors.size > 0 ? floorKills(c) > 0 : c.kills.size > 0;
  const ranked = cands
    .filter(useful)
    .sort(
      (x, y) => floorKills(y) - floorKills(x) || y.kills.size - x.kills.size || x.rank - y.rank,
    );
  const chosen: Candidate[] = [];
  const covered = new Set<string>();
  const take = (c: Candidate): void => {
    chosen.push(c);
    for (const k of c.kills) covered.add(k);
  };
  if (doNotRun) take(doNotRun);
  for (const c of ranked) {
    if (chosen.length === 2) break;
    if (chosen.length > 0 && !doNotRun && ![...c.kills].some((k) => !covered.has(k))) continue;
    take(c);
  }
  if (reviewFirst && chosen.length < 2) take(reviewFirst);
  if (chosen.length < 2 && [...firedFloors].some((f) => !covered.has(f))) {
    // A fired floor no tool change can remove: the text drives the legs. Split the work, or keep a human in the loop.
    chosen.push(
      ev.caps.U.task >= LEG_MIN
        ? { action: { id: "split" }, text: REMEDY_TEXT.split(), kills: new Set(), rank: 7 }
        : { action: { id: "hitl" }, text: REMEDY_TEXT.hitl(), kills: new Set(), rank: 8 },
    );
  }
  if (chosen.length === 0) return undefined;
  return { actions: chosen.map((c) => c.action), text: chosen.map((c) => c.text).join("; ") };
}

// --- the entry point ---------------------------------------------------------------------------

/**
 * Score one dispatch: this grant, doing this task text, with this much session taint and
 * autonomy. Never throws and never reads anything but its input.
 */
export function assessHeuristic(input: HeuristicInput): HeuristicAssessment {
  const autonomy = input.autonomy ?? "default";
  const a = AUTONOMY_MULT[autonomy];
  const cueSet = new Set<CueId>(input.cues ?? []);
  const intent = [...new Set(input.intent ?? [])];
  const ctx: Ctx = {
    tools: input.grant.tools,
    cues: cueSet,
    intent,
    taint: input.taint ?? [],
    autonomous: autonomy === "autonomous",
  };
  const ev = evaluate(ctx);

  let base = ev.flat;
  for (const c of CAPS) base += WEIGHTS[c] * ev.effBase[c];
  let adds = 0;
  for (const r of ev.rules) adds += r.add;
  const sum = base + adds;
  const score = Math.min(100, Math.round(100 * Math.min(1, sum) * a));
  const band: "low" | "medium" = score >= BAND_MEDIUM ? "medium" : "low";
  const level = levelOf(ev.floors, band);
  const status = input.grant.status ?? "known";

  const exposures = [...ev.exposures]
    .sort(
      (x, y) =>
        y.e - x.e ||
        KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
        CAPS.indexOf(x.cap) - CAPS.indexOf(y.cap) ||
        (x.from < y.from ? -1 : x.from > y.from ? 1 : 0),
    )
    .slice(0, MAX_EXPOSURES);

  const out: HeuristicAssessment = {
    score,
    band,
    level,
    caps: ev.caps,
    exposures,
    rules: ev.rules,
    floors: ev.floors,
    autonomy,
    a,
    cues: CUE_IDS.filter((c) => cueSet.has(c)),
    intent,
    reasons: buildReasons(
      ev,
      input.grant,
      status,
      autonomy,
      a,
      sum,
      intent,
      cueSet.has("review-context"),
    ),
    grantStatus: status,
  };
  const remedy = buildRemedy(ctx, ev);
  if (remedy) out.remedy = remedy;
  return out;
}
