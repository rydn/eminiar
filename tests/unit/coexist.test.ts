import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { handlers } from "../../src/hooks/index.js";
import type { HookInput } from "../../src/hooks/types.js";
import { markServerAlive } from "../../src/session/server-alive.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

let root: string;
let unmark: () => void;

const pre = (tool_name: string, tool_input: Record<string, unknown>): Promise<unknown> =>
  handlers.PreToolUse!({
    session_id: "s1",
    cwd: root,
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
  } as HookInput) as Promise<unknown>;

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "em-coex-home-"));
  process.env.EMINIAR_HOME = home;
  // context-mode present in the plugin registry (read once per process, hence its own test file)
  const plugins = join(home, "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "installed_plugins.json"),
    JSON.stringify({ plugins: { "context-mode@x": [{}] } }),
  );
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = plugins;
  root = mkdtempSync(join(tmpdir(), "em-coex-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "big.log"), "x".repeat(30 * 1024));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "export function parseThing() {}\n");
  resetContextCache();
  unmark = markServerAlive(getContext(root));
  const db = getStorage(getContext(root), { vectors: false });
  db.graphUpsertNodes([
    {
      id: "file:src/x.ts",
      kind: "file",
      name: "src/x.ts",
      path: "src/x.ts",
      source: "tree-sitter",
    },
    {
      id: "sym:src/x.ts#parseThing",
      kind: "function",
      name: "parseThing",
      path: "src/x.ts",
      startLine: 1,
      endLine: 1,
      source: "tree-sitter",
    },
  ]);
  db.fileIndexSet({
    path: "big.log",
    hash: "h",
    mtime: 0,
    size: 30 * 1024,
    language: null,
    document_id: null,
    status: "skipped",
    reason: "over the size limit",
  });
});

afterAll(() => {
  unmark();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  delete process.env.EMINIAR_ROUTING_MODE;
});

describe("context-mode coexistence", () => {
  for (const mode of ["auto", "enforce", "annotate"]) {
    it(`mode ${mode}: no routing suggestion, graph hints kept`, async () => {
      process.env.EMINIAR_ROUTING_MODE = mode;
      writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ routing: { mode } }));
      resetContextCache();
      const grep = (await pre("Grep", { pattern: "parseThing" })) as {
        hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string };
      };
      expect(grep.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(grep.hookSpecificOutput?.additionalContext).toContain("symbols matching");
      expect(grep.hookSpecificOutput?.additionalContext).not.toContain("em_search");
      // a heavy read is routed without context-mode; here it is left alone, but the
      // coverage warning (only eminiar knows it) still comes with it
      const read = (await pre("Read", { file_path: join(root, "big.log") })) as
        | {
            hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string };
          }
        | undefined;
      expect(read?.hookSpecificOutput?.permissionDecision).toBeUndefined();
      expect(read?.hookSpecificOutput?.additionalContext).toContain(
        "eminiar graph: big.log is skipped (over the size limit)",
      );
    });
  }

  it("does not count the graph for tools that get no graph hint", async () => {
    process.env.EMINIAR_ROUTING_MODE = "auto";
    writeFileSync(join(root, "eminiar.config.json"), "{}");
    resetContextCache();
    const counts = vi.spyOn(SqliteAdapter.prototype, "graphCounts");
    try {
      await pre("Bash", { command: "ls" });
      await pre("WebFetch", { url: "https://example.com/x", prompt: "x" });
      expect(counts).not.toHaveBeenCalled();
      // the tools that can use it still get it
      await pre("Grep", { pattern: "parseThing" });
      expect(counts).toHaveBeenCalled();
    } finally {
      counts.mockRestore();
    }
  });
});
