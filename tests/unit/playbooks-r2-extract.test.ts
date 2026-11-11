import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { EmbeddingProvider } from "../../src/embeddings/provider.js";
import { scan } from "../../src/playbooks/extract.js";
import { dismissSuggestion, suggestions } from "../../src/playbooks/store.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

/**
 * Round-2 review of the "known" check (tasks #270, #271). A new cluster counts as a task proposed
 * before only when at least half of its prompts match that task, so one stray prompt that also
 * names a dismissed task cannot hide a new one. A suggestion keeps a bounded identity of its
 * whole cluster in its evidence, and in embeddings mode the past prompts are embedded again, so a
 * dismissed task stays dismissed after its old prompts leave the scan window.
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 14);
const SLACK = "mcp__claude_ai_Slack__slack_read_channel";
const lexical = { embeddings: false, timeZone: "UTC" } as const;

type Db = ReturnType<typeof getStorage>;
let ctx: ProjectContext;
let db: Db;
let sid = 0;

function fresh(): void {
  closeAllStorage();
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  const root = mkdtempSync(join(tmpdir(), "em-r2x-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ playbooks: { extraction: { enabled: true } } }),
  );
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
  sid = 0;
}

function session(ts: number, prompt: string, tools: string[] = [SLACK]): void {
  const id = `s${++sid}`;
  db.eventInsert({
    sessionId: id,
    ts,
    category: "user_prompt",
    priority: 1,
    payload: { text: prompt },
  });
  tools.forEach((tool, i) => {
    db.eventInsert({
      sessionId: id,
      ts: ts + 1000 * (i + 1),
      category: "mcp_tool",
      priority: 3,
      tool,
      payload: { tool },
    });
  });
}

const onDays = (days: number[], prompt: string): void => {
  for (const d of days) session(T0 + d * DAY, prompt);
};

function dismissAll(): void {
  for (const s of suggestions(ctx, db, { status: "pending" })) dismissSuggestion(ctx, db, s.id);
}

/** 3000 newer prompts without tools: the scan window no longer reaches what came before. */
function slideWindow(fromDay: number): void {
  for (let i = 0; i < 3000; i++) {
    db.eventInsert({
      sessionId: `w${i % 50}`,
      ts: T0 + fromDay * DAY + i * 60_000,
      category: "user_prompt",
      priority: 1,
      payload: { text: `unrelated prompt number ${i}` },
    });
  }
}

/** Texts with a keyword of a group share that group's vector; anything else sits apart. */
function stub(groups: Record<string, number[]>): EmbeddingProvider {
  return {
    model: "stub",
    dims: 3,
    ready: () => true,
    warm: () => {},
    error: () => undefined,
    embed: async (texts: string[]) =>
      texts.map((t) => {
        const key = Object.keys(groups).find((k) => t.toLowerCase().includes(k));
        return Float32Array.from(key ? (groups[key] as number[]) : [0, 0, 1]);
      }),
  } as EmbeddingProvider;
}

beforeEach(() => fresh());
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

const PRS = "Review open pull requests posted in Slack";
const INCIDENTS = "Summarize incidents posted in Slack";
const STRAY = "Summarize incidents and review open pull requests posted in Slack";

describe("#270 a stray prompt does not hide a new task", () => {
  it("suggests a new task whose cluster holds one prompt that also names a dismissed task", async () => {
    onDays([0, 1, 2], PRS);
    await scan(ctx, db, lexical);
    dismissAll();
    onDays([-5, 5, 6, 7], INCIDENTS);
    session(T0 + 8 * DAY, STRAY);
    const r = await scan(ctx, db, lexical);
    expect(r.candidates.map((c) => c.prompt)).toEqual([INCIDENTS]);
    expect(r.suggested).toBe(1);
  });

  it("proposes both tasks on a first scan when a stray prompt names both", async () => {
    // The pull-request cluster starts with a longer wording; its representative is PRS. The
    // stray is too far from that first wording to join it, so it joins the incidents cluster,
    // yet it is close enough to PRS to have counted as "already proposed" in the same scan.
    session(T0 - DAY, `${PRS} channel`);
    onDays([0, 1, 2], PRS);
    for (const d of [0, 1, 2]) session(T0 + d * DAY + 3_600_000, INCIDENTS);
    session(T0 + 3 * DAY, "Summarize incidents, review open, posted in Slack");
    const r = await scan(ctx, db, { ...lexical, dryRun: true });
    expect(r.candidates.map((c) => c.prompt).sort()).toEqual([INCIDENTS, PRS].sort());
    expect(r.known).toBe(0);
  });

  it("proposes a task when exactly half of its prompts also name a dismissed one (a tie is new)", async () => {
    onDays([0, 1, 2], PRS);
    await scan(ctx, db, lexical);
    dismissAll();
    onDays([-5, 5, 6, 7], INCIDENTS);
    onDays([8, 9, 10, 11], STRAY);
    const r = await scan(ctx, db, lexical);
    expect(r.candidates.map((c) => c.prompt)).toEqual([INCIDENTS]);
  });

  it("keeps a stray prompt's own words out of the words a suggestion remembers", async () => {
    onDays([0, 1, 2], INCIDENTS);
    session(T0 + 3 * DAY, "Summarize incidents posted in Slack and draft standup notes");
    for (const d of [0, 1, 2]) session(T0 + d * DAY + 3_600_000, "Draft standup notes in Slack");
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(2);
    const words = suggestions(ctx, db, { status: "pending" }).map(
      (s) => /; words: ([^;]+)/.exec(s.evidence ?? "")?.[1],
    );
    expect(words).toContain("incidents posted slack summarize");
  });

  it("still knows a dismissed task when most of its cluster is that task", async () => {
    onDays([0, 1, 2], PRS);
    await scan(ctx, db, lexical);
    dismissAll();
    onDays([10, 11, 12], PRS);
    session(T0 + 13 * DAY, "Review open pull requests posted in Slack today please");
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
  });
});

