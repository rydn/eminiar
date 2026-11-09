// Settings the documentation lists but no other test turned: each case flips one setting and
// checks the behaviour that setting promises, so a rename or a dropped read fails here.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { syncSource } from "../../src/docs/sync.js";
import { reindexCode, reindexGitSignals } from "../../src/graph/reindex.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookInput, HookOutput } from "../../src/hooks/types.js";
import { indexContent } from "../../src/index/indexer.js";
import { write } from "../../src/memory/store.js";
import { execute } from "../../src/sandbox/execute.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { emSearch } from "../../src/tools/em_search.js";

const ctxText = (out: HookOutput | undefined) => out?.hookSpecificOutput?.additionalContext ?? "";
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "dev",
  GIT_AUTHOR_EMAIL: "d@x",
  GIT_COMMITTER_NAME: "dev",
  GIT_COMMITTER_EMAIL: "d@x",
};
const gitIn = (cwd: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: "pipe", env: gitEnv });

/** A context built straight from a config object, with its own database file. */
function plainCtx(name: string, config: Record<string, unknown>): ProjectContext {
  const root = mkdtempSync(join(tmpdir(), `em-set-${name}-`));
  writeFileSync(join(root, "package.json"), "{}");
  return { root, id: name, dbPath: join(root, "set.db"), config: ConfigSchema.parse(config) };
}

describe("recall hooks", () => {
  let root: string;
  let unmark: () => void;
  const base = (over: Partial<HookInput>): HookInput => ({
    session_id: "s",
    cwd: root,
    hook_event_name: "x",
    ...over,
  });
  const setRecall = (recall: Record<string, unknown>): void => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false }, recall }),
    );
    resetContextCache();
  };
  let n = 0;
  const sid = () => `set-${++n}`;
  const tool = (tool_name: string, tool_input: Record<string, unknown>) =>
    handlers.PreToolUse!(
      base({ session_id: sid(), hook_event_name: "PreToolUse", tool_name, tool_input }),
    );
  const prompt = (text: string) =>
    handlers.UserPromptSubmit!(
      base({ session_id: sid(), hook_event_name: "UserPromptSubmit", prompt: text }),
    );

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-set-recall-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/parser.ts"), "export const x = 1;\n");
    setRecall({});
    const ctx = getContext(root);
    unmark = markServerAlive(ctx);
    const db = getStorage(ctx, { vectors: false });
    db.metaSet(
      "history_files",
      JSON.stringify({
        head: "abc",
        files: {
          "src/parser.ts": {
            commits: 9,
            fixes: 5,
            bugOrigins: 2,
            risk: 0.62,
            reasons: ["fix density"],
            lastFix: "1a2b3c4 fix: parser drops trailing comments",
          },
        },
      }),
    );
    // Three memories and three doc pages that all match the same prompt.
    for (const i of [1, 2, 3]) {
      write(ctx, db, {
        name: `note/zorblax-${i}`,
        kind: "note",
        content: `Zorblax calibration step ${i}: the quibbleframe flange must be torqued before the zorblax gasket seats.`,
      });
      indexContent(db, {
        source: `docs:vendor-${i}`,
        title: `Vendor ${i} > Quibbleframe`,
        uri: `https://docs.example.test/vendor-${i}/quibbleframe`,
        content: `Quibbleframe zorblax reference ${i}: torque the flange, then seat the zorblax gasket.`,
        kind: "markdown",
      });
    }
    gitIn(root, "init -q");
    gitIn(root, "add src/parser.ts");
  });
  afterAll(() => {
    unmark();
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
  });
  afterEach(() => setRecall({}));

  it("recall.onFile gates the fix history shown before a file is read or edited", async () => {
    const edit = { file_path: join(root, "src/parser.ts") };
    setRecall({ onFile: false });
    expect(await tool("Edit", edit)).toBeUndefined();
    setRecall({ onFile: true });
    expect(ctxText(await tool("Edit", edit))).toContain("src/parser.ts is bug-prone");
  });

  it("recall.onCommit gates the risk note before git commit", async () => {
    const commit = { command: 'git commit -m "tweak"' };
    setRecall({ onCommit: false });
    expect(await tool("Bash", commit)).toBeUndefined();
    setRecall({ onCommit: true });
    expect(ctxText(await tool("Bash", commit))).toContain("src/parser.ts is bug-prone");
  });

  it("recall.onWeb gates the doc pages offered before WebSearch", async () => {
    const search = { query: "quibbleframe zorblax gasket" };
    setRecall({ onWeb: false });
    expect(await tool("WebSearch", search)).toBeUndefined();
    setRecall({ onWeb: true });
    expect(ctxText(await tool("WebSearch", search))).toContain("local documentation index");
  });

  it("recall.onAgent gates the memories added to a subagent prompt", async () => {
    const agent = { prompt: "Check the zorblax quibbleframe gasket torque" };
    const promptOf = async () =>
      String((await tool("Agent", agent))?.hookSpecificOutput?.updatedInput?.prompt ?? "");
    setRecall({ onAgent: false });
    expect(await promptOf()).not.toContain("note/zorblax");
    setRecall({ onAgent: true });
    expect(await promptOf()).toContain("note/zorblax");
  });

  it("recall.maxMemories and recall.maxDocs cap what a prompt receives", async () => {
    const text = "Why does the zorblax quibbleframe gasket need torque?";
    const count = (out: HookOutput | undefined, re: RegExp) =>
      (ctxText(out).match(re) ?? []).length;
    setRecall({ maxMemories: 1, maxDocs: 1 });
    const one = await prompt(text);
    expect(count(one, /note\/zorblax-\d/g)).toBe(1);
    expect(count(one, /^- docs:/gm)).toBe(1);
    setRecall({ maxMemories: 3, maxDocs: 3 });
    const three = await prompt(text);
    expect(count(three, /note\/zorblax-\d/g)).toBe(3);
    expect(count(three, /^- docs:/gm)).toBe(3);
  });
});

