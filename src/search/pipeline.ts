import type { StorageAdapter } from "../storage/adapter.js";
import type { ChunkWithDoc, ContentType, RecallSource, SearchFilters } from "../storage/types.js";
import { rrf } from "./fusion.js";
import { buildMatch, parseQuery } from "./query.js";
import { rerank, type Scored } from "./rerank.js";
import { regexSnippet, snippet } from "./snippets.js";
import { type Correction, correctTerms } from "./typo.js";

export type SearchMode = "hybrid" | "lexical" | "semantic" | "regex";

export interface SearchOptions {
  limit?: number;
  mode?: SearchMode;
  sort?: "relevance" | "timeline";
  filters?: SearchFilters;
  /** Optional: provided by the embeddings layer. Returns ranked chunk ids. */
  vectorSearch?:
    | ((query: string, k: number, filters?: SearchFilters) => Promise<number[]>)
    | undefined;
  candidates?: number;
  /**
   * Search the small recall index (memories, docs pages or captured errors) instead of the whole
   * chunk index: porter terms only, AND then OR, no typo correction, no vectors, `filters`
   * ignored. For hooks, whose cost must not grow with everything ever captured.
   */
  recall?: RecallSource | undefined;
}

export interface SearchHit {
  chunk: ChunkWithDoc;
  score: number;
  snippet: string;
  matched: string[];
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
  corrections: Correction[];
  /** Which rankers contributed. */
  used: string[];
}

const WEIGHTS = { porter: 1.0, trigram: 0.7, vector: 1.0 };

/** Lexical ranking: AND first, then OR to fill, for both tokenisers. */
function lexical(
  db: StorageAdapter,
  terms: string[],
  phrases: string[],
  filters: SearchFilters | undefined,
  n: number,
  recall?: RecallSource,
) {
  if (recall) {
    // The recall index: porter only, and the source is a column of the index itself. Terms are
    // prefix queries, the word-start semantics of the recall gate (sharedTerms), so an
    // abbreviation (`auth`, `config`, `repo`) still reaches a stemmed word (`authent`); there is
    // no trigram list on this path to catch it.
    const prefixed = {
      terms: terms.map((t) => (t.endsWith("*") ? t : `${t}*`)),
      phrases,
    };
    const ids = runLexical(prefixed, 1, n, (match) => db.recallSearch(recall, match, n));
    return { porter: ids, trigram: [] as number[] };
  }
  const parsed = { terms, phrases };
  const run = (kind: "porter" | "trigram", minLen: number) =>
    runLexical(parsed, minLen, n, (match) => db.ftsSearch(kind, match, n, filters));
  return { porter: run("porter", 1), trigram: run("trigram", 3) };
}

/** AND first, then OR to fill, through one query function. */
function runLexical(
  parsed: { terms: string[]; phrases: string[] },
  minLen: number,
  n: number,
  query: (match: string) => Array<{ chunkId: number }>,
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const mode of ["and", "or"] as const) {
    const match = buildMatch(parsed, mode, minLen);
    if (!match) break;
    for (const h of query(match)) {
      if (!seen.has(h.chunkId)) {
        seen.add(h.chunkId);
        ids.push(h.chunkId);
      }
    }
    if (ids.length >= n) break;
  }
  return ids;
}

export async function search(
  db: StorageAdapter,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const limit = opts.limit ?? 5;
  const n = opts.candidates ?? 50;
  const mode = opts.mode ?? "hybrid";
  if (mode === "regex") {
    // A scan, not a ranking: newest documents first, matching lines with context.
    const ids = db.chunkRegexSearch(query, "", Math.max(limit, 1), opts.filters);
    const re = new RegExp(query, "g");
    const hits: SearchHit[] = db.getChunks(ids).map((c) => ({
      chunk: c,
      score: 1,
      matched: [query],
      snippet: regexSnippet(c.body, re),
    }));
    if (opts.sort === "timeline")
      hits.sort((a, b) => b.chunk.document.created_at - a.chunk.document.created_at);
    return { query, hits, corrections: [], used: ["regex"] };
  }
  const parsed = parseQuery(query);
  const used: string[] = [];
  let corrections: Correction[] = [];
  let terms = parsed.terms;

  const lists: Array<{ ids: number[]; weight: number }> = [];
  if (mode !== "semantic") {
    // Typo correction reads the vocabulary of the whole index: not on the recall path.
    if (!opts.recall) {
      const corrected = correctTerms(db, terms);
      terms = corrected.terms;
      corrections = corrected.corrections;
    }
    const lex = lexical(db, terms, parsed.phrases, opts.filters, n, opts.recall);
    if (lex.porter.length) {
      lists.push({ ids: lex.porter, weight: WEIGHTS.porter });
      used.push("porter");
    }
    if (lex.trigram.length) {
      lists.push({ ids: lex.trigram, weight: WEIGHTS.trigram });
      used.push("trigram");
    }
  }
  if (mode !== "lexical" && opts.vectorSearch && !opts.recall) {
    try {
      const ids = await opts.vectorSearch(query, n, opts.filters);
      if (ids.length) {
        lists.push({ ids, weight: WEIGHTS.vector });
        used.push("vector");
      }
    } catch {
      // embeddings unavailable → lexical only
    }
  }

  const fused = rrf(lists);
  const top = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(limit * 4, 20));
  const chunks = db.getChunks(top.map(([id]) => id));
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const scored: Scored[] = top
    .map(([id, score]) => ({ chunk: byId.get(id)!, score, matched: [] as string[] }))
    .filter((s) => !!s.chunk);
  const allTerms = [...terms, ...parsed.phrases];
  const ranked = rerank(scored, allTerms);

  // Dedupe identical bodies and overlapping windows of the same document.
  const seenHash = new Set<string>();
  const seenSpan: Array<{ doc: number; a: number; b: number }> = [];
  const hits: SearchHit[] = [];
  for (const s of ranked) {
    const c = s.chunk;
    if (seenHash.has(c.hash)) continue;
    if (
      c.start_line &&
      c.end_line &&
      seenSpan.some((x) => x.doc === c.document_id && c.start_line! <= x.b && c.end_line! >= x.a)
    )
      continue;
    seenHash.add(c.hash);
    if (c.start_line && c.end_line)
      seenSpan.push({ doc: c.document_id, a: c.start_line, b: c.end_line });
    hits.push({
      chunk: c,
      score: s.score,
      matched: s.matched,
      snippet: snippet(c.body, allTerms, { wholeLines: c.content_type === "code" }),
    });
    if (hits.length >= limit) break;
  }
  if (opts.sort === "timeline")
    hits.sort((a, b) => b.chunk.document.created_at - a.chunk.document.created_at);
  return { query, hits, corrections, used };
}

export function contentTypeFilter(v: string | undefined): ContentType | undefined {
  return v === "code" || v === "prose" || v === "json" ? v : undefined;
}
