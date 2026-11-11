import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { architecture, formatArchitecture } from "../../src/graph/architecture.js";
import { detectChanges, isDiffRef } from "../../src/graph/changes.js";
import { readClusters, readCycles } from "../../src/graph/metrics.js";
import { deadCode, hotspots, impact, pattern, routes } from "../../src/graph/query.js";
import { indexFreshness, reindexCode, reindexGitSignals } from "../../src/graph/reindex.js";
import { resetResolveCache, resolveImport } from "../../src/graph/resolve.js";
import { parseFile } from "../../src/graph/treesitter.js";
import { write as writeMemory } from "../../src/memory/store.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { indexStatus } from "../../src/tools/em_index_status.js";

let root: string;
let ctx: ProjectContext;
let db: SqliteAdapter;

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    bin: { fixture: "./src/cli.ts" },
    main: "src/index.ts",
    workspaces: ["packages/*"],
    scripts: { build: "tsc" },
  }),
  "packages/shared/package.json": JSON.stringify({
    name: "@fixture/shared",
    exports: { ".": { import: "./dist/index.js", default: "./src/index.ts" } },
  }),
  "packages/shared/src/index.ts": "export function shared(): number { return 1; }\n",
  // barrel re-exporting with an alias, plus a default export
  "src/util/impl.ts":
    "export function helper(x: number) { if (x > 1 && x < 10) { return x * 2; } return x; }\nexport const K = 1;\nexport default class Store { get() { return K; } }\n",
  "src/util/index.ts":
    'export { helper as help, K } from "./impl.js";\nexport * from "./extra.js";\n',
  "src/util/extra.ts": "export function extra() { return 3; }\n",
  "src/service.ts":
    'import { help, extra } from "./util/index.js";\nimport Store from "./util/impl.js";\nimport { shared } from "@fixture/shared";\nexport class Service {\n  run() { return help(1) + extra() + shared(); }\n  store() { const s = new Store(); return s.get(); }\n}\nexport function unused() { return 0; }\n',
  // express-style routes
  "src/server.ts":
    'import express from "express";\nimport { Service } from "./service.js";\nconst app = express();\nconst svc = new Service();\nexport function listUsers(req: unknown, res: unknown) { return svc.run(); }\napp.get("/users", listUsers);\napp.post("/users/:id", (req, res) => { svc.store(); });\nexport default app;\n',
  "app/api/health/route.ts": 'export async function GET() { return new Response("ok"); }\n',
  // an import cycle
  "src/cycle/a.ts": 'import { b } from "./b.js";\nexport function a() { return b(); }\n',
  "src/cycle/b.ts": 'import { a } from "./a.js";\nexport function b() { return a(); }\n',
  "src/index.ts": 'import { Service } from "./service.js";\nexport { Service };\n',
  "src/cli.ts": 'import { Service } from "./service.js";\nnew Service().run();\n',
  "notes.rb": "def rb; end\n",
};

function git(cmd: string) {
  return execSync(`git ${cmd}`, {
    cwd: root,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "dev",
      GIT_AUTHOR_EMAIL: "d@x",
      GIT_COMMITTER_NAME: "dev",
      GIT_COMMITTER_EMAIL: "d@x",
    },
  })
    .toString()
    .trim();
}

