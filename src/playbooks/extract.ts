import { createHash } from "node:crypto";
import { redactSecrets } from "../adjudicator/redact.js";
import type { ProjectContext } from "../context.js";
import { type EmbeddingProvider, getProvider } from "../embeddings/provider.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { slugify, suggest } from "./store.js";

/**
 * Opt-in playbook extraction (playbooks.extraction.enabled). A deterministic miner that runs
 * only when asked (CLI scan, em_playbook scan); never from a hook. It reads the user_prompt,
 * mcp_tool and subagent events of this project, clusters similar prompts, and proposes a
 * playbook when a cluster recurs: >= MIN_SESSIONS sessions on >= MIN_DAYS distinct days, with a
 * shared set of MCP servers in the tool window after the prompt. Proposals only land in the
 * suggestions inbox; nothing becomes a playbook without acceptance. Tool arguments are not
 * stored, so there are no parameters here: they come from the prompt or the person.
 */

export const MIN_SESSIONS = 3;
export const MIN_DAYS = 2;
/** A tool call belongs to a prompt when it follows it in the same session within this window. */
const WINDOW_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const EVENT_LIMIT = 20_000;
const EMBED_SIM = 0.82;
const LEXICAL_SIM = 0.5;
const SERVER_SHARE = 0.6;
const MIN_WORDS = 3;

const STOP = new Set(
  "a an and are as at be but by can could do for from has have how i if in into is it its just me my of on or our please should so that the their them then there these this to up us was we what when where which will with would you your let lets now also any all some".split(
    " ",
  ),
);

/** Prompts the harness or a swarm wrote, not the person. */
const ENVELOPE_TAGS =
  /<(system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook|bash-input|bash-stdout)\b[\s\S]*?(?:<\/\1>|$)/gi;
const SWARM =
  /eminiar swarm|swarm brief|worker of the .{0,40}swarm|em_swarm|SubagentStart|swarm run \d{8}/i;

export interface ScanOptions {
  /** Report candidates without storing suggestions. */
  dryRun?: boolean | undefined;
  /** An embedding provider; `false` forces the lexical fallback. Default: the configured one. */
  embeddings?: EmbeddingProvider | false | undefined;
  /** Only events at or after this time (ms). */
  since?: number | undefined;
}

export interface Candidate {
  signature: string;
  title: string;
  prompt: string;
  servers: string[];
  sessions: number;
  days: number;
  tags: string[];
}

export interface ScanResult {
  /** "embeddings" or "lexical" (token overlap, used when no model is loaded). */
  mode: "embeddings" | "lexical";
  prompts: number;
  clusters: number;
  candidates: Candidate[];
  suggested: number;
  /** Candidates left out because they were seen before (any status, dismissed included). */
  known: number;
}

interface Item {
  session: string;
  ts: number;
  text: string;
  tokens: Set<string>;
  servers: Set<string>;
  vec?: Float32Array | undefined;
}

export function stripEnvelope(text: string): string {
  return text.replace(ENVELOPE_TAGS, " ").replace(/\s+/g, " ").trim();
}

/** Mostly code, commands or paths: not a recurring task description. */
export function isCodeHeavy(text: string): boolean {
  if (text.includes("```")) return true;
  const paths = text.match(/(?:[\w.~-]*\/)+[\w.-]+/g) ?? [];
  if (paths.length >= 2) return true;
  const stack = /^\s+at .+\(.*:\d+:\d+\)/m.test(text);
  if (stack) return true;
  const symbols = text.match(/[{}();=<>[\]\\|$]/g)?.length ?? 0;
  return symbols / Math.max(1, text.length) > 0.06;
}

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}

/** `mcp__claude_ai_Slack__x` and `mcp__plugin_engineering_slack__x` are both "slack". */
export function serverOf(tool: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(tool);
  if (!m?.[1]) return undefined;
  let s = m[1].toLowerCase();
  if (s.includes("eminiar")) return undefined;
  s = s.replace(/^claude_ai_/, "").replace(/^plugin_[a-z0-9]+_/, "");
  return s;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    d += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

function payloadText(payload: string): string {
  try {
    const p = JSON.parse(payload) as { text?: unknown };
    return typeof p.text === "string" ? p.text : "";
  } catch {
    return "";
  }
}

/** Order-independent id of a cluster's identity: its top tokens and servers. */
export function signatureOf(tokens: string[], servers: string[]): string {
  return createHash("sha256")
    .update(`${[...tokens].sort().join(",")}|${[...servers].sort().join(",")}`)
    .digest("hex")
    .slice(0, 16);
}

const SIG_RE = /\bsig:([0-9a-f]{16})\b/;

function loadItems(db: StorageAdapter, since: number | undefined): Item[] {
  const events = db
    .eventsRecent(EVENT_LIMIT, ["user_prompt", "mcp_tool", "subagent"])
    .filter((e) => since === undefined || e.ts >= since)
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
  const bySession = new Map<string, typeof events>();
  for (const e of events) {
    const l = bySession.get(e.session_id);
    if (l) l.push(e);
    else bySession.set(e.session_id, [e]);
  }
  const items: Item[] = [];
  for (const [session, evs] of bySession) {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e?.category !== "user_prompt") continue;
      const raw = payloadText(e.payload);
      if (SWARM.test(raw)) continue;
      const text = stripEnvelope(raw);
      if (text.length < 8 || text.startsWith("<") || text.startsWith("/")) continue;
      if (text.split(/\s+/).length < MIN_WORDS || isCodeHeavy(text)) continue;
      const servers = new Set<string>();
      let orchestration = false;
      for (let j = i + 1; j < evs.length; j++) {
        const n = evs[j];
        if (!n || n.category === "user_prompt" || n.ts - e.ts > WINDOW_MS) break;
        if (n.category === "mcp_tool" && n.tool) {
          const s = serverOf(n.tool);
          if (s) servers.add(s);
        } else if (n.category === "subagent" && SWARM.test(n.payload)) orchestration = true;
      }
      if (orchestration) continue;
      items.push({ session, ts: e.ts, text, tokens: tokenize(text), servers });
    }
  }
  return items;
}

