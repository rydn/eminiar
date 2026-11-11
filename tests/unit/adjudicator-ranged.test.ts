/**
 * Ranged swarm roles in dispatch (task #104): resolveAgentPin's `ranged` status, the ranged row
 * of dispatchRule, plan advice (lines, head, Next, plan-row flags, the all-pinned nudge) and the
 * PreToolUse(Agent) hook (apply sets the pick inside the range, never over an explicit model,
 * FORCE, a fork or a low confidence; the savings baseline is the fallback). Also the role-note
 * gate and the saturated-brief effort that every Agent note and plan line now follow.
 *
 * Task #107 adds, around those: swarm.yaml model_range through to the pin the adjudicator reads
 * (refusals and their boundaries, defaults inheritance, byte-identical files without a range);
 * the full dispatchRule table and the rangedTier clamp against an independent oracle, also driven
 * through the hook for every verdict x apply bound; fail-open and off paths; and the savings side
 * (rangedFallback, the baseline order, the env baseline with FORCE off, reconcile pricing a ranged
 * dispatch against its fallback). Tests stub the provider and take no env from the machine.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAgentPin } from "../../src/adjudicator/agent-pin.js";
import { afterRouting, clampTier, onPreAgent, onPrompt } from "../../src/adjudicator/hooks.js";
import { reconcile } from "../../src/adjudicator/learn.js";
import {
  ADVISED_PICK_FIELD,
  advisedPick,
  FALLBACK_MODEL,
  FALLBACK_PIN_FIELD,
  keptModel,
  RANGED_FLAG,
  rangedFallback,
  repriceAt,
  resolveBaseline,
  SAVINGS_ASSUMPTIONS,
  savingsReport,
  tierOf,
  withKeptModel,
} from "../../src/adjudicator/savings.js";
import {
  ALL_PINNED_NOTE,
  adjudicatePlan,
  appliedTier,
  type DispatchFacts,
  type DispatchRule,
  dispatchRule,
  keptModelOf,
  type PlanAdvice,
  type PlanRange,
  planAdviceBlock,
  planAdviceHead,
  planLines,
  planNextHint,
  planPassing,
  ROLE_NOTE_MIN,
  rangedPart,
  rangedPasses,
  rangedTier,
} from "../../src/adjudicator/swarm.js";
import {
  type AdjudicationRequest,
  type AdjudicationRow,
  type AdjudicatorProvider,
  type ProviderResult,
  TIERS,
  type Tier,
} from "../../src/adjudicator/types.js";
import { type Config, ConfigSchema } from "../../src/config.js";
import { getContext, type ProjectContext } from "../../src/context.js";
import type { HookInput } from "../../src/hooks/types.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import type { ApiCallInput } from "../../src/storage/types.js";
import { agentFileRange, renderAgentFile, syncAgents } from "../../src/swarm/agents.js";
import { parseSwarmYaml } from "../../src/swarm/config.js";
import type { ConfigIssue, ModelRange, SwarmConfig, SwarmSpec } from "../../src/swarm/types.js";
import { resolvePrice } from "../../src/usage/pricing.js";

const ENV_KEYS = [
  "EMINIAR_HOME",
  "HOME",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL",
];
const saved: Record<string, string | undefined> = {};
let home: string;

beforeAll(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-ranged-home-"));
  // User-level agents are read from HOME: keep the real ~/.claude out.
  home = mkdtempSync(join(tmpdir(), "em-ranged-user-"));
  process.env.HOME = home;
});
afterAll(() => {
  closeAllStorage();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** coder moves haiku..opus around sonnet; tester haiku..sonnet around haiku; lead sonnet..opus. */
const YAML = `
version: 1
swarms:
  rng:
    description: ranged swarm
    agents:
      coder:
        description: writes code
        model: sonnet
        model_range: { floor: haiku, ceiling: opus }
      tester:
        description: writes tests
        model: haiku
        model_range: { ceiling: sonnet }
      lead:
        description: leads the work
        model: sonnet
        model_range: { ceiling: opus }
      reviewer:
        description: reviews changes
        model: opus
`;
const PINNED_YAML = `
version: 1
swarms:
  pin:
    description: pinned swarm
    agents:
      coder:
        description: writes code
        model: sonnet
      reviewer:
        description: reviews changes
        model: opus
`;

interface Project {
  root: string;
  swarm: SwarmSpec;
}

