import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { playbookCommand } from "../../src/playbooks/cli.js";
import {
  acceptSuggestion,
  assertCanScan,
  closeRun,
  dismissSuggestion,
  list,
  PlaybookGateError,
  read,
  reconcile,
  recordRun,
  remove,
  runs,
  suggest,
  suggestions,
  write,
} from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emPlaybook } from "../../src/tools/em_playbook.js";
import { availableTools } from "../../src/tools/types.js";
import { playbooksRoute } from "../../src/ui/playbooks-api.js";

/**
 * The switches (playbooks.viewing, playbooks.adding, playbooks.extraction.enabled) on every
 * surface (MCP tool, dashboard API, CLI), the defaults of a project with no config, and the
 * exit codes and status codes around them. Hermetic: temp project, temp EMINIAR_HOME.
 */

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

const withPlaybooks = (over: Record<string, unknown>): ProjectContext => ({
  ...ctx,
  config: { ...ctx.config, playbooks: { ...ctx.config.playbooks, ...over } },
});
const hidden = () => withPlaybooks({ viewing: false });
const readOnly = () => withPlaybooks({ adding: false });
const extracting = () => withPlaybooks({ extraction: { enabled: true } });

const tool = async (a: Record<string, unknown>, c: ProjectContext = ctx) => {
  const r = await emPlaybook.handler(a as never, c);
  return { text: r.content.map((x) => x.text).join("\n"), err: r.isError === true };
};

const api = (c: ProjectContext, method: string, path: string, body: unknown = {}) =>
  playbooksRoute(c, { path, method, query: new URLSearchParams(), body: async () => body });

async function cli(args: string[], c: ProjectContext = ctx, stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await playbookCommand(
    args,
    c,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    async () => stdin,
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const file = (name: string, priv = false) =>
  join(root, priv ? ".eminiar/playbooks-private" : ".eminiar/playbooks", `${name}.md`);

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pbgate-"));
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
  rmSync(join(root, ".gitignore"), { recursive: true, force: true });
  rmSync(join(root, ".claude"), { recursive: true, force: true });
  reconcile(ctx, db);
  db.playbooks.purgeActivity();
});

