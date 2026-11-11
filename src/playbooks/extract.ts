import { createHash } from "node:crypto";
import { redactSecrets } from "../adjudicator/redact.js";
import type { ProjectContext } from "../context.js";
import { type EmbeddingProvider, getProvider } from "../embeddings/provider.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { playbookFingerprint } from "../storage/sqlite/playbooks.js";
import { PLAYBOOK_SUGGESTION_STATUSES, type PlaybookSuggestionRow } from "../storage/types.js";
import { assertCanScan, slugify, suggest } from "./store.js";

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
const EVENT_LIMIT = 20_000;
const EMBED_SIM = 0.82;
const LEXICAL_SIM = 0.5;
const SERVER_SHARE = 0.6;
const MIN_WORDS = 3;
/** The store refuses a longer prompt (MAX_PROMPT in store.ts); such a prompt is not a task description. */
const MAX_PROMPT_CHARS = 20_000;
/** The most recent prompts one scan looks at: bounds the clustering work. */
const MAX_PROMPTS = 3000;
/** The store returns at most this many suggestions per call. */
const PAGE = 1000;
const EMBED_BATCH = 256;
/** Give the event loop a turn after this many items, or this many comparisons. */
const YIELD_ITEMS = 64;
const YIELD_COMPARES = 20_000;
/** The store keeps at most this much evidence (MAX_NOTE in store.ts). */
const MAX_EVIDENCE = 500;
/** A suggestion's evidence keeps the cluster's most common words and short ids of its prompts. */
const PROFILE_WORDS = 8;
const ID_LEN = 8;
/** Past suggestions embedded again per scan in embeddings mode, newest first. */
const MAX_PAST_EMBED = 1000;

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
  /** IANA time zone whose calendar days are counted. Default: this machine's. */
  timeZone?: string | undefined;
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
  /** Prompts left out because the store would refuse them (longer than 20000 characters). */
  skipped: number;
  /** Candidates the store refused; they do not stop the others. */
  errors: string[];
  /** Set when the scan looked only at the most recent prompts. */
  truncated?: string;
}

interface Item {
  session: string;
  ts: number;
  text: string;
  tokens: Set<string>;
  servers: Set<string>;
  vec?: Float32Array | undefined;
}

/** The prompt without harness envelopes, line breaks kept (the code check reads line starts). */
function dropEnvelope(text: string): string {
  return text.replace(ENVELOPE_TAGS, " ").trim();
}

export function stripEnvelope(text: string): string {
  return dropEnvelope(text).replace(/\s+/g, " ").trim();
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

const nextTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Counts work and hands the event loop a turn now and then; never changes the result. */
class Pacer {
  private items = 0;
  private compares = 0;
  async item(): Promise<void> {
    if (++this.items >= YIELD_ITEMS) await this.flush();
  }
  async compare(n: number): Promise<void> {
    this.compares += n;
    if (this.compares >= YIELD_COMPARES) await this.flush();
  }
  private async flush(): Promise<void> {
    this.items = 0;
    this.compares = 0;
    await nextTurn();
  }
}

interface Loaded {
  items: Item[];
  skipped: number;
  truncated?: string;
}

async function loadItems(
  db: StorageAdapter,
  since: number | undefined,
  pace: Pacer,
): Promise<Loaded> {
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
  type Ev = (typeof events)[number];
  const refs: Array<{ evs: Ev[]; i: number; e: Ev }> = [];
  for (const evs of bySession.values()) {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e?.category === "user_prompt") refs.push({ evs, i, e });
    }
  }
  // Bound the work: only the most recent prompts are mined (ties broken by id, so it is stable).
  let truncated: string | undefined;
  let kept = refs;
  if (refs.length > MAX_PROMPTS) {
    const newest = new Set(
      [...refs]
        .sort((a, b) => b.e.ts - a.e.ts || b.e.id - a.e.id)
        .slice(0, MAX_PROMPTS)
        .map((r) => r.e.id),
    );
    kept = refs.filter((r) => newest.has(r.e.id));
    truncated = `looked at the ${MAX_PROMPTS} most recent of ${refs.length} prompts`;
  }
  const items: Item[] = [];
  let skipped = 0;
  for (const { evs, i, e } of kept) {
    await pace.item();
    const raw = payloadText(e.payload);
    if (SWARM.test(raw)) continue;
    const stripped = dropEnvelope(raw);
    if (stripped.length > MAX_PROMPT_CHARS) {
      skipped++;
      continue;
    }
    // Secrets are masked before anything is tokenized: the tokens build the title and name.
    // The code check runs on the text with its line breaks, so a stack trace is recognised.
    const body = redactSecrets(stripped).trim();
    const text = body.replace(/\s+/g, " ");
    if (text.length < 8 || text.startsWith("<") || text.startsWith("/")) continue;
    if (text.length > MAX_PROMPT_CHARS) {
      skipped++;
      continue;
    }
    if (text.split(/\s+/).length < MIN_WORDS || isCodeHeavy(body)) continue;
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
    items.push({ session: e.session_id, ts: e.ts, text, tokens: tokenize(text), servers });
  }
  return { items, skipped, ...(truncated ? { truncated } : {}) };
}

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) ** 2;
  const out = new Float32Array(v.length);
  if (n > 0) {
    const k = 1 / Math.sqrt(n);
    for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) * k;
  }
  return out;
}

