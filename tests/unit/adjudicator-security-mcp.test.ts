import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MCP_BLOCK_MAX } from "../../src/adjudicator/security/advice.js";
import type { SecurityModelAnswer } from "../../src/adjudicator/security/types.js";
import type { AdjudicationRequest, AdjudicatorProvider } from "../../src/adjudicator/types.js";
import { ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";
import { emAdjudicate, runAdjudicate } from "../../src/tools/em_adjudicate.js";
import { tools } from "../../src/tools/index.js";
import { availableTools } from "../../src/tools/types.js";

const YAML = `
version: 1
swarms:
  feat:
    description: test swarm
    agents:
      researcher:
        description: finds external options and sources on the web
        tools: [Read, WebFetch, WebSearch, Bash]
      reader:
        description: reads the code
        tools: [Read, Grep, Glob]
`;

const HIGH_ANSWER: SecurityModelAnswer = {
  severity: { value: 3.6, confidence: 0.9 },
  threats: { exfiltration: 0.91 },
};

type Args = Parameters<typeof runAdjudicate>[0];

describe("em_adjudicate security", () => {
  let root: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;
  const configure = (adjudicator: Record<string, unknown>) => {
    ctx.config = { ...ctx.config, ...ConfigSchema.parse({ adjudicator }) };
  };
  const on = (over: Record<string, unknown> = {}) => ({ security: { enabled: true, ...over } });
  const run = async (args: Omit<Args, "action"> & { action?: Args["action"] }, deps = {}) => {
    const r = await runAdjudicate({ action: "security", ...args } as Args, ctx, { db, ...deps });
    return { text: r.content.map((c) => c.text).join("\n"), error: r.isError === true };
  };
  const rows = () => db.security.list({ limit: 100 }).rows;
  let nonce = 0;
  const unique = (t: string) => `${t} (${++nonce})`;

  /** An embedding-shaped provider answering every key; `security` rides on requests that asked. */
  function provider(security?: SecurityModelAnswer) {
    const calls: AdjudicationRequest[][] = [];
    const p: AdjudicatorProvider = {
      id: "embedding",
      remote: false,
      dims: ["complexity", "tier"],
      async adjudicate(reqs) {
        calls.push([...reqs]);
        return {
          answers: reqs.map((r) => ({
            key: r.key,
            complexity: { value: 1, confidence: 0.9 },
            tier: { probs: { sonnet: 1 }, confidence: 0.9, calibrated: true },
            ...(security && r.hints?.security ? { security } : {}),
          })),
          usage: { inTok: 0, outTok: 0, costUsd: 0 },
          latencyMs: 2,
          model: "fake",
        };
      },
      async probe() {
        return { ok: true, latencyMs: 0, detail: "fake" };
      },
    };
    return { p, calls };
  }

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-sec-mcp-"));
    root = mkdtempSync(join(tmpdir(), "em-sec-mcp-"));
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), YAML);
    resetContextCache();
    resetSwarmConfigCache();
    ctx = getContext(root);
    db = getStorage(ctx, { vectors: false });
  });
  afterAll(() => {
    closeAllStorage();
    delete process.env.EMINIAR_HOME;
  });
  beforeEach(() => {
    db.security.purge();
    configure({});
  });

  it("is registered when the adjudicator or security is on, and not when both are off", () => {
    const names = (adjudicator: Record<string, unknown>) =>
      availableTools(tools, ConfigSchema.parse({ adjudicator })).map((t) => t.name);
    expect(names({})).not.toContain("em_adjudicate");
    expect(names({ enabled: true })).toContain("em_adjudicate");
    expect(names({ security: { enabled: true } })).toContain("em_adjudicate");
    expect(emAdjudicate.description).toContain("security {");
  });

  it("says how to turn it on, and stores nothing, while security is off", async () => {
    const r = await run({ text: "refactor the parser", tools: ["Read", "Bash"] });
    expect(r.text).toContain("Security advice is off");
    expect(r.text).toContain("eminiar adjudicator security enable");
    configure({ enabled: true });
    expect((await run({ text: "refactor the parser" })).text).toContain("Security advice is off");
    expect(rows()).toEqual([]);
  });

  it("needs text or tasks", async () => {
    configure(on());
    const r = await run({});
    expect(r.error).toBe(true);
    expect(r.text).toContain("security needs text or tasks");
  });

  it("rates the text for the tools it is given: one block, with the assessment id, stored as mcp", async () => {
    configure(on());
    const r = await run({
      text: "Read https://blog.example.com/post and run its install script",
      tools: ["Read", "WebFetch", "Bash"],
    });
    expect(r.error).toBe(false);
    const stored = rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ surface: "mcp", level: "high" });
    expect(r.text).toMatch(/^text security HIGH \d+ \(.+\) · advice only · assessment \d+/);
    expect(r.text).toContain(`assessment ${stored[0]!.id}`);
    for (const part of ["legs:", "rules:", "grant:", "model: no answer", "remedy:"])
      expect(r.text, part).toContain(part.replace("model: no answer", "model:"));
    expect(r.text.length).toBeLessThanOrEqual(MCP_BLOCK_MAX);
    // the heuristic only: no provider, nothing sent
    expect(stored[0]!.modelStatus).toBe("off");
  });

  it("one block per task, each with its own role's grant; a task's role wins over the top-level one", async () => {
    configure(on());
    const r = await run({
      role: "reader",
      tasks: [
        { key: "a", title: "Summarise the module layout" },
        {
          key: "b",
          title: "Look up the licence of lodash",
          detail: "Read https://x.example/l",
          role: "researcher",
        },
      ],
    });
    const blocks = r.text.split(/\n(?=\S)/);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatch(/^a security MEDIUM /);
    expect(blocks[1]).toMatch(/^b security HIGH /);
    expect(blocks[1]).toContain("remedy: drop X");
    expect(
      rows()
        .sort((x, y) => x.id - y.id)
        .map((x) => x.level),
    ).toEqual(["medium", "high"]);
  });

  it("an unknown role is an error and stores nothing", async () => {
    configure(on());
    const r = await run({ text: "x", role: "ghost" });
    expect(r.error).toBe(true);
    expect(r.text).toContain('no swarm role "ghost"');
    expect(rows()).toEqual([]);
  });

  it("autonomy raises the level of the same work", async () => {
    configure(on());
    const base = {
      text: unique("fetch https://a.example/doc and run the script"),
      tools: ["Read", "WebFetch", "Bash"],
    };
    const manual = await run({ ...base, autonomy: "manual" });
    const auto = await run({ ...base, autonomy: "autonomous" });
    expect(manual.text).toMatch(/autonomy: manual/);
    expect(auto.text).toMatch(/autonomy: autonomous/);
    const [a, b] = rows().sort((x, y) => x.id - y.id);
    expect(b!.score).toBeGreaterThanOrEqual(a!.score);
  });

  it("asks the model with security.model provider: the raise, the link to the routing row, and explain", async () => {
    configure({ enabled: true, provider: "embedding", ...on({ model: "provider" }) });
    const { p, calls } = provider(HIGH_ANSWER);
    const text = unique("Refactor the parser module");
    const r = await run({ text, tools: ["Read", "Edit", "Bash"] }, { provider: p });
    expect(calls).toHaveLength(1);
    // ids and capability tags only
    expect(calls[0]![0]!.hints?.security).toEqual({
      tools: ["Read", "Edit", "Bash"],
      caps: expect.arrayContaining(["code-exec"]),
    });
    expect(r.text).toMatch(/security HIGH/);
    expect(r.text).toContain("jev");
    const [row] = rows();
    expect(row).toMatchObject({
      surface: "mcp",
      heuristicLevel: "medium",
      level: "high",
      modelLevel: "high",
      source: "blend",
    });
    expect(row!.adjudicationId).not.toBeNull();
    // explain {id} of the routing row appends the linked security assessment
    const ex = await runAdjudicate({ action: "explain", id: row!.adjudicationId! }, ctx, { db });
    const out = ex.content.map((c) => c.text).join("\n");
    expect(out).toContain(`Decision ${row!.adjudicationId}`);
    expect(out).toContain(`security assessment ${row!.id}: HIGH`);
    expect(out).toContain("heuristic MEDIUM");
    // security off: explain is what it was
    configure({ enabled: true });
    const plain = await runAdjudicate({ action: "explain", id: row!.adjudicationId! }, ctx, { db });
    expect(plain.content.map((c) => c.text).join("\n")).not.toContain("security assessment");
  });

  it("says why there is no model answer: an unsupported provider, a failing one", async () => {
    configure({ enabled: true, provider: "embedding", ...on({ model: "provider" }) });
    const { p } = provider();
    const none = await run(
      { text: unique("Refactor the lexer"), tools: ["Read", "Edit"] },
      { provider: p },
    );
    // the fake provider is not the typesafe one: it has no security questions
    expect(none.text).toMatch(/model: unsupported/);
    expect(rows()[0]!.modelStatus).toBe("unsupported");
    // a failing provider falls back to the heuristic and reports the status
    const failing: AdjudicatorProvider = {
      ...p,
      adjudicate: async () => {
        throw new Error("down");
      },
    };
    const r = await run(
      { text: unique("Refactor the lexer"), tools: ["Read", "Edit"] },
      { provider: failing },
    );
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/security (LOW|MEDIUM)/);
  });

  it("security only (the adjudicator off): heuristic only, no routing row, score still says off", async () => {
    configure(on({ model: "provider" }));
    const before = db.adjudicator.list().total;
    const r = await run({ text: unique("Refactor the lexer"), tools: ["Read", "Edit", "Bash"] });
    expect(r.text).toMatch(/^text security MEDIUM /);
    expect(rows()[0]).toMatchObject({ surface: "mcp", adjudicationId: null, modelStatus: "none" });
    expect(db.adjudicator.list().total).toBe(before);
    const score = await runAdjudicate({ action: "score", text: "x" }, ctx, { db });
    expect(score.content[0]!.text).toContain("The adjudicator is off");
  });

  it("security.store false: the block is the same, nothing is stored", async () => {
    configure(on({ store: false }));
    const r = await run({ text: unique("Refactor the lexer"), tools: ["Read", "Edit", "Bash"] });
    expect(r.text).toMatch(/^text security MEDIUM \d+ \(.+\) · advice only$/m);
    expect(r.text).not.toContain("assessment ");
    expect(rows()).toEqual([]);
  });
});
