import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { EmbeddingProvider } from "../../src/embeddings/provider.js";
import { isCodeHeavy, scan } from "../../src/playbooks/extract.js";
import { dismissSuggestion, suggestions } from "../../src/playbooks/store.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

/**
 * Where extraction draws its lines: 3 sessions on 2 UTC days sharing an MCP server within 30
 * minutes of the prompt, at least 60% of the prompts that used a server, and which prompts never
 * count. Every scan passes an explicit provider (a stub or `false`), so no model is ever loaded.
 */

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 9);
const SLACK = "mcp__claude_ai_Slack__slack_read_channel";
const DD = "mcp__claude_ai_Datadog__search_datadog_logs";
const P = "Check Slack for open pull requests and review them for me";

type Db = ReturnType<typeof getStorage>;

let ctx: ProjectContext;
let db: Db;
let n = 0;

// days are local calendar days; the thresholds below are written in UTC
const lexical = { embeddings: false, timeZone: "UTC" } as const;

function fresh(): void {
  closeAllStorage();
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  const root = mkdtempSync(join(tmpdir(), "em-ext-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ playbooks: { extraction: { enabled: true } } }),
  );
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
  n = 0;
}

/** One session: a prompt at `ts`, then each tool `after` ms later (default 1 s apart). */
function session(
  id: string,
  ts: number,
  prompt: string,
  tools: Array<string | { tool: string; after: number }> = [],
): void {
  db.eventInsert({
    sessionId: id,
    ts,
    category: "user_prompt",
    priority: 1,
    payload: { text: prompt },
  });
  tools.forEach((t, i) => {
    const tool = typeof t === "string" ? t : t.tool;
    const after = typeof t === "string" ? 1000 * (i + 1) : t.after;
    db.eventInsert({
      sessionId: id,
      ts: ts + after,
      category: "mcp_tool",
      priority: 3,
      tool,
      payload: { tool },
    });
  });
}

/** One session per entry of `at` (ms timestamps), the same prompt and tools in each. */
function sessions(
  at: number[],
  prompt = P,
  tools: Array<string | { tool: string; after: number }> = [SLACK],
) {
  n++;
  at.forEach((ts, i) => {
    session(`s${n}-${i}`, ts, prompt, tools);
  });
}

const candidates = async (opt: Parameters<typeof scan>[2] = lexical) =>
  (await scan(ctx, db, { ...opt, dryRun: true })).candidates;

/** A provider that places a text by its first matching keyword group, so the test sets what is "similar". */
function stub(
  groups: Record<string, number[]>,
  over: { ready?: boolean; fail?: boolean; short?: boolean } = {},
): EmbeddingProvider & { warmed: number; embedded: number } {
  const p = {
    model: "stub",
    dims: 2,
    warmed: 0,
    embedded: 0,
    ready: () => over.ready ?? true,
    warm: () => {
      p.warmed++;
    },
    error: () => undefined,
    embed: async (texts: string[]) => {
      p.embedded++;
      if (over.fail) throw new Error("model gone");
      const vecs = texts.map((t) => {
        const key = Object.keys(groups).find((k) => t.toLowerCase().includes(k));
        return Float32Array.from(key ? (groups[key] as number[]) : [0.7, 0.7]);
      });
      return over.short ? vecs.slice(1) : vecs;
    },
  };
  return p;
}

beforeAll(() => fresh());
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => fresh());

describe("how many sessions and days", () => {
  it("proposes at exactly 3 sessions on 2 days", async () => {
    sessions([T0, T0 + 2 * MIN, T0 + DAY]);
    const [c] = await candidates();
    expect(c).toMatchObject({ sessions: 3, days: 2, servers: ["slack"] });
  });

  it("does not propose 3 sessions inside one UTC day", async () => {
    sessions([Date.UTC(2026, 0, 5, 0, 1), Date.UTC(2026, 0, 5, 12), Date.UTC(2026, 0, 5, 23, 59)]);
    expect(await candidates()).toHaveLength(0);
  });

  it("counts days in UTC: two minutes across midnight are two days", async () => {
    sessions([
      Date.UTC(2026, 0, 5, 23, 59),
      Date.UTC(2026, 0, 6, 0, 1),
      Date.UTC(2026, 0, 6, 0, 2),
    ]);
    expect(await candidates()).toHaveLength(1);
  });

  it("does not propose 2 sessions, however many days or prompts", async () => {
    sessions([T0, T0 + DAY]);
    expect(await candidates()).toHaveLength(0);
    // one session repeating the prompt on three days is still one session
    fresh();
    for (const d of [0, 1, 2]) session("same", T0 + d * DAY, P, [SLACK]);
    expect(await candidates()).toHaveLength(0);
    // a second one, then a third distinct session tips it over
    session("other", T0 + 3 * DAY, P, [SLACK]);
    expect(await candidates()).toHaveLength(0);
    session("third", T0 + 4 * DAY, P, [SLACK]);
    expect((await candidates())[0]).toMatchObject({ sessions: 3, days: 5 });
  });
});

