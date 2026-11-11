import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { impact } from "../../src/graph/query.js";
import { persist } from "../../src/hooks/capture.js";
import { handlers } from "../../src/hooks/index.js";
import { parseMemoryFile, serializeMemoryFile } from "../../src/memory/frontmatter.js";
import {
  autoName,
  edit,
  isValidName,
  list,
  memoryLinks,
  read,
  reconcile,
  relatedTarget,
  remove,
  rename,
  write,
} from "../../src/memory/store.js";
import { search } from "../../src/search/pipeline.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emExecute } from "../../src/tools/em_execute.js";
import { emMemory } from "../../src/tools/em_memory.js";
import { emPurge } from "../../src/tools/em_purge.js";
import { emRecall } from "../../src/tools/em_recall.js";
import { emRemember } from "../../src/tools/em_remember.js";
import { deleteMemory, memoryBody, setMemoryStatus, updateMemory } from "../../src/ui/api.js";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;
const file = (name: string) => join(root, ".eminiar", "memories", `${name}.md`);
const textOf = (r: { content: Array<{ text: string }>; isError?: boolean }) =>
  r.content.map((c) => c.text).join("\n");

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-mem-"));
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

describe("frontmatter", () => {
  it("parses scalars, lists, comments and unknown keys, and round-trips", () => {
    const text = `---
name: auth/session-tokens
kind: decision   # why not
tags: [auth, "security"]
related: []
owner: ryan
created: 2026-10-13T15:00:00Z
updated: 2026-10-13T15:04:11Z
---

Body line one.
`;
    const p = parseMemoryFile(text);
    expect(p.hadFrontmatter).toBe(true);
    expect(p.meta.name).toBe("auth/session-tokens");
    expect(p.meta.kind).toBe("decision");
    expect(p.meta.tags).toEqual(["auth", "security"]);
    expect(p.meta.related).toEqual([]);
    expect(p.meta.owner).toBe("ryan");
    expect(p.body.trim()).toBe("Body line one.");
    const out = serializeMemoryFile(p.meta, p.body);
    expect(out).toContain("name: auth/session-tokens\nkind: decision\ntags: [auth, security]");
    expect(out).toContain("owner: ryan");
    expect(parseMemoryFile(out).body).toBe(p.body);
    expect(parseMemoryFile("no header here").hadFrontmatter).toBe(false);
  });
});

