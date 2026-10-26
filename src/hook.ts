import { dispatch } from "./hooks/dispatch.js";
import { hookLog } from "./hooks/log.js";

/**
 * Single hook entry point. hooks.json (Claude Code) and ~/.cursor/hooks.json (Cursor)
 * route every event here; we dispatch on `hook_event_name` from stdin and answer in the
 * dialect of whichever client called (`--client cursor`, or detected from the payload).
 * Contract: stdout is JSON only, exit 0 means "continue". We never exit non-zero — a
 * broken hook must not block the model.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  process.stdout.write(await dispatch(raw, process.argv.slice(2)));
}

main().catch((err) => {
  hookLog("error", `fatal: ${(err as Error).stack ?? String(err)}`);
  process.stdout.write("{}");
});
