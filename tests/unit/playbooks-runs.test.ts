import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { closeRun, reconcile, recordRun, runs, suggest, write } from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { migrations } from "../../src/storage/sqlite/schema.js";
import { emPlaybook } from "../../src/tools/em_playbook.js";

/**
 * Playbook runs (record, close in place, races), the v10 migration on an older database, and
 * which purge scopes touch playbook data. Hermetic: temp project, temp EMINIAR_HOME.
 */

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

const withPlaybooks = (over: Record<string, unknown>): ProjectContext => ({
  ...ctx,
  config: { ...ctx.config, playbooks: { ...ctx.config.playbooks, ...over } },
});

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pbruns-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => {
  rmSync(join(root, ".eminiar"), { recursive: true, force: true });
  reconcile(ctx, db);
  db.playbooks.purgeActivity();
  write(ctx, db, { name: "pb", title: "PB", prompt: "x" });
  write(ctx, db, { name: "other", title: "Other", prompt: "y" });
});

describe("closing a run", () => {
  it("without an id closes the newest started run only, then the next, then reports none left", () => {
    const first = recordRun(ctx, db, { playbook: "pb", trigger: "mcp" }).id;
    const second = recordRun(ctx, db, { playbook: "pb", trigger: "mcp" }).id;
    expect(closeRun(ctx, db, { playbook: "pb", status: "done" })).toEqual({ id: second });
    const state = () =>
      Object.fromEntries(runs(ctx, db, { playbook: "pb" }).map((r) => [r.id, r.status]));
    expect(state()).toEqual({ [first]: "started", [second]: "done" });
    expect(closeRun(ctx, db, { playbook: "pb", status: "failed" })).toEqual({ id: first });
    expect(state()).toEqual({ [first]: "failed", [second]: "done" });
    expect(() => closeRun(ctx, db, { playbook: "pb", status: "done" })).toThrow(/no started run/);
  });

  it("with an id closes that run, even when a newer one is still started", () => {
    const older = recordRun(ctx, db, { playbook: "pb", trigger: "cli" }).id;
    const newer = recordRun(ctx, db, { playbook: "pb", trigger: "cli" }).id;
    closeRun(ctx, db, { playbook: "pb", runId: older, status: "skipped" });
    const byId = Object.fromEntries(runs(ctx, db, { playbook: "pb" }).map((r) => [r.id, r.status]));
    expect(byId).toEqual({ [older]: "skipped", [newer]: "started" });
  });

  it("another playbook's started run is never closed by name", () => {
    recordRun(ctx, db, { playbook: "other", trigger: "cli" });
    expect(() => closeRun(ctx, db, { playbook: "pb", status: "done" })).toThrow(/no started run/);
    expect(runs(ctx, db, { playbook: "other" })[0]?.status).toBe("started");
  });

  it("keeps the note a run was started with unless the report brings one", () => {
    const keep = recordRun(ctx, db, { playbook: "pb", trigger: "ui", note: "opened" }).id;
    closeRun(ctx, db, { playbook: "pb", runId: keep, status: "done" });
    const swap = recordRun(ctx, db, { playbook: "pb", trigger: "ui", note: "opened" }).id;
    closeRun(ctx, db, { playbook: "pb", runId: swap, status: "done", note: "3 reviewed" });
    const notes = Object.fromEntries(runs(ctx, db, { playbook: "pb" }).map((r) => [r.id, r.note]));
    expect(notes).toEqual({ [keep]: "opened", [swap]: "3 reviewed" });
  });

  it("two reporters for one run: the second loses and cannot overwrite the first outcome", () => {
    const id = recordRun(ctx, db, { playbook: "pb", trigger: "mcp" }).id;
    // Both read the run while it was still started ...
    const stale = runs(ctx, db, { playbook: "pb" });
    expect(stale[0]?.status).toBe("started");
    // ... the first report lands ...
    closeRun(ctx, db, { playbook: "pb", runId: id, status: "done", note: "first" });
    // ... the second acts on its stale snapshot.
    const racing = {
      playbooks: {
        get: (n: string) => db.playbooks.get(n),
        runs: () => stale,
        runSetStatus: (...a: Parameters<typeof db.playbooks.runSetStatus>) =>
          db.playbooks.runSetStatus(...a),
      },
    } as unknown as StorageAdapter;
    expect(() =>
      closeRun(ctx, racing, { playbook: "pb", runId: id, status: "failed", note: "second" }),
    ).toThrow(/already closed/);
    expect(() =>
      closeRun(ctx, racing, { playbook: "pb", status: "failed", note: "third" }),
    ).toThrow(/already closed/);
    const row = runs(ctx, db, { playbook: "pb" })[0];
    expect([row?.status, row?.note]).toEqual(["done", "first"]);
  });

  it("a run of a deleted playbook cannot be closed, and its history stays", () => {
    const id = recordRun(ctx, db, { playbook: "other", trigger: "cli" }).id;
    rmSync(join(root, ".eminiar/playbooks/other.md"));
    reconcile(ctx, db);
    expect(() => closeRun(ctx, db, { playbook: "other", runId: id, status: "done" })).toThrow(
      /no playbook/,
    );
    expect(db.playbooks.runs({ playbook: "other" })).toHaveLength(1);
  });

  it("rejects a status that is not an outcome", () => {
    const id = recordRun(ctx, db, { playbook: "pb", trigger: "cli" }).id;
    for (const status of ["started", "bogus", ""]) {
      expect(
        () => closeRun(ctx, db, { playbook: "pb", runId: id, status: status as never }),
        status,
      ).toThrow(/status/);
    }
    expect(runs(ctx, db, { playbook: "pb" })[0]?.status).toBe("started");
  });

  it("is a read-side action: it follows playbooks.viewing, not playbooks.adding", () => {
    const id = recordRun(ctx, db, { playbook: "pb", trigger: "cli" }).id;
    const hidden = withPlaybooks({ viewing: false });
    expect(() => closeRun(hidden, db, { playbook: "pb", runId: id, status: "done" })).toThrow(
      /viewing/,
    );
    const ro = withPlaybooks({ adding: false });
    expect(closeRun(ro, db, { playbook: "pb", runId: id, status: "done" })).toEqual({ id });
  });

  it("em_playbook report of a run that belongs to another playbook is refused", async () => {
    const id = recordRun(ctx, db, { playbook: "other", trigger: "mcp" }).id;
    const r = await emPlaybook.handler(
      { action: "report", name: "pb", run_id: id, status: "done" } as never,
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(runs(ctx, db, { playbook: "other" })[0]?.status).toBe("started");
  });
});

describe("migration 10 on an existing database", () => {
  const latest = () => migrations[migrations.length - 1]!.version;

  function dbAtV9(): string {
    const path = join(mkdtempSync(join(tmpdir(), "em-v9-")), "eminiar.db");
    const raw = new Database(path);
    for (const m of migrations) {
      if (m.version > 9) break;
      if (m.sql) raw.exec(m.sql);
      m.up?.(raw);
    }
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '9')").run();
    raw
      .prepare(
        "INSERT INTO memories (name, kind, content, created_at) VALUES ('keep', 'note', 'old row', 1)",
      )
      .run();
    expect(
      raw.prepare("SELECT name FROM sqlite_master WHERE name = 'playbooks'").get(),
    ).toBeUndefined();
    raw.close();
    return path;
  }

  const objects = (a: SqliteAdapter) =>
    (
      a.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

  it("adds the playbook tables and indexes, keeps existing rows, and reopening is a no-op", () => {
    const path = dbAtV9();
    const a = new SqliteAdapter(path, { vectors: false });
    try {
      expect(a.metaGet("schema_version")).toBe(String(latest()));
      expect(objects(a)).toEqual(
        expect.arrayContaining([
          "playbooks",
          "playbook_runs",
          "playbook_suggestions",
          "playbooks_updated",
          "playbook_runs_playbook",
          "playbook_suggestions_status",
        ]),
      );
      expect(
        (
          a.db.prepare("SELECT content FROM memories WHERE name = 'keep'").get() as {
            content: string;
          }
        ).content,
      ).toBe("old row");
      a.playbooks.upsert({ name: "n", title: "N", prompt: "p" });
      const rid = a.playbooks.runAdd({ playbook: "n", trigger: "cli" });
      expect(a.playbooks.runSetStatus(rid, "done")).toBe(true);
    } finally {
      a.close();
    }
    const again = new SqliteAdapter(path, { vectors: false });
    try {
      expect(again.metaGet("schema_version")).toBe(String(latest()));
      expect(again.playbooks.count()).toBe(1);
      expect(again.playbooks.runs()).toHaveLength(1);
    } finally {
      again.close();
    }
  });

  it("a name and a suggestion fingerprint are unique in the database itself", () => {
    const a = new SqliteAdapter(dbAtV9(), { vectors: false });
    try {
      const insertPlaybook = () =>
        a.db
          .prepare(
            "INSERT INTO playbooks (name, title, prompt, created_at) VALUES ('dup', 't', 'p', 1)",
          )
          .run();
      insertPlaybook();
      expect(insertPlaybook).toThrow(/UNIQUE/);
      const insertSuggestion = () =>
        a.db
          .prepare(
            "INSERT INTO playbook_suggestions (ts, name, title, prompt, fingerprint) VALUES (1, 'n', 't', 'p', 'fp')",
          )
          .run();
      insertSuggestion();
      expect(insertSuggestion).toThrow(/UNIQUE/);
    } finally {
      a.close();
    }
  });
});

describe("purge scopes", () => {
  const on = () => withPlaybooks({ extraction: { enabled: true } });
  const seed = () => {
    recordRun(ctx, db, { playbook: "pb", trigger: "cli" });
    suggest(on(), db, { title: "s", prompt: "something recurring" });
  };
  const counts = () => [
    db.playbooks.count(),
    db.playbooks.runs().length,
    db.playbooks.suggestions().length,
  ];

  it("index, graph, usage and adjudicator purges leave playbooks, runs and suggestions alone", () => {
    for (const scope of ["index", "graph", "usage", "adjudicator"] as const) {
      seed();
      const before = counts();
      db.purge(scope);
      expect(counts(), scope).toEqual(before);
    }
  });

  it("purging everything clears the mirror, runs and suggestions but never the files", () => {
    seed();
    db.purge("all");
    expect(counts()).toEqual([0, 0, 0]);
    expect(existsSync(join(root, ".eminiar/playbooks/pb.md"))).toBe(true);
    expect(reconcile(ctx, db).synced).toBe(2);
  });
});