/** Unit vectors of `texts` (identical texts share one), or undefined when the model fails. */
async function embedTexts(
  p: EmbeddingProvider,
  texts: string[],
): Promise<Map<string, Float32Array> | undefined> {
  const distinct = [...new Set(texts)];
  const byText = new Map<string, Float32Array>();
  for (let at = 0; at < distinct.length; at += EMBED_BATCH) {
    const batch = distinct.slice(at, at + EMBED_BATCH);
    const vecs = await p.embed(batch, "passage");
    if (vecs.length !== batch.length) return undefined;
    batch.forEach((t, i) => {
      const v = vecs[i];
      if (v) byText.set(t, unit(v));
    });
    await nextTurn();
  }
  return byText;
}

async function embedAll(
  items: Item[],
  opt: ScanOptions,
  ctx: ProjectContext,
): Promise<{ mode: "embeddings" | "lexical"; provider?: EmbeddingProvider }> {
  if (opt.embeddings === false || !items.length) return { mode: "lexical" };
  try {
    const p = opt.embeddings ?? (await getProvider(ctx.config));
    if (!p) return { mode: "lexical" };
    if (!p.ready()) {
      p.warm();
      return { mode: "lexical" };
    }
    // Identical prompts share one vector: a recurring task is the same text again and again.
    const byText = await embedTexts(
      p,
      items.map((i) => i.text),
    );
    if (!byText) return { mode: "lexical" };
    for (const it of items) it.vec = byText.get(it.text);
    return { mode: "embeddings", provider: p };
  } catch {
    for (const it of items) it.vec = undefined;
    return { mode: "lexical" };
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] ?? 0) * (b[i] ?? 0);
  return d;
}

/**
 * Greedy single pass: an item joins the first cluster whose first member it resembles, else it
 * starts one. Identical prompts join the cluster of their first occurrence without a comparison
 * (they would resolve to it anyway), and in word mode only clusters sharing a word with the
 * prompt are compared, so the cost stays well under every-prompt-against-every-cluster. The
 * result is exactly what the plain scan over all clusters in order would give.
 */
