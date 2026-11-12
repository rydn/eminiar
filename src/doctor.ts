import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { adjudicatorDoctorChecks } from "./adjudicator/cli.js";
import type { Config } from "./config.js";
import { getContext } from "./context.js";
import { recallIndexFilling } from "./index/indexer.js";
import { ensureDirs, paths } from "./paths.js";
import { recallFillingText } from "./session/recall-explain.js";
import type { StorageAdapter } from "./storage/adapter.js";
import { pluginRoot, version } from "./version.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const require = createRequire(import.meta.url);

function check(name: string, fn: () => string): Check {
  try {
    return { name, ok: true, detail: fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

export interface DoctorOptions {
  /** Default: the current project's config (getContext()). */
  config?: Config;
  root?: string;
  /** The project DB, for the adjudicator's breaker and 24 h figures (skipped without it). */
  db?: StorageAdapter;
  env?: NodeJS.ProcessEnv;
}

/** Shared by `em_doctor` and `eminiar doctor`. Each check is independent and never throws. */
export function runDoctor(opts: DoctorOptions = {}): Check[] {
  const p = ensureDirs();
  const checks: Check[] = [];

  // EMINIAR_LAUNCH_ROOT is set by bin/_resolve.sh when it fell back to the pinned stable
  // copy because the launched directory (Claude Code's plugin cache) has no node_modules.
  const launched = process.env.EMINIAR_LAUNCH_ROOT;
  checks.push({
    name: "eminiar",
    ok: true,
    detail: `v${version()} at ${pluginRoot()}${launched ? ` (launched from ${launched})` : ""}`,
  });

  checks.push(
    check("node", () => {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if ((major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 12)) {
        throw new Error(`node ${process.versions.node} too old; need >= 22.12`);
      }
      return `${process.versions.node} (${process.execPath})`;
    }),
  );

  checks.push(
    check("node-path pin", () => {
      if (!existsSync(p.nodePathFile)) return "not pinned (run `eminiar install`); using PATH node";
      const pinned = readFileSync(p.nodePathFile, "utf8").trim();
      accessSync(pinned, constants.X_OK);
      return pinned;
    }),
  );

  checks.push(
    check("root-path pin", () => {
      if (!existsSync(p.rootPathFile))
        return "not pinned (run `eminiar install`); the bin/ shims run only from a directory that has node_modules";
      const root = readFileSync(p.rootPathFile, "utf8").trim();
      if (!existsSync(join(root, "dist", "server.js")))
        throw new Error(`${root} has no dist/server.js (run \`eminiar install\`)`);
      return root;
    }),
  );

  checks.push(
    check("data dir", () => {
      accessSync(p.home, constants.W_OK);
      return p.home;
    }),
  );

  checks.push(
    check("better-sqlite3 + FTS5", () => {
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const db = new Database(":memory:");
      try {
        const ver = (db.prepare("select sqlite_version() v").get() as { v: string }).v;
        db.exec("create virtual table t using fts5(x, tokenize='porter unicode61')");
        db.exec("create virtual table t2 using fts5(x, tokenize='trigram')");
        return `sqlite ${ver}, fts5 porter+trigram ok`;
      } finally {
        db.close();
      }
    }),
  );

  checks.push(
    check("sqlite-vec", () => {
      const Database = require("better-sqlite3") as typeof import("better-sqlite3");
      const vec = require("sqlite-vec") as { load: (db: unknown) => void };
      const db = new Database(":memory:");
      try {
        vec.load(db);
        const v = (db.prepare("select vec_version() v").get() as { v: string }).v;
        return `vec ${v}`;
      } finally {
        db.close();
      }
    }),
  );

  checks.push(
    check("embedding model", () => {
      const dir = paths().models;
      return existsSync(dir) ? `${dir} (downloaded lazily on first hybrid search)` : "not present";
    }),
  );

  // The recall index (memories, docs, past errors): a fill still pending is why recall is quiet.
  // Not a failure: it completes on its own (server, quiet hooks) or with `eminiar reindex`.
  if (opts.db) {
    const filling = recallIndexFilling(opts.db);
    checks.push({
      name: "recall index",
      ok: true,
      detail: filling ? recallFillingText(filling.after) : "complete",
    });
  }

  // The adjudicator (opt-in): config, effective provider, key file, consent, health. No network.
  try {
    let config = opts.config;
    let root = opts.root;
    if (!config || !root) {
      const ctx = getContext(root);
      config ??= ctx.config;
      root ??= ctx.root;
    }
    checks.push(
      ...adjudicatorDoctorChecks(config, {
        root,
        db: opts.db,
        ...(opts.env ? { env: opts.env } : {}),
        p95: nearestRank95,
      }),
    );
  } catch (err) {
    checks.push({ name: "adjudicator", ok: false, detail: (err as Error).message });
  }

  return checks;
}

function nearestRank95(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

export function formatDoctor(checks: Check[]): string {
  const lines = checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  lines.push(failed === 0 ? "all checks passed" : `${failed} check(s) failed`);
  return lines.join("\n");
}
