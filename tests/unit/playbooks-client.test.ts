import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fillPrompt as serverFill } from "../../src/playbooks/store.js";

/**
 * The dashboard fills a prompt in the browser (src/ui/web/playbooks-client.ts) with its own copy
 * of the store's fillPrompt. The text a person copies must be the text `eminiar playbook run` and
 * em_playbook run would print for the same values.
 */

type Fill = (
  prompt: string,
  params: Array<{ name: string; default?: string | undefined }>,
  values: Record<string, string>,
) => string;
let clientFill: Fill;

// The page code needs the DOM lib, which the project's Node tsconfig does not have: load it by a
// path tsc does not follow (its own tsconfig.web.json checks it), and give it the one global it
// reads at import time.
const CLIENT = "../../src/ui/web/playbooks-client.js";

beforeAll(async () => {
  vi.stubGlobal("location", new URL("http://127.0.0.1:1/?root=x"));
  clientFill = ((await import(/* @vite-ignore */ CLIENT)) as { fillPrompt: Fill }).fillPrompt;
});
afterAll(() => vi.unstubAllGlobals());

// the shape the store keeps: a parameter with an empty default is stored without one
const params = [{ name: "a" }, { name: "b", default: "B" }];

describe("dashboard fillPrompt agrees with the store's", () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["values first", "{{a}} {{b}}", { a: "A", b: "z" }],
    ["then defaults", "{{a}} {{b}}", { a: "A" }],
    ["gaps stay as written", "{{a}} {{c}} {{b}}", {}],
    ["spaces inside braces", "{{ a }} and {{  b  }}", { a: "A" }],
    ["every occurrence", "{{b}}-{{b}}-{{a}}-{{a}}", { a: "x" }],
    ["underscore names", "{{_x}} {{a_1}}", { _x: "1", a_1: "2" }],
    ["not placeholders", "{a} {{1a}} {{a-b}} {{ }} {{}}", { a: "A" }],
    ["prototype keys are not values", "{{a}} {{constructor}} {{__proto__}}", { a: "A" }],
    ["regex characters in a value", "{{a}}", { a: "$1 $& \\ $$" }],
    ["no placeholders", "plain text", { a: "A" }],
  ];
  for (const [label, prompt, values] of cases) {
    it(label, () => {
      expect(clientFill(prompt, params, values)).toBe(serverFill({ prompt, params }, values));
    });
  }

  it("the values are taken literally, never as a replacement pattern", () => {
    expect(clientFill("x {{a}} y", params, { a: "$& $1" })).toBe("x $& $1 y");
  });
});

describe("dashboard playbooks client: closing a run", () => {
  it("POSTs the run id and outcome to /api/playbooks/run/close", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    });
    const { playbooksApi } = (await import(/* @vite-ignore */ CLIENT)) as {
      playbooksApi: {
        closeRun: (id: number, s: "done" | "failed" | "skipped") => Promise<unknown>;
      };
    };
    expect(await playbooksApi.closeRun(7, "skipped")).toEqual({ id: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/playbooks/run/close");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ id: 7, status: "skipped" });
  });
});