describe("the tool window", () => {
  const at = (after: number) => sessions([T0, T0 + DAY, T0 + 2 * DAY], P, [{ tool: SLACK, after }]);

  it("a tool call exactly 30 minutes after the prompt still belongs to it", async () => {
    at(30 * MIN);
    expect(await candidates()).toHaveLength(1);
  });

  it("a tool call 1 ms past 30 minutes does not", async () => {
    at(30 * MIN + 1);
    expect(await candidates()).toHaveLength(0);
  });

  it("a tool call after the next prompt belongs to that prompt, not this one", async () => {
    const other = [
      "Draft the release notes changelog entries",
      "Plan the offsite agenda logistics budget",
      "Summarize quarterly revenue figures dashboard",
    ];
    [0, 1, 2].forEach((d, i) => {
      const id = `w${i}`;
      session(id, T0 + d * DAY, P);
      session(id, T0 + d * DAY + 5 * MIN, other[i] as string, [SLACK]);
    });
    expect(await candidates()).toHaveLength(0);
  });

  it("a tool call in another session does not belong to the prompt", async () => {
    [0, 1, 2].forEach((d, i) => {
      session(`p${i}`, T0 + d * DAY, P);
      session(`t${i}`, T0 + d * DAY + 1000, "Run the nightly build and smoke checks", [SLACK]);
    });
    // the sessions that ran the tool propose their own task; the pull request prompt gets none
    const found = await candidates();
    expect(found.map((c) => c.prompt)).toEqual(["Run the nightly build and smoke checks"]);
  });
});

describe("the shared MCP server", () => {
  it("passes at 60% of the prompts that used a server, with only those counted as evidence", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], P, [SLACK]);
    sessions([T0 + 3 * DAY, T0 + 4 * DAY], P, [DD]);
    const found = await candidates();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ servers: ["slack"], sessions: 3 });
  });

  it("fails below 60%, even just below (5 of 9 is 56%)", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], P, [SLACK]);
    sessions([T0 + 3 * DAY, T0 + 4 * DAY, T0 + 5 * DAY], P, [DD]);
    expect(await candidates(), "3 of 6").toHaveLength(0);
    sessions([T0 + 6 * DAY, T0 + 7 * DAY], P, [SLACK]);
    sessions([T0 + 8 * DAY], P, [DD]);
    expect(await candidates(), "5 of 9").toHaveLength(0);
    sessions([T0 + 9 * DAY], P, [SLACK]);
    expect(await candidates(), "6 of 10 is enough").toHaveLength(1);
  });

  it("prompts with no tool calls do not dilute the share, and are not evidence", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], P, [SLACK]);
    sessions([T0 + 3 * DAY, T0 + 4 * DAY], P, []);
    expect((await candidates())[0]).toMatchObject({ servers: ["slack"], sessions: 3 });
  });

  it("needs the whole server set in a prompt's window for it to be evidence", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], P, [SLACK, DD]);
    sessions([T0 + 3 * DAY], P, [SLACK]);
    const [c] = await candidates();
    expect(c).toMatchObject({ servers: ["datadog", "slack"], sessions: 3 });
  });

  it("ignores eminiar's own tools and non-MCP tools", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], P, [
      "mcp__plugin_eminiar_eminiar__em_search",
      "Bash",
      "Read",
    ]);
    expect(await candidates()).toHaveLength(0);
  });
});

