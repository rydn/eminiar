import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { type PermissionRules, parseRule } from "../../src/permissions/rules.js";
import { execute } from "../../src/sandbox/execute.js";
import { confinePath } from "../../src/sandbox/file.js";
import { prepareCode, resolveLanguage } from "../../src/sandbox/languages.js";
import { processOutput } from "../../src/sandbox/output.js";
import { runProcess } from "../../src/sandbox/run.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { chooseInline, emBatchExecute } from "../../src/tools/em_batch_execute.js";
import { emExecuteFile } from "../../src/tools/em_execute_file.js";
import { emIndex } from "../../src/tools/em_index.js";

let ctx: ProjectContext;
let db: SqliteAdapter;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_HOME = home;
  const root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  ctx = { root, id: "test", dbPath: join(home, "t.db"), config: ConfigSchema.parse({}) };
  db = new SqliteAdapter(ctx.dbPath);
});
afterAll(() => {
  db.close();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

describe("runProcess", () => {
  it("captures stdout and exit code", async () => {
    const r = await runProcess(["sh", "-c", "echo hi; exit 3"], {
      cwd: ctx.root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    expect(r.stdout).toBe("hi\n");
    expect(r.exitCode).toBe(3);
  });
  it("times out and truncates", async () => {
    const t = await runProcess(["sh", "-c", "sleep 5"], {
      cwd: ctx.root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 200,
      maxOutputBytes: 1024,
    });
    expect(t.timedOut).toBe(true);
    const big = await runProcess(["sh", "-c", "yes | head -c 100000"], {
      cwd: ctx.root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 5000,
      maxOutputBytes: 2048,
    });
    expect(big.truncated).toBe(true);
    expect(big.stdout.length).toBeLessThanOrEqual(2048);
  });
  it("keeps the end of stderr up to the output cap, whole characters only", async () => {
    const run = (js: string, maxOutputBytes: number) =>
      runProcess([process.execPath, "-e", js], {
        cwd: ctx.root,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 10_000,
        maxOutputBytes,
      });
    // 400 KB of a two-byte character after one odd byte: past the old 8 KB tail, and the pipe's
    // even-sized chunks then end mid-character.
    const wide = await run("process.stderr.write('a' + 'é'.repeat(200000))", 1024 * 1024);
    expect(wide.stderr).toBe(`a${"é".repeat(200000)}`);
    const capped = await run("process.stderr.write('a'.repeat(5000) + 'END')", 1024);
    expect(capped.stderr).toBe(`${"a".repeat(1021)}END`);
  });
});

describe("execute", () => {
  it("runs shell, javascript and typescript in the project root", async () => {
    const sh = await execute(ctx, { language: "shell", code: "pwd; echo $EMINIAR_PROJECT_ROOT" });
    expect(sh.stdout.split("\n")[0]).toContain(ctx.root.split("/").pop());
    const js = await execute(ctx, { language: "javascript", code: "console.log(1+1)" });
    expect(js.stdout.trim()).toBe("2");
    const ts = await execute(ctx, {
      language: "typescript",
      code: "const x: number = 40; console.log(x + 2)",
    });
    expect(ts.stdout.trim()).toBe("42");
  }, 30_000);

  it("refuses denied shell commands and unknown languages", async () => {
    const denied = {
      ...ctx,
      config: ConfigSchema.parse({ permissions: { extraDeny: ["Bash(sudo *)"] } }),
    };
    await expect(execute(denied, { language: "shell", code: "ls; sudo ls" })).rejects.toThrow(
      /sudo/,
    );
    await expect(execute(ctx, { language: "cobol", code: "x" })).rejects.toThrow(
      /unknown language/,
    );
  });

  it("gives javascript and typescript a `require` next to `import`", async () => {
    const js = await execute(ctx, {
      language: "javascript",
      code: "const fs = require('fs'); console.log(typeof fs.readFileSync)",
    });
    expect(js.stderr).toBe("");
    expect(js.stdout.trim()).toBe("function");
    const esm = await execute(ctx, {
      language: "javascript",
      code: 'import fs from "node:fs";\nconsole.log(typeof fs.statSync)',
    });
    expect(esm.stdout.trim()).toBe("function");
    const ts = await execute(ctx, {
      language: "typescript",
      code: "const p: typeof import('node:path') = require('path'); console.log(typeof p.join)",
    });
    expect(ts.stdout.trim()).toBe("function");
  }, 30_000);

  it("resolves `require` from the project root, not the scratch directory", async () => {
    // A package only the project has (zod, linked from this repo's node_modules) and a
    // relative path: both must resolve against the project root, where the snippet runs.
    mkdirSync(join(ctx.root, "node_modules"), { recursive: true });
    symlinkSync(
      fileURLToPath(new URL("../../node_modules/zod", import.meta.url)),
      join(ctx.root, "node_modules", "zod"),
    );
    const r = await execute(ctx, {
      language: "javascript",
      code: "const { z } = require('zod'); const pkg = require('./package.json'); console.log(typeof z.object, JSON.stringify(pkg))",
    });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("function {}");
    // A hashbang stays on the first line, the preamble goes second.
    const bang = await execute(ctx, {
      language: "javascript",
      code: "#!/usr/bin/env node\nconsole.log(typeof require('os').platform)",
    });
    expect(bang.stderr).toBe("");
    expect(bang.stdout.trim()).toBe("function");
  }, 30_000);

  it("does not declare `require` twice when the snippet brings its own", async () => {
    const own =
      'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconsole.log(typeof require("os").platform)';
    const js = resolveLanguage("javascript")!;
    expect(prepareCode(js, own)).toBe(own);
    expect(prepareCode(js, "const require = (m) => m; console.log(require('x'))")).toContain(
      "const require = (m)",
    );
    expect(prepareCode(js, "function require(m) { return m }\nrequire('x')")).not.toContain(
      "createRequire",
    );
    expect(prepareCode(js, "console.log(1)")).toBe("console.log(1)");
    // The preamble is one line, so a snippet's line N is the file's line N+1.
    expect(prepareCode(js, "require('fs')").split("\n")).toHaveLength(2);
    expect(prepareCode(js, "#!/usr/bin/env node\nrequire('fs')").split("\n")).toEqual([
      "#!/usr/bin/env node",
      expect.stringContaining("createRequire"),
      "require('fs')",
    ]);
    const r = await execute(ctx, { language: "javascript", code: own });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("function");
  }, 30_000);
});

describe("em_batch_execute inline rule", () => {
  const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => c.text ?? "").join("\n");
  const twoKb = "console.log('x'.repeat(2000))";

  it("inlines outputs up to the index threshold when there are no queries", async () => {
    const r = await emBatchExecute.handler(
      { commands: [{ label: "big", command: twoKb, language: "javascript" }] },
      ctx,
    );
    const out = textOf(r);
    expect(out).toMatch(/^## big — exit 0 · 2\.0 KB stdout .* · doc \d+\n/);
    expect(out).toContain("x".repeat(2000));
    expect(out).not.toContain("em_search {document_ids");
  }, 30_000);

  it("keeps the 1 KB cap with queries and says how to fetch an elided output", async () => {
    const r = await emBatchExecute.handler(
      {
        commands: [{ label: "big", command: twoKb, language: "javascript" }],
        queries: ["xxxx"],
      },
      ctx,
    );
    const out = textOf(r);
    expect(out).not.toContain("x".repeat(2000));
    expect(out).toMatch(
      /^## big — exit 0 .* · doc (\d+) · em_search \{document_ids: \[\1\]\} for the output\n/,
    );
  }, 30_000);

  it("shares the token budget without letting one output starve the rest", () => {
    // Four outputs of about 1 KB, 3 KB budget: the three smallest fit, the largest is elided.
    expect([...chooseInline([1024, 1000, 1010, 900], 5120, 3000)].sort()).toEqual([1, 2, 3]);
    // Over the per-output cap: never inline, whatever the budget.
    expect(chooseInline([6000, 10], 5120, 100_000).has(0)).toBe(false);
    expect(chooseInline([6000, 10], 5120, 100_000).has(1)).toBe(true);
    // One large output and several small ones: the small ones all come back.
    expect([...chooseInline([5000, 100, 100, 100], 5120, 2000)].sort()).toEqual([1, 2, 3]);
  });
});

describe("processOutput", () => {
  it("returns small outputs verbatim and indexes large ones by intent", async () => {
    const small = await processOutput(db, ctx, { stdout: "ok", title: "t", source: "exec" });
    expect(small.text).toBe("ok");
    expect(small.documentId).toBeUndefined();

    const big = Array.from({ length: 400 }, (_, i) =>
      i === 250 ? "ERROR: connection refused to postgres" : `line ${i} routine output noise`,
    ).join("\n");
    const r = await processOutput(db, ctx, {
      stdout: big,
      title: "logs",
      source: "exec",
      intent: "connection refused error",
    });
    expect(r.documentId).toBeDefined();
    expect(r.text).toContain("connection refused");
    expect(r.text).toContain("searchable terms");
    expect(r.text.length).toBeLessThan(big.length / 2);

    const noIntent = await processOutput(db, ctx, { stdout: big, title: "logs2", source: "exec" });
    expect(noIntent.text).toContain("chars omitted");
  });
});

describe("confinePath", () => {
  const rules = (r: { allow?: string[]; deny?: string[]; ask?: string[] }): PermissionRules => ({
    allow: (r.allow ?? []).map((s) => parseRule(s)!),
    deny: (r.deny ?? []).map((s) => parseRule(s)!),
    ask: (r.ask ?? []).map((s) => parseRule(s)!),
  });
  let root: string;
  let outside: string;
  beforeAll(() => {
    // The project root is always a real path, and the macOS tmpdir is a symlink.
    root = realpathSync(mkdtempSync(join(tmpdir(), "em-confine-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "em-outside-")));
    writeFileSync(join(root, "app.ts"), "export {};");
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, "config.txt"), "c");
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "key.pem"), "k");
    symlinkSync(join(root, ".env"), join(root, "notes.txt"));
    mkdirSync(join(root, "linked"));
    symlinkSync(join(root, "config.txt"), join(root, "linked", ".env"));
    writeFileSync(join(outside, "data.log"), "d");
    writeFileSync(join(outside, "key.pem"), "k");
  });

  it("keeps files inside the root and opts outside files in with a Read allow rule", () => {
    expect(confinePath(root, "app.ts", rules({}))).toBe(join(root, "app.ts"));
    expect(() => confinePath(root, join(outside, "data.log"), rules({}))).toThrow(
      /outside the project root/,
    );
    const allowed = rules({ allow: [`Read(${outside}/**)`] });
    expect(confinePath(root, join(outside, "data.log"), allowed)).toBe(join(outside, "data.log"));
  });

  it("refuses files inside the root that a Read deny rule matches", () => {
    expect(() => confinePath(root, ".env", rules({ deny: ["Read(**/.env)"] }))).toThrow(
      /refused by permission rule Read\(\*\*\/\.env\) \(deny\)/,
    );
  });

  it("refuses a denied name before checking whether it exists", () => {
    expect(() => confinePath(root, "missing/.env", rules({ deny: ["Read(**/.env)"] }))).toThrow(
      /\(deny\)/,
    );
  });

  it("treats a Read ask rule as deny", () => {
    const r = rules({ ask: ["Read(**/secrets/**)"] });
    expect(() => confinePath(root, "secrets/key.pem", r)).toThrow(
      /refused by permission rule Read\(\*\*\/secrets\/\*\*\) \(ask\)/,
    );
  });

  it("lets a Read deny rule win over a Read allow rule", () => {
    const r = rules({ allow: [`Read(${outside}/**)`], deny: [`Read(${outside}/key.pem)`] });
    expect(() => confinePath(root, join(outside, "key.pem"), r)).toThrow(
      /refused by permission rule .* \(deny\)/,
    );
    expect(confinePath(root, join(outside, "data.log"), r)).toBe(join(outside, "data.log"));
  });

  it("matches deny rules on the requested path and on the symlink target", () => {
    const r = rules({ deny: ["Read(**/.env)"] });
    expect(() => confinePath(root, "notes.txt", r)).toThrow(/\(deny\)/);
    expect(() => confinePath(root, "linked/.env", r)).toThrow(/\(deny\)/);
  });

  it("resolves project-relative Read patterns against the root it confines to", () => {
    for (const rule of ["Read(./.env)", "Read(.env)", "Read(/.env)"]) {
      expect(() => confinePath(root, ".env", rules({ deny: [rule] })), rule).toThrow(/\(deny\)/);
      // A symlink whose target the rule names.
      expect(() => confinePath(root, "notes.txt", rules({ deny: [rule] })), rule).toThrow(
        /\(deny\)/,
      );
    }
    // A missing file is refused by its spelling before any stat.
    expect(() => confinePath(root, "missing/.env", rules({ deny: ["Read(.env)"] }))).toThrow(
      /\(deny\)/,
    );
    expect(() => confinePath(root, "secrets/key.pem", rules({ deny: ["Read(*.pem)"] }))).toThrow(
      /Read\(\*\.pem\) \(deny\)/,
    );
    expect(() => confinePath(root, "app.ts", rules({ ask: ["Read(./app.ts)"] }))).toThrow(
      /\(ask\)/,
    );
    // A relative rule does not reach a file of the same name elsewhere in the tree.
    expect(confinePath(root, "linked/.env", rules({ deny: ["Read(./.env)"] }))).toBe(
      join(root, "config.txt"),
    );
    // `//` opts an absolute path in, and the refusal names that form.
    expect(() => confinePath(root, join(outside, "data.log"), rules({}))).toThrow(
      `add a Read(/${join(outside, "data.log")}) rule`,
    );
    expect(
      confinePath(root, join(outside, "data.log"), rules({ allow: [`Read(/${outside}/**)`] })),
    ).toBe(join(outside, "data.log"));
  });

  const probe = mkdtempSync(join(tmpdir(), "em-case-"));
  writeFileSync(join(probe, "a"), "");
  it.runIf(existsSync(join(probe, "A")))(
    "matches deny rules on the on-disk name when the file system ignores case",
    () => {
      expect(() => confinePath(root, ".ENV", rules({ deny: ["Read(**/.env)"] }))).toThrow(
        /\(deny\)/,
      );
    },
  );
});

describe("em_index Read rules", () => {
  // Rules also come from ~/.claude/settings.json; keep the developer's own rules out of it.
  const home = process.env.HOME;
  const made: string[] = [];
  let ictx: ProjectContext;
  const textOf = (r: { content: Array<{ text: string }> }) =>
    r.content.map((c) => c.text).join("\n");
  beforeAll(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "em-index-read-")));
    const userHome = mkdtempSync(join(tmpdir(), "em-userhome-"));
    made.push(root, userHome);
    process.env.HOME = userHome;
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Read(**/creds.md)"], ask: ["Read(**/vault/**)"] } }),
    );
    mkdirSync(join(root, "notes", "vault"), { recursive: true });
    writeFileSync(join(root, "notes", "guide.md"), "# Guide\n\nOrdinary notes.\n");
    writeFileSync(join(root, "notes", "vault", "keys.md"), "# Keys\n\nhunter2\n");
    writeFileSync(join(root, "notes", "creds.md"), "# Creds\n\nSECRET=1\n");
    // A symlink with an innocent name: its target is what the rule matches.
    symlinkSync(join(root, "notes", "creds.md"), join(root, "notes", "link.md"));
    ictx = {
      root,
      id: "em-index-read",
      dbPath: join(process.env.EMINIAR_HOME!, "index-read.db"),
      config: ConfigSchema.parse({ embeddings: { enabled: false } }),
    };
  });
  afterAll(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it("refuses a file a Read deny or ask rule matches, like em_execute_file", async () => {
    const denied = await emIndex.handler({ path: "notes/creds.md" }, ictx);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/refused by permission rule Read\(\*\*\/creds\.md\) \(deny\)/);
    const viaLink = await emIndex.handler({ path: "notes/link.md" }, ictx);
    expect(viaLink.isError).toBe(true);
    const asked = await emIndex.handler({ path: "notes/vault/keys.md" }, ictx);
    expect(textOf(asked)).toMatch(/\(ask\)/);
  });

  it("indexes the rest of a directory and reports the files it skipped", async () => {
    const out = textOf(await emIndex.handler({ path: "notes", glob: ["**/*.md"] }, ictx));
    expect(out).toContain("1 indexed");
    expect(out).toMatch(/skipped notes\/creds\.md: refused by permission rule .* \(deny\)/);
    expect(out).toMatch(/skipped notes\/link\.md: refused by permission rule .* \(deny\)/);
    expect(out).toMatch(/skipped notes\/vault\/keys\.md: refused by permission rule .* \(ask\)/);
    const docs = getStorage(ictx)
      .documentsBySource("file")
      .map((d) => d.title);
    expect(docs).toEqual(["notes/guide.md"]);
  });

  it("project-relative rules from settings refuse em_execute_file and em_index alike, and drop an indexed file", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "em-rel-rules-")));
    made.push(root);
    mkdirSync(join(root, "keys"));
    writeFileSync(join(root, ".env"), "TOKEN=1\n");
    writeFileSync(join(root, "keys", "a.pem"), "k\n");
    writeFileSync(join(root, "keys", "notes.md"), "# Notes\n\nfine\n");
    const rctx: ProjectContext = { ...ictx, root, id: "em-rel-rules" };
    // Indexed while nothing denied it.
    await emIndex.handler({ path: "keys/notes.md" }, rctx);
    const uri = `file://${join(root, "keys", "notes.md")}`;
    expect(getStorage(rctx).findDocumentByUri(uri)).toBeDefined();
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Read(./.env)", "Read(*.pem)"], ask: ["Read(keys/notes.md)"] },
      }),
    );
    for (const [path, rule] of [
      [".env", "Read(./.env) (deny)"],
      ["keys/a.pem", "Read(*.pem) (deny)"],
      ["keys/notes.md", "Read(keys/notes.md) (ask)"],
    ] as const) {
      const ef = await emExecuteFile.handler({ path }, rctx);
      expect(ef.isError, path).toBe(true);
      expect(textOf(ef)).toContain(rule);
      const ix = await emIndex.handler({ path }, rctx);
      expect(ix.isError, path).toBe(true);
      expect(textOf(ix)).toContain(rule);
    }
    // The refused file left the index.
    expect(getStorage(rctx).findDocumentByUri(uri)).toBeUndefined();
  });
});
