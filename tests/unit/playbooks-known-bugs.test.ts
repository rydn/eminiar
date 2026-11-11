import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { exportSkill } from "../../src/playbooks/export.js";
import { isCodeHeavy, scan } from "../../src/playbooks/extract.js";
import { parsePlaybookFile } from "../../src/playbooks/frontmatter.js";
import { closeRun, read, reconcile, recordRun, write } from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { playbooksRoute } from "../../src/ui/playbooks-api.js";

/**
 * Defects in the playbook code that the tester found (swarm run 20261111-e068a8, task #148).
 * Each test states the CORRECT behaviour and is marked `it.fails`: the suite stays green while
 * the defect exists, and the test goes red the moment someone fixes it. To close one, fix the
 * code, then change `it.fails` to `it`. Nothing here weakens a check: the assertions are what
 * the feature promises (README of src/playbooks/store.ts, export.ts, extract.ts).
 */

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5, 9);
const SLACK = "mcp__claude_ai_Slack__slack_read_channel";

const on = (): ProjectContext => ({
  ...ctx,
  config: { ...ctx.config, playbooks: { ...ctx.config.playbooks, extraction: { enabled: true } } },
});
const call = (c: ProjectContext, path: string, body: unknown = {}, method = "POST") =>
  playbooksRoute(c, { path, method, query: new URLSearchParams(), body: async () => body });

function recurring(prompt: string): void {
  [0, 1, 2].forEach((d, i) => {
    const ts = T0 + d * DAY;
    db.eventInsert({
      sessionId: `k${i}`,
      ts,
      category: "user_prompt",
      priority: 1,
      payload: { text: prompt },
    });
    db.eventInsert({
      sessionId: `k${i}`,
      ts: ts + 1000,
      category: "mcp_tool",
      priority: 3,
      tool: SLACK,
      payload: { tool: SLACK },
    });
  });
}

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pbbug-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});
beforeEach(() => {
  rmSync(join(root, ".eminiar"), { recursive: true, force: true });
  rmSync(join(root, ".claude"), { recursive: true, force: true });
  rmSync(join(root, ".gitignore"), { recursive: true, force: true });
  reconcile(ctx, db);
  db.purge("sessions"); // events, runs and suggestions
});

