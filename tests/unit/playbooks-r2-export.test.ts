import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { playbookCommand } from "../../src/playbooks/cli.js";
import { exportMarkdown, exportSkill, schedulePrompt } from "../../src/playbooks/export.js";
import { PlaybookGateError, read, suggest, write } from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emPlaybook } from "../../src/tools/em_playbook.js";

/** Round 2 fixes to the skill export (swarm run 20261111-e068a8, tasks #262 #267 #274 #268). */

let root: string;
let outside: string;
let ctx: ProjectContext;
let db: StorageAdapter;
let home: string;
const savedHome = process.env.EMINIAR_HOME;
const savedEmb = process.env.EMINIAR_EMBEDDINGS;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "em-r2-home-"));
  process.env.EMINIAR_HOME = home;
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = realpathSync(mkdtempSync(join(tmpdir(), "em-r2-root-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "em-r2-out-")));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".git"));
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
  write(ctx, db, { name: "pub", title: "Pub", prompt: "do the thing" });
});

afterAll(() => {
  closeAllStorage();
  for (const d of [root, outside, home]) rmSync(d, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = savedHome;
  if (savedEmb === undefined) delete process.env.EMINIAR_EMBEDDINGS;
  else process.env.EMINIAR_EMBEDDINGS = savedEmb;
});

describe("#262 export survives a symlink swap of the target", () => {
  it("never writes outside the project while the target flips to a symlink", async () => {
    const racer = new Worker(
      `
const { symlinkSync, unlinkSync, rmSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { t, out } = workerData;
const end = Date.now() + 6000;
while (Date.now() < end) {
  try { rmSync(t, { recursive: true, force: true }); } catch {}
  try { symlinkSync(out, t); } catch {}
  for (let i = 0; i < 200; i++);
  try { unlinkSync(t); } catch {}
  for (let i = 0; i < 50; i++);
}`,
      { eval: true, workerData: { t: join(root, "t"), out: outside } },
    );
    let tries = 0;
    const end = Date.now() + 5000;
    while (Date.now() < end && tries < 5000) {
      tries++;
      try {
        exportSkill(ctx, db, "pub", { targetDir: "t" });
      } catch {
        /* refusals are fine */
      }
      if (existsSync(join(outside, "pub", "SKILL.md"))) break;
    }
    await racer.terminate();
    expect(existsSync(join(outside, "pub", "SKILL.md"))).toBe(false);
    expect(tries).toBeGreaterThan(100);
  }, 20_000);
});

describe("#267 playbooks.adding off refuses export skill only", () => {
  const off = (): ProjectContext => ({
    ...ctx,
    config: { ...ctx.config, playbooks: { ...ctx.config.playbooks, adding: false } },
  });

  it("refuses with the gate error naming playbooks.adding and writes nothing", () => {
    let err: unknown;
    try {
      exportSkill(off(), db, "pub", { targetDir: "gated" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlaybookGateError);
    expect((err as PlaybookGateError).key).toBe("playbooks.adding");
    expect((err as Error).message).toContain("playbooks.adding");
    expect(existsSync(join(root, "gated"))).toBe(false);
  });

  it("keeps markdown and schedule exports working", () => {
    const f = read(off(), db, "pub");
    expect(f).toBeTruthy();
    expect(exportMarkdown(f as NonNullable<typeof f>)).toContain("do the thing");
    expect(schedulePrompt(off(), db, "pub")).toContain("do the thing");
  });
});

describe("#274 the schedule instruction carries the run_id", () => {
  it("tells the job to report with the run_id its own run call returned", async () => {
    write(ctx, db, { name: "daily", title: "Daily", prompt: "check", schedule: "every day" });
    const r = await emPlaybook.handler({ action: "schedule", name: "daily" }, ctx);
    const t = r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(t).toMatch(/run_id/);
    expect(t).toMatch(/run_id[^.]*(returns|returned)/i);
    expect(t).toMatch(/no run_id|without a run_id|have no/i);
  });
});

describe("#268 small text fixes", () => {
  it("dismiss does not promise 'not proposed again' without the purge caveat", async () => {
    const c: ProjectContext = {
      ...ctx,
      config: {
        ...ctx.config,
        playbooks: { ...ctx.config.playbooks, extraction: { enabled: true } },
      },
    };
    const { id } = suggest(c, db, { title: "Dismiss me", prompt: "a task to dismiss" });
    const r = await emPlaybook.handler({ action: "dismiss", id }, c);
    const t = r.content.map((x) => ("text" in x ? x.text : "")).join("\n");
    expect(t).toContain("em_purge sessions");
    expect(t).not.toMatch(/will not be proposed again(?! until)/);
  });

  it("playbook help --json prints JSON", async () => {
    const out: string[] = [];
    const code = await playbookCommand(["help", "--json"], ctx, {
      out: (s) => out.push(s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n")).usage).toContain("eminiar playbook");
  });
});
