import type { ProjectContext } from "../context.js";
import { kickEmbedding } from "../embeddings/queue.js";
import { indexContent } from "../index/indexer.js";
import { formatResults } from "../search/format.js";
import { type SearchResponse, search } from "../search/pipeline.js";
import { getCurrentSession } from "../session/current.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { topTermsOf } from "../storage/terms.js";
import type { Source } from "../storage/types.js";

export interface ProcessInput {
  stdout: string;
  /**
   * As `cleanStderr` leaves it (the caller cleans once and reuses it). Returned after stdout under
   * STDERR_MARK, and indexed as a document of its own.
   */
  stderr?: string | undefined;
  title: string;
  source: Source;
  intent?: string | undefined;
  queries?: string[] | undefined;
  /** Index even when under the threshold (batch mode needs every output searchable). */
  forceIndex?: boolean | undefined;
  maxTokens?: number | undefined;
}

export interface Processed {
  text: string;
  /** The stdout document, or the stderr one when only stderr had text. */
  documentId?: number;
  /** Every document indexed: stdout's, then stderr's. */
  documentIds?: number[];
  chunks?: number;
  returnedChars: number;
}

const HEAD = 3 * 1024;
const TAIL = 1 * 1024;
const STDERR_BUDGET = 2 * 1024;
const STDERR_MARK = "--- stderr ---";

/**
 * stderr as it is returned and indexed. A `\r` that is not part of a CRLF starts a frame over
 * the previous one (curl's meter, npm's spinner), so only the last frame of each line is kept.
 * Anchored at line starts with a lookbehind, not `^` with `m`: `m` also matches after U+2028 and
 * U+2029, and unanchored, `[^\n]*` rescans the rest of the line from every position, quadratic.
 */
export function cleanStderr(stderr: string): string {
  return stderr.replace(/(?<![^\n])[^\n]*\r(?=[^\n])/g, "").trimEnd();
}

/**
 * One run's output as the model sees it: stdout, then the cleaned stderr after STDERR_MARK.
 * Jest, compilers and git report on stderr, so an `intent` has to find it too.
 */
export function joinOutput(stdout: string, stderr = ""): string {
  if (!stderr.trim()) return stdout;
  const gap = stdout === "" || stdout.endsWith("\n") ? "" : "\n";
  return `${stdout}${gap}${STDERR_MARK}\n${stderr}\n`;
}

/** stdout whole, then at most the last STDERR_BUDGET chars of stderr under the mark. */
function stderrTail(stdout: string, stderr: string): string {
  return joinOutput(stdout, boundStderr(stderr));
}

/** stderr as is when within STDERR_BUDGET, else its last STDERR_BUDGET chars after an omitted count. */
export function boundStderr(stderr: string): string {
  if (stderr.length <= STDERR_BUDGET) return stderr;
  const cut = stderr.length - STDERR_BUDGET;
  return `… ${cut} chars omitted …\n${stderr.slice(-STDERR_BUDGET)}`;
}

/**
 * Decide what the model gets to see. Small outputs are returned verbatim. Large
 * ones are indexed; with an intent/queries only matching sections come back
 * (plus a vocabulary of searchable terms), otherwise a head/tail preview and the
 * document id for follow-up `em_search` calls.
 */
export async function processOutput(
  db: StorageAdapter,
  ctx: ProjectContext,
  input: ProcessInput,
): Promise<Processed> {
  const threshold = ctx.config.sandbox.indexThreshold;
  const stderr = input.stderr ?? "";
  const out = joinOutput(input.stdout, stderr);
  // The threshold is about stdout alone: noisy stderr must not push a short stdout into a preview.
  const stdoutFits = input.stdout.length <= threshold;
  const stderrFits = stderr.length <= STDERR_BUDGET;
  if (!input.forceIndex && stdoutFits && stderrFits) {
    return { text: out, returnedChars: out.length };
  }
  if (!out.trim()) return { text: "", returnedChars: 0 };

  // One document per stream, so each is chunked as what it is: JSON on stdout stays json.
  const streams = [
    { title: input.title, content: input.stdout },
    { title: `${input.title} (stderr)`, content: input.stderr ?? "" },
  ].filter((s) => s.content.trim());
  const docs = streams.map((s) =>
    indexContent(db, {
      source: input.source,
      title: s.title,
      content: s.content,
      sessionId: getCurrentSession(ctx),
      meta: input.intent ? { intent: input.intent } : undefined,
    }),
  );
  const ids = docs.map((d) => d.documentId);
  const chunks = docs.reduce((n, d) => n + d.chunks, 0);
  // processOutput returned above when neither stream had text, so ids is never empty.
  const indexed = { documentId: ids[0]!, documentIds: ids, chunks };
  kickEmbedding(ctx, db);
  const queries = [...(input.queries ?? [])];
  if (input.intent && !queries.includes(input.intent)) queries.unshift(input.intent);

  if (stdoutFits && stderrFits) return { text: out, ...indexed, returnedChars: out.length };

  const lines: string[] = [];
  if (stdoutFits && !queries.length) {
    lines.push(stderrTail(input.stdout, stderr));
  } else if (queries.length) {
    const responses: SearchResponse[] = [];
    for (const q of queries) {
      responses.push(
        await search(db, q, {
          limit: 5,
          mode: "lexical",
          filters: { documentIds: ids },
        }),
      );
    }
    lines.push(formatResults(responses, input.maxTokens ?? 1500));
    // Vocabulary from these documents' chunks only; see topTermsOf for why not fts5vocab.
    const bodies = ids.flatMap((id) => db.chunksOfDocument(id).map((c) => c.body));
    const terms = topTermsOf(bodies, 40).map((t) => t.term);
    if (terms.length) lines.push(`\nsearchable terms: ${terms.join(", ")}`);
  } else {
    const o = input.stdout;
    lines.push(o.slice(0, HEAD));
    if (o.length > HEAD + TAIL) lines.push(`\n… ${o.length - HEAD - TAIL} chars omitted …\n`);
    lines.push(o.slice(-TAIL));
    if (stderr.trim()) lines.push(stderrTail("", stderr));
  }
  const docList = ids.join(", ");
  lines.push(
    `\n[indexed as doc${ids.length > 1 ? "s" : ""} ${docList} (${chunks} chunks, ${out.length} chars); em_search with document_ids: [${docList}] for more]`,
  );
  const text = lines.join("\n");
  return { text, ...indexed, returnedChars: text.length };
}
