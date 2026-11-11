import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../../src/context.js";
import type { HookHandler, HookInput, HookOutput } from "../../src/hooks/types.js";

/**
 * The strict half of "a disabled adjudicator costs nothing" (memory adjudicator/hook-integration,
 * docs/design/adjudicator.md §10): with `adjudicator.enabled` off, no hook ever imports
 * src/adjudicator/hooks.ts, the only adjudicator module src/hooks/* calls. The mock-flag test in
 * tests/unit/adjudicator-hooks.test.ts cannot prove it any more (#132): its registry is shared by
 * every test of the file, so once a test with the adjudicator on has imported the module the mock
 * factory has run for good, and only "no export was read during this test" can be asserted there.
 *
 * So every test here boots its own module registry. `vi.resetModules()` drops the src/hooks/*
 * graph, and the stand-in for hooks.ts is registered again with `vi.doMock`: resetModules keeps
 * the result a mock factory already returned (the registry's `mock:` entries), and registering the
 * mock anew is what discards it. The stand-in records when its factory runs (the module was
 * imported), which of its exports are read (a call-out was reached) and which are called, each with
 * the hook step that was running. The `on` tests show the probe sees each of the call-out sites, so
 * the `off` tests cannot pass by the probe being blind. Nothing depends on the order tests run in.
 */

/** The module under test, as the five call-out sites import it. */
const HOOKS = "../../src/adjudicator/hooks.js";

const ADJUDICATOR_DIR = join(__dirname, "../../src/adjudicator");
/**
 * The rest of src/adjudicator, probed too. types.ts is left out: src/config.ts imports its
 * constants (MODES, PROVIDER_IDS, TIERS) in every hook process. So is redact.ts: the index masks
 * captured output with its redactSecrets() in every hook process (pure text rules, no adjudicator
 * state or call-out). hooks.ts has the stand-in.
 */
const NOT_PROBED = new Set(["types.ts", "redact.ts", "hooks.ts"]);
const OTHER_MODULES = readdirSync(ADJUDICATOR_DIR, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !NOT_PROBED.has(f))
  .sort();

/** What the probes recorded since the last boot(). */
const probe = {
  /** The step that was running each time the stand-in's factory ran: once per registry that imports it. */
  evaluated: [] as string[],
  /** `<export> @ <step>` for each read of one of the stand-in's exports (every call-out reads one). */
  reads: [] as string[],
  /** The stand-in's functions that were called, in order. */
  calls: [] as string[],
  /** `<file> @ <step>` for each other adjudicator module that was imported. */
  others: [] as string[],
  /** The step being driven; `boot` while the hook modules are imported. */
  step: "boot",
};

/**
 * The exports src/hooks/* destructure, with the sync/async shape of the real ones so the call-outs
 * behave. They have nothing to say (afterRouting hands routing's output back untouched).
 */
function hooksStandIn(): Record<string, unknown> {
  probe.evaluated.push(probe.step);
  const called = (name: string): void => {
    probe.calls.push(name);
  };
  const fns: Record<string, unknown> = {
    onPrompt: async () => called("onPrompt"),
    afterRouting: async (_ctx: unknown, _input: unknown, _spawn: unknown, out: unknown) => {
      called("afterRouting");
      return out;
    },
    onPreAgent: async () => called("onPreAgent"),
    onPreTool: () => called("onPreTool"),
    onPostAgent: () => called("onPostAgent"),
    onSessionStart: () => called("onSessionStart"),
    onSessionEnd: () => called("onSessionEnd"),
  };
  return new Proxy(fns, {
    get(target, key, receiver) {
      if (typeof key === "string" && Object.hasOwn(target, key))
        probe.reads.push(`${key} @ ${probe.step}`);
      return Reflect.get(target, key, receiver);
    },
  });
}

/** The same module as a corrupt or missing install would have it: importing it throws. */
function hooksThatFailToLoad(): never {
  probe.evaluated.push(probe.step);
  throw new Error("hooks.ts failed to load");
}