describe("sandbox", () => {
  afterEach(() => {
    delete process.env.EM_SET_PROBE;
  });
  const echoProbe = { language: "shell", code: 'printf %s "[$EM_SET_PROBE]"' };

  it("sandbox.envAllow passes a named variable through and nothing else", async () => {
    process.env.EM_SET_PROBE = "visible";
    const closed = await execute(plainCtx("env0", {}), echoProbe);
    expect(closed.stdout).toBe("[]");
    const open = await execute(
      plainCtx("env1", { sandbox: { envAllow: ["EM_SET_PROBE"] } }),
      echoProbe,
    );
    expect(open.stdout).toBe("[visible]");
  });

  it("sandbox.disabledLanguages refuses the language", async () => {
    await expect(execute(plainCtx("lang0", {}), echoProbe)).resolves.toBeDefined();
    await expect(
      execute(plainCtx("lang1", { sandbox: { disabledLanguages: ["shell"] } }), echoProbe),
    ).rejects.toThrow(/disabled/);
  });
});

describe("search.defaultMaxTokens", () => {
  it("sets the output budget when the call gives none", async () => {
    const ctx = plainCtx("tok", {});
    const db = new SqliteAdapter(ctx.dbPath);
    try {
      for (let i = 0; i < 5; i++)
        indexContent(db, {
          source: "file",
          title: `Spec ${i}`,
          uri: `spec-${i}.md`,
          content: `# Spec ${i}\n\n${`The frobnicator handshake ${i} retries with backoff after timeout ${i}. `.repeat(12)}`,
          kind: "markdown",
        });
      const run = async (defaultMaxTokens: number) => {
        const c = { ...ctx, config: ConfigSchema.parse({ search: { defaultMaxTokens } }) };
        const r = await emSearch.handler({ queries: ["frobnicator handshake"] }, c);
        return r.content.map((x) => x.text).join("\n");
      };
      expect(await run(100)).toContain("more hit(s) omitted");
      expect(await run(8000)).not.toContain("omitted");
    } finally {
      db.close();
      closeAllStorage();
    }
  });
});

describe("git.maxCommits", () => {
  it("limits how many commits the co-change scan reads", () => {
    const ctx = plainCtx("git", { git: { maxCommits: 2 } });
    gitIn(ctx.root, "init -q");
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(ctx.root, "a.txt"), `${i}\n`);
      gitIn(ctx.root, `add . && git commit -qm c${i}`);
    }
    const db = new SqliteAdapter(ctx.dbPath);
    try {
      expect(reindexGitSignals(ctx, db, true).commits).toBe(2);
      const wide = { ...ctx, config: ConfigSchema.parse({ git: { maxCommits: 10 } }) };
      expect(reindexGitSignals(wide, db, true).commits).toBe(4);
    } finally {
      db.close();
    }
  });
});

describe("docs.crawl.maxPageBytes", () => {
  it("truncates a local page larger than the cap before indexing", async () => {
    const ctx = plainCtx("pg", { docs: { crawl: { maxPageBytes: 400 } } });
    mkdirSync(join(ctx.root, "guide"));
    writeFileSync(
      join(ctx.root, "guide/big.md"),
      `# Big\n\n${"All work and no play. ".repeat(200)}\n`,
    );
    const db = new SqliteAdapter(ctx.dbPath);
    try {
      const r = await syncSource(ctx, db, {
        name: "guide",
        kind: "path",
        path: "guide",
        addedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(r.truncated).toBe(1);
      const wide = plainCtx("pg2", { docs: { crawl: { maxPageBytes: 1_000_000 } } });
      mkdirSync(join(wide.root, "guide"));
      writeFileSync(
        join(wide.root, "guide/big.md"),
        `# Big\n\n${"All work and no play. ".repeat(200)}\n`,
      );
      const db2 = new SqliteAdapter(wide.dbPath);
      try {
        const r2 = await syncSource(wide, db2, {
          name: "guide",
          kind: "path",
          path: "guide",
          addedAt: "2026-01-01T00:00:00.000Z",
        });
        expect(r2.truncated).toBe(0);
      } finally {
        db2.close();
      }
    } finally {
      db.close();
    }
  });
});

describe("graph.exclude", () => {
  beforeAll(() => {
    process.env.EMINIAR_PLUGIN_ROOT = process.cwd();
  });
  afterAll(() => {
    delete process.env.EMINIAR_PLUGIN_ROOT;
  });

  it("keeps matching files out of the code graph", async () => {
    const scan = async (name: string, graph: Record<string, unknown>) => {
      const ctx = plainCtx(name, { graph });
      mkdirSync(join(ctx.root, "src"));
      mkdirSync(join(ctx.root, "gen"));
      writeFileSync(join(ctx.root, "src/keep.ts"), "export const keep = 1;\n");
      writeFileSync(join(ctx.root, "gen/skip.ts"), "export const skip = 1;\n");
      const db = new SqliteAdapter(ctx.dbPath);
      try {
        await reindexCode(ctx, db, { full: true });
        return db.fileIndexAll().map((f) => f.path);
      } finally {
        db.close();
      }
    };
    const all = await scan("ex0", {});
    expect(all).toContain("gen/skip.ts");
    const excluded = await scan("ex1", { exclude: ["gen/**"] });
    expect(excluded).toContain("src/keep.ts");
    expect(excluded).not.toContain("gen/skip.ts");
  });
});
