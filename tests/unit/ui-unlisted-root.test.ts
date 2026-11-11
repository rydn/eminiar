import { existsSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let port = 0;
const home = mkdtempSync(join(tmpdir(), "em-home-"));
const start = mkdtempSync(join(tmpdir(), "em-start-"));
const unlisted = mkdtempSync(join(tmpdir(), "em-unlisted-"));
process.env.EMINIAR_HOME = home;

beforeAll(async () => {
  port = await new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
  const { serve } = await import("../../src/ui/server.js");
  void serve({ port, open: false, root: start }); // never resolves; run detached
  await new Promise((r) => setTimeout(r, 300));
});

describe("?root= on the dashboard API", () => {
  it("answers for the default root and creates nothing in an unlisted folder", async () => {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/stats?root=${encodeURIComponent(unlisted)}`,
    );
    expect(r.status).toBe(200);
    expect(existsSync(join(unlisted, ".eminiar"))).toBe(false);
    expect(readdirSync(unlisted)).toEqual([]);
  });
  it("acts on the start root, not the asked one", async () => {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/projects?root=${encodeURIComponent(unlisted)}`,
    );
    const body = (await r.json()) as { current: string };
    expect(realpathSync(body.current)).toBe(realpathSync(start));
    expect(readdirSync(unlisted)).toEqual([]);
  });
});