const envBefore: Record<string, string | undefined> = {};
beforeAll(() => {
  Object.assign(envBefore, process.env);
});

/** Everything a test made: closers for the booted registries, then the temp dirs. */
let closers: Array<() => void> = [];
let scratch: string[] = [];
let session = 0;
afterEach(() => {
  try {
    for (const close of closers.reverse()) close();
  } finally {
    closers = [];
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    scratch = [];
  }
});
afterAll(() => {
  vi.doUnmock(HOOKS);
  for (const file of OTHER_MODULES) vi.doUnmock(join(ADJUDICATOR_DIR, file));
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
  for (const [k, v] of Object.entries(envBefore)) if (v !== undefined) process.env[k] = v;
});

/** What a test decides about the machine the hooks run on. */
interface Setup {
  /** EMINIAR_HOME/config.json, the personal config (the only one that may hold a provider). */
  personal?: Record<string, unknown>;
  /** <root>/eminiar.config.json, next to the routing settings every test needs. */
  project?: Record<string, unknown>;
  /** Environment variables of the hook process (EMINIAR_*). */
  env?: Record<string, string>;
  /** Importing hooks.ts throws instead of returning the stand-in. */
  hooksBroken?: boolean;
}

interface World {
  root: string;
  sid: string;
  handlers: Record<string, HookHandler>;
  /** The context the handlers see (resolved once, from the files written for this test). */
  context(): ProjectContext;
}

const tmp = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `em-adj-off-${label}-`));
  scratch.push(dir);
  return dir;
};

/**
 * A project, an EMINIAR_HOME and a user HOME of its own, no EMINIAR_*, CLAUDE_* or CURSOR_*
 * variable from the machine running the tests, and a module registry nobody has used: the hook
 * handlers are imported only now, after the probes are registered anew.
 */
async function boot(setup: Setup = {}): Promise<World> {
  for (const k of Object.keys(process.env))
    if (/^(EMINIAR_|CLAUDE_|CURSOR_)/.test(k)) delete process.env[k];
  const home = tmp("home");
  const user = tmp("user");
  const root = tmp("root");
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "eminiar.config.json"),
    JSON.stringify({ routing: { mode: "enforce", deferToContextMode: false }, ...setup.project }),
  );
  if (setup.personal) writeFileSync(join(home, "config.json"), JSON.stringify(setup.personal));
  process.env.EMINIAR_HOME = home;
  // User-level and plugin agents are read from HOME: keep the real ~/.claude out of the test.
  process.env.HOME = user;
  process.env.CLAUDE_PROJECT_DIR = root;
  Object.assign(process.env, setup.env);

  probe.evaluated = [];
  probe.reads = [];
  probe.calls = [];
  probe.others = [];
  probe.step = "boot";
  vi.resetModules();
  vi.doMock(HOOKS, setup.hooksBroken ? hooksThatFailToLoad : hooksStandIn);
  for (const file of OTHER_MODULES)
    vi.doMock(join(ADJUDICATOR_DIR, file), async (importOriginal) => {
      probe.others.push(`${file} @ ${probe.step}`);
      return importOriginal();
    });
  const { handlers } = await import("../../src/hooks/index.js");
  const { getContext } = await import("../../src/context.js");
  const { closeAllStorage } = await import("../../src/storage/index.js");
  const { globalDb } = await import("../../src/stats/global.js");
  closers.push(() => {
    closeAllStorage();
    // SessionEnd keeps the global database warm: this registry's copy goes with its project's.
    process.env.EMINIAR_HOME = home;
    globalDb().close();
  });
  return { root, sid: `S${++session}`, handlers, context: () => getContext(root) };
}

/** One hook call of a session, and the stand-in function its call-out reaches while it is on. */
interface Step {
  label: string;
  event: string;
  input(): Partial<HookInput>;
  /** The export of hooks.ts this handler calls with the adjudicator on; none for the rest. */
  call?: string;
}

