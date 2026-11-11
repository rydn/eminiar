import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetContextCache } from "../../src/context.js";
import { closeAllStorage } from "../../src/storage/index.js";

/**
 * The Playbooks routes over real HTTP, through the dashboard server: the loopback guard, the
 * JSON content type on writes, and the three config switches as the server resolves them from
 * each project's eminiar.config.json. No model, no network beyond 127.0.0.1.
 */

interface Site {
  port: number;
  root: string;
}

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function start(config?: Record<string, unknown>): Promise<Site> {
  const root = mkdtempSync(join(tmpdir(), "em-pbhttp-"));
  writeFileSync(join(root, "package.json"), '{"name":"pb-demo"}');
  if (config) writeFileSync(join(root, "eminiar.config.json"), JSON.stringify(config));
  const port = await freePort();
  const { serve } = await import("../../src/ui/server.js");
  void serve({ port, open: false, root });
  return { port, root };
}

let open: Site;
let readOnly: Site;
let hidden: Site;
let withScan: Site;

beforeAll(async () => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  process.env.EMINIAR_PLUGIN_ROOT = process.cwd();
  resetContextCache();
  open = await start();
  readOnly = await start({ playbooks: { adding: false } });
  hidden = await start({ playbooks: { viewing: false } });
  withScan = await start({ playbooks: { extraction: { enabled: true } } });
  await new Promise((r) => setTimeout(r, 400));
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
  delete process.env.EMINIAR_PLUGIN_ROOT;
});

type Body = Record<string, unknown>;
async function call(site: Site, path: string, init: RequestInit = {}) {
  const r = await fetch(`http://127.0.0.1:${site.port}${path}`, init);
  const text = await r.text();
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {
    // not JSON
  }
  return { status: r.status, body };
}
const post = (site: Site, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(site, path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("playbooks over HTTP", () => {
  it("saves, lists, records a use and deletes, with the defaults on", async () => {
    const o = await call(open, "/api/playbooks");
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ viewing: true, adding: true, extraction: false, playbooks: [] });
    const s = await post(open, "/api/playbooks/save", {
      title: "Review open PRs",
      prompt: "Review PRs in {{repo}}",
      params: [{ name: "repo", default: "eminiar" }],
    });
    expect(s.status).toBe(200);
    expect(s.body.name).toBe("review-open-prs");
    expect((await post(open, "/api/playbooks/run", { name: "review-open-prs" })).status).toBe(200);
    const after = await call(open, "/api/playbooks");
    expect(
      (after.body.playbooks as Array<{ name: string; runs: number }>).map((p) => [p.name, p.runs]),
    ).toEqual([["review-open-prs", 1]]);
    expect((await post(open, "/api/playbooks/delete", { name: "review-open-prs" })).body).toEqual({
      removed: true,
    });
  });

  it("refuses a write that is not JSON, comes from another origin or another site, and writes nothing", async () => {
    const body = JSON.stringify({ name: "evil", title: "E", prompt: "p" });
    const attempts: Array<[string, RequestInit]> = [
      ["text/plain", { method: "POST", headers: { "content-type": "text/plain" }, body }],
      [
        "form",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      ],
      ["no content type", { method: "POST", body }],
      [
        "foreign origin",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://evil.example" },
          body,
        },
      ],
      [
        "cross-site fetch",
        {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
          body,
        },
      ],
    ];
    for (const [label, init] of attempts) {
      const r = await call(open, "/api/playbooks/save", init);
      expect([label, r.status]).toEqual([label, 403]);
    }
    expect(existsSync(join(open.root, ".eminiar/playbooks/evil.md"))).toBe(false);
  });

  it("refuses to show playbooks to another site as well", async () => {
    const r = await call(open, "/api/playbooks", { headers: { "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
    expect(r.body).not.toHaveProperty("playbooks");
  });

  it("answers a malformed JSON body with a 400, not a dropped connection", async () => {
    const r = await call(open, "/api/playbooks/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    expect(r.body).toHaveProperty("error");
  });

  it("read-only project: lists, but save and delete are 403", async () => {
    expect((await call(readOnly, "/api/playbooks")).body).toMatchObject({
      viewing: true,
      adding: false,
    });
    expect((await post(readOnly, "/api/playbooks/save", { title: "t", prompt: "p" })).status).toBe(
      403,
    );
    expect((await post(readOnly, "/api/playbooks/delete", { name: "x" })).status).toBe(403);
    expect(existsSync(join(readOnly.root, ".eminiar"))).toBe(false);
  });

  it("hidden project: an empty overview and every write 403", async () => {
    const o = await call(hidden, "/api/playbooks");
    expect(o.status).toBe(200);
    expect(o.body).toMatchObject({ viewing: false, playbooks: [], runs: [], suggestions: [] });
    for (const path of ["/api/playbooks/save", "/api/playbooks/run", "/api/playbooks/scan"])
      expect([
        path,
        (await post(hidden, path, { title: "t", prompt: "p", name: "x" })).status,
      ]).toEqual([path, 403]);
  });

  it("scan: 403 until extraction is on, then 200 with nothing to mine", async () => {
    expect((await post(open, "/api/playbooks/scan", { dryRun: true })).status).toBe(403);
    const r = await post(withScan, "/api/playbooks/scan", { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, prompts: 0, suggested: 0, candidates: [] });
  });
});