/** A project whose agent files `eminiar swarm sync` wrote from `yaml`. */
function project(yaml = YAML): Project {
  const root = mkdtempSync(join(tmpdir(), "em-ranged-proj-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".git"));
  const r = parseSwarmYaml(yaml, join(root, ".eminiar", "swarm.yaml"), ".eminiar/swarm.yaml");
  if (r.state !== "ok") throw new Error(JSON.stringify(r));
  syncAgents(root, r.config);
  return { root, swarm: r.config.swarms[0]! };
}

const configWith = (adjudicator: Record<string, unknown>): Config =>
  ConfigSchema.parse({ adjudicator });

/** A generated agent file with a valid marker hash (what sync would write, made by hand). */
function generated(name: string, model: string, range: string, body = "\nYou are a worker.\n") {
  const fm = `name: ${name}\ndescription: d\nmodel: ${model}`;
  const hash = createHash("sha1")
    .update(`range=${range}\n${fm}\n${body}`)
    .digest("hex")
    .slice(0, 12);
  return `---\n${fm}\n---\n<!-- eminiar:swarm swarm=s role=r range=${range} hash=${hash} · generated from .eminiar/swarm.yaml by \`eminiar swarm sync\`; edit the YAML, not this file (it is overwritten). -->\n${body}`;
}

/** A provider that answers every request with `tier` (confidence 0.9) and counts its calls. */
function stubProvider(tier: Tier, complexity = 1): AdjudicatorProvider & { calls: number } {
  const p = {
    id: "openai-compatible" as const,
    remote: false,
    dims: ["complexity", "tier"] as Array<"complexity" | "tier">,
    calls: 0,
    async adjudicate(reqs: AdjudicationRequest[]): Promise<ProviderResult> {
      p.calls++;
      return {
        answers: reqs.map((r) => ({
          key: r.key,
          complexity: { value: complexity, confidence: 0.9 },
          tier: { probs: { [tier]: 1 }, confidence: 0.9, calibrated: true },
        })),
        usage: { inTok: 10, outTok: 5, costUsd: 0 },
        latencyMs: 3,
        model: "stub",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 1, detail: "" };
    },
  };
  return p;
}

/** An api_calls row at list price: a sidechain worker's when it has an `agent_id`, else the session's. */
function apiCall(
  over: Partial<ApiCallInput> & Pick<ApiCallInput, "session_id" | "model">,
): ApiCallInput {
  const id = Math.random().toString(36).slice(2, 10);
  return {
    request_id: `r-${id}`,
    message_id: `m-${id}`,
    agent_id: null,
    sidechain: 0,
    ts: Date.now() - 60_000,
    input_tokens: 1000,
    output_tokens: 500,
    cache_create_5m: 0,
    cache_create_1h: 0,
    cache_read: 0,
    thinking_tokens: 0,
    web_searches: 0,
    web_fetches: 0,
    service_tier: null,
    speed: null,
    stop_reason: null,
    prompt_id: null,
    git_branch: null,
    cwd: null,
    effort: null,
    version: null,
    entrypoint: null,
    ...over,
  };
}

describe("resolveAgentPin: ranged swarm agents (#104)", () => {
  const look = (root: string, type: string) =>
    resolveAgentPin(type, { root, env: { HOME: home }, managedDir: null });

  it("a synced role with model_range is ranged (fallback + range); one without stays pinned", () => {
    const { root } = project();
    expect(look(root, "swarm-rng-coder")).toMatchObject({
      status: "ranged",
      model: "sonnet",
      range: { floor: "haiku", ceiling: "opus" },
      source: "project",
    });
    expect(look(root, "swarm-rng-tester")).toMatchObject({
      status: "ranged",
      model: "haiku",
      range: { floor: "haiku", ceiling: "sonnet" },
    });
    const reviewer = look(root, "swarm-rng-reviewer");
    expect(reviewer).toMatchObject({
      status: "pinned",
      model: "opus",
      source: "project",
    });
    expect(reviewer.range).toBeUndefined();
  });

  it("a hand edit, or a range that is not a real range around the fallback, is the plain pin", () => {
    const { root } = project();
    const dir = join(root, ".claude", "agents");
    const coder = join(dir, "swarm-rng-coder.md");
    writeFileSync(coder, `${readFileSync(coder, "utf8")}One more line.\n`);
    expect(look(root, "swarm-rng-coder")).toMatchObject({
      status: "pinned",
      model: "sonnet",
    });

    // the helper writes what sync would: its range is read back
    expect(agentFileRange(generated("ok", "sonnet", "haiku..opus"))).toEqual({
      floor: "haiku",
      ceiling: "opus",
    });
    const cases: Array<[string, string, string]> = [
      ["outside", "opus", "haiku..sonnet"], // the fallback above the ceiling
      ["one-tier", "sonnet", "sonnet..sonnet"],
      ["planner", "opusplan", "sonnet..opus"], // no one tier
      ["unknown-id", "gpt-5", "haiku..opus"],
    ];
    for (const [name, model, range] of cases) {
      writeFileSync(join(dir, `${name}.md`), generated(name, model, range));
      const pin = look(root, name);
      expect(pin.status, name).toBe("pinned");
      expect(pin.range, name).toBeUndefined();
    }
    // a model id or a [1m] variant is a fallback like the alias
    writeFileSync(join(dir, "full.md"), generated("full", "claude-sonnet-4-5", "haiku..opus"));
    writeFileSync(join(dir, "wide.md"), generated("wide", "sonnet[1m]", "sonnet..fable"));
    expect(look(root, "full")).toMatchObject({
      status: "ranged",
      model: "claude-sonnet-4-5",
    });
    expect(look(root, "wide")).toMatchObject({
      status: "ranged",
      model: "sonnet[1m]",
      range: { floor: "sonnet", ceiling: "fable" },
    });
  });

  it("same-name definitions must agree on the range too; inherit is unpinned and says so", () => {
    const { root } = project();
    const dir = join(root, ".claude", "agents");
    mkdirSync(join(dir, "more"), { recursive: true });
    writeFileSync(join(dir, "d1.md"), generated("dup", "sonnet", "haiku..opus"));
    writeFileSync(join(dir, "more", "d2.md"), generated("dup", "sonnet", "haiku..sonnet"));
    expect(look(root, "dup")).toMatchObject({
      status: "pinned",
      model: "sonnet",
    });
    writeFileSync(join(dir, "s1.md"), generated("same", "sonnet", "haiku..opus"));
    writeFileSync(join(dir, "more", "s2.md"), generated("same", "sonnet", "haiku..opus"));
    expect(look(root, "same")).toMatchObject({
      status: "ranged",
      model: "sonnet",
    });
    writeFileSync(join(dir, "p1.md"), generated("part", "sonnet", "haiku..opus"));
    writeFileSync(join(dir, "more", "p2.md"), "---\nname: part\nmodel: sonnet\n---\nb\n");
    expect(look(root, "part").status).toBe("pinned");

    writeFileSync(join(dir, "inh.md"), "---\nname: inh\nmodel: inherit\n---\nb\n");
    writeFileSync(join(dir, "bare.md"), "---\nname: bare\n---\nb\n");
    writeFileSync(join(dir, "inh-ranged.md"), generated("inh-ranged", "inherit", "haiku..opus"));
    expect(look(root, "inh")).toMatchObject({
      status: "unpinned",
      inherit: true,
    });
    expect(look(root, "inh-ranged")).toMatchObject({
      status: "unpinned",
      inherit: true,
    });
    expect(look(root, "bare").inherit).toBeUndefined();
    expect(look(root, "general-purpose").inherit).toBeUndefined();
  });

  it("the first location that has the name decides: managed, then project, then user (#107)", () => {
    const { root } = project();
    const dir = join(root, ".claude", "agents");
    const userDir = join(home, ".claude", "agents");
    const managed = mkdtempSync(join(tmpdir(), "em-ranged-managed-"));
    mkdirSync(join(managed, ".claude", "agents"), { recursive: true });
    mkdirSync(userDir, { recursive: true });
    const plain = (name: string, model: string) => `---\nname: ${name}\nmodel: ${model}\n---\nb\n`;

    // a ranged user file alone is ranged, and says where it came from
    writeFileSync(join(userDir, "scope-solo.md"), generated("scope-solo", "sonnet", "haiku..opus"));
    expect(look(root, "scope-solo")).toMatchObject({
      status: "ranged",
      source: "user",
    });
    // a plain project file of the same name hides it
    writeFileSync(join(dir, "scope-both.md"), plain("scope-both", "opus"));
    writeFileSync(join(userDir, "scope-both.md"), generated("scope-both", "sonnet", "haiku..opus"));
    expect(look(root, "scope-both")).toMatchObject({
      status: "pinned",
      model: "opus",
      source: "project",
    });
    // and a ranged project file hides a plain user one
    writeFileSync(join(dir, "scope-up.md"), generated("scope-up", "sonnet", "haiku..opus"));
    writeFileSync(join(userDir, "scope-up.md"), plain("scope-up", "haiku"));
    expect(look(root, "scope-up")).toMatchObject({
      status: "ranged",
      source: "project",
    });
    // a managed definition outranks the project's
    writeFileSync(
      join(managed, ".claude", "agents", "m.md"),
      generated("scope-managed", "sonnet", "haiku..opus"),
    );
    writeFileSync(join(dir, "scope-managed.md"), plain("scope-managed", "haiku"));
    expect(
      resolveAgentPin("scope-managed", {
        root,
        env: { HOME: home },
        managedDir: managed,
      }),
    ).toMatchObject({ status: "ranged", source: "managed", model: "sonnet" });
    expect(look(root, "scope-managed")).toMatchObject({
      status: "pinned",
      model: "haiku",
    });
  });

  it("a marker range that names no real range is an edit, and a file too large to read pins nothing (#107)", () => {
    const { root } = project();
    const dir = join(root, ".claude", "agents");
    // the hash is right for the text it was made from, but the range itself is nonsense
    for (const [name, range] of [
      ["bad-tier", "haiku..banana"],
      ["inverted", "opus..haiku"],
      ["upper", "Haiku..Opus"],
      ["three", "haiku..sonnet..opus"],
    ] as const) {
      writeFileSync(join(dir, `${name}.md`), generated(name, "sonnet", range));
      const pin = look(root, name);
      expect(pin, name).toMatchObject({ status: "pinned", model: "sonnet" });
      expect(pin.range, name).toBeUndefined();
    }
    // the scan skips a file over 256 KiB: the agent is then not found, which is `unknown`, never
    // `unpinned` or ranged (apply mode never overrides what it cannot read)
    const big = generated("big", "sonnet", "haiku..opus", `\n${"x".repeat(300 * 1024)}\n`);
    writeFileSync(join(dir, "big.md"), big);
    const unread = look(root, "big");
    expect(unread.status).toBe("unknown");
    expect(unread.range).toBeUndefined();
  });

  it("a generated file checked out with CRLF line ends still ranges; a byte-order mark counts as an edit (#107)", () => {
    const { root } = project();
    const dir = join(root, ".claude", "agents");
    writeFileSync(
      join(dir, "crlf.md"),
      generated("crlf", "sonnet", "haiku..opus").replace(/\n/g, "\r\n"),
    );
    writeFileSync(join(dir, "bom.md"), `\uFEFF${generated("bom", "sonnet", "haiku..opus")}`);
    expect(look(root, "crlf")).toMatchObject({
      status: "ranged",
      model: "sonnet",
      range: { floor: "haiku", ceiling: "opus" },
    });
    const bom = look(root, "bom");
    expect(bom).toMatchObject({ status: "pinned", model: "sonnet" });
    expect(bom.range).toBeUndefined();
  });
});

describe("dispatchRule and plan lines: the ranged row (#104)", () => {
  it("ranged sits after the fork and FORCE and before the pin; saturation makes effort informational", () => {
    expect(
      dispatchRule({
        fork: true,
        forced: true,
        ranged: true,
        effortSet: false,
      }),
    ).toEqual({
      model: "fork",
      effort: "fork",
    });
    expect(dispatchRule({ forced: true, ranged: true, effortSet: false })).toEqual({
      model: "forced",
      effort: "pass",
    });
    expect(
      dispatchRule({
        forced: false,
        ranged: true,
        pin: true,
        effortSet: false,
      }),
    ).toEqual({
      model: "ranged",
      effort: "pass",
    });
    expect(
      dispatchRule({
        forced: false,
        pin: true,
        effortSet: false,
        saturated: true,
      }),
    ).toEqual({
      model: "pin",
      effort: "informational",
    });
    // a moving ranged pick is creditable advice, like `pass`
    expect(keptModelOf({ model: "ranged", effort: "pass" })).toBeUndefined();
  });

  it("without the new facts every old row is exactly what it was", () => {
    for (const fork of [false, true])
      for (const forced of [false, true])
        for (const pin of [false, true])
          for (const effortSet of [false, true]) {
            const old = fork
              ? { model: "fork", effort: "fork" }
              : {
                  model: forced ? "forced" : pin ? "pin" : "pass",
                  effort: effortSet ? "informational" : "pass",
                };
            const label = JSON.stringify({ fork, forced, pin, effortSet });
            expect(dispatchRule({ fork, forced, pin, effortSet }), label).toEqual(old);
            expect(
              dispatchRule({
                fork,
                forced,
                pin,
                effortSet,
                ranged: false,
                saturated: false,
              }),
              label,
            ).toEqual(old);
          }
  });

  it("rangedTier clamps into the role's range ∩ apply.floor..ceiling", () => {
    const R = { floor: "haiku", ceiling: "opus" } as const;
    expect(TIERS.map((t) => rangedTier(t, R, "haiku", "opus"))).toEqual([
      "haiku",
      "sonnet",
      "opus",
      "opus",
    ]);
    expect(
      TIERS.map((t) => rangedTier(t, { floor: "sonnet", ceiling: "fable" }, "haiku", "opus")),
    ).toEqual(["sonnet", "sonnet", "opus", "opus"]);
    expect(rangedTier("opus", R, "haiku", "sonnet")).toBe("sonnet");
    expect(rangedTier("haiku", R, "sonnet", "opus")).toBe("sonnet");
    // the two do not meet, or the tier is not on the ladder: no pick, the fallback stays
    expect(
      rangedTier("haiku", { floor: "opus", ceiling: "fable" }, "haiku", "sonnet"),
    ).toBeUndefined();
    expect(rangedTier("gpt-5", R, "haiku", "opus")).toBeUndefined();
    expect(rangedTier(undefined, R, "haiku", "opus")).toBeUndefined();
    // apply.floor above apply.ceiling is read like hooks.ts clampTier: the floor wins
    expect(rangedTier("haiku", R, "sonnet", "haiku")).toBe("sonnet");
  });

  const range: PlanRange = {
    floor: "haiku",
    ceiling: "opus",
    fallback: "sonnet",
  };
  const base: PlanAdvice = {
    taskId: 3,
    role: "coder",
    agentType: "swarm-rng-coder",
    effort: "low",
    complexity: 1,
    confidence: 0.9,
  };

  it("a line names the pick, its range and the fallback, or the fallback it keeps", () => {
    expect(rangedPart(range, "opus")).toBe("model opus (range haiku–opus, fallback sonnet)");
    expect(
      planLines([
        { ...base, model: "haiku", range },
        { ...base, taskId: 4, model: "sonnet", range },
        {
          ...base,
          taskId: 5,
          model: "sonnet",
          range: { ...range, fallback: "claude-sonnet-4-5" },
        },
        { ...base, taskId: 6, range },
      ]),
    ).toEqual([
      "#3 → swarm-rng-coder · model haiku (range haiku–opus, fallback sonnet) · effort low (complexity 1, conf 0.90)",
      "#4 → swarm-rng-coder · fallback sonnet (range haiku–opus; matches the adjudicator's pick) · effort low (complexity 1, conf 0.90)",
      "#5 → swarm-rng-coder · fallback claude-sonnet-4-5 (range haiku–opus; matches the adjudicator's pick) · effort low (complexity 1, conf 0.90)",
      "#6 → swarm-rng-coder · fallback sonnet (range haiku–opus; no pick inside apply.floor..ceiling) · effort low (complexity 1, conf 0.90)",
    ]);
  });

  it("the head and Next pass `model` for a moving pick and keep the fallback like a pin", () => {
    const moves: PlanAdvice = { ...base, model: "haiku", range };
    const stays: PlanAdvice = { ...base, taskId: 4, model: "sonnet", range };
    expect(planPassing([moves], {})).toMatchObject({
      model: true,
      pinned: false,
      effort: true,
    });
    expect(planPassing([stays], {})).toMatchObject({
      model: false,
      pinned: true,
      effort: true,
    });
    expect(planNextHint([moves], {})).toBe(
      ", passing `model` and `effort` as each suggestion below says",
    );
    expect(planNextHint([moves, stays], {})).toBe(
      ", passing `model` and `effort` as each suggestion below says; leave `model` unset for pinned agents",
    );
    expect(planAdviceHead([stays], {})).toBe(
      "Adjudicator suggestions: pass the effort as `effort` (Claude Code 2.1.292 or later) on each Agent call; a pinned agent keeps its model: pass no `model`:",
    );
  });

  it("a saturated brief's effort is informational on its line, in the head and in Next", () => {
    const sat: PlanAdvice = {
      ...base,
      model: "opus",
      effort: "max",
      complexity: 4,
      saturated: true,
    };
    expect(planLines([sat])[0]).toBe(
      "#3 → swarm-rng-coder · model opus · effort max: informational (brief saturated; complexity 4, conf 0.90)",
    );
    const why = "every brief is saturated, naming more work than its hardest statement scores";
    expect(planAdviceHead([sat], {})).toBe(
      `Adjudicator suggestions: pass the model as \`model\` on each Agent call (effort is informational: ${why}):`,
    );
    expect(planNextHint([sat], {})).toBe(", passing `model` as each suggestion below says");
    const pinnedSat: PlanAdvice = {
      ...sat,
      pin: { status: "pinned", model: "opus" },
    };
    expect(planNextHint([pinnedSat], {})).toBe(
      `; the suggestions below are informational: leave \`model\` unset for pinned agents and pass no \`effort\` (${why})`,
    );
    // some saturated, some not: the head says why those lines are informational
    const plain: PlanAdvice = { ...base, taskId: 4, model: "haiku" };
    expect(planAdviceHead([sat, plain], {})).toBe(
      "Adjudicator suggestions: pass the model as `model` and the effort as `effort` on each Agent call (`effort` needs Claude Code 2.1.292 or later); a saturated brief's effort is informational: pass no `effort`:",
    );
    // CLAUDE_CODE_EFFORT_LEVEL already makes every effort informational: the env is the reason
    expect(planAdviceHead([sat], { CLAUDE_CODE_EFFORT_LEVEL: "high" })).toBe(
      "Adjudicator suggestions: pass the model as `model` on each Agent call (effort is informational: CLAUDE_CODE_EFFORT_LEVEL is set and outranks `effort`):",
    );
    // under FORCE the effort is the only thing to pass, and a saturated one is not
    expect(
      planAdviceHead([{ ...sat, forced: true }], {
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      }),
    ).toMatch(new RegExp(`the model is informational; ${why}, so effort is too\\):$`));
  });

  it("the block nudges when every role pins a model, right under its head", () => {
    expect(ALL_PINNED_NOTE).toBe(
      "every role pins a model: the adjudicator cannot change any worker's model (add model_range in swarm.yaml)",
    );
    const pinned: PlanAdvice = {
      ...base,
      model: "haiku",
      pin: { status: "pinned", model: "opus" },
      allRolesPinned: true,
    };
    const block = planAdviceBlock([pinned, { ...pinned, taskId: 4 }], {}).split("\n");
    expect(block).toHaveLength(4);
    expect(block[0]).toMatch(/^Adjudicator suggestions: /);
    expect(block[1]).toBe(ALL_PINNED_NOTE);
    expect(planAdviceBlock([pinned, { ...pinned, allRolesPinned: undefined }], {})).not.toContain(
      ALL_PINNED_NOTE,
    );
  });

  it("a line suggests another role only from a role-table confidence of ROLE_NOTE_MIN (#107)", () => {
    expect(ROLE_NOTE_MIN).toBe(0.7);
    const line = (over: Partial<PlanAdvice>) =>
      planLines([{ ...base, suggestedRole: "reviewer", ...over }])[0]!;
    expect(line({ roleConfidence: 0.7 })).toMatch(/; role suggested: reviewer \(planned: coder\)$/);
    expect(line({ roleConfidence: 0.69 })).not.toMatch(/role suggested/);
    expect(line({})).not.toMatch(/role suggested/);
    // no planned role: the suggestion stands alone; the planned role suggested again is no news
    expect(line({ roleConfidence: 0.95, role: undefined })).toMatch(/; role suggested: reviewer$/);
    expect(line({ roleConfidence: 0.95, role: "reviewer" })).not.toMatch(/role suggested/);
    expect(line({ roleConfidence: 0.95, suggestedRole: undefined })).not.toMatch(/role suggested/);
  });
});

describe("adjudicatePlan with ranged swarm agents (#104)", () => {
  const plan = async (
    p: Project,
    tasks: Array<[string, string]>,
    adjudicator: Record<string, unknown> = {},
    env: NodeJS.ProcessEnv = {},
  ) => {
    const ctx = {
      root: p.root,
      config: configWith({ enabled: true, ...adjudicator }),
    };
    const db = getStorage(getContext(p.root), { vectors: false });
    const run = db.swarm.runCreate({
      id: `rng-${Math.random().toString(36).slice(2, 8)}`,
      swarm: p.swarm.name,
      goal: "g",
      topology: "hierarchical",
    });
    const rows = tasks.map(([title, role]) => db.swarm.taskAdd({ run_id: run.id, title, role }));
    const advice = await adjudicatePlan(ctx, db, run, p.swarm, rows, {
      provider: null,
      env: { HOME: home, ...env },
    });
    const scores = (a: PlanAdvice | undefined) =>
      JSON.parse(db.adjudicator.get(a!.rowId!)?.scores ?? "{}") as Record<string, unknown>;
    return { advice, db, scores };
  };

  it("a ranged role gets the pick inside its range; its plan row carries the ranged flags", async () => {
    const p = project();
    const { advice, db, scores } = await plan(p, [
      ["Rename a variable in the coder module", "coder"],
      ["Rename a variable in the tester module", "tester"],
      ["Rename a variable in the reviewer module", "reviewer"],
    ]);
    // the heuristic scores each of these haiku
    expect(advice.map((a) => db.adjudicator.get(a.rowId!)?.tier)).toEqual([
      "haiku",
      "haiku",
      "haiku",
    ]);
    const [coder, tester, reviewer] = advice;
    expect(coder).toMatchObject({
      model: "haiku",
      range: {
        floor: "haiku",
        ceiling: "opus",
        fallback: "sonnet",
        source: "project",
      },
    });
    expect(coder!.pin).toBeUndefined();
    // haiku is the tester's own fallback: nothing to pass
    expect(tester).toMatchObject({
      model: "haiku",
      range: { fallback: "haiku" },
    });
    expect(reviewer!.pin).toMatchObject({ status: "pinned", model: "opus" });
    expect(advice.some((a) => a.allRolesPinned)).toBe(false);

    const lines = planLines(advice);
    expect(lines[0]).toMatch(
      /^#\d+ → swarm-rng-coder · model haiku \(range haiku–opus, fallback sonnet\) · effort low /,
    );
    expect(lines[1]).toMatch(
      /^#\d+ → swarm-rng-tester · fallback haiku \(range haiku–sonnet; matches the adjudicator's pick\) · /,
    );
    expect(lines[2]).toMatch(
      /^#\d+ → swarm-rng-reviewer · pinned opus \(adjudicator would pick haiku; /,
    );
    expect(planNextHint(advice, {})).toBe(
      ", passing `model` and `effort` as each suggestion below says; leave `model` unset for pinned agents",
    );

    expect(scores(coder)).toMatchObject({
      [RANGED_FLAG]: true,
      [FALLBACK_PIN_FIELD]: "sonnet",
      pin: {
        status: "ranged",
        model: "sonnet",
        range: { floor: "haiku", ceiling: "opus" },
      },
    });
    expect(scores(coder).pinDeferred).toBeUndefined();
    expect(scores(tester)).toMatchObject({
      ranged: true,
      fallbackPin: "haiku",
      pinDeferred: true,
    });
    expect(scores(reviewer)).toMatchObject({ pinDeferred: true });
    expect(scores(reviewer).ranged).toBeUndefined();
    const coderRow = db.adjudicator.get(coder!.rowId!)!;
    expect(rangedFallback(coderRow)).toBe("sonnet");
    expect(coderRow.baselineModel).toBe("sonnet");
    // the pick the line names, for follow detection (#126)
    expect(coder!.model).toBeDefined();
    expect(advisedPick(coderRow)).toBe(coder!.model);
  });

  it("apply.floor..ceiling narrows the range; FORCE or respectFrontmatter off drops it", async () => {
    const p = project();
    const task: Array<[string, string]> = [["Rename a variable in the coder module", "coder"]];
    // haiku, raised to the apply floor sonnet: the coder's fallback, so it is kept
    const floor = await plan(p, task, { apply: { floor: "sonnet" } });
    expect(floor.advice[0]).toMatchObject({
      model: "sonnet",
      range: { fallback: "sonnet" },
    });
    expect(floor.scores(floor.advice[0])).toMatchObject({
      ranged: true,
      pinDeferred: true,
    });

    const forced = await plan(p, task, {}, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    expect(forced.advice[0]).toMatchObject({ forced: true, model: "haiku" });
    expect(forced.advice[0]!.range).toBeUndefined();
    expect(forced.scores(forced.advice[0])).toMatchObject({ forced: true });
    expect(forced.scores(forced.advice[0]).ranged).toBeUndefined();

    const free = await plan(p, task, { apply: { respectFrontmatter: false } });
    expect(free.advice[0]).toMatchObject({ model: "haiku" });
    expect(free.advice[0]!.range).toBeUndefined();
    expect(free.advice[0]!.pin).toBeUndefined();
  });

  it("a saturated brief's line shows its effort as informational", async () => {
    const p = project();
    const { advice } = await plan(p, [
      [
        "Redesign the storage layer across every adapter and migration\nMigrate every caller to the new adapter interface. Rewrite the sync engine and the conflict resolver. Add a migration path for old databases, with rollback. Audit the security of the auth flow and the session store. Refactor the hook bundle split across all modules.",
        "coder",
      ],
    ]);
    expect(advice[0]!.saturated).toBe(true);
    expect(planLines(advice)[0]).toMatch(
      /^#\d+ → swarm-rng-coder · model opus \(range haiku–opus, fallback sonnet\) · effort \w+: informational \(brief saturated; complexity 4, /,
    );
  });

  it("every role pinned without a range: the block nudges, but not under FORCE or with pins ignored", async () => {
    const p = project(PINNED_YAML);
    const task: Array<[string, string]> = [["Rename a variable in the coder module", "coder"]];
    const pinned = await plan(p, task);
    expect(pinned.advice[0]!.allRolesPinned).toBe(true);
    expect(planAdviceBlock(pinned.advice, {}).split("\n")[1]).toBe(ALL_PINNED_NOTE);
    const forced = await plan(p, task, {}, { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    expect(forced.advice[0]!.allRolesPinned).toBeUndefined();
    const free = await plan(p, task, { apply: { respectFrontmatter: false } });
    expect(free.advice[0]!.allRolesPinned).toBeUndefined();
    // one ranged role is enough for the adjudicator to change a worker
    const ranged = await plan(project(), task);
    expect(ranged.advice[0]!.allRolesPinned).toBeUndefined();
  });

  it("fails open: a provider that never answers costs the plan budget, then the heuristic's pick is the advice (#107)", async () => {
    const p = project();
    const ctx = {
      root: p.root,
      config: configWith({
        enabled: true,
        provider: "openai-compatible",
        openai: { preset: "ollama" },
        timeouts: { planMs: 40, localMs: 40 },
      }),
    };
    const db = getStorage(getContext(p.root), { vectors: false });
    const run = db.swarm.runCreate({
      id: `hang-${Math.random().toString(36).slice(2, 8)}`,
      swarm: p.swarm.name,
      goal: "g",
      topology: "hierarchical",
    });
    const task = db.swarm.taskAdd({
      run_id: run.id,
      title: "Rename a variable in the coder module",
      role: "coder",
    });
    let asked = 0;
    const hangs: AdjudicatorProvider = {
      ...stubProvider("opus"),
      adjudicate: () => {
        asked++;
        return new Promise<ProviderResult>(() => {});
      },
    };
    const errors: unknown[] = [];
    const advice = await adjudicatePlan(ctx, db, run, p.swarm, [task], {
      provider: hangs,
      env: { HOME: home },
      onError: (e) => errors.push(e),
    });
    expect(asked).toBe(1);
    expect(errors).toEqual([]);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({
      model: "haiku",
      range: { floor: "haiku", ceiling: "opus", fallback: "sonnet" },
    });
    expect(planLines(advice)[0]).toMatch(
      /^#\d+ → swarm-rng-coder · model haiku \(range haiku–opus, fallback sonnet\) · /,
    );
  });

  it("gives no advice and stores nothing while the adjudicator or its plan surface is off (#107)", async () => {
    const p = project();
    const task: Array<[string, string]> = [["Rename a variable in the coder module", "coder"]];
    for (const off of [{ enabled: false }, { surfaces: { plan: false } }]) {
      const ctx = {
        root: p.root,
        config: configWith({ enabled: true, ...off }),
      };
      const db = getStorage(getContext(p.root), { vectors: false });
      const run = db.swarm.runCreate({
        id: `off-${Math.random().toString(36).slice(2, 8)}`,
        swarm: p.swarm.name,
        goal: "g",
        topology: "hierarchical",
      });
      const rows = task.map(([title, role]) => db.swarm.taskAdd({ run_id: run.id, title, role }));
      const advice = await adjudicatePlan(ctx, db, run, p.swarm, rows, {
        provider: null,
        env: { HOME: home },
      });
      expect(advice, JSON.stringify(off)).toEqual([]);
      expect(db.adjudicator.forTask(run.id, rows[0]!.id), JSON.stringify(off)).toEqual([]);
    }
  });

  it("the nudge needs every role to be a plain pin: an unpinned or unreadable role silences it, hand-edited ranges bring it back (#107)", async () => {
    const task: Array<[string, string]> = [["Rename a variable in the coder module", "coder"]];
    // a role without a model line runs on the main session's model: the adjudicator can pick for it
    const unpinned = await plan(project(PINNED_YAML.replace(/\n {8}model: opus/, "")), task);
    expect(unpinned.advice[0]!.allRolesPinned).toBeUndefined();
    // an agent file that is gone cannot be read: not a plain pin either
    const missing = project(PINNED_YAML);
    rmSync(join(missing.root, ".claude", "agents", "swarm-pin-reviewer.md"));
    expect((await plan(missing, task)).advice[0]!.allRolesPinned).toBeUndefined();
    // a hand-edited ranged file is a plain pin, so a swarm of those has nothing to move
    const edited = project();
    for (const role of ["coder", "tester", "lead"]) {
      const file = join(edited.root, ".claude", "agents", `swarm-rng-${role}.md`);
      writeFileSync(file, `${readFileSync(file, "utf8")}Edited by hand.\n`);
    }
    const { advice } = await plan(edited, task);
    expect(advice[0]!.allRolesPinned).toBe(true);
    expect(advice[0]!.range).toBeUndefined();
    expect(advice[0]!.pin).toMatchObject({ status: "pinned", model: "sonnet" });
  });

  it("defaults.model_range reaches roles that set none; a role's own range replaces it whole; {} opts out (#107)", async () => {
    const p = project(`
version: 1
defaults:
  model: sonnet
  model_range: { floor: haiku, ceiling: opus }
swarms:
  rng:
    description: ranges from the defaults
    agents:
      plain: { description: takes the default range }
      own: { description: names a ceiling only, model_range: { ceiling: opus } }
      off: { description: opts out, model_range: {} }
      strong: { description: keeps the default range around opus, model: opus }
`);
    const { advice } = await plan(p, [
      ["Rename a variable in the plain module", "plain"],
      ["Rename a variable in the own module", "own"],
      ["Rename a variable in the off module", "off"],
      ["Rename a variable in the strong module", "strong"],
    ]);
    // every task scores haiku
    const [plain, own, off, strong] = advice;
    expect(plain).toMatchObject({
      model: "haiku",
      range: { floor: "haiku", ceiling: "opus", fallback: "sonnet" },
    });
    // replaced whole: the default floor is not merged in, the floor is the fallback's tier
    expect(own).toMatchObject({
      model: "sonnet",
      range: { floor: "sonnet", ceiling: "opus", fallback: "sonnet" },
    });
    expect(off!.range).toBeUndefined();
    expect(off!.pin).toMatchObject({ status: "pinned", model: "sonnet" });
    expect(strong).toMatchObject({
      model: "haiku",
      range: { floor: "haiku", ceiling: "opus", fallback: "opus" },
    });
    const lines = planLines(advice);
    expect(lines[0]).toMatch(
      /^#\d+ → swarm-rng-plain · model haiku \(range haiku–opus, fallback sonnet\) · /,
    );
    expect(lines[1]).toMatch(
      /^#\d+ → swarm-rng-own · fallback sonnet \(range sonnet–opus; matches the adjudicator's pick\) · /,
    );
    expect(lines[2]).toMatch(
      /^#\d+ → swarm-rng-off · pinned sonnet \(adjudicator would pick haiku; /,
    );
    expect(lines[3]).toMatch(
      /^#\d+ → swarm-rng-strong · model haiku \(range haiku–opus, fallback opus\) · /,
    );
  });

  it("a ranged agent another file redefines with another model is an unknown pin: no range, no pick (#107)", async () => {
    const p = project();
    writeFileSync(
      join(p.root, ".claude", "agents", "shadow.md"),
      "---\nname: swarm-rng-coder\nmodel: opus\n---\nb\n",
    );
    const { advice, scores } = await plan(p, [["Rename a variable in the coder module", "coder"]]);
    expect(advice[0]!.range).toBeUndefined();
    expect(advice[0]!.pin).toMatchObject({ status: "unknown" });
    expect(planLines(advice)[0]).toMatch(
      /^#\d+ → swarm-rng-coder · model pin is unknown \(adjudicator would pick haiku; not overridden while the agent's definition cannot be read\) · /,
    );
    expect(scores(advice[0])).toMatchObject({ pinDeferred: true });
    expect(scores(advice[0]).ranged).toBeUndefined();
    expect(advice[0]!.allRolesPinned).toBeUndefined();
  });

  it("apply bounds move the pick inside the role's range, or miss it and leave the fallback (#107)", async () => {
    const p = project();
    const task: Array<[string, string]> = [["Rename a variable in the tester module", "tester"]];
    // the tester ranges haiku..sonnet around haiku: an apply floor of sonnet moves it up
    const up = await plan(p, task, { apply: { floor: "sonnet" } });
    expect(up.advice[0]).toMatchObject({
      model: "sonnet",
      range: { fallback: "haiku" },
    });
    expect(planLines(up.advice)[0]).toMatch(
      /^#\d+ → swarm-rng-tester · model sonnet \(range haiku–sonnet, fallback haiku\) · /,
    );
    expect(up.scores(up.advice[0])).toMatchObject({
      ranged: true,
      fallbackPin: "haiku",
    });
    expect(up.scores(up.advice[0]).pinDeferred).toBeUndefined();
    // apply bounds above the whole range: nothing to pick, the fallback stays and the row says so
    const miss = await plan(p, task, {
      apply: { floor: "opus", ceiling: "fable" },
    });
    expect(miss.advice[0]!.model).toBeUndefined();
    expect(planLines(miss.advice)[0]).toMatch(
      /^#\d+ → swarm-rng-tester · fallback haiku \(range haiku–sonnet; no pick inside apply\.floor\.\.ceiling\) · /,
    );
    expect(miss.scores(miss.advice[0])).toMatchObject({
      ranged: true,
      fallbackPin: "haiku",
      pinDeferred: true,
    });
    expect(planPassing(miss.advice, {})).toMatchObject({
      model: false,
      pinned: true,
    });
  });

  it("a role's own ceiling clamps a hard task although apply allows more (#107)", async () => {
    const p = project();
    const hard =
      "Redesign the storage layer across every adapter and migration\nMigrate every caller to the new adapter interface. Rewrite the sync engine and the conflict resolver. Add a migration path for old databases, with rollback. Audit the security of the auth flow and the session store. Refactor the hook bundle split across all modules.";
    const { advice, db } = await plan(p, [
      [hard, "coder"],
      [hard, "tester"],
    ]);
    // the scorer rates both opus; the tester's ceiling is sonnet
    expect(advice.map((a) => db.adjudicator.get(a.rowId!)?.tier)).toEqual(["opus", "opus"]);
    expect(advice.map((a) => a.model)).toEqual(["opus", "sonnet"]);
    expect(planLines(advice)[1]).toMatch(
      /^#\d+ → swarm-rng-tester · model sonnet \(range haiku–sonnet, fallback haiku\) · /,
    );
  });

  it("a non-ranged line names the verdict clamped to the apply bounds, like the Agent note (#129)", async () => {
    const p = project(`
version: 1
swarms:
  rng:
    description: one unpinned role, one pinned
    agents:
      free: { description: writes code }
      reviewer: { description: reviews code, model: opus }
`);
    const hard =
      "Redesign the storage layer across every adapter and migration\nMigrate every caller to the new adapter interface. Rewrite the sync engine and the conflict resolver. Add a migration path for old databases, with rollback. Audit the security of the auth flow and the session store. Refactor the hook bundle split across all modules.";
    const tasks: Array<[string, string]> = [
      [hard, "free"],
      [hard, "reviewer"],
    ];
    const ceiling = { apply: { ceiling: "sonnet" } };
    const { advice, db, scores } = await plan(p, tasks, ceiling);
    // the plan rows keep the raw verdict; the advice names the clamped tier
    expect(advice.map((a) => db.adjudicator.get(a.rowId!)?.tier)).toEqual(["opus", "opus"]);
    expect(advice.map((a) => a.model)).toEqual(["sonnet", "sonnet"]);
    const lines = planLines(advice);
    expect(lines[0]).toMatch(/^#\d+ → swarm-rng-free · model sonnet · effort /);
    expect(lines[1]).toMatch(
      /^#\d+ → swarm-rng-reviewer · pinned opus \(adjudicator would pick sonnet; /,
    );
    // every plan row stores the tier its line names, for follow detection
    expect(scores(advice[0])[ADVISED_PICK_FIELD]).toBe("sonnet");
    expect(scores(advice[0]).pinDeferred).toBeUndefined();
    expect(scores(advice[1])).toMatchObject({
      pinDeferred: true,
      [ADVISED_PICK_FIELD]: "sonnet",
    });

    // under FORCE the model is informational, and still the clamped tier
    const forced = await plan(p, tasks, ceiling, {
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    });
    expect(planLines(forced.advice)[0]).toMatch(/ · model sonnet \(informational\) · /);
    expect(forced.scores(forced.advice[0])).toMatchObject({
      forced: true,
      [ADVISED_PICK_FIELD]: "sonnet",
    });

    // a floor above the ceiling wins, as hooks.ts clampTier reads it
    const flipped = await plan(p, [["Rename a variable in the free module", "free"]], {
      apply: { floor: "opus", ceiling: "sonnet" },
    });
    expect(flipped.db.adjudicator.get(flipped.advice[0]!.rowId!)?.tier).toBe("haiku");
    expect(flipped.advice[0]!.model).toBe("opus");
    expect(planLines(flipped.advice)[0]).toMatch(/ · model opus · /);
  });
});

describe("onPreAgent: ranged swarm agents (#104)", () => {
  interface Plan {
    tier: string;
    confidence?: number;
    complexity?: number;
    effort?: string;
    role?: string;
    scores?: string;
  }

  /**
   * A worker dispatch of a task whose plan row has `plan`'s verdict (the decision: no provider).
   * Apply mode with scope swarm and minConfidence 0.7 unless `adjudicator` says otherwise.
   */
  async function dispatch(
    p: Project,
    plan: Plan,
    opts: {
      adjudicator?: Record<string, unknown>;
      input?: Record<string, unknown>;
      env?: NodeJS.ProcessEnv;
      routing?: boolean;
      /** The role actually dispatched, when it is not the planned one (mesh topology). */
      agentRole?: string;
      provider?: AdjudicatorProvider | null;
    } = {},
  ) {
    const ctx: ProjectContext = getContext(p.root);
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({
        enabled: true,
        mode: "apply",
        apply: { scope: "swarm", minConfidence: 0.7 },
        ...opts.adjudicator,
      }).adjudicator,
    };
    const db = getStorage(ctx, { vectors: false });
    const role = plan.role ?? "coder";
    const run = db.swarm.runCreate({
      id: `run-${Math.random().toString(36).slice(2, 8)}`,
      swarm: "rng",
      goal: "g",
      topology: "hierarchical",
    });
    const task = db.swarm.taskAdd({
      run_id: run.id,
      title: "Rename a variable",
      detail: "one file",
      role,
    });
    db.adjudicator.insert({
      surface: "plan",
      inputHash: "h",
      runId: run.id,
      taskId: task.id,
      tier: plan.tier,
      confidence: plan.confidence ?? 0.9,
      complexity: plan.complexity ?? 1,
      effort: plan.effort ?? "low",
      role,
      scores: plan.scores ?? JSON.stringify({ role: { confidence: 0.9 } }),
    });
    const agentType = `swarm-rng-${opts.agentRole ?? role}`;
    const input: HookInput = {
      session_id: `S-${run.id}`,
      cwd: p.root,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        subagent_type: agentType,
        prompt: `task #${task.id}`,
        ...opts.input,
      },
    };
    const spawn = {
      kind: "worker" as const,
      agentType,
      runId: run.id,
      taskId: task.id,
    };
    const deps = {
      env: { HOME: home, ...opts.env },
      provider: opts.provider ?? null,
    };
    const a = await onPreAgent(ctx, input, spawn, deps);
    const row = db.adjudicator.get(a!.rowId!)!;
    const routed = opts.routing
      ? await afterRouting(ctx, input, spawn, undefined, deps)
      : undefined;
    return {
      a: a!,
      row,
      sc: JSON.parse(row.scores ?? "{}") as Record<string, unknown>,
      routed,
    };
  }

  const EFFORT = "pass effort:'low' (Claude Code 2.1.292+)";
  // Apply mode sets the advised effort itself, in the same updatedInput as the model.
  const APPLIED = "effort low applied";

  it("apply sets the pick inside the range and the advised effort; the baseline is the fallback", async () => {
    const p = project();
    const { a, row, sc, routed } = await dispatch(p, { tier: "haiku" }, { routing: true });
    expect(a.model).toBe("haiku");
    expect(a.action).toBe("applied");
    expect(a.note).toBe(
      `adjudicator: model haiku applied (range haiku–opus, fallback sonnet; complexity 1, conf 0.90); ${APPLIED}, role coder`,
    );
    expect(a.effort).toBe("low");
    expect(row).toMatchObject({
      action: "applied",
      modelFinal: "haiku",
      baselineModel: "sonnet",
    });
    expect(sc).toMatchObject({
      [RANGED_FLAG]: true,
      [FALLBACK_PIN_FIELD]: "sonnet",
      pin: {
        status: "ranged",
        model: "sonnet",
        range: { floor: "haiku", ceiling: "opus" },
      },
    });
    expect(sc.pinDeferred).toBeUndefined();
    const ui = routed?.hookSpecificOutput?.updatedInput as Record<string, unknown>;
    expect(routed?.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(ui).toMatchObject({
      model: "haiku",
      effort: "low",
      subagent_type: "swarm-rng-coder",
    });
    expect(sc.effortApplied).toBe("low");
  });

  it("a pick above the range is clamped to its ceiling", async () => {
    const { a, row } = await dispatch(project(), {
      tier: "fable",
      complexity: 4,
      effort: "max",
    });
    expect(a.model).toBe("opus");
    expect(row.modelFinal).toBe("opus");
  });

  it("a pick that is the fallback's tier passes no model, still sets the effort, and counts as a kept pin", async () => {
    const p = project();
    const kept = await dispatch(p, {
      tier: "sonnet",
      complexity: 2,
      effort: "medium",
    });
    expect(kept.a.model).toBeUndefined();
    expect(kept.a.action).toBe("respected");
    expect(kept.a.note).toBe(
      "adjudicator: fallback sonnet (range haiku–opus; matches the adjudicator's pick); effort medium applied, role coder",
    );
    expect(kept.a.effort).toBe("medium");
    expect(kept.sc.effortApplied).toBe("medium");
    expect(kept.row).toMatchObject({
      modelFinal: "sonnet",
      baselineModel: "sonnet",
    });
    expect(kept.sc).toMatchObject({
      ranged: true,
      fallbackPin: "sonnet",
      pinDeferred: true,
    });
    // apply.ceiling sonnet clamps opus down to the fallback: kept as well
    const capped = await dispatch(
      p,
      { tier: "opus" },
      { adjudicator: { apply: { ceiling: "sonnet" } } },
    );
    expect(capped.a.model).toBeUndefined();
    expect(capped.sc.pinDeferred).toBe(true);
  });

  it("a kept fallback sends no model: the updatedInput carries only the effort, and the note (#107)", async () => {
    const kept = await dispatch(
      project(),
      { tier: "sonnet", complexity: 2, effort: "medium" },
      { routing: true },
    );
    const h = kept.routed?.hookSpecificOutput;
    expect(h?.updatedInput).toEqual({
      subagent_type: "swarm-rng-coder",
      prompt: expect.stringMatching(/^task #\d+$/),
      effort: "medium",
    });
    expect(h?.updatedInput).not.toHaveProperty("model");
    expect(h?.permissionDecision).toBe("allow");
    expect(h?.additionalContext).toBe(kept.a.note);
    expect(h?.additionalContext).toMatch(
      /^adjudicator: fallback sonnet \(range haiku–opus; matches the adjudicator's pick\); /,
    );
  });

  it("an explicit model, FORCE or a low confidence leaves the model alone (effort is still set)", async () => {
    const p = project();
    const explicit = await dispatch(
      p,
      { tier: "haiku" },
      { input: { model: "opus" }, routing: true },
    );
    expect(explicit.a.model).toBeUndefined();
    expect(explicit.a.action).toBe("respected");
    expect(explicit.row).toMatchObject({
      modelFinal: "opus",
      modelRequested: "opus",
      baselineModel: "sonnet",
    });
    expect(explicit.routed?.hookSpecificOutput?.updatedInput).toMatchObject({
      model: "opus",
      effort: "low",
    });

    const forced = await dispatch(
      p,
      { tier: "haiku" },
      {
        env: {
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
          CLAUDE_CODE_SUBAGENT_MODEL: "opus",
        },
      },
    );
    expect(forced.a.model).toBeUndefined();
    expect(forced.a.note).toMatch(/^adjudicator: CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets the model/);
    expect(forced.sc).toMatchObject({ forced: true });
    expect(forced.sc.ranged).toBeUndefined();
    expect(forced.row.baselineModel).toBe("opus");
    expect(forced.a.effort).toBe("low");
    expect(forced.a.note).toMatch(/; effort low applied, role coder$/);

    const unsure = await dispatch(p, { tier: "haiku", confidence: 0.5 });
    expect(unsure.a.model).toBeUndefined();
    expect(unsure.a.action).toBe("advised");
    expect(unsure.row.modelFinal).toBe("sonnet");
    expect(unsure.a.note).toBe(
      `adjudicator: model haiku would do (range haiku–opus, fallback sonnet; complexity 1, conf 0.50): pass model:'haiku'; ${APPLIED}, role coder`,
    );
    // minConfidence gates the model only: apply mode in scope still sets the advised effort
    expect(unsure.a.effort).toBe("low");
    expect(unsure.sc.pinDeferred).toBeUndefined();
  });

  it("advise mode names the pick to pass, or the fallback it keeps", async () => {
    const p = project();
    const advise = { adjudicator: { mode: "advise" } };
    const moves = await dispatch(p, { tier: "haiku" }, advise);
    expect(moves.a.model).toBeUndefined();
    expect(moves.a.note).toBe(
      `adjudicator: model haiku would do (range haiku–opus, fallback sonnet; complexity 1, conf 0.90): pass model:'haiku'; ${EFFORT}, role coder`,
    );
    expect(moves.row).toMatchObject({
      action: "advised",
      modelFinal: null,
      baselineModel: "sonnet",
    });
    expect(moves.sc).toMatchObject({ ranged: true, fallbackPin: "sonnet" });
    expect(moves.sc.pinDeferred).toBeUndefined();
    const stays = await dispatch(p, { tier: "sonnet" }, advise);
    expect(stays.a.note).toMatch(
      /^adjudicator: fallback sonnet \(range haiku–opus; matches the adjudicator's pick\); /,
    );
    expect(stays.sc.pinDeferred).toBe(true);
  });

  it("respectFrontmatter off ignores the range like any pin; a hand-edited file is a plain pin", async () => {
    const p = project();
    // lead ranges sonnet..opus: haiku would stay on the fallback sonnet
    const ranged = await dispatch(p, { tier: "haiku", role: "lead" });
    expect(ranged.a.model).toBeUndefined();
    const free = await dispatch(
      p,
      { tier: "haiku", role: "lead" },
      {
        adjudicator: {
          apply: {
            scope: "swarm",
            minConfidence: 0.7,
            respectFrontmatter: false,
          },
        },
      },
    );
    expect(free.a.model).toBe("haiku");
    expect(free.sc.ranged).toBeUndefined();

    const file = join(p.root, ".claude", "agents", "swarm-rng-coder.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}Edited by hand.\n`);
    const edited = await dispatch(p, { tier: "haiku" });
    expect(edited.a.model).toBeUndefined();
    expect(edited.a.action).toBe("respected");
    expect(edited.a.note).toMatch(/^adjudicator: pinned sonnet \(adjudicator would pick haiku; /);
    expect(edited.sc.ranged).toBeUndefined();
  });

  /** wide spans every tier around sonnet; top is the two highest around opus. */
  const GRID_YAML = `
version: 1
swarms:
  rng:
    description: clamp grid
    agents:
      wide: { description: spans every tier, model: sonnet, model_range: { floor: haiku, ceiling: fable } }
      top: { description: the two highest tiers, model: opus, model_range: { floor: opus, ceiling: fable } }
`;

  it("applies the clamp's pick for every verdict and apply bound, never one outside the role's range (#107)", async () => {
    const p = project(GRID_YAML);
    const roles: Record<string, { range: ModelRange; fallback: Tier }> = {
      wide: { range: { floor: "haiku", ceiling: "fable" }, fallback: "sonnet" },
      top: { range: { floor: "opus", ceiling: "fable" }, fallback: "opus" },
    };
    const seen = { moved: 0, sameAsFallback: 0, nothingInside: 0 };
    for (const [role, { range, fallback }] of Object.entries(roles))
      for (const floor of TIERS)
        for (const ceiling of TIERS)
          for (const tier of TIERS) {
            const label = `${role}: verdict ${tier}, apply ${floor}..${ceiling}`;
            const inside = allowed(range, floor, ceiling);
            const want = nearest(tier, inside);
            const r = await dispatch(
              p,
              { role, tier },
              {
                adjudicator: {
                  apply: { scope: "swarm", minConfidence: 0.7, floor, ceiling },
                },
              },
            );
            if (want !== undefined && want !== fallback) {
              seen.moved++;
              expect(r.a.model, label).toBe(want);
              expect(r.a.action, label).toBe("applied");
              expect(r.row.modelFinal, label).toBe(want);
              expect(r.sc.pinDeferred, label).toBeUndefined();
              expect(inside, label).toContain(r.a.model);
            } else {
              if (want === undefined) seen.nothingInside++;
              else seen.sameAsFallback++;
              expect(r.a.model, label).toBeUndefined();
              expect(r.a.action, label).toBe("respected");
              expect(r.row.modelFinal, label).toBe(fallback);
              expect(r.sc.pinDeferred, label).toBe(true);
            }
            expect(r.row.baselineModel, label).toBe(fallback);
          }
    // the grid reaches every outcome
    expect(seen.moved).toBeGreaterThan(0);
    expect(seen.sameAsFallback).toBeGreaterThan(0);
    expect(seen.nothingInside).toBeGreaterThan(0);
  });

  it("applies at exactly apply.minConfidence and only advises just below it (#107)", async () => {
    const p = project();
    const at = await dispatch(p, { tier: "haiku", confidence: 0.7 });
    expect(at.a).toMatchObject({ action: "applied", model: "haiku" });
    const below = await dispatch(p, { tier: "haiku", confidence: 0.69 });
    expect(below.a.action).toBe("advised");
    expect(below.a.model).toBeUndefined();
    expect(below.row).toMatchObject({
      action: "advised",
      modelFinal: "sonnet",
    });
    const strict = {
      adjudicator: { apply: { scope: "swarm", minConfidence: 0.95 } },
    };
    expect((await dispatch(p, { tier: "haiku", confidence: 0.9 }, strict)).a.action).toBe(
      "advised",
    );
    expect((await dispatch(p, { tier: "haiku", confidence: 0.95 }, strict)).a.action).toBe(
      "applied",
    );
  });

  it("a dispatch with a plan row never asks the provider: the plan's verdict is the decision, effort included", async () => {
    const p = project();
    const adjudicator = {
      provider: "openai-compatible",
      openai: { preset: "ollama" },
      apply: { scope: "all", minConfidence: 0 },
    };
    for (const role of ["coder", "reviewer"]) {
      const provider = stubProvider("opus", 4);
      const r = await dispatch(
        p,
        { role, tier: "haiku", effort: "medium" },
        { adjudicator, provider },
      );
      expect(provider.calls, role).toBe(0);
      expect(r.a.effort, role).toBe("medium");
      expect(r.row.parentId, role).not.toBeNull();
    }
  });

  describe("a ranged agent outside a swarm run (#107)", () => {
    /** The coder dispatched with no run and no plan row: the live verdict decides. */
    async function loose(
      adjudicator: Record<string, unknown>,
      opts: {
        provider?: AdjudicatorProvider | null;
        agent?: string;
        input?: Record<string, unknown>;
        env?: NodeJS.ProcessEnv;
        /** Routing denied or asked this call. */
        blocked?: boolean;
      } = {},
    ) {
      const p = project();
      const ctx = getContext(p.root);
      ctx.config = {
        ...ctx.config,
        adjudicator: configWith({
          enabled: true,
          mode: "apply",
          ...adjudicator,
        }).adjudicator,
      };
      const db = getStorage(ctx, { vectors: false });
      const a = await onPreAgent(
        ctx,
        {
          session_id: `L-${Math.random().toString(36).slice(2, 8)}`,
          cwd: p.root,
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: {
            subagent_type: opts.agent ?? "swarm-rng-coder",
            description: "Rename a variable",
            prompt: "Rename a variable in the coder module",
            ...opts.input,
          },
        },
        undefined,
        { env: { HOME: home, ...opts.env }, provider: opts.provider ?? null },
        opts.blocked,
      );
      const row = db.adjudicator.get(a!.rowId!)!;
      return {
        a: a!,
        row,
        sc: JSON.parse(row.scores ?? "{}") as Record<string, unknown>,
      };
    }

    it("is only advised under apply.scope swarm, the default", async () => {
      const r = await loose({});
      expect(r.a.model).toBeUndefined();
      expect(r.a.action).toBe("advised");
      expect(r.a.note).toMatch(
        /^adjudicator: model haiku would do \(range haiku–opus, fallback sonnet; complexity \d, conf 0\.\d\d\): pass model:'haiku'; /,
      );
      expect(r.row).toMatchObject({
        action: "advised",
        modelFinal: null,
        baselineModel: "sonnet",
      });
      expect(r.sc).toMatchObject({ ranged: true, fallbackPin: "sonnet" });
      expect(r.sc.pinDeferred).toBeUndefined();
    });

    it("gets the pick inside its range under apply.scope all", async () => {
      const r = await loose({ apply: { scope: "all", minConfidence: 0.7 } });
      expect(r.a).toMatchObject({ action: "applied", model: "haiku" });
      expect(r.row).toMatchObject({
        modelFinal: "haiku",
        baselineModel: "sonnet",
      });
      expect(r.sc).toMatchObject({ ranged: true, fallbackPin: "sonnet" });
    });

    it("fails open: a provider that never answers costs its budget, then the heuristic's pick applies", async () => {
      const cfg = {
        provider: "openai-compatible",
        openai: { preset: "ollama" },
        apply: { scope: "all", minConfidence: 0.7 },
        timeouts: { localMs: 40 },
      };
      let asked = 0;
      const hangs: AdjudicatorProvider = {
        ...stubProvider("opus"),
        adjudicate: () => {
          asked++;
          return new Promise<ProviderResult>(() => {});
        },
      };
      const t0 = Date.now();
      const r = await loose(cfg, { provider: hangs });
      expect(asked).toBe(1);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.a).toMatchObject({ action: "applied", model: "haiku" });
      expect(r.row).toMatchObject({
        modelFinal: "haiku",
        baselineModel: "sonnet",
      });
    });

    it("costs nothing while the adjudicator or its agent surface is off (#107)", async () => {
      for (const off of [{ enabled: false }, { surfaces: { agent: false } }]) {
        const provider = stubProvider("opus");
        const p = project();
        const ctx = getContext(p.root);
        ctx.config = {
          ...ctx.config,
          adjudicator: configWith({
            enabled: true,
            mode: "apply",
            apply: { scope: "all" },
            ...off,
          }).adjudicator,
        };
        const a = await onPreAgent(
          ctx,
          {
            session_id: "OFF",
            cwd: p.root,
            hook_event_name: "PreToolUse",
            tool_name: "Agent",
            tool_input: {
              subagent_type: "swarm-rng-coder",
              prompt: "Rename a variable",
            },
          },
          undefined,
          { env: { HOME: home }, provider },
        );
        expect(a, JSON.stringify(off)).toBeUndefined();
        expect(provider.calls).toBe(0);
        const db = getStorage(ctx, { vectors: false });
        expect(db.adjudicator.list({ limit: 5 }).total, JSON.stringify(off)).toBe(0);
      }
    });

    it("asks the provider inline only when its verdict could be applied: the model, or the effort alone", async () => {
      const cfg = {
        provider: "openai-compatible",
        openai: { preset: "ollama" },
        apply: { scope: "all", minConfidence: 0 },
      };
      // the heuristic rates a rename haiku and low effort; the provider is asked, and its answer counts
      const ranged = stubProvider("opus");
      const moved = await loose(cfg, { provider: ranged });
      expect(ranged.calls).toBe(1);
      expect(moved.a.action).toBe("applied");
      expect(moved.a.model).not.toBe("haiku");
      expect(moved.row.modelFinal).toBe(moved.a.model);

      // the model cannot move (a pin, a model on the call, FORCE), but the effort still applies,
      // and the provider's verdict (complexity 4, blended with the heuristic: high), not the
      // heuristic's own low, is what gets applied
      const effortOnly: Array<[string, Parameters<typeof loose>]> = [
        ["a pinned agent", [cfg, { agent: "swarm-rng-reviewer" }]],
        ["a model on the call", [cfg, { input: { model: "haiku" } }]],
        ["FORCE", [cfg, { env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" } }]],
      ];
      for (const [what, [adjudicator, opts]] of effortOnly) {
        const provider = stubProvider("opus", 4);
        const r = await loose(adjudicator, { ...opts, provider });
        expect(provider.calls, what).toBe(1);
        expect(r.a.effort, what).toBe("high");
        expect(r.sc.effortApplied, what).toBe("high");
        expect(r.row.effort, what).toBe("high");
        // the model stays respected
        expect(r.a.model, what).toBeUndefined();
        expect(r.a.action, what).not.toBe("applied");
      }
      // and the same verdict from the heuristic alone is lower: the provider's answer is what applied
      const heuristic = await loose(cfg, { agent: "swarm-rng-reviewer" });
      expect(heuristic.a.effort).toBe("low");

      // nothing to apply, so nothing to ask: advise mode, CLAUDE_CODE_EFFORT_LEVEL, a fork, a
      // blocked (deny/ask) call
      const quiet: Array<[string, Parameters<typeof loose>]> = [
        ["advise mode", [{ ...cfg, mode: "advise" }, {}]],
        [
          "advise mode, a pinned agent",
          [{ ...cfg, mode: "advise" }, { agent: "swarm-rng-reviewer" }],
        ],
        [
          "CLAUDE_CODE_EFFORT_LEVEL on a pinned agent",
          [
            cfg,
            {
              agent: "swarm-rng-reviewer",
              env: { CLAUDE_CODE_EFFORT_LEVEL: "high" },
            },
          ],
        ],
        ["a fork", [cfg, { agent: "fork" }]],
        ["a blocked call, a pinned agent", [cfg, { agent: "swarm-rng-reviewer", blocked: true }]],
        ["a blocked call, an explicit model", [cfg, { input: { model: "haiku" }, blocked: true }]],
      ];
      for (const [what, [adjudicator, opts]] of quiet) {
        const provider = stubProvider("opus", 4);
        const r = await loose(adjudicator, { ...opts, provider });
        expect(provider.calls, what).toBe(0);
        expect(r.a.effort, what).toBeUndefined();
        expect(r.sc.effortApplied, what).toBeUndefined();
      }
      // pins ignored: the range goes with them and the agent is open to the provider again
      const free = stubProvider("opus");
      await loose(
        { ...cfg, apply: { ...cfg.apply, respectFrontmatter: false } },
        { provider: free },
      );
      expect(free.calls).toBe(1);
    });
  });

  it("the hook's effort overrides the call's own; only CLAUDE_CODE_EFFORT_LEVEL outranks it (#107)", async () => {
    const p = project();
    const own = await dispatch(p, { tier: "haiku" }, { input: { effort: "high" }, routing: true });
    expect(own.a.model).toBe("haiku");
    expect(own.a.note).toBe(
      `adjudicator: model haiku applied (range haiku–opus, fallback sonnet; complexity 1, conf 0.90); ${APPLIED}, role coder`,
    );
    expect(own.routed?.hookSpecificOutput?.updatedInput).toMatchObject({
      model: "haiku",
      effort: "low",
    });
    // the row keeps what the call passed, next to what the hook sent
    expect(own.sc).toMatchObject({
      passedEffort: "high",
      effortApplied: "low",
    });
    // CLAUDE_CODE_EFFORT_LEVEL outranks the hook: the pick is applied, no effort is added
    const env = await dispatch(
      p,
      { tier: "haiku" },
      { env: { CLAUDE_CODE_EFFORT_LEVEL: "max" }, routing: true },
    );
    expect(env.a.model).toBe("haiku");
    expect(env.a.note).toMatch(
      /; effort low not applied: CLAUDE_CODE_EFFORT_LEVEL is set and outranks it, role coder$/,
    );
    expect(env.a.effort).toBeUndefined();
    expect(env.sc.effortApplied).toBeUndefined();
    expect(env.sc.effortEnv).toBe("max");
    const ui = env.routed?.hookSpecificOutput?.updatedInput as Record<string, unknown>;
    expect(ui).toMatchObject({ model: "haiku" });
    expect(ui).not.toHaveProperty("effort");
  });

  it("a ranged file another file shadows with a different model is an unknown pin: no model is applied (#107)", async () => {
    const p = project();
    writeFileSync(
      join(p.root, ".claude", "agents", "shadow.md"),
      "---\nname: swarm-rng-coder\nmodel: opus\n---\nb\n",
    );
    const r = await dispatch(p, { tier: "haiku" });
    expect(r.a.model).toBeUndefined();
    expect(r.a.action).toBe("advised");
    expect(r.a.note).toBe(
      `adjudicator: model pin is unknown (adjudicator would pick haiku; not overridden while the agent's definition cannot be read); ${APPLIED}, role coder`,
    );
    expect(r.row).toMatchObject({ action: "advised", modelFinal: null });
    expect(r.sc).toMatchObject({
      pinDeferred: true,
      pin: { status: "unknown" },
    });
    expect(r.sc.ranged).toBeUndefined();
    expect(r.sc.fallbackPin).toBeUndefined();
  });

  it("reads FORCE as Claude Code does: on drops the range and runs the env model, off keeps the range (#107)", async () => {
    const p = project();
    const env = { CLAUDE_CODE_SUBAGENT_MODEL: "opus" };
    for (const force of ["1", "true", "TRUE", "yes", "On", " on "]) {
      const r = await dispatch(
        p,
        { tier: "haiku" },
        { env: { ...env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: force } },
      );
      expect(r.a.model, force).toBeUndefined();
      expect(r.sc, force).toMatchObject({ forced: true });
      expect(r.sc.ranged, force).toBeUndefined();
      expect(r.row.baselineModel, force).toBe("opus");
    }
    for (const force of ["0", "false", "no", "off", "OFF", "", "2", "enabled"]) {
      const r = await dispatch(
        p,
        { tier: "haiku" },
        { env: { ...env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: force } },
      );
      expect(r.a.model, force).toBe("haiku");
      expect(r.sc.forced, force).toBeUndefined();
      expect(r.sc, force).toMatchObject({
        ranged: true,
        fallbackPin: "sonnet",
      });
      // the fallback is what ran without the adjudicator, whatever CLAUDE_CODE_SUBAGENT_MODEL says
      expect(r.row.baselineModel, force).toBe("sonnet");
    }
  });

  describe("reconcile prices a ranged dispatch against its fallback pin (#105, #107)", () => {
    /** The worker of the dispatched task makes two calls on `model`; the task is done; reconcile runs. */
    function settle(p: Project, row: AdjudicationRow, model: string) {
      const db = getStorage(getContext(p.root), { vectors: false });
      const agent = `ag-${row.id}`;
      db.swarm.taskClaim(row.taskId!, agent);
      db.swarm.workerUpsert({
        run_id: row.runId!,
        agent_id: agent,
        agent_type: "swarm-rng-coder",
        role: "coder",
        session_id: row.sessionId!,
        task_id: row.taskId!,
      });
      db.apiCallsUpsert(
        [1, 2].map((i) =>
          apiCall({
            session_id: row.sessionId!,
            agent_id: agent,
            sidechain: 1,
            model,
            ts: row.ts + i * 1000,
          }),
        ),
      );
      db.swarm.taskUpdate(row.taskId!, { status: "done" });
      reconcile(db, { now: row.ts + 10 * 60_000 });
      return {
        db,
        row: db.adjudicator.get(row.id)!,
        calls: db.apiCalls({ sessionId: row.sessionId! }).filter((c) => c.agent_id === agent),
      };
    }

    it("an applied pick is credited against the fallback, not the env model nor the pick (#107)", async () => {
      const p = project();
      const d = await dispatch(
        p,
        { tier: "haiku" },
        { env: { CLAUDE_CODE_SUBAGENT_MODEL: "opus" } },
      );
      expect(d.a.action).toBe("applied");
      const { db, row, calls } = settle(p, d.row, "claude-haiku-4-5");
      expect(calls).toHaveLength(2);
      expect(row).toMatchObject({
        action: "applied",
        baselineModel: "sonnet",
        actualModel: "claude-haiku-4-5",
        outcome: "success",
      });
      const base = repriceAt(calls, "sonnet")!;
      const ran = repriceAt(calls, "claude-haiku-4-5")!;
      expect(row.baselineCostUsd).toBeCloseTo(base, 12);
      expect(row.savingsUsd).toBeCloseTo(base - ran, 12);
      expect(row.savingsUsd!).toBeGreaterThan(0);
      // priced at the env model, the same calls would have credited something else
      expect(repriceAt(calls, "opus")! - ran).not.toBeCloseTo(base - ran, 6);
      const report = savingsReport(db);
      expect(report).toMatchObject({
        creditedRows: 1,
        keptModel: { pin: 0, force: 0, fork: 0 },
      });
      expect(report.realisedUsd).toBeCloseTo(base - ran, 12);
      expect(report.matrix).toEqual([{ suggested: "haiku", actual: "haiku", n: 1 }]);
    });

    // #128: resolvePrice prices a bare alias with the context suffix as the alias, so the verbatim
    // fallback baseline `sonnet[1m]` is priced and the saving credited.
    it("a ranged role that falls back to an alias[1m] is credited like any other (#107, #128)", async () => {
      // sonnet[1m] is a fallback the design allows (the hook never swaps it for the bare alias)
      const p = project(
        YAML.replace(
          "model: sonnet\n        model_range: { floor: haiku, ceiling: opus }",
          'model: "sonnet[1m]"\n        model_range: { floor: haiku, ceiling: opus }',
        ),
      );
      const d = await dispatch(p, { tier: "haiku" });
      expect(d.a).toMatchObject({ action: "applied", model: "haiku" });
      expect(d.row.baselineModel).toBe("sonnet[1m]");
      const { row, calls } = settle(p, d.row, "claude-haiku-4-5");
      // 1000 in / 500 out per call is far below the long-context threshold: sonnet's list price
      const base = repriceAt(calls, "sonnet")!;
      const ran = repriceAt(calls, "claude-haiku-4-5")!;
      expect(row.baselineCostUsd).toBeCloseTo(base, 12);
      expect(row.savingsUsd).toBeCloseTo(base - ran, 12);
    });

    it("an alias with the context suffix is priced as the alias; versioned ids are unchanged (#128)", () => {
      for (const alias of ["sonnet", "opus", "haiku", "fable"]) {
        expect(resolvePrice(`${alias}[1m]`), alias).toEqual(resolvePrice(alias));
        expect(resolvePrice(`${alias.toUpperCase()}[1M]`), alias).toEqual(resolvePrice(alias));
      }
      expect(resolvePrice("claude-sonnet-4-5[1m]")).toEqual(resolvePrice("claude-sonnet-4-5"));
      expect(resolvePrice("claude-opus-5-5[1m]")).toEqual(resolvePrice("claude-opus-5-5"));
      // an unknown versioned id stays unpriced: the suffix strip does not reach the alias fallback
      expect(resolvePrice("claude-sonnet-9-9")).toBeUndefined();
      expect(resolvePrice("claude-sonnet-9-9[1m]")).toBeUndefined();
      expect(resolvePrice("gpt-4[1m]")).toBeUndefined();
      // only a trailing suffix is stripped
      expect(resolvePrice("sonnet[1m]-2")).toBeUndefined();
    });

    it("a pick that is the fallback is no saving and no disagreement: a kept pin (#107)", async () => {
      const p = project();
      const d = await dispatch(p, {
        tier: "sonnet",
        complexity: 2,
        effort: "medium",
      });
      expect(d.a.action).toBe("respected");
      const { db, row } = settle(p, d.row, "claude-sonnet-5-5");
      expect(row).toMatchObject({
        action: "respected",
        baselineModel: "sonnet",
        outcome: "success",
      });
      expect(row.savingsUsd ?? null).toBeNull();
      const report = savingsReport(db);
      expect(report.keptModel).toEqual({ pin: 1, force: 0, fork: 0 });
      expect(report.matrix).toEqual([]);
      expect(report).toMatchObject({ creditedRows: 0, realisedUsd: 0 });
    });

    it("advise mode: the coordinator passes the pick, the dispatch is followed and credited against the fallback (#107)", async () => {
      const p = project();
      const d = await dispatch(
        p,
        { tier: "haiku" },
        { adjudicator: { mode: "advise" }, input: { model: "haiku" } },
      );
      expect(d.row).toMatchObject({
        action: "advised",
        modelRequested: "haiku",
      });
      const { row, calls } = settle(p, d.row, "claude-haiku-4-5");
      expect(row.action).toBe("followed");
      expect(row.baselineModel).toBe("sonnet");
      const base = repriceAt(calls, "sonnet")!;
      const ran = repriceAt(calls, "claude-haiku-4-5")!;
      expect(row.savingsUsd).toBeCloseTo(base - ran, 12);
    });

    // KNOWN DEFECT, task #126: reconcile (learn.ts pricePatch) compares the call's model with the
    // scorer's raw tier (the plan row's `tier`), not with the pick the range moved it to, so a
    // coordinator that does what the line says is recorded `ignored` and earns no credit. The
    // assertions below are the intended behaviour; vitest reports this test as failing the moment
    // #126 lands, and that change removes `.fails`.
    it("advise mode: a pick the range moved away from the verdict is still followed (#107)", async () => {
      // steady falls back to opus and may drop to sonnet; the scorer says haiku, the line says sonnet
      const p = project(`
version: 1
swarms:
  rng:
    description: drops down from opus
    agents:
      steady: { description: keeps the strong model unless it can drop, model: opus, model_range: { floor: sonnet } }
`);
      const d = await dispatch(
        p,
        { role: "steady", tier: "haiku" },
        { adjudicator: { mode: "advise" }, input: { model: "sonnet" } },
      );
      expect(d.row).toMatchObject({
        action: "advised",
        tier: "haiku",
        modelRequested: "sonnet",
      });
      expect(d.row.baselineModel).toBe("opus");
      const { row, calls } = settle(p, d.row, "claude-sonnet-5-5");
      expect(row.action).toBe("followed");
      const base = repriceAt(calls, "opus")!;
      const ran = repriceAt(calls, "claude-sonnet-5-5")!;
      expect(row.savingsUsd).toBeCloseTo(base - ran, 12);
      expect(row.savingsUsd!).toBeGreaterThan(0);
    });

    it("advise mode: a pick the range ceiling clamped is followed, credited against the fallback (#126)", async () => {
      // coder is haiku..opus around sonnet; the scorer says fable, the note says opus
      const p = project();
      const d = await dispatch(
        p,
        { tier: "fable" },
        { adjudicator: { mode: "advise" }, input: { model: "opus" } },
      );
      expect(d.row).toMatchObject({
        action: "advised",
        tier: "fable",
        modelRequested: "opus",
      });
      const { row, calls } = settle(p, d.row, "claude-opus-4-5");
      expect(row.action).toBe("followed");
      const base = repriceAt(calls, "sonnet")!;
      const ran = repriceAt(calls, "claude-opus-4-5")!;
      // the move up costs more than the fallback: a negative saving, still credited
      expect(row.savingsUsd).toBeCloseTo(base - ran, 12);
      expect(row.savingsUsd!).toBeLessThan(0);
    });

    it("advise mode: the dispatch row's own pick wins over the plan row's when the dispatched role differs (F4)", async () => {
      // planned for the tester (haiku..sonnet): verdict opus, pick sonnet. The coordinator dispatches
      // the coder (haiku..opus) instead, so the Agent note names opus and the coordinator passes it.
      const p = project();
      const d = await dispatch(
        p,
        {
          role: "tester",
          tier: "opus",
          scores: JSON.stringify({
            role: { confidence: 0.9 },
            [ADVISED_PICK_FIELD]: "sonnet",
          }),
        },
        {
          adjudicator: { mode: "advise" },
          agentRole: "coder",
          input: { model: "opus" },
        },
      );
      expect(d.row).toMatchObject({
        action: "advised",
        modelRequested: "opus",
      });
      expect(d.row.parentId).not.toBeNull();
      expect(advisedPick(d.row)).toBe("opus");
      const { row } = settle(p, d.row, "claude-opus-4-5");
      expect(row.action).toBe("followed");
    });

    it("advise mode: a pick the apply ceiling clamped is followed (#126)", async () => {
      const p = project();
      const d = await dispatch(
        p,
        { tier: "opus" },
        {
          adjudicator: {
            mode: "advise",
            apply: { scope: "swarm", minConfidence: 0.7, ceiling: "haiku" },
          },
          input: { model: "haiku" },
        },
      );
      expect(d.row).toMatchObject({
        action: "advised",
        tier: "opus",
        modelRequested: "haiku",
      });
      const { row, calls } = settle(p, d.row, "claude-haiku-4-5");
      expect(row.action).toBe("followed");
      const base = repriceAt(calls, "sonnet")!;
      const ran = repriceAt(calls, "claude-haiku-4-5")!;
      expect(row.savingsUsd).toBeCloseTo(base - ran, 12);
      expect(row.savingsUsd!).toBeGreaterThan(0);
    });

    it("advise mode: passing the raw verdict instead of the pick is ignored, not credited (#126)", async () => {
      const p = project(`
version: 1
swarms:
  rng:
    description: drops down from opus
    agents:
      steady: { description: keeps the strong model unless it can drop, model: opus, model_range: { floor: sonnet } }
`);
      const d = await dispatch(
        p,
        { role: "steady", tier: "haiku" },
        { adjudicator: { mode: "advise" }, input: { model: "haiku" } },
      );
      const { row } = settle(p, d.row, "claude-haiku-4-5");
      expect(row.action).toBe("ignored");
      expect(row.savingsUsd).toBeNull();
    });

    it("the agent row stores the pick; advisedPick reads any row's stored tier (#126, #128)", async () => {
      const p = project();
      const d = await dispatch(p, { tier: "fable" }, { adjudicator: { mode: "advise" } });
      expect(d.sc[ADVISED_PICK_FIELD]).toBe("opus");
      expect(advisedPick(d.row)).toBe("opus");
      expect(
        advisedPick({
          scores: JSON.stringify({ ranged: true, advisedPick: "sonnet" }),
        }),
      ).toBe("sonnet");
      // a non-ranged row's clamped tier is read too (#128)
      expect(advisedPick({ scores: JSON.stringify({ advisedPick: "haiku" }) })).toBe("haiku");
      // not a tier, no field, or not JSON: no pick
      expect(advisedPick({ scores: JSON.stringify({ advisedPick: "gpt" }) })).toBeUndefined();
      expect(advisedPick({ scores: JSON.stringify({ ranged: true }) })).toBeUndefined();
      expect(advisedPick({ scores: "not json" })).toBeUndefined();
      expect(advisedPick({ scores: null })).toBeUndefined();
    });

    /** A swarm whose `free` role pins no model and has no range. */
    const FREE_YAML = `
version: 1
swarms:
  rng:
    description: unpinned swarm
    agents:
      free: { description: writes code }
`;
    const CLAMPED = {
      adjudicator: {
        mode: "advise",
        apply: { scope: "swarm", minConfidence: 0.7, ceiling: "haiku" },
      },
    };

    it("advise mode, no range: the note's apply-clamped tier is stored and followed (#128)", async () => {
      const p = project(FREE_YAML);
      const d = await dispatch(
        p,
        { role: "free", tier: "opus" },
        { ...CLAMPED, input: { model: "haiku" } },
      );
      expect(d.sc.ranged).toBeUndefined();
      expect(d.sc[ADVISED_PICK_FIELD]).toBe("haiku");
      // the note of the same dispatch without a model names that tier
      const bare = await dispatch(p, { role: "free", tier: "opus" }, CLAMPED);
      expect(bare.a.note).toContain("pass model:'haiku'");
      expect(bare.sc[ADVISED_PICK_FIELD]).toBe("haiku");
      expect(d.row).toMatchObject({
        action: "advised",
        tier: "opus",
        modelRequested: "haiku",
      });
      const { row, calls } = settle(p, d.row, "claude-haiku-4-5");
      expect(row.action).toBe("followed");
      expect(tierOf(row.baselineModel)).not.toBe("haiku");
      const base = repriceAt(calls, row.baselineModel!)!;
      const ran = repriceAt(calls, "claude-haiku-4-5")!;
      expect(row.savingsUsd).toBeCloseTo(base - ran, 12);
      expect(row.savingsUsd!).toBeGreaterThan(0);
    });

    it("advise mode, no range: passing the raw verdict over the clamp is ignored (#128)", async () => {
      const p = project(FREE_YAML);
      const d = await dispatch(
        p,
        { role: "free", tier: "opus" },
        { ...CLAMPED, input: { model: "opus" } },
      );
      const { row } = settle(p, d.row, "claude-opus-5-5");
      expect(row.action).toBe("ignored");
      expect(row.savingsUsd).toBeNull();
    });

    it("a row written without the advised pick keeps the raw-tier comparison (#128)", async () => {
      const p = project(FREE_YAML);
      const d = await dispatch(
        p,
        { role: "free", tier: "opus" },
        { ...CLAMPED, input: { model: "opus" } },
      );
      // an old row: no advisedPick in its scores
      const db = getStorage(getContext(p.root), { vectors: false });
      const { [ADVISED_PICK_FIELD]: _drop, ...old } = d.sc;
      db.adjudicator.update(d.row.id, { scores: JSON.stringify(old) });
      const { row } = settle(p, db.adjudicator.get(d.row.id)!, "claude-opus-5-5");
      expect(row.action).toBe("followed");
    });

    it("a coordinator that passes a plan line's clamped tier is followed (#129)", async () => {
      const p = project(FREE_YAML);
      const ctx: ProjectContext = getContext(p.root);
      ctx.config = {
        ...ctx.config,
        adjudicator: configWith({ enabled: true, ...CLAMPED.adjudicator }).adjudicator,
      };
      const db = getStorage(ctx, { vectors: false });
      const run = db.swarm.runCreate({
        id: `pl-${Math.random().toString(36).slice(2, 8)}`,
        swarm: "rng",
        goal: "g",
        topology: "hierarchical",
      });
      const task = db.swarm.taskAdd({
        run_id: run.id,
        title:
          "Redesign the storage layer across every adapter and migration\nMigrate every caller to the new adapter interface. Rewrite the sync engine and the conflict resolver. Add a migration path for old databases, with rollback. Audit the security of the auth flow and the session store.",
        role: "free",
      });
      const env = { HOME: home };
      const [advice] = await adjudicatePlan(ctx, db, run, p.swarm, [task], {
        provider: null,
        env,
      });
      const planRow = db.adjudicator.get(advice!.rowId!)!;
      expect(planRow.tier).toBe("opus");
      expect(advice!.model).toBe("haiku");
      expect(advisedPick(planRow)).toBe("haiku");
      expect(planLines([advice!])[0]).toMatch(/^#\d+ → swarm-rng-free · model haiku · /);

      // the coordinator passes what the line says
      const agentType = "swarm-rng-free";
      const input: HookInput = {
        session_id: `S-${run.id}`,
        cwd: p.root,
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: {
          subagent_type: agentType,
          prompt: `task #${task.id}`,
          model: advice!.model,
        },
      };
      const spawn = {
        kind: "worker" as const,
        agentType,
        runId: run.id,
        taskId: task.id,
      };
      const a = await onPreAgent(ctx, input, spawn, { env, provider: null });
      const dispatched = db.adjudicator.get(a!.rowId!)!;
      expect(dispatched).toMatchObject({
        action: "advised",
        modelRequested: "haiku",
      });
      expect(advisedPick(dispatched)).toBe("haiku");
      const { row } = settle(p, dispatched, "claude-haiku-4-5");
      expect(row.action).toBe("followed");
      expect(row.savingsUsd!).toBeGreaterThan(0);
    });
  });
});

describe("Agent notes: the role gate and saturated briefs (#104)", () => {
  const units = (saturated: boolean) => ({
    scored: 4,
    dropped: 0,
    skipped: 0,
    winner: 1,
    sum: saturated ? 6.4 : 2.1,
    saturated,
    roleConfidence: 0.9,
  });

  async function note(
    scores: Record<string, unknown>,
    env: NodeJS.ProcessEnv = {},
    call: Record<string, unknown> = {},
  ) {
    const p = project(PINNED_YAML.replace(/\n {8}model: sonnet/, ""));
    const ctx = getContext(p.root);
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({ enabled: true, mode: "advise" }).adjudicator,
    };
    const db = getStorage(ctx, { vectors: false });
    const run = db.swarm.runCreate({
      id: `n-${Math.random().toString(36).slice(2, 8)}`,
      swarm: "pin",
      goal: "g",
      topology: "hierarchical",
    });
    const task = db.swarm.taskAdd({
      run_id: run.id,
      title: "Rename a variable",
      role: "coder",
    });
    db.adjudicator.insert({
      surface: "plan",
      inputHash: "h",
      runId: run.id,
      taskId: task.id,
      tier: "opus",
      confidence: 0.9,
      complexity: 4,
      effort: "max",
      role: "coder",
      scores: JSON.stringify(scores),
    });
    const a = await onPreAgent(
      ctx,
      {
        session_id: `S-${run.id}`,
        cwd: p.root,
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: {
          subagent_type: "swarm-pin-coder",
          prompt: "task",
          ...call,
        },
      },
      {
        kind: "worker",
        agentType: "swarm-pin-coder",
        runId: run.id,
        taskId: task.id,
      },
      { env: { HOME: home, ...env }, provider: null },
    );
    return a!.note!;
  }

  it("names the role only from a role table at 0.7 or more", async () => {
    expect(await note({ role: { confidence: 0.9 } })).toMatch(/, role coder$/);
    expect(await note({ role: { confidence: 0.69 } })).not.toMatch(/role coder/);
    // no role table stored: the brief's own role confidence
    expect(await note({ units: { ...units(false), roleConfidence: 0.55 } })).not.toMatch(
      /role coder/,
    );
  });

  it("a saturated brief's effort is informational, unless the env already makes it so", async () => {
    const sat = await note({ role: { confidence: 0.9 }, units: units(true) });
    expect(sat).toMatch(/effort max: informational \(brief saturated\)/);
    expect(sat).not.toMatch(/pass effort/);
    expect(await note({ role: { confidence: 0.9 }, units: units(false) })).toMatch(
      /pass effort:'max' \(Claude Code 2\.1\.292\+\)/,
    );
    expect(
      await note(
        { role: { confidence: 0.9 }, units: units(true) },
        { CLAUDE_CODE_EFFORT_LEVEL: "high" },
      ),
    ).toMatch(/suggested effort max/);
  });

  it("names the role at exactly ROLE_NOTE_MIN, taking the role table before the brief's units (#107)", async () => {
    expect(ROLE_NOTE_MIN).toBe(0.7);
    expect(await note({ role: { confidence: 0.7 } })).toMatch(/, role coder$/);
    expect(await note({ units: { ...units(false), roleConfidence: 0.7 } })).toMatch(
      /, role coder$/,
    );
    // both stored: the role table decides, whichever is higher
    const low = { ...units(false), roleConfidence: 0.1 };
    const high = { ...units(false), roleConfidence: 0.9 };
    expect(await note({ role: { confidence: 0.9 }, units: low })).toMatch(/, role coder$/);
    expect(await note({ role: { confidence: 0.1 }, units: high })).not.toMatch(/role coder/);
    // nothing stored: the live verdict's role confidence (a rename is surely a coder's)
    expect(await note({})).toMatch(/, role coder$/);
  });

  it("an effort already on the call is only suggested, saturated brief or not; no units means not saturated (#107)", async () => {
    const own = { effort: "low" };
    const sat = await note({ role: { confidence: 0.9 }, units: units(true) }, {}, own);
    expect(sat).toMatch(/suggested effort max/);
    expect(sat).not.toMatch(/informational|pass effort/);
    const plain = await note({ role: { confidence: 0.9 }, units: units(false) }, {}, own);
    expect(plain).toMatch(/suggested effort max/);
    expect(plain).not.toMatch(/pass effort/);
    // a plan row without units is not saturated: its effort is passed
    expect(await note({ role: { confidence: 0.9 } })).toMatch(/pass effort:'max'/);
  });
});

describe("baselines read CLAUDE_CODE_SUBAGENT_MODEL only for an agent without a model line (#104)", () => {
  function call(sessionId: string, model: string): ApiCallInput {
    return {
      request_id: `r${Math.random()}`,
      message_id: `m${Math.random()}`,
      session_id: sessionId,
      agent_id: null,
      sidechain: 0,
      ts: Date.now() - 60_000,
      model,
      input_tokens: 100,
      output_tokens: 10,
      cache_create_5m: 0,
      cache_create_1h: 0,
      cache_read: 0,
      thinking_tokens: 0,
      web_searches: 0,
      web_fetches: 0,
      service_tier: null,
      speed: null,
      stop_reason: null,
      prompt_id: null,
      git_branch: null,
      cwd: null,
      effort: null,
      version: null,
      entrypoint: null,
    };
  }

  async function baselineOf(subagentType: string, env: NodeJS.ProcessEnv) {
    const p = project();
    writeFileSync(
      join(p.root, ".claude", "agents", "inh.md"),
      "---\nname: inh\nmodel: inherit\n---\nb\n",
    );
    const ctx = getContext(p.root);
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({ enabled: true, mode: "advise" }).adjudicator,
    };
    const db = getStorage(ctx, { vectors: false });
    const sid = `B-${Math.random().toString(36).slice(2, 8)}`;
    db.apiCallsUpsert([call(sid, "claude-opus-5-5")]);
    const a = await onPreAgent(
      ctx,
      {
        session_id: sid,
        cwd: p.root,
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: {
          subagent_type: subagentType,
          description: "x",
          prompt: "list the files in src",
        },
      },
      undefined,
      { env: { HOME: home, ...env }, provider: null },
    );
    return db.adjudicator.get(a!.rowId!)!.baselineModel;
  }

  it("unpinned: the env model (FORCE off by Claude Code's rule); inherit, a fork and FORCE: not", async () => {
    const env = { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" };
    expect(await baselineOf("general-purpose", env)).toBe("haiku");
    // "off" is off for Claude Code: the hook passes the variable on without the FORCE flag
    expect(
      await baselineOf("general-purpose", {
        ...env,
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "off",
      }),
    ).toBe("haiku");
    expect(await baselineOf("inh", env)).toBe("claude-opus-5-5");
    expect(await baselineOf("fork", env)).toBe("claude-opus-5-5");
    expect(await baselineOf("general-purpose", {})).toBe("claude-opus-5-5");
  });

  it("main-session advice compares with the session's own model, whatever CLAUDE_CODE_SUBAGENT_MODEL says", async () => {
    const p = project();
    const ctx = getContext(p.root);
    ctx.config = {
      ...ctx.config,
      adjudicator: configWith({
        enabled: true,
        promptMode: "heuristic",
        tiers: ["haiku", "sonnet", "opus"],
        advice: { mainSession: "user", cooldownPrompts: 3 },
      }).adjudicator,
    };
    const db = getStorage(ctx, { vectors: false });
    const sid = `M-${Math.random().toString(36).slice(2, 8)}`;
    db.apiCallsUpsert([call(sid, "claude-fable-1")]);
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "haiku";
    try {
      const out = await onPrompt(
        ctx,
        db,
        {
          session_id: sid,
          cwd: p.root,
          hook_event_name: "UserPromptSubmit",
          prompt: "Where is the function parseConfig defined in src/config.ts?",
        },
        sid,
        { provider: null },
      );
      expect(out?.systemMessage).toMatch(/\/model (haiku|sonnet) would be cheaper than fable/);
    } finally {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    }
  });
});

// --- #107: tables and the swarm.yaml → agent file → pin pipeline --------------------------------

describe("dispatchRule: every combination of facts (#107)", () => {
  const FLAGS = [false, true];
  /** The rule table of docs/adjudicator.md, first match first (everything else passes). */
  const MODEL_ORDER: ReadonlyArray<readonly [keyof DispatchFacts, DispatchRule["model"]]> = [
    ["fork", "fork"],
    ["forced", "forced"],
    ["ranged", "ranged"],
    ["pin", "pin"],
  ];

  it("fork > FORCE > ranged > pin > pass, and the effort rule, over all 64 combinations", () => {
    let checked = 0;
    for (const fork of FLAGS)
      for (const forced of FLAGS)
        for (const ranged of FLAGS)
          for (const pin of FLAGS)
            for (const effortSet of FLAGS)
              for (const saturated of FLAGS) {
                const facts: DispatchFacts = {
                  fork,
                  forced,
                  ranged,
                  pin,
                  effortSet,
                  saturated,
                };
                const model = MODEL_ORDER.find(([fact]) => facts[fact])?.[1] ?? "pass";
                const effort = fork ? "fork" : effortSet || saturated ? "informational" : "pass";
                expect(dispatchRule(facts), JSON.stringify(facts)).toEqual({
                  model,
                  effort,
                });
                checked++;
              }
    expect(checked).toBe(64);
  });

  it("only pin, FORCE and fork name no model; a ranged pick is advice like `pass`", () => {
    const kept = (["pass", "ranged", "pin", "forced", "fork"] as const).map((model) =>
      keptModelOf({ model, effort: "pass" }),
    );
    expect(kept).toEqual([undefined, undefined, "pin", "force", "fork"]);
  });
});

/** Every real range: floor strictly below ceiling. */
const RANGES: ModelRange[] = TIERS.flatMap((floor, i) =>
  TIERS.slice(i + 1).map((ceiling) => ({ floor, ceiling })),
);
const rank = (t: Tier) => TIERS.indexOf(t);
/**
 * The tiers a ranged role may take, as a set: its range ∩ apply.floor..ceiling (a ceiling below
 * the floor yields to it, like clampTier). Independent of rangedTier's min/max arithmetic.
 */
const allowed = (range: ModelRange, floor: Tier, ceiling: Tier): Tier[] =>
  TIERS.filter(
    (_, i) =>
      i >= rank(range.floor) &&
      i <= rank(range.ceiling) &&
      i >= rank(floor) &&
      i <= Math.max(rank(floor), rank(ceiling)),
  );
/** The allowed tier closest to the verdict (the allowed tiers are one run of the ladder). */
const nearest = (tier: Tier, from: Tier[]): Tier | undefined =>
  [...from].sort((a, b) => Math.abs(rank(a) - rank(tier)) - Math.abs(rank(b) - rank(tier)))[0];

describe("the ranged pick: rangedTier, rangedPasses, rangedPart (#107)", () => {
  it("appliedTier is hooks.ts clampTier for every verdict and apply bound (#129)", () => {
    for (const tier of [...TIERS, "gpt"])
      for (const floor of TIERS)
        for (const ceiling of TIERS)
          expect(appliedTier(tier, floor, ceiling), `${tier} ${floor}..${ceiling}`).toBe(
            clampTier(tier, floor, ceiling),
          );
    expect(appliedTier(undefined, "haiku", "opus")).toBeUndefined();
  });

  it("picks the allowed tier nearest the verdict, for every range, apply bound and verdict", () => {
    expect(RANGES).toHaveLength(6);
    let checked = 0;
    for (const range of RANGES)
      for (const floor of TIERS)
        for (const ceiling of TIERS)
          for (const tier of TIERS) {
            const label = `${tier} in ${range.floor}..${range.ceiling}, apply ${floor}..${ceiling}`;
            const want = nearest(tier, allowed(range, floor, ceiling));
            expect(rangedTier(tier, range, floor, ceiling), label).toBe(want);
            checked++;
          }
    expect(checked).toBe(384);
  });

  it("has no pick when the range and the apply bounds do not meet, or the verdict is off the ladder", () => {
    const top: ModelRange = { floor: "opus", ceiling: "fable" };
    const low: ModelRange = { floor: "haiku", ceiling: "sonnet" };
    expect(allowed(top, "haiku", "sonnet")).toEqual([]);
    expect(rangedTier("fable", top, "haiku", "sonnet")).toBeUndefined();
    expect(rangedTier("opus", low, "opus", "fable")).toBeUndefined();
    // a ceiling below the floor leaves the floor alone: it is read like clampTier
    expect(rangedTier("fable", { floor: "haiku", ceiling: "fable" }, "sonnet", "haiku")).toBe(
      "sonnet",
    );
    expect(rangedTier("", low, "haiku", "opus")).toBeUndefined();
    expect(rangedTier("Opus", low, "haiku", "opus")).toBeUndefined();
  });

  it("a pick passes `model` only when it is not the fallback's tier, whatever spells the fallback", () => {
    expect(rangedPasses("haiku", "sonnet")).toBe(true);
    expect(rangedPasses("opus", "claude-sonnet-4-5")).toBe(true);
    expect(rangedPasses("sonnet", "sonnet")).toBe(false);
    expect(rangedPasses("sonnet", "claude-sonnet-4-5")).toBe(false);
    expect(rangedPasses("sonnet", "sonnet[1m]")).toBe(false);
    expect(rangedPasses("sonnet", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(false);
    expect(rangedPasses(undefined, "sonnet")).toBe(false);
  });

  it("names the pick, or the kept fallback with the reason it is kept", () => {
    const range: PlanRange = {
      floor: "haiku",
      ceiling: "opus",
      fallback: "sonnet[1m]",
    };
    expect(rangedPart(range, "haiku")).toBe("model haiku (range haiku–opus, fallback sonnet[1m])");
    expect(rangedPart(range, "sonnet")).toBe(
      "fallback sonnet[1m] (range haiku–opus; matches the adjudicator's pick)",
    );
    expect(rangedPart(range, undefined)).toBe(
      "fallback sonnet[1m] (range haiku–opus; no pick inside apply.floor..ceiling)",
    );
  });
});

describe("model_range from swarm.yaml to the adjudicator (#103, #107)", () => {
  const parse = (yaml: string) =>
    parseSwarmYaml(yaml, "/x/.eminiar/swarm.yaml", ".eminiar/swarm.yaml");
  const ok = (yaml: string): SwarmConfig => {
    const r = parse(yaml);
    if (r.state !== "ok") throw new Error(JSON.stringify(r));
    return r.config;
  };
  const issuesOf = (yaml: string): ConfigIssue[] => {
    const r = parse(yaml);
    if (r.state !== "invalid") throw new Error(`expected an invalid file:\n${yaml}`);
    return r.issues;
  };
  /** A one-swarm file `s`; each role is `{ description: x, <keys> }`. */
  const file = (agents: Record<string, string>, defaults = "") =>
    [
      ...(defaults ? ["defaults:", ...defaults.split("\n").map((l) => `  ${l}`)] : []),
      "swarms:",
      "  s:",
      "    description: d",
      "    agents:",
      ...Object.entries(agents).map(
        ([role, keys]) => `      ${role}: { description: x${keys ? `, ${keys}` : ""} }`,
      ),
      "",
    ].join("\n");
  const rangeOf = (c: SwarmConfig, role = "a") =>
    c.swarms[0]!.roles.find((r) => r.role === role)?.range;
  const R = (floor: Tier, ceiling: Tier): ModelRange => ({ floor, ceiling });
  const render = (c: SwarmConfig) => renderAgentFile(c, c.swarms[0]!, c.swarms[0]!.roles[0]!);

  it("refuses an inverted range, a fallback outside it, inherit as the fallback and no fallback", () => {
    const refused: Array<[string, string, string, RegExp]> = [
      [
        "floor above ceiling",
        file({
          a: "model: sonnet, model_range: { floor: opus, ceiling: haiku }",
        }),
        "swarms.s.agents.a.model_range",
        /floor must not be above ceiling \(haiku < sonnet < opus < fable\)/,
      ],
      [
        "floor above ceiling in the defaults",
        file({ a: "" }, "model: sonnet\nmodel_range: { floor: fable, ceiling: sonnet }"),
        "defaults.model_range",
        /floor must not be above ceiling/,
      ],
      [
        "fallback above the ceiling",
        file({ a: "model: opus, model_range: { ceiling: sonnet }" }),
        "swarms.s.agents.a.model_range",
        /^model opus is above the ceiling sonnet of model_range: the fallback must lie inside the range$/,
      ],
      [
        "fallback below the floor",
        file({ a: "model: haiku, model_range: { floor: sonnet }" }),
        "swarms.s.agents.a.model_range",
        /^model haiku is below the floor sonnet of model_range: the fallback must lie inside the range$/,
      ],
      [
        "inherit as the fallback",
        file({ a: "model: inherit, model_range: { floor: haiku }" }),
        "swarms.s.agents.a.model_range",
        /^model inherit cannot be the fallback of model_range/,
      ],
      [
        "inherit from the defaults, named once for two roles",
        file({ a: "", b: "" }, "model: inherit\nmodel_range: { floor: haiku, ceiling: opus }"),
        "defaults.model_range",
        /^defaults\.model inherit cannot be the fallback of defaults\.model_range/,
      ],
      [
        "no fallback at all",
        file({ a: "model_range: { floor: haiku, ceiling: opus }" }),
        "swarms.s.agents.a.model_range",
        /^model_range needs a fallback model inside it/,
      ],
      [
        "a fallback with no one tier",
        file({ a: "model: opusplan, model_range: { floor: haiku }" }),
        "swarms.s.agents.a.model_range",
        /^model opusplan has no single tier/,
      ],
    ];
    for (const [what, yaml, path, message] of refused) {
      const issues = issuesOf(yaml);
      expect(
        issues.map((i) => i.path),
        what,
      ).toEqual([path]);
      expect(issues[0]!.message, what).toMatch(message);
    }
  });

  it("accepts the boundaries next to those refusals", () => {
    const accepted: Array<[string, string, ModelRange | undefined]> = [
      ["fallback at the floor", "model: haiku, model_range: { ceiling: opus }", R("haiku", "opus")],
      ["fallback at the ceiling", "model: opus, model_range: { floor: haiku }", R("haiku", "opus")],
      [
        "bounds named at the fallback's tier",
        "model: sonnet, model_range: { floor: sonnet, ceiling: opus }",
        R("sonnet", "opus"),
      ],
      [
        "a model id reads as its family",
        'model: "claude-sonnet-4-5", model_range: { floor: haiku, ceiling: opus }',
        R("haiku", "opus"),
      ],
      [
        "a [1m] variant reads as its family",
        'model: "sonnet[1m]", model_range: { floor: haiku, ceiling: opus }',
        R("haiku", "opus"),
      ],
      ["inherit, opted out", "model: inherit, model_range: {}", undefined],
      ["no model, opted out", "model_range: {}", undefined],
      [
        "both bounds at the fallback: no range",
        "model: sonnet, model_range: { floor: sonnet, ceiling: sonnet }",
        undefined,
      ],
    ];
    for (const [what, keys, want] of accepted) {
      expect(rangeOf(ok(file({ a: keys }))), what).toEqual(want);
    }
    // a defaults problem only counts when some role takes the default as its fallback
    const own = ok(
      file(
        { a: "model: opus", b: "model: haiku, model_range: {}" },
        "model: inherit\nmodel_range: { floor: haiku, ceiling: opus }",
      ),
    );
    expect(rangeOf(own, "a")).toEqual(R("haiku", "opus"));
    expect(rangeOf(own, "b")).toBeUndefined();
  });

  it("a role without a real range renders byte for byte like one with no model_range at all", () => {
    const plain = render(ok(file({ a: "model: sonnet" })));
    expect(plain).not.toContain("range=");
    for (const keys of [
      "model_range: {}",
      "model_range: { floor: sonnet }",
      "model_range: { ceiling: sonnet }",
      "model_range: { floor: sonnet, ceiling: sonnet }",
    ])
      expect(render(ok(file({ a: `model: sonnet, ${keys}` }))), keys).toBe(plain);
    // the role opts out of a default range
    const optedOut = file(
      { a: "model: sonnet, model_range: {}" },
      "model_range: { floor: haiku, ceiling: opus }",
    );
    expect(render(ok(optedOut))).toBe(plain);

    // on disk too: switching the spelling rewrites nothing
    const root = mkdtempSync(join(tmpdir(), "em-ranged-bytes-"));
    const path = join(root, ".claude", "agents", "swarm-s-a.md");
    expect(syncAgents(root, ok(file({ a: "model: sonnet" }))).actions[0]!.action).toBe("create");
    const before = readFileSync(path, "utf8");
    expect(before).toBe(plain);
    for (const keys of ["model_range: {}", "model_range: { floor: sonnet }"]) {
      const res = syncAgents(root, ok(file({ a: `model: sonnet, ${keys}` })));
      expect(res.changed, keys).toBe(0);
      expect(readFileSync(path, "utf8"), keys).toBe(before);
    }
  });

  it("writes the range into the marker only, and re-syncing a new range moves the pin the adjudicator reads", () => {
    const p = project();
    const path = join(p.root, ".claude", "agents", "swarm-rng-coder.md");
    const pinOf = () =>
      resolveAgentPin("swarm-rng-coder", {
        root: p.root,
        env: { HOME: home },
        managedDir: null,
      });
    const sync = (yaml: string) => syncAgents(p.root, ok(yaml));

    const text = readFileSync(path, "utf8");
    const marker = text.split("\n").find((l) => l.startsWith("<!-- eminiar:swarm"))!;
    expect(marker).toMatch(
      /^<!-- eminiar:swarm swarm=rng role=coder range=haiku\.\.opus hash=[0-9a-f]{12} · /,
    );
    expect(text).toMatch(/^model: sonnet$/m);
    expect(text.replace(marker, "")).not.toContain("range");
    expect(pinOf()).toMatchObject({ status: "ranged", model: "sonnet" });

    // narrower: the file is updated and the adjudicator sees the new bounds
    sync(YAML.replace("{ floor: haiku, ceiling: opus }", "{ floor: sonnet, ceiling: opus }"));
    expect(pinOf()).toMatchObject({
      status: "ranged",
      range: { floor: "sonnet", ceiling: "opus" },
    });

    // dropped: a plain file again, and a plain pin
    sync(YAML.replace("        model_range: { floor: haiku, ceiling: opus }\n", ""));
    expect(readFileSync(path, "utf8")).not.toContain("range=");
    const plain = pinOf();
    expect(plain).toMatchObject({ status: "pinned", model: "sonnet" });
    expect(plain.range).toBeUndefined();
  });
});

describe("savings: the ranged row fields, the baseline order and the assumptions (#105, #107)", () => {
  const row = (scores: unknown) => ({ scores: JSON.stringify(scores) });

  it("rangedFallback reads the fallback only from a row flagged ranged, with a real pin", () => {
    expect(RANGED_FLAG).toBe("ranged");
    expect(FALLBACK_PIN_FIELD).toBe("fallbackPin");
    expect(rangedFallback(row({ ranged: true, fallbackPin: "sonnet" }))).toBe("sonnet");
    expect(rangedFallback(row({ ranged: true, fallbackPin: " claude-sonnet-4-5 " }))).toBe(
      "claude-sonnet-4-5",
    );
    expect(rangedFallback(row({ ranged: true, fallbackPin: "sonnet[1m]", pin: {} }))).toBe(
      "sonnet[1m]",
    );
    const notRanged: unknown[] = [
      { fallbackPin: "sonnet" }, // no flag
      { ranged: false, fallbackPin: "sonnet" },
      { ranged: "true", fallbackPin: "sonnet" }, // only the boolean true flags a row
      { ranged: 1, fallbackPin: "sonnet" },
      { ranged: true }, // no fallback
      { ranged: true, fallbackPin: "inherit" },
      { ranged: true, fallbackPin: "Inherit" },
      { ranged: true, fallbackPin: "   " },
      { ranged: true, fallbackPin: 3 },
      { ranged: true, fallbackPin: null },
    ];
    for (const scores of notRanged)
      expect(rangedFallback(row(scores)), JSON.stringify(scores)).toBeUndefined();
    for (const scores of [null, "", "{", "[]", "null", '"ranged"', "3"])
      expect(rangedFallback({ scores }), String(scores)).toBeUndefined();
    // a row read without its scores column at all
    expect(rangedFallback({} as Pick<AdjudicationRow, "scores">)).toBeUndefined();
    // rows written by the plan and the hook read back (the real producers' shape)
    const written = withKeptModel(null, "pin", {
      [RANGED_FLAG]: true,
      [FALLBACK_PIN_FIELD]: "haiku",
    });
    expect(rangedFallback({ scores: written ?? null })).toBe("haiku");
  });

  it("withKeptModel sets one KeptModel flag, clears the others and keeps the ranged fields", () => {
    const stored = JSON.stringify({
      role: { confidence: 0.9 },
      forced: true,
      fork: true,
    });
    const extra = { [RANGED_FLAG]: true, [FALLBACK_PIN_FIELD]: "sonnet" };
    const pin = withKeptModel(stored, "pin", extra)!;
    expect(JSON.parse(pin)).toEqual({
      role: { confidence: 0.9 },
      pinDeferred: true,
      ranged: true,
      fallbackPin: "sonnet",
    });
    expect(keptModel({ scores: pin })).toBe("pin");
    expect(rangedFallback({ scores: pin })).toBe("sonnet");
    // a pick that moves the model sets no flag and still marks the row ranged
    const moves = withKeptModel(stored, undefined, extra)!;
    expect(keptModel({ scores: moves })).toBeUndefined();
    expect(rangedFallback({ scores: moves })).toBe("sonnet");
    expect(JSON.parse(moves)).not.toHaveProperty("forced");
    // not an object: nothing to flag
    expect(withKeptModel("[]", "pin", extra)).toBeUndefined();
    expect(withKeptModel("{", "pin", extra)).toBeUndefined();
  });

  describe("resolveBaseline", () => {
    const sid = "BL-session";
    const dbOf = () => {
      const db = getStorage(getContext(project().root), { vectors: false });
      db.apiCallsUpsert([apiCall({ session_id: sid, model: "claude-opus-5-5" })]);
      return db;
    };
    const session = { model: "claude-opus-5-5", source: "session" };

    it("a ranged fallback pin outranks the frontmatter pin, the env model and the session; a blank one falls through", () => {
      const db = dbOf();
      const q = {
        sessionId: sid,
        ts: Date.now(),
        env: { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" },
        pinned: "opus",
      };
      expect(resolveBaseline(db, { ...q, fallbackPin: "sonnet" })).toEqual({
        model: "sonnet",
        source: "ranged",
      });
      expect(resolveBaseline(db, { ...q, fallbackPin: "  sonnet[1m] " })).toEqual({
        model: "sonnet[1m]",
        source: "ranged",
      });
      for (const blank of [undefined, null, "", "  ", "inherit", "Inherit"])
        expect(resolveBaseline(db, { ...q, fallbackPin: blank }), String(blank)).toEqual({
          model: "opus",
          source: "pinned",
        });
      // no pin at all: the env model, then the session's own
      const bare = { sessionId: sid, ts: Date.now() };
      expect(resolveBaseline(db, { ...bare, env: q.env })).toEqual({
        model: "haiku",
        source: "env",
      });
      expect(resolveBaseline(db, bare)).toEqual(session);
      expect(resolveBaseline(undefined, { ts: Date.now() })).toEqual({
        model: FALLBACK_MODEL,
        source: "fallback",
      });
    });

    it("reads CLAUDE_CODE_SUBAGENT_MODEL only from the env it is given, with FORCE off by Claude Code's rule (#124)", () => {
      const db = dbOf();
      const bare = { sessionId: sid, ts: Date.now() };
      const withEnv = (vars: Record<string, string>) => ({
        ...bare,
        env: vars,
      });
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = "haiku";
      process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = "0";
      try {
        // this process's variables are no dispatch's: reconcile runs elsewhere
        expect(resolveBaseline(db, bare)).toEqual(session);
        expect(resolveBaseline(db, { ...bare, env: {} })).toEqual(session);
      } finally {
        delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
        delete process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE;
      }
      const env = (force: string) =>
        withEnv({
          CLAUDE_CODE_SUBAGENT_MODEL: " sonnet ",
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: force,
        });
      // FORCE on: Claude Code sets the model, so the env model is no baseline
      for (const force of ["1", "true", "TRUE", "yes", "On", " on "])
        expect(resolveBaseline(db, env(force)), force).toEqual(session);
      // off, empty or undocumented: the env model is
      for (const force of ["0", "false", "no", "off", "OFF", "", "2", "y", "enabled"])
        expect(resolveBaseline(db, env(force)), force).toEqual({
          model: "sonnet",
          source: "env",
        });
      // no model, or inherit: nothing to price against
      for (const model of ["", "  ", "inherit"])
        expect(resolveBaseline(db, withEnv({ CLAUDE_CODE_SUBAGENT_MODEL: model })), model).toEqual(
          session,
        );
    });
  });

  it("the assumptions name the fallback baseline of a ranged role and the env baseline of an unpinned agent", () => {
    const all = SAVINGS_ASSUMPTIONS.join("\n");
    expect(all).toMatch(/model range the baseline is its fallback pin/);
    expect(all).toMatch(
      /no `model` line, the baseline is CLAUDE_CODE_SUBAGENT_MODEL when it is set \(and FORCE is off\)/,
    );
    const db = getStorage(getContext(project().root), { vectors: false });
    expect(savingsReport(db).assumptions).toEqual(expect.arrayContaining([...SAVINGS_ASSUMPTIONS]));
  });
});