const AGENT_INPUT = (): Record<string, unknown> => ({
  description: "find the parser",
  prompt: "Find where the config parser is defined and list its callers.",
  subagent_type: "general-purpose",
  run_in_background: true,
});

/** A session in the order Claude Code fires it. The steps with a `call` are the call-out sites. */
const STEPS: Step[] = [
  {
    label: "SessionStart",
    event: "SessionStart",
    input: () => ({ source: "startup" }),
    call: "onSessionStart",
  },
  {
    label: "UserPromptSubmit",
    event: "UserPromptSubmit",
    input: () => ({
      prompt: "Refactor the storage adapter so every store shares one transaction helper.",
    }),
    call: "onPrompt",
  },
  {
    label: "PreToolUse(Agent)",
    event: "PreToolUse",
    input: () => ({ tool_name: "Agent", tool_input: AGENT_INPUT() }),
    call: "afterRouting",
  },
  {
    label: "PostToolUse(Agent)",
    event: "PostToolUse",
    input: () => ({
      tool_name: "Agent",
      tool_input: AGENT_INPUT(),
      tool_use_id: "toolu_off",
      tool_response: { status: "async_launched", agentId: "aoff", resolvedModel: "x" },
    }),
    call: "onPostAgent",
  },
  {
    label: "PreToolUse(Bash)",
    event: "PreToolUse",
    input: () => ({ tool_name: "Bash", tool_input: { command: "pwd" } }),
    call: "afterRouting",
  },
  {
    label: "PostToolUse(Bash)",
    event: "PostToolUse",
    input: () => ({
      tool_name: "Bash",
      tool_input: { command: "pwd" },
      tool_response: "/work/project\n",
    }),
  },
  {
    label: "PostToolUseFailure(Bash)",
    event: "PostToolUseFailure",
    input: () => ({
      tool_name: "Bash",
      tool_input: { command: "false" },
      error: "Exit code 1",
    }),
  },
  {
    label: "SubagentStart",
    event: "SubagentStart",
    input: () => ({ agent_id: "aoff", agent_type: "general-purpose" }),
  },
  {
    label: "SubagentStop",
    event: "SubagentStop",
    input: () => ({
      agent_id: "aoff",
      agent_type: "general-purpose",
      last_assistant_message: "The parser is defined in src/config.ts; callers: context.ts.",
    }),
  },
  { label: "PreCompact", event: "PreCompact", input: () => ({ trigger: "auto" }) },
  {
    label: "Stop",
    event: "Stop",
    input: () => ({ last_assistant_message: "Done: the helper is shared." }),
  },
  {
    label: "SessionEnd",
    event: "SessionEnd",
    input: () => ({ reason: "exit" }),
    call: "onSessionEnd",
  },
];

/** The steps whose handler has a call-out: the places hooks.ts can be imported from. */
const SITES = STEPS.filter((s) => s.call);
const step = (label: string): Step => {
  const found = STEPS.find((s) => s.label === label);
  if (!found) throw new Error(`no step ${label}`);
  return found;
};

async function fire(
  w: World,
  s: Step,
  over: Partial<HookInput> = {},
): Promise<HookOutput | undefined> {
  const handler = w.handlers[s.event];
  if (!handler) throw new Error(`src/hooks/index.ts has no ${s.event} handler`);
  probe.step = s.label;
  const out = await handler({
    session_id: w.sid,
    cwd: w.root,
    hook_event_name: s.event,
    ...s.input(),
    ...over,
  });
  probe.step = "idle";
  return out;
}

/**
 * Every event src/hooks/index.ts registers that STEPS has no step for, with a bare payload, so a
 * call-out added to a handler this file has not heard of is driven too.
 */
async function sweep(
  w: World,
  over: Partial<HookInput> = {},
): Promise<Record<string, HookOutput | undefined>> {
  const out: Record<string, HookOutput | undefined> = {};
  const known = new Set(STEPS.map((s) => s.event));
  for (const event of Object.keys(w.handlers))
    if (!known.has(event))
      out[event] = await fire(w, { label: event, event, input: () => ({}) }, over);
  return out;
}

