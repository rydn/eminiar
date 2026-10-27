import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { getContext, type ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { planAgentSync, syncAgents } from "./agents.js";
import { loadSwarmConfig, STARTER_YAML, swarmFile } from "./config.js";
import {
  formatInvalid,
  formatIssues,
  formatNotOptedIn,
  formatRunList,
  formatRunStatus,
  formatSwarmList,
  formatSync,
  type RunListItem,
  runListItem,
  watchStep,
} from "./format.js";
import { coordinationRoot } from "./hooks.js";
import { runSnapshot, workerStatus } from "./runtime.js";
import type { RunRow } from "./types.js";

/**
 * `eminiar swarm <init|validate|sync|list|runs|status|watch>`. Kept out of src/cli.ts so it
 * can be tested without the process.exit the entry point does. Returns the exit code.
 */

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

export const SWARM_USAGE =
  "usage: eminiar swarm <init [--force] | validate | sync [--dry-run] [--force] | list | runs [--limit N] | status [run] | watch [--run id] [--interval 2]> [--json]";

async function storage(ctx: ProjectContext): Promise<StorageAdapter> {
  const { getStorage } = await import("../storage/index.js");
  return getStorage(ctx, { vectors: false });
}

function items(db: StorageAdapter, runs: RunRow[]): RunListItem[] {
  const now = Date.now();
  return runs.map((r) =>
    runListItem(
      r,
      db.swarm.tasks(r.id),
      db.swarm.workers(r.id).map((w) => ({ ...w, status: workerStatus(w, now) })),
    ),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function swarmCommand(
  args: string[],
  callerCtx: ProjectContext,
  io: CliIO = defaultIO,
  opts: { maxTicks?: number } = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      limit: { type: "string" },
      run: { type: "string" },
      interval: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });
  const [sub = "list", arg] = positionals;
  const json = !!values.json;
  // Run from a git worktree, the swarm still belongs to the main checkout (as in the hooks).
  const root = coordinationRoot(callerCtx.root);
  const ctx = root === callerCtx.root ? callerCtx : getContext(root);
  const emit = (v: unknown) => io.out(JSON.stringify(v, null, 2));

  switch (sub) {
    case "init": {
      const where = swarmFile(root);
      if (where.exists && !values.force) {
        io.err(`${where.rel} already exists; pass --force to overwrite it with the starter file`);
        return 1;
      }
      mkdirSync(dirname(where.file), { recursive: true });
      writeFileSync(where.file, STARTER_YAML);
      const loaded = loadSwarmConfig(root);
      if (loaded.state !== "ok") {
        // The starter file is tested to parse; reaching this means the file changed under us.
        io.err(`${where.rel} was written but does not validate`);
        return 1;
      }
      const r = syncAgents(root, loaded.config);
      if (json) {
        emit({ file: where.rel, swarms: loaded.config.swarms.map((s) => s.name), sync: r });
        return 0;
      }
      io.out(
        [
          `wrote ${where.rel} (swarms: ${loaded.config.swarms.map((s) => s.name).join(", ")})`,
          formatSync(r),
          "Edit the file to fit the project, then in Claude Code: /eminiar:em-swarm feature <goal>",
          "Docs: https://github.com/rydn/eminiar/blob/main/docs/swarms.md",
        ].join("\n"),
      );
      return r.conflicts ? 1 : 0;
    }

    case "validate": {
      const loaded = loadSwarmConfig(root);
      if (json) {
        emit(
          loaded.state === "ok"
            ? {
                state: "ok",
                file: loaded.config.rel,
                enabled: loaded.config.enabled,
                swarms: loaded.config.swarms.map((s) => s.name),
              }
            : loaded.state === "invalid"
              ? { state: "invalid", file: loaded.rel, issues: loaded.issues }
              : { state: "absent", file: loaded.rel },
        );
        return loaded.state === "ok" ? 0 : 1;
      }
      if (loaded.state === "absent") {
        io.err(`no ${loaded.rel}: swarms are off in this project (eminiar swarm init creates one)`);
        return 1;
      }
      if (loaded.state === "invalid") {
        io.err(formatIssues(loaded.rel, loaded.issues));
        return 1;
      }
      const c = loaded.config;
      io.out(
        `ok: ${c.rel} · ${c.swarms.length} swarm(s), ${c.swarms.reduce((n, s) => n + s.roles.length, 0)} role(s)${
          c.enabled ? "" : " · disabled (enabled: false)"
        }`,
      );
      return 0;
    }

    case "sync": {
      const loaded = loadSwarmConfig(root);
      if (loaded.state === "invalid") {
        io.err(formatInvalid(loaded.rel, loaded.issues));
        return 1;
      }
      const config = loaded.state === "ok" ? loaded.config : undefined;
      const dryRun = !!values["dry-run"];
      const syncOpts: { dryRun?: boolean; force?: boolean } = { dryRun, force: !!values.force };
      const r = syncAgents(root, config, syncOpts);
      const reason =
        loaded.state === "absent"
          ? `no ${loaded.rel}: swarms are off`
          : config?.enabled
            ? undefined
            : "swarms are disabled";
      if (json) emit({ dryRun, ...r });
      else io.out(formatSync(r, { dryRun, reason }));
      return r.conflicts ? 1 : 0;
    }

    case "list": {
      const loaded = loadSwarmConfig(root);
      if (loaded.state === "absent") {
        if (json) emit({ state: "absent", file: loaded.rel });
        else io.out(formatNotOptedIn(loaded.rel));
        return 0;
      }
      if (loaded.state === "invalid") {
        if (json) emit({ state: "invalid", file: loaded.rel, issues: loaded.issues });
        else io.err(formatInvalid(loaded.rel, loaded.issues));
        return 1;
      }
      const c = loaded.config;
      const plan = planAgentSync(root, c).map(({ content: _c, ...a }) => a);
      const db = await storage(ctx);
      const active = items(db, db.swarm.runs({ status: "active", limit: 10 }));
      if (json) {
        emit({
          state: "ok",
          file: c.rel,
          enabled: c.enabled,
          sync: c.sync,
          swarms: c.swarms.map((s) => ({
            name: s.name,
            description: s.description,
            topology: s.topology,
            max_agents: s.maxAgents,
            stages: s.stages,
            roles: s.roles.map((r) => ({
              role: r.role,
              subagent_type: r.agentType,
              model: r.model ?? null,
              count: r.count,
              file: plan.find((a) => a.agentType === r.agentType)?.action ?? null,
            })),
          })),
          agent_files: plan,
          active_runs: active,
        });
        return 0;
      }
      io.out(
        `${c.enabled ? "" : "(disabled: enabled is false, workers cannot be spawned)\n"}${formatSwarmList(c, plan, active)}`,
      );
      return 0;
    }

    case "runs": {
      const limit = values.limit === undefined ? 20 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        io.err("--limit must be a positive integer");
        return 2;
      }
      const db = await storage(ctx);
      const list = items(db, db.swarm.runs({ limit: Math.min(limit, 500) }));
      if (json) emit(list);
      else io.out(formatRunList(list));
      return 0;
    }

    case "status": {
      const db = await storage(ctx);
      const id = arg ?? (typeof values.run === "string" ? values.run : undefined);
      const run = id
        ? db.swarm.runGet(id)
        : (db.swarm.runActive() ?? db.swarm.runs({ limit: 1 })[0]);
      if (!run) {
        io.err(id ? `unknown run "${id}"` : "no swarm runs yet");
        return 1;
      }
      const snap = runSnapshot(db, run);
      if (json) emit(snap);
      else io.out(formatRunStatus(snap));
      return 0;
    }

    case "watch": {
      const interval = values.interval === undefined ? 2 : Number(values.interval);
      if (!Number.isFinite(interval) || interval <= 0) {
        io.err("--interval must be a positive number of seconds");
        return 2;
      }
      const db = await storage(ctx);
      const id = (typeof values.run === "string" ? values.run : undefined) ?? arg;
      const first = id ? db.swarm.runGet(id) : db.swarm.runActive();
      if (!first) {
        io.err(
          id
            ? `unknown run "${id}"`
            : 'no active swarm run to watch; start one with em_swarm {action:"start", swarm, goal} or pass --run',
        );
        return 1;
      }
      let key: string | undefined;
      for (let tick = 0; ; tick++) {
        const run = db.swarm.runGet(first.id);
        if (!run) {
          io.err(`run ${first.id} disappeared`);
          return 1;
        }
        const step = watchStep(key, runSnapshot(db, run, 1));
        key = step.key;
        // One compact line per change: Claude Code's Monitor tool turns each into an event.
        if (step.line) io.out(JSON.stringify(step.line));
        if (run.status !== "active") return 0;
        if (opts.maxTicks !== undefined && tick + 1 >= opts.maxTicks) return 0;
        await sleep(Math.max(250, interval * 1000));
      }
    }

    default:
      io.err(SWARM_USAGE);
      return 2;
  }
}
