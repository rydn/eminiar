import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/adjudicator/redact.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { parsePlaybookFile, serializePlaybookFile } from "../../src/playbooks/frontmatter.js";
import {
  acceptSuggestion,
  closeRun,
  dismissSuggestion,
  fillPrompt,
  isValidName,
  list,
  read,
  reconcile,
  recordRun,
  remove,
  rowParams,
  rowTags,
  runs,
  suggest,
  suggestions,
  write,
} from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { migrations } from "../../src/storage/sqlite/schema.js";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

const withPlaybooks = (over: Record<string, unknown>): ProjectContext => ({
  ...ctx,
  config: { ...ctx.config, playbooks: { ...ctx.config.playbooks, ...over } },
});

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pb-"));
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
  rmSync(join(root, ".gitignore"), { force: true });
  reconcile(ctx, db);
  db.playbooks.purgeActivity();
});

describe("playbook frontmatter", () => {
  it("round-trips values that would break the memory header format", () => {
    const meta = {
      name: "x",
      title: 'Check "PRs" # not a comment',
      params: ["repo", "channel=#eng, prs", "plain=ok"],
      schedule: "every weekday 9am",
      tags: ["a b", "c,d"],
      owner: "ryan",
    };
    const text = serializePlaybookFile(meta, "\nBody {{repo}}\n");
    const p = parsePlaybookFile(text);
    expect(p.hadFrontmatter).toBe(true);
    expect(p.meta).toEqual(meta);
    expect(p.body.trim()).toBe("Body {{repo}}");
  });

  it("strips comments outside quotes and ignores prototype keys", () => {
    const p = parsePlaybookFile(
      '---\nname: a   # why\ntitle: "x # y"   # c\n__proto__: [a]\nconstructor: b\ntags: [a, b] # t\n---\nbody',
    );
    expect(p.meta).toEqual({ name: "a", title: "x # y", tags: ["a", "b"] });
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it("never lets a newline in a value start a new header key", () => {
    const text = serializePlaybookFile({ name: "x", title: "a\nevil: 1" }, "b");
    const p = parsePlaybookFile(text);
    expect(p.meta.evil).toBeUndefined();
    expect(p.meta.title).toBe("a evil: 1");
  });
});

describe("playbooks config", () => {
  it("defaults: viewing and adding on, extraction off", () => {
    const c = ConfigSchema.parse({}).playbooks;
    expect(c).toEqual({
      dir: ".eminiar/playbooks",
      privateDir: ".eminiar/playbooks-private",
      viewing: true,
      adding: true,
      extraction: { enabled: false },
    });
  });

  it("refuses a directory that leaves the project", () => {
    const ok = (playbooks: object) => ConfigSchema.safeParse({ playbooks }).success;
    expect(ok({ dir: "notes/pb" })).toBe(true);
    for (const dir of ["/abs", "../pb", "a/../../pb"]) expect(ok({ dir }), dir).toBe(false);
    for (const privateDir of ["/abs", "../pb"]) expect(ok({ privateDir }), privateDir).toBe(false);
  });

  it("drops an unsafe project playbooks.dir and keeps the rest", () => {
    const r = mkdtempSync(join(tmpdir(), "em-pbcfg-"));
    writeFileSync(
      join(r, "eminiar.config.json"),
      JSON.stringify({
        playbooks: { dir: "../../x", privateDir: "/etc", adding: false },
      }),
    );
    const c = loadConfig(r).playbooks;
    expect([c.dir, c.privateDir, c.adding]).toEqual([
      ".eminiar/playbooks",
      ".eminiar/playbooks-private",
      false,
    ]);
  });
});

describe("migration 10", () => {
  it("is the newest version, after the shipped ones, and has unique versions", () => {
    const versions = migrations.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(versions.at(-1)).toBe(10);
  });

  it("creates the playbook tables", () => {
    const names = (
      (db as unknown as { db: import("better-sqlite3").Database }).db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'playbook%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names.sort()).toEqual(["playbook_runs", "playbook_suggestions", "playbooks"]);
  });
});

describe("playbook store", () => {
  it("validates names", () => {
    expect(isValidName("review-open-prs")).toBe(true);
    for (const n of ["Bad", "a/b", "../x", ".hidden", "", "a b", "x".repeat(65)])
      expect(isValidName(n), n).toBe(false);
    expect(() => write(ctx, db, { name: "../evil", title: "t", prompt: "p" })).toThrow(
      /invalid playbook name/,
    );
  });

  it("writes a file, mirrors it, and reads it back", () => {
    const r = write(ctx, db, {
      title: "Review open PRs",
      prompt: "Check {{channel}} for PRs and review them.",
      params: [{ name: "channel", default: "#eng-prs" }, { name: "repo" }],
      schedule: "every weekday 9am",
      tags: ["GitHub", "review", "github"],
    });
    expect(r.name).toBe("review-open-prs");
    expect(r.created).toBe(true);
    expect(r.path).toBe(".eminiar/playbooks/review-open-prs.md");
    const text = readFileSync(join(root, r.path), "utf8");
    expect(text).toContain("title: Review open PRs");
    expect(text).toContain('params: ["channel=#eng-prs", repo]');
    expect(text).toContain("schedule: every weekday 9am");
    const f = read(ctx, db, "review-open-prs")!;
    expect(f.params).toEqual([{ name: "channel", default: "#eng-prs" }, { name: "repo" }]);
    expect(f.tags).toEqual(["github", "review"]);
    expect(f.source).toBe("manual");
    expect(f.private).toBe(false);
    expect(f.schedule).toBe("every weekday 9am");
    expect(f.prompt).toBe("Check {{channel}} for PRs and review them.");
    expect(rowTags(f.row)).toEqual(["github", "review"]);
    expect(rowParams(f.row)).toHaveLength(2);
  });

  it("refuses to overwrite without replace, keeps the created date on replace", () => {
    const a = write(ctx, db, { name: "daily", title: "Daily", prompt: "one" });
    expect(() => write(ctx, db, { name: "daily", title: "Daily", prompt: "two" })).toThrow(
      /already exists/,
    );
    const created = read(ctx, db, "daily")!.created;
    const b = write(ctx, db, { name: "daily", title: "Daily", prompt: "two", replace: true });
    expect([a.created, b.created]).toEqual([true, false]);
    const f = read(ctx, db, "daily")!;
    expect(f.prompt).toBe("two");
    expect(f.created).toBe(created);
  });

  it("numbers an automatic name that is taken", () => {
    write(ctx, db, { title: "Check logs", prompt: "a" });
    expect(write(ctx, db, { title: "Check logs", prompt: "b" }).name).toBe("check-logs-2");
  });

  it("rejects bad input", () => {
    expect(() => write(ctx, db, { title: "  ", prompt: "p" })).toThrow(/title/);
    expect(() => write(ctx, db, { title: "t", prompt: " " })).toThrow(/prompt/);
    expect(() => write(ctx, db, { title: "t", prompt: "p", params: [{ name: "9x" }] })).toThrow(
      /parameter name/,
    );
  });

  it("masks secrets before saving, in the file and the mirror", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactSecrets(secret)).not.toBe(secret);
    const r = write(ctx, db, {
      title: `Deploy ${secret}`,
      prompt: `Use token ${secret} to call the API`,
      params: [{ name: "tok", default: secret }],
      schedule: secret,
      name: "deploy",
    });
    const text = readFileSync(join(root, r.path), "utf8");
    expect(text).not.toContain(secret);
    const row = db.playbooks.get("deploy")!;
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("masks a secret in a file that arrived by hand (the mirror, not the file)", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    writeFileSync(
      join(root, ".eminiar/playbooks/hand.md"),
      `---\ntitle: Hand\n---\nUse ${secret}\n`,
    );
    reconcile(ctx, db);
    expect(db.playbooks.get("hand")!.prompt).not.toContain(secret);
  });

  it("removes the file and the row", () => {
    const r = write(ctx, db, { name: "gone", title: "Gone", prompt: "x" });
    expect(remove(ctx, db, "gone")).toBe(true);
    expect(existsSync(join(root, r.path))).toBe(false);
    expect(db.playbooks.get("gone")).toBeUndefined();
    expect(remove(ctx, db, "gone")).toBe(false);
  });

  it("fills {{params}} from values, then defaults, and leaves gaps visible", () => {
    const f = {
      prompt: "{{a}} {{ b }} {{c}} {{d}}",
      params: [{ name: "a" }, { name: "b", default: "B" }],
    };
    expect(fillPrompt(f, { a: "A", __proto__: "x" } as Record<string, string>)).toBe(
      "A B {{c}} {{d}}",
    );
    expect(fillPrompt(f, { b: "z" })).toBe("{{a}} z {{c}} {{d}}");
  });
});

describe("private playbooks", () => {
  it("go to the private folder and get it ignored before the first write", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/");
    const r = write(ctx, db, { name: "mine", title: "Mine", prompt: "secret plan", private: true });
    expect(r.path).toBe(".eminiar/playbooks-private/mine.md");
    expect(existsSync(join(root, ".eminiar/playbooks/mine.md"))).toBe(false);
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignore.split("\n")).toContain(".eminiar/playbooks-private/");
    expect(ignore.startsWith("node_modules/\n")).toBe(true);
    expect(read(ctx, db, "mine")!.private).toBe(true);
    expect(list(ctx, db, { includePrivate: false }).map((x) => x.name)).not.toContain("mine");
    expect(list(ctx, db).map((x) => x.name)).toContain("mine");
    // a second private write does not add the line again
    write(ctx, db, { name: "mine2", title: "M2", prompt: "x", private: true });
    expect(readFileSync(join(root, ".gitignore"), "utf8").match(/playbooks-private/g)).toHaveLength(
      1,
    );
  });

  it("do not duplicate an ignore line that already covers the folder", () => {
    writeFileSync(join(root, ".gitignore"), "/.eminiar/playbooks-private\n");
    write(ctx, db, { name: "p", title: "P", prompt: "x", private: true });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe("/.eminiar/playbooks-private\n");
  });

  it("move between folders on replace, so a name lives in one place", () => {
    write(ctx, db, { name: "mv", title: "Mv", prompt: "x" });
    write(ctx, db, { name: "mv", title: "Mv", prompt: "x", private: true, replace: true });
    expect(existsSync(join(root, ".eminiar/playbooks/mv.md"))).toBe(false);
    expect(existsSync(join(root, ".eminiar/playbooks-private/mv.md"))).toBe(true);
    expect(db.playbooks.get("mv")!.private).toBe(1);
  });

  it("refuse a private folder inside the committed one", () => {
    const bad = withPlaybooks({ privateDir: ".eminiar/playbooks/private" });
    expect(() => write(bad, db, { title: "t", prompt: "p", private: true })).toThrow(
      /must not be playbooks.dir/,
    );
  });
});