/** A whole session: every step in order, then the sweep. */
async function runSession(
  w: World,
  over: Partial<HookInput> = {},
): Promise<Record<string, HookOutput | undefined>> {
  const out: Record<string, HookOutput | undefined> = {};
  for (const s of STEPS) out[s.label] = await fire(w, s, over);
  return { ...out, ...(await sweep(w, over)) };
}

const ADJUDICATOR_TABLES = [
  "adjudications",
  "adjudicator_bias",
  "adjudicator_cache",
  "adjudicator_provider_state",
];

/** Rows in every adjudicator table of the project database, and the adjudicator meta keys. */
function footprint(w: World): { rows: Record<string, number>; meta: string[] } {
  const db = new Database(w.context().dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'adjudicat%'")
      .pluck()
      .all() as string[];
    const rows = Object.fromEntries(
      tables
        .sort()
        .map((t) => [t, (db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get() as number) ?? 0]),
    );
    const meta = db
      .prepare("SELECT key FROM meta WHERE key LIKE 'adjudicator:%' ORDER BY key")
      .pluck()
      .all() as string[];
    return { rows, meta };
  } finally {
    db.close();
  }
}

/** The adjudicator never ran: hooks.ts not imported, no export read, no call, no row, no meta key. */
function expectUntouched(w: World): void {
  // One object, so a failure lists every site that got through, not just the first.
  expect({ imported: probe.evaluated, read: probe.reads, called: probe.calls }).toEqual({
    imported: [],
    read: [],
    called: [],
  });
  const { rows, meta } = footprint(w);
  // The tables exist (the migration runs for every project); the check is that they stay empty.
  expect(Object.keys(rows)).toEqual(expect.arrayContaining(ADJUDICATOR_TABLES));
  expect({
    "rows in adjudicator tables": Object.fromEntries(Object.entries(rows).filter(([, n]) => n > 0)),
    "adjudicator meta keys": meta,
  }).toEqual({ "rows in adjudicator tables": {}, "adjudicator meta keys": [] });
}

/** A personal config that sets the adjudicator up completely; `enabled` is the caller's. */
const configured = (enabled: boolean): Record<string, unknown> => ({
  adjudicator: {
    enabled,
    mode: "apply",
    provider: "openai-compatible",
    openai: { preset: "ollama" },
    promptMode: "blocking",
    surfaces: { prompt: true, agent: true, plan: true, tools: true },
    apply: { scope: "all", minConfidence: 0 },
    advice: { mainSession: "user", cooldownPrompts: 1 },
  },
});

/**
 * Every way the adjudicator is off. `mode` (when the setup picks one) shows the rest of the
 * section was read, so "off" is the `enabled` flag and not a fallback to defaults.
 */
const OFF: Array<{ name: string; setup: Setup; mode?: string }> = [
  { name: "never configured", setup: {} },
  {
    name: "enabled: false in the personal config",
    setup: { personal: { adjudicator: { enabled: false } } },
  },
  {
    name: "fully configured, then switched off",
    setup: { personal: configured(false) },
    mode: "apply",
  },
  {
    name: "the project file opts out of a personal opt-in",
    setup: { personal: configured(true), project: { adjudicator: { enabled: false } } },
    mode: "apply",
  },
  {
    name: "EMINIAR_ADJUDICATOR=0 over a personal opt-in",
    setup: { personal: configured(true), env: { EMINIAR_ADJUDICATOR: "0" } },
    mode: "apply",
  },
];

