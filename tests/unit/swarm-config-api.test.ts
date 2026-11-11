import {
  chmodSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectContext } from "../../src/context.js";
import { hashText } from "../../src/swarm/edit.js";
import { swarmRoute } from "../../src/ui/swarm-api.js";

const A =
  "version: 1\nswarms:\n  one:\n    description: One\n    agents:\n      a:\n        description: A\n        prompt: P\n";

let root: string;
const file = () => join(root, ".eminiar/swarm.yaml");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "em-cfgapi-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ctx = () => ({ root }) as unknown as ProjectContext;
const get = (path: string) =>
  swarmRoute(ctx(), { path, method: "GET", query: new URLSearchParams(), body: async () => ({}) });
const post = (path: string, body: unknown) =>
  swarmRoute(ctx(), { path, method: "POST", query: new URLSearchParams(), body: async () => body });
const put = (text = A) => {
  mkdirSync(join(root, ".eminiar"), { recursive: true });
  writeFileSync(file(), text);
};
// biome-ignore lint/suspicious/noExplicitAny: test reads loose JSON
type J = any;

describe("swarm config API", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable swarm file is a read error, not 'removed'",
    async () => {
      put();
      const h = hashText(A);
      chmodSync(file(), 0);
      try {
        const r = await post("/api/swarm/config/validate", { text: A, baseHash: h });
        expect(r.status).toBe(500);
        expect(JSON.stringify(r.body)).toContain("cannot read");
        expect(JSON.stringify(r.body)).not.toContain("removed");
      } finally {
        chmodSync(file(), 0o644);
      }
    },
  );

  it("GET config: absent gives the starter and meta", async () => {
    const r = await get("/api/swarm/config");
    const b = r.body as J;
    expect(r.status).toBe(200);
    expect(b.state).toBe("absent");
    expect(b.hash).toBeNull();
    expect(b.starter.swarms).toBeTruthy();
    expect(b.meta.limits.maxAgents).toBe(16);
    expect(b.meta.topologies).toContain("mesh");
  });

  it("GET config: ok file returns doc and hash", async () => {
    put();
    const b = (await get("/api/swarm/config")).body as J;
    expect(b.state).toBe("ok");
    expect(b.hash).toBe(hashText(A));
    expect(b.doc.swarms.one.agents.a.prompt).toBe("P");
  });

  it("GET templates", async () => {
    const b = (await get("/api/swarm/templates")).body as J;
    expect(b.templates.map((t: J) => t.id)).toContain("feature");
    expect(b.templates[0].roles[0]).toHaveProperty("count");
  });

  it("validate never writes and reports changed lines", async () => {
    put();
    const cfg = (await get("/api/swarm/config")).body as J;
    cfg.doc.swarms.one.description = "Two";
    const r = await post("/api/swarm/config/validate", { doc: cfg.doc, baseHash: cfg.hash });
    const b = r.body as J;
    expect(r.status).toBe(200);
    expect(b.ok).toBe(true);
    expect(b.text).toContain("description: Two");
    expect(b.changed.length).toBeGreaterThan(0);
    expect(readFileSync(file(), "utf8")).toBe(A);
  });

  it("validate reports schema issues with paths", async () => {
    put();
    const text = A.replace("prompt: P", "prompt: P\n        count: 99");
    const b = (await post("/api/swarm/config/validate", { text, baseHash: hashText(A) })).body as J;
    expect(b.ok).toBe(false);
    expect(b.issues[0].path).toContain("count");
  });

  it("lists ignored keys as warnings that do not block a save", async () => {
    const text = A.replace("prompt: P", "prompt: P\n        retry_policy: plan");
    put(text);
    const cfg = (await get("/api/swarm/config")).body as J;
    expect(cfg.state).toBe("ok");
    expect(cfg.issues).toEqual([]);
    const ignored = {
      path: "swarms.one.agents.a",
      kind: "ignored-key",
      message: 'unknown key "retry_policy" ignored: not a setting in this eminiar version',
    };
    expect(cfg.warnings).toEqual([ignored]);
    const edited = text.replace("description: One", "description: Two");
    const saved = await post("/api/swarm/config/save", { text: edited, baseHash: hashText(text) });
    expect(saved.status).toBe(200);
    expect((saved.body as J).warnings).toEqual([ignored]);
    expect(readFileSync(file(), "utf8")).toBe(edited);
  });

  it("the draft-doc branch lists ignored keys and blocks a restriction-like unknown key", async () => {
    put(A.replace("prompt: P", "prompt: P\n        retry_policy: plan"));
    const cfg = (await get("/api/swarm/config")).body as J;
    const ok = await post("/api/swarm/config/validate", { doc: cfg.doc, baseHash: cfg.hash });
    expect((ok.body as J).ok).toBe(true);
    expect((ok.body as J).warnings.map((w: J) => w.kind)).toContain("ignored-key");
    cfg.doc.swarms.one.agents.a.scp = ["src"];
    const bad = await post("/api/swarm/config/validate", { doc: cfg.doc, baseHash: cfg.hash });
    expect((bad.body as J).ok).toBe(false);
    expect(JSON.stringify((bad.body as J).issues)).toContain("looks like a restriction");
  });

  it("save writes the project's swarm file and returns the new hash", async () => {
    put();
    const cfg = (await get("/api/swarm/config")).body as J;
    cfg.doc.swarms.one.description = "Two";
    const r = await post("/api/swarm/config/save", { doc: cfg.doc, baseHash: cfg.hash });
    const b = r.body as J;
    expect(r.status).toBe(200);
    expect(b.saved).toBe(true);
    expect(readFileSync(file(), "utf8")).toBe(b.text);
    expect(b.hash).toBe(hashText(b.text));
  });

  it("save with no change is a no-op", async () => {
    put();
    const cfg = (await get("/api/swarm/config")).body as J;
    const b = (await post("/api/swarm/config/save", { doc: cfg.doc, baseHash: cfg.hash }))
      .body as J;
    expect(b.saved).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe(A);
  });

  it("save creates the file when baseHash is null", async () => {
    const r = await post("/api/swarm/config/save", { text: A, baseHash: null });
    expect((r.body as J).created).toBe(true);
    expect(existsSync(file())).toBe(true);
  });

  it("409 with current when the file changed or exists on create", async () => {
    put();
    const stale = hashText("something else");
    const r = await post("/api/swarm/config/save", { text: A, baseHash: stale });
    expect(r.status).toBe(409);
    expect((r.body as J).current.hash).toBe(hashText(A));
    const r2 = await post("/api/swarm/config/save", { text: A, baseHash: null });
    expect(r2.status).toBe(409);
    expect(readFileSync(file(), "utf8")).toBe(A);
  });

  it("400 for an invalid file and nothing is written", async () => {
    put();
    const bad = A.replace("description: A", "description: ''");
    const r = await post("/api/swarm/config/save", { text: bad, baseHash: hashText(A) });
    expect(r.status).toBe(400);
    expect((r.body as J).issues.length).toBeGreaterThan(0);
    expect(readFileSync(file(), "utf8")).toBe(A);
  });

  it("rejects unknown keys (a client path), both doc and text, and a bad hash", async () => {
    put();
    const h = hashText(A);
    expect(
      (await post("/api/swarm/config/save", { text: A, baseHash: h, path: "/etc/x" })).status,
    ).toBe(400);
    expect((await post("/api/swarm/config/save", { text: A, doc: {}, baseHash: h })).status).toBe(
      400,
    );
    expect((await post("/api/swarm/config/save", { text: A, baseHash: "zz" })).status).toBe(400);
    expect((await post("/api/swarm/config/save", { baseHash: h })).status).toBe(400);
  });

  it("refuses a symlinked swarm file with 403", async () => {
    const { symlinkSync } = await import("node:fs");
    const out = mkdtempSync(join(tmpdir(), "em-cfgapi-out-"));
    try {
      writeFileSync(join(out, "t.yaml"), A);
      mkdirSync(join(root, ".eminiar"), { recursive: true });
      symlinkSync(join(out, "t.yaml"), file());
      const r = await post("/api/swarm/config/save", {
        text: A.replace("One", "Two"),
        baseHash: hashText(A),
      });
      expect([403, 409]).toContain(r.status);
      expect(readFileSync(join(out, "t.yaml"), "utf8")).toBe(A);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("method checks", async () => {
    expect((await post("/api/swarm/config", {})).status).toBe(405);
    expect((await get("/api/swarm/config/save")).status).toBe(405);
  });

  it("init: writes the starter, then 409s", async () => {
    const r = await post("/api/swarm/init", {});
    expect(r.status).toBe(200);
    expect((r.body as J).created).toBe(".eminiar/swarm.yaml");
    expect(existsSync(file())).toBe(true);
    expect((await post("/api/swarm/init", {})).status).toBe(409);
  });

  it("init: a symlinked .eminiar is refused 403 and nothing lands outside", async () => {
    const outside = mkdtempSync(join(tmpdir(), "em-cfgapi-out-"));
    try {
      symlinkSync(outside, join(root, ".eminiar"));
      const r = await post("/api/swarm/init", {});
      expect(r.status).toBe(403);
      expect(existsSync(join(outside, "swarm.yaml"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a no-op save of invalid UTF-8 returns the on-disk hash", async () => {
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    const buf = Buffer.concat([
      Buffer.from(A + "# "),
      Buffer.from([0xff, 0xfe]),
      Buffer.from("\n"),
    ]);
    writeFileSync(file(), buf);
    const disk = (await get("/api/swarm/config")).body as J;
    const r = await post("/api/swarm/config/save", { text: disk.text, baseHash: disk.hash });
    expect((r.body as J).saved).toBe(false);
    expect((r.body as J).hash).toBe(disk.hash);
  });
});