describe("path safety", () => {
  it("refuses a playbook file that is a link, and a folder that leads out of the project", () => {
    const outside = mkdtempSync(join(tmpdir(), "em-out-"));
    writeFileSync(join(outside, "x.md"), "---\ntitle: X\n---\nsecret");
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    symlinkSync(join(outside, "x.md"), join(root, ".eminiar/playbooks/linked.md"));
    const s = reconcile(ctx, db);
    expect(s.skipped).toContain(".eminiar/playbooks/linked.md");
    expect(db.playbooks.get("linked")).toBeUndefined();
    expect(() => read(ctx, db, "linked")).toThrow(/link|leaves the project/);
    expect(() =>
      write(ctx, db, { name: "linked", title: "t", prompt: "p", replace: true }),
    ).toThrow(/link|leaves the project/);
    expect(readFileSync(join(outside, "x.md"), "utf8")).toContain("secret");

    rmSync(join(root, ".eminiar/playbooks"), { recursive: true });
    symlinkSync(outside, join(root, ".eminiar/playbooks"));
    expect(() => write(ctx, db, { name: "p", title: "t", prompt: "p" })).toThrow(
      /leaves the project/,
    );
    expect(existsSync(join(outside, "p.md"))).toBe(false);
    expect(reconcile(ctx, db).skipped).toContain(".eminiar/playbooks");
  });
});

