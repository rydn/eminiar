import { fileId, fileOf } from "../graph/ids.js";
import { type FileRisk, readFileRisk } from "../history/model.js";
import { search } from "../search/pipeline.js";
import { parseQuery } from "../search/query.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { EventRow, MemoryRow } from "../storage/types.js";

/**
 * Proactive recall for hooks: the memories and documentation pages relevant to a prompt
 * (or a file about to be touched), delivered as context so Claude does not have to
 * remember to call em_recall / em_docs. Lexical only — hooks never load the embedding
 * model — and gated on matched terms so common words do not drag in noise. A memory
 * whose slug or tags the prompt names clears the bar with a single term. Each memory
 * or page is shown once per context window (restarted at the latest session_start
 * event) and again once `repeatAfter` prompts have gone by, so knowledge skimmed past
 * early in a long session comes back when it matters. Every decision is recorded as a
 * `recall` event, fired or not, so em_stats and `eminiar recall --explain` can show why.
 */

/** Words that carry no topic in a prompt (on top of the search stopwords). */
const PROMPT_FILLER = new Set([
  "please",
  "can",
  "could",
  "would",
  "should",
  "you",
  "we",
  "me",
  "my",
  "our",
  "us",
  "let",
  "lets",
  "let's",
  "want",
  "need",
  "make",
  "use",
  "using",
  "add",
  "get",
  "now",
  "also",
  "just",
  "like",
  "then",
  "so",
  "not",
  "all",
  "any",
  "some",
  "into",
  "about",
  "there",
  "here",
  "have",
  "has",
  "will",
  "which",
  "them",
  "they",
  "its",
  "if",
  "than",
  "more",
  "once",
  "complete",
  "done",
  "work",
  "thing",
  "things",
  "sure",
  "ok",
  "okay",
  "thanks",
  "yes",
  "no",
]);

const MAX_TERMS = 16;
export const RECALL_CATEGORY = "recall";
/** Prompts after which an already shown item may be injected again (0 = never). */
export const DEFAULT_REPEAT_AFTER = 10;
/**
 * A single matched term is enough when it names the memory (slug word or tag) and the
 * prompt is short enough for that term to be its topic: at least this share of the terms.
 */
const NAME_MATCH_RATIO = 0.3;

export type RecallPath = "prompt" | "file" | "error" | "web" | "agent" | "commit";

export interface TraceCandidate {
  /** `memory:<name>` or `doc:<document id>`. */
  key: string;
  label: string;
  matched: string[];
  outcome: "shown" | "seen" | "gated" | "skipped" | "over-limit";
  why?: string | undefined;
}

/** Why a recall fired or stayed quiet: the terms, the bar and every candidate's fate. */
export interface RecallTrace {
  path: RecallPath;
  terms: string[];
  need: number;
  candidates: TraceCandidate[];
}

export interface RecallOptions {
  maxMemories?: number;
  maxDocs?: number;
  /** Skip what this session was already shown in the current context window. */
  sessionId?: string | undefined;
  /** Shared terms a hit needs; defaults to requiredMatches(term count). */
  minMatches?: number | undefined;
  /** Prompts after which a shown item may come back (default 10, 0 = never). */
  repeatAfter?: number | undefined;
  /** Collect a trace of every candidate (for recording and --explain). */
  trace?: boolean | undefined;
  path?: RecallPath | undefined;
}

export interface RecallResult {
  /** Rendered lines, ready to inject (empty when nothing cleared the bar). */
  text: string;
  /** Keys shown (`memory:<name>`, `doc:<chunk id>`), for recordShown. */
  keys: string[];
  trace?: RecallTrace | undefined;
}

/** Distinctive terms of a prompt: no stopwords, no filler, no slash command, capped. */
export function promptTerms(prompt: string): string[] {
  const body = prompt.replace(/^\s*\/\S+/, " ");
  return parseQuery(body)
    .terms.filter((t) => t.length >= 3 && !PROMPT_FILLER.has(t) && !/^\d+$/.test(t))
    .slice(0, MAX_TERMS);
}