describe("adjudicator off: hooks.ts is never imported", () => {
  it.each(OFF.map((c) => [c.name, c] as const))(
    "%s: a whole session reaches no call-out and writes nothing",
    async (_name, c) => {
      const w = await boot(c.setup);
      // Importing every hook module already left hooks.ts alone.
      expect(probe.evaluated).toEqual([]);

      const out = await runSession(w);

      expect(w.context().config.adjudicator).toMatchObject({
        enabled: false,
        ...(c.mode ? { mode: c.mode } : {}),
      });
      expectUntouched(w);
      // Routing's own answers: no model or effort for the Agent call, no advice anywhere.
      const updated = out["PreToolUse(Agent)"]?.hookSpecificOutput?.updatedInput;
      expect(updated?.model).toBeUndefined();
      expect(updated?.effort).toBeUndefined();
      expect(out.UserPromptSubmit?.systemMessage).toBeUndefined();
      // The call-outs speak as "eminiar adjudicator: ..." or "adjudicator: model ...".
      expect(JSON.stringify(out)).not.toMatch(/adjudicator:/i);
    },
  );

  it("sweeps an event it has no step for, so a call-out added to a new handler is caught", async () => {
    const w = await boot();
    // A handler somebody adds later, with an import nobody guarded.
    w.handlers.Notification = async () => {
      await import("../../src/adjudicator/hooks.js");
      return undefined;
    };
    await sweep(w);
    expect(probe.evaluated).toEqual(["Notification"]);
  });

  it("keeps redact.ts, which hooks load while it is off, free of other modules", () => {
    const src = readFileSync(join(ADJUDICATOR_DIR, "redact.ts"), "utf8");
    const specifiers = [...src.matchAll(/^import[^"]*"([^"]+)";$/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s?.startsWith("node:"))).toEqual([]);
  });

  it("imports no other adjudicator module either: only types.ts and redact.ts, which config and the index need", async () => {
    const w = await boot();
    expect(OTHER_MODULES).toEqual(expect.arrayContaining(["engine.ts", "providers/http.ts"]));
    await runSession(w);
    expect(probe.others).toEqual([]);
  });
});

describe("adjudicator on: the probe sees each call-out", () => {
  const on: Setup = { personal: { adjudicator: { enabled: true } } };

  it.each(SITES)("$label imports hooks.ts and calls $call", async (site) => {
    const w = await boot(on);
    expect(probe.evaluated, "importing the hook modules").toEqual([]);

    await fire(w, site);

    expect(w.context().config.adjudicator.enabled).toBe(true);
    // The factory ran once, inside this handler, and the call-out reached exactly its export.
    expect(probe.evaluated).toEqual([site.label]);
    expect(probe.reads).toEqual([`${site.call} @ ${site.label}`]);
    expect(probe.calls).toEqual([site.call]);
  });

  it("a fresh registry imports it again: no test inherits another's import", async () => {
    const handlerSets = new Set<unknown>();
    for (const round of [1, 2, 3]) {
      const w = await boot(on);
      handlerSets.add(w.handlers);
      await fire(w, step("UserPromptSubmit"));
      expect(probe.evaluated, `round ${round}`).toEqual(["UserPromptSubmit"]);
    }
    // `handlers` is a module-level object of src/hooks/index.ts: three registries, three copies.
    expect(handlerSets.size).toBe(3);
  });
});

describe("adjudicator on, hooks.ts cannot be loaded", () => {
  it.each(SITES)("$label still answers, as it does with the adjudicator off", async (site) => {
    const w = await boot({ personal: { adjudicator: { enabled: true } }, hooksBroken: true });

    // fire() resolves: the call-out swallows the failed import.
    const out = await fire(w, site);

    expect(w.context().config.adjudicator.enabled).toBe(true);
    expect(probe.evaluated, "the import was attempted").toEqual([site.label]);
    expect(probe.calls).toEqual([]);
    expect(out?.hookSpecificOutput?.updatedInput?.model).toBeUndefined();
    expect(JSON.stringify(out ?? {})).not.toMatch(/adjudicator:/i);
  });
});

describe("the Cursor client", () => {
  it("never loads hooks.ts, even with the adjudicator on", async () => {
    const w = await boot({ personal: { adjudicator: { enabled: true } } });
    await runSession(w, { client: "cursor" });
    expect(w.context().config.adjudicator.enabled).toBe(true);
    expectUntouched(w);
  });
});
