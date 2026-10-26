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
  for (const f of ["src/parser.ts", "src/core.ts", "src/quiet.ts"])
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
  db.metricsReplace([metric("src/core.ts", 12), metric("src/quiet.ts", 1)]);
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

describe("history and graph context before a read or an edit", () => {
  it("warns about a bug-prone file once per window, on a Read as well as an Edit", async () => {
    const edit = () => tool("e1", "Edit", { file_path: join(root, "src/parser.ts") });
    const out = await edit();
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(ctxText(out)).toContain("eminiar history: src/parser.ts is bug-prone");
    expect(ctxText(out)).toContain("5/9 commits were fixes");
    expect(ctxText(out)).toContain("2 earlier changes later needed fixing");
    expect(ctxText(out)).toContain("last fix 1a2b3c4 fix: parser drops trailing comments");
    expect(await edit()).toBeUndefined();
    // a fresh window: the fix record arrives before the file is even read, and the edit
    // that follows does not repeat it
    const read = await tool("e2", "Read", { file_path: join(root, "src/parser.ts") });
    expect(ctxText(read)).toContain("eminiar history: src/parser.ts is bug-prone");
    expect(await tool("e2", "Edit", { file_path: join(root, "src/parser.ts") })).toBeUndefined();
  });
  it("notes fan-in for widely imported files only, and only before an edit", async () => {
    expect(await tool("e3", "Read", { file_path: join(root, "src/core.ts") })).toBeUndefined();
    const core = await tool("e3", "Write", { file_path: join(root, "src/core.ts") });
    expect(ctxText(core)).toContain("eminiar graph: src/core.ts is imported by 12 files");
    expect(await tool("e3", "Edit", { file_path: join(root, "src/quiet.ts") })).toBeUndefined();
  });
});

describe("git history commands route to em_history", () => {
  it("maps log, blame, show and shortlog forms to the matching em_history call", () => {
    const call = (cmd: string) => suggest("Bash", { command: cmd }, root);
    expect(call("git log --oneline -30")?.tool).toBe("em_history");
    expect(call("git log --oneline -30")?.reason).toContain('{action:"overview"}');
    expect(call("git log -p -- src/parser.ts")?.reason).toContain(
      '{action:"file", path:"src/parser.ts"}',
    );
    expect(call("git log --follow src/parser.ts | head -20")?.reason).toContain(
      '{action:"file", path:"src/parser.ts"}',
    );
    expect(call("git blame src/core.ts")?.reason).toContain('{action:"file", path:"src/core.ts"}');
    expect(call("git show 1a2b3c4 --stat")?.reason).toContain('{action:"commit", sha:"1a2b3c4"}');
    expect(call("git log --grep='rate limit' -i")?.reason).toContain(
      '{action:"search", query:"rate limit"}',
    );
    expect(call("git log main..feature/x --oneline")?.reason).toContain(
      '{action:"branch", name:"feature/x"}',
    );
    expect(call("git log -L :parse:src/parser.ts")?.reason).toContain(
      '{action:"symbol", name_path:"src/parser.ts#parse"}',
    );
    expect(call("git log --author=ryan --since=2.weeks")?.reason).toContain(
      '{action:"timeline", author:"ryan"}',
    );
    expect(call("cd src && git log -5")?.tool).toBe("em_history");
    expect(call("git -C /tmp/other --no-pager log -5")?.tool).toBe("em_history");
  });
  it("leaves one-commit lookups and file prints alone", () => {
    const call = (cmd: string) => suggest("Bash", { command: cmd }, root);
    expect(call("git log -1 --format=%H")).toBeUndefined();
    expect(call("git log -n 1 --pretty=%s")).toBeUndefined();
    // a patch is big even for one commit
    expect(call("git log -1 -p")?.tool).toBe("em_history");
    // `git show REF:path` prints a file, not history
    expect(call("git show HEAD:package.json")?.tool).toBe("em_execute");
    expect(call("git status")).toBeUndefined();
  });
  it("denies the raw log in enforce mode and names the em_history call", async () => {
    const out = await tool("h1", "Bash", { command: "git log --oneline -20 -- src/parser.ts" });
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain("Retry with em_history");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toContain(
      'em_history {action:"file", path:"src/parser.ts"}',
    );
  });
});

describe("commit risk", () => {
  it("names bug-prone and widely imported staged files before git commit", async () => {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("add", "src/parser.ts", "src/core.ts", "src/quiet.ts");
    const out = await tool("c1", "Bash", { command: 'git commit -m "tweak parser"' });
    const text = ctxText(out);
    expect(out?.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(text).toContain("this commit includes files that deserve a second look");
    expect(text).toContain("src/parser.ts is bug-prone");
    expect(text).toContain("widely imported: src/core.ts (12 importers)");
    expect(text).not.toContain("quiet.ts");
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

describe("bash routing ignores heredoc bodies", () => {
  it("lets cat-redirect writes through and does not read pipes inside heredocs", () => {
    writeFileSync(join(root, "big.log"), "x".repeat(30 * 1024));
    const write = "cat >> notes.md <<'EOF'\nsome | head text\nEOF";
    expect(withoutHeredocs(write)).toBe("cat >> notes.md <<EOF");
    expect(suggest("Bash", { command: write }, root)).toBeUndefined();
    expect(suggest("Bash", { command: "cat big.log" }, root)?.tool).toBe("em_execute");
    expect(suggest("Bash", { command: "cat big.log | grep x" }, root)?.tool).toBe("em_execute");
    // a redirection into a file is a write, and `| head` caps what is printed
    expect(suggest("Bash", { command: "cat big.log > b.log" }, root)).toBeUndefined();
    expect(suggest("Bash", { command: "cat big.log | head" }, root)).toBeUndefined();
  });
});
