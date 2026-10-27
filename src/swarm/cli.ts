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
  formatReleased,
  formatRunList,
  formatRunStatus,
  formatSwarmList,
  formatSync,
  isWatchEvent,
  type RunListItem,
  runListItem,
  runRef,
  watchStep,
} from "./format.js";
import { coordinationRoot } from "./hooks.js";
import {
  COORDINATOR,
  releaseWorkers,
  runSnapshot,
  STALE_MS,
  SwarmError,
  workerStatus,
} from "./runtime.js";
import type { RunRow, SwarmEventRow } from "./types.js";

/**
 * `eminiar swarm <init|validate|sync|list|runs|status|release|watch>`. Kept out of src/cli.ts
 * so it can be tested without the process.exit the entry point does. Returns the exit code.
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
  "usage: eminiar swarm <init [--force] | validate | sync [--dry-run] [--force] | list | runs [--limit N] | status [run] | release [--run id] [--agent id] [--role r] | watch [--run id] [--interval 2]> [--json]";

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

const VALUE_OPTIONS = ["limit", "run", "interval", "agent", "role"] as const;

/** Events scanned per query while `watch` catches up with the feed. */
const WATCH_PAGE = 1000;

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
      agent: { type: "string" },
      role: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });
  const [sub = "list", arg] = positionals;
  const json = !!values.json;
  // Non-strict parseArgs turns a value option given without its value into `true`.
  for (const name of VALUE_OPTIONS)
    if (values[name] === true) {
      io.err(`--${name} needs a value`);
      return 2;
    }
  const opt = (name: (typeof VALUE_OPTIONS)[number]) => {
    const v = values[name];
    return typeof v === "string" ? v : undefined;
  };
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
        return r.conflicts ? 1 : 0;
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
      const dryRun = !!values["dry-run"];
      if (loaded.state === "invalid") {
        if (json)
          emit({
            dryRun,
            reason: `${loaded.rel} is invalid: swarms stay off and sync changes nothing`,
            file: loaded.rel,
            issues: loaded.issues,
            actions: [],
            changed: 0,
            conflicts: 0,
          });
        else io.err(formatInvalid(loaded.rel, loaded.issues));
        return 1;
      }
      const config = loaded.state === "ok" ? loaded.config : undefined;
      const syncOpts: { dryRun?: boolean; force?: boolean } = { dryRun, force: !!values.force };
      const r = syncAgents(root, config, syncOpts);
      const reason =
        loaded.state === "absent"
          ? `no ${loaded.rel}: swarms are off`
          : config?.enabled
            ? undefined
            : "swarms are disabled";
      if (json) emit({ dryRun, reason: reason ?? null, ...r });
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
      const limit = opt("limit") === undefined ? 20 : Number(opt("limit"));
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
      const id = arg ?? opt("run");
      const run = id
        ? db.swarm.runGet(id)
        : (db.swarm.runActive() ?? db.swarm.runs({ limit: 1 })[0]);
      if (!run) {
        io.err(id ? `unknown run "${id}"` : "no swarm runs yet");
        return 1;
      }
      const snap = runSnapshot(db, run);
      if (json) {
        emit(snap);
        return 0;
      }
      const others = id
        ? []
        : db.swarm.runs({ status: "active", limit: 50 }).filter((r) => r.id !== run.id);
      // A terminal has room: every task and worker, no character cap.
      io.out(
        formatRunStatus(snap, {
          max: Number.POSITIVE_INFINITY,
          perGroup: Number.POSITIVE_INFINITY,
          workers: Number.POSITIVE_INFINITY,
          lead: others.length
            ? [
                `Also active: ${others
                  .slice(0, 5)
                  .map(runRef)
                  .join("; ")}${others.length > 5 ? "; …" : ""} (eminiar swarm status <run>)`,
              ]
            : [],
        }),
      );
      return 0;
    }

    case "release": {
      const db = await storage(ctx);
      const id = opt("run") ?? arg;
      let run: RunRow | undefined;
      if (id) {
        run = db.swarm.runGet(id);
        if (!run) {
          io.err(`unknown run "${id}"`);
          return 1;
        }
      } else {
        const active = db.swarm.runs({ status: "active", limit: 50 });
        if (active.length > 1) {
          io.err(
            `${active.length} runs are active; pass --run: ${active
              .slice(0, 8)
              .map(runRef)
              .join("; ")}`,
          );
          return 1;
        }
        run = active[0];
        if (!run) {
          io.err("no active swarm run; pass --run to release workers of a finished one");
          return 1;
        }
      }
      const agent = opt("agent")?.trim() || undefined;
      const role = opt("role")?.trim() || undefined;
      try {
        // The CLI is the user at a terminal: they act as the coordinator.
        const released = releaseWorkers(db, run, { label: COORDINATOR }, { agent, role });
        const running = db.swarm.workers(run.id).filter((w) => w.status === "running");
        if (json)
          emit({
            run: run.id,
            released: released.map((w) => ({
              agent_id: w.agent_id,
              role: w.role,
              task_id: w.task_id,
            })),
          });
        else
          io.out(
            formatReleased(run, released, running, {
              agent,
              role,
              staleMinutes: Math.round(STALE_MS / 60_000),
            }),
          );
        return 0;
      } catch (err) {
        if (!(err instanceof SwarmError)) throw err;
        io.err(err.message);
        return 1;
      }
    }

    case "watch": {
      const interval = opt("interval") === undefined ? 2 : Number(opt("interval"));
      if (!Number.isFinite(interval) || interval <= 0) {
        io.err("--interval must be a positive number of seconds");
        return 2;
      }
      const db = await storage(ctx);
      const id = opt("run") ?? arg;
      const first = id ? db.swarm.runGet(id) : db.swarm.runActive();
      if (!first) {
        io.err(
          id
            ? `unknown run "${id}"`
            : 'no active swarm run to watch; start one with em_swarm {action:"start", swarm, goal} or pass --run',
        );
        return 1;
      }
      if (!id) {
        const others = db.swarm.runs({ status: "active", limit: 50 }).length - 1;
        if (others > 0)
          io.err(
            `watching run ${first.id}; ${others} other run(s) are active (pass --run to pick)`,
          );
      }
      // The newest event that counts as a change, tracked across ticks: tool calls are
      // skipped, so a busy worker never wakes the Monitor tool.
      let lastSeen = 0;
      let lastEvent: SwarmEventRow | null = null;
      const scan = (rows: SwarmEventRow[]) => {
        for (const e of rows) {
          lastSeen = Math.max(lastSeen, e.id);
          if (isWatchEvent(e)) lastEvent = e;
        }
        return rows.length;
      };
      scan(db.swarm.events(first.id, { limit: WATCH_PAGE }));
      let key: string | undefined;
      for (let tick = 0; ; tick++) {
        const run = db.swarm.runGet(first.id);
        if (!run) {
          io.err(`run ${first.id} disappeared`);
          return 1;
        }
        for (let n = WATCH_PAGE; tick > 0 && n === WATCH_PAGE; )
          n = scan(db.swarm.events(run.id, { after: lastSeen, limit: WATCH_PAGE }));
        const step = watchStep(key, runSnapshot(db, run, 0), lastEvent);
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