describe("which prompts count", () => {
  it("clusters paraphrases that share enough words", async () => {
    session("a", T0, "Check Slack for open pull requests and review them", [SLACK]);
    session("b", T0 + DAY, "Check Slack for open pull requests then review them", [SLACK]);
    session("c", T0 + 2 * DAY, "please check slack for open pull requests and review them all", [
      SLACK,
    ]);
    expect(await candidates()).toHaveLength(1);
  });

  it("does not merge different tasks that happen to use the same server", async () => {
    session("a", T0, "Check Slack for open pull requests and review them", [SLACK]);
    session("b", T0 + DAY, "Draft the weekly newsletter announcement from channel highlights", [
      SLACK,
    ]);
    session("c", T0 + 2 * DAY, "Archive the stale incident channels older than ninety days", [
      SLACK,
    ]);
    expect(await candidates()).toHaveLength(0);
  });

  it("leaves out slash commands, harness text, fences, stack traces, paths and prompts that are too short", async () => {
    const skipped: Array<[string, string]> = [
      ["slash command", "/review open slack pull requests and review them"],
      ["tag first", "<note>Check Slack for open pull requests and review them for me"],
      ["too few words", "Review PRs"],
      ["too short", "abc d e"],
      ["code fence", "Check slack for pull requests ```x```"],
      ["two paths", "Check slack pull requests in src/a/b.ts and src/c/d.ts"],
      ["symbols", "check slack {a: b(c); d = [e] | f $g} requests"],
    ];
    for (const [label, prompt] of skipped) {
      fresh();
      sessions([T0, T0 + DAY, T0 + 2 * DAY], prompt);
      expect(await candidates(), label).toHaveLength(0);
    }
    fresh();
    sessions([T0, T0 + DAY, T0 + 2 * DAY], "Review slack prs");
    expect(await candidates(), "three words is enough").toHaveLength(1);
  });

  it("recognises a pasted stack trace and a command line as code", () => {
    expect(
      isCodeHeavy("why does slack fail\n    at run (file.js:10:5)\n    at main (x.js:2:1)"),
    ).toBe(true);
    expect(isCodeHeavy("Check Slack for open pull requests and review them")).toBe(false);
  });

  it("strips harness envelopes and keeps the person's words", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], `<system-reminder>ignore this</system-reminder> ${P}`);
    expect(await candidates()).toHaveLength(1);
  });

  it("leaves out swarm prompts and prompts that started a swarm, but not a plain subagent", async () => {
    [0, 1, 2].forEach((d, i) => {
      const ts = T0 + d * DAY;
      session(`sw${i}`, ts, P, [SLACK]);
      db.eventInsert({
        sessionId: `sw${i}`,
        ts: ts + 500,
        category: "subagent",
        priority: 3,
        payload: { text: "worker of the eminiar swarm feature" },
      });
    });
    expect(await candidates()).toHaveLength(0);
    fresh();
    [0, 1, 2].forEach((d, i) => {
      const ts = T0 + d * DAY;
      session(`pl${i}`, ts, P, [SLACK]);
      db.eventInsert({
        sessionId: `pl${i}`,
        ts: ts + 500,
        category: "subagent",
        priority: 3,
        payload: { text: "Explore agent finished" },
      });
    });
    expect(await candidates()).toHaveLength(1);
  });

  it("only looks at events at or after `since`", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    expect(await candidates({ ...lexical, since: T0 })).toHaveLength(1);
    expect(await candidates({ ...lexical, since: T0 + 1 })).toHaveLength(0);
    expect(await candidates({ ...lexical, since: T0 + DAY + 1 })).toHaveLength(0);
  });
});

describe("what a scan stores and never stores", () => {
  it("proposes once: the same cluster is known on the next scan, and growing it changes nothing", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    const first = await scan(ctx, db, lexical);
    expect([first.suggested, first.known]).toEqual([1, 0]);
    const second = await scan(ctx, db, lexical);
    expect([second.suggested, second.known]).toEqual([0, 1]);
    session("late", T0 + 3 * DAY, P, [SLACK]);
    const third = await scan(ctx, db, lexical);
    expect([third.suggested, third.known]).toEqual([0, 1]);
    expect(suggestions(ctx, db)).toHaveLength(1);
  });

  it("a cluster that grows with a reworded prompt is still the same, known task", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY]);
    expect((await scan(ctx, db, lexical)).suggested).toBe(1);
    const [before] = suggestions(ctx, db);
    // a shorter wording of the task becomes the cluster's best representative ...
    session("reworded", T0 + 4 * DAY, "Check Slack pull requests review", [SLACK]);
    const again = await scan(ctx, db, { ...lexical, dryRun: true });
    expect(again.candidates).toHaveLength(0);
    expect(again.known).toBe(1);
    // ... and a saved scan does not add it as a second suggestion either
    const saved = await scan(ctx, db, lexical);
    expect([saved.suggested, saved.known]).toEqual([0, 1]);
    expect(suggestions(ctx, db).map((s) => s.id)).toEqual([before?.id]);
  });

  it("a dismissed task stays dismissed after the cluster grows, and an accepted one is not re-proposed", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    await scan(ctx, db, lexical);
    const [s] = suggestions(ctx, db, { status: "pending" });
    expect(dismissSuggestion(ctx, db, s!.id)).toBe(true);
    session("late", T0 + 3 * DAY, P, [SLACK]);
    session("later", T0 + 4 * DAY, P, [SLACK]);
    const again = await scan(ctx, db, lexical);
    expect([again.suggested, again.known]).toEqual([0, 1]);
    expect(suggestions(ctx, db, { status: "pending" })).toHaveLength(0);
    expect(suggestions(ctx, db, { status: "dismissed" })).toHaveLength(1);
  });

  it("a dry run stores nothing, so the next scan still proposes the cluster", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    const dry = await scan(ctx, db, { ...lexical, dryRun: true });
    expect([dry.candidates.length, dry.suggested]).toEqual([1, 0]);
    expect(suggestions(ctx, db)).toHaveLength(0);
    expect((await scan(ctx, db, lexical)).suggested).toBe(1);
  });

  it("never writes a playbook file: suggestions stay in the inbox until accepted", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    await scan(ctx, db, lexical);
    expect(existsSync(join(ctx.root, ".eminiar/playbooks"))).toBe(false);
    expect(db.playbooks.count()).toBe(0);
  });

  it("with nothing to mine it says so and stores nothing", async () => {
    const r = await scan(ctx, db, lexical);
    expect(r).toMatchObject({ prompts: 0, clusters: 0, suggested: 0, known: 0, mode: "lexical" });
    expect(r.candidates).toEqual([]);
  });
});