describe("memory store", () => {
  it("validates and derives names", () => {
    expect(isValidName("auth/session-tokens")).toBe(true);
    expect(isValidName("note")).toBe(true);
    expect(isValidName("Bad Name")).toBe(false);
    expect(isValidName("a/b/c")).toBe(false);
    expect(autoName(db, "decision", "We use Vitest, not Jest!")).toBe(
      "decision/we-use-vitest-not-jest",
    );
    expect(() => write(ctx, db, { name: "Bad Name", kind: "note", content: "x" })).toThrow(
      /invalid memory name/,
    );
  });

  it("writes a file and mirrors it into the index and the graph", () => {
    const r = write(ctx, db, {
      name: "auth/session-tokens",
      kind: "decision",
      content: "Tokens rotate every fifteen minutes because refresh is cheap.",
      tags: ["auth"],
      related: ["file:./src/auth.ts", "sym:src/auth.ts#issueToken"],
    });
    expect(r.created).toBe(true);
    expect(r.path).toBe(".eminiar/memories/auth/session-tokens.md");
    const text = readFileSync(file("auth/session-tokens"), "utf8");
    expect(text).toMatch(/^---\nname: auth\/session-tokens\nkind: decision\ntags: \[auth\]\n/);
    expect(text).toContain("related: [file:src/auth.ts, sym:src/auth.ts#issueToken]");
    expect(text.trim().endsWith("refresh is cheap.")).toBe(true);
    const row = db.memoryGetByName("auth/session-tokens")!;
    expect(row.kind).toBe("decision");
    expect(row.path).toBe(r.path);
    expect(db.findDocumentByUri("memory:auth/session-tokens")).toBeDefined();
    expect(db.graphGetNode("memory:auth/session-tokens")?.kind).toBe("memory");
    const edges = db.graphEdgesFrom(["memory:auth/session-tokens"], ["mentions"]);
    expect(edges.map((e) => e.dst).sort()).toEqual([
      "file:src/auth.ts",
      "sym:src/auth.ts#issueToken",
    ]);
  });

  it("is searchable and refuses to overwrite unless asked", async () => {
    const hits = await search(db, "tokens rotate", {
      mode: "lexical",
      filters: { source: "memory" },
    });
    expect(hits.hits[0]?.chunk.document.uri).toBe("memory:auth/session-tokens");
    expect(() =>
      write(ctx, db, { name: "auth/session-tokens", kind: "decision", content: "other" }),
    ).toThrow(/already exists/);
    const created = parseMemoryFile(readFileSync(file("auth/session-tokens"), "utf8")).meta.created;
    const r = write(ctx, db, {
      name: "auth/session-tokens",
      kind: "decision",
      content: "Tokens rotate every fifteen minutes because refresh is cheap. Rotation is logged.",
      tags: ["auth"],
      related: ["file:src/auth.ts", "sym:src/auth.ts#issueToken"],
      replace: true,
    });
    expect(r.created).toBe(false);
    expect(parseMemoryFile(readFileSync(file("auth/session-tokens"), "utf8")).meta.created).toBe(
      created,
    );
  });

  it("re-imports files edited by hand", async () => {
    const f = file("auth/session-tokens");
    writeFileSync(f, `${readFileSync(f, "utf8")}\nHand-edited: the zebra clause.\n`);
    const s = reconcile(ctx, db);
    expect(s.synced).toBe(1);
    expect(read(ctx, db, "auth/session-tokens")?.body).toContain("zebra clause");
    expect(db.memoryGetByName("auth/session-tokens")?.content).toContain("zebra clause");
    const hits = await search(db, "zebra", { mode: "lexical", filters: { source: "memory" } });
    expect(hits.hits.length).toBe(1);
    expect(reconcile(ctx, db).synced).toBe(0);
  });

  it("repairs a missing header and lets the path win over the header's name", () => {
    mkdirSync(join(root, ".eminiar", "memories", "notes"), { recursive: true });
    writeFileSync(file("notes/raw"), "Just a note without a header.\n");
    writeFileSync(
      file("notes/moved"),
      "---\nname: notes/old-name\nkind: fact\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n\nMoved by mv.\n",
    );
    const s = reconcile(ctx, db);
    expect(s.synced).toBe(2);
    const raw = parseMemoryFile(readFileSync(file("notes/raw"), "utf8"));
    expect(raw.meta.name).toBe("notes/raw");
    expect(raw.meta.kind).toBe("note");
    expect(raw.body.trim()).toBe("Just a note without a header.");
    expect(parseMemoryFile(readFileSync(file("notes/moved"), "utf8")).meta.name).toBe(
      "notes/moved",
    );
    expect(db.memoryGetByName("notes/moved")?.kind).toBe("fact");
    expect(db.memoryGetByName("notes/old-name")).toBeUndefined();
  });

  it("forgets memories whose file was deleted", () => {
    unlinkSync(file("notes/raw"));
    const s = reconcile(ctx, db);
    expect(s.removed).toBe(1);
    expect(db.memoryGetByName("notes/raw")).toBeUndefined();
    expect(db.findDocumentByUri("memory:notes/raw")).toBeUndefined();
    expect(db.graphGetNode("memory:notes/raw")).toBeUndefined();
  });

  it("edits the body only and renames with mem: references following", () => {
    write(ctx, db, { name: "a/one", kind: "note", content: "See mem:a/two for the follow-up." });
    write(ctx, db, { name: "a/two", kind: "todo", content: "Follow-up item alpha." });
    expect(edit(ctx, db, "a/two", { find: "alpha", replace: "beta" })).toBe(1);
    expect(edit(ctx, db, "a/two", { find: "nothing-here", replace: "x" })).toBe(0);
    expect(read(ctx, db, "a/two")?.body).toBe("Follow-up item beta.");
    expect(parseMemoryFile(readFileSync(file("a/two"), "utf8")).meta.kind).toBe("todo");

    const r = rename(ctx, db, "a/two", "b/two");
    expect(r.refsUpdated).toBe(1);
    expect(existsSync(file("a/two"))).toBe(false);
    expect(read(ctx, db, "a/one")?.body).toContain("mem:b/two");
    expect(db.memoryGetByName("a/two")).toBeUndefined();
    expect(db.graphGetNode("memory:a/two")).toBeUndefined();
    expect(db.graphGetNode("memory:b/two")).toBeDefined();
    expect(parseMemoryFile(readFileSync(file("b/two"), "utf8")).meta.name).toBe("b/two");
  });

  it("migrates legacy database-only rows into files once", () => {
    const id = db.memoryInsert({ kind: "fact", content: "Legacy row content", tags: ["x"] });
    const s = reconcile(ctx, db);
    expect(s.migrated).toBe(1);
    expect(existsSync(file("fact/legacy-row-content"))).toBe(true);
    expect(db.memoryLegacyRows()).toEqual([]);
    expect(db.memoryGetByName("fact/legacy-row-content")?.tags).toBe('["x"]');
    expect(reconcile(ctx, db).migrated).toBe(0);
    // a second legacy row with the same text gets the row id as a suffix
    const id2 = db.memoryInsert({ kind: "fact", content: "Legacy row content" });
    expect(reconcile(ctx, db).migrated).toBe(1);
    expect(existsSync(file(`fact/legacy-row-content-${id2}`))).toBe(true);
    void id;
  });

  it("surfaces memories in impact analysis via mentions edges", () => {
    db.graphUpsertNodes([
      {
        id: "file:src/auth.ts",
        kind: "file",
        name: "src/auth.ts",
        path: "src/auth.ts",
        source: "curated",
      },
    ]);
    const r = impact(db, "src/auth.ts")!;
    const hit = r.hits.find((h) => h.id === "memory:auth/session-tokens");
    expect(hit).toBeDefined();
    expect(hit!.reasons[0]).toMatch(/^memory mentions/);
  });

  it("lists onboarding memories first and removes files on delete", () => {
    write(ctx, db, { name: "onboarding/commands", kind: "onboarding", content: "npm test" });
    expect(list(ctx, db)[0]?.name).toBe("onboarding/commands");
    expect(list(ctx, db, { topic: "a" }).map((m) => m.name)).toEqual(["a/one"]);
    expect(remove(ctx, db, "onboarding/commands")).toBe(true);
    expect(existsSync(file("onboarding/commands"))).toBe(false);
    expect(remove(ctx, db, "onboarding/commands")).toBe(false);
  });
});

