import { describe, expect, it } from "vitest";
import { classifyToolCall } from "../../src/capture/classify.js";

// What a tool call leaves in the session store (and, for the memorable events, in the index that
// em_recall searches): the summaries, the failed call's error text, a git command, a fetched URL.
// Each is masked before it is cut, because a token cut short no longer has its shape.

const root = "/tmp/proj";
const TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const payloads = (drafts: ReturnType<typeof classifyToolCall>, category: string) =>
  drafts.filter((d) => d.category === category).map((d) => JSON.stringify(d.payload));

/** No run of 8+ characters of the token survives (`ghp_` itself and `***` may). */
function expectNoPieceOf(text: string | undefined, secret = TOKEN): void {
  expect(text).toBeDefined();
  const body = secret.slice(4);
  for (let i = 0; i + 8 <= body.length; i++) expect(text).not.toContain(body.slice(i, i + 8));
}

describe("tool call summaries: masked before the 160-char cut", () => {
  // A bare token (only its shape rule finds it) 143 chars in: cut to 159 chars + "…" first,
  // `ghp_` + 12 chars is left, too short for the shape rule and long enough to be a lead.
  const command = `echo ${"a".repeat(132)} ${TOKEN} done`;

  it("masks a token the cut would split, in tool_call, latency and error", () => {
    expect(`Bash ${command}`.indexOf(TOKEN)).toBe(143);
    const drafts = classifyToolCall({
      toolName: "Bash",
      toolInput: { command },
      durationMs: 9000,
      error: "exit 1",
      root,
    });
    for (const category of ["tool_call", "latency", "error"]) {
      const [p] = payloads(drafts, category);
      expectNoPieceOf(p);
    }
  });

  it("masks a quoted value the cut leaves without its closing quote", () => {
    const quoted = `${"echo padding ".repeat(9)}&& curl -d '{"password": "${"Hunter2-".repeat(4)}"}' https://x`;
    const at = `Bash ${quoted}`.indexOf("Hunter2");
    expect(at).toBeLessThan(160);
    expect(at + 32).toBeGreaterThan(160);
    const drafts = classifyToolCall({ toolName: "Bash", toolInput: { command: quoted }, root });
    const [p] = payloads(drafts, "tool_call");
    expect(p).not.toContain("Hunter2");
  });

  it("masks the git command and a fetched URL", () => {
    const git = classifyToolCall({
      toolName: "Bash",
      toolInput: { command: `git push https://me:${TOKEN}@github.com/org/repo.git main` },
      root,
    });
    const [g] = payloads(git, "git");
    expectNoPieceOf(g);
    expect(g).toContain("https://***@github.com/org/repo.git");
    const fetch = classifyToolCall({
      toolName: "WebFetch",
      toolInput: { url: `https://api.example.com/x?access_token=${TOKEN}`, prompt: "p" },
      root,
    });
    const [u] = payloads(fetch, "external_ref");
    expectNoPieceOf(u);
    expect(u).toContain("access_token=***");
  });
});

describe("a failed call's error text", () => {
  it("is masked before the 400-char cut", () => {
    // the token straddles the cut (399 chars + "…"): masking only the first 400 chars, or
    // cutting first, leaves `ghp_` + 12 chars of it
    const error = `${"x".repeat(375)} GH_PAT ${TOKEN} more output`;
    expect(error.indexOf(TOKEN)).toBe(383);
    const drafts = classifyToolCall({
      toolName: "Bash",
      toolInput: { command: "make" },
      error,
      root,
    });
    const [p] = payloads(drafts, "error");
    expectNoPieceOf(p);
  });

  it("masks only the first 4 KB, so a huge failing output costs the hook nothing", () => {
    const time = (error: string) => {
      const t0 = performance.now();
      classifyToolCall({ toolName: "Bash", toolInput: { command: "make" }, error, root });
      return performance.now() - t0;
    };
    const line = "error: something failed at src/a.ts:10 password=hunter2 Bearer abcdefghijkl\n";
    const small = line.repeat(Math.ceil(4096 / line.length));
    const huge = line.repeat(Math.ceil(8_000_000 / line.length));
    time(small);
    const baseline = Math.min(time(small), time(small), time(small));
    // masking 8 MB takes ~100+ ms; the first 4 KB well under a millisecond
    let t = time(huge);
    for (let retry = 0; retry < 2 && t >= Math.max(20, 20 * baseline); retry++)
      t = Math.min(t, time(huge));
    expect(t).toBeLessThan(Math.max(20, 20 * baseline));
  });
});