describe("embeddings (stub provider, no model)", () => {
  const same = { slack: [1, 0], channel: [1, 0], messaging: [1, 0] };
  const reworded = () => {
    session("a", T0, "Check Slack for open pull requests and review them", [SLACK]);
    session("b", T0 + DAY, "Scan the team channel for pending code changes awaiting approval", [
      SLACK,
    ]);
    session(
      "c",
      T0 + 2 * DAY,
      "Look through messaging threads for patches that need a second pair of eyes",
      [SLACK],
    );
  };

  it("clusters prompts whose vectors are close even when their words are not", async () => {
    reworded();
    expect(await candidates()).toHaveLength(0);
    const p = stub(same);
    const r = await scan(ctx, db, { embeddings: p, dryRun: true });
    expect(r.mode).toBe("embeddings");
    expect(r.candidates).toHaveLength(1);
    expect(p.embedded).toBe(1);
  });

  it("keeps prompts apart when their vectors are far apart, whatever their words share", async () => {
    // three different texts with the same words (identical texts share one vector)
    [P, P.toLowerCase(), `${P}.`].forEach((t, i) => {
      session(`far${i}`, T0 + i * DAY, t, [SLACK]);
    });
    const p = stub({ "for me": [1, 0] });
    // the first prompt is placed on one axis, the others on the orthogonal one
    const split = {
      embed: async (texts: string[]) =>
        texts.map((_, i) => Float32Array.from(i === 0 ? [1, 0] : [0, 1])),
    };
    const r = await scan(ctx, db, { embeddings: { ...p, ...split }, dryRun: true });
    expect(r.mode).toBe("embeddings");
    expect(r.candidates).toHaveLength(0);
  });

  it("falls back to words, and starts loading, when the model is not ready", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    const p = stub(same, { ready: false });
    const r = await scan(ctx, db, { embeddings: p, dryRun: true });
    expect(r.mode).toBe("lexical");
    expect(p.warmed).toBe(1);
    expect(p.embedded).toBe(0);
    expect(r.candidates).toHaveLength(1);
  });

  it("falls back to words when embedding throws or returns the wrong number of vectors", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    for (const over of [{ fail: true }, { short: true }]) {
      const r = await scan(ctx, db, { embeddings: stub(same, over), dryRun: true });
      expect(r.mode, JSON.stringify(over)).toBe("lexical");
      expect(r.candidates).toHaveLength(1);
    }
  });

  it("does not embed when there is nothing to embed", async () => {
    const p = stub(same);
    expect((await scan(ctx, db, { embeddings: p, dryRun: true })).mode).toBe("lexical");
    expect(p.embedded).toBe(0);
  });
});

