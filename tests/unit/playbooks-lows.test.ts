import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { playbookCommand } from "../../src/playbooks/cli.js";
import { scan } from "../../src/playbooks/extract.js";
import { oneLine, parsePlaybookFile } from "../../src/playbooks/frontmatter.js";
import {
  acceptSuggestion,
  closeRun,
  list,
  read,
  reconcile,
  recordRun,
  suggest,
  write,
} from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

/**
 * The low-severity logic defects of the playbook review (swarm run 20261111-e068a8, task #221,
 * findings L1-L5 and L7-L10 of review-logic).
 */

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;

const SLACK = "mcp__claude_ai_Slack__slack_read_channel";
const PROMPT = "Check Slack for open pull requests and review them for me";

const on = (): ProjectContext => ({
  ...ctx,
  config: { ...ctx.config, playbooks: { ...ctx.config.playbooks, extraction: { enabled: true } } },
});

async function cli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await playbookCommand(args, ctx, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function session(id: string, ts: number): void {
  db.eventInsert({
    sessionId: id,
    ts,
    category: "user_prompt",
    priority: 1,
    payload: { text: PROMPT },
  });
  db.eventInsert({
    sessionId: id,
    ts: ts + 1000,
    category: "mcp_tool",
    priority: 3,
    tool: SLACK,
    payload: { tool: SLACK },
  });
}

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-pblows-"));
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
  db.purge("sessions");
});

describe("L1 line separators in a header", () => {
  it("oneLine turns U+2028, U+2029 and NEL into spaces", () => {
    expect(oneLine("a b c\u0085d")).toBe("a b c d");
  });

  it("write keeps the title, tags and params when they carry U+2028 / U+2029", () => {
    const r = write(ctx, db, {
      name: "sep",
      title: "Review open PRs",
      prompt: "x",
      tags: ["github", "a b"],
      params: [{ name: "repo", default: "x y" }],
    });
    expect(r.row.title).toBe("Review open PRs");
    const f = read(ctx, db, "sep");
    expect(f?.tags).toEqual(["github", "a b"]);
    expect(f?.params).toEqual([{ name: "repo", default: "x y" }]);
  });

  it("a hand-written header line with U+2028 inside a value is still read", () => {
    const p = parsePlaybookFile("---\ntitle: One Two\ntags: [a, b]\n---\nbody\n");
    expect(p.meta.title).toBe("One Two");
    expect(p.meta.tags).toEqual(["a", "b"]);
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    writeFileSync(
      join(root, ".eminiar/playbooks/hand.md"),
      "---\ntitle: One Two\ntags: [a, b]\n---\nbody\n",
    );
    reconcile(ctx, db);
    const f = read(ctx, db, "hand");
    expect(f?.title).toBe("One Two");
    expect(f?.tags).toEqual(["a", "b"]);
  });
});

