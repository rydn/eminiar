import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getContext } from "./context.js";
import { kickEmbedding } from "./embeddings/queue.js";
import { drainReindexQueue, reindexCode, reindexGitSignals } from "./graph/reindex.js";
import { refreshHistorySummary } from "./history/model.js";
import { backfillRecallIndex, remaskCapturedOutput } from "./index/indexer.js";
import { reconcile } from "./memory/store.js";
import { markServerAlive } from "./session/server-alive.js";
import { getStorage } from "./storage/index.js";
import { registerServerProviders } from "./tools/em_adjudicate.js";
import { tools } from "./tools/index.js";
import { availableTools, errorResult } from "./tools/types.js";
import { pluginRoot, version } from "./version.js";

// `em-server --probe` is the installer's and doctor's cheap "can this copy start?" check:
// reaching this line means every static import above (better-sqlite3, sqlite-vec, the MCP
// SDK) resolved, which is exactly what fails when Claude Code launches a cache copy that
// has no node_modules.
if (process.argv.includes("--probe")) {
  process.stdout.write(`eminiar ${version()} ok root=${pluginRoot()} node=${process.execPath}\n`);
  process.exit(0);
}

const server = new McpServer({ name: "eminiar", version: version() });

// Sandbox tools never read the code graph, so they need not wait for edited files to
// be re-parsed; the drain still starts first and overlaps the child process instead.
const SANDBOX_TOOLS = new Set(["em_execute", "em_execute_file", "em_batch_execute"]);

// Opt-in tools (em_adjudicate) are listed only when their feature is on for the config loaded
// at start; enabling one later needs /mcp reconnect. The adjudicator's embedding provider is
// registered here (never in a hook) when it is the effective provider, and its model warmed,
// both in the background: start-up and tool listing never wait. Only the tools that score
// (ADJUDICATOR_TOOLS) wait for the registration, not for the warm-up. Disabled: nothing runs.
let startConfig: ReturnType<typeof getContext>["config"] | undefined;
try {
  startConfig = getContext().config;
} catch (err) {
  process.stderr.write(`eminiar: config not loaded at start: ${(err as Error).message}\n`);
}
const listed = startConfig ? availableTools(tools, startConfig) : tools.filter((t) => !t.available);
const ADJUDICATOR_TOOLS = new Set(["em_adjudicate", "em_swarm"]);
const providersReady: Promise<unknown> = startConfig
  ? registerServerProviders(startConfig, { warm: true }).catch((err: unknown) =>
      process.stderr.write(`eminiar: adjudicator provider skipped: ${(err as Error).message}\n`),
    )
  : Promise.resolve();

for (const tool of listed) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      annotations: tool.annotations,
      // Every tool accepts an optional project_root, for a caller whose project is not the
      // server's own (the em_swarm stamp hook names the session's); without it, the server's.
      inputSchema: { ...tool.schema, project_root: z.string().optional() },
    },
    async (args: Record<string, unknown>) => {
      const { project_root, ...rest } = args;
      try {
        const ctx = getContext(typeof project_root === "string" ? project_root : undefined);
        // Files edited since the last call get re-parsed before any tool runs.
        if (!tool.name.startsWith("em_graph") && tool.name !== "em_reindex") {
          const drain = drainReindexQueue(ctx, getStorage(ctx)).catch(() => undefined);
          if (!SANDBOX_TOOLS.has(tool.name)) await drain;
        }
        if (ADJUDICATOR_TOOLS.has(tool.name)) await providersReady;
        return await tool.handler(rest, ctx);
      } catch (err) {
        return errorResult(`${tool.name} failed: ${(err as Error).stack ?? String(err)}`);
      }
    },
  );
}

await server.connect(new StdioServerTransport());

// Leave a pid marker so the PreToolUse hook knows an em_* server is reachable for this
// project and may safely deny native calls in enforce mode. The marker goes away on any
// orderly exit; the hook discards markers whose pid no longer exists.
try {
  const unmark = markServerAlive(getContext());
  process.on("exit", unmark);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(sig, () => process.exit(0));
  // A stdio server has no reason to outlive its client.
  process.stdin.on("end", () => process.exit(0));
} catch (err) {
  process.stderr.write(`eminiar: liveness marker skipped: ${(err as Error).message}\n`);
}

// Open the project database as soon as the transport is up rather than inside the
// first tool call: loading sqlite-vec and checking migrations is ~10 ms the first
// em_execute of a session would otherwise pay.
setImmediate(() => {
  try {
    getStorage(getContext());
  } catch {
    // the first tool call reports the real error
  }
});

// Fill the recall index in the background (a database upgraded to it has the chunks stored
// before it existed to copy in). Hooks never do this: it is their open that only creates the
// empty index. On its own timer, not the warm-up's, which can take a while on a large project.
const recallFill = setTimeout(() => {
  try {
    backfillRecallIndex(getStorage(getContext())).catch((err: unknown) => {
      process.stderr.write(`eminiar: recall index fill skipped: ${(err as Error).message}\n`);
    });
  } catch (err) {
    process.stderr.write(`eminiar: recall index fill skipped: ${(err as Error).message}\n`);
  }
}, 500);
recallFill.unref();

// Warm the project in the background so the first em_* call is fast: parse
// changed code into the graph, refresh git signals, embed pending chunks.
// The server imports internal modules statically only: it is built as one file
// (tsup.config.ts) so an in-place upgrade cannot pull a chunk from under it, and a
// dynamic import() would make esbuild wrap modules lazily (scripts/check-bundle.mjs).
const warm = setTimeout(async () => {
  try {
    const ctx = getContext();
    const db = getStorage(ctx);
    try {
      reconcile(ctx, db);
    } catch (err) {
      process.stderr.write(`eminiar: memory reconcile skipped: ${(err as Error).message}\n`);
    }
    await reindexCode(ctx, db);
    try {
      reindexGitSignals(ctx, db);
      // hooks read the persisted history summary; rebuild it when HEAD moved
      refreshHistorySummary(ctx, db);
    } catch {
      // not a git repo
    }
    try {
      // in slices: output indexed before secrets were masked, then on later starts what was
      // stored since (by an older eminiar still running on this database)
      await remaskCapturedOutput(db);
    } catch (err) {
      process.stderr.write(`eminiar: masking stored output skipped: ${(err as Error).message}\n`);
    }
    kickEmbedding(ctx, db, 100);
  } catch (err) {
    process.stderr.write(`eminiar: warm-up skipped: ${(err as Error).message}\n`);
  }
}, 3000);
warm.unref();