describe("defaults of a project with no config", () => {
  it("viewing and adding are on, extraction is off, folders are the documented ones", () => {
    expect(ctx.config.playbooks).toEqual({
      dir: ".eminiar/playbooks",
      privateDir: ".eminiar/playbooks-private",
      viewing: true,
      adding: true,
      extraction: { enabled: false },
    });
  });

  it("turning extraction on in a project config leaves the other defaults alone", () => {
    const r = mkdtempSync(join(tmpdir(), "em-pbcfg-"));
    writeFileSync(
      join(r, "eminiar.config.json"),
      JSON.stringify({ playbooks: { extraction: { enabled: true } } }),
    );
    expect(loadConfig(r).playbooks).toEqual({
      dir: ".eminiar/playbooks",
      privateDir: ".eminiar/playbooks-private",
      viewing: true,
      adding: true,
      extraction: { enabled: true },
    });
  });

  it("a config value of the wrong type never turns extraction on", () => {
    const r = mkdtempSync(join(tmpdir(), "em-pbcfg-"));
    writeFileSync(
      join(r, "eminiar.config.json"),
      JSON.stringify({ playbooks: { extraction: { enabled: "yes" } } }),
    );
    expect(loadConfig(r).playbooks.extraction.enabled).toBe(false);
  });

  it("using playbooks that do not exist creates no folder, no ignore file and no rows", async () => {
    expect((await tool({ action: "list" })).err).toBe(false);
    expect((await tool({ action: "read", name: "nope" })).err).toBe(true);
    expect((await cli(["list"])).code).toBe(0);
    expect((await api(ctx, "GET", "/api/playbooks")).status).toBe(200);
    expect(existsSync(join(root, ".eminiar/playbooks"))).toBe(false);
    expect(existsSync(join(root, ".eminiar/playbooks-private"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(db.playbooks.count()).toBe(0);
  });

  it("every surface refuses extraction until it is switched on", async () => {
    expect(() => suggest(ctx, db, { title: "t", prompt: "p" })).toThrow(/extraction/);
    for (const action of ["scan", "accept", "dismiss"]) {
      const r = await tool({ action, id: 1 });
      expect(r.err, action).toBe(true);
    }
    expect((await tool({ action: "scan" })).text).toMatch(/extraction/);
    for (const args of [["scan"], ["scan", "--dry-run"], ["scan", "--json"]]) {
      const r = await cli(args);
      expect([r.code, r.out], args.join(" ")).toEqual([1, ""]);
      expect(r.err).toContain("playbooks.extraction.enabled");
    }
    for (const dryRun of [true, false]) {
      expect((await api(ctx, "POST", "/api/playbooks/scan", { dryRun })).status).toBe(403);
    }
    const overview = (await api(ctx, "GET", "/api/playbooks")).body as Record<string, unknown>;
    expect([overview.extraction, overview.suggestions]).toEqual([false, []]);
    expect(db.playbooks.suggestions()).toHaveLength(0);
  });

  it("the tool refuses to list suggestions while extraction is off, naming the switch", async () => {
    const r = await tool({ action: "suggestions" });
    expect(r.err).toBe(true);
    expect(r.text).toContain("playbooks.extraction.enabled");
  });
});

describe("one rule, enforced by the store, on every surface", () => {
  type Gate = "playbooks.viewing" | "playbooks.adding" | "playbooks.extraction.enabled";
  let sid: number;
  let runId: number;
  beforeEach(() => {
    write(ctx, db, { name: "keep", title: "Keep", prompt: "original {{what}}" });
    sid = suggest(extracting(), db, { title: "Pending", prompt: "a pending task" }).id;
    runId = recordRun(ctx, db, { playbook: "keep", trigger: "cli" }).id;
  });
  /** Every switch on except the ones named. */
  const off = (...keys: Gate[]): ProjectContext =>
    withPlaybooks({
      viewing: !keys.includes("playbooks.viewing"),
      adding: !keys.includes("playbooks.adding"),
      extraction: { enabled: !keys.includes("playbooks.extraction.enabled") },
    });
  const gateOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof PlaybookGateError ? e.key : `other: ${(e as Error).message}`;
    }
    return undefined;
  };
  const unchanged = () => {
    expect(readFileSync(file("keep"), "utf8")).toContain("original");
    expect(existsSync(file("new"))).toBe(false);
    expect(db.playbooks.suggestionGet(sid)?.status).toBe("pending");
    expect(db.playbooks.runs({ playbook: "keep" }).map((r) => [r.id, r.status])).toEqual([
      [runId, "started"],
    ]);
  };

  it("store: viewing gates every call, reads and writes alike", () => {
    const c = off("playbooks.viewing");
    const calls: Array<[string, () => unknown]> = [
      ["read", () => read(c, db, "keep")],
      ["list", () => list(c, db)],
      ["runs", () => runs(c, db)],
      ["write", () => write(c, db, { name: "new", title: "N", prompt: "p" })],
      ["remove", () => remove(c, db, "keep")],
      ["recordRun", () => recordRun(c, db, { playbook: "keep", trigger: "mcp" })],
      ["closeRun", () => closeRun(c, db, { playbook: "keep", runId, status: "done" })],
      ["suggest", () => suggest(c, db, { title: "S", prompt: "another task" })],
      ["suggestions", () => suggestions(c, db)],
      ["accept", () => acceptSuggestion(c, db, sid)],
      ["dismiss", () => dismissSuggestion(c, db, sid)],
      ["scan", () => assertCanScan(c, { dryRun: false })],
      ["scan dry", () => assertCanScan(c, { dryRun: true })],
    ];
    for (const [what, fn] of calls) expect([what, gateOf(fn)]).toEqual([what, "playbooks.viewing"]);
    unchanged();
  });

  it("store: adding gates every write, runs and suggestions included; reads still work", () => {
    const c = off("playbooks.adding");
    const calls: Array<[string, () => unknown]> = [
      ["write", () => write(c, db, { name: "new", title: "N", prompt: "p" })],
      ["remove", () => remove(c, db, "keep")],
      ["recordRun", () => recordRun(c, db, { playbook: "keep", trigger: "mcp" })],
      ["closeRun", () => closeRun(c, db, { playbook: "keep", runId, status: "done" })],
      ["suggest", () => suggest(c, db, { title: "S", prompt: "another task" })],
      ["accept", () => acceptSuggestion(c, db, sid)],
      ["dismiss", () => dismissSuggestion(c, db, sid)],
      ["scan", () => assertCanScan(c, { dryRun: false })],
    ];
    for (const [what, fn] of calls) expect([what, gateOf(fn)]).toEqual([what, "playbooks.adding"]);
    for (const [what, fn] of [
      ["read", () => read(c, db, "keep")],
      ["list", () => list(c, db)],
      ["runs", () => runs(c, db)],
      ["suggestions", () => suggestions(c, db)],
      ["scan dry", () => assertCanScan(c, { dryRun: true })],
    ] as Array<[string, () => unknown]>)
      expect([what, gateOf(fn)]).toEqual([what, undefined]);
    unchanged();
  });

  it("store: extraction gates suggest, suggestions, accept, dismiss and scan", () => {
    const c = off("playbooks.extraction.enabled");
    const calls: Array<[string, () => unknown]> = [
      ["suggest", () => suggest(c, db, { title: "S", prompt: "another task" })],
      ["suggestions", () => suggestions(c, db)],
      ["accept", () => acceptSuggestion(c, db, sid)],
      ["dismiss", () => dismissSuggestion(c, db, sid)],
      ["scan", () => assertCanScan(c, { dryRun: false })],
      ["scan dry", () => assertCanScan(c, { dryRun: true })],
    ];
    for (const [what, fn] of calls)
      expect([what, gateOf(fn)]).toEqual([what, "playbooks.extraction.enabled"]);
    unchanged();
  });

  it("the gate error names the config key in its message", () => {
    for (const key of [
      "playbooks.viewing",
      "playbooks.adding",
      "playbooks.extraction.enabled",
    ] as Gate[]) {
      try {
        acceptSuggestion(off(key), db, sid);
        expect.unreachable(key);
      } catch (e) {
        expect(e).toBeInstanceOf(PlaybookGateError);
        expect((e as Error).message).toContain(key);
      }
    }
  });

  const toolWrites = () => [
    { action: "add", name: "new", title: "N", prompt: "p" },
    { action: "edit", name: "keep", prompt: "changed" },
    { action: "delete", name: "keep", confirm: true },
    { action: "report", name: "keep", run_id: runId, status: "done" },
    { action: "accept", id: sid },
    { action: "dismiss", id: sid },
    { action: "scan" },
  ];

  it("tool: viewing off refuses every action, with the key in the error", async () => {
    for (const a of [
      ...toolWrites(),
      { action: "list" },
      { action: "read", name: "keep" },
      { action: "run", name: "keep" },
      { action: "suggestions" },
      { action: "scan", dry_run: true },
    ]) {
      const r = await tool(a, off("playbooks.viewing"));
      expect([JSON.stringify(a), r.err, r.text]).toEqual([
        JSON.stringify(a),
        true,
        expect.stringContaining("playbooks.viewing"),
      ]);
    }
    unchanged();
  });

  it("tool: adding off refuses every write (report and a saving scan included)", async () => {
    for (const a of toolWrites()) {
      const r = await tool(a, off("playbooks.adding"));
      expect([JSON.stringify(a), r.err, r.text]).toEqual([
        JSON.stringify(a),
        true,
        expect.stringContaining("playbooks.adding"),
      ]);
    }
    unchanged();
    for (const a of [
      { action: "list" },
      { action: "read", name: "keep" },
      { action: "suggestions" },
      { action: "scan", dry_run: true },
    ])
      expect([a.action, (await tool(a, off("playbooks.adding"))).err]).toEqual([a.action, false]);
  });

  it("tool: adding off, run hands over the filled prompt but records nothing", async () => {
    const r = await tool(
      { action: "run", name: "keep", values: { what: "x" } },
      off("playbooks.adding"),
    );
    expect(r.err).toBe(false);
    expect(r.text).toContain("original x");
    expect(r.text).toContain("playbooks.adding");
    expect(r.text).not.toContain('action:"report"');
    unchanged();
  });

  it("tool: extraction off refuses suggestions, accept, dismiss and scan", async () => {
    for (const a of [
      { action: "suggestions" },
      { action: "accept", id: sid },
      { action: "dismiss", id: sid },
      { action: "scan" },
      { action: "scan", dry_run: true },
    ]) {
      const r = await tool(a, off("playbooks.extraction.enabled"));
      expect([JSON.stringify(a), r.err, r.text]).toEqual([
        JSON.stringify(a),
        true,
        expect.stringContaining("playbooks.extraction.enabled"),
      ]);
    }
    unchanged();
  });

  it("CLI: each switch exits 1 with the key on stderr and nothing on stdout", async () => {
    const table: Array<[Gate, string[]]> = [
      ["playbooks.viewing", ["add", "new", "--title", "N", "--prompt", "p"]],
      ["playbooks.viewing", ["rm", "keep"]],
      ["playbooks.viewing", ["scan"]],
      ["playbooks.viewing", ["scan", "--dry-run"]],
      ["playbooks.adding", ["scan"]],
      ["playbooks.adding", ["scan", "--json"]],
      ["playbooks.extraction.enabled", ["scan", "--dry-run"]],
    ];
    for (const [key, args] of table) {
      const r = await cli(args, off(key));
      expect([key, args.join(" "), r.code, r.out]).toEqual([key, args.join(" "), 1, ""]);
      expect(r.err).toContain(key);
    }
    unchanged();
    expect((await cli(["scan", "--dry-run"], off("playbooks.adding"))).code).toBe(0);
  });

  it("CLI: adding off, run prints the filled prompt, says it was not recorded, exits 0", async () => {
    const r = await cli(["run", "keep", "--set", "what=x"], off("playbooks.adding"));
    expect([r.code, r.out]).toEqual([0, "original x"]);
    expect(r.err).toContain("playbooks.adding");
    const j = await cli(["run", "keep", "--set", "what=x", "--json"], off("playbooks.adding"));
    expect(JSON.parse(j.out)).toMatchObject({ name: "keep", run: null, prompt: "original x" });
    unchanged();
  });

  it("API: every refusal of the store is a 403 naming the key", async () => {
    const table: Array<[Gate, string, Record<string, unknown>]> = [
      ["playbooks.viewing", "/api/playbooks/save", { title: "N", prompt: "p" }],
      ["playbooks.viewing", "/api/playbooks/scan", { dryRun: true }],
      ["playbooks.adding", "/api/playbooks/run", { name: "keep" }],
      ["playbooks.adding", "/api/playbooks/scan", { dryRun: false }],
      ["playbooks.extraction.enabled", "/api/playbooks/suggestion/accept", { id: sid }],
      ["playbooks.extraction.enabled", "/api/playbooks/suggestion/dismiss", { id: sid }],
      ["playbooks.extraction.enabled", "/api/playbooks/scan", { dryRun: true }],
    ];
    for (const [key, path, body] of table) {
      const r = await api(off(key), "POST", path, body);
      expect([key, path, r.status]).toEqual([key, path, 403]);
      expect(JSON.stringify(r.body)).toContain(key);
    }
    unchanged();
    expect((await api(ctx, "POST", "/api/playbooks/delete", { name: "../x" })).status).toBe(400);
  });

  it("em_playbook is listed only while playbooks.viewing is on", () => {
    expect(availableTools([emPlaybook], ctx.config)).toEqual([emPlaybook]);
    expect(availableTools([emPlaybook], off("playbooks.adding").config)).toEqual([emPlaybook]);
    expect(availableTools([emPlaybook], off("playbooks.viewing").config)).toEqual([]);
  });
});

describe("the hot path does not carry playbook code", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = join(here, "..", "..", "dist");

  it("no hook source imports the playbook modules", () => {
    const dir = join(here, "..", "..", "src", "hooks");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts")))
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/playbooks\//);
  });

  it.skipIf(!existsSync(join(dist, "hook.js")))(
    "the built hook bundles hold no playbook store, scan or export",
    () => {
      for (const f of readdirSync(dist).filter((x) => /^hook.*\.js$/.test(x))) {
        const text = readFileSync(join(dist, f), "utf8");
        for (const marker of [
          "private playbooks stay local",
          "playbook extraction is off",
          "playbooks are read-only",
          "eminiar:playbook-export",
        ])
          expect(text, `${f}: ${marker}`).not.toContain(marker);
      }
    },
  );
});

