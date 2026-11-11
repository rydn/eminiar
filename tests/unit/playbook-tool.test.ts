import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emPlaybook } from "../../src/tools/em_playbook.js";
import { tools } from "../../src/tools/index.js";

let ctx: ProjectContext;

type Args = Parameters<typeof emPlaybook.handler>[0];
const call = async (a: Partial<Args> & { action: Args["action"] }) => {
  const r = await emPlaybook.handler(a as Args, ctx);
  return { text: r.content.map((c) => c.text).join("\n"), err: r.isError === true };
};

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_SESSION_ID = "sess-pb";
  const root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
});

afterAll(() => closeAllStorage());

describe("em_playbook", () => {
  it("is registered", () => {
    expect(tools.some((t) => t.name === "em_playbook")).toBe(true);
  });

  it("adds, lists, reads, edits and exports", async () => {
    expect((await call({ action: "list" })).text).toMatch(/no playbooks/);
    const add = await call({
      action: "add",
      name: "pr-review",
      title: "Review PRs",
      prompt: "Review open PRs in {{repo}} for {{who}}",
      params: [{ name: "repo" }, { name: "who", default: "me" }],
      schedule: "every weekday 9am",
      tags: ["github"],
    });
    expect(add.err).toBe(false);
    expect((await call({ action: "list" })).text).toContain("pr-review");
    expect((await call({ action: "read", name: "pr-review" })).text).toContain("every weekday 9am");
    await call({ action: "edit", name: "pr-review", title: "Review all PRs" });
    expect((await call({ action: "read", name: "pr-review" })).text).toContain("Review all PRs");
    const ex = await call({ action: "export", name: "pr-review" });
    expect(ex.text).toContain("title: Review all PRs");
    expect(ex.text).toContain("{{repo}}");
  });

  it("run fills the prompt and records a started run; report records the outcome", async () => {
    const r = await call({ action: "run", name: "pr-review", values: { repo: "rydn/eminiar" } });
    expect(r.err).toBe(false);
    expect(r.text).toContain("Review open PRs in rydn/eminiar for me");
    const runs = getStorage(ctx).playbooks.runs({ playbook: "pr-review" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("started");
    expect(runs[0]?.trigger).toBe("mcp");
    const rep = await call({
      action: "report",
      name: "pr-review",
      run_id: runs[0]?.id,
      status: "done",
      note: "3 reviewed",
    });
    expect(rep.err).toBe(false);
    // the original row is closed in place: still one row, same id
    const after = getStorage(ctx).playbooks.runs({ playbook: "pr-review" });
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(runs[0]?.id);
    expect(after[0]?.status).toBe("done");
    expect(after[0]?.note).toBe("3 reviewed");
    expect((await call({ action: "report", name: "pr-review" })).err).toBe(true);
  });

  it("report rejects unknown and already-closed runs, masks the note, defaults to the open run", async () => {
    const id = Number(
      /run (\d+)\./.exec((await call({ action: "run", name: "pr-review" })).text)?.[1],
    );
    const runsOf = () => getStorage(ctx).playbooks.runs({ playbook: "pr-review" });
    const before = runsOf().length;
    expect(
      (await call({ action: "report", name: "pr-review", run_id: 99999, status: "done" })).err,
    ).toBe(true);
    expect((await call({ action: "report", name: "nope", run_id: id, status: "done" })).err).toBe(
      true,
    );
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    // no run_id: the newest started run is closed
    const ok = await call({
      action: "report",
      name: "pr-review",
      status: "failed",
      note: `x ${secret}`,
    });
    expect(ok.err).toBe(false);
    const row = runsOf().find((r) => r.id === id);
    expect(row?.status).toBe("failed");
    expect(row?.note).not.toContain(secret);
    expect(runsOf()).toHaveLength(before);
    // closed runs stay closed
    const again = await call({ action: "report", name: "pr-review", run_id: id, status: "done" });
    expect(again.err).toBe(true);
    expect(runsOf().find((r) => r.id === id)?.status).toBe("failed");
    // nothing left to close without an id
    expect((await call({ action: "report", name: "pr-review", status: "done" })).err).toBe(true);
  });

  it("schedule returns an instruction, never schedules", async () => {
    const s = await call({ action: "schedule", name: "pr-review" });
    expect(s.text).toContain("/loop");
    expect(s.text).toContain("every weekday 9am");
    await call({ action: "add", name: "plain", title: "Plain", prompt: "do it" });
    expect((await call({ action: "schedule", name: "plain" })).err).toBe(true);
  });

  it("errors on missing inputs and unknown names; delete needs confirm", async () => {
    expect((await call({ action: "read" })).err).toBe(true);
    expect((await call({ action: "run", name: "nope" })).err).toBe(true);
    expect((await call({ action: "delete", name: "plain" })).err).toBe(true);
    expect((await call({ action: "delete", name: "plain", confirm: true })).err).toBe(false);
    expect((await call({ action: "read", name: "plain" })).err).toBe(true);
  });
});