async function cluster(
  items: Item[],
  mode: "embeddings" | "lexical",
  pace: Pacer,
): Promise<Item[][]> {
  const clusters: Item[][] = [];
  const byText = new Map<string, number>();
  const byToken = new Map<string, number[]>();
  for (const it of items) {
    await pace.item();
    let home = byText.get(it.text);
    if (home === undefined) {
      if (mode === "embeddings" && it.vec) {
        const v = it.vec;
        await pace.compare(clusters.length);
        home = clusters.findIndex((c) => {
          const rep = c[0]?.vec;
          return rep ? dot(rep, v) >= EMBED_SIM : false;
        });
      } else {
        const near = new Set<number>();
        for (const t of it.tokens) for (const ci of byToken.get(t) ?? []) near.add(ci);
        await pace.compare(near.size);
        home = -1;
        for (const ci of [...near].sort((a, b) => a - b)) {
          const rep = clusters[ci]?.[0];
          if (rep && jaccard(rep.tokens, it.tokens) >= LEXICAL_SIM) {
            home = ci;
            break;
          }
        }
      }
      if (home < 0) {
        home = clusters.length;
        clusters.push([it]);
        for (const t of it.tokens) {
          const l = byToken.get(t);
          if (l) l.push(home);
          else byToken.set(t, [home]);
        }
        byText.set(it.text, home);
        continue;
      }
      byText.set(it.text, home);
    }
    clusters[home]?.push(it);
  }
  return clusters;
}

function topTokens(members: Item[], n: number): string[] {
  const df = new Map<string, number>();
  for (const m of members) for (const t of m.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  return [...df.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([t]) => t);
}

interface Mined {
  cand: Candidate;
  members: Item[];
  /** The member whose prompt is the candidate's. */
  rep: Item;
  /** The cluster's most common words among its evidence. */
  words: string[];
}

/** The calendar day of `ts` in `timeZone` (default: the machine's), as a sortable string. */
function dayCounter(timeZone: string | undefined): (ts: number) => string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (ts) => fmt.format(ts);
}

function toCandidate(members: Item[], dayOf: (ts: number) => string): Mined | undefined {
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
  const days = new Set(evidence.map((m) => dayOf(m.ts)));
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
    cand: {
      signature: signatureOf(tokens, servers),
      title: redactSecrets(title),
      prompt: redactSecrets(rep.text),
      servers,
      sessions: sessions.size,
      days: days.size,
      tags: servers,
    },
    members,
    rep,
    // only words most of the evidence shares: a stray prompt's own words are not the task's
    words: topTokens(evidence, PROFILE_WORDS).filter(
      (t) => 2 * (freq.get(t) ?? 0) > evidence.length,
    ),
  };
}

/**
 * Every suggestion ever stored, whatever its status. The store returns at most PAGE rows per
 * call and has no offset, so each status is read on its own; when one of them fills a page there
 * may be more, and the rest are read one by one by id (ids only grow, so none is missed).
 */
async function allSuggestions(db: StorageAdapter): Promise<PlaybookSuggestionRow[]> {
  const rows = new Map<number, PlaybookSuggestionRow>();
  let full = false;
  for (const status of PLAYBOOK_SUGGESTION_STATUSES) {
    const page = db.playbooks.suggestions({ status, limit: PAGE });
    for (const r of page) rows.set(r.id, r);
    if (page.length >= PAGE) full = true;
  }
  if (full) {
    const top = Math.max(0, ...rows.keys());
    for (let id = top; id >= 1; id--) {
      if (rows.has(id)) continue;
      const r = db.playbooks.suggestionGet(id);
      if (r) rows.set(id, r);
      if (id % 5000 === 0) await nextTurn();
    }
  }
  return [...rows.values()];
}