describe("playbooks.viewing = false", () => {
  beforeEach(() => {
    write(ctx, db, { name: "shown", title: "Shown", prompt: "x" });
    write(ctx, db, { name: "mine", title: "Mine", prompt: "private text", private: true });
  });

  it("the tool reads and runs nothing", async () => {
    for (const a of [
      { action: "list" },
      { action: "read", name: "shown" },
      { action: "export", name: "shown" },
      { action: "export", name: "shown", format: "schedule" },
      { action: "export", name: "shown", format: "skill" },
      { action: "run", name: "shown" },
      { action: "report", name: "shown", status: "done" },
      { action: "schedule", name: "shown" },
    ]) {
      const r = await tool(a, hidden());
      expect([JSON.stringify(a), r.err]).toEqual([JSON.stringify(a), true]);
      expect(r.text).toContain("playbooks.viewing");
      expect(r.text).not.toContain("private text");
    }
    expect(existsSync(join(root, ".claude/skills"))).toBe(false);
    expect(db.playbooks.runs()).toHaveLength(0);
  });

  it("the dashboard overview is empty and its writes are 403", async () => {
    const o = await api(hidden(), "GET", "/api/playbooks");
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({
      viewing: false,
      playbooks: [],
      runs: [],
      suggestions: [],
      skipped: [],
    });
    expect(JSON.stringify(o.body)).not.toContain("private text");
    for (const path of [
      "/api/playbooks/save",
      "/api/playbooks/delete",
      "/api/playbooks/run",
      "/api/playbooks/suggestion/accept",
      "/api/playbooks/suggestion/dismiss",
      "/api/playbooks/scan",
    ]) {
      const r = await api(
        {
          ...hidden(),
          config: {
            ...hidden().config,
            playbooks: { ...hidden().config.playbooks, extraction: { enabled: true } },
          },
        },
        "POST",
        path,
        { name: "shown", title: "t", prompt: "p", id: 1 },
      );
      expect([path, r.status]).toEqual([path, 403]);
    }
    expect(existsSync(file("shown"))).toBe(true);
  });

  it("the CLI exits 1 for every read and prints nothing on stdout", async () => {
    for (const args of [
      ["list"],
      ["show", "shown"],
      ["run", "shown"],
      ["runs"],
      ["export", "shown"],
      ["export", "shown", "--skill"],
      ["export", "shown", "--schedule"],
      ["edit", "shown", "--title", "x"],
    ]) {
      const r = await cli(args, hidden());
      expect([args.join(" "), r.code, r.out]).toEqual([args.join(" "), 1, ""]);
      expect(r.err).toContain("playbooks.viewing");
    }
  });
});