describe("memory tools", () => {
  it("em_remember auto-names, em_recall finds, em_memory manages", async () => {
    const r1 = textOf(
      await emRemember.handler({ content: "We use vitest for tests", kind: "decision" }, ctx),
    );
    expect(r1).toContain(
      "remembered decision/we-use-vitest-for-tests (decision) → .eminiar/memories/decision/we-use-vitest-for-tests.md",
    );
    const r2 = textOf(
      await emRemember.handler({ content: "We use vitest for tests", kind: "decision" }, ctx),
    );
    expect(r2).toContain("decision/we-use-vitest-for-tests-2");
    const dup = await emRemember.handler(
      { content: "x".repeat(10), kind: "note", name: "decision/we-use-vitest-for-tests" },
      ctx,
    );
    expect(dup.isError).toBe(true);

    const recall = textOf(await emRecall.handler({ query: "vitest" }, ctx));
    expect(recall).toContain("decision/we-use-vitest-for-tests [decision]");
    const listed = textOf(await emRecall.handler({}, ctx));
    expect(listed).toContain("decision/we-use-vitest-for-tests");

    const readOut = textOf(
      await emMemory.handler({ action: "read", name: "decision/we-use-vitest-for-tests" }, ctx),
    );
    expect(readOut).toContain("[decision]");
    expect(readOut).toContain("We use vitest for tests");
    const refused = await emMemory.handler(
      { action: "delete", name: "decision/we-use-vitest-for-tests-2" },
      ctx,
    );
    expect(refused.isError).toBe(true);
    const deleted = textOf(
      await emMemory.handler(
        { action: "delete", name: "decision/we-use-vitest-for-tests-2", confirm: true },
        ctx,
      ),
    );
    expect(deleted).toContain("deleted");
    expect(existsSync(file("decision/we-use-vitest-for-tests-2"))).toBe(false);
    const edited = textOf(
      await emMemory.handler(
        {
          action: "edit",
          name: "decision/we-use-vitest-for-tests",
          find: "vitest",
          replace: "Vitest",
        },
        ctx,
      ),
    );
    expect(edited).toContain("replaced 1");
    const listOut = textOf(await emMemory.handler({ action: "list", topic: "decision" }, ctx));
    expect(listOut).toContain("decision/we-use-vitest-for-tests [decision]");
    expect(listOut).toContain("We use Vitest for tests");
  });

  it("em_purge memories keeps the files, which reconcile re-imports", async () => {
    const before = db.memoryCount();
    expect(before).toBeGreaterThan(0);
    const out = textOf(await emPurge.handler({ scope: "memories", confirm: true }, ctx));
    expect(out).toContain("left in place");
    expect(db.memoryCount()).toBe(0);
    expect(db.countDocuments("memory")).toBe(0);
    expect(db.graphGetNode("memory:auth/session-tokens")).toBeUndefined();
    reconcile(ctx, db);
    expect(db.memoryCount()).toBe(before);
    expect(db.graphGetNode("memory:auth/session-tokens")).toBeDefined();
  });

  it("keeps a failed command's error text in session history with its secrets masked", async () => {
    const token = "ghp_Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8";
    const input = { language: "shell", code: `echo "fatal: auth GH_TOKEN=${token}" >&2; exit 2` };
    const reply = await emExecute.handler(input, ctx);
    expect(reply.isError).toBe(true);
    await handlers.PostToolUse?.({
      session_id: "s-err",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "mcp__plugin_eminiar_eminiar__em_execute",
      tool_input: input,
      tool_response: reply,
    });
    const recalled = textOf(await emRecall.handler({ query: "fatal auth" }, ctx));
    expect(recalled).toContain("[session error]");
    expect(recalled).toContain("GH_TOKEN=***");
    expect(
      (await search(db, "Q1w2E3r4T5y6U7i8", { mode: "lexical", filters: { source: "session" } }))
        .hits,
    ).toHaveLength(0);

    // a failed native Bash call: its command line is stored with the error, masked too
    await handlers.PostToolUse?.({
      session_id: "s-err",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: `curl -fsS -H "Authorization: Bearer ${token}" https://x.invalid` },
      tool_response: { exit_code: 6, stdout: "", stderr: "curl: (6) Could not resolve host" },
    });
    const bash = textOf(await emRecall.handler({ query: "resolve host" }, ctx));
    expect(bash).toContain("Authorization: Bearer ***");
    expect(
      (await search(db, "Q1w2E3r4T5y6U7i8", { mode: "lexical", filters: { source: "session" } }))
        .hits,
    ).toHaveLength(0);
  }, 30_000);

  it("em_purge sessions also drops the session history em_recall returns", async () => {
    persist(db, "s-purge", [
      {
        sessionId: "s-purge",
        category: "constraint",
        priority: 2,
        payload: { text: "never deploy the zebrafish service on a Friday" },
      },
    ]);
    const recall = async () => textOf(await emRecall.handler({ query: "zebrafish deploy" }, ctx));
    expect(await recall()).toContain("[session constraint]");
    const memories = db.countDocuments("memory");
    await emPurge.handler({ scope: "sessions", confirm: true }, ctx);
    expect(await recall()).not.toContain("[session");
    expect(db.countDocuments("session")).toBe(0);
    // memories are not session data
    expect(db.countDocuments("memory")).toBe(memories);
  });
});

