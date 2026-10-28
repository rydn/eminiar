import { dispatch, gate } from "./hooks/dispatch.js";
import { hookLog } from "./hooks/log.js";

/**
 * Single hook entry point. hooks.json (Claude Code) and ~/.cursor/hooks.json (Cursor)
 * route every event here; we dispatch on `hook_event_name` from stdin and answer in the
 * dialect of whichever client called (`--client cursor`, or detected from the payload).
 * Contract: stdout is JSON only, exit 0 means "continue". We never exit non-zero — a
 * broken hook must not block the model — except `--gate` (decide-only swarm enforcement for a
 * user's `onFailure: "block"` entry), where any error exits 1.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (process.argv.includes("--gate")) {
    process.stdout.write(gate(raw));
    return;
  }
  process.stdout.write(await dispatch(raw, process.argv.slice(2)));
}

main().catch((err) => {
  hookLog("error", `fatal: ${(err as Error).stack ?? String(err)}`);
  if (process.argv.includes("--gate")) {
    // Gate mode fails closed: a non-zero exit makes the user's onFailure:"block" entry block.
    process.stderr.write(`eminiar hook --gate: ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  }
  process.stdout.write("{}");
});