describe("playbooks.adding = false", () => {
  let id: number;
  beforeEach(() => {
    write(ctx, db, { name: "keep", title: "Keep", prompt: "original" });
    id = suggest(extracting(), db, { title: "Pending", prompt: "a pending task" }).id;
  });
  const roOn = () => withPlaybooks({ adding: false, extraction: { enabled: true } });

  it("the tool refuses every write and leaves the file and the inbox as they were", async () => {
    for (const a of [
      { action: "add", name: "new", title: "N", prompt: "p" },
      { action: "edit", name: "keep", prompt: "changed" },
      { action: "delete", name: "keep", confirm: true },
      { action: "accept", id },
      { action: "dismiss", id },
    ]) {
      const r = await tool(a, roOn());
      expect([a.action, r.err]).toEqual([a.action, true]);
      expect(r.text).toContain("playbooks.adding");
    }
    expect(readFileSync(file("keep"), "utf8")).toContain("original");
    expect(existsSync(file("new"))).toBe(false);
    expect(suggestions(extracting(), db, { status: "pending" }).map((s) => s.id)).toEqual([id]);
  });

  it("the tool still lists, reads and exports", async () => {
    for (const a of [
      { action: "list" },
      { action: "read", name: "keep" },
      { action: "export", name: "keep" },
    ])
      expect((await tool(a, readOnly())).err, a.action).toBe(false);
  });

  it("the dashboard answers 403 to save, delete, accept, dismiss and recording a use, and still lists", async () => {
    for (const [path, body] of [
      ["/api/playbooks/save", { title: "t", prompt: "p" }],
      ["/api/playbooks/delete", { name: "keep" }],
      ["/api/playbooks/suggestion/accept", { id }],
      ["/api/playbooks/suggestion/dismiss", { id }],
    ] as const) {
      expect([path, (await api(roOn(), "POST", path, body)).status]).toEqual([path, 403]);
    }
    expect(existsSync(file("keep"))).toBe(true);
    expect(suggestions(extracting(), db, { status: "pending" })).toHaveLength(1);
    const o = (await api(roOn(), "GET", "/api/playbooks")).body as {
      playbooks: unknown[];
      adding: boolean;
    };
    expect([o.adding, o.playbooks.length]).toEqual([false, 1]);
    // recording a use is a write too: the page has already copied the prompt and ignores the 403
    expect((await api(roOn(), "POST", "/api/playbooks/run", { name: "keep" })).status).toBe(403);
    expect(db.playbooks.runs()).toHaveLength(0);
  });

  it("the CLI exits 1 for add, edit and rm, and 0 for list and show", async () => {
    for (const args of [
      ["add", "new", "--title", "N", "--prompt", "p"],
      ["edit", "keep", "--prompt", "changed"],
      ["rm", "keep"],
    ]) {
      const r = await cli(args, readOnly());
      expect([args[0], r.code]).toEqual([args[0], 1]);
      expect(r.err).toContain("playbooks.adding");
    }
    expect(readFileSync(file("keep"), "utf8")).toContain("original");
    expect(existsSync(file("new"))).toBe(false);
    expect((await cli(["list"], readOnly())).code).toBe(0);
    expect((await cli(["show", "keep"], readOnly())).code).toBe(0);
  });
});