async function embedAll(
  items: Item[],
  opt: ScanOptions,
  ctx: ProjectContext,
): Promise<"embeddings" | "lexical"> {
  if (opt.embeddings === false || !items.length) return "lexical";
  try {
    const p = opt.embeddings ?? (await getProvider(ctx.config));
    if (!p) return "lexical";
    if (!p.ready()) {
      p.warm();
      return "lexical";
    }
    const vecs = await p.embed(
      items.map((i) => i.text),
      "passage",
    );
    if (vecs.length !== items.length) return "lexical";
    items.forEach((it, i) => {
      it.vec = vecs[i];
    });
    return "embeddings";
  } catch {
    for (const it of items) it.vec = undefined;
    return "lexical";
  }
}

function similar(a: Item, b: Item, mode: "embeddings" | "lexical"): boolean {
  if (mode === "embeddings" && a.vec && b.vec) return cosine(a.vec, b.vec) >= EMBED_SIM;
  return jaccard(a.tokens, b.tokens) >= LEXICAL_SIM;
}

function topTokens(members: Item[], n: number): string[] {
  const df = new Map<string, number>();
  for (const m of members) for (const t of m.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  return [...df.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([t]) => t);
}

function toCandidate(members: Item[]): Candidate | undefined {
  const withServers = members.filter((m) => m.servers.size > 0);
  const count = new Map<string, number>();
  for (const m of withServers) for (const s of m.servers) count.set(s, (count.get(s) ?? 0) + 1);
  const servers = [...count.entries()]
    .filter(([, n]) => n >= MIN_SESSIONS && n / withServers.length >= SERVER_SHARE)
    .map(([s]) => s)
    .sort();
  if (!servers.length) return undefined;
  // only prompts whose tool window shares the server set count as evidence
  const evidence = members.filter((m) => servers.every((s) => m.servers.has(s)));
  const sessions = new Set(evidence.map((m) => m.session));
  const days = new Set(evidence.map((m) => Math.floor(m.ts / DAY_MS)));
  if (sessions.size < MIN_SESSIONS || days.size < MIN_DAYS) return undefined;
  const tokens = topTokens(evidence, 6);
  if (!tokens.length) return undefined;
  const freq = new Map<string, number>();
  for (const m of evidence) for (const t of m.tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  const score = (m: Item): number => {
    let s = 0;
    for (const t of m.tokens) s += freq.get(t) ?? 0;
    return s / Math.max(4, m.tokens.size);
  };
  const rep = [...evidence].sort((a, b) => score(b) - score(a) || a.ts - b.ts)[0] as Item;
  const title = `${tokens.slice(0, 4).join(" ")} (${servers.join(", ")})`;
  return {
    signature: signatureOf(tokens, servers),
    title: redactSecrets(title),
    prompt: redactSecrets(rep.text),
    servers,
    sessions: sessions.size,
    days: days.size,
    tags: servers,
  };
}

/**
 * Mine the project's history for recurring tasks and, unless `dryRun`, store each new
 * candidate as a pending suggestion. A candidate whose signature or prompt was suggested
 * before (pending, accepted or dismissed) is never proposed again.
 */
export async function scan(
  ctx: ProjectContext,
  db: StorageAdapter,
  opt: ScanOptions = {},
): Promise<ScanResult> {
  if (!ctx.config.playbooks.extraction.enabled)
    throw new Error("playbook extraction is off: set playbooks.extraction.enabled in the config");
  const items = loadItems(db, opt.since);
  const mode = await embedAll(items, opt, ctx);
  const clusters: Item[][] = [];
  for (const it of items) {
    const home = clusters.find((c) => c[0] && similar(c[0], it, mode));
    if (home) home.push(it);
    else clusters.push([it]);
  }
  const seen = new Set<string>();
  for (const s of db.playbooks.suggestions({ limit: 10_000 })) {
    const m = SIG_RE.exec(s.evidence ?? "");
    if (m?.[1]) seen.add(m[1]);
  }
  const candidates: Candidate[] = [];
  let known = 0;
  let suggested = 0;
  for (const c of clusters) {
    const cand = toCandidate(c);
    if (!cand) continue;
    if (seen.has(cand.signature)) {
      known++;
      continue;
    }
    seen.add(cand.signature);
    candidates.push(cand);
    if (opt.dryRun) continue;
    const r = suggest(ctx, db, {
      name: slugify(cand.title),
      title: cand.title,
      prompt: cand.prompt,
      tags: cand.tags,
      evidence: `sig:${cand.signature} seen in ${cand.sessions} sessions on ${cand.days} days; servers: ${cand.servers.join(", ")}`,
    });
    if (r.created) suggested++;
    else known++;
  }
  return { mode, prompts: items.length, clusters: clusters.length, candidates, suggested, known };
}