/** Hits must share this many terms with the prompt: 2 for short prompts, 3 for long ones. */
export function requiredMatches(termCount: number): number {
  return Math.min(3, Math.max(2, Math.ceil(termCount * 0.2)));
}

/**
 * Keys shown recently enough to stay quiet: everything shown since the latest
 * session_start of this session, unless `repeatAfter` prompts have gone by since it
 * was shown (0 = never repeat inside a context window).
 */
export function shownKeys(
  db: StorageAdapter,
  sessionId: string,
  repeatAfter: number = DEFAULT_REPEAT_AFTER,
): Set<string> {
  const events = db.eventsBySession(sessionId, {
    categories: [RECALL_CATEGORY, "session_start", "user_prompt"],
  });
  const shownAt = new Map<string, number>();
  let prompts = 0;
  for (const e of events) {
    if (e.category === "session_start") {
      shownAt.clear();
      prompts = 0;
      continue;
    }
    if (e.category === "user_prompt") {
      prompts++;
      continue;
    }
    try {
      for (const k of (JSON.parse(e.payload) as { keys?: string[] }).keys ?? [])
        shownAt.set(k, prompts);
    } catch {
      // malformed payload: ignore
    }
  }
  const out = new Set<string>();
  for (const [k, at] of shownAt) if (repeatAfter <= 0 || prompts - at < repeatAfter) out.add(k);
  return out;
}

/**
 * Remember what was injected so the next prompt does not repeat it, and why: a quiet
 * decision is recorded too when a trace is given, so the hit rate can be measured.
 */
