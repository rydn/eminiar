import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { processOutput } from "../../src/sandbox/output.js";
import { runProcess } from "../../src/sandbox/run.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emBatchExecute } from "../../src/tools/em_batch_execute.js";
import { emExecute } from "../../src/tools/em_execute.js";
import { emExecuteFile } from "../../src/tools/em_execute_file.js";

let ctx: ProjectContext;
let db: StorageAdapter;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_HOME = home;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "em-root-")));
  writeFileSync(join(root, "package.json"), "{}");
  ctx = { root, id: "test", dbPath: join(home, "t.db"), config: ConfigSchema.parse({}) };
  db = getStorage(ctx);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");
const count = (s: string, part: string) => s.split(part).length - 1;

describe("processOutput stderr boundaries", () => {
  it("returns a 1.5 KB stderr whole and tails one just over 2 KB, with the exact omitted count", async () => {
    const small = await processOutput(db, ctx, {
      stdout: "ok",
      stderr: "e".repeat(1500),
      title: "t",
      source: "exec",
    });
    expect(small.text).toBe(`ok\n--- stderr ---\n${"e".repeat(1500)}\n`);
    const over = await processOutput(db, ctx, {
      stdout: "ok",
      stderr: "e".repeat(2049),
      title: "t",
      source: "exec",
    });
    expect(over.text).toContain("… 1 chars omitted …");
  });

  it("separates a stdout without a trailing newline from the mark", async () => {
    const r = await processOutput(db, ctx, {
      stdout: "no newline",
      stderr: "warned",
      title: "t",
      source: "exec",
    });
    expect(r.text).toBe("no newline\n--- stderr ---\nwarned\n");
  });

  it("lists stderr's words among the searchable terms", async () => {
    const r = await processOutput(db, ctx, {
      stdout: `${"plain line\n".repeat(600)}`,
      stderr: "zxqvword ".repeat(30),
      title: "t",
      source: "exec",
      intent: "plain",
    });
    expect(r.text).toMatch(/searchable terms: .*zxqvword/);
  });
});

describe("runProcess stderr cap", () => {
  it("never returns more than the cap when stderr arrives in several chunks", async () => {
    const js =
      "(async()=>{for(let i=0;i<4;i++){process.stderr.write('x'.repeat(400));await new Promise(r=>setTimeout(r,40));}})()";
    const r = await runProcess([process.execPath, "-e", js], {
      cwd: ctx.root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(r.stderr.length).toBe(1024);
  });
});

describe("exec tools: stderr tail and header details", () => {
  it("em_execute shows a small failure's stderr once, even with an intent", async () => {
    const r = await emExecute.handler(
      { language: "shell", code: "echo out; echo smallmarker >&2; exit 1", intent: "smallmarker" },
      ctx,
    );
    expect(count(textOf(r), "smallmarker")).toBe(1);
  }, 30_000);

  it("em_execute adds no stderr tail on success, whatever the intent", async () => {
    const code =
      'i=0; while [ $i -lt 120 ]; do echo "noise $i ok-line padding padding padding" >&2; i=$((i+1)); done; echo done';
    const out = textOf(await emExecute.handler({ language: "shell", code, intent: "noise" }, ctx));
    expect(out).not.toContain("stderr (tail):");
  }, 30_000);

  it("em_execute adds the tail for queries alone, capped at 2 KB", async () => {
    const code =
      'i=0; while [ $i -lt 400 ]; do echo "line $i padding padding padding padding" >&2; i=$((i+1)); done; echo ENDMARK >&2; exit 1';
    const out = textOf(
      await emExecute.handler({ language: "shell", code, queries: ["padding"] }, ctx),
    );
    const tail = out.split("stderr (tail):\n")[1];
    expect(tail).toBeDefined();
    expect(tail!.length).toBe(2048);
    expect(tail).toContain("ENDMARK");
  }, 30_000);

  it("em_execute_file counts only the cleaned stderr in its header", async () => {
    const code = "head -c 8000 /dev/zero | tr '\\0' '\\r' >&2; echo kept >&2";
    const out = textOf(await emExecuteFile.handler({ path: "package.json", code }, ctx));
    expect(out).toMatch(/· 0\.0 KB stderr · /);
  }, 30_000);

  it("em_batch_execute cleans progress frames before it indexes and counts, and caps the failure tail", async () => {
    const command =
      "head -c 8000 /dev/zero | tr '\\0' '\\r' >&2; printf '  9%%\\r 99%%\\rfinal\\n' >&2; head -c 3000 /dev/zero | tr '\\0' 'z' >&2; echo ' ENDMARK' >&2; yes line | head -n 600; exit 1";
    const out = textOf(
      await emBatchExecute.handler(
        { commands: [{ label: "b", command }], queries: ["final"] },
        ctx,
      ),
    );
    expect(out).toMatch(/· (2\.9|3\.0) KB stderr · /);
    expect(out).not.toContain(" 99%");
    const line = out.match(/\nstderr: (.*)\n/)?.[1];
    expect(line).toHaveLength(800);
    expect(line).toContain("ENDMARK");
  }, 30_000);

  it("em_batch_execute adds no stderr line for a command that succeeded", async () => {
    const command = "yes line | head -n 600; head -c 3000 /dev/zero | tr '\\0' 'z' >&2";
    const out = textOf(
      await emBatchExecute.handler(
        { commands: [{ label: "ok", command }], queries: ["line"] },
        ctx,
      ),
    );
    expect(out).not.toMatch(/\nstderr: /);
  }, 30_000);
});

describe("review 54 fixes", () => {
  it("em_execute_file adds a 2048-char stderr tail on failure with an intent", async () => {
    const code =
      'i=0; while [ $i -lt 400 ]; do echo "line $i padding padding padding padding" >&2; i=$((i+1)); done; echo ENDMARK >&2; exit 1';
    const out = textOf(
      await emExecuteFile.handler({ path: "package.json", code, intent: "padding" }, ctx),
    );
    const tail = out.split("stderr (tail):\n")[1];
    expect(tail).toBeDefined();
    expect(tail!.length).toBe(2048);
    expect(tail).toContain("ENDMARK");
  }, 30_000);

  it("cleanStderr stays linear on U+2028 runs", async () => {
    const { cleanStderr } = await import("../../src/sandbox/output.js");
    const s = " ".repeat(2_000_000);
    const t = Date.now();
    cleanStderr(s);
    expect(Date.now() - t).toBeLessThan(100);
    expect(cleanStderr("a\rb\nc\rd")).toBe("b\nd");
  });

  it("batch keeps a short stdout inline behind a noisy stderr", async () => {
    const command = "echo 'added 812 packages'; head -c 9700 /dev/zero | tr '\\0' 'e' >&2";
    const out = textOf(
      await emBatchExecute.handler({ commands: [{ label: "npm", command }] }, ctx),
    );
    expect(out).toContain("added 812 packages");
    expect(out).toContain("chars omitted");
  }, 30_000);

  it("flags stderr truncation with a correct dropped count", async () => {
    const js = "process.stderr.write('x'.repeat(5000))";
    const r = await runProcess([process.execPath, "-e", js], {
      cwd: ctx.root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    expect(r.stderr.length).toBe(1024);
    expect(r.stderrDropped).toBe(5000 - 1024);
    const { describeRun } = await import("../../src/sandbox/execute.js");
    expect(describeRun(r)).toContain("stderr TRUNCATED (3976 earlier chars dropped)");
  });
});
