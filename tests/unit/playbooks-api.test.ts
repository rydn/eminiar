import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { suggest } from "../../src/playbooks/store.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { playbooksRoute } from "../../src/ui/playbooks-api.js";

let root: string;
let ctx: ProjectContext;

const withPlaybooks = (over: Record<string, unknown>): ProjectContext => ({
  ...ctx,
  config: {
    ...ctx.config,
    playbooks: { ...ctx.config.playbooks, ...over },
  } as ProjectContext["config"],
});

const call = (c: ProjectContext, method: string, path: string, body: unknown = {}) =>
  playbooksRoute(c, { path, method, query: new URLSearchParams(), body: async () => body });

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pbapi-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => {
  rmSync(join(root, ".eminiar"), { recursive: true, force: true });
  getStorage(ctx).playbooks.purgeActivity();
});

describe("playbooks API", () => {
  it("starts empty, with extraction off and no suggestions", async () => {
    const r = await call(ctx, "GET", "/api/playbooks");
    const b = r.body as { viewing: boolean; extraction: boolean; playbooks: unknown[] };
    expect(r.status).toBe(200);
    expect(b.viewing).toBe(true);
    expect(b.extraction).toBe(false);
    expect(b.playbooks).toEqual([]);
  });

  it("saves, lists, records a use, edits and deletes", async () => {
    const s = await call(ctx, "POST", "/api/playbooks/save", {
      title: "Review open PRs",
      prompt: "Review PRs in {{repo}}",
      params: [{ name: "repo", default: "eminiar" }],
      tags: "git, review",
    });
    expect(s.status).toBe(200);
    const name = (s.body as { name: string }).name;
    expect(name).toBe("review-open-prs");
    expect((await call(ctx, "POST", "/api/playbooks/run", { name })).status).toBe(200);
    const o = (await call(ctx, "GET", "/api/playbooks")).body as {
      playbooks: Array<{ name: string; runs: number; tags: string[] }>;
      runs: unknown[];
    };
    expect(o.playbooks[0]).toMatchObject({ name, runs: 1, tags: ["git", "review"] });
    expect(o.runs).toHaveLength(1);
    // saving over an existing one without replace is refused
    const dup = await call(ctx, "POST", "/api/playbooks/save", {
      name,
      title: "x",
      prompt: "y",
    });
    expect(dup.status).toBe(400);
    const edit = await call(ctx, "POST", "/api/playbooks/save", {
      name,
      title: "Review PRs",
      prompt: "z",
      replace: true,
    });
    expect(edit.status).toBe(200);
    expect((await call(ctx, "POST", "/api/playbooks/delete", { name })).body).toEqual({
      removed: true,
    });
  });

  it("rejects a bad playbook and wrong methods", async () => {
    expect((await call(ctx, "POST", "/api/playbooks/save", { title: "", prompt: "" })).status).toBe(
      400,
    );
    expect((await call(ctx, "POST", "/api/playbooks")).status).toBe(405);
    expect((await call(ctx, "GET", "/api/playbooks/save")).status).toBe(404);
  });

  it("is hidden when viewing is off and read-only when adding is off", async () => {
    const hidden = await call(withPlaybooks({ viewing: false }), "GET", "/api/playbooks");
    expect((hidden.body as { viewing: boolean }).viewing).toBe(false);
    expect(
      (await call(withPlaybooks({ viewing: false }), "POST", "/api/playbooks/save", {})).status,
    ).toBe(403);
    const ro = withPlaybooks({ adding: false });
    expect(
      (await call(ro, "POST", "/api/playbooks/save", { title: "a", prompt: "b" })).status,
    ).toBe(403);
  });

  it("shows and handles suggestions only when extraction is on", async () => {
    const on = withPlaybooks({ extraction: { enabled: true } });
    suggest(on, getStorage(on), { title: "Check Datadog", prompt: "Look at monitors" });
    const off = (await call(ctx, "GET", "/api/playbooks")).body as { suggestions: unknown[] };
    expect(off.suggestions).toEqual([]);
    const o = (await call(on, "GET", "/api/playbooks")).body as {
      suggestions: Array<{ id: number }>;
    };
    expect(o.suggestions).toHaveLength(1);
    const acc = await call(on, "POST", "/api/playbooks/suggestion/accept", {
      id: o.suggestions[0]!.id,
    });
    expect(acc.status).toBe(200);
    const after = (await call(on, "GET", "/api/playbooks")).body as {
      suggestions: unknown[];
      playbooks: Array<{ source: string }>;
    };
    expect(after.suggestions).toEqual([]);
    expect(after.playbooks[0]?.source).toBe("suggested");
  });
});
