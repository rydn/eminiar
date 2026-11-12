import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import {
  healPlaybookTables,
  migrations,
  PLAYBOOK_OBJECTS,
  RESERVED_SCHEMA_VERSIONS,
  tablesExist,
} from "../../src/storage/sqlite/schema.js";

/**
 * Migration versions that shipped in a release: databases in the wild may be at the highest
 * one, so a new entry below it would never run there. When a release ships a new migration,
 * append its version here in the same PR that bumps the package version.
 */
const RELEASED_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11];

/** Lowest version above every migration, released and reserved number that is not reserved. */
function nextFreeVersion(): number {
  const taken = [
    ...migrations.map((m) => m.version),
    ...RELEASED_SCHEMA_VERSIONS,
    ...RESERVED_SCHEMA_VERSIONS,
  ];
  let v = Math.max(...taken) + 1;
  while (RESERVED_SCHEMA_VERSIONS.includes(v)) v++;
  return v;
}

/**
 * The runner applies every migration whose version is above meta.schema_version, in list
 * order. Two entries with one number, or a number lower than the one before it, would be
 * skipped on databases that already ran the higher one. Branches that pick the same number
 * (playbooks and feature/jev-integrations both took v10) must fail here when merged.
 */
describe("schema migrations", () => {
  it("versions are unique and strictly increasing, starting at 1", () => {
    const versions = migrations.map((m) => m.version);
    expect(versions[0]).toBe(1);
    const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(dupes, "duplicate migration versions").toEqual([]);
    for (let i = 1; i < versions.length; i++)
      expect(versions[i], `migration after v${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]!);
  });

  it("every migration has sql or an up step", () => {
    for (const m of migrations) expect(Boolean(m.sql || m.up), `v${m.version}`).toBe(true);
  });

  it("no migration is reserved or numbered below the highest released version", () => {
    const highest = Math.max(...RELEASED_SCHEMA_VERSIONS);
    const bad = migrations
      .map((m) => m.version)
      .filter(
        (v) =>
          RESERVED_SCHEMA_VERSIONS.includes(v) ||
          (v < highest && !RELEASED_SCHEMA_VERSIONS.includes(v)),
      );
    const next = nextFreeVersion();
    const message = bad
      .map(
        (v) =>
          `migration v${v} is ${RESERVED_SCHEMA_VERSIONS.includes(v) ? "reserved (RESERVED_SCHEMA_VERSIONS)" : `below the highest released version v${highest}`}: databases at v${highest} never run it. Renumber to v${next} (next free), keep IF NOT EXISTS, see mem:playbooks/design-and-scope`,
      )
      .join("\n");
    expect(bad, message).toEqual([]);
  });

  it("every released version is still in the list", () => {
    const versions = new Set(migrations.map((m) => m.version));
    for (const v of RELEASED_SCHEMA_VERSIONS)
      expect(versions.has(v), `released migration v${v} was removed`).toBe(true);
  });
});

describe("playbook heal under a write lock", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function dbWithoutPlaybookTables(): string {
    const dir = mkdtempSync(join(tmpdir(), "em-heal-lock-"));
    dirs.push(dir);
    const path = join(dir, "eminiar.db");
    new SqliteAdapter(path, { vectors: false }).close();
    const raw = new Database(path);
    raw.exec("DROP TABLE playbooks; DROP TABLE playbook_runs; DROP TABLE playbook_suggestions;");
    raw.close();
    return path;
  }

  it("an open does not wait the busy timeout for the heal; the next open heals", () => {
    const path = dbWithoutPlaybookTables();
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const busyTimeoutMs = 3000;
      const t = performance.now();
      const a = new SqliteAdapter(path, { vectors: false, busyTimeoutMs });
      const ms = performance.now() - t;
      try {
        expect(ms).toBeLessThan(busyTimeoutMs / 4);
        expect(tablesExist(a.db, ["playbooks"])).toBe(false);
        // the connection keeps its own busy timeout
        expect(Number(a.db.pragma("busy_timeout", { simple: true }))).toBe(busyTimeoutMs);
      } finally {
        a.close();
      }
    } finally {
      holder.exec("COMMIT");
      holder.close();
    }
    const again = new SqliteAdapter(path, { vectors: false });
    try {
      const n = (
        again.db
          .prepare(
            `SELECT count(*) AS n FROM sqlite_master WHERE name IN (${PLAYBOOK_OBJECTS.map(() => "?").join(",")})`,
          )
          .get(...PLAYBOOK_OBJECTS) as { n: number }
      ).n;
      expect(n).toBe(PLAYBOOK_OBJECTS.length);
    } finally {
      again.close();
    }
  });

  it("returns false on a locked database and true once the lock is gone", () => {
    const path = dbWithoutPlaybookTables();
    const holder = new Database(path);
    const db = new Database(path, { timeout: 3000 });
    try {
      holder.exec("BEGIN IMMEDIATE");
      const t = performance.now();
      expect(healPlaybookTables(db)).toBe(false);
      expect(performance.now() - t).toBeLessThan(750);
      holder.exec("COMMIT");
      expect(healPlaybookTables(db)).toBe(true);
      expect(healPlaybookTables(db)).toBe(false);
    } finally {
      if (holder.inTransaction) holder.exec("ROLLBACK");
      holder.close();
      db.close();
    }
  });
});
