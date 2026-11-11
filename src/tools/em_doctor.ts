import { formatDoctor, runDoctor } from "../doctor.js";
import { embeddingStatus } from "../embeddings/queue.js";
import { contextModeInstalled, effectiveRoutingMode } from "../hooks/coexist.js";
import { needsAuthEntry } from "../install/claude-config.js";
import { availableLanguages } from "../sandbox/languages.js";
import { getCurrentSession } from "../session/current.js";
import { liveServers } from "../session/server-alive.js";
import { getStorage } from "../storage/index.js";
import { defineTool, READ_ONLY, text } from "./types.js";

export const emDoctor = defineTool({
  name: "em_doctor",
  annotations: READ_ONLY,
  description:
    "Check eminiar's health: node version, data directory, SQLite FTS5, sqlite-vec, embedding model, project root resolution.",
  schema: {},
  handler: async (_args, ctx) => {
    const db = getStorage(ctx);
    const checks = runDoctor({ db, config: ctx.config, root: ctx.root });
    checks.push({ name: "project", ok: true, detail: `${ctx.root} (id ${ctx.id})` });
    checks.push({
      name: "routing",
      ok: true,
      detail: `${ctx.config.routing.mode} (effective: ${effectiveRoutingMode(ctx.config)})`,
    });
    checks.push({
      name: "context-mode",
      ok: true,
      detail: contextModeInstalled() ? "installed (coexisting)" : "not installed",
    });
    const live = liveServers(ctx);
    checks.push({
      name: "MCP server",
      ok: live.includes(process.pid),
      detail: live.includes(process.pid)
        ? `this server (pid ${process.pid}) is marked live${live.length > 1 ? `; ${live.length - 1} other session(s)` : ""}`
        : "this server's liveness marker is missing; enforce routing will only annotate",
    });
    // Claude Code keeps a failed plugin launch on file for ~15 min and skips the server
    // meanwhile. If we are answering, this session connected; the entry is from another
    // client (typically the desktop app) and will make its next session skip us too.
    const failed = needsAuthEntry();
    checks.push({
      name: "Claude Code failure cache",
      ok: !failed,
      detail: failed
        ? `a failed launch at ${new Date(failed.timestamp).toISOString()} is cached; other sessions skip the server for 15 min — run \`eminiar doctor --fix\` in a terminal, then restart Claude Code`
        : "no cached launch failure",
    });
    checks.push({ name: "embeddings", ok: true, detail: embeddingStatus(ctx, db) });
    checks.push({
      name: "sandbox languages",
      ok: true,
      detail: availableLanguages()
        .map((l) => `${l.id}${l.bin ? "" : " (missing)"}`)
        .join(", "),
    });
    checks.push({
      name: "index",
      ok: true,
      detail: `${db.countDocuments()} documents, ${db.memoryCount()} memories, session ${getCurrentSession(ctx).slice(0, 8)}`,
    });
    return text(formatDoctor(checks));
  },
});
