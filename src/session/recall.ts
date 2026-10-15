import { fileId, fileOf } from "../graph/ids.js";
import { DEPENDENCY_KINDS } from "../graph/metrics.js";
import { type FileRisk, readFileRisk } from "../history/model.js";
import { search } from "../search/pipeline.js";
import { parseQuery } from "../search/query.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { MemoryRow } from "../storage/types.js";

/**
 * Proactive recall for hooks: the memories and documentation pages relevant to a prompt
 * (or a file about to be touched), delivered as context so Claude does not have to
 * remember to call em_recall / em_docs. Lexical only — hooks never load the embedding
 * model — and gated on matched terms so common words do not drag in noise. Each memory
 * or page is shown once per context window: the window restarts at the latest
 * session_start event (written on startup, compact and resume).
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
const RECALL_CATEGORY = "recall";

export interface RecallOptions {
  maxMemories?: number;
  maxDocs?: number;
  /** Skip what this session was already shown in the current context window. */
  sessionId?: string | undefined;
  /** Shared terms a hit needs; defaults to requiredMatches(term count). */
  minMatches?: number | undefined;
}

export interface RecallResult {
  /** Rendered lines, ready to inject (empty when nothing cleared the bar). */
  text: string;
  /** Keys shown (`memory:<name>`, `doc:<chunk id>`), for recordShown. */
  keys: string[];
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

/** Keys already shown since the latest session_start of this session. */
export function shownKeys(db: StorageAdapter, sessionId: string): Set<string> {
  const events = db.eventsBySession(sessionId, {
    categories: [RECALL_CATEGORY, "session_start"],
  });
  const out = new Set<string>();
  for (const e of events) {
    if (e.category === "session_start") {
      out.clear();
      continue;
    }
    try {
      for (const k of (JSON.parse(e.payload) as { keys?: string[] }).keys ?? []) out.add(k);
    } catch {
      // malformed payload: ignore
    }
  }
  return out;
}

/** Remember what was injected so the next prompt does not repeat it. */
export function recordShown(db: StorageAdapter, sessionId: string, keys: string[]): void {
  if (!keys.length) return;
  db.eventInsert({ sessionId, category: RECALL_CATEGORY, priority: 4, payload: { keys } });
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
  if (terms.length < 2 || (maxMemories <= 0 && maxDocs <= 0)) return { text: "", keys: [] };
  const need = opts.minMatches ?? requiredMatches(terms.length);
  const query = terms.join(" ");
  const seen = opts.sessionId ? shownKeys(db, opts.sessionId) : new Set<string>();
  const lines: string[] = [];
  const keys: string[] = [];

  if (maxMemories > 0) {
    const r = await search(db, query, {
      mode: "lexical",
      // room for the onboarding / superseded hits that are skipped below
      limit: maxMemories * 3 + 5,
      filters: { source: "memory" },
    });
    let n = 0;
    for (const h of r.hits) {
      if (n >= maxMemories) break;
      if (h.matched.length < need) continue;
      const uri = h.chunk.document.uri;
      const name = uri?.startsWith("memory:") ? uri.slice(7) : undefined;
      const m = name ? db.memoryGetByName(name) : undefined;
      const key = `memory:${name}`;
      if (!m?.name || !live(m) || !specific(m) || seen.has(key) || keys.includes(key)) continue;
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
      if (n >= maxDocs) break;
      if (h.matched.length < need) continue;
      const d = h.chunk.document;
      const key = `doc:${d.id}`;
      if (docsSeen.has(d.id) || seen.has(key)) continue;
      docsSeen.add(d.id);
      lines.push(`- ${d.source} › ${clip(d.title, 80)}: ${clip(h.snippet, 160)}`);
      keys.push(key);
      n++;
    }
  }

  if (!lines.length) return { text: "", keys: [] };
  return {
    text: [
      "eminiar recall — project memories and indexed docs that match this request (check them before deciding; superseded ones are omitted):",
      ...lines,
      'Full text: em_memory {action:"read", name} for a memory, em_docs {action:"lookup", query} for docs; em_recall {query} searches further.',
    ].join("\n"),
    keys,
  };
}

/** True when a memory's `related` ids name this file or a symbol inside it. */
function mentionsFile(m: MemoryRow, rel: string): boolean {
  if (!m.node_ids) return false;
  try {
    return (JSON.parse(m.node_ids) as string[]).some((id) => fileOf(id) === rel);
  } catch {
    return false;
  }
}

/**
 * Memories linked to a file (`related: [file:<path>]` or a `sym:<path>#…` in their
 * header), for a hook about to read or edit it: constraints first, onboarding left to the
 * brief, only those not yet shown in this context window. Scans the memory rows: a project
 * has tens of memories, not thousands.
 */
export function memoriesForFile(
  db: StorageAdapter,
  rel: string,
  opts: { sessionId?: string | undefined; max?: number } = {},
): RecallResult {
  const linked = db
    .memoryList({ limit: 1000 })
    .filter((m) => live(m) && specific(m) && mentionsFile(m, rel))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  if (!linked.length) return { text: "", keys: [] };
  const seen = opts.sessionId ? shownKeys(db, opts.sessionId) : new Set<string>();
  const lines: string[] = [];
  const keys: string[] = [];
  for (const m of linked) {
    if (lines.length >= (opts.max ?? 3)) break;
    const key = `memory:${m.name}`;
    if (!m.name || seen.has(key)) continue;
    lines.push(`${m.name} [${m.kind}]: ${gist(m, 140)}`);
    keys.push(key);
  }
  if (!lines.length) return { text: "", keys: [] };
  return {
    text: `eminiar memory: ${rel} is covered by ${lines.join(" · ")} — respect it (em_memory {action:"read", name} for the full text) or update the memory if this change overrides it.`,
    keys,
  };
}

// --- history, graph and error recall ------------------------------------------------

/** A file is worth a history warning from this risk, or with any traced bug origin. */
const RISKY = 0.3;
/** A file is worth a dependents note from this many other files depending on it. */
const FAN_IN = 5;

/**
 * Other files that import the file or use its symbols. Not the metrics fan-in: that also
 * counts calls from inside the file, so a self-contained script with helpers looked "widely
 * imported".
 */
function dependentFiles(db: StorageAdapter, paths: string[]): Map<string, number> {
  return db.graphDependentFileCounts(paths, DEPENDENCY_KINDS);
}

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
 * History and graph context for a file about to be edited: bug-prone files get their fix
 * record, heavily imported ones their fan-in. Once per file per context window; reads only
 * the persisted history table and the metrics row, never git.
 */
export function fileContext(
  db: StorageAdapter,
  rel: string,
  opts: { sessionId?: string | undefined } = {},
): RecallResult {
  const key = `file:${rel}`;
  if (opts.sessionId && shownKeys(db, opts.sessionId).has(key)) return { text: "", keys: [] };
  const lines: string[] = [];
  const f = readFileRisk(db)[rel];
  const risk = f ? riskLine(rel, f) : undefined;
  if (risk)
    lines.push(
      `eminiar history: ${risk}. em_history {action:"file", path:"${rel}"} shows those fixes; keep the behaviour they restored covered by a test.`,
    );
  const dependents = dependentFiles(db, [rel]).get(rel) ?? 0;
  if (dependents >= FAN_IN)
    lines.push(
      `eminiar graph: ${dependents} other files import or use ${rel}; em_graph_impact {node:"${fileId(rel)}"} lists them before you change an exported signature.`,
    );
  if (!lines.length) return { text: "", keys: [] };
  return { text: lines.join("\n"), keys: [key] };
}

/** Bug-prone and heavily imported files among those a commit is about to include. */
export function commitContext(db: StorageAdapter, files: string[]): string {
  if (!files.length) return "";
  const table = readFileRisk(db);
  const risky = files
    .map((p) => (table[p] ? riskLine(p, table[p]) : undefined))
    .filter((l): l is string => !!l)
    .slice(0, 4);
  const wide = [...dependentFiles(db, files)]
    .filter(([, n]) => n >= FAN_IN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([p, n]) => `${p} (${n} dependent files)`);
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
  opts: { sessionId?: string | undefined; maxMemories?: number } = {},
): Promise<RecallResult> {
  const terms = promptTerms(error.slice(0, 600)).filter((t) => !ERROR_FILLER.has(t));
  if (terms.length < 3) return { text: "", keys: [] };
  const need = Math.max(3, Math.ceil(terms.length * 0.4));
  const seen = opts.sessionId ? shownKeys(db, opts.sessionId) : new Set<string>();
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
    // error text is wordy (paths, module names): the same proportional bar as past errors
    minMatches: need,
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