describe("known defects (flip it.fails to it when fixed)", () => {
  // src/playbooks/extract.ts toCandidate: the title is built from lowercased, split tokens and
  // masked only afterwards, so a secret repeated in the prompts survives in the title, and the
  // title becomes the suggestion name (the file name once accepted).
  for (const secret of [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "password=hunter2secret",
  ]) {
    it.fails(`a secret repeated in recurring prompts never reaches the title or name (${secret.slice(0, 6)})`, async () => {
      recurring(`Check Slack for pull requests token ${secret} and review`);
      await scan(on(), db, { embeddings: false });
      const rows = db.playbooks.suggestions();
      expect(rows).toHaveLength(1);
      const body = secret.replace(/^[a-z]+[_=]/i, "").toLowerCase();
      for (const r of rows) {
        expect(`${r.title} | ${r.name}`.toLowerCase()).not.toContain(body);
      }
    });
  }

  // src/playbooks/frontmatter.ts parsePlaybookFile: the header's last line keeps its "\r" in a
  // CRLF file and then fails the `key: value` pattern, so the last key is dropped silently.
  it.fails("a CRLF playbook file keeps every header key", () => {
    const p = parsePlaybookFile("---\r\ntitle: T\r\ntags: [a]\r\n---\r\nbody\r\n");
    expect(p.meta).toEqual({ title: "T", tags: ["a"] });
  });

  // src/playbooks/frontmatter.ts parsePlaybookFile: a UTF-8 byte order mark before the opening
  // --- hides the header, so the header lines become the prompt.
  it.fails("a byte order mark before the header does not turn the header into prompt text", () => {
    const p = parsePlaybookFile("﻿---\ntitle: T\n---\nbody\n");
    expect(p.meta).toEqual({ title: "T" });
    expect(p.body.trim()).toBe("body");
  });

  // src/playbooks/export.ts exportSkill: only the target directory is checked for leaving the
  // project; <target>/<name> may be a link out, and SKILL.md is then written there.
  it.fails("export refuses to write through a <name> folder that links out of the project", () => {
    write(ctx, db, { name: "exp", title: "E", prompt: "x" });
    const outside = mkdtempSync(join(tmpdir(), "em-out-"));
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    symlinkSync(outside, join(root, ".claude/skills/exp"));
    expect(() => exportSkill(ctx, db, "exp")).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  // src/playbooks/export.ts exportSkill: the "made by eminiar" check is `includes(marker)`
  // anywhere in the file, so a hand-written skill that merely mentions the marker is replaced.
  it.fails("export does not overwrite a skill that only mentions the marker in its text", () => {
    write(ctx, db, { name: "exp", title: "E", prompt: "x" });
    mkdirSync(join(root, ".claude/skills/exp"), { recursive: true });
    const p = join(root, ".claude/skills/exp/SKILL.md");
    const mine =
      "---\nname: exp\n---\nMine. eminiar writes <!-- eminiar:playbook-export at the top of its files.\n";
    writeFileSync(p, mine);
    expect(() => exportSkill(ctx, db, "exp")).toThrow();
    expect(readFileSync(p, "utf8")).toBe(mine);
  });

  // src/playbooks/store.ts closeRun: the run is looked up in the newest 1000 runs of the
  // playbook, so an older run that is still started cannot be closed by its id.
  it.fails("a started run can be closed by id however many runs came after it", () => {
    write(ctx, db, { name: "many", title: "M", prompt: "x" });
    const first = recordRun(ctx, db, { playbook: "many", trigger: "cli" }).id;
    for (let i = 0; i < 1001; i++)
      db.playbooks.runAdd({
        playbook: "many",
        trigger: "cli",
        status: "done",
        ts: Date.now() + 1000 + i,
      });
    expect(closeRun(ctx, db, { playbook: "many", runId: first, status: "done" })).toEqual({
      id: first,
    });
  });

  // src/ui/playbooks-api.ts /api/playbooks/save: `private: b.private === true`, so an edit
  // (replace) that leaves `private` out moves a private playbook into the committed folder. The
  // CLI and the MCP tool keep the playbook where it is.
  it.fails("saving over a private playbook without a private flag keeps it private", async () => {
    write(ctx, db, { name: "priv", title: "P", prompt: "x", private: true });
    const r = await call(ctx, "/api/playbooks/save", {
      name: "priv",
      title: "P",
      prompt: "edited",
      replace: true,
    });
    expect(r.status).toBe(200);
    expect(existsSync(join(root, ".eminiar/playbooks/priv.md"))).toBe(false);
    expect(existsSync(join(root, ".eminiar/playbooks-private/priv.md"))).toBe(true);
  });

  // src/ui/playbooks-api.ts accept/dismiss: `Number(b.id)` turns null, "" and [] into 0 and
  // true into 1, so those pass the integer check.
  it.fails("accept and dismiss reject an id that is not a number", async () => {
    for (const path of ["/api/playbooks/suggestion/accept", "/api/playbooks/suggestion/dismiss"])
      for (const bad of [{ id: null }, { id: "" }, { id: true }, { id: [] }])
        expect([path, JSON.stringify(bad), (await call(on(), path, bad)).status]).toEqual([
          path,
          JSON.stringify(bad),
          400,
        ]);
  });

  // src/ui/playbooks-api.ts playbooksOverview: run counts are tallied from the newest 200 runs
  // of all playbooks, so a busy playbook hides another's history. `runStats()` has the totals
  // and is not used.
  it.fails("the dashboard run count of a playbook is its total, not its share of the newest 200 runs", async () => {
    write(ctx, db, { name: "old", title: "Old", prompt: "x" });
    write(ctx, db, { name: "busy", title: "Busy", prompt: "y" });
    const t = Date.now();
    for (let i = 0; i < 100; i++)
      db.playbooks.runAdd({ playbook: "old", trigger: "ui", status: "done", ts: t + i });
    for (let i = 0; i < 150; i++)
      db.playbooks.runAdd({ playbook: "busy", trigger: "ui", status: "done", ts: t + 1000 + i });
    const o = (await call(ctx, "/api/playbooks", {}, "GET")).body as {
      playbooks: Array<{ name: string; runs: number }>;
    };
    expect(o.playbooks.find((p) => p.name === "old")?.runs).toBe(100);
    expect(o.playbooks.find((p) => p.name === "busy")?.runs).toBe(150);
  });

  // src/playbooks/store.ts clean: tags are free text but are not masked like the title,
  // prompt and schedule are.
  it.fails("a secret in a tag is masked before it is saved", () => {
    write(ctx, db, { name: "tagged", title: "T", prompt: "x", tags: [SECRET] });
    expect(readFileSync(join(root, ".eminiar/playbooks/tagged.md"), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify(read(ctx, db, "tagged"))).not.toContain(SECRET);
  });

  // src/playbooks/extract.ts loadItems: whitespace is collapsed by stripEnvelope before
  // isCodeHeavy runs, so its stack-trace rule (which needs line starts) can never match.
  it.fails("a pasted stack trace is left out of the mining", async () => {
    const trace = "why does slack time out\n    at run (index.js:10:5)\n    at main (index.js:2:1)";
    expect(isCodeHeavy(trace)).toBe(true); // the rule itself works on raw text
    recurring(trace);
    const r = await scan(on(), db, { embeddings: false, dryRun: true });
    expect(r.candidates).toHaveLength(0);
  });
});
