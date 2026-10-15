import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import { suggest, withoutHeredocs } from "../../src/hooks/routing.js";
import type { HookInput, HookOutput } from "../../src/hooks/types.js";
import { indexContent } from "../../src/index/indexer.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

let root: string;
let unmark: () => void;
const base = (over: Partial<HookInput>): HookInput => ({
  session_id: "a1",
  cwd: root,
  hook_event_name: "x",
  ...over,
});
const ctxText = (out: HookOutput | undefined) => out?.hookSpecificOutput?.additionalContext ?? "";
const metric = (path: string, fan_in: number) => ({
  node_id: `file:${path}`,
  kind: "file",
  path,
  fan_in,
  fan_out: 0,
  loc: 10,
  complexity: 1,
  commits_90d: 1,
  score: 0.5,
  cluster: 0,
});

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  root = mkdtempSync(join(tmpdir(), "em-abilities-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false } }),
  );
  mkdirSync(join(root, "src"), { recursive: true });
  for (const f of ["src/parser.ts", "src/core.ts", "src/quiet.ts", "src/busy.ts"])
    writeFileSync(join(root, f), "export const x = 1;\n");
  resetContextCache();
  unmark = markServerAlive(getContext(root));

  const db = getStorage(getContext(root), { vectors: false });
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
  // src/core.ts: imported by five files, and its symbol is called from a sixth.
  // src/busy.ts: no importers, but 20 calls between its own helpers (metrics fan-in 20).
  const file = (path: string) => ({
    id: `file:${path}`,
    kind: "file",
    name: path,
    path,
    source: "tree-sitter" as const,
  });
  const fn = (path: string, name: string) => ({
    id: `sym:${path}#${name}`,
    kind: "function",
    name,
    path,
    source: "tree-sitter" as const,
  });
  const users = ["a", "b", "c", "d", "e"].map((n) => `src/use-${n}.ts`);
  const helpers = Array.from({ length: 21 }, (_, i) => fn("src/busy.ts", `h${i}`));
  db.graphUpsertNodes([
    ...["src/core.ts", "src/quiet.ts", "src/busy.ts", "src/caller.ts", ...users].map(file),
    fn("src/core.ts", "run"),
    fn("src/caller.ts", "main"),
    ...helpers,
  ]);
  db.graphUpsertEdges([
    ...users.map((u) => ({
      src: `file:${u}`,
      dst: "file:src/core.ts",
      kind: "imports",
      source: "tree-sitter" as const,
    })),
    {
      src: "sym:src/caller.ts#main",
      dst: "sym:src/core.ts#run",
      kind: "calls",
      source: "tree-sitter",
    },
    { src: "file:src/use-a.ts", dst: "file:src/quiet.ts", kind: "imports", source: "tree-sitter" },
    ...helpers.slice(1).map((h, i) => ({
      src: helpers[i]!.id,
      dst: h.id,
      kind: "calls",
      source: "tree-sitter" as const,
    })),
  ]);
  db.metricsReplace([
    metric("src/core.ts", 12),
    metric("src/quiet.ts", 1),
    metric("src/busy.ts", 20),
  ]);
  indexContent(db, {
    source: "docs:stripe",
    title: "Stripe › Rate limits",
    uri: "https://docs.stripe.test/rate-limits",
    content:
      "Stripe rate limits: 100 read requests per second in live mode. Handle 429 responses with exponential backoff and idempotency keys.",
    kind: "markdown",
  });
});
afterAll(() => {
  unmark();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

const tool = (sid: string, tool_name: string, tool_input: Record<string, unknown>) =>
  handlers.PreToolUse!(
    base({ session_id: sid, hook_event_name: "PreToolUse", tool_name, tool_input }),
  );

describe("history and graph context before an edit", () => {
  it("warns about a bug-prone file once per window, never on a plain Read", async () => {
    const edit = () => tool("e1", "Edit", { file_path: join(root, "src/parser.ts") });
    const out = await edit();
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(ctxText(out)).toContain("eminiar history: src/parser.ts is bug-prone");
    expect(ctxText(out)).toContain("5/9 commits were fixes");
    expect(ctxText(out)).toContain("2 earlier changes later needed fixing");
    expect(ctxText(out)).toContain("last fix 1a2b3c4 fix: parser drops trailing comments");
    expect(await edit()).toBeUndefined();
    expect(await tool("e2", "Read", { file_path: join(root, "src/parser.ts") })).toBeUndefined();
  });
  it("notes the files that depend on a widely used file", async () => {
    const core = await tool("e3", "Write", { file_path: join(root, "src/core.ts") });
    // five importers plus one caller of its symbol; the metrics fan-in (12) is not quoted
    expect(ctxText(core)).toContain("eminiar graph: 6 other files import or use src/core.ts");
    expect(await tool("e3", "Edit", { file_path: join(root, "src/quiet.ts") })).toBeUndefined();
  });
  it("does not count calls inside the file as dependents", async () => {
    // metrics fan-in is 20, all from its own helpers: nobody else depends on it
    expect(await tool("e4", "Edit", { file_path: join(root, "src/busy.ts") })).toBeUndefined();
  });
});

describe("commit risk", () => {
  it("names bug-prone and widely imported staged files before git commit", async () => {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("add", "src/parser.ts", "src/core.ts", "src/quiet.ts", "src/busy.ts");
    const out = await tool("c1", "Bash", { command: 'git commit -m "tweak parser"' });
    const text = ctxText(out);
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(text).toContain("this commit includes files that deserve a second look");
    expect(text).toContain("src/parser.ts is bug-prone");
    expect(text).toContain("widely imported: src/core.ts (6 dependent files)");
    expect(text).not.toContain("quiet.ts");
    expect(text).not.toContain("busy.ts");
    // not a commit: nothing to say
    expect(await tool("c1", "Bash", { command: "git status" })).toBeUndefined();
  });
});

describe("error recall", () => {
  const fail = (sid: string) =>
    handlers.PostToolUseFailure!(
      base({
        session_id: sid,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
        error:
          "Error: Cannot find module '@rollup/rollup-darwin-arm64'. npm has a bug related to optional dependencies",
      }),
    );
  it("tells a later session how the same error was resolved", async () => {
    expect(await fail("x1")).toBeUndefined(); // first sighting: nothing to recall
    await handlers.Stop!(
      base({
        session_id: "x1",
        hook_event_name: "Stop",
        last_assistant_message:
          "Fixed it by deleting node_modules and package-lock.json, then reinstalling.",
      }),
    );
    const out = await fail("x2");
    expect(out?.hookSpecificOutput?.hookEventName).toBe("PostToolUseFailure");
    expect(ctxText(out)).toContain("this error has been seen before");
    expect(ctxText(out)).toContain("then: Fixed it by deleting node_modules");
    // shown once per window
    expect(await fail("x2")).toBeUndefined();
  });
});

describe("docs before the web", () => {
  it("lists the indexed pages that answer a WebSearch", async () => {
    const out = await tool("w1", "WebSearch", { query: "stripe rate limits 429 backoff" });
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(ctxText(out)).toContain("eminiar docs: the local documentation index already has");
    expect(ctxText(out)).toContain("docs:stripe › Stripe › Rate limits");
  });
  it("puts them in the WebFetch denial reason in enforce mode", async () => {
    const out = await tool("w2", "WebFetch", {
      url: "https://stripe.com/docs/rate-limits",
      prompt: "what are the rate limits and how to handle 429",
    });
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("docs:stripe");
  });
});

describe("read routing", () => {
  it("lets Read show large images and PDFs; large text still goes to the sandbox", () => {
    const big = "x".repeat(300 * 1024);
    for (const f of [
      "shot.png",
      "photo.JPG",
      "anim.gif",
      "pic.webp",
      "spec.pdf",
      "logo.svg",
      "data.json",
    ])
      writeFileSync(join(root, f), big);
    for (const f of ["shot.png", "photo.JPG", "anim.gif", "pic.webp", "spec.pdf"])
      expect(suggest("Read", { file_path: join(root, f) }, root), f).toBeUndefined();
    // SVG is text: a 300 KB one floods the context like any other text file
    expect(suggest("Read", { file_path: join(root, "logo.svg") }, root)?.tool).toBe(
      "em_execute_file",
    );
    expect(suggest("Read", { file_path: join(root, "data.json") }, root)?.tool).toBe(
      "em_execute_file",
    );
  });
});

describe("bash routing ignores heredoc bodies", () => {
  it("lets cat-redirect writes through and does not read pipes inside heredocs", () => {
    const write = "cat >> notes.md <<'EOF'\nsome | head text\nEOF";
    expect(withoutHeredocs(write)).toBe("cat >> notes.md <<EOF");
    expect(suggest("Bash", { command: write }, root)).toBeUndefined();
    expect(suggest("Bash", { command: "cat big.log" }, root)?.tool).toBe("em_execute");
    expect(suggest("Bash", { command: "cat a.log > b.log | head" }, root)?.tool).toBe("em_execute");
  });
});
