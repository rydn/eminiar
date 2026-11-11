import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { isCodeHeavy, scan, serverOf, stripEnvelope } from "../../src/playbooks/extract.js";
import { dismissSuggestion, suggestions } from "../../src/playbooks/store.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emPlaybook } from "../../src/tools/em_playbook.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 9);
let ctx: ProjectContext;
let n = 0;

type Db = ReturnType<typeof getStorage>;

function fresh(enabled = true): Db {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  // The "MCP tool" test scans with the configured provider: without this it would construct the
  // real embedding model and start warming (downloading) it. No network, no model in unit tests.
  process.env.EMINIAR_EMBEDDINGS = "0";
  const root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  if (enabled)
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ playbooks: { extraction: { enabled: true } } }),
    );
  resetContextCache();
  ctx = getContext(root);
  return getStorage(ctx);
}

function session(db: Db, id: string, ts: number, prompt: string, tools: string[]) {
  db.eventInsert({
    sessionId: id,
    ts,
    category: "user_prompt",
    priority: 1,
    payload: { text: prompt },
  });
  tools.forEach((t, i) => {
    db.eventInsert({
      sessionId: id,
      ts: ts + 1000 * (i + 1),
      category: "mcp_tool",
      priority: 3,
      tool: t,
      payload: { tool: t },
    });
  });
}

const P = "Check Slack for open pull requests and review them for me";
const SLACK = ["mcp__claude_ai_Slack__slack_read_channel"];

function recurring(db: Db, prompt = P, days = [0, 1, 2], tools = SLACK) {
  n++;
  days.forEach((d, i) => {
    session(db, `s${n}-${i}`, T0 + d * DAY, prompt, tools);
  });
}

const opts = { embeddings: false } as const;

afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_EMBEDDINGS;
});

describe("playbook extraction", () => {
  beforeEach(() => {
    closeAllStorage();
  });

  it("is off by default and mines nothing", async () => {
    const db = fresh(false);
    recurring(db);
    await expect(scan(ctx, db, opts)).rejects.toThrow(/extraction is off/);
    expect(db.playbooks.suggestions()).toHaveLength(0);
  });

  it("proposes a recurring prompt with a shared MCP server", async () => {
    const db = fresh();
    recurring(db);
    const r = await scan(ctx, db, opts);
    expect(r.mode).toBe("lexical");
    expect(r.suggested).toBe(1);
    const [s] = suggestions(ctx, db, { status: "pending" });
    expect(s?.title).toContain("slack");
    expect(s?.evidence).toMatch(/sig:[0-9a-f]{16}/);
  });

  it("needs 3 sessions", async () => {
    const db = fresh();
    recurring(db, P, [0, 1]);
    expect((await scan(ctx, db, opts)).candidates).toHaveLength(0);
  });

  it("needs 2 distinct days (same-day repeats and one-session bursts)", async () => {
    const db = fresh();
    recurring(db, P, [0, 0, 0]);
    expect((await scan(ctx, db, opts)).candidates).toHaveLength(0);
    const db2 = fresh();
    for (let i = 0; i < 5; i++) session(db2, "one", T0 + i * 3_600_000 * 2 * (i + 1) * 3, P, SLACK);
    expect((await scan(ctx, db2, opts)).candidates).toHaveLength(0);
  });

  it("needs a shared MCP server in the tool window", async () => {
    const db = fresh();
    recurring(db, P, [0, 1, 2], []);
    expect((await scan(ctx, db, opts)).candidates).toHaveLength(0);
    const db2 = fresh();
    recurring(db2, P, [0, 1, 2], ["mcp__plugin_eminiar_eminiar__em_search"]);
    expect((await scan(ctx, db2, opts)).candidates).toHaveLength(0);
  });

  it("excludes swarm, envelope and code-heavy prompts", async () => {
    const db = fresh();
    recurring(db, "You are the coder worker of the eminiar swarm feature. Check Slack for PRs");
    recurring(db, "<system-reminder>Check Slack for pull requests</system-reminder>");
    recurring(db, "Check src/a/b.ts and src/c/d.ts for slack pull requests {x();}");
    expect((await scan(ctx, db, opts)).candidates).toHaveLength(0);
  });

  it("remembers dismissals and never re-proposes", async () => {
    const db = fresh();
    recurring(db);
    await scan(ctx, db, opts);
    const [s] = suggestions(ctx, db, { status: "pending" });
    expect(dismissSuggestion(ctx, db, s?.id as number)).toBe(true);
    const again = await scan(ctx, db, opts);
    expect(again.suggested).toBe(0);
    expect(again.known).toBe(1);
    expect(suggestions(ctx, db, { status: "pending" })).toHaveLength(0);
  });

  it("dry run stores nothing; secrets are masked", async () => {
    const db = fresh();
    recurring(
      db,
      "Check Slack for pull requests token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and review",
    );
    const r = await scan(ctx, db, { ...opts, dryRun: true });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(suggestions(ctx, db)).toHaveLength(0);
  });

  it("helpers", () => {
    expect(serverOf("mcp__plugin_engineering_slack__x")).toBe("slack");
    expect(serverOf("mcp__claude_ai_Slack__x")).toBe("slack");
    expect(serverOf("mcp__plugin_eminiar_eminiar__em_search")).toBeUndefined();
    expect(stripEnvelope("<system-reminder>x</system-reminder>")).toBe("");
    expect(isCodeHeavy("see a/b.ts and c/d.ts")).toBe(true);
  });

  it("works through the MCP tool: scan, suggestions, accept, dismiss", async () => {
    const db = fresh();
    recurring(db);
    const call = async (a: Record<string, unknown>) => {
      const r = await emPlaybook.handler(a as never, ctx);
      return { text: r.content.map((c) => c.text).join("\n"), err: r.isError === true };
    };
    expect((await call({ action: "scan" })).err).toBe(false);
    const ls = await call({ action: "suggestions" });
    const id = Number(/#(\d+)/.exec(ls.text)?.[1] ?? 0);
    expect(id).toBeGreaterThan(0);
    expect((await call({ action: "accept", id })).err).toBe(false);
    expect((await call({ action: "dismiss", id })).err).toBe(true);
  });
});
