import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isHarnessEnvelope, stripLeadingReminders } from "../../src/capture/envelope.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { clearBudget, startBudget } from "../../src/hooks/budget.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookInput, HookOutput } from "../../src/hooks/types.js";
import { indexContent } from "../../src/index/indexer.js";
import { write } from "../../src/memory/store.js";
import { search } from "../../src/search/pipeline.js";
import { recallForText } from "../../src/session/recall.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

/**
 * The prompt recall reads the small recall index and nothing else: no query on the whole chunk
 * index, no typo correction, no hits from code or command output, and no recall at all for turns
 * the harness sent. These are the properties that keep UserPromptSubmit fast on a large index.
 */

let root: string;
let unmark: () => void;
const PROMPT = "Change the sqlite connection pool to allow concurrent writers";
const prompt = (session: string, p: string): Promise<HookOutput | undefined> =>
  Promise.resolve(
    handlers.UserPromptSubmit!({
      session_id: session,
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      prompt: p,
    } as HookInput),
  );
const ctxText = (out: HookOutput | undefined) => out?.hookSpecificOutput?.additionalContext ?? "";
const db = () => getStorage(getContext(root), { vectors: false });

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  root = mkdtempSync(join(tmpdir(), "em-recall-path-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  resetContextCache();
  unmark = markServerAlive(getContext(root));
  const ctx = getContext(root);
  const d = getStorage(ctx, { vectors: false });
  write(ctx, d, {
    name: "decision/sqlite-connection-pool",
    kind: "decision",
    content:
      "The SQLite connection pool is capped at one writer; WAL mode handles concurrent readers.",
  });
  indexContent(d, {
    source: "docs:better-sqlite3",
    title: "better-sqlite3 › WAL mode",
    uri: "https://example.test/better-sqlite3/wal",
    content:
      "Enable WAL journal mode for concurrent readers: db.pragma('journal_mode = WAL'). A single writer connection avoids SQLITE_BUSY.",
    kind: "markdown",
  });
  write(ctx, d, {
    name: "decision/gateway-authentication-configuration",
    kind: "decision",
    content:
      "Authentication configuration for the application gateway is mandatory. The environment variables live in the deployment repository.",
  });
  // Code and command output that share every prompt term: never recall material.
  indexContent(d, {
    source: "code",
    title: "pool.ts",
    uri: "src/pool.ts",
    content:
      "// change the sqlite connection pool to allow concurrent writers\nexport const sqlitePoolWriters = 1;\n",
    kind: "code",
  });
  indexContent(d, {
    source: "exec",
    title: "grep output",
    content: "change sqlite connection pool allow concurrent writers (exec output)\n",
    kind: "prose",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  clearBudget();
});
afterAll(() => {
  unmark();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

describe("recall on the recall index", () => {
  it("never touches the whole-index search, typo correction or the vocabulary", async () => {
    const d = db();
    const fts = vi.spyOn(d, "ftsSearch");
    const exists = vi.spyOn(d, "termExists");
    const vocab = vi.spyOn(d, "vocabCandidates");
    const rs = vi.spyOn(d, "recallSearch");
    const out = await prompt("p-spy", PROMPT);
    expect(ctxText(out)).toContain("decision/sqlite-connection-pool");
    const r = await recallForText(d, PROMPT);
    expect(r.text).toContain("memory decision/sqlite-connection-pool");
    expect(fts).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(vocab).not.toHaveBeenCalled();
    // a memory and a docs search, each AND then OR at most, for the prompt and for the call
    expect(rs.mock.calls.length).toBeGreaterThan(0);
    expect(rs.mock.calls.length).toBeLessThanOrEqual(8);
    expect(new Set(rs.mock.calls.map((c) => c[0]))).toEqual(new Set(["memory", "docs"]));
  });

  it("does not show code chunks or command output that share every term", async () => {
    const r = await recallForText(db(), PROMPT, { trace: true });
    expect(r.text).not.toContain("pool.ts");
    expect(r.text).not.toContain("grep output");
    expect(r.text).not.toContain("exec output");
    expect(r.trace?.candidates.map((c) => c.label).join("\n")).not.toContain("pool.ts");
    const hits = await search(db(), "sqlite connection pool writers", {
      mode: "lexical",
      limit: 20,
      recall: "docs",
    });
    expect(hits.hits.every((h) => h.chunk.document.source.startsWith("docs:"))).toBe(true);
    expect(hits.corrections).toEqual([]);
  });

  it("recall option off keeps the whole-index search", async () => {
    const d = db();
    const fts = vi.spyOn(d, "ftsSearch");
    const rs = vi.spyOn(d, "recallSearch");
    await search(d, "sqlite connection pool", { mode: "lexical", filters: { source: "code" } });
    expect(fts).toHaveBeenCalled();
    expect(rs).not.toHaveBeenCalled();
  });
});

describe("word-start abbreviations", () => {
  // porter stems authentication -> authent, configuration -> configur, application -> applic,
  // environment -> environ, repository -> repositori: only a prefix query reaches them.
  const KEY = "memory:decision/gateway-authentication-configuration";
  for (const p of [
    "Fix the auth config for the app",
    "where is the env config for auth kept in the repo",
  ]) {
    it(`recalls on "${p}"`, async () => {
      const r = await recallForText(db(), p);
      expect(r.keys).toContain(KEY);
    });
  }

  it("still recalls on the full words", async () => {
    const r = await recallForText(db(), "Fix the authentication configuration of the application");
    expect(r.keys).toContain(KEY);
  });

  it("searches the recall index with prefix terms", async () => {
    const rs = vi.spyOn(db(), "recallSearch");
    await search(db(), "auth config", { mode: "lexical", recall: "memory" });
    expect(rs.mock.calls.map((c) => c[1])).toEqual(['"auth"* "config"*', '"auth"* OR "config"*']);
  });
});

describe("harness envelopes", () => {
  const envelopes: Record<string, string> = {
    "hand-back": `<agent-message from="a1">[Subagent hand-back] ${PROMPT}</agent-message>`,
    "task notification": `<task-notification><summary>${PROMPT}</summary></task-notification>`,
    "ci event": `<ci-monitor-event>${PROMPT}</ci-monitor-event>`,
    "reminder only": `<system-reminder>${PROMPT}</system-reminder>`,
  };
  for (const [label, text] of Object.entries(envelopes)) {
    it(`gets no recall: ${label}`, async () => {
      expect(isHarnessEnvelope(text)).toBe(true);
      const rs = vi.spyOn(db(), "recallSearch");
      const out = await prompt(`p-env-${label}`, text);
      expect(ctxText(out)).toBe("");
      expect(rs).not.toHaveBeenCalled();
    });
  }

  it("recalls on the typed text behind leading system reminders", async () => {
    const text = `<system-reminder>worktree note</system-reminder>\n${PROMPT}`;
    expect(isHarnessEnvelope(text)).toBe(false);
    const d = db();
    const r = await recallForText(d, stripLeadingReminders(text), { trace: true });
    expect(r.keys).toContain("memory:decision/sqlite-connection-pool");
    expect(r.trace?.terms.join(" ")).not.toMatch(/worktree|reminder|note/);
    const out = await prompt("p-reminder", text);
    expect(ctxText(out)).toContain("decision/sqlite-connection-pool");
  });
});

describe("budget between index searches", () => {
  it("returns what is in hand when stop turns true after the memory search", async () => {
    const rs = vi.spyOn(db(), "recallSearch");
    let calls = 0;
    const r = await recallForText(db(), PROMPT, { stop: () => ++calls > 1 });
    expect(r.text).toContain("memory decision/sqlite-connection-pool");
    expect(r.text).not.toContain("docs:better-sqlite3");
    expect(rs.mock.calls.some((c) => c[0] === "memory")).toBe(true);
    expect(rs.mock.calls.some((c) => c[0] === "docs")).toBe(false);
  });

  it("runs no search when stop is true from the start", async () => {
    const rs = vi.spyOn(db(), "recallSearch");
    const r = await recallForText(db(), PROMPT, { stop: () => true });
    expect(r).toMatchObject({ text: "", keys: [] });
    expect(rs).not.toHaveBeenCalled();
  });

  it("skips the prompt recall with under 600 ms left, and runs it with more", async () => {
    const rs = vi.spyOn(db(), "recallSearch");
    startBudget(3500, performance.now() - 3200);
    expect(ctxText(await prompt("p-late", PROMPT))).toBe("");
    expect(rs).not.toHaveBeenCalled();
    startBudget(3500, performance.now());
    expect(ctxText(await prompt("p-early", PROMPT))).toContain("decision/sqlite-connection-pool");
    expect(rs).toHaveBeenCalled();
  });
});
