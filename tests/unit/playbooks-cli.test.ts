import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { playbookCommand } from "../../src/playbooks/cli.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

let root: string;
let ctx: ProjectContext;

async function run(args: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await playbookCommand(
    args,
    ctx,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    async () => stdin,
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pbcli-"));
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
  rmSync(join(root, ".gitignore"), { force: true });
  getStorage(ctx).playbooks.purgeActivity();
});

describe("eminiar playbook", () => {
  it("adds, lists, shows and removes", async () => {
    expect((await run(["list"])).out).toContain("no playbooks yet");
    const add = await run([
      "add",
      "pr-review",
      "--title",
      "Review PRs",
      "--prompt",
      "Review PRs in {{repo}} on {{channel}}",
      "--param",
      "repo",
      "--param",
      "channel=#eng",
      "--tag",
      "daily",
      "--schedule",
      "every weekday 9am",
    ]);
    expect(add.code).toBe(0);
    expect(add.out).toContain("added pr-review");
    expect((await run(["list"])).out).toContain(
      "pr-review  Review PRs  [every weekday 9am | daily]",
    );
    const listed = JSON.parse((await run(["list", "--json"])).out);
    expect(listed[0]).toMatchObject({ name: "pr-review", tags: ["daily"] });
    const show = await run(["show", "pr-review"]);
    expect(show.out).toContain("params: repo, channel=#eng");
    expect(show.out).toContain("Review PRs in {{repo}}");
    expect((await run(["rm", "pr-review"])).code).toBe(0);
    expect((await run(["show", "pr-review"])).code).toBe(1);
    expect((await run(["rm", "pr-review"])).code).toBe(1);
  });

  it("refuses a duplicate add unless --replace, and reads the prompt from stdin", async () => {
    expect((await run(["add", "a", "--title", "A"], "from stdin")).code).toBe(0);
    expect((await run(["show", "a", "--json"])).out).toContain("from stdin");
    const dup = await run(["add", "a", "--title", "A", "--prompt", "x"]);
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("already exists");
    expect((await run(["add", "a", "--title", "A2", "--prompt", "y", "--replace"])).code).toBe(0);
    expect((await run(["add", "b", "--title", "B"])).code).toBe(2);
  });

  it("edit changes given fields and keeps the rest", async () => {
    await run(["add", "e", "--title", "E", "--prompt", "body", "--tag", "t1"]);
    expect((await run(["edit", "e", "--title", "E2"])).out).toContain("updated e");
    const f = JSON.parse((await run(["show", "e", "--json"])).out);
    expect(f).toMatchObject({ title: "E2", tags: ["t1"] });
    expect(f.prompt.trim()).toBe("body");
    expect((await run(["edit", "nope", "--title", "x"])).code).toBe(1);
  });

  it("run prints the filled prompt, records a run, and runs lists it", async () => {
    await run([
      "add",
      "r",
      "--title",
      "R",
      "--prompt",
      "Hi {{who}} {{when}}",
      "--param",
      "when=now",
    ]);
    const r = await run(["run", "r", "--set", "who=Ann", "--note", "try"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Hi Ann now");
    const missing = await run(["run", "r"]);
    expect(missing.out).toBe("Hi {{who}} now");
    expect(missing.err).toContain("unfilled parameters: who");
    const j = JSON.parse((await run(["run", "r", "--set", "who=Bo", "--json"])).out);
    expect(j).toMatchObject({ prompt: "Hi Bo now", unfilled: [] });
    const rows = JSON.parse((await run(["runs", "r", "--json"])).out);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ trigger: "cli", status: "started" });
    expect((await run(["runs", "--limit", "1"])).out.split("\n")).toHaveLength(1);
    expect((await run(["run", "ghost"])).code).toBe(1);
    expect((await run(["run", "r", "--set", "bad"])).code).toBe(1);
  });

  it("validates usage", async () => {
    expect((await run(["bogus"])).code).toBe(2);
    expect((await run(["show"])).code).toBe(2);
    expect((await run(["runs", "--limit", "0"])).code).toBe(2);
    expect((await run(["add", "x", "--title"])).code).toBe(2);
  });
});
