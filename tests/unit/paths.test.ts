import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { ensureDirs } from "../../src/paths.js";
import { GlobalDb } from "../../src/stats/global.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { filePayload } from "../../src/ui/graph-api.js";

describe("dashboard file viewer containment", () => {
  let root: string;
  let outside: string;
  let ctx: ProjectContext;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "em-viewer-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "em-viewer-out-")));
    writeFileSync(join(root, "package.json"), "{}");
    // Names that start with `..` are ordinary files inside the project.
    writeFileSync(join(root, "..notes.md"), "dots\n");
    mkdirSync(join(root, "..cache"));
    writeFileSync(join(root, "..cache", "a.txt"), "cached\n");
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt"));
    resetContextCache();
    ctx = getContext(root);
  });
  afterAll(() => {
    resetContextCache();
    for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("serves a file whose name starts with `..`", () => {
    expect(filePayload(ctx, "..notes.md")).toMatchObject({ path: "..notes.md", content: "dots\n" });
    expect(filePayload(ctx, "..cache/a.txt")).toMatchObject({ content: "cached\n" });
  });

  it("refuses a `..` segment, an absolute path and a symlink out of the project", () => {
    for (const p of ["../x.txt", "a/../../x.txt", "..", join(outside, "secret.txt"), "leak.txt"])
      expect(() => filePayload(ctx, p), p).toThrow(/outside the project/);
  });
});

describe("unsafe project paths in one config layer", () => {
  let home: string;
  let root: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterAll(() => {
    delete process.env.EMINIAR_HOME;
    vi.restoreAllMocks();
    for (const d of [home, root]) rmSync(d, { recursive: true, force: true });
  });

  it("drops every unsafe path key of one layer and keeps that layer's other keys", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({
        docs: { manifest: "../x.json", ttlHours: 3 },
        memories: { dir: "/abs/mem" },
        recall: { maxMemories: 4 },
      }),
    );
    const c = loadConfig(root);
    expect([c.docs.manifest, c.docs.ttlHours, c.memories.dir, c.recall.maxMemories]).toEqual([
      ".eminiar/docs.json",
      3,
      ".eminiar/memories",
      4,
    ]);
    const out = err.mock.calls.map((a) => String(a[0])).join("");
    expect(out).toContain("ignoring docs.manifest");
    expect(out).toContain("ignoring memories.dir");
    expect(out).not.toContain("invalid config");
  });

  it("a safe key in one layer survives an unsafe one in the other", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ docs: { manifest: "/abs.json" }, memories: { dir: "notes/mem" } }),
    );
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ docs: { manifest: "p/docs.json" }, memories: { dir: "../up" } }),
    );
    const c = loadConfig(root);
    expect([c.docs.manifest, c.memories.dir]).toEqual(["p/docs.json", "notes/mem"]);
  });
});

const mode = (path: string) => statSync(path).mode & 0o777;
const posix = process.platform !== "win32";

describe.runIf(posix)("data file modes", () => {
  const realHome = process.env.HOME;
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
    process.env.HOME = realHome;
  });

  const dir = (name: string, entries: string[] = []) => {
    const d = join(mkdtempSync(join(tmpdir(), "em-modes-")), name);
    mkdirSync(d);
    for (const e of entries) writeFileSync(join(d, e), "");
    chmodSync(d, 0o755);
    return d;
  };

  it("creates the eminiar home owner-only and tightens an existing one", () => {
    process.env.EMINIAR_HOME = join(mkdtempSync(join(tmpdir(), "em-modes-")), "fresh");
    expect(mode(ensureDirs().home)).toBe(0o700);

    // an older install: nothing but eminiar's state
    const old = dir("old", ["global.db", "global.db-wal", "hook.log"]);
    process.env.EMINIAR_HOME = old;
    ensureDirs();
    expect(mode(old)).toBe(0o700);

    // marked by install.json alone (no global.db yet), with eminiar's own sidecars beside it
    const installed = dir("installed", ["install.json", "config.json", "swarm.key"]);
    process.env.EMINIAR_HOME = installed;
    ensureDirs();
    expect(mode(installed)).toBe(0o700);

    // the default ~/.eminiar, whatever it holds
    delete process.env.EMINIAR_HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "em-user-"));
    const dflt = join(process.env.HOME, ".eminiar");
    mkdirSync(dflt, { mode: 0o755 });
    writeFileSync(join(dflt, "notes.txt"), "");
    chmodSync(dflt, 0o755);
    ensureDirs();
    expect(mode(dflt)).toBe(0o700);
  });

  it("leaves a project or shared folder that EMINIAR_HOME points at as its owner set it", () => {
    // a repo's settings can set EMINIAR_HOME, relative to the hook's cwd ("." is the project)
    const project = dir("project", ["package.json", "global.db"]);
    process.env.EMINIAR_HOME = relative(process.cwd(), project);
    ensureDirs();
    expect(mode(project)).toBe(0o755);
    // an empty folder, or one with only folders eminiar would add, carries no mark of eminiar
    for (const entries of [[], ["tmp"]]) {
      const bare = dir("bare");
      for (const e of entries) mkdirSync(join(bare, e));
      process.env.EMINIAR_HOME = bare;
      ensureDirs();
      expect(mode(bare)).toBe(0o755);
    }
  });

  it("creates a project database and its -wal and -shm owner-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "em-modes-")), "eminiar.db");
    const db = new SqliteAdapter(path, { vectors: false });
    db.metaSet("probe", "1");
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(mode(f), f).toBe(0o600);
    db.close();
  });

  it("tightens the files of an existing database when it opens", () => {
    const path = join(mkdtempSync(join(tmpdir(), "em-modes-")), "eminiar.db");
    new SqliteAdapter(path, { vectors: false }).close();
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(f, "", { flag: "a" });
      chmodSync(f, 0o644);
    }
    const db = new SqliteAdapter(path, { vectors: false });
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(mode(f), f).toBe(0o600);
    db.close();
  });

  it("keeps the global database owner-only too", () => {
    const path = join(mkdtempSync(join(tmpdir(), "em-modes-")), "global.db");
    const g = new GlobalDb(path);
    g.cacheSet("https://example.com", null, "page", 1000);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(mode(f), f).toBe(0o600);
    g.close();
  });
});