describe("dashboard API requests", () => {
  it("answers 404 for an unknown route and 405 for the wrong method", async () => {
    expect((await api(ctx, "GET", "/api/playbooks/nope")).status).toBe(404);
    expect((await api(ctx, "POST", "/api/playbooks/nope")).status).toBe(404);
    for (const method of ["PUT", "DELETE", "PATCH", "POST"])
      expect([method, (await api(ctx, method, "/api/playbooks")).status]).toEqual([method, 405]);
    for (const method of ["PUT", "DELETE", "PATCH"])
      expect([method, (await api(ctx, method, "/api/playbooks/save")).status]).toEqual([
        method,
        405,
      ]);
    expect((await api(ctx, "HEAD", "/api/playbooks")).status).toBe(200);
  });

  it("answers 400, not an error, for a body that is not an object or has a bad id", async () => {
    for (const body of [null, "text", [1, 2], 7])
      expect([
        JSON.stringify(body),
        (await api(ctx, "POST", "/api/playbooks/save", body)).status,
      ]).toEqual([JSON.stringify(body), 400]);
    for (const path of ["/api/playbooks/suggestion/accept", "/api/playbooks/suggestion/dismiss"])
      for (const bad of [{ id: "abc" }, { id: 1.5 }, { id: Number.NaN }, {}])
        expect([
          path,
          JSON.stringify(bad),
          (await api(extracting(), "POST", path, bad)).status,
        ]).toEqual([path, JSON.stringify(bad), 400]);
    expect((await api(ctx, "POST", "/api/playbooks/run", { name: "ghost" })).status).toBe(400);
    expect((await api(ctx, "POST", "/api/playbooks/delete", { name: "../x" })).status).toBe(400);
  });

  it("records a use as started unless the page names an outcome, and rejects an unknown status", async () => {
    write(ctx, db, { name: "pb", title: "PB", prompt: "x" });
    await api(ctx, "POST", "/api/playbooks/run", { name: "pb" });
    await api(ctx, "POST", "/api/playbooks/run", { name: "pb", status: "bogus" });
    await api(ctx, "POST", "/api/playbooks/run", { name: "pb", status: "done" });
    const rows = db.playbooks.runs({ playbook: "pb" });
    expect(rows.map((r) => [r.trigger, r.status]).sort()).toEqual([
      ["ui", "done"],
      ["ui", "started"],
      ["ui", "started"],
    ]);
  });

  it("saves a private playbook into the ignored folder and reports it as private", async () => {
    const r = await api(ctx, "POST", "/api/playbooks/save", {
      name: "mine",
      title: "Mine",
      prompt: "x",
      private: true,
    });
    expect(r.body).toMatchObject({ path: ".eminiar/playbooks-private/mine.md" });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".eminiar/playbooks-private/");
    const o = (await api(ctx, "GET", "/api/playbooks")).body as {
      playbooks: Array<{ name: string; private: boolean }>;
    };
    expect(o.playbooks.find((p) => p.name === "mine")?.private).toBe(true);
  });
});

