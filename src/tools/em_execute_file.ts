import { z } from "zod";
import { loadPermissionRules } from "../permissions/settings.js";
import { describeRun, execute } from "../sandbox/execute.js";
import { confinePath } from "../sandbox/file.js";
import { processOutput } from "../sandbox/output.js";
import { recordStat } from "../stats/record.js";
import { getStorage } from "../storage/index.js";
import { LANG_ENUM } from "./em_execute.js";
import { defineTool, errorResult, text } from "./types.js";

export const emExecuteFile = defineTool({
  name: "em_execute_file",
  description:
    "Process a file in the sandbox without reading it into context. Your code receives the absolute path as $EM_FILE (shell) / process.env.EM_FILE (node) / os.environ['EM_FILE'] (python); print only what you need. The file must be inside the project root unless a Read(<path>) allow rule opts it in; a matching Read deny or ask rule refuses the path, inside the root or out. Omit `code` to get a quick summary (size, lines, head).",
  schema: {
    path: z.string().describe("File to process, relative to the project root or absolute"),
    language: LANG_ENUM.optional(),
    code: z
      .string()
      .optional()
      .describe("Program to run against the file; default prints a summary"),
    intent: z.string().optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
    max_tokens: z.number().int().min(100).max(20_000).optional(),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    let file: string;
    try {
      file = confinePath(ctx.root, args.path, loadPermissionRules(ctx.root));
    } catch (err) {
      return errorResult((err as Error).message);
    }
    const language = args.language ?? "shell";
    const code =
      args.code ??
      'printf "%s\\n" "$EM_FILE"; wc -c -l "$EM_FILE" | tail -1; echo "--- head ---"; head -c 2000 "$EM_FILE"';
    let r: Awaited<ReturnType<typeof execute>>;
    try {
      r = await execute(ctx, {
        language,
        code,
        timeoutMs: args.timeout_ms,
        env: { EM_FILE: file },
      });
    } catch (err) {
      return errorResult((err as Error).message);
    }
    const processed = await processOutput(getStorage(ctx), ctx, {
      stdout: r.stdout,
      title: `file: ${args.path}`,
      source: "exec",
      intent: args.intent,
      maxTokens: args.max_tokens,
    });
    const parts = [describeRun(r)];
    if (processed.text) parts.push(processed.text);
    if (r.exitCode !== 0 && r.stderr.trim())
      parts.push(`stderr (tail):\n${r.stderr.trim().slice(-2048)}`);
    const out = parts.join("\n");
    recordStat(ctx, "em_execute_file", {
      rawChars: r.stdout.length + r.stderr.length,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});
