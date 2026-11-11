import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { playbookCommand } from "../../src/playbooks/cli.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

let root: string;
let ctx: ProjectContext;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 9);
/** Three sessions on three days that repeat one Slack task: the smallest thing scan() proposes. */
function seedRecurring(c: ProjectContext, tag: string): void {
  const db = getStorage(c);
  [0, 1, 2].forEach((d, i) => {
    const id = `${tag}-${i}`;
    const ts = T0 + d * DAY;
    db.eventInsert({
      sessionId: id,
      ts,
      category: "user_prompt",
      priority: 1,
      payload: { text: "Check Slack for open pull requests and review them for me" },
    });
    db.eventInsert({
      sessionId: id,
      ts: ts + 1000,
      category: "mcp_tool",
      priority: 3,
      tool: "mcp__claude_ai_Slack__slack_read_channel",
      payload: { tool: "mcp__claude_ai_Slack__slack_read_channel" },
    });
  });
}

const scanCtx = (): ProjectContext => ({
  ...ctx,
  config: {
    ...ctx.config,
    playbooks: { ...ctx.config.playbooks, extraction: { enabled: true } },
  } as ProjectContext["config"],
});

async function runScan(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await playbookCommand(args, scanCtx(), {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

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
  rmSync(join(root, ".claude"), { recursive: true, force: true });
  rmSync(join(root, "elsewhere"), { recursive: true, force: true });
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

  it("export prints markdown by default, writes a skill with --skill, prints a schedule prompt with --schedule", async () => {
    await run([
      "add",
      "x1",
      "--title",
      "Check CI",
      "--prompt",
      "Look at {{repo}} CI",
      "--schedule",
      "daily 8am",
    ]);
    const md = await run(["export", "x1"]);
    expect(md.code).toBe(0);
    expect(md.out).toContain("title: Check CI");
    const sk = await run(["export", "x1", "--skill", "--set", "repo=rydn/eminiar"]);
    expect(sk.code).toBe(0);
    const path = join(root, ".claude", "skills", "x1", "SKILL.md");
    expect(sk.out).toContain(path);
    expect(readFileSync(path, "utf8")).toContain("Look at rydn/eminiar CI");
    expect(readFileSync(path, "utf8")).toContain("disable-model-invocation: true");
    expect((await run(["export", "x1", "--skill", "--model-invocable"])).out).toContain("updated");
    expect(readFileSync(path, "utf8")).not.toContain("disable-model-invocation");
    const custom = await run(["export", "x1", "--skill", "--target", "elsewhere", "--json"]);
    expect(JSON.parse(custom.out)).toMatchObject({ name: "x1", created: true });
    expect(existsSync(join(root, "elsewhere", "x1", "SKILL.md"))).toBe(true);
    // --schedule is a switch here, even before the name
    const sch = await run(["export", "--schedule", "x1"]);
    expect(sch.code).toBe(0);
    expect(sch.out).toContain("Scheduled task: Check CI");
    expect(sch.out).toContain("Suggested schedule: daily 8am");
    expect(JSON.parse((await run(["export", "x1", "--schedule", "--json"])).out).prompt).toContain(
      "Look at {{repo}} CI",
    );
    expect((await run(["export", "x1", "--skill", "--schedule"])).code).toBe(2);
    expect((await run(["export"])).code).toBe(2);
    expect((await run(["export", "ghost"])).code).toBe(1);
    expect((await run(["export", "ghost", "--skill"])).code).toBe(1);
    expect((await run(["export", "x1", "--skill", "--target", "../out"])).code).toBe(1);
  });

  it("validates usage", async () => {
    expect((await run(["bogus"])).code).toBe(2);
    expect((await run(["show"])).code).toBe(2);
    expect((await run(["runs", "--limit", "0"])).code).toBe(2);
    expect((await run(["add", "x", "--title"])).code).toBe(2);
  });

  it("scan refuses when extraction is off", async () => {
    const r = await run(["scan"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("playbooks.extraction.enabled");
  });

  it("scan --dry-run reports candidates and saves nothing; scan saves suggestions", async () => {
    seedRecurring(scanCtx(), "cli-scan");
    const dry = await runScan(["scan", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("1 new candidate");
    expect(dry.out).toContain("nothing saved");
    expect(getStorage(ctx).playbooks.suggestions({ limit: 10 })).toHaveLength(0);
    const j = await runScan(["scan", "--dry-run", "--json"]);
    const parsed = JSON.parse(j.out) as { dryRun: boolean; candidates: unknown[] };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.candidates).toHaveLength(1);
    const real = await runScan(["scan"]);
    expect(real.code).toBe(0);
    expect(real.out).toContain("saved 1 suggestion");
    expect(getStorage(ctx).playbooks.suggestions({ limit: 10 })).toHaveLength(1);
    expect((await runScan(["scan"])).out).toContain("0 new candidates");
  });
});