describe("eminiar playbook exit codes", () => {
  beforeEach(async () => {
    await cli(["add", "pb", "--title", "PB", "--prompt", "Do {{what}}", "--tag", "t1"]);
  });

  it("0 for what worked, 1 for a playbook or file that is not there, 2 for a command line that is wrong", async () => {
    const table: Array<[string[], number]> = [
      [[], 0],
      [["help"], 0],
      [["list"], 0],
      [["show", "pb"], 0],
      [["runs"], 0],
      [["runs", "pb"], 0],
      [["runs", "ghost"], 0],
      [["show", "ghost"], 1],
      [["run", "ghost"], 1],
      [["export", "ghost"], 1],
      [["edit", "ghost", "--title", "x"], 1],
      [["rm", "ghost"], 1],
      [["add", "pb", "--title", "T", "--prompt", "dup"], 1],
      [["add", "Bad Name", "--title", "T", "--prompt", "p"], 1],
      [["add", "nofile", "--title", "T", "--file", join(root, "missing.txt")], 1],
      [["run", "pb", "--set", "novalue"], 1],
      [["export", "pb", "--skill", "--target", "../out"], 1],
      [["bogus"], 2],
      [["show"], 2],
      [["add"], 2],
      [["edit"], 2],
      [["rm"], 2],
      [["run"], 2],
      [["export"], 2],
      [["add", "x", "--title"], 2],
      [["add", "x", "--title", "T"], 2],
      [["runs", "--limit", "0"], 2],
      [["runs", "--limit", "-1"], 2],
      [["runs", "--limit", "1.5"], 2],
      [["runs", "--limit", "abc"], 2],
      [["runs", "--limit"], 2],
      [["export", "pb", "--skill", "--schedule"], 2],
    ];
    for (const [args, code] of table) {
      const r = await cli(args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), code]);
    }
  });

  it("an unknown command prints the usage on stderr and nothing on stdout", async () => {
    const r = await cli(["bogus"]);
    expect(r.out).toBe("");
    expect(r.err).toContain("usage: eminiar playbook");
    expect((await cli(["help"])).out).toContain("usage: eminiar playbook");
  });

  it("--json prints one JSON document on success, and nothing on stdout on failure", async () => {
    for (const args of [
      ["list", "--json"],
      ["show", "pb", "--json"],
      ["runs", "--json"],
      ["export", "pb", "--json"],
      ["export", "pb", "--schedule", "--json"],
      ["run", "pb", "--set", "what=x", "--json"],
      ["add", "j", "--title", "J", "--prompt", "p", "--json"],
      ["rm", "j", "--json"],
    ]) {
      const r = await cli(args);
      expect([args.join(" "), r.code]).toEqual([args.join(" "), 0]);
      expect(() => JSON.parse(r.out), args.join(" ")).not.toThrow();
    }
    for (const args of [
      ["show", "ghost", "--json"],
      ["rm", "ghost"],
      ["run", "ghost", "--json"],
    ]) {
      const r = await cli(args);
      expect([args.join(" "), r.code, r.out === "" || JSON.parse(r.out).removed === false]).toEqual(
        [args.join(" "), 1, true],
      );
      expect(r.err).not.toBe("");
    }
  });

  it("add --file reads the prompt from a file, and --private keeps it out of git", async () => {
    const prompt = join(root, "prompt.txt");
    writeFileSync(prompt, "Prompt from a file\n");
    const r = await cli(["add", "fromfile", "--title", "From file", "--file", prompt, "--private"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(".eminiar/playbooks-private/fromfile.md");
    expect(readFileSync(file("fromfile", true), "utf8")).toContain("Prompt from a file");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".eminiar/playbooks-private/");
    expect((await cli(["list"])).out).toMatch(/fromfile .*private/);
    expect((await cli(["show", "fromfile"])).out).toContain("(private)");
    const edit = await cli(["edit", "fromfile", "--prompt", "Changed"]);
    expect(edit.code).toBe(0);
    expect(existsSync(file("fromfile", true))).toBe(true);
    expect(existsSync(file("fromfile"))).toBe(false);
  });

  it("list --tag filters, and a run is recorded for a private playbook too", async () => {
    await cli(["add", "other", "--title", "Other", "--prompt", "p", "--tag", "t2", "--private"]);
    expect((await cli(["list", "--tag", "t1"])).out).toMatch(/^pb /);
    expect((await cli(["list", "--tag", "t1"])).out).not.toContain("other");
    expect((await cli(["run", "other"])).code).toBe(0);
    expect((await cli(["runs", "other"])).out).toContain("other  started  via cli");
    expect((await cli(["runs", "pb"])).out).toBe("no runs recorded");
  });

  it("masks the note of a run it records", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await cli(["run", "pb", "--set", "what=x", "--note", `used ${secret}`]);
    expect(JSON.stringify(db.playbooks.runs({ playbook: "pb" }))).not.toContain(secret);
  });
});