describe("memory links in the graph", () => {
  it("maps related mem: ids to memory: nodes", () => {
    expect(relatedTarget("mem:auth/tokens")).toBe("memory:auth/tokens");
    expect(relatedTarget("file:src/a.ts")).toBe("file:src/a.ts");
    expect(relatedTarget("memory:x")).toBe("memory:x");
  });

  it("finds mem: links in a body, bare, in backticks and as link targets", () => {
    const body =
      "See mem:links/target. Also `mem:links/other` and [why](mem:links/third), " +
      "not xmem:links/no or mem:Bad/Name, and mem:links/self again.";
    expect(memoryLinks(body, "links/self")).toEqual(["links/target", "links/other", "links/third"]);
  });

  it("writes mentions edges to memory: nodes and links edges for body references", () => {
    write(ctx, db, { name: "links/target", kind: "fact", content: "The target." });
    write(ctx, db, {
      name: "links/source",
      kind: "decision",
      content: "Builds on mem:links/target and mem:links/missing.",
      related: ["mem:links/target", "file:src/a.ts"],
      tags: ["graph"],
    });
    const out = db.graphEdgesFrom(["memory:links/source"]);
    const by = (kind: string) =>
      out
        .filter((e) => e.kind === kind)
        .map((e) => e.dst)
        .sort();
    expect(by("mentions")).toEqual(["file:src/a.ts", "memory:links/target"]);
    expect(by("links")).toEqual(["memory:links/missing", "memory:links/target"]);
    // the file keeps the reader's mem: spelling
    expect(readFileSync(file("links/source"), "utf8")).toContain("mem:links/target");
    expect(db.graphDanglingEdges("memory:").map((e) => e.dst)).toEqual(["memory:links/missing"]);
  });

  it("follows a rename: references are rewritten and the edges point at the new node", () => {
    rename(ctx, db, "links/target", "links/renamed");
    const out = db.graphEdgesFrom(["memory:links/source"]).map((e) => `${e.kind} ${e.dst}`);
    expect(out).toContain("links memory:links/renamed");
    expect(out).toContain("mentions memory:links/renamed");
    expect(out).not.toContain("links memory:links/target");
  });
});