describe("L2 days are local calendar days", () => {
  const base = Date.UTC(2026, 9, 5, 22, 0, 0); // 15:00 PDT Oct 5

  it("three sessions in one Los Angeles afternoon are one day, not two", async () => {
    session("x1", base);
    session("x2", base + 90 * 60_000);
    session("x3", base + 150 * 60_000); // 00:30 UTC on Oct 6, still 17:30 PDT Oct 5
    const r = await scan(on(), db, {
      embeddings: false,
      dryRun: true,
      timeZone: "America/Los_Angeles",
    });
    expect(r.candidates).toHaveLength(0);
  });

  it("sessions on two Sydney days count as two days, though one UTC day", async () => {
    const mon = Date.UTC(2026, 9, 5, 0, 0, 0); // Mon 11:00 AEDT
    session("y1", mon);
    session("y2", mon + 4 * 3_600_000);
    session("y3", mon + 23.5 * 3_600_000); // Tue 10:30 AEDT
    const r = await scan(on(), db, {
      embeddings: false,
      dryRun: true,
      timeZone: "Australia/Sydney",
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.days).toBe(2);
  });
});

describe("L3 names without case", () => {
  const caseInsensitive = (() => {
    const d = mkdtempSync(join(tmpdir(), "em-case-"));
    writeFileSync(join(d, "aB"), "");
    const same = existsSync(join(d, "Ab"));
    rmSync(d, { recursive: true, force: true });
    return same;
  })();

  function hand(): void {
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    writeFileSync(
      join(root, ".eminiar/playbooks/Review-PRs.md"),
      "---\ntitle: Review PRs\n---\nreview the open prs\n",
    );
  }

  it("add refuses a name that only differs in case from a file, saying which file", () => {
    hand();
    expect(() => write(ctx, db, { name: "review-prs", title: "R", prompt: "x" })).toThrow(
      /Review-PRs\.md/,
    );
    expect(existsSync(join(root, ".eminiar/playbooks/review-prs.md"))).toBe(caseInsensitive);
  });

  it.skipIf(!caseInsensitive)("a hand-made Review-PRs.md is listed (case-insensitive disk)", () => {
    hand();
    reconcile(ctx, db);
    expect(list(ctx, db).map((r) => r.name)).toEqual(["review-prs"]);
    expect(read(ctx, db, "review-prs")?.title).toBe("Review PRs");
  });
});

describe("L4 closing runs", () => {
  beforeEach(() => {
    write(ctx, db, { name: "daily", title: "Daily", prompt: "check things" });
  });

  it("report without a run id closes only a started run opened through em_playbook (mcp)", () => {
    const m = recordRun(ctx, db, { playbook: "daily", trigger: "mcp" }).id;
    const c = recordRun(ctx, db, { playbook: "daily", trigger: "cli" }).id;
    const u = recordRun(ctx, db, { playbook: "daily", trigger: "ui" }).id;
    expect(closeRun(ctx, db, { playbook: "daily", status: "done" })).toEqual({ id: m });
    expect(db.playbooks.getRun(c)?.status).toBe("started");
    expect(db.playbooks.getRun(u)?.status).toBe("started");
    expect(() => closeRun(ctx, db, { playbook: "daily", status: "done" })).toThrow(/run_id|run id/);
    expect(closeRun(ctx, db, { playbook: "daily", runId: c, status: "failed" })).toEqual({ id: c });
  });

  it("cli: report closes the newest started cli run", async () => {
    await cli(["run", "daily"]);
    const id = db.playbooks.runs({ playbook: "daily" })[0]?.id as number;
    const r = await cli(["report", "daily", "--status", "done", "--note", "all good"]);
    expect(r.code).toBe(0);
    expect(db.playbooks.getRun(id)?.status).toBe("done");
    expect(db.playbooks.getRun(id)?.note).toBe("all good");
  });

  it("cli: report --run closes that run; usage errors exit 2", async () => {
    await cli(["run", "daily"]);
    await cli(["run", "daily"]);
    const [newest, older] = db.playbooks.runs({ playbook: "daily" }).map((x) => x.id) as number[];
    expect(
      (await cli(["report", "daily", "--status", "skipped", "--run", String(older)])).code,
    ).toBe(0);
    expect(db.playbooks.getRun(older as number)?.status).toBe("skipped");
    expect(db.playbooks.getRun(newest as number)?.status).toBe("started");
    expect((await cli(["report", "daily"])).code).toBe(2);
    expect((await cli(["report", "daily", "--status", "started"])).code).toBe(2);
    expect((await cli(["report", "daily", "--status", "done", "--run", "abc"])).code).toBe(2);
    expect((await cli(["report", "--status", "done"])).code).toBe(2);
  });

  it("cli: report with nothing started is an error (exit 1)", async () => {
    const r = await cli(["report", "daily", "--status", "done"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no started/);
  });
});

describe("L5 an over-long hand-written prompt", () => {
  it("other fields can be edited; changing the prompt is still checked", () => {
    mkdirSync(join(root, ".eminiar/playbooks"), { recursive: true });
    writeFileSync(
      join(root, ".eminiar/playbooks/big.md"),
      `---\ntitle: Big\n---\n${"word ".repeat(5000)}\n`,
    );
    reconcile(ctx, db);
    const f = read(ctx, db, "big");
    expect(f?.prompt.length).toBeGreaterThan(20_000);
    const r = write(ctx, db, {
      name: "big",
      title: "Bigger",
      prompt: f?.prompt as string,
      replace: true,
    });
    expect(r.row.title).toBe("Bigger");
    expect(() =>
      write(ctx, db, {
        name: "big",
        title: "Bigger",
        prompt: `${f?.prompt as string} more`,
        replace: true,
      }),
    ).toThrow(/prompt is \d+ characters/);
    expect(() => write(ctx, db, { name: "fresh", title: "F", prompt: "x".repeat(20_001) })).toThrow(
      /prompt is/,
    );
  });
});

describe("L7 playbook show has no stray blank lines", () => {
  it("a playbook without schedule, tags or params prints one blank line before the prompt", async () => {
    write(ctx, db, { name: "plain", title: "Plain", prompt: "do the thing" });
    const r = await cli(["show", "plain"]);
    expect(r.out.split("\n")).toEqual([
      "plain: Plain",
      expect.stringMatching(/^path: .*plain\.md {2}source: manual$/),
      "",
      "do the thing",
    ]);
  });
});

describe("L8 CLI parsing", () => {
  beforeEach(() => {
    write(ctx, db, { name: "pb", title: "PB", prompt: "Do {{x}}" });
  });

  it("a bad --set is a usage error (exit 2)", async () => {
    for (const bad of ["novalue", "=v"]) {
      expect((await cli(["run", "pb", "--set", bad])).code).toBe(2);
      expect((await cli(["export", "pb", "--set", bad])).code).toBe(2);
    }
  });

  it("export is recognised after global flags", async () => {
    const r = await cli(["--json", "export", "pb", "--schedule"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).prompt).toContain("Do");
  });

  it("--schedule=1 on export, and unknown options, are usage errors", async () => {
    expect((await cli(["export", "pb", "--schedule=1"])).code).toBe(2);
    expect((await cli(["export", "pb", "--skil"])).code).toBe(2);
    expect((await cli(["list", "--bogus"])).code).toBe(2);
  });

  it("--tag a,b is two tags", async () => {
    await cli(["add", "tagged", "--title", "T", "--prompt", "p", "--tag", "a,b", "--tag", "c"]);
    expect(read(ctx, db, "tagged")?.tags).toEqual(["a", "b", "c"]);
  });
});

describe("L9 recordRun status", () => {
  it("rejects an empty or unknown status, accepts none", () => {
    write(ctx, db, { name: "rr", title: "R", prompt: "x" });
    expect(() =>
      recordRun(ctx, db, { playbook: "rr", trigger: "cli", status: "" as never }),
    ).toThrow(/invalid status/);
    expect(() =>
      recordRun(ctx, db, { playbook: "rr", trigger: "cli", status: "weird" as never }),
    ).toThrow(/invalid status/);
    const { id } = recordRun(ctx, db, { playbook: "rr", trigger: "cli" });
    expect(db.playbooks.getRun(id)?.status).toBe("started");
  });
});

describe("L10 accepting a suggestion is atomic", () => {
  it("the status update only applies to a pending suggestion", () => {
    const { id } = suggest(on(), db, { title: "Sugg", prompt: "do the recurring thing" });
    expect(db.playbooks.suggestionSetStatus(id, "accepted", "x")).toBe(true);
    expect(db.playbooks.suggestionSetStatus(id, "dismissed")).toBe(false);
    expect(db.playbooks.suggestionGet(id)?.status).toBe("accepted");
  });

  it("a second accept after a lost race leaves one playbook and an error", () => {
    const { id } = suggest(on(), db, { title: "Race", prompt: "do the recurring thing" });
    // another process wins between our status check and our status update
    const real = db.playbooks.suggestionGet.bind(db.playbooks);
    let first = true;
    db.playbooks.suggestionGet = (i: number) => {
      const s = real(i);
      if (first && s) {
        first = false;
        db.playbooks.suggestionSetStatus(i, "accepted", "race");
      }
      return s && { ...s, status: "pending" };
    };
    try {
      expect(() => acceptSuggestion(on(), db, id)).toThrow(/already/);
    } finally {
      db.playbooks.suggestionGet = real;
    }
    expect(list(ctx, db).map((r) => r.name)).toEqual([]);
  });
});