beforeAll(async () => {
  process.env.EMINIAR_PLUGIN_ROOT = process.cwd();
  root = mkdtempSync(join(tmpdir(), "em-depth-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  // a file over the size limit, and config that includes ruby so it shows as unsupported
  writeFileSync(join(root, "src/huge.ts"), `// ${"x".repeat(1_600_000)}\n`);
  resetResolveCache();
  const config = ConfigSchema.parse({ graph: { include: ["**/*.ts", "**/*.rb"] } });
  ctx = { root, id: "d", dbPath: join(root, "d.db"), config };
  db = new SqliteAdapter(ctx.dbPath);
  git("init -q");
  git("add . && git commit -qm one");
}, 60_000);

afterAll(() => {
  db.close();
  delete process.env.EMINIAR_PLUGIN_ROOT;
});

describe("resolution", () => {
  it("resolves workspace packages through package.json exports", () => {
    expect(resolveImport(root, "src/service.ts", "@fixture/shared")).toBe(
      "packages/shared/src/index.ts",
    );
  });

  it("emits reexports, default exports, instance method calls, complexity and routes", async () => {
    const barrel = await parseFile(root, "src/util/index.ts", files["src/util/index.ts"]!);
    const re = barrel.edges.filter((e) => e.kind === "reexports");
    expect(re.map((e) => e.dst)).toEqual(["file:src/util/impl.ts", "file:src/util/extra.ts"]);
    expect(re[0]!.meta).toMatchObject({ names: ["helper as help", "K"] });
    expect(re[1]!.meta).toMatchObject({ names: ["*"] });
    expect(barrel.exports).toEqual(["help", "K"]);

    const impl = await parseFile(root, "src/util/impl.ts", files["src/util/impl.ts"]!);
    expect(impl.nodes.find((n) => n.id === "file:src/util/impl.ts")?.meta).toMatchObject({
      default_export: "Store",
    });
    const helper = impl.nodes.find((n) => n.id === "sym:src/util/impl.ts#helper")!;
    expect(helper.meta).toMatchObject({ complexity: 3, exported: true });

    const svc = await parseFile(root, "src/service.ts", files["src/service.ts"]!);
    const calls = svc.edges.filter((e) => e.kind === "calls").map((e) => e.dst);
    expect(calls).toContain("sym:src/util/impl.ts#default.get"); // via `const s = new Store()`
    expect(calls).toContain("sym:src/util/index.ts#help"); // barrel: fixed by the link pass

    const server = await parseFile(root, "src/server.ts", files["src/server.ts"]!);
    const routeNodes = server.nodes.filter((n) => n.kind === "route");
    expect(routeNodes.map((n) => n.name).sort()).toEqual(["GET /users", "POST /users/:id"]);
    expect(routeNodes[0]!.meta).toMatchObject({ framework: "express" });
    const handles = server.edges.filter((e) => e.kind === "handles");
    expect(handles.find((e) => e.dst === "route:GET /users")?.src).toBe(
      "sym:src/server.ts#listUsers",
    );
    // the inline handler is attributed to the file (no enclosing symbol)
    expect(handles.find((e) => e.dst === "route:POST /users/:id")?.src).toBe("file:src/server.ts");

    const next = await parseFile(
      root,
      "app/api/health/route.ts",
      files["app/api/health/route.ts"]!,
    );
    expect(next.nodes.find((n) => n.kind === "route")?.name).toBe("GET /api/health");
  });
});

describe("index pipeline", () => {
  it("records coverage, links barrels and defaults, computes metrics, clusters and cycles", async () => {
    const s = await reindexCode(ctx, db, { full: true });
    expect(s.skipped).toBe(1);
    expect(s.unsupported).toBe(1);
    expect(db.fileIndexGet("src/huge.ts")?.status).toBe("skipped");
    expect(db.fileIndexGet("notes.rb")?.status).toBe("unsupported");
    expect(db.fileIndexGet("src/service.ts")).toMatchObject({ status: "indexed", symbols: 4 });
    const summary = db.fileIndexSummary();
    expect(summary.byStatus).toMatchObject({ skipped: 1, unsupported: 1 });
    expect(summary.reasons.map((r) => r.reason)).toEqual(
      expect.arrayContaining(["over 1.5 MB", "no parser for .rb"]),
    );

    // link pass: the call through the barrel now points at the real symbol
    expect(s.link!.resolved).toBeGreaterThanOrEqual(2);
    const run = db.graphEdgesFrom(["sym:src/service.ts#Service.run"], ["calls"]);
    expect(run.map((e) => e.dst)).toEqual(
      expect.arrayContaining(["sym:src/util/impl.ts#helper", "sym:src/util/extra.ts#extra"]),
    );
    expect(run.find((e) => e.dst === "sym:src/util/impl.ts#helper")?.meta).toContain(
      '"via":"sym:src/util/index.ts#help"',
    );
    // default import resolved to the named class, and the instance call to its method
    const refs = db.graphEdgesTo(["sym:src/util/impl.ts#Store"]);
    expect(refs.some((e) => e.src === "sym:src/service.ts#Service.store")).toBe(true);
    expect(
      db.graphEdgesFrom(["sym:src/service.ts#Service.store"], ["calls"]).map((e) => e.dst),
    ).toContain("sym:src/util/impl.ts#Store.get");
    // workspace package import resolved to a file
    expect(db.graphEdgesFrom(["file:src/service.ts"], ["imports"]).map((e) => e.dst)).toContain(
      "file:packages/shared/src/index.ts",
    );

    // metrics
    expect(s.metrics!.nodes).toBeGreaterThan(10);
    const helper = db.metricsGet(["sym:src/util/impl.ts#helper"])[0]!;
    expect(helper.fan_in).toBe(1);
    expect(helper.complexity).toBe(3);
    expect(readCycles(db)).toEqual([["src/cycle/a.ts", "src/cycle/b.ts"]]);
    const clusters = readClusters(db);
    expect(clusters.length).toBeGreaterThan(1);
    expect(clusters.reduce((a, c) => a + c.size, 0)).toBe(db.graphFileNodes().length);
    const cycleCluster = db.metricsGet(["file:src/cycle/a.ts", "file:src/cycle/b.ts"]);
    expect(cycleCluster[0]!.cluster).toBe(cycleCluster[1]!.cluster);

    // a run was logged
    const runs = db.indexRunsRecent(5);
    expect(runs[0]).toMatchObject({ scope: "code", scanned: 13, errors: 0 });
    expect(runs[0]!.finished_at).not.toBeNull();
  }, 60_000);

  it("answers routes, dead code, hotspots and pattern queries", () => {
    const r = routes(db);
    expect(r.map((x) => `${x.method} ${x.path}`)).toEqual([
      "GET /api/health",
      "GET /users",
      "POST /users/:id",
    ]);
    expect(r[1]!.handlers[0]!.name).toBe("listUsers");

    const dead = deadCode(db).map((d) => d.node.name);
    expect(dead).toContain("unused");
    expect(dead).not.toContain("listUsers"); // route handler
    expect(dead).not.toContain("GET"); // route handler (Next)

    expect(hotspots(db, 5)[0]!.score).toBeGreaterThan(0);
    expect(hotspots(db, 5, { kind: "symbol" })[0]!.kind).not.toBe("file");

    // every handler of every route, walking `handles` backwards
    const handlers = pattern(db, {
      from: { kind: "route" },
      edge: { kinds: ["handles"], direction: "in" },
    });
    expect(handlers.starts.length).toBe(3);
    expect(handlers.nodes.map((n) => n.node.id)).toEqual(
      expect.arrayContaining(["sym:src/server.ts#listUsers", "sym:app/api/health/route.ts#GET"]),
    );
    // callers of helper two hops up, with paths
    const callers = pattern(db, {
      from: { name: "^helper$", kind: "function" },
      edge: { kinds: ["calls"], direction: "in", depth: 2 },
      return: "paths",
    });
    expect(callers.nodes.map((n) => n.node.id)).toContain("sym:src/service.ts#Service.run");
    expect(callers.paths[0]!.length).toBeGreaterThanOrEqual(1);
    // `to` without `from` walks the other way
    const viaTo = pattern(db, {
      edge: { kinds: ["imports"], direction: "out" },
      to: { path: "service.ts", kind: "file" },
    });
    expect(viaTo.nodes.map((n) => n.node.id)).toEqual(
      expect.arrayContaining(["file:src/index.ts", "file:src/cli.ts", "file:src/server.ts"]),
    );
  });

  it("summarises the architecture", () => {
    reindexGitSignals(ctx, db, true);
    const a = architecture(ctx, db);
    expect(a.project.name).toBe("fixture");
    expect(a.overview.languages).toMatchObject({ typescript: 12, other: 1 });
    expect(a.folders.map((f) => f.path)).toEqual(
      expect.arrayContaining(["src/", "app/", "packages/", "(root)"]),
    );
    expect(a.entryPoints).toEqual(
      expect.arrayContaining([
        { kind: "bin", name: "fixture", path: "src/cli.ts" },
        { kind: "main", name: "main", path: "src/index.ts" },
        { kind: "script", name: "build", path: "tsc" },
      ]),
    );
    expect(a.routes.length).toBe(3);
    expect(a.cycles.length).toBe(1);
    const text = formatArchitecture(a);
    expect(text).toContain("fixture v1.0.0");
    expect(text).toContain("GET /users");
    expect(text).toContain("import cycles (1)");
  });

  it("maps a working-tree diff to symbols with exposure and blast radius", () => {
    writeFileSync(
      join(root, "src/util/impl.ts"),
      files["src/util/impl.ts"]!.replace("return x * 2;", "return x * 3;"),
    );
    writeFileSync(join(root, "src/server.ts"), `${files["src/server.ts"]}// touched\n`);
    writeFileSync(join(root, "README.md"), "# new\n");
    const c = detectChanges(db, root);
    expect(c.base).toBe("working tree");
    const helper = c.symbols.find((s) => s.id === "sym:src/util/impl.ts#helper")!;
    expect(helper.lines).toEqual([[1, 1]]);
    expect(helper.exported).toBe(true);
    expect(helper.risk).toBe("medium");
    expect(c.affected.map((h) => h.id)).toContain("file:src/service.ts");
    expect(c.unindexed).toContain("README.md");
    // freshness sees the edited files
    const f = indexFreshness(ctx, db);
    expect(f.dirty).toEqual(expect.arrayContaining(["src/util/impl.ts", "src/server.ts"]));
    expect(indexStatus(ctx, db).files.byStatus.indexed).toBeGreaterThan(5);
    git("add . && git commit -qm two");
    expect(detectChanges(db, root, { ref: "HEAD~1" }).symbols.map((s) => s.name)).toContain(
      "helper",
    );
  });

  it("never hands git an option as the diff ref", () => {
    const good = ["HEAD~1", "main...HEAD", "v1.2.0", "a1b2c3d", "origin/x", "main@{2 weeks ago}"];
    for (const ref of good) expect(isDiffRef(ref), ref).toBe(true);
    for (const ref of ["", "-p", "--output=x", "--no-index", "a\nb", "a\u0000b"])
      expect(isDiffRef(ref), JSON.stringify(ref)).toBe(false);
    // `git diff --output=<file>` truncates <file> and writes the diff there, even outside the repo
    const outside = join(mkdtempSync(join(tmpdir(), "em-victim-")), "victim.txt");
    const inside = join(root, "victim.txt");
    for (const f of [outside, inside]) writeFileSync(f, "keep\n");
    try {
      for (const ref of [`--output=${outside}`, "--output=victim.txt"])
        expect(() => detectChanges(db, root, { ref }), ref).toThrow(/not a ref/);
      for (const f of [outside, inside]) expect(readFileSync(f, "utf8")).toBe("keep\n");
    } finally {
      rmSync(inside, { force: true });
      rmSync(dirname(outside), { recursive: true, force: true });
    }
  });

  it("promotes demoted edges once the target symbol appears", async () => {
    // a call into a symbol that does not exist yet is demoted to the file …
    writeFileSync(
      join(root, "src/cli.ts"),
      'import { Service } from "./service.js";\nimport { later } from "./later.js";\nnew Service().run();\nlater();\n',
    );
    writeFileSync(join(root, "src/later.ts"), "export const placeholder = 1;\n");
    await reindexCode(ctx, db, { paths: ["src/cli.ts", "src/later.ts"] });
    const demoted = db.graphEdgesFrom(["file:src/cli.ts"], ["calls"]);
    expect(demoted.find((e) => e.dst === "file:src/later.ts")?.meta).toContain(
      '"unresolved":"later"',
    );
    // … and promoted back when it is defined
    writeFileSync(join(root, "src/later.ts"), "export function later() { return 1; }\n");
    await reindexCode(ctx, db, { paths: ["src/later.ts"] });
    const calls = db.graphEdgesFrom(["file:src/cli.ts"], ["calls"]).map((e) => e.dst);
    expect(calls).toContain("sym:src/later.ts#later");
    expect(calls).not.toContain("file:src/later.ts");
    // impact from the restored symbol reaches the caller file
    expect(impact(db, "src/later.ts#later")!.hits.map((h) => h.id)).toContain("file:src/cli.ts");
  });
});

describe("decision lifecycle", () => {
  it("stores status and supersedes, and marks the superseded decision", () => {
    const first = writeMemory(ctx, db, {
      name: "decision/old-store",
      kind: "decision",
      content: "Use a global store.",
    });
    expect(first.row.status).toBeNull();
    const second = writeMemory(ctx, db, {
      name: "decision/new-store",
      kind: "decision",
      content: "Use scoped stores.",
      status: "accepted",
      supersedes: "decision/old-store",
    });
    expect(second.superseded).toBe("decision/old-store");
    expect(db.memoryGetByName("decision/old-store")?.status).toBe("superseded");
    expect(db.memoryGetByName("decision/new-store")).toMatchObject({
      status: "accepted",
      supersedes: "decision/old-store",
    });
    expect(db.memoryList({ kind: "decision", status: "accepted" }).map((m) => m.name)).toEqual([
      "decision/new-store",
    ]);
    expect(db.graphEdgesFrom(["memory:decision/new-store"], ["supersedes"])[0]?.dst).toBe(
      "memory:decision/old-store",
    );
    const a = architecture(ctx, db, ["decisions"]);
    expect(a.decisions.map((d) => d.name)).toEqual(["decision/new-store"]);
  });
});
