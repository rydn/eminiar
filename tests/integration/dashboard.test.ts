import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetContextCache } from "../../src/context.js";
import { closeAllStorage } from "../../src/storage/index.js";

let port = 0;
let root: string;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

beforeAll(async () => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  process.env.EMINIAR_PLUGIN_ROOT = process.cwd();
  root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), '{"name":"demo","main":"src/a.ts"}');
  writeFileSync(join(root, "README.md"), "# Demo\n\nThe dashboard shows savings.\n");
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src/a.ts"),
    'import { b } from "./b.js";\nexport function a() { return b(); }\n',
  );
  writeFileSync(join(root, "src/b.ts"), "export function b() { return 1; }\n");
  resetContextCache();
  port = await freePort();
  const { serve } = await import("../../src/ui/server.js");
  // serve() never resolves (it keeps the process alive); run it detached.
  void serve({ port, open: false, root });
  await new Promise((r) => setTimeout(r, 300));
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
  delete process.env.EMINIAR_PLUGIN_ROOT;
});

const get = async (p: string, init?: RequestInit) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init);
  return { status: r.status, body: await r.text() };
};
const j = async <T>(p: string, init?: RequestInit): Promise<T> =>
  JSON.parse((await get(p, init)).body) as T;
const post = (p: string, body: unknown, method = "POST", headers: Record<string, string> = {}) =>
  get(p, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("dashboard", () => {
  it("serves the page and the JSON API", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>eminiar</title>");

    const stats = await j<{ project: string; index: { documents: number } }>("/api/stats");
    expect(stats.project).toBe(realpathSync(root));

    const { emIndex } = await import("../../src/tools/em_index.js");
    const { getContext } = await import("../../src/context.js");
    await emIndex.handler({ path: "README.md" }, getContext(root));
    const search = await j<{ hits: Array<{ title: string }> }>(
      "/api/search?q=savings&mode=lexical",
    );
    expect(search.hits[0]?.title).toContain("README.md");

    const added = JSON.parse(
      (
        await post("/api/memories", {
          kind: "fact",
          content: "dashboard test memory",
          tags: "a, b",
        })
      ).body,
    ) as { id: number; name: string };
    expect(added.id).toBeGreaterThan(0);
    expect(added.name).toBe("fact/dashboard-test-memory");
    type MemList = {
      memories: Array<{ id: number; name: string; tags: string[]; status: string | null }>;
      statuses: string[];
    };
    const list = await j<MemList>("/api/memories");
    const mine = list.memories.find((m) => m.id === added.id);
    expect(mine?.tags).toEqual(["a", "b"]);
    expect(list.statuses).toContain("superseded");

    const updated = JSON.parse(
      (
        await post(
          `/api/memories?name=${added.name}`,
          { content: "edited body", kind: "note" },
          "PUT",
        )
      ).body,
    ) as { name: string };
    expect(updated.name).toBe(added.name);
    const body = await j<{ body: string; kind: string; tags: string[] }>(
      `/api/memories?name=${added.name}`,
    );
    expect(body.body).toBe("edited body");
    expect(body.kind).toBe("note");
    expect(body.tags).toEqual(["a", "b"]);

    // decision lifecycle through the API
    await post("/api/memories", { kind: "decision", content: "Old way", name: "decision/old" });
    const nd = JSON.parse(
      (
        await post("/api/memories", {
          kind: "decision",
          content: "New way",
          name: "decision/new",
          supersedes: "decision/old",
        })
      ).body,
    ) as { superseded?: string };
    expect(nd.superseded).toBe("decision/old");
    const accepted = await j<MemList>("/api/memories?kind=decision&status=accepted");
    expect(accepted.memories.map((m) => m.name)).toEqual(["decision/new"]);
    const st = JSON.parse(
      (await post("/api/memories?name=decision/new", { status: "proposed" }, "PATCH")).body,
    ) as { status: string };
    expect(st.status).toBe("proposed");

    const renamed = JSON.parse(
      (await post(`/api/memories?name=${added.name}`, { to: "note/renamed-memory" }, "PATCH")).body,
    ) as { name: string };
    expect(renamed.name).toBe("note/renamed-memory");
    await get("/api/memories?name=note/renamed-memory", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect((await j<MemList>("/api/memories")).memories.length).toBe(list.memories.length + 1);

    // documentation sources through the API
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/intro.md"), "# Intro\n\nDashboard docs api content.\n");
    const addedDocs = JSON.parse(
      (await post("/api/docs", { sources: [{ name: "docs", path: "docs" }], sync: true })).body,
    ) as { added: string[]; sync: Array<{ pages: number }> };
    expect(addedDocs.added).toEqual(["docs"]);
    expect(addedDocs.sync[0]?.pages).toBe(1);
    const docsList = await j<{
      sources: Array<{ name: string; documents: number }>;
      manifest: string;
    }>("/api/docs");
    expect(docsList.manifest).toBe(".eminiar/docs.json");
    expect(docsList.sources[0]?.documents).toBe(1);
    const pages = await j<Array<{ title: string }>>("/api/docs/pages?name=docs");
    expect(pages[0]?.title).toBe("docs/intro.md");
    const disc = await j<{ local: Array<{ name: string; registered: boolean }> }>(
      "/api/docs/discover",
    );
    expect(disc.local.find((c) => c.name === "docs")?.registered).toBe(true);
    // history endpoints degrade gracefully outside a git repository
    const hist = await j<{ git: boolean; error?: string }>("/api/history");
    expect(hist.git).toBe(false);
    expect(hist.error).toMatch(/not a git repository/);
    expect((await get("/api/history/commit")).status).toBe(400);
    expect((await j<{ git: boolean }>("/api/history/risk")).git).toBe(false);

    const dsearch = await j<{ hits: Array<{ source: string }> }>(
      "/api/search?q=dashboard&mode=lexical&source=docs:*",
    );
    expect(dsearch.hits[0]?.source).toBe("docs:docs");
    const synced = JSON.parse((await post("/api/docs/sync", { names: ["docs"] })).body) as {
      results: Array<{ unchanged: number }>;
    };
    expect(synced.results[0]?.unchanged).toBe(1);
    const resolved = await j<{ via: string }>("/api/docs/resolve?provider=npm:zod");
    expect(resolved.via).toBe("catalog");
    const removedDocs = await j<{ removed: boolean; documents: number }>("/api/docs?name=docs", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(removedDocs).toEqual({ removed: true, documents: 1 });
    expect((await get("/api/docs/pages")).status).toBe(400);

    const sessions = await j<unknown[]>("/api/sessions");
    expect(Array.isArray(sessions)).toBe(true);

    const action = JSON.parse((await post("/api/actions", { action: "reconcile" })).body) as {
      ok: boolean;
      output: string;
    };
    expect(action.ok).toBe(true);
    expect(action.output).toContain("memories:");
    const refused = JSON.parse(
      (await post("/api/actions", { action: "purge", scope: "index" })).body,
    ) as { ok: boolean };
    expect(refused.ok).toBe(false);
    expect((await get("/api/actions")).status).toBe(405);
    expect((await get("/api/nope")).status).toBe(404);
    expect((await get("/api/search")).status).toBe(400);
  });

  it("answers the explorer endpoints after a code reindex", async () => {
    const r = JSON.parse(
      (await post("/api/actions", { action: "reindex", scope: "code" })).body,
    ) as { ok: boolean; output: string };
    expect(r.ok).toBe(true);
    expect(r.output).toContain("2 parsed");

    const status = await j<{
      state: string;
      graph: { nodes: number };
      files: { byStatus: Record<string, number> };
    }>("/api/status");
    expect(status.state).toBe("fresh");
    expect(status.graph.nodes).toBeGreaterThan(2);
    expect(status.files.byStatus.indexed).toBe(2);

    const tree = await j<{ files: Array<{ path: string; status: string; symbols: number }> }>(
      "/api/tree",
    );
    expect(tree.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);

    const file = await j<{ content: string; symbols: Array<{ name: string }> }>(
      "/api/file?path=src/a.ts",
    );
    expect(file.content).toContain("export function a()");
    expect(file.symbols.map((s) => s.name)).toEqual(["a"]);
    expect((await get("/api/file?path=../package.json")).status).toBe(403);
    expect((await get("/api/file?path=src/nope.ts")).status).toBe(404);

    const impact = await j<{
      directDependents: number;
      hits: Array<{ id: string }>;
      graph: { nodes: unknown[] };
    }>("/api/file-impact?path=src/b.ts");
    expect(impact.directDependents).toBe(1);
    expect(impact.hits[0]?.id).toBe("file:src/a.ts");
    expect(impact.graph.nodes.length).toBe(2);

    const sym = await j<{ node: { kind: string }; callers: Array<{ node: { id: string } }> }>(
      "/api/symbol?id=src/b.ts%23b",
    );
    expect(sym.node.kind).toBe("function");
    expect(sym.callers[0]?.node.id).toBe("sym:src/a.ts#a");

    const found = await j<Array<{ id: string }>>("/api/nodes/search?q=b");
    expect(found.some((n) => n.id === "sym:src/b.ts#b")).toBe(true);

    const expand = await j<{ root: string; nodes: unknown[]; edges: unknown[] }>(
      "/api/graph?mode=expand&node=src/b.ts&direction=in&kinds=imports",
    );
    expect(expand.root).toBe("file:src/b.ts");
    expect(expand.nodes.length).toBe(2);

    // The project map draws only the selected edge kinds, lifting symbol edges to files.
    type MapResult = {
      nodes: Array<{ id: string }>;
      edges: Array<{ src: string; dst: string; kind: string }>;
    };
    const map = (kinds: string) => j<MapResult>(`/api/graph?mode=map&kinds=${kinds}`);
    expect((await map("imports")).edges).toEqual([
      expect.objectContaining({ src: "file:src/a.ts", dst: "file:src/b.ts", kind: "imports" }),
    ]);
    expect((await map("calls")).edges).toEqual([
      expect.objectContaining({ src: "file:src/a.ts", dst: "file:src/b.ts", kind: "calls" }),
    ]);
    expect((await map("defines")).edges).toEqual([]);
    const none = await map("none");
    expect(none.edges).toEqual([]);
    expect(none.nodes.length).toBe(2);

    const path = await j<{ edges: unknown[] }>("/api/graph?mode=path&node=src/a.ts&to=src/b.ts");
    expect(path.edges.length).toBe(1);
    const behavior = await j<{ callees: Array<{ node: { id: string } }> }>(
      "/api/behavior?id=src/a.ts%23a",
    );
    expect(behavior.callees[0]?.node.id).toBe("sym:src/b.ts#b");

    const arch = await j<{
      project: { name: string };
      entryPoints: Array<{ kind: string; path: string }>;
    }>("/api/architecture?aspects=overview,entry_points");
    expect(arch.project.name).toBe("demo");
    expect(arch.entryPoints).toEqual(
      expect.arrayContaining([{ kind: "main", name: "main", path: "src/a.ts" }]),
    );
    const hot = await j<Array<{ path: string }>>("/api/hotspots?kind=file");
    expect(hot.length).toBe(2);
    expect(Array.isArray(await j<unknown[]>("/api/routes"))).toBe(true);
    const clusters = await j<{ clusters: unknown[]; members: Record<string, unknown[]> }>(
      "/api/clusters",
    );
    expect(clusters.clusters.length).toBeGreaterThan(0);
    const coverage = await j<{ summary: { byStatus: Record<string, number> }; files: unknown[] }>(
      "/api/coverage",
    );
    expect(coverage.summary.byStatus.indexed).toBe(2);
    expect(coverage.files.length).toBe(2);
    const runs = await j<Array<{ scope: string }>>("/api/runs");
    expect(runs[0]?.scope).toBe("code");
    const changes = await j<{ base?: string; error?: string }>("/api/changes");
    expect(changes.base ?? changes.error).toBeDefined();

    // reindex a single file through the action
    const one = JSON.parse(
      (await post("/api/actions", { action: "reindex", scope: "code", paths: ["src/a.ts"] })).body,
    ) as { output: string };
    expect(one.output).toContain("1 scanned");
  });

  it("answers the usage endpoints", async () => {
    const { getContext } = await import("../../src/context.js");
    const { getStorage } = await import("../../src/storage/index.js");
    const db = getStorage(getContext(root));
    const ts = Date.now() - 60_000;
    const row = (i: number, session: string) => ({
      request_id: `req-${i}`,
      message_id: `msg-${i}`,
      session_id: session,
      agent_id: null,
      sidechain: 0,
      ts: ts + i * 1000,
      model: "claude-sonnet-5-5",
      input_tokens: 1000,
      output_tokens: 200,
      cache_create_5m: 500,
      cache_create_1h: 0,
      cache_read: 8000,
      thinking_tokens: 0,
      web_searches: 0,
      web_fetches: 0,
      service_tier: null,
      speed: null,
      stop_reason: "end_turn",
      prompt_id: null,
      git_branch: null,
      cwd: null,
      effort: null,
      version: null,
      entrypoint: null,
      cost_usd: 0.01,
      priced: 1,
    });
    db.apiCallsUpsert([row(1, "s-usage"), row(2, "s-usage"), row(3, "s-other")]);
    db.toolUsesUpsert([
      {
        tool_use_id: "tu-1",
        session_id: "s-usage",
        agent_id: null,
        ts: ts + 500,
        tool: "Bash",
        input_chars: 10,
        result_chars: 4000,
        is_error: 0,
        request_id: "req-1",
      },
    ]);

    const summary = await j<{
      view: string;
      scope: string;
      totals: { calls: number; costUsd: number };
      today: { calls: number };
      cache: { hitRate: number };
      models: Array<{ model: string }>;
      block: { active: boolean } | null;
      insights: unknown[];
      scores: Array<{ id: string; reasons: string[] }>;
      savings: { assumptions: string[] };
    }>("/api/usage?view=summary");
    expect(summary.view).toBe("summary");
    expect(summary.scope).toBe("project");
    expect(summary.totals.calls).toBe(3);
    expect(summary.totals.costUsd).toBeCloseTo(0.03);
    expect(summary.cache.hitRate).toBeGreaterThan(0.5);
    expect(summary.models[0]?.model).toBe("claude-sonnet-5-5");
    expect(summary.block?.active).toBe(true);
    expect(Array.isArray(summary.insights)).toBe(true);
    expect(summary.scores.map((s) => s.id)).toContain("context-health");
    expect(summary.savings.assumptions.length).toBeGreaterThan(0);

    const daily = await j<{ rows: Array<{ key: string; models: Array<{ model: string }> }> }>(
      "/api/usage?view=daily&since=7d",
    );
    expect(daily.rows.length).toBe(1);
    expect(daily.rows[0]?.models[0]?.model).toBe("claude-sonnet-5-5");
    const sessions = await j<{ rows: Array<{ session: string }> }>(
      "/api/usage?view=sessions&limit=1",
    );
    expect(sessions.rows.length).toBe(1);
    const scoped = await j<{ scope: string; totals: { calls: number } }>(
      "/api/usage?view=summary&session=s-usage",
    );
    expect(scoped.scope).toBe("session");
    expect(scoped.totals.calls).toBe(2);

    const limited = await j<{ rows: unknown[] }>("/api/usage?view=sessions&limit=1000");
    expect(limited.rows.length).toBe(2);
    const scopedProject = await j<{ scope: string; totals: { calls: number } }>(
      "/api/usage?view=summary&scope=project",
    );
    expect(scopedProject.scope).toBe("project");
    expect(scopedProject.totals.calls).toBe(3);

    type Detail = {
      session: string;
      timeline: Array<{ contextTokens: number }>;
      calls?: Array<{ model: string }>;
      toolUses: Array<{ tool: string; chars: number }>;
      insights: unknown[];
      scores: unknown[];
    };
    const detail = await j<Detail>("/api/usage/session?id=s-usage");
    expect(detail.session).toBe("s-usage");
    expect(detail.timeline.length).toBe(2);
    expect(detail.timeline[0]?.contextTokens).toBe(9500);
    expect(detail.calls).toBeUndefined(); // the per-call rows only on request
    expect(detail.toolUses).toEqual([expect.objectContaining({ tool: "Bash", chars: 4000 })]);
    expect(Array.isArray(detail.insights)).toBe(true);
    expect(detail.scores.length).toBeGreaterThan(0);
    const withCalls = await j<Detail>("/api/usage/session?id=s-usage&calls=1");
    expect(withCalls.calls?.length).toBe(2);
    expect(withCalls.calls?.[0]?.model).toBe("claude-sonnet-5-5");

    // bad query values are 400s, never defaults
    for (const bad of [
      "/api/usage?view=nope",
      "/api/usage?view=daily&since=lately",
      "/api/usage?view=daily&since=1",
      "/api/usage?view=daily&since=32",
      "/api/usage?view=daily&since=1/1",
      "/api/usage?view=daily&since=99999999999999999999d",
      "/api/usage?view=sessions&limit=0",
      "/api/usage?view=sessions&limit=-1",
      "/api/usage?view=sessions&limit=abc",
      "/api/usage?view=sessions&limit=1001",
      "/api/usage?view=sessions&limit=1.5",
      "/api/usage?scope=bogus",
      "/api/usage?session=../x",
      "/api/usage?session=a%20b",
      `/api/usage?session=${"x".repeat(129)}`,
      "/api/usage/session",
      "/api/usage/session?id=../x",
      "/api/usage/session?id=a/b",
    ]) {
      const r = await get(bad);
      expect(r.status, bad).toBe(400);
      expect((JSON.parse(r.body) as { error: string }).error, bad).toBeTruthy();
    }
    const unknownSession = await j<{ session: string; timeline: unknown[] }>(
      "/api/usage/session?id=never-seen_1.0",
    );
    expect(unknownSession.timeline).toEqual([]);
  });

  it("refuses cross-site and foreign-host requests", async () => {
    // fetch drops a custom Host header, so go through node:http
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/stats", headers: { host: "evil.example:80" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(foreign).toBe(403);
    const form = await post("/api/actions", { action: "reconcile" }, "POST", {
      "content-type": "text/plain",
    });
    expect(form.status).toBe(403);
    const crossOrigin = await post("/api/actions", { action: "reconcile" }, "POST", {
      origin: "http://evil.example",
    });
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await post("/api/actions", { action: "reconcile" }, "POST", {
      origin: `http://127.0.0.1:${port}`,
    });
    expect(sameOrigin.status).toBe(200);
  });
});