describe("memory frontmatter prototype keys (#62)", () => {
  it("skips __proto__, constructor and prototype keys", () => {
    const { meta } = parseMemoryFile(
      "---\n__proto__: [a, b]\nconstructor: x\nprototype: y\nkind: note\n---\nbody\n",
    );
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect(Object.keys(meta)).toEqual(["kind"]);
    expect((meta as Record<string, unknown>)[0]).toBeUndefined();
  });
});

describe("memory names from callers are checked before any file is touched", () => {
  // relOf joins the name into the path: this one is <root>/victim.md, outside the memories dir.
  const name = "../../victim";
  const victim = () => join(root, "victim.md");
  const untouched = () => expect(readFileSync(victim(), "utf8")).toBe("keep me\n");
  beforeEach(() => writeFileSync(victim(), "keep me\n"));

  it("read and edit refuse the name instead of repairing the file's header", async () => {
    expect(() => read(ctx, db, name)).toThrow(/invalid memory name/);
    expect(() => memoryBody(ctx, name)).toThrow(/invalid memory name/);
    expect(() => edit(ctx, db, name, { find: "keep", replace: "lose" })).toThrow(
      /invalid memory name/,
    );
    const r = await emMemory.handler({ action: "read", name }, ctx);
    expect([r.isError, textOf(r)]).toEqual([true, expect.stringMatching(/invalid memory name/)]);
    untouched();
    expect(db.memoryGetByName(name)).toBeUndefined();
  });

  it("status, rename and delete refuse it from the tool and the dashboard", async () => {
    const status = await emMemory.handler({ action: "status", name, status: "deprecated" }, ctx);
    expect(status.isError).toBe(true);
    expect(() => setMemoryStatus(ctx, name, "deprecated")).toThrow(/invalid memory name/);
    untouched();
    expect(() => rename(ctx, db, name, "note/moved")).toThrow(/invalid memory name/);
    expect(existsSync(file("note/moved"))).toBe(false);
    untouched();
    const del = await emMemory.handler({ action: "delete", name, confirm: true }, ctx);
    expect(del.isError).toBe(true);
    expect(() => deleteMemory(ctx, name)).toThrow(/invalid memory name/);
    expect(() => remove(ctx, db, name)).toThrow(/invalid memory name/);
    untouched();
  });

  it("em_remember keeps a bad supersedes as written but never touches it as a file", async () => {
    const r = await emRemember.handler(
      { content: "Replaces the victim", kind: "decision", name: "decision/new", supersedes: name },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).not.toContain("marked superseded");
    expect(read(ctx, db, "decision/new")?.supersedes).toBe(name);
    untouched();
    // An invalid name inside the memories folder is stored the same way, not a late throw.
    const upper = await emRemember.handler(
      {
        content: "Replaces nothing",
        kind: "decision",
        name: "decision/upper",
        supersedes: "Not A Name",
      },
      ctx,
    );
    expect(upper.isError).toBeFalsy();
  });

  it("a mem: supersedes marks its target once; later edits of the newer memory leave it alone", () => {
    write(ctx, db, { name: "decision/older", kind: "decision", content: "The older way." });
    const r = write(ctx, db, {
      name: "decision/newer",
      kind: "decision",
      content: "The new way.",
      supersedes: "mem:decision/older",
    });
    expect(r.superseded).toBe("decision/older");
    expect(read(ctx, db, "decision/older")?.status).toBe("superseded");
    // The dashboard passes the header's `mem:` value back on every edit (it used to throw).
    const before = readFileSync(file("decision/older"), "utf8");
    updateMemory(ctx, "decision/newer", { content: "The new way, edited." });
    updateMemory(ctx, "decision/newer", { content: "The new way, edited again." });
    expect(readFileSync(file("decision/older"), "utf8")).toBe(before);
    setMemoryStatus(ctx, "decision/older", "accepted");
    expect(
      updateMemory(ctx, "decision/newer", { content: "Third edit." }).superseded,
    ).toBeUndefined();
    expect(read(ctx, db, "decision/older")?.status).toBe("accepted");
    // The same name without its prefix is not a change either.
    updateMemory(ctx, "decision/newer", { content: "Fourth edit.", supersedes: "decision/older" });
    expect(read(ctx, db, "decision/older")?.status).toBe("accepted");
    expect(read(ctx, db, "decision/newer")?.supersedes).toBe("decision/older");
  });
});