describe("#271 a dismissed task stays dismissed after its prompts leave the window", () => {
  // The model groups these three wordings; their words barely overlap.
  const A1 = "Check Slack for open pull requests and review them";
  const A2 = "Go through PR links people dropped in the channel and leave comments";
  const A3 = "Triage what teammates shared for code review this morning";
  const groups = { "pull requests": [1, 0, 0], "pr links": [1, 0, 0], "code review": [1, 0, 0] };

  it("remembers every wording of the cluster it suggested, in word mode too", async () => {
    onDays([0, 1, 2], A1);
    onDays([0, 1], A2);
    onDays([2], A3);
    const r1 = await scan(ctx, db, { embeddings: stub(groups), timeZone: "UTC" });
    expect(r1.suggested).toBe(1);
    dismissAll();
    slideWindow(4);
    // later the model is not loaded (word mode) and only the second wording recurs
    onDays([10, 11, 12], A2);
    const r2 = await scan(ctx, db, lexical);
    expect(r2.truncated).toBeDefined();
    expect(r2.suggested).toBe(0);
    expect(r2.known).toBe(1);
  });

  it("recognises a rewording it never stored once the model says it is the same task", async () => {
    onDays([0, 1, 2], A1);
    await scan(ctx, db, { embeddings: stub(groups), timeZone: "UTC" });
    dismissAll();
    slideWindow(4);
    onDays([30, 31, 32], A3);
    const r = await scan(ctx, db, { embeddings: stub(groups), timeZone: "UTC" });
    expect(r.mode).toBe("embeddings");
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
  });

  it("counts the cluster's prompts, not only its representative", async () => {
    // first scan (model loaded): R, W1 and W2 are one task; all three are kept as ids
    const R = "Check Slack for open pull requests and review them";
    const W1 = "Triage shared code review links quickly";
    const W2 = "Triage shared code review links quickly today";
    const X = "Triage shared code review links";
    onDays([0, 1, 2], R);
    onDays([0], W1);
    onDays([1], W2);
    await scan(ctx, db, { embeddings: stub(groups), timeZone: "UTC" });
    dismissAll();
    slideWindow(4);
    // later, word mode: W1 x2 and W2 are known by id; X is new wording and is the representative
    onDays([10, 11], W1);
    onDays([12], W2);
    onDays([11, 12], X);
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
  });

  it("knows a rewording close to the words most of the cluster shared", async () => {
    // three wordings around one core; the stored prompt is the first, with extra words
    onDays([0], "Check Slack for open pull requests and review them carefully, teammates");
    onDays([1], "Check Slack for open pull requests and review them quickly today");
    onDays([2], "Check Slack for open pull requests and review them first this morning");
    expect((await scan(ctx, db, lexical)).suggested).toBe(1);
    dismissAll();
    slideWindow(4);
    // too far from the stored prompt (4/10 shared words), close to the core (4/8)
    onDays([10, 11, 12], "Review the pull requests and links posted in Slack");
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
  });

  it("keeps the evidence bounded and readable however many wordings the cluster had", async () => {
    const base = "Check Slack for open pull requests and review them";
    for (let i = 0; i < 80; i++) session(T0 + (i % 4) * DAY + i * 60_000, `${base} variant${i}`);
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(1);
    const [s] = suggestions(ctx, db, { status: "pending" });
    expect(s?.evidence?.length).toBeLessThanOrEqual(500);
    expect(s?.evidence).toMatch(
      /^sig:[0-9a-f]{16} seen in \d+ sessions on \d+ days; servers: slack/,
    );
    // a re-scan of the same history finds it known, not new
    const again = await scan(ctx, db, lexical);
    expect(again.suggested).toBe(0);
    expect(again.known).toBe(1);
  });

  it("still reads suggestions stored before the identity was kept (old evidence)", async () => {
    onDays([0, 1, 2], PRS);
    await scan(ctx, db, lexical);
    const [s] = suggestions(ctx, db, { status: "pending" });
    (db as unknown as SqliteAdapter).db
      .prepare("UPDATE playbook_suggestions SET evidence = ? WHERE id = ?")
      .run("seen in 3 sessions on 3 days; servers: slack", s?.id);
    dismissAll();
    onDays([10, 11, 12], PRS);
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(0);
  });
});
