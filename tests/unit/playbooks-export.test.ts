import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { exportSkill, schedulePrompt } from "../../src/playbooks/export.js";
import { reconcile, write } from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;
const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pbx-"));
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
  rmSync(join(root, ".gitignore"), { force: true });
  reconcile(ctx, db);
  db.playbooks.purgeActivity();
  write(ctx, db, {
    name: "review-prs",
    title: "Review open PRs",
    prompt: "Review PRs in {{repo}} on {{branch}}.",
    params: [{ name: "repo" }, { name: "branch", default: "main" }],
    schedule: "every weekday 9am",
  });
});

describe("exportSkill", () => {
  it("writes .claude/skills/<name>/SKILL.md with side-effect safety on by default", () => {
    const r = exportSkill(ctx, db, "review-prs", { allowedTools: ["Read", "Bash(git log:*)"] });
    expect(r.path).toBe(join(ctx.root, ".claude/skills/review-prs/SKILL.md"));
    const t = readFileSync(r.path, "utf8");
    expect(t).toMatch(/^---\nname: review-prs\n/);
    expect(t).toContain("disable-model-invocation: true");
    expect(t).toContain('allowed-tools: "Read, Bash(git log:*)"');
    expect(t).toContain("Review PRs in {{repo}} on main.");
    expect(t).toContain("$ARGUMENTS");
    expect(r.created).toBe(true);
  });

  it("omits disable-model-invocation for a read-only playbook and honours targetDir", () => {
    const r = exportSkill(ctx, db, "review-prs", { sideEffecting: false, targetDir: "out/skills" });
    expect(r.path).toBe(join(ctx.root, "out/skills/review-prs/SKILL.md"));
    expect(readFileSync(r.path, "utf8")).not.toContain("disable-model-invocation");
  });

  it("re-exports over its own file but refuses one it did not create", () => {
    exportSkill(ctx, db, "review-prs");
    expect(exportSkill(ctx, db, "review-prs").created).toBe(false);
    const p = join(root, ".claude/skills/review-prs/SKILL.md");
    writeFileSync(p, "---\nname: review-prs\n---\nhand written\n");
    expect(() => exportSkill(ctx, db, "review-prs")).toThrow(/not created by eminiar/);
    expect(readFileSync(p, "utf8")).toContain("hand written");
  });

  it("refuses a symlinked SKILL.md", () => {
    const dir = join(root, ".claude/skills/review-prs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "victim.md"), "x");
    symlinkSync(join(root, "victim.md"), join(dir, "SKILL.md"));
    expect(() => exportSkill(ctx, db, "review-prs")).toThrow(/not a regular file/);
    expect(readFileSync(join(root, "victim.md"), "utf8")).toBe("x");
  });

  it("rejects traversal in names and target directories", () => {
    for (const n of ["../x", "a/b", "..", ".hidden", "A", "a_b", "a--b"])
      expect(() => exportSkill(ctx, db, n)).toThrow();
    expect(() => exportSkill(ctx, db, "review-prs", { targetDir: "../out" })).toThrow(/inside/);
    expect(existsSync(join(root, "..", "out"))).toBe(false);
  });

  it("refuses a target that is a symlink out of the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "em-out-"));
    mkdirSync(join(root, ".claude"), { recursive: true });
    symlinkSync(outside, join(root, ".claude/skills"));
    expect(() => exportSkill(ctx, db, "review-prs")).toThrow(/outside the project/);
  });

  it("rejects bad allowed-tools entries", () => {
    expect(() => exportSkill(ctx, db, "review-prs", { allowedTools: ["a\nb"] })).toThrow();
    expect(() => exportSkill(ctx, db, "review-prs", { allowedTools: ["a, b"] })).toThrow();
  });

  it("masks secrets in the skill and the schedule prompt", () => {
    const r = exportSkill(ctx, db, "review-prs", { values: { repo: secret } });
    expect(r.content).not.toContain(secret);
    expect(schedulePrompt(ctx, db, "review-prs", { repo: secret })).not.toContain(secret);
  });

  it("errors on an unknown playbook", () => {
    expect(() => exportSkill(ctx, db, "nope")).toThrow(/no playbook/);
  });
});

describe("schedulePrompt", () => {
  it("is self-contained with the schedule hint and defaults filled", () => {
    const t = schedulePrompt(ctx, db, "review-prs", { repo: "rydn/eminiar" });
    expect(t).toContain("Scheduled task: Review open PRs");
    expect(t).toContain("Suggested schedule: every weekday 9am");
    expect(t).toContain("Review PRs in rydn/eminiar on main.");
  });
});
