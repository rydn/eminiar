import { lockWaitFor } from "./hooks/budget.js";
import { dispatch, gate, ranLate } from "./hooks/dispatch.js";
import { hookLog } from "./hooks/log.js";
import { setStorageBusyTimeout } from "./storage/index.js";

/**
 * Single hook entry point. hooks.json (Claude Code) and ~/.cursor/hooks.json (Cursor)
 * route every event here; we dispatch on `hook_event_name` from stdin and answer in the
 * dialect of whichever client called (`--client cursor`, or detected from the payload).
 * Contract: stdout is JSON only, exit 0 means "continue". We never exit non-zero — a
 * broken hook must not block the model — except `--gate` (decide-only swarm enforcement for a
 * user's `onFailure: "block"` entry), where any error exits 1.
 * `--adjudicate` is the adjudicator's detached async job (src/adjudicator/async.ts): the job JSON
 * arrives on stdin, nobody reads stdout, and a hard timer ends the process however the job goes.
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
  if (process.argv.includes("--adjudicate")) {
    // Loaded only here: the engine, providers and their config parsing stay out of every
    // ordinary hook process (the adjudicator is off by default).
    const { ASYNC_JOB_MAX_MS, runAsyncJob } = await import("./adjudicator/async.js");
    setTimeout(() => process.exit(0), ASYNC_JOB_MAX_MS).unref();
    await runAsyncJob(raw, { log: (line) => hookLog("info", line) });
    return;
  }
  // A hook run has seconds, not minutes: a locked database is skipped after a short wait
  // instead of the CLI's 2 s per statement, which a handler's statements add up (budget.ts).
  // Hooks whose job is a write wait longer than the read-only ones, Cursor's included (budget.ts).
  setStorageBusyTimeout(lockWaitFor(raw, process.argv.slice(2)));
  // startedAt 0 is this process's start on the performance clock: the soft budget counts
  // Node's boot and the stdin read, not only the handler.
  const out = await dispatch(raw, process.argv.slice(2), { startedAt: 0 });
  if (!ranLate()) {
    process.stdout.write(out);
    return;
  }
  // A handler that outlasted its budget is still running; end the process once the answer is out.
  process.stdout.write(out, () => process.exit(0));
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