describe("memory files outside the project", () => {
  const made: string[] = [];
  const tmp = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    made.push(d);
    return d;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    resetContextCache();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  // A header-less file with a valid name: reconcile would add frontmatter to it.
  const outsideNotes = () => {
    const notes = tmp("em-mem-notes-");
    mkdirSync(join(notes, "topic"));
    writeFileSync(join(notes, "topic", "page.md"), "personal notes\n");
    return notes;
  };
  const projectAt = (config?: unknown) => {
    const project = tmp("em-mem-proj-");
    writeFileSync(join(project, "package.json"), "{}");
    if (config) writeFileSync(join(project, "eminiar.config.json"), JSON.stringify(config));
    return project;
  };

  it("a project memories.dir outside the project is ignored", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const notes = outsideNotes();
    // Both are made in tmpdir(), so this climbs from the project to the notes.
    const project = projectAt({ memories: { dir: `../${basename(notes)}` } });
    resetContextCache();
    const c = getContext(project);
    expect(c.config.memories.dir).toBe(".eminiar/memories");
    expect(reconcile(c, getStorage(c)).files).toBe(0);
    expect(readFileSync(join(notes, "topic", "page.md"), "utf8")).toBe("personal notes\n");
  });

  it("a memories.dir spelled in another case than the folder on disk keeps working", () => {
    // On a case-insensitive filesystem (macOS, Windows) `Memories` is the folder `memories`;
    // elsewhere it is simply a new folder. Either way writes and reads must succeed.
    const project = projectAt({ memories: { dir: ".eminiar/Memories" } });
    mkdirSync(join(project, ".eminiar", "memories"), { recursive: true });
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    write(c, cdb, { name: "topic/page", kind: "fact", content: "Cased folder note." });
    expect(read(c, cdb, "topic/page")?.body).toContain("Cased folder note.");
    expect(reconcile(c, cdb).skipped).toEqual([]);
    expect(cdb.memoryGetByName("topic/page")).toBeDefined();
  });

  it("reconcile lists a linked memories folder or topic that leads out once, untouched", () => {
    for (const link of [".eminiar/memories", ".eminiar/memories/topic"]) {
      const notes = outsideNotes();
      const project = projectAt();
      mkdirSync(join(project, link, ".."), { recursive: true });
      symlinkSync(link.endsWith("topic") ? join(notes, "topic") : notes, join(project, link));
      resetContextCache();
      const c = getContext(project);
      const summary = reconcile(c, getStorage(c));
      expect([summary.files, summary.skipped], link).toEqual([0, [link]]);
      expect(readFileSync(join(notes, "topic", "page.md"), "utf8")).toBe("personal notes\n");
      expect(getStorage(c).memoryGetByName("topic/page")).toBeUndefined();
    }
  });

  it("reconcile never walks a topic linked to a big folder outside", () => {
    const outside = tmp("em-mem-big-");
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(outside, `d${i}`, "deeper"), { recursive: true });
      writeFileSync(join(outside, `d${i}`, "deeper", "x.md"), "x\n");
      writeFileSync(join(outside, `f${i}.md`), "f\n");
    }
    const project = projectAt();
    mkdirSync(join(project, ".eminiar", "memories"), { recursive: true });
    symlinkSync(outside, join(project, ".eminiar", "memories", "x"));
    resetContextCache();
    const c = getContext(project);
    expect(reconcile(c, getStorage(c)).skipped).toEqual([".eminiar/memories/x"]);
    // A link nested below a topic is read one level deep only, never all the way down.
    mkdirSync(join(project, ".eminiar", "memories", "topic"));
    symlinkSync(outside, join(project, ".eminiar", "memories", "topic", "sub"));
    const nested = reconcile(c, getStorage(c)).skipped;
    expect(nested.filter((p) => p.includes("/deeper/"))).toEqual([]);
    expect(nested).toContain(".eminiar/memories/topic/sub/f0.md");
  });

  it("refuses topic and file links to other project files (CLAUDE.md, src/)", () => {
    const project = projectAt();
    const mem = join(project, ".eminiar", "memories");
    mkdirSync(join(mem, "topic"), { recursive: true });
    mkdirSync(join(mem, "other"), { recursive: true });
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "CLAUDE.md"), "# Project rules\n");
    writeFileSync(join(project, "src", "notes.md"), "source notes\n");
    writeFileSync(join(mem, "other", "real.md"), "A memory reached by two names.\n");
    symlinkSync(join(project, "CLAUDE.md"), join(mem, "rules.md"));
    symlinkSync(join(project, "CLAUDE.md"), join(mem, "topic", "claude.md"));
    symlinkSync(join(project, "src"), join(mem, "code"));
    symlinkSync(join(mem, "other", "real.md"), join(mem, "topic", "alias.md"));
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    const summary = reconcile(c, cdb);
    expect(summary.skipped.sort()).toEqual([
      ".eminiar/memories/code",
      ".eminiar/memories/rules.md",
      ".eminiar/memories/topic/claude.md",
    ]);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("# Project rules\n");
    expect(readFileSync(join(project, "src", "notes.md"), "utf8")).toBe("source notes\n");
    expect(() => read(c, cdb, "code/notes")).toThrow(/outside the memories folder/);
    // A file link that stays in the memories folder is a memory like any other.
    expect(cdb.memoryGetByName("topic/alias")).toBeDefined();
  });

  it("named calls refuse a memory a committed symlink leads out of the project", async () => {
    const notes = outsideNotes();
    const project = projectAt();
    mkdirSync(join(project, ".eminiar"));
    symlinkSync(notes, join(project, ".eminiar", "memories"));
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    const refused = /is dangling or outside the memories folder/;
    expect(() => read(c, cdb, "topic/page")).toThrow(refused);
    expect(() => edit(c, cdb, "topic/page", { find: "personal", replace: "lost" })).toThrow(
      refused,
    );
    expect(() =>
      write(c, cdb, { name: "topic/page", kind: "note", content: "overwritten", replace: true }),
    ).toThrow(refused);
    expect(() => write(c, cdb, { name: "topic/new", kind: "note", content: "new file" })).toThrow(
      refused,
    );
    const r = await emMemory.handler({ action: "delete", name: "topic/page", confirm: true }, c);
    expect([r.isError, textOf(r)]).toEqual([true, expect.stringMatching(refused)]);
    expect(readFileSync(join(notes, "topic", "page.md"), "utf8")).toBe("personal notes\n");
    expect(existsSync(join(notes, "topic", "new.md"))).toBe(false);
  });

  it("write quietly skips marking a supersedes target that is outside the memories folder", () => {
    const notes = outsideNotes();
    const project = projectAt();
    mkdirSync(join(project, ".eminiar", "memories"), { recursive: true });
    symlinkSync(join(notes, "topic"), join(project, ".eminiar", "memories", "topic"));
    resetContextCache();
    const c = getContext(project);
    const r = write(c, getStorage(c), {
      name: "decision/new",
      kind: "decision",
      content: "Replaces a page behind a link.",
      supersedes: "topic/page",
    });
    expect([r.created, r.superseded]).toEqual([true, undefined]);
    expect(readFileSync(join(notes, "topic", "page.md"), "utf8")).toBe("personal notes\n");
  });

  it("rename into a topic folder that is a symlink out of the project is refused by the folder check", () => {
    const notes = outsideNotes();
    const project = projectAt();
    mkdirSync(join(project, ".eminiar", "memories"), { recursive: true });
    symlinkSync(join(notes, "topic"), join(project, ".eminiar", "memories", "linked"));
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    write(c, cdb, { name: "plain/page", kind: "note", content: "Stays in the project." });
    // "linked/moved" is a valid name; only the on-disk folder is wrong.
    expect(isValidName("linked/moved")).toBe(true);
    expect(() => rename(c, cdb, "plain/page", "linked/moved")).toThrow(
      /is dangling or outside the memories folder/,
    );
    expect(existsSync(join(notes, "topic", "moved.md"))).toBe(false);
    expect(existsSync(join(project, ".eminiar", "memories", "plain", "page.md"))).toBe(true);
    expect(cdb.memoryGetByName("plain/page")).toBeDefined();
    expect(readFileSync(join(notes, "topic", "page.md"), "utf8")).toBe("personal notes\n");
  });

  it("legacy rows are not migrated through a link out of the memories folder", () => {
    const notes = outsideNotes();
    const project = projectAt();
    mkdirSync(join(project, ".eminiar", "memories"), { recursive: true });
    mkdirSync(join(notes, "fact"));
    symlinkSync(join(notes, "fact"), join(project, ".eminiar", "memories", "fact"));
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    cdb.memoryInsert({ kind: "fact", content: "Legacy row behind a link" });
    const summary = reconcile(c, cdb);
    expect(summary.migrated).toBe(0);
    expect(summary.skipped).toContain(".eminiar/memories/fact/legacy-row-behind-a-link.md");
    expect(existsSync(join(notes, "fact", "legacy-row-behind-a-link.md"))).toBe(false);
    expect(cdb.memoryLegacyRows()).toHaveLength(1);
  });

  it("rename does not rewrite a referring file that became a link out of the project", () => {
    const notes = outsideNotes();
    const project = projectAt();
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    write(c, cdb, { name: "notes/old", kind: "note", content: "The old one." });
    write(c, cdb, { name: "notes/refers", kind: "note", content: "See mem:notes/old." });
    const victim = join(notes, "topic", "refers.md");
    writeFileSync(victim, "outside text naming mem:notes/old\n");
    const refers = join(project, ".eminiar", "memories", "notes", "refers.md");
    unlinkSync(refers);
    symlinkSync(victim, refers);
    expect(rename(c, cdb, "notes/old", "notes/renamed").refsUpdated).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("outside text naming mem:notes/old\n");
  });

  it("a memories folder linked elsewhere inside the project keeps working", () => {
    const project = projectAt();
    mkdirSync(join(project, "team", "memories"), { recursive: true });
    mkdirSync(join(project, ".eminiar"));
    symlinkSync(join(project, "team", "memories"), join(project, ".eminiar", "memories"));
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    write(c, cdb, { name: "topic/shared", kind: "fact", content: "Kept in the team folder." });
    expect(existsSync(join(project, "team", "memories", "topic", "shared.md"))).toBe(true);
    expect(reconcile(c, cdb).removed).toBe(0);
    expect(read(c, cdb, "topic/shared")?.body).toBe("Kept in the team folder.");
  });

  it("a memories folder that leads out for a moment keeps its rows instead of forgetting them", () => {
    const project = projectAt();
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    write(c, cdb, { name: "topic/keep", kind: "decision", content: "Important decision." });
    const dir = join(project, ".eminiar", "memories");
    const moved = `${dir}.bak`;
    renameSync(dir, moved);
    // Out of the project, then a dangling link: refused, nothing read, nothing forgotten.
    for (const target of [tmp("em-mem-away-"), join(project, "nowhere")]) {
      symlinkSync(target, dir);
      const r = reconcile(c, cdb);
      expect([r.removed, r.skipped], target).toEqual([0, [".eminiar/memories"]]);
      expect(cdb.memoryGetByName("topic/keep"), target).toBeDefined();
      unlinkSync(dir);
    }
    renameSync(moved, dir);
    expect(reconcile(c, cdb).removed).toBe(0);
    // A folder that is really gone still forgets its memories.
    rmSync(dir, { recursive: true });
    expect(reconcile(c, cdb).removed).toBe(1);
    expect(cdb.memoryGetByName("topic/keep")).toBeUndefined();
  });

  it("reconcile reports a dangling memory link, and remove unlinks it without touching a target", () => {
    const project = projectAt();
    const dir = join(project, ".eminiar", "memories");
    mkdirSync(join(dir, "t"), { recursive: true });
    symlinkSync(join(project, "missing.md"), join(dir, "t", "dang.md"));
    resetContextCache();
    const c = getContext(project);
    const cdb = getStorage(c);
    expect(reconcile(c, cdb).skipped).toEqual([".eminiar/memories/t/dang.md"]);
    expect(remove(c, cdb, "t/dang")).toBe(true);
    expect(lstatSync(join(dir, "t", "dang.md"), { throwIfNoEntry: false })).toBeUndefined();
    expect(reconcile(c, cdb).skipped).toEqual([]);
    // A link that resolves outside, or one in a topic folder linked out, is still refused.
    const notes = outsideNotes();
    symlinkSync(join(notes, "topic", "page.md"), join(dir, "t", "out.md"));
    expect(() => remove(c, cdb, "t/out")).toThrow(/outside the memories folder/);
    expect(readFileSync(join(notes, "topic", "page.md"), "utf8")).toBe("personal notes\n");
    symlinkSync(notes, join(dir, "away"));
    symlinkSync(join(notes, "gone.md"), join(notes, "dead.md"));
    expect(() => remove(c, cdb, "away/dead")).toThrow(/outside the memories folder/);
    expect(lstatSync(join(notes, "dead.md")).isSymbolicLink()).toBe(true);
  });
});