describe("review fixes: stable dedupe, one bad prompt, bounded scan", () => {
  beforeEach(() => fresh());

  const A = "Check Slack channel for open pull requests and review them carefully";
  const B = "Check Slack channel for open pull requests and review them";

  async function dismissAll(): Promise<void> {
    for (const s of suggestions(ctx, db, { status: "pending" })) dismissSuggestion(ctx, db, s.id);
  }

  it("a dismissed suggestion stays dismissed when its cluster grows and a word changes", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], A);
    expect((await scan(ctx, db, lexical)).suggested).toBe(1);
    await dismissAll();
    sessions([T0 + 3 * DAY, T0 + 4 * DAY, T0 + 5 * DAY], B);
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
    expect(suggestions(ctx, db, { status: "pending" })).toHaveLength(0);
  });

  it("stays known when only the changed wording is left in range", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], A);
    await scan(ctx, db, lexical);
    await dismissAll();
    sessions([T0 + 3 * DAY, T0 + 4 * DAY, T0 + 5 * DAY], B);
    const r = await scan(ctx, db, { ...lexical, since: T0 + 3 * DAY });
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
  });

  it("stays known when the clustering switches from words to embeddings", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], A);
    const first = await scan(ctx, db, lexical);
    expect(first.suggested).toBe(1);
    await dismissAll();
    // embeddings group a paraphrase in as well: the cluster, its top words and its
    // representative all change
    const C = "Look through the slack channel for open pull requests and review those";
    sessions([T0 + 6 * DAY, T0 + 7 * DAY, T0 + 8 * DAY, T0 + 9 * DAY, T0 + 10 * DAY], C);
    const r = await scan(ctx, db, { embeddings: stub({ slack: [1, 0] }) });
    expect(r.mode).toBe("embeddings");
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
  });

  it("reads every past suggestion, not only the newest 1000", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], A);
    await scan(ctx, db, lexical);
    await dismissAll();
    for (let i = 0; i < 1100; i++) {
      db.playbooks.suggestionAdd({
        name: `other-${i}`,
        title: `other ${i}`,
        prompt: `unrelated chore number ${i} zebra`,
        ts: Date.now() + 1000 + i,
      });
    }
    sessions([T0 + 3 * DAY, T0 + 4 * DAY, T0 + 5 * DAY], B);
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(0);
    expect(r.known).toBe(1);
  });

  it("skips a prompt over the store limit and still stores the other candidates", async () => {
    const long = `Please summarise the incident notes and post them to slack. ${"The cache warmed slowly. ".repeat(900)}`;
    expect(long.length).toBeGreaterThan(20_000);
    sessions([T0, T0 + DAY, T0 + 2 * DAY], long);
    sessions([T0, T0 + DAY, T0 + 2 * DAY], "Check github for open pull requests and review them", [
      "mcp__claude_ai_github__list_pull_requests",
    ]);
    const r = await scan(ctx, db, lexical);
    expect(r.suggested).toBe(1);
    expect(r.skipped).toBe(3);
    expect(suggestions(ctx, db).map((s) => s.title)).toEqual([expect.stringContaining("github")]);
    // the next scan works the same instead of throwing for good
    expect((await scan(ctx, db, lexical)).known).toBe(1);
  });

  it("one candidate the store refuses does not abort the others", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], P);
    sessions([T0, T0 + DAY, T0 + 2 * DAY], "Summarise the payments error logs from last night", [
      DD,
    ]);
    const real = db.playbooks.suggestionAdd.bind(db.playbooks);
    let calls = 0;
    db.playbooks.suggestionAdd = (s) => {
      if (calls++ === 0) throw new Error("boom");
      return real(s);
    };
    try {
      const r = await scan(ctx, db, lexical);
      expect(r.suggested).toBe(1);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain("boom");
    } finally {
      db.playbooks.suggestionAdd = real;
    }
  });

  it("looks at the most recent prompts only, says so, and lets the event loop run", async () => {
    // the recurring task is the oldest: it falls outside the window
    sessions([T0, T0 + DAY, T0 + 2 * DAY]);
    for (let i = 0; i < 3100; i++)
      session(
        `bulk${i}`,
        T0 + 10 * DAY + i * 1000,
        `unique${i} alpha${i} beta${i} gamma${i} chore`,
      );
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 0);
    let r: Awaited<ReturnType<typeof scan>>;
    try {
      r = await scan(ctx, db, { ...lexical, dryRun: true });
    } finally {
      clearInterval(timer);
    }
    expect(r.truncated).toMatch(/most recent/);
    expect(r.prompts).toBeLessThanOrEqual(3000);
    expect(r.candidates).toHaveLength(0);
    expect(ticks).toBeGreaterThan(0);
  });

  it("is deterministic across runs", async () => {
    sessions([T0, T0 + DAY, T0 + 2 * DAY], A);
    for (let i = 0; i < 300; i++)
      session(`bulk${i}`, T0 + 10 * DAY + i * 1000, `chore ${i % 7} task`);
    const a = await scan(ctx, db, { ...lexical, dryRun: true });
    const b = await scan(ctx, db, { ...lexical, dryRun: true });
    expect(b).toEqual(a);
  });
});
