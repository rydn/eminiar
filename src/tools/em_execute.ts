import { z } from "zod";
import { describeRun, execute } from "../sandbox/execute.js";
import { cleanStderr, processOutput } from "../sandbox/output.js";
import { recordStat } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { defineTool, errorResult, RUNS_CODE, text } from "./types.js";

export const LANG_ENUM = z
  .string()
  .describe(
    "shell | javascript | typescript | python | ruby | go | php | perl | r | elixir | rust | csharp (others only if installed)",
  );

export const emExecute = defineTool({
  name: "em_execute",
  annotations: RUNS_CODE,
  description:
    "Run code in a sandbox inside the project root and return its stdout, then its stderr after a `--- stderr ---` line. Output over the index threshold (5 KB) is indexed; pass `intent` to get back just the matching sections plus a vocabulary of searchable terms. Use this instead of Bash for anything that prints a lot: git log/diff, test runs, dependency trees, logs, API calls. Shell snippets honour Claude Code's Bash deny rules. javascript and typescript run as ES modules; `import` and `require` both work.",
  schema: {
    language: LANG_ENUM,
    code: z.string().min(1).describe("Program or shell script to run"),
    intent: z
      .string()
      .optional()
      .describe(
        "What you are looking for in the output; drives section selection for large outputs",
      ),
    queries: z.array(z.string()).optional().describe("Extra search queries against the output"),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
    max_tokens: z.number().int().min(100).max(20_000).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    let r: Awaited<ReturnType<typeof execute>>;
    try {
      r = await execute(ctx, {
        language: args.language,
        code: args.code,
        timeoutMs: args.timeout_ms,
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
    // Cleaned once: the output, the stderr document, the header and the tail all use it.
    const stderr = cleanStderr(r.stderr);
    const db = getStorage(ctx);
    const processed = await processOutput(db, ctx, {
      stdout: r.stdout,
      stderr,
      // Never use the intent as the title: it would match every chunk via the title boost.
      title: `${args.language}: ${args.code.split("\n")[0]?.slice(0, 60) ?? ""}`,
      source: "exec",
      intent: args.intent,
      queries: args.queries,
      maxTokens: args.max_tokens,
    });
    const header = describeRun({ ...r, stderr });
    const parts = [header];
    if (processed.text) parts.push(processed.text);
    // stderr is part of the output. When a search picked what came back, still show how a
    // failure ended; without one the preview's tail already does.
    const searched = !!args.intent || !!args.queries?.length;
    if (r.exitCode !== 0 && stderr && processed.documentId !== undefined && searched)
      parts.push(`stderr (tail):\n${stderr.slice(-2048)}`);
    const out = parts.join("\n");
    recordStat(ctx, "em_execute", {
      rawChars: r.stdout.length + r.stderr.length,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return r.exitCode === 0 ? text(out) : { ...text(out), isError: !r.stdout.trim() };
  },
});
