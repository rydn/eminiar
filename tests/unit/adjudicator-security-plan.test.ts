import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Lets a test make the routing plan advice throw while security is on (it must stay on). */
const planFault = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("../../src/adjudicator/swarm.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/adjudicator/swarm.js")>();
  return {
    ...real,
    adjudicatePlan: async (...args: Parameters<typeof real.adjudicatePlan>) => {
      if (planFault.error) throw planFault.error;
      return real.adjudicatePlan(...args);
    },
  };
});

import { registerProvider, resetProviders } from "../../src/adjudicator/providers/index.js";
import { ADVISED_PICK_FIELD } from "../../src/adjudicator/savings.js";
import { FLOOR_LABEL, PLAN_LINE_MAX } from "../../src/adjudicator/security/advice.js";
import type { SecurityHint, SecurityModelAnswer } from "../../src/adjudicator/security/types.js";
import {
  type PlanAdvice,
  planLines,
  SECURITY_FLOOR_LABEL,
  taskRequest,
} from "../../src/adjudicator/swarm.js";
import type { AdjudicationRequest, AdjudicatorProvider } from "../../src/adjudicator/types.js";
import { ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { resetSwarmConfigCache } from "../../src/swarm/config.js";
import { type CallerStamp, resetSwarmSecret, signCaller } from "../../src/swarm/identity.js";
import type { SwarmSpec, TaskRow } from "../../src/swarm/types.js";
import { emSwarm } from "../../src/tools/em_swarm.js";

const YAML = `
version: 1
swarms:
  feat:
    description: test swarm
    max_agents: 4
    agents:
      reader:
        description: reads the code and summarises it
        tools: [Read, Grep, Glob]
      researcher:
        description: finds external options and sources on the web
        tools: [Read, WebFetch, WebSearch, Bash]
`;
const SESSION = "sess-sec-plan";

const savedEffortLevel = process.env.CLAUDE_CODE_EFFORT_LEVEL;
beforeAll(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
});
afterAll(() => {
  if (savedEffortLevel !== undefined) process.env.CLAUDE_CODE_EFFORT_LEVEL = savedEffortLevel;
});

const HIGH_ANSWER: SecurityModelAnswer = {
  severity: { value: 3.6, confidence: 0.9 },
  threats: { exfiltration: 0.91 },
};

/** Answers every key with `tier`; with `security`, each answer carries the security answer too. */
function fakeProvider(tier: string, security?: SecurityModelAnswer) {
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
          complexity: { value: 0.5, confidence: 0.95 },
          tier: { probs: { [tier]: 1 }, confidence: 0.95, calibrated: true },
          ...(security && r.hints?.security ? { security } : {}),
        })),
        usage: { inTok: 0, outTok: 0, costUsd: 0 },
        latencyMs: 3,
        model: "fake-embed",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 0, detail: "fake" };
    },
  };
  return { p, calls };
}

