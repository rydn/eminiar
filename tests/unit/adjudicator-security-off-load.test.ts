import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Security off costs nothing (design S1): the routing adjudicator's engine, prompt builders and
 * providers reach the security prompt helpers through security/load.ts and import nothing of
 * src/adjudicator/security/ themselves. Every file of that directory is mocked with a factory that
 * records the import and hands back the real module, in a registry nobody has used. (The MCP
 * server is one bundle, scripts/check-bundle.mjs forbids a lazy import there, so only the hook
 * path can be kept free of these files; adjudicator-hooks-off.test.ts drives that end to end.)
 */
const SECURITY_DIR = join(__dirname, "../../src/adjudicator/security");
const FILES = readdirSync(SECURITY_DIR).filter((f) => f.endsWith(".ts"));
const loaded: string[] = [];

async function freshRegistry(): Promise<void> {
  loaded.length = 0;
  vi.resetModules();
  for (const f of FILES)
    vi.doMock(join(SECURITY_DIR, f), async (importOriginal) => {
      // load.ts is the leaf registry the engine imports: it imports nothing.
      if (f !== "load.ts") loaded.push(f);
      return importOriginal();
    });
}

afterAll(() => {
  for (const f of FILES) vi.doUnmock(join(SECURITY_DIR, f));
  vi.resetModules();
});

describe("engine, prompt builders and providers", () => {
  beforeEach(freshRegistry);

  it("load no security module", async () => {
    await import("../../src/adjudicator/engine.js");
    await import("../../src/adjudicator/prompt.js");
    await import("../../src/adjudicator/providers/typesafe.js");
    await import("../../src/adjudicator/providers/index.js");
    expect(loaded).toEqual([]);
  });

  it("the probe is not blind: the advice module brings the prompt helpers in", async () => {
    await import("../../src/adjudicator/security/advice.js");
    expect(loaded).toEqual(expect.arrayContaining(["advice.ts", "register.ts", "prompt.ts"]));
  });
});

describe("the security-load registry", () => {
  beforeEach(freshRegistry);

  it("refuses a read before anything registered, with a message that names the fix", async () => {
    const { security } = await import("../../src/adjudicator/security/load.js");
    expect(() => security()).toThrow(/security\/register\.js/);
  });

  it("a request without a hint is keyed with nothing registered; one with a hint after advice.ts", async () => {
    const { cacheKeyFor } = await import("../../src/adjudicator/engine.js");
    const r = { configured: "heuristic", model: "m" } as const;
    const base = { surface: "plan" as const, text: "summarize the docs" };
    const withHint = { ...base, hints: { security: { tools: ["Read"], caps: ["S"] } as never } };
    expect(() => cacheKeyFor(base, r)).not.toThrow();
    expect(loaded).toEqual([]);
    expect(() => cacheKeyFor(withHint, r)).toThrow(/not registered/);
    await import("../../src/adjudicator/security/advice.js");
    expect(cacheKeyFor(withHint, r)).not.toBe(cacheKeyFor(base, r));
  });
});