describe("reconcile", () => {
  it("imports hand-written files, picks up edits, forgets deleted files", () => {
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    const file = join(root, ".eminiar/playbooks/hand.md");
    writeFileSync(file, "---\ntitle: Hand made\ntags: [x]\nsource: suggested\n---\n\nDo it\n");
    writeFileSync(join(root, ".eminiar/playbooks/Bad Name.md"), "x");
    writeFileSync(join(root, ".eminiar/playbooks/notes.txt"), "x");
    let s = reconcile(ctx, db);
    expect(s).toMatchObject({ files: 1, synced: 1, removed: 0 });
    expect(s.skipped).toEqual([".eminiar/playbooks/Bad Name.md"]);
    const f = read(ctx, db, "hand")!;
    expect([f.title, f.prompt, f.source, f.tags]).toEqual([
      "Hand made",
      "Do it",
      "suggested",
      ["x"],
    ]);

    s = reconcile(ctx, db);
    expect(s.synced).toBe(0);

    writeFileSync(file, "---\ntitle: Edited\n---\nNew body\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(reconcile(ctx, db).synced).toBe(1);
    expect(read(ctx, db, "hand")!.title).toBe("Edited");

    rmSync(file);
    expect(reconcile(ctx, db).removed).toBe(1);
    expect(db.playbooks.get("hand")).toBeUndefined();
  });

  it("falls back to the file name for a title and tolerates a missing header", () => {
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    writeFileSync(join(root, ".eminiar/playbooks/bare.md"), "Just a prompt\n");
    reconcile(ctx, db);
    const f = read(ctx, db, "bare")!;
    expect([f.title, f.prompt]).toEqual(["bare", "Just a prompt"]);
  });

  it("keeps the public file when a name exists in both folders", () => {
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    mkdirSync(join(root, ".eminiar/playbooks-private"), { recursive: true });
    writeFileSync(join(root, ".eminiar/playbooks/dup.md"), "public\n");
    writeFileSync(join(root, ".eminiar/playbooks-private/dup.md"), "private\n");
    const s = reconcile(ctx, db);
    expect(s.skipped).toEqual([".eminiar/playbooks-private/dup.md"]);
    expect(db.playbooks.get("dup")!.prompt).toBe("public");
  });
});

describe("runs", () => {
  it("records runs with a masked note and summarises them", () => {
    write(ctx, db, { name: "pr", title: "PR", prompt: "x" });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    recordRun(ctx, db, {
      playbook: "pr",
      trigger: "mcp",
      sessionId: "s1",
      status: "done",
      note: `ok ${secret}\nline2`,
    });
    recordRun(ctx, db, { playbook: "pr", trigger: "ui" });
    const rows = runs(ctx, db, { playbook: "pr" });
    expect(rows.map((r) => [r.trigger, r.status])).toEqual([
      ["ui", "started"],
      ["mcp", "done"],
    ]);
    expect(rows[1]!.note).not.toContain(secret);
    expect(rows[1]!.note).not.toContain("\n");
    expect(rows[1]!.session_id).toBe("s1");
    expect(db.playbooks.runStats().get("pr")!.runs).toBe(2);
    expect(() => recordRun(ctx, db, { playbook: "pr", trigger: "x" as never })).toThrow(/trigger/);
    expect(() =>
      recordRun(ctx, db, { playbook: "pr", trigger: "cli", status: "x" as never }),
    ).toThrow(/status/);
    expect(() => recordRun(ctx, db, { playbook: "nope", trigger: "cli" })).toThrow(/no playbook/);
  });

  it("closeRun updates the started row in place and never reopens or rewrites a closed one", () => {
    write(ctx, db, { name: "cl", title: "CL", prompt: "x" });
    const { id } = recordRun(ctx, db, { playbook: "cl", trigger: "mcp", status: "started" });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(
      closeRun(ctx, db, { playbook: "cl", runId: id, status: "done", note: `ok ${secret}` }),
    ).toEqual({ id });
    const rows = runs(ctx, db, { playbook: "cl" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
    expect(rows[0]!.note).not.toContain(secret);
    expect(() => closeRun(ctx, db, { playbook: "cl", runId: id, status: "failed" })).toThrow(
      /already done/,
    );
    expect(() => closeRun(ctx, db, { playbook: "cl", runId: 9999, status: "done" })).toThrow(
      /no run/,
    );
    expect(() => closeRun(ctx, db, { playbook: "cl", status: "done" })).toThrow(/no started run/);
    expect(() => closeRun(ctx, db, { playbook: "cl", runId: id, status: "started" })).toThrow(
      /status/,
    );
    // a run id of another playbook is not found under this name
    write(ctx, db, { name: "cl2", title: "CL2", prompt: "x" });
    const other = recordRun(ctx, db, { playbook: "cl2", trigger: "cli" }).id;
    expect(() => closeRun(ctx, db, { playbook: "cl", runId: other, status: "done" })).toThrow(
      /no run/,
    );
    // the store refuses to touch a closed run too, and keeps a note when none is given
    expect(db.playbooks.runSetStatus(id, "failed", "x")).toBe(false);
    expect(db.playbooks.runSetStatus(other, "skipped")).toBe(true);
    expect(db.playbooks.runSetStatus(other, "done")).toBe(false);
  });
});

describe("suggestions", () => {
  const on = () => withPlaybooks({ extraction: { enabled: true } });

  it("are refused while extraction is off", () => {
    expect(() => suggest(ctx, db, { title: "t", prompt: "p" })).toThrow(/extraction/);
  });

  it("store one per task, then accept or dismiss", () => {
    const c = on();
    const a = suggest(c, db, {
      title: "Check Datadog",
      prompt: "Look at   Datadog monitors",
      evidence: "seen 4 times",
    });
    const dup = suggest(c, db, { title: "Other title", prompt: "look at datadog MONITORS" });
    expect([a.created, dup.created, dup.id]).toEqual([true, false, a.id]);
    expect(suggestions(c, db, { status: "pending" })).toHaveLength(1);

    const acc = acceptSuggestion(c, db, a.id);
    expect(acc.name).toBe("check-datadog");
    const f = read(c, db, "check-datadog")!;
    expect(f.source).toBe("suggested");
    expect(suggestions(c, db, { status: "accepted" })[0]!.playbook).toBe("check-datadog");
    expect(() => acceptSuggestion(c, db, a.id)).toThrow(/already accepted/);
    // seen again after acceptance: still one row
    expect(suggest(c, db, { title: "x", prompt: "Look at Datadog monitors" }).created).toBe(false);

    const b = suggest(c, db, { title: "Check Datadog", prompt: "a different prompt" });
    const acc2 = acceptSuggestion(c, db, b.id);
    expect(acc2.name).toBe("check-datadog-2");
    expect(read(c, db, "check-datadog")!.prompt).toBe("Look at   Datadog monitors");
    expect(read(c, db, "check-datadog-2")!.prompt).toBe("a different prompt");

    const d = suggest(c, db, { title: "Third", prompt: "third thing" });
    expect(dismissSuggestion(c, db, d.id)).toBe(true);
    expect(dismissSuggestion(c, db, d.id)).toBe(false);
    expect(suggestions(c, db, { status: "dismissed" })).toHaveLength(1);
    expect(() => acceptSuggestion(c, db, 9999)).toThrow(/no suggestion/);
  });

  it("mask the evidence and the prompt", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const c = on();
    const { id } = suggest(c, db, { title: "t", prompt: `use ${secret}`, evidence: secret });
    expect(JSON.stringify(db.playbooks.suggestionGet(id))).not.toContain(secret);
  });
});

describe("config gates", () => {
  it("playbooks.adding false blocks writes, removals and suggestion changes", () => {
    write(ctx, db, { name: "keep", title: "Keep", prompt: "x" });
    const ro = withPlaybooks({ adding: false });
    expect(() => write(ro, db, { title: "t", prompt: "p" })).toThrow(/adding/);
    expect(() => remove(ro, db, "keep")).toThrow(/adding/);
    expect(() => acceptSuggestion(ro, db, 1)).toThrow(/adding/);
    expect(() => dismissSuggestion(ro, db, 1)).toThrow(/adding/);
    expect(read(ro, db, "keep")!.title).toBe("Keep");
  });

  it("playbooks.viewing false blocks reads", () => {
    const hidden = withPlaybooks({ viewing: false });
    expect(() => read(hidden, db, "x")).toThrow(/viewing/);
    expect(() => list(hidden, db)).toThrow(/viewing/);
    expect(() => runs(hidden, db)).toThrow(/viewing/);
    expect(() => suggestions(hidden, db)).toThrow(/viewing/);
  });
});

describe("purge", () => {
  it("clears runs and suggestions with sessions, the mirror with memories, never the files", () => {
    const c = withPlaybooks({ extraction: { enabled: true } });
    const w = write(c, db, { name: "p", title: "P", prompt: "x" });
    recordRun(c, db, { playbook: "p", trigger: "cli" });
    suggest(c, db, { title: "s", prompt: "something" });
    db.purge("sessions");
    expect(db.playbooks.runs()).toHaveLength(0);
    expect(db.playbooks.suggestions()).toHaveLength(0);
    expect(db.playbooks.get("p")).toBeDefined();
    db.purge("memories");
    expect(db.playbooks.count()).toBe(0);
    expect(lstatSync(join(root, w.path)).isFile()).toBe(true);
    expect(reconcile(c, db).synced).toBe(1);
  });
});