export function recordShown(
  db: StorageAdapter,
  sessionId: string,
  keys: string[],
  info: { path: RecallPath; trace?: RecallTrace | undefined } = { path: "prompt" },
): void {
  if (!keys.length && !info.trace) return;
  const t = info.trace;
  db.eventInsert({
    sessionId,
    category: RECALL_CATEGORY,
    priority: 4,
    payload: {
      keys,
      path: info.path,
      ...(t
        ? {
            terms: t.terms,
            need: t.need,
            candidates: t.candidates.length,
            gated: t.candidates
              .filter((c) => c.outcome !== "shown")
              .slice(0, 6)
              .map((c) => `${c.key} ${c.outcome}${c.why ? ` (${c.why})` : ""}`),
          }
        : {}),
    },
  });
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** First non-heading line of a memory body; a line ending in ":" takes the next one along. */
function gist(m: MemoryRow, max = 160): string {
  const lines = m.content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (!lines.length) return clip(m.content, max);
  const first = lines[0]!.trim();
  return clip(first.endsWith(":") && lines[1] ? `${first} ${lines[1].trim()}` : first, max);
}

/** Superseded and deprecated memories are history, not guidance. */
function live(m: MemoryRow): boolean {
  return m.status !== "superseded" && m.status !== "deprecated";
}

/**
 * Onboarding memories describe the whole project, so they match nearly every prompt; the
 * session brief already carries them. Prompt recall is for the specific ones.
 */
function specific(m: MemoryRow): boolean {
  return m.kind !== "onboarding";
}

/** Rules before rationale before notes, when only a few fit. */
const KIND_ORDER = ["constraint", "decision", "preference", "fact", "todo", "note"];
function kindRank(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

/**
 * Prompt terms that start a word of the text: a stem match (`write` ↔ `writers`), not the
 * reranker's substring one (`app` inside `capped`), so the bar counts real overlap.
 */
export function sharedTerms(terms: string[], ...texts: string[]): string[] {
  const hay = texts.join("\n").toLowerCase();
  return terms.filter((t) => {
    const base = t.replace(/\*$/, "").toLowerCase();
    return !!base && new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(base)}`, "u").test(hay);
  });
}

/** The words that name a memory: its slug split on separators, plus its tags. */
export function nameTerms(m: MemoryRow): string[] {
  const slug = (m.name ?? "").split("/").pop() ?? "";
  let tags: string[] = [];
  try {
    tags = m.tags ? (JSON.parse(m.tags) as string[]) : [];
  } catch {
    // no tags
  }
  return [...slug.toLowerCase().split(/[-._]+/), ...tags.map((t) => t.toLowerCase())].filter(
    (t) => t.length >= 4,
  );
}

/** A prompt term names the memory when it equals, contains or is contained in a slug word or tag (`em_history` ↔ `history`). */
function namesMemory(term: string, names: string[]): boolean {
  const t = term.replace(/\*$/, "");
  if (t.length < 4) return false;
  return names.some((n) => t === n || t.includes(n) || n.includes(t));
}

/**
 * Whether a memory hit clears the bar: enough shared terms, the prompt naming the memory
 * outright, or one shared term that is a slug word or tag of a prompt short enough for
 * that term to be its topic.
 */
export function qualifies(
  matched: string[],
  need: number,
  termCount: number,
  m?: MemoryRow,
  text?: string,
): { ok: boolean; why?: string } {
  if (matched.length >= need) return { ok: true };
  if (m?.name && text?.toLowerCase().includes(m.name)) return { ok: true, why: "named" };
  if (m && matched.length >= 1 && matched.length / Math.max(1, termCount) >= NAME_MATCH_RATIO) {
    const names = nameTerms(m);
    const hit = matched.find((t) => namesMemory(t, names));
    if (hit) return { ok: true, why: `slug/tag "${hit}"` };
  }
  return { ok: false, why: `${matched.length}/${need} terms` };
}

/**
 * Memories and documentation pages relevant to free text (a prompt, a subagent task).
 * Returns empty text when the prompt is too vague or nothing shares enough terms.
 */
export async function recallForText(
  db: StorageAdapter,
  text: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const maxMemories = opts.maxMemories ?? 3;
  const maxDocs = opts.maxDocs ?? 2;
  const terms = promptTerms(text);
  const trace: RecallTrace | undefined = opts.trace
    ? { path: opts.path ?? "prompt", terms, need: 0, candidates: [] }
    : undefined;
  const quiet = (): RecallResult => ({ text: "", keys: [], trace });
  if (terms.length < 2 || (maxMemories <= 0 && maxDocs <= 0)) return quiet();
  const need = opts.minMatches ?? requiredMatches(terms.length);
  if (trace) trace.need = need;
  const query = terms.join(" ");
  const seen = opts.sessionId ? shownKeys(db, opts.sessionId, opts.repeatAfter) : new Set<string>();
  const lines: string[] = [];
  const keys: string[] = [];
  const note = (c: TraceCandidate) => trace?.candidates.push(c);

  if (maxMemories > 0) {
    const r = await search(db, query, {
      mode: "lexical",
      // room for the onboarding / superseded hits that are skipped below
      limit: maxMemories * 3 + 5,
      filters: { source: "memory" },
    });
    let n = 0;
    // a memory has several chunks; decide (and trace) each memory once
    const considered = new Set<string>();
    for (const h of r.hits) {
      const uri = h.chunk.document.uri;
      const name = uri?.startsWith("memory:") ? uri.slice(7) : undefined;
      const m = name ? db.memoryGetByName(name) : undefined;
      const key = `memory:${name}`;
      if (!m?.name || considered.has(key)) continue;
      considered.add(key);
      const label = `${m.name} [${m.kind}]`;
      const matched = sharedTerms(terms, m.name, m.content, m.tags ?? "");
      if (!live(m)) {
        note({ key, label, matched, outcome: "skipped", why: m.status ?? "retired" });
        continue;
      }
      if (!specific(m)) {
        note({ key, label, matched, outcome: "skipped", why: "onboarding" });
        continue;
      }
      const q = qualifies(matched, need, terms.length, m, text);
      if (!q.ok) {
        note({ key, label, matched, outcome: "gated", why: q.why });
        continue;
      }
      if (seen.has(key)) {
        note({ key, label, matched, outcome: "seen", why: q.why });
        continue;
      }
      if (n >= maxMemories) {
        note({ key, label, matched, outcome: "over-limit", why: q.why });
        continue;
      }
      note({ key, label, matched, outcome: "shown", why: q.why });
      lines.push(`- memory ${m.name} [${m.kind}]: ${gist(m)}`);
      keys.push(key);
      n++;
    }
  }

  if (maxDocs > 0) {
    const r = await search(db, query, {
      mode: "lexical",
      limit: maxDocs * 3,
      filters: { sourcePrefix: "docs:" },
    });
    let n = 0;
    const docsSeen = new Set<number>();
    for (const h of r.hits) {
      const d = h.chunk.document;
      const key = `doc:${d.id}`;
      if (docsSeen.has(d.id)) continue;
      docsSeen.add(d.id);
      const label = `${d.source} › ${clip(d.title, 60)}`;
      const matched = sharedTerms(terms, h.chunk.title, h.chunk.body);
      if (matched.length < need) {
        note({ key, label, matched, outcome: "gated", why: `${matched.length}/${need} terms` });
        continue;
      }
      if (seen.has(key)) {
        note({ key, label, matched, outcome: "seen" });
        continue;
      }
      if (n >= maxDocs) {
        note({ key, label, matched, outcome: "over-limit" });
        continue;
      }
      note({ key, label, matched, outcome: "shown" });
      lines.push(`- ${d.source} › ${clip(d.title, 80)}: ${clip(h.snippet, 160)}`);
      keys.push(key);
      n++;
    }
  }

  if (!lines.length) return quiet();
  return {
    text: [
      "eminiar recall — project memories and indexed docs that match this request (check them before deciding; superseded ones are omitted):",
      ...lines,
      'Full text: em_memory {action:"read", name} for a memory, em_docs {action:"lookup", query} for docs; em_recall {query} searches further.',
    ].join("\n"),
    keys,
    trace,
  };
}

// --- file recall ------------------------------------------------------------------------

const SYMBOL_KINDS = [
  "function",
  "class",
  "method",
  "interface",
  "trait",
  "type",
  "enum",
  "variable",
];

/** Names of the symbols the graph defines in a file (for memories that mention them). */
export function fileSymbols(db: StorageAdapter, rel: string): string[] {
  try {
    return db
      .graphFindNodes({ path: rel, kinds: SYMBOL_KINDS, limit: 400 })
      .filter((n) => n.path === rel)
      .map((n) => n.name);
  } catch {
    return [];
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when a memory's `related` ids (header or implied) name this file or a symbol inside it. */
function linksFile(m: MemoryRow, rel: string): boolean {
  if (!m.node_ids) return false;
  try {
    return (JSON.parse(m.node_ids) as string[]).some((id) => fileOf(id) === rel);
  } catch {
    return false;
  }
}

/** The body names the path outright (bare, in backticks, or as `./path`), not as a suffix of a longer path. */
export function bodyNamesPath(body: string, rel: string): boolean {
  return new RegExp(`(?:^|[^\\w/.-]|\\./)${escapeRe(rel)}(?![\\w-])`, "m").test(body);
}

/**
 * A pattern for the file's symbols as prose names them: in backticks, qualified
 * (`Class.method`, `file#fn`) or called (`fn(`). Short names are left out: a bare `run`
 * or `main` says nothing about which file is meant.
 */
export function symbolMentionPattern(symbols: string[]): RegExp | undefined {
  const names = [...new Set(symbols)].filter((s) => /^[A-Za-z_$][\w$]{4,}$/.test(s));
  if (!names.length) return undefined;
  const alt = names.map(escapeRe).join("|");
  return new RegExp(`(?:[\`#.](?:${alt})(?!\\w)|(?<!\\w)(?:${alt})\\()`);
}

/**
 * Memories about a file, for a hook about to read or edit it: those whose `related`
 * header or implied links name the file or a symbol in it, those whose body names the
 * path, and those that name one of the file's symbols. Constraints first, onboarding
 * left to the brief, only those not shown recently in this context window. Scans the
 * memory rows: a project has tens of memories, not thousands.
 */
export function memoriesForFile(
  db: StorageAdapter,
  rel: string,
  opts: {
    sessionId?: string | undefined;
    max?: number;
    /** Names of the symbols defined in the file (from the graph), for body mentions. */
    symbols?: string[] | undefined;
    repeatAfter?: number | undefined;
    trace?: boolean | undefined;
  } = {},
): RecallResult {
  const symRe = opts.symbols?.length ? symbolMentionPattern(opts.symbols) : undefined;
  const how = (m: MemoryRow): string | undefined => {
    if (linksFile(m, rel)) return "related";
    if (bodyNamesPath(m.content, rel)) return "names the path";
    if (symRe?.test(m.content)) return "names a symbol";
    return undefined;
  };
  const trace: RecallTrace | undefined = opts.trace
    ? { path: "file", terms: [rel], need: 0, candidates: [] }
    : undefined;
  const linked = db
    .memoryList({ limit: 1000 })
    .map((m) => ({ m, why: how(m) }))
    .filter((x): x is { m: MemoryRow; why: string } => !!x.why && live(x.m) && specific(x.m))
    .sort((a, b) => kindRank(a.m.kind) - kindRank(b.m.kind));
  if (!linked.length) return { text: "", keys: [], trace };
  const seen = opts.sessionId ? shownKeys(db, opts.sessionId, opts.repeatAfter) : new Set<string>();
  const lines: string[] = [];
  const keys: string[] = [];
  for (const { m, why } of linked) {
    const key = `memory:${m.name}`;
    const label = `${m.name} [${m.kind}]`;
    if (!m.name) continue;
    if (seen.has(key)) {
      trace?.candidates.push({ key, label, matched: [rel], outcome: "seen", why });
      continue;
    }
    if (lines.length >= (opts.max ?? 3)) {
      trace?.candidates.push({ key, label, matched: [rel], outcome: "over-limit", why });
      continue;
    }
    trace?.candidates.push({ key, label, matched: [rel], outcome: "shown", why });
    lines.push(`${m.name} [${m.kind}]: ${gist(m, 140)}`);
    keys.push(key);
  }
  if (!lines.length) return { text: "", keys: [], trace };
  return {
    text: `eminiar memory: ${rel} is covered by ${lines.join(" · ")} — respect it (em_memory {action:"read", name} for the full text) or update the memory if this change overrides it.`,
    keys,
    trace,
  };
}

// --- history, graph and error recall ------------------------------------------------

/** A file is worth a history warning from this risk, or with any traced bug origin. */
const RISKY = 0.3;
/** A file is worth a dependents note from this many importers. */
const FAN_IN = 5;

function riskLine(path: string, f: FileRisk): string | undefined {
  if (f.risk < RISKY && !f.bugOrigins) return undefined;
  const parts = [`${f.fixes}/${f.commits} commits were fixes`];
  if (f.bugOrigins)
    parts.push(
      `${f.bugOrigins} earlier change${f.bugOrigins === 1 ? "" : "s"} later needed fixing`,
    );
  if (f.lastFix) parts.push(`last fix ${f.lastFix}`);
  return `${path} is bug-prone (${parts.join("; ")})`;
}

/**
 * History and graph context for a file about to be read or edited: bug-prone files get
 * their fix record on a read or an edit, heavily imported ones their fan-in before an
 * edit. Each once per file per context window (and again after `repeatAfter` prompts);
 * reads only the persisted history table and the metrics row, never git.
 */
export function fileContext(
  db: StorageAdapter,
  rel: string,
  opts: { sessionId?: string | undefined; edit?: boolean | undefined; repeatAfter?: number } = {},
): RecallResult {
  const seen = opts.sessionId ? shownKeys(db, opts.sessionId, opts.repeatAfter) : new Set<string>();
  const lines: string[] = [];
  const keys: string[] = [];
  const histKey = `hist:${rel}`;
  if (!seen.has(histKey)) {
    const f = readFileRisk(db)[rel];
    const risk = f ? riskLine(rel, f) : undefined;
    if (risk) {
      lines.push(
        `eminiar history: ${risk}. em_history {action:"file", path:"${rel}"} shows those fixes; keep the behaviour they restored covered by a test.`,
      );
      keys.push(histKey);
    }
  }
  const fanKey = `fanin:${rel}`;
  if (opts.edit && !seen.has(fanKey)) {
    const fanIn = db.metricsGet([fileId(rel)])[0]?.fan_in ?? 0;
    if (fanIn >= FAN_IN) {
      lines.push(
        `eminiar graph: ${rel} is imported by ${fanIn} files; em_graph_impact {node:"${fileId(rel)}"} lists them before you change an exported signature.`,
      );
      keys.push(fanKey);
    }
  }
  if (!lines.length) return { text: "", keys: [] };
  return { text: lines.join("\n"), keys };
}

/** Bug-prone and heavily imported files among those a commit is about to include. */
export function commitContext(db: StorageAdapter, files: string[]): string {
  if (!files.length) return "";
  const table = readFileRisk(db);
  const risky = files
    .map((p) => (table[p] ? riskLine(p, table[p]) : undefined))
    .filter((l): l is string => !!l)
    .slice(0, 4);
  const wide = db
    .metricsGet(files.map(fileId))
    .filter((m) => m.fan_in >= FAN_IN)
    .sort((a, b) => b.fan_in - a.fan_in)
    .slice(0, 4)
    .map((m) => `${m.path} (${m.fan_in} importers)`);
  if (!risky.length && !wide.length) return "";
  const lines = ["eminiar history: this commit includes files that deserve a second look:"];
  for (const r of risky) lines.push(`- ${r}`);
  if (wide.length) lines.push(`- widely imported: ${wide.join(", ")}`);
  lines.push(
    'em_history {action:"risk"} rates the whole change; em_graph_changes shows what it reaches. Make sure tests cover the risky paths.',
  );
  return lines.join("\n");
}

/** Words every error message shares; they say nothing about which error it is. */
const ERROR_FILLER = new Set([
  "error",
  "errors",
  "failed",
  "fail",
  "failure",
  "exit",
  "code",
  "status",
  "command",
  "line",
  "cannot",
  "unable",
  "unexpected",
  "warning",
  "stderr",
  "stdout",
]);

function eventIdOf(meta: string | null): number | undefined {
  if (!meta) return undefined;
  try {
    const id = (JSON.parse(meta) as { eventId?: unknown }).eventId;
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}

function resolutionAfter(
  db: StorageAdapter,
  sessionId: string | null,
  eventId: number | undefined,
): string | undefined {
  if (!sessionId || eventId === undefined) return undefined;
  const fix = db
    .eventsBySession(sessionId, { categories: ["error_resolution"] })
    .find((e) => e.id > eventId);
  if (!fix) return undefined;
  try {
    return (JSON.parse(fix.payload) as { text?: string }).text;
  } catch {
    return undefined;
  }
}

/**
 * Earlier occurrences of a tool error (captured as session events) with the resolution
 * recorded after them, plus the memories that mention it. Call before the new error is
 * persisted, so it does not find itself.
 */
export async function recallForError(
  db: StorageAdapter,
  error: string,
  opts: { sessionId?: string | undefined; maxMemories?: number; repeatAfter?: number } = {},
): Promise<RecallResult> {
  const terms = promptTerms(error.slice(0, 600)).filter((t) => !ERROR_FILLER.has(t));
  if (terms.length < 3) return { text: "", keys: [] };
  const need = Math.max(3, Math.ceil(terms.length * 0.4));
  const seen = opts.sessionId ? shownKeys(db, opts.sessionId, opts.repeatAfter) : new Set<string>();
  const past: string[] = [];
  const keys: string[] = [];

  const r = await search(db, terms.join(" "), {
    mode: "lexical",
    limit: 10,
    filters: { source: "session" },
  });
  for (const h of r.hits) {
    if (past.length >= 2) break;
    const d = h.chunk.document;
    if (d.title !== "error" || h.matched.length < need) continue;
    const id = eventIdOf(d.meta);
    const key = `err:${id ?? d.id}`;
    if (seen.has(key)) continue;
    const when = new Date(d.created_at).toISOString().slice(0, 10);
    const fix = resolutionAfter(db, d.session_id, id);
    past.push(
      `- ${when}: ${clip(h.chunk.body, 140)}${fix ? ` → then: ${clip(fix, 160)}` : " (no resolution recorded)"}`,
    );
    keys.push(key);
  }

  const mem = await recallForText(db, terms.join(" "), {
    maxMemories: opts.maxMemories ?? 2,
    maxDocs: 0,
    sessionId: opts.sessionId,
    repeatAfter: opts.repeatAfter,
    // error text is wordy (paths, module names): the same proportional bar as past errors
    minMatches: need,
    path: "error",
  });
  const memLines = mem.text.split("\n").filter((l) => l.startsWith("- memory "));
  if (!past.length && !memLines.length) return { text: "", keys: [] };
  return {
    text: [
      past.length
        ? "eminiar recall — this error has been seen before:"
        : "eminiar recall — memories that mention this error:",
      ...past,
      ...memLines,
      'em_recall {query} searches further; em_memory {action:"read", name} for a memory.',
    ].join("\n"),
    keys: [...keys, ...mem.keys],
  };
}

// --- observability ----------------------------------------------------------------------

export interface RecallStats {
  decisions: number;
  byPath: Record<string, { fired: number; quiet: number; items: number }>;
  /** Most common reasons candidates stayed out, with counts. */
  gated: Array<{ why: string; n: number }>;
}

/** Tally the recorded `recall` events: how often each path fired, and what kept candidates out. */
export function recallStats(events: EventRow[]): RecallStats {
  const byPath: RecallStats["byPath"] = {};
  const gated = new Map<string, number>();
  let decisions = 0;
  for (const e of events) {
    if (e.category !== RECALL_CATEGORY) continue;
    let p: { keys?: string[]; path?: string; gated?: string[] };
    try {
      p = JSON.parse(e.payload) as typeof p;
    } catch {
      continue;
    }
    decisions++;
    const path = p.path ?? "file";
    byPath[path] ??= { fired: 0, quiet: 0, items: 0 };
    const row = byPath[path];
    const n = p.keys?.length ?? 0;
    if (n) {
      row.fired++;
      row.items += n;
    } else row.quiet++;
    for (const g of p.gated ?? []) {
      // "memory:x gated (1/2 terms)" → "gated (1/2 terms)"; keep the reason, drop the key
      const why = g.replace(/^\S+\s+/, "").replace(/\d+\/\d+ terms/, "too few terms");
      gated.set(why, (gated.get(why) ?? 0) + 1);
    }
  }
  return {
    decisions,
    byPath,
    gated: [...gated.entries()]
      .map(([why, n]) => ({ why, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 6),
  };
}

export function formatRecallStats(title: string, s: RecallStats): string {
  if (!s.decisions) return `${title}: no recall decisions recorded yet`;
  const paths = Object.entries(s.byPath)
    .sort((a, b) => b[1].fired + b[1].quiet - (a[1].fired + a[1].quiet))
    .map(([path, r]) => {
      const total = r.fired + r.quiet;
      return `${path} ${r.fired}/${total} fired (${Math.round((100 * r.fired) / total)}%, ${r.items} items)`;
    });
  const lines = [`${title}: ${s.decisions} decision(s) — ${paths.join(" · ")}`];
  if (s.gated.length)
    lines.push(`  held back: ${s.gated.map((g) => `${g.why} ×${g.n}`).join(", ")}`);
  return lines.join("\n");
}