describe("em_swarm plan: security advice", () => {
  let root: string;
  let ctx: ProjectContext;
  let db: StorageAdapter;
  let main: CallerStamp;
  type Args = Parameters<typeof emSwarm.handler>[0];
  const call = async (args: Args) => {
    const r = await emSwarm.handler({ ...args, ...main }, ctx);
    return r.content.map((c) => c.text).join("\n");
  };
  /** Config for the next calls: the adjudicator (if any) and security. */
  const configure = (adjudicator: Record<string, unknown>) => {
    ctx.config = { ...ctx.config, ...ConfigSchema.parse({ adjudicator }) };
  };
  const securityOn = (over: Record<string, unknown> = {}) => ({
    security: { enabled: true, ...over },
  });
  // Unique text per test: the engine caches verdicts by request text, which would hide the call.
  let nonce = 0;
  const tasks = (): NonNullable<Args["tasks"]> => {
    nonce++;
    return [
      { title: `Fix a typo in the README, pass ${nonce}`, role: "reader" },
      {
        title: `Look up the licence of the lodash package, pass ${nonce}`,
        detail: "Read https://blog.example.com/caches",
        role: "researcher",
      },
    ];
  };
  const adjudications = () => db.adjudicator.list().total;
  const run = () => db.swarm.runs({ status: "active", limit: 1 })[0]!;

  beforeAll(() => {
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-sec-plan-"));
    resetSwarmSecret();
    main = signCaller({ kind: "main", sessionId: SESSION });
    root = mkdtempSync(join(tmpdir(), "em-sec-plan-"));
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
  beforeEach(async () => {
    resetProviders();
    planFault.error = undefined;
    db.security.purge();
    configure({});
    await call({ action: "start", swarm: "feat", goal: "g" });
  });
  afterEach(async () => {
    for (const r of db.swarm.runs({ status: "active", limit: 50 }))
      await call({ action: "finish", run: r.id, status: "cancelled" });
    resetProviders();
  });

  it("adds nothing and stores nothing while security is off", async () => {
    const { p, calls } = fakeProvider("haiku");
    registerProvider("embedding", () => p);
    configure({ enabled: true, provider: "embedding" });
    const out = await call({ action: "plan", tasks: tasks() });
    expect(out).not.toMatch(/security/i);
    expect(db.security.list({ limit: 10 }).total).toBe(0);
    // the engine request is what it was before security existed
    expect(calls[0]?.every((r) => r.hints && !("security" in r.hints))).toBe(true);
    expect(out).not.toContain(SECURITY_FLOOR_LABEL);
  });

  it("security only (the adjudicator off): the head and a line for the HIGH task, rows stored", async () => {
    configure(securityOn());
    const before = adjudications();
    const out = await call({ action: "plan", tasks: tasks() });
    const lines = out.split("\n");
    const headAt = lines.findIndex((l) => l.startsWith("Security (advice only): "));
    expect(headAt).toBeGreaterThan(0);
    expect(lines[headAt]).toBe("Security (advice only): 1 high, 1 medium · heuristic");
    const planned = db.swarm.tasks(run().id);
    const line = lines[headAt + 1] ?? "";
    expect(line).toMatch(
      new RegExp(
        `^#${planned[1]!.id} security HIGH \\d+ · .*drop X: disallowed_tools: \\[Bash\\] for researcher`,
      ),
    );
    expect(line.length).toBeLessThanOrEqual(PLAN_LINE_MAX);
    expect(lines).toHaveLength(headAt + 2);
    // no routing advice at all
    expect(out).not.toMatch(/Adjudicator suggestions|model (haiku|sonnet|opus)/);
    const rows = db.security.forRun(run().id);
    expect(rows.map((r) => [r.surface, r.level, r.taskId])).toEqual([
      ["plan", "medium", planned[0]!.id],
      ["plan", "high", planned[1]!.id],
    ]);
    expect(adjudications()).toBe(before);
  });

  it("minLevel medium gives every task a line; a low-risk plan still has its head", async () => {
    configure(securityOn({ minLevel: "medium" }));
    const out = await call({ action: "plan", tasks: tasks() });
    expect(out.split("\n").filter((l) => /^#\d+ security /.test(l))).toHaveLength(2);
    configure(securityOn());
    const quiet = await call({
      action: "plan",
      tasks: [{ title: "Rename a variable", role: "reader" }],
    });
    expect(quiet).toMatch(/^Security \(advice only\): 1 medium · heuristic$/m);
    expect(quiet).not.toMatch(/^#\d+ security /m);
  });

  it("plan surface off: nothing is added or stored", async () => {
    configure(securityOn({ surfaces: { plan: false } }));
    const out = await call({ action: "plan", tasks: tasks() });
    expect(out).not.toMatch(/security/i);
    expect(db.security.list({ limit: 10 }).total).toBe(0);
  });

  it("the routing advice floors a HIGH task's model, marks the line and the row, and links the rows", async () => {
    const { p, calls } = fakeProvider("haiku");
    registerProvider("embedding", () => p);
    configure({ enabled: true, provider: "embedding", ...securityOn({ modelFloor: "sonnet" }) });
    const out = await call({ action: "plan", tasks: tasks() });
    // model off: the engine request carries no security questions
    expect(calls[0]?.every((r) => r.hints && !("security" in r.hints))).toBe(true);
    const planned = db.swarm.tasks(run().id);
    const lineOf = (id: number) => out.split("\n").find((l) => l.startsWith(`#${id} → `)) ?? "";
    expect(lineOf(planned[0]!.id)).toMatch(/· model haiku · /);
    expect(lineOf(planned[0]!.id)).not.toContain(FLOOR_LABEL);
    expect(lineOf(planned[1]!.id)).toContain(`model sonnet (${FLOOR_LABEL}) · `);
    // the plan row keeps the raw verdict but advises the floored tier
    const [low, high] = planned.map((t) => db.adjudicator.forTask(run().id, t.id)[0]!);
    expect(low!.tier).toBe("haiku");
    expect(high!.tier).toBe("haiku");
    const pick = (r: typeof low) =>
      (JSON.parse(r!.scores!) as Record<string, unknown>)[ADVISED_PICK_FIELD];
    expect(pick(low)).toBe("haiku");
    expect(pick(high)).toBe("sonnet");
    // the security block follows the routing advice, and its rows sit beside the engine's
    expect(out.indexOf("Security (advice only)")).toBeGreaterThan(
      out.indexOf("Adjudicator suggestions"),
    );
    const rows = db.security.forRun(run().id);
    expect(rows.map((r) => r.adjudicationId)).toEqual([low!.id, high!.id]);
  });

  it("a MEDIUM task keeps a small model (the floor is for HIGH and CRITICAL)", async () => {
    const { p } = fakeProvider("haiku");
    registerProvider("embedding", () => p);
    configure({ enabled: true, provider: "embedding", ...securityOn({ modelFloor: "opus" }) });
    const out = await call({ action: "plan", tasks: tasks().slice(0, 1) });
    expect(out).toMatch(/· model haiku · /);
    expect(out).not.toContain(FLOOR_LABEL);
  });

  it("with security.model provider the questions ride on every request and a raise shows", async () => {
    const { p, calls } = fakeProvider("haiku", HIGH_ANSWER);
    registerProvider("embedding", () => p);
    configure({ enabled: true, provider: "embedding", ...securityOn({ model: "provider" }) });
    const out = await call({ action: "plan", tasks: tasks() });
    expect(calls).toHaveLength(1);
    const hints = calls[0]!.map((r) => r.hints?.security);
    expect(hints.every((h) => h && h.tools.length > 0)).toBe(true);
    // ids and capability tags only
    expect(JSON.stringify(hints)).not.toMatch(/blog\.example|cache layer/);
    expect(out).toContain("Security (advice only): 2 high · model jev ok");
    expect(out).toMatch(/jev raised MEDIUM→HIGH \(sev 3\.6, exfil \.91\)/);
    const rows = db.security.forRun(run().id);
    expect(rows.map((r) => [r.heuristicLevel, r.level, r.source])).toEqual([
      ["medium", "high", "blend"],
      ["high", "high", "blend"],
    ]);
    // both tasks are HIGH now: neither names a tier below the floor
    const named = out.split("\n").filter((l) => /^#\d+ → /.test(l));
    expect(named).toHaveLength(2);
    for (const l of named) expect(l).toMatch(/· model (sonnet|opus|fable)\b/);
  });

  it("adjudicator on but plan advice off: the security block is the heuristic's alone", async () => {
    configure({ enabled: true, surfaces: { plan: false }, ...securityOn({ model: "provider" }) });
    const before = adjudications();
    const out = await call({ action: "plan", tasks: tasks() });
    expect(out).toContain("Security (advice only): 1 high, 1 medium · heuristic");
    expect(out).not.toContain("Adjudicator suggestions");
    expect(adjudications()).toBe(before);
  });

  it("fails open: a failing routing advice leaves the security block", async () => {
    configure({ enabled: true, provider: "embedding", ...securityOn() });
    planFault.error = new Error("boom");
    const out = await call({ action: "plan", tasks: tasks() });
    expect(out).toContain("Adjudicator advice unavailable for this plan");
    expect(out).toContain("Security (advice only): 1 high, 1 medium · heuristic");
    expect(db.security.forRun(run().id)).toHaveLength(2);
  });

  it("a worker may plan too: the same block", async () => {
    configure(securityOn());
    const out = await call({ action: "plan", tasks: tasks().slice(1) });
    expect(out).toMatch(/^Security \(advice only\): 1 high · heuristic$/m);
  });
});

describe("plan helpers", () => {
  const swarm = { name: "feat", roles: [] } as unknown as SwarmSpec;
  const task = {
    id: 7,
    title: "t",
    detail: "d",
    files: [],
    deps: [],
    role: null,
  } as unknown as TaskRow;

  it("taskRequest adds hints.security only when a hint is given", () => {
    const plain = taskRequest(task, swarm);
    expect(plain.hints).toEqual({ roles: [], files: 0, deps: 0 });
    expect(JSON.stringify(taskRequest(task, swarm, undefined))).toBe(JSON.stringify(plain));
    const hint: SecurityHint = { tools: ["Read", "Bash"], caps: ["code-exec"] };
    expect(taskRequest(task, swarm, hint).hints?.security).toEqual(hint);
  });

  it("a floored line says so, for a plain, a pinned and a forced model", () => {
    expect(SECURITY_FLOOR_LABEL).toBe(FLOOR_LABEL);
    const base: PlanAdvice = {
      taskId: 5,
      agentType: "swarm-feat-researcher",
      model: "sonnet",
      effort: "low",
      complexity: 1,
      confidence: 0.8,
    };
    expect(planLines([base])[0]).toContain("· model sonnet · effort low");
    expect(planLines([{ ...base, floored: true }])[0]).toContain(
      "· model sonnet (security floor) · effort low",
    );
    expect(
      planLines([{ ...base, floored: true, pin: { status: "pinned", model: "opus" } }])[0],
    ).toMatch(/pinned opus .*\) \(security floor\) · effort/);
    expect(planLines([{ ...base, floored: true, forced: true }])[0]).toContain(
      "model sonnet (informational) (security floor)",
    );
  });
});
