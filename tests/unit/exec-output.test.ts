import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { cleanStderr, processOutput } from "../../src/sandbox/output.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emBatchExecute } from "../../src/tools/em_batch_execute.js";
import { emExecute } from "../../src/tools/em_execute.js";
import { emExecuteFile } from "../../src/tools/em_execute_file.js";

// The exec tools return and index stderr after stdout (decision/exec-output-includes-stderr).
let ctx: ProjectContext;
let db: StorageAdapter;
const saved = process.env.EMINIAR_HOME;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_HOME = home;
  // The real path: em_execute_file compares the resolved file with the root (/var vs /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "em-root-")));
  writeFileSync(join(root, "package.json"), "{}");
  ctx = { root, id: "test", dbPath: join(home, "t.db"), config: ConfigSchema.parse({}) };
  db = getStorage(ctx);
});
afterAll(() => {
  closeAllStorage();
  if (saved === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = saved;
});

describe("cleanStderr", () => {
  it("keeps the last frame of each line, CRLF and text after a bar", () => {
    expect(cleanStderr("  0%\r 50%\r100%\nnext\r\nline\r")).toBe("100%\nnext\r\nline");
    expect(cleanStderr("\r\r[====]\rERROR: boom\n")).toBe("ERROR: boom");
    expect(cleanStderr("plain\nlines\n")).toBe("plain\nlines");
  });

  it("stays linear on a long line with no carriage return", () => {
    // Ryan's rule for redaction (adjudicator/redact-rules): linear on 100 KB. An unanchored
    // `[^\n]*\r` rescans the line from every position, seconds here. The bound scales with a
    // linear baseline measured under the same load, and a slow input is re-timed before it fails.
    const time = (s: string): number => {
      const t0 = performance.now();
      cleanStderr(s);
      return performance.now() - t0;
    };
    cleanStderr("warm up\r the regex\n".repeat(10));
    const plain = "the quick brown fox jumps over the lazy dog 0123456789\n".repeat(100_000 / 55);
    const baseline = Math.min(time(plain), time(plain), time(plain));
    const bound = Math.max(100, 25 * baseline);
    for (const s of ["y".repeat(100_000), "a\rb".repeat(33_000), `${"x".repeat(100_000)}\r`]) {
      let t = time(s);
      for (let retry = 0; retry < 2 && t >= bound; retry++) t = Math.min(t, time(s));
      expect(t, `${JSON.stringify(s.slice(0, 8))} (bound ${bound.toFixed(0)} ms)`).toBeLessThan(
        bound,
      );
    }
  }, 60_000);
});

describe("processOutput with stderr", () => {
  it("indexes stderr as its own document, so JSON on stdout is still chunked as json", async () => {
    const json = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, name: `n${i}` })));
    const meter = "  % Total    % Received\n  0  0\r100  9000\n";
    const r = await processOutput(db, ctx, {
      stdout: json,
      stderr: meter,
      title: "api",
      source: "exec",
      intent: "Received",
    });
    expect(r.documentIds).toHaveLength(2);
    const [out, err] = (r.documentIds ?? []).map((id) => db.getDocument(id)!);
    expect(out?.content_type).toBe("json");
    expect(db.chunksOfDocument(out!.id)[0]?.title).toMatch(/^api \$\[0\.\./);
    expect(err?.title).toBe("api (stderr)");
    // Both go through indexContent under the tool's source, so index-time redaction there (the
    // privacy PR) would cover both.
    expect([out?.source, err?.source]).toEqual(["exec", "exec"]);
    expect(r.text).toContain(`document_ids: [${r.documentIds?.join(", ")}]`);
    // The search covers both documents: the intent only matches the stderr one.
    expect(r.text).toContain("% Received");
  });
});