function parseTags(tags: string | null): string[] {
  try {
    const v: unknown = JSON.parse(tags ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const WORDS_RE = /; words: ([a-z0-9 -]+?)(?:;|$)/;
const IDS_RE = new RegExp(`; ids:((?: [0-9a-f]{${ID_LEN}})+)`);

const shortId = (text: string): string => playbookFingerprint(text).slice(0, ID_LEN);

/**
 * What a suggestion keeps of its whole cluster, bounded by the store's evidence limit: the
 * signature, the most common words and short ids of the member prompts (most frequent first),
 * so the task is recognised after those prompts have left the scan window.
 */
function identityOf(m: Mined): { ids: string[]; evidence: string } {
  const { cand } = m;
  const count = new Map<string, { n: number; ts: number }>();
  for (const it of m.members) {
    const c = count.get(it.text);
    if (c) c.n++;
    else count.set(it.text, { n: 1, ts: it.ts });
  }
  const order = [...count.entries()].sort(
    (a, b) => b[1].n - a[1].n || a[1].ts - b[1].ts || (a[0] < b[0] ? -1 : 1),
  );
  let evidence = `sig:${cand.signature} seen in ${cand.sessions} sessions on ${cand.days} days; servers: ${cand.servers.join(", ")}`;
  if (m.words.length) evidence += `; words: ${m.words.join(" ")}`;
  const ids: string[] = [];
  let tail = "; ids:";
  for (const id of new Set([shortId(m.rep.text), ...order.map(([t]) => shortId(t))])) {
    if (evidence.length + tail.length + 1 + ID_LEN > MAX_EVIDENCE) break;
    tail += ` ${id}`;
    ids.push(id);
  }
  if (ids.length) evidence += tail;
  return { ids, evidence };
}

interface Past {
  servers: Set<string>;
  /** The suggested prompt's words, and the cluster's most common words when they were kept. */
  words: Array<Set<string>>;
  vec?: Float32Array | undefined;
}

/**
 * What was proposed before, in terms that do not move when a cluster grows, a word changes, the
 * old prompts leave the scan window or the clustering switches between words and embeddings: the
 * signature, the fingerprints of the prompts, their words with the servers they were suggested
 * for and, in embeddings mode, the suggested prompts embedded again.
 */
class Known {
  private readonly sigs = new Set<string>();
  private readonly fps = new Set<string>();
  private readonly ids = new Set<string>();
  private readonly past: Past[] = [];
  /** Past prompts, newest suggestion first, for embedding. */
  private readonly prompts: Array<{ prompt: string; past: Past }> = [];

  constructor(rows: PlaybookSuggestionRow[]) {
    for (const r of [...rows].sort((a, b) => b.id - a.id)) {
      const ev = r.evidence ?? "";
      const m = SIG_RE.exec(ev);
      if (m?.[1]) this.sigs.add(m[1]);
      this.fps.add(r.fingerprint);
      for (const id of IDS_RE.exec(ev)?.[1]?.trim().split(" ") ?? []) this.ids.add(id);
      const words = WORDS_RE.exec(ev)?.[1]?.trim().split(" ") ?? [];
      const past = this.addPast(r.prompt, words, parseTags(r.tags));
      this.prompts.push({ prompt: r.prompt, past });
    }
  }

  private addPast(prompt: string, words: string[], servers: string[]): Past {
    const sets = [tokenize(prompt), new Set(words)].filter((s) => s.size > 0);
    const past: Past = { servers: new Set(servers), words: sets };
    this.past.push(past);
    return past;
  }

  /**
   * Embed the past prompts suggested for any of `servers` (the newest MAX_PAST_EMBED of them),
   * since only those can match; a model failure leaves words and ids.
   */
  async embed(p: EmbeddingProvider, servers: Set<string>): Promise<void> {
    const recent = this.prompts
      .filter((r) => [...r.past.servers].some((s) => servers.has(s)))
      .slice(0, MAX_PAST_EMBED);
    if (!recent.length) return;
    try {
      const byText = await embedTexts(
        p,
        recent.map((r) => r.prompt),
      );
      if (byText) for (const r of recent) r.past.vec = byText.get(r.prompt);
    } catch {
      // keep words and ids
    }
  }

  /** One prompt matches a past suggestion on a shared server, by text, words or vector. */
  private matches(it: Item, near: Past[]): boolean {
    const fp = playbookFingerprint(it.text);
    if (this.fps.has(fp) || this.ids.has(fp.slice(0, ID_LEN))) return true;
    for (const p of near) {
      for (const w of p.words) if (jaccard(w, it.tokens) >= LEXICAL_SIM) return true;
      if (it.vec && p.vec && dot(it.vec, p.vec) >= EMBED_SIM) return true;
    }
    return false;
  }

  /**
   * A new cluster is known when its signature was proposed before, or when more than half of its
   * prompts match a past suggestion: one stray prompt that also names an old task does not make
   * a new task known, and a tie is new (a task hidden by mistake never shows; one proposed again
   * by mistake is dismissed again, with this cluster's identity kept).
   */
  async has(m: Mined, pace: Pacer): Promise<boolean> {
    if (this.sigs.has(m.cand.signature)) return true;
    const near = this.past.filter((p) => m.cand.servers.some((s) => p.servers.has(s)));
    const texts = new Map<string, { it: Item; n: number }>();
    for (const it of m.members) {
      const t = texts.get(it.text);
      if (t) t.n++;
      else texts.set(it.text, { it, n: 1 });
    }
    let hit = 0;
    for (const { it, n } of texts.values()) {
      await pace.compare(near.length + 1);
      if (this.matches(it, near)) hit += n;
    }
    return 2 * hit > m.members.length;
  }

  /** Remember a suggestion made in this scan exactly as a later scan will read it back. */
  add(m: Mined, ids: string[]): void {
    this.sigs.add(m.cand.signature);
    this.fps.add(playbookFingerprint(m.cand.prompt));
    for (const id of ids) this.ids.add(id);
    const past = this.addPast(m.cand.prompt, m.words, m.cand.servers);
    past.vec = m.rep.vec;
  }
}

/**
 * Mine the project's history for recurring tasks and, unless `dryRun`, store each new
 * candidate as a pending suggestion. A candidate that matches an earlier suggestion (pending,
 * accepted or dismissed) is not proposed again, however its cluster has since grown, and also
 * after its old prompts left the window: each suggestion keeps its cluster's words and prompt
 * ids, and in embeddings mode a rewording the model places beside it matches too. In word mode a
 * rewording that shares under half its words with all of those is a different task. A cluster is
 * known only when most of its prompts match (see Known.has). The work is bounded (the most recent
 * prompts only, see `truncated`) and the event loop gets a turn between batches, so a scan does
 * not stall the server that runs it. It checks the config gate itself (store.assertCanScan:
 * viewing and extraction, plus adding unless dryRun), so a direct library call is refused exactly
 * as the CLI, tool and dashboard refuse it.
 */
export async function scan(
  ctx: ProjectContext,
  db: StorageAdapter,
  opt: ScanOptions = {},
): Promise<ScanResult> {
  assertCanScan(ctx, { dryRun: opt.dryRun });
  const pace = new Pacer();
  const { items, skipped, truncated } = await loadItems(db, opt.since, pace);
  const { mode, provider } = await embedAll(items, opt, ctx);
  const clusters = await cluster(items, mode, pace);
  const dayOf = dayCounter(opt.timeZone);
  const mined: Mined[] = [];
  for (const c of clusters) {
    const m = toCandidate(c, dayOf);
    if (m) mined.push(m);
  }
  const known = new Known(await allSuggestions(db));
  if (provider && mined.length) {
    await known.embed(provider, new Set(mined.flatMap((m) => m.cand.servers)));
  }
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  let knownCount = 0;
  let suggested = 0;
  for (const m of mined) {
    const { cand } = m;
    if (await known.has(m, pace)) {
      knownCount++;
      continue;
    }
    const { ids, evidence } = identityOf(m);
    known.add(m, ids);
    candidates.push(cand);
    if (opt.dryRun) continue;
    try {
      const r = suggest(ctx, db, {
        name: slugify(cand.title),
        title: cand.title,
        prompt: cand.prompt,
        tags: cand.tags,
        evidence,
      });
      if (r.created) suggested++;
      else knownCount++;
    } catch (e) {
      // one candidate the store refuses must not stop the others
      errors.push(`${cand.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    mode,
    prompts: items.length,
    clusters: clusters.length,
    candidates,
    suggested,
    known: knownCount,
    skipped,
    errors,
    ...(truncated ? { truncated } : {}),
  };
}
