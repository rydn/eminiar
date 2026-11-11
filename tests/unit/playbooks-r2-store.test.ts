import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { playbookCommand } from "../../src/playbooks/cli.js";
import {
  acceptSuggestion,
  list,
  playbooksRel,
  privatePlaybooksRel,
  read,
  reconcile,
  removeReport,
  suggest,
  write,
} from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emPlaybook } from "../../src/tools/em_playbook.js";
import { playbooksRoute } from "../../src/ui/playbooks-api.js";

/**
 * Round 2 review of the playbook store (swarm run 20261111-e068a8): accepting a suggestion claims
 * it before any file is written (#269); deleting a private playbook says which committed one it
 * uncovers, and the CLI marks a hidden name (#272).
 */

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

const on = (): ProjectContext => ({
  ...ctx,
  config: { ...ctx.config, playbooks: { ...ctx.config.playbooks, extraction: { enabled: true } } },
});

const fileOf = (name: string): string => join(root, playbooksRel(ctx), `${name}.md`);

/** A db whose playbook store runs `hook` once, right after the first call of `method`. */
function hooked(
  method: "suggestionSetStatus" | "upsert",
  hook: (result: unknown) => void,
): StorageAdapter {
  const pb = Object.create(db.playbooks) as StorageAdapter["playbooks"];
  let fired = false;
  // biome-ignore lint/suspicious/noExplicitAny: test double over one method
  (pb as any)[method] = (...args: unknown[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: test double over one method
    const r = (db.playbooks as any)[method](...args);
    if (!fired) {
      fired = true;
      hook(r);
    }
    return r;
  };
  const d = Object.create(db) as StorageAdapter;
  Object.defineProperty(d, "playbooks", { value: pb });
  return d;
}

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pbr2-"));
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

const SUGG = { name: "review-prs", title: "Review PRs", prompt: "Review the open pull requests" };

describe("#269 accepting a suggestion claims it before writing the playbook", () => {
  it("a second accept that runs before the first one claims leaves one playbook, never none", () => {
    const { id } = suggest(on(), db, SUGG);
    let inner: unknown;
    // B runs completely while A is about to claim: A's claim must fail and write nothing
    const dbA = Object.create(db) as StorageAdapter;
    const pb = Object.create(db.playbooks) as StorageAdapter["playbooks"];
    let fired = false;
    pb.suggestionSetStatus = (...args) => {
      if (!fired) {
        fired = true;
        inner = acceptSuggestion(on(), db, id);
      }
      return db.playbooks.suggestionSetStatus(...args);
    };
    Object.defineProperty(dbA, "playbooks", { value: pb });
    expect(() => acceptSuggestion(on(), dbA, id)).toThrow(/already accepted/);
    expect(inner).toEqual({ name: "review-prs", path: `${playbooksRel(ctx)}/review-prs.md` });
    const row = db.playbooks.suggestionGet(id)!;
    expect(row.status).toBe("accepted");
    expect(row.playbook).toBe("review-prs");
    expect(existsSync(fileOf("review-prs"))).toBe(true);
    reconcile(ctx, db);
    expect(list(ctx, db).map((r) => r.name)).toEqual(["review-prs"]);
  });

  it("a second accept between the first one's claim and its write leaves one playbook", () => {
    const { id } = suggest(on(), db, SUGG);
    let inner: unknown;
    const dbA = hooked("suggestionSetStatus", (claimed) => {
      expect(claimed).toBe(true);
      // the suggestion is accepted and its file is not there yet: B re-creates it
      inner = acceptSuggestion(on(), db, id);
    });
    const a = acceptSuggestion(on(), dbA, id);
    expect(inner).toMatchObject({ name: "review-prs" });
    expect(a).toMatchObject({ name: "review-prs" });
    expect(db.playbooks.suggestionGet(id)).toMatchObject({
      status: "accepted",
      playbook: "review-prs",
    });
    expect(existsSync(fileOf("review-prs"))).toBe(true);
    reconcile(ctx, db);
    expect(list(ctx, db).map((r) => r.name)).toEqual(["review-prs"]);
  });

  it("a playbook written under the claimed name in the window is never overwritten or deleted", () => {
    const { id } = suggest(on(), db, SUGG);
    const dbA = hooked("suggestionSetStatus", () => {
      write(ctx, db, { name: "review-prs", title: "Mine", prompt: "my own steps" });
    });
    const a = acceptSuggestion(on(), dbA, id);
    // the name was chosen by accept, so it moves on to a free one
    expect(a.name).toBe("review-prs-2");
    expect(readFileSync(fileOf("review-prs"), "utf8")).toContain("my own steps");
    expect(readFileSync(fileOf("review-prs-2"), "utf8")).toContain("Review the open pull requests");
    expect(db.playbooks.suggestionGet(id)).toMatchObject({
      status: "accepted",
      playbook: "review-prs-2",
    });
  });

  it("a file that appears after the existence check is not replaced (exclusive create)", () => {
    const { id } = suggest(on(), db, SUGG);
    const pb = Object.create(db.playbooks) as StorageAdapter["playbooks"];
    let calls = 0;
    pb.get = (n: string) => {
      // get #4 for the name is write's `prev` lookup: past the existence check, before the file
      if (n === "review-prs" && ++calls === 4) {
        mkdirSync(join(root, playbooksRel(ctx)), { recursive: true });
        writeFileSync(fileOf("review-prs"), "---\nname: review-prs\ntitle: Raced\n---\n\nraced\n");
      }
      return db.playbooks.get(n);
    };
    const dbA = Object.create(db) as StorageAdapter;
    Object.defineProperty(dbA, "playbooks", { value: pb });
    const a = acceptSuggestion(on(), dbA, id);
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(a.name).toBe("review-prs-2");
    expect(readFileSync(fileOf("review-prs"), "utf8")).toContain("raced");
    expect(db.playbooks.suggestionGet(id)?.playbook).toBe("review-prs-2");
  });

  it("a name the caller chose and lost in the window is an error, and the suggestion is pending again", () => {
    const { id } = suggest(on(), db, SUGG);
    const dbA = hooked("suggestionSetStatus", () => {
      write(ctx, db, { name: "mine", title: "Mine", prompt: "my own steps" });
    });
    expect(() => acceptSuggestion(on(), dbA, id, { name: "mine" })).toThrow(/already exists/);
    expect(readFileSync(fileOf("mine"), "utf8")).toContain("my own steps");
    expect(db.playbooks.suggestionGet(id)).toMatchObject({ status: "pending", playbook: null });
    // and it can be accepted again
    expect(acceptSuggestion(on(), db, id).name).toBe("review-prs");
  });

  it("a failure after the file was written removes only this call's file and releases the claim", () => {
    const { id } = suggest(on(), db, SUGG);
    const dbA = hooked("upsert", () => {
      throw new Error("disk full");
    });
    expect(() => acceptSuggestion(on(), dbA, id)).toThrow(/disk full/);
    expect(existsSync(fileOf("review-prs"))).toBe(false);
    expect(db.playbooks.suggestionGet(id)?.status).toBe("pending");
  });

  it("that cleanup leaves a file another writer put in its place", () => {
    const { id } = suggest(on(), db, SUGG);
    const dbA = hooked("upsert", () => {
      // another writer replaces the file (a new inode) before ours fails
      const tmp = `${fileOf("review-prs")}.other`;
      writeFileSync(tmp, "---\nname: review-prs\ntitle: Other\n---\n\nother steps\n");
      renameSync(tmp, fileOf("review-prs"));
      throw new Error("disk full");
    });
    expect(() => acceptSuggestion(on(), dbA, id)).toThrow(/disk full/);
    expect(readFileSync(fileOf("review-prs"), "utf8")).toContain("other steps");
  });

  it("the rollback leaves a suggestion another accept claimed meanwhile", () => {
    const { id } = suggest(on(), db, SUGG);
    expect(db.playbooks.suggestionSetStatus(id, "accepted", "theirs")).toBe(true);
    expect(db.playbooks.suggestionRelease(id, "review-prs")).toBe(false);
    expect(db.playbooks.suggestionGet(id)).toMatchObject({
      status: "accepted",
      playbook: "theirs",
    });
    expect(db.playbooks.suggestionRelease(id, "theirs")).toBe(true);
    expect(db.playbooks.suggestionGet(id)).toMatchObject({ status: "pending", playbook: null });
  });

  it("a crash after the claim is recovered by accepting again: the playbook is created once", () => {
    const { id } = suggest(on(), db, SUGG);
    // what a process killed between the claim and the write leaves behind
    expect(db.playbooks.suggestionSetStatus(id, "accepted", "review-prs")).toBe(true);
    expect(existsSync(fileOf("review-prs"))).toBe(false);
    const r = acceptSuggestion(on(), db, id);
    expect(r).toMatchObject({ name: "review-prs", recreated: true });
    expect(readFileSync(fileOf("review-prs"), "utf8")).toContain("source: suggested");
    // with the file there, a further accept is the usual error and makes no copy
    expect(() => acceptSuggestion(on(), db, id)).toThrow(/already accepted/);
    reconcile(ctx, db);
    expect(list(ctx, db).map((r) => r.name)).toEqual(["review-prs"]);
  });

  it("a crash before the claim leaves the suggestion pending and one accept later makes one playbook", () => {
    const { id } = suggest(on(), db, SUGG);
    const dbA = Object.create(db) as StorageAdapter;
    const pb = Object.create(db.playbooks) as StorageAdapter["playbooks"];
    pb.suggestionSetStatus = () => {
      throw new Error("crash");
    };
    Object.defineProperty(dbA, "playbooks", { value: pb });
    expect(() => acceptSuggestion(on(), dbA, id)).toThrow(/crash/);
    expect(existsSync(fileOf("review-prs"))).toBe(false);
    expect(acceptSuggestion(on(), db, id).name).toBe("review-prs");
    reconcile(ctx, db);
    expect(list(ctx, db).map((r) => r.name)).toEqual(["review-prs"]);
  });

  it("recovery keeps the accepted name and refuses another", () => {
    const { id } = suggest(on(), db, SUGG);
    db.playbooks.suggestionSetStatus(id, "accepted", "review-prs");
    expect(() => acceptSuggestion(on(), db, id, { name: "other" })).toThrow(
      /accepted as review-prs/,
    );
    expect(existsSync(fileOf("other"))).toBe(false);
  });

  it("a dismissed suggestion is still refused", () => {
    const { id } = suggest(on(), db, SUGG);
    db.playbooks.suggestionSetStatus(id, "dismissed");
    expect(() => acceptSuggestion(on(), db, id)).toThrow(/already dismissed/);
  });

  it("an invalid field is refused before the claim", () => {
    const { id } = suggest(on(), db, SUGG);
    expect(() => acceptSuggestion(on(), db, id, { prompt: "  " })).toThrow(/needs a prompt/);
    expect(() => acceptSuggestion(on(), db, id, { name: "Bad Name" })).toThrow();
    expect(db.playbooks.suggestionGet(id)?.status).toBe("pending");
  });
});

describe("#264 secrets in a playbook's header and prompt", () => {
  const privFile = (name: string) => join(root, privatePlaybooksRel(ctx), `${name}.md`);
  const EXTRA = [
    "dbpass: Tr0ub4dor-and-3",
    "apipass: hunter2hunter2",
    "cookie: sessionid=8f3a9c2e1b7d4f60a5c3e9b1d2f4a6c8",
    "login: alice:Tr0ub4dorLogin",
    "authheader: Basic YWxpY2U6VHIwdWI0ZG9y",
    "otp_seed: JBSWY3DPEHPK3PXP",
    "pin: 4921",
    "private_url: https://internal.corp/admin?key=abc",
    "owner: alice",
  ];
  const LEAKS = [
    "Tr0ub4dor-and-3",
    "hunter2hunter2",
    "8f3a9c2e1b7d4f60a5c3e9b1d2f4a6c8",
    "Tr0ub4dorLogin",
    "YWxpY2U6VHIwdWI0ZG9y",
    "JBSWY3DPEHPK3PXP",
    "4921",
    "internal.corp",
  ];

  function handEdited(name: string, priv: boolean): string {
    write(ctx, db, { name, title: "Mine", prompt: "x", private: priv });
    const f = priv ? privFile(name) : fileOf(name);
    writeFileSync(f, readFileSync(f, "utf8").replace("---\n", `---\n${EXTRA.join("\n")}\n`));
    reconcile(ctx, db);
    return f;
  }

  it("a private playbook made public carries none of its hand-added header keys", () => {
    writeFileSync(join(root, ".gitignore"), `${privatePlaybooksRel(ctx)}/\n`);
    handEdited("mine", true);
    write(ctx, db, { name: "mine", title: "Mine", prompt: "x", private: false, replace: true });
    expect(existsSync(privFile("mine"))).toBe(false);
    const pub = readFileSync(fileOf("mine"), "utf8");
    for (const s of [...LEAKS, "owner:", "dbpass", "cookie", "login", "pin:"])
      expect(pub, s).not.toContain(s);
  });

  it("a committed playbook keeps a harmless hand-added key, masked, and drops secret-named ones", () => {
    handEdited("pub", false);
    write(ctx, db, { name: "pub", title: "Pub", prompt: "y", replace: true });
    const text = readFileSync(fileOf("pub"), "utf8");
    expect(text).toContain("owner: alice");
    for (const s of ["dbpass", "apipass", "cookie", "authheader", "otp_seed", "Tr0ub4dorLogin"])
      expect(text, s).not.toContain(s);
  });

  it("a prompt's fullwidth, zero-width and one-word secrets are masked before the file is written", () => {
    const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789";
    write(ctx, db, {
      name: "p",
      title: "P",
      prompt: [
        `use ＧＨＰ＿${TOKEN}`,
        `or ghp\u200b_${TOKEN}`,
        "DBPASS=Xq9vT2mLr8Kp4Wz7",
        "mysql -pS3cretPw then -pS3cretPw2 mysql",
        "keep café ① as written",
      ].join("\n"),
    });
    const text = readFileSync(fileOf("p"), "utf8");
    for (const s of [TOKEN, "Xq9vT2mLr8Kp4Wz7", "S3cretPw"]) expect(text, s).not.toContain(s);
    expect(read(ctx, db, "p")?.prompt).not.toContain(TOKEN);
  });

  it("a prompt that hides nothing keeps its characters", () => {
    write(ctx, db, { name: "q", title: "Café ①", prompt: "résumé ﬁle ｶﾀｶﾅ" });
    const f = read(ctx, db, "q");
    expect(f?.prompt).toBe("résumé ﬁle ｶﾀｶﾅ");
    expect(f?.title).toBe("Café ①");
  });
});

describe("#272 a private playbook that hides a committed one of the same name", () => {
  const COMMITTED = () => `${playbooksRel(ctx)}/deploy.md`;

  /** A committed `deploy` and a private `deploy` placed by hand, as a person would. */
  function shadowed(): void {
    write(ctx, db, {
      name: "deploy",
      title: "Committed",
      prompt: "committed prompt text",
      replace: true,
    });
    mkdirSync(join(root, privatePlaybooksRel(ctx)), { recursive: true });
    writeFileSync(join(root, ".gitignore"), `${privatePlaybooksRel(ctx)}/\n`);
    writeFileSync(
      join(root, privatePlaybooksRel(ctx), "deploy.md"),
      "---\nname: deploy\ntitle: Mine\n---\n\nmy private prompt\n",
    );
    reconcile(ctx, db);
    expect(read(ctx, db, "deploy")?.private).toBe(true);
  }

  async function cli(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await playbookCommand(args, ctx, {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  const tool = async (args: Record<string, unknown>): Promise<string> => {
    const r = (await emPlaybook.handler(args as never, ctx)) as {
      content: { text: string }[];
    };
    return r.content.map((c) => c.text).join("");
  };

  it("removeReport names the committed file that is now active, and read returns it", () => {
    shadowed();
    expect(removeReport(ctx, db, "deploy")).toEqual({ removed: true, nowActive: COMMITTED() });
    // mirrored at once, not only after the next reconcile
    expect(read(ctx, db, "deploy")).toMatchObject({ private: false, title: "Committed" });
  });

  it("removeReport on a name in one folder only reports no uncovered file", () => {
    write(ctx, db, { name: "solo", title: "Solo", prompt: "p" });
    expect(removeReport(ctx, db, "solo")).toEqual({ removed: true });
    expect(removeReport(ctx, db, "solo")).toEqual({ removed: false });
  });

  it("the tool's delete says the committed playbook is now active", async () => {
    shadowed();
    const t = await tool({ action: "delete", name: "deploy", confirm: true });
    expect(t).toContain("deleted the private playbook deploy");
    expect(t).toContain(`the committed playbook ${COMMITTED()} it hid is now active`);
  });

  it("CLI rm says so, in text and json", async () => {
    shadowed();
    const r = await cli(["rm", "deploy"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed the private playbook deploy");
    expect(r.out).toContain(`the committed playbook ${COMMITTED()} it hid is now active`);
    shadowed();
    const j = await cli(["rm", "deploy", "--json"]);
    expect(JSON.parse(j.out)).toEqual({ name: "deploy", removed: true, nowActive: COMMITTED() });
  });

  it("the dashboard delete response says so", async () => {
    shadowed();
    const r = await playbooksRoute(ctx, {
      path: "/api/playbooks/delete",
      method: "POST",
      query: new URLSearchParams(),
      body: async () => ({ name: "deploy" }),
    });
    expect(r?.body).toMatchObject({ removed: true, nowActive: COMMITTED() });
    expect(String((r?.body as { note?: string } | undefined)?.note)).toContain("is now active");
  });

  it("an unshadowed delete keeps its plain messages", async () => {
    write(ctx, db, { name: "solo", title: "Solo", prompt: "p" });
    expect(await tool({ action: "delete", name: "solo", confirm: true })).toBe(
      "deleted playbook solo",
    );
    write(ctx, db, { name: "solo", title: "Solo", prompt: "p" });
    expect((await cli(["rm", "solo"])).out).toBe("removed solo");
  });

  it("CLI list, show and run mark the hidden committed file", async () => {
    shadowed();
    const l = await cli(["list"]);
    expect(l.out).toMatch(
      /^deploy {2}"Mine" {2}\(private\).*\[hides committed \.eminiar\/playbooks\/deploy\.md\]/m,
    );
    expect(JSON.parse((await cli(["list", "--json"])).out)[0]).toMatchObject({
      name: "deploy",
      hides: COMMITTED(),
    });
    const s = await cli(["show", "deploy"]);
    expect(s.out).toContain(`hides committed ${COMMITTED()}`);
    const r = await cli(["run", "deploy"]);
    expect(r.out).toBe("my private prompt");
    expect(r.err).toContain(`the committed file ${COMMITTED()} has the same name and is ignored`);
    expect(JSON.parse((await cli(["run", "deploy", "--json"])).out)).toMatchObject({
      hides: COMMITTED(),
    });
  });

  it("the CLI says nothing about hiding when the name is in one folder", async () => {
    write(ctx, db, { name: "solo", title: "Solo", prompt: "p" });
    expect((await cli(["list"])).out).not.toContain("hides");
    expect((await cli(["show", "solo"])).out).not.toContain("hides");
    expect((await cli(["run", "solo"])).err).not.toContain("ignored");
  });
});