describe("processOutput threshold", () => {
  it("returns a short stdout whole when only stderr is noisy, with stderr tailed", async () => {
    const stdout = "x".repeat(4500);
    const stderr = `${"a".repeat(3000)}END`;
    const r = await processOutput(db, ctx, { stdout, stderr, title: "t", source: "exec" });
    expect(r.text).toContain(stdout);
    expect(r.text).toContain("--- stderr ---");
    expect(r.text).toContain("chars omitted");
    expect(r.text.endsWith("]")).toBe(true);
    expect(r.text).toContain("END");
    expect(r.text.length).toBeLessThan(stdout.length + 2600);
  });

  it("keeps a summary on the last stdout line when stdout is long and stderr is noisy", async () => {
    const stdout = `${"case ok\n".repeat(1500)}Tests: 5 passed, 0 failed`;
    const stderr = `${"warn: deprecated call\n".repeat(400)}stderr end`;
    const r = await processOutput(db, ctx, { stdout, stderr, title: "t", source: "exec" });
    const [shownStdout, shownStderr] = r.text.split("--- stderr ---");
    expect(shownStdout).toContain("Tests: 5 passed, 0 failed");
    expect(shownStderr).toContain("stderr end");
    expect(shownStderr).not.toContain("Tests: 5 passed");
  });

  it("previews a long stdout by its own head and tail, then stderr", async () => {
    const stdout = `HEAD${"y".repeat(9000)}TAIL`;
    const r = await processOutput(db, ctx, {
      stdout,
      stderr: "warned",
      title: "t",
      source: "exec",
    });
    expect(r.text).toContain("HEAD");
    expect(r.text).toContain("TAIL");
    expect(r.text).toContain("chars omitted");
    expect(r.text).toContain("--- stderr ---\nwarned");
  });
});

describe("exec tools and stderr", () => {
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => c.text ?? "").join("\n");
  const count = (s: string, part: string) => s.split(part).length - 1;
  /** About 14 KB on stderr and nothing on stdout, the way Jest reports, then exit 1. */
  const jestLike = [
    "i=1",
    "while [ $i -le 200 ]; do",
    '  if [ $i -eq 50 ]; then echo "FAIL case $i: quokka expected 1, received 2" >&2',
    '  else echo "PASS case $i: this case of the suite went fine as usual, nothing to see" >&2; fi',
    "  i=$((i + 1))",
    "done",
    'echo "LAST LINE UNIQUE" >&2',
    "exit 1",
  ].join("\n");

  it("em_execute: an intent finds a failure reported on stderr far from its end", async () => {
    // Line 50 is about 10 KB from the end: outside the old 8 KB buffer and its 2 KB tail.
    const r = await emExecute.handler({ language: "shell", code: jestLike, intent: "quokka" }, ctx);
    const out = textOf(r);
    expect(out).toMatch(/^exit 1 · 0\.0 KB stdout · 1\d\.\d KB stderr · /);
    expect(out).toContain("FAIL case 50: quokka expected 1, received 2");
    // The search chose what came back, so the end of the failure is added.
    expect(out).toContain("stderr (tail):");
    expect(count(out, "LAST LINE UNIQUE")).toBe(1);
  }, 30_000);

  it("em_execute: without an intent the preview already ends with stderr, shown once", async () => {
    const out = textOf(await emExecute.handler({ language: "shell", code: jestLike }, ctx));
    expect(out).toContain("chars omitted");
    expect(out).not.toContain("stderr (tail):");
    expect(count(out, "LAST LINE UNIQUE")).toBe(1);
  }, 30_000);

  it("em_execute: stderr follows a marker, also on success, with progress frames dropped", async () => {
    // 8 KB of bare carriage returns in front: the header counts what comes back, not what was written.
    const code = [
      'echo "npm test"',
      "head -c 8000 /dev/zero | tr '\\0' '\\r' >&2",
      "printf '  0%%\\r 50%%\\r100%%\\n' >&2",
      'echo "Tests: 3 passed" >&2',
    ].join("; ");
    const r = await emExecute.handler({ language: "shell", code }, ctx);
    const out = textOf(r);
    expect(out).toMatch(/· 0\.0 KB stderr · /);
    expect(out).toContain("npm test\n--- stderr ---\n100%\nTests: 3 passed");
    expect(out).not.toContain(" 50%");
    expect(r.isError).toBeUndefined();
  }, 30_000);

  it("em_execute: a failure with no stdout is still an error and shows its stderr once", async () => {
    const r = await emExecute.handler({ language: "shell", code: "echo boom >&2; exit 2" }, ctx);
    const out = textOf(r);
    expect(r.isError).toBe(true);
    expect(out).toContain("--- stderr ---\nboom");
    expect(count(out, "boom")).toBe(1);
  }, 30_000);

  it("em_execute_file returns what the code wrote to stderr", async () => {
    const code = 'wc -c < "$EM_FILE"; echo "no lines matched" >&2';
    const r = await emExecuteFile.handler({ path: "package.json", code }, ctx);
    expect(textOf(r)).toMatch(/2\n--- stderr ---\nno lines matched/);
    const big = textOf(await emExecuteFile.handler({ path: "package.json", code: jestLike }, ctx));
    expect(big).not.toContain("stderr (tail):");
    expect(count(big, "LAST LINE UNIQUE")).toBe(1);
  }, 30_000);

  it("em_batch_execute inlines cleaned stderr with the output and does not repeat its tail", async () => {
    const r = await emBatchExecute.handler(
      { commands: [{ label: "warn", command: "echo out; printf '50%%\\rwarned\\n' >&2; exit 1" }] },
      ctx,
    );
    const out = textOf(r);
    expect(out).toContain("out\n--- stderr ---\nwarned");
    expect(count(out, "warned")).toBe(1);
  }, 30_000);

  it("em_execute: a failure that printed some stdout is not flagged isError", async () => {
    const r = await emExecute.handler({ language: "shell", code: "echo partial; exit 1" }, ctx);
    expect(textOf(r)).toContain("partial");
    expect(textOf(r)).toMatch(/^exit 1/);
    expect(r.isError).toBeFalsy();
  }, 30_000);

  it("em_batch_execute shows the stderr tail of a failing command over 1 KB when queries are given", async () => {
    const command =
      'head -c 3000 /dev/zero | tr "\\0" "o"; echo; echo "ENDS WITH tailmarker-77" >&2; exit 3';
    const r = await emBatchExecute.handler(
      { commands: [{ label: "bad", command }], queries: ["tailmarker"] },
      ctx,
    );
    const out = textOf(r);
    expect(out).not.toContain("o".repeat(1500));
    expect(out).toMatch(/\nstderr: ENDS WITH tailmarker-77\n/);
  }, 30_000);

  it("em_execute_file shows 'stderr (tail):' for an intent run on a failing script", async () => {
    const r = await emExecuteFile.handler(
      { path: "package.json", code: jestLike, intent: "quokka" },
      ctx,
    );
    const out = textOf(r);
    expect(out).toContain("FAIL case 50: quokka expected 1, received 2");
    expect(out).toContain("stderr (tail):");
    expect(count(out, "LAST LINE UNIQUE")).toBe(1);
  }, 30_000);

  it("em_batch_execute answers queries from what a command wrote to stderr", async () => {
    // stderr over its 2 KB tail budget, exit 0: only the index can return the line from its head.
    const command =
      'echo "spec run"; echo "FAIL quokka spec" >&2; head -c 3000 /dev/zero | tr "\\0" "y" >&2';
    const r = await emBatchExecute.handler(
      { commands: [{ label: "spec", command }], queries: ["quokka"] },
      ctx,
    );
    const out = textOf(r);
    expect(out).not.toContain("y".repeat(3000));
    expect(out).toMatch(/^## spec — .* · docs \d+, \d+/);
    expect(out).toContain("chars omitted");
    expect(out.split("# query hits")[1]).toContain("FAIL quokka spec");
  }, 30_000);
});
