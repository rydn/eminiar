import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTONOMIES,
  CAP_TAG,
  CAPS,
  CUE_IDS,
  FLOOR_IDS,
  GRANT_KINDS,
  INTENT_CUE_IDS,
  LEVELS,
  MIN_LEVELS,
  NOTIFY_LEVELS,
  REMEDY_ACTION_IDS,
  RULE_IDS,
  SECURITY_ACTIONS,
  SECURITY_MODEL_SETTINGS,
  SECURITY_SURFACES,
  SECURITY_VERSION,
  THREATS,
} from "../../src/adjudicator/security/types.js";
import {
  MIN_LEVELS as ADJUDICATOR_MIN_LEVELS,
  SECURITY_MODEL_SETTINGS as ADJUDICATOR_MODEL_SETTINGS,
  NOTIFY_LEVELS as ADJUDICATOR_NOTIFY_LEVELS,
  SURFACES,
  TIERS,
} from "../../src/adjudicator/types.js";
import {
  type AdjudicatorConfig,
  AdjudicatorConfigSchema,
  adjudicatorDefaults,
  adjudicatorWanted,
  ConfigSchema,
  droppedProjectAdjudicatorKeys,
  loadConfig,
  personalConfigTrusted,
  projectAdjudicatorWarning,
} from "../../src/config.js";

const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_MODE",
  "EMINIAR_ADJUDICATOR_REMOTE",
  "EMINIAR_ADJUDICATOR_SECURITY",
];

let home: string;
let root: string;
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "em-sec-home-"));
  root = mkdtempSync(join(tmpdir(), "em-sec-root-"));
  process.env.EMINIAR_HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

type Sec = AdjudicatorConfig["security"];
const DEFAULT_SECURITY: Sec = {
  enabled: false,
  model: "off",
  surfaces: { agent: true, plan: true, prompt: true },
  minLevel: "high",
  notifyUser: "critical",
  modelFloor: "sonnet",
  trustedMcpServers: [],
  secretPaths: [],
  taintLookbackMin: 240,
  store: true,
};
/** Every security key set to something that is not the default. */
const FULL: Sec = {
  enabled: true,
  model: "provider",
  surfaces: { agent: false, plan: true, prompt: false },
  minLevel: "medium",
  notifyUser: "high",
  modelFloor: "opus",
  trustedMcpServers: ["corp-tools"],
  secretPaths: ["vault/*.txt"],
  taintLookbackMin: 30,
  store: false,
};

const sec = (over: Record<string, unknown> = {}): Sec =>
  ConfigSchema.parse({ adjudicator: { security: over } }).adjudicator.security;
const project = (adjudicator: Record<string, unknown>) =>
  writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ adjudicator }));
const personal = (adjudicator: Record<string, unknown>) =>
  writeFileSync(join(home, "config.json"), JSON.stringify({ adjudicator }));

describe("adjudicator.security defaults", () => {
  it("is off, advice only and bounded by default", () => {
    expect(sec()).toEqual(DEFAULT_SECURITY);
    expect(ConfigSchema.parse({}).adjudicator.security).toEqual(DEFAULT_SECURITY);
    expect(adjudicatorDefaults().security).toEqual(DEFAULT_SECURITY);
  });

  it("adjudicatorDefaults() matches the schema key for key, in the same order", () => {
    const viaSchema = AdjudicatorConfigSchema.parse({});
    expect(JSON.stringify(adjudicatorDefaults().security)).toBe(JSON.stringify(viaSchema.security));
    // security comes last, so a section written before it existed round-trips unchanged
    expect(Object.keys(viaSchema).at(-1)).toBe("security");
    // a fresh object per call, so a caller mutating its config cannot change the next one
    expect(adjudicatorDefaults().security).not.toBe(adjudicatorDefaults().security);
    expect(adjudicatorDefaults().security.trustedMcpServers).not.toBe(
      adjudicatorDefaults().security.trustedMcpServers,
    );
  });

  it("a partial section fills in the rest and round-trips", () => {
    const s = sec({ enabled: true, surfaces: { prompt: false }, minLevel: "critical" });
    expect(s).toEqual({
      ...DEFAULT_SECURITY,
      enabled: true,
      surfaces: { agent: true, plan: true, prompt: false },
      minLevel: "critical",
    });
    expect(sec(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(sec(FULL)).toEqual(FULL);
  });

  it("refuses values outside the documented ranges", () => {
    for (const bad of [
      { model: "local" },
      { model: true },
      { minLevel: "low" },
      { minLevel: "severe" },
      { notifyUser: "medium" },
      { notifyUser: true },
      { modelFloor: "gpt" },
      { trustedMcpServers: "github" },
      { trustedMcpServers: [""] },
      { trustedMcpServers: ["x".repeat(129)] },
      { trustedMcpServers: Array.from({ length: 65 }, (_, i) => `s${i}`) },
      { secretPaths: ["x".repeat(201)] },
      { secretPaths: ["bad\npattern"] },
      { secretPaths: [""] },
      { secretPaths: Array.from({ length: 65 }, (_, i) => `p${i}`) },
      { taintLookbackMin: -1 },
      { taintLookbackMin: 1441 },
      { taintLookbackMin: 1.5 },
      { store: "yes" },
      { enabled: "no" },
      { surfaces: { agent: "on" } },
    ])
      expect(
        ConfigSchema.safeParse({ adjudicator: { security: bad } }).success,
        JSON.stringify(bad),
      ).toBe(false);
    // the edges of the ranges are fine
    expect(sec({ taintLookbackMin: 0 }).taintLookbackMin).toBe(0);
    expect(sec({ taintLookbackMin: 1440 }).taintLookbackMin).toBe(1440);
    expect(sec({ secretPaths: ["x".repeat(200)] }).secretPaths).toHaveLength(1);
    expect(
      sec({ trustedMcpServers: Array.from({ length: 64 }, (_, i) => `s${i}`) }).trustedMcpServers,
    ).toHaveLength(64);
    for (const t of TIERS) expect(sec({ modelFloor: t }).modelFloor).toBe(t);
  });

  it("secretPaths passes the key-like field check, anything else key-like in security does not", () => {
    // The name matches /secret/ but it is a list of file patterns, and only at security.secretPaths.
    expect(sec({ secretPaths: ["~/.config/vault/*"] }).secretPaths).toEqual(["~/.config/vault/*"]);
    for (const bad of [
      { security: { apiKey: "sk-123" } },
      { security: { token: "x" } },
      { security: { password: "x" } },
      { security: { secretPaths: { apiKey: "x" } } },
      { secretPaths: ["a"] }, // not under security: still key-like
      { security: { surfaces: { secretPaths: ["a"] } } },
    ]) {
      const r = ConfigSchema.safeParse({ adjudicator: bad });
      expect(r.success, JSON.stringify(bad)).toBe(false);
    }
    const r = ConfigSchema.safeParse({ adjudicator: { security: { apiKey: "sk-123" } } });
    expect(r.error?.issues[0]?.message).toMatch(/eminiar adjudicator key set/);
  });
});

describe("loadConfig: the security section", () => {
  it("without any file or env it is the defaults, via the fast path", () => {
    const c = loadConfig(root).adjudicator;
    expect(c).toStrictEqual(adjudicatorDefaults());
    expect(c.security.enabled).toBe(false);
  });

  it("an untouched security section (absent, or only enabled:false) takes the defaults", () => {
    // `security: {enabled: false}` is what EMINIAR_ADJUDICATOR_SECURITY=0 injects; it must not
    // change anything, with or without the adjudicator.
    for (const section of [
      { security: { enabled: false } },
      { enabled: false, security: { enabled: false } },
      { security: {} },
    ]) {
      personal(section);
      expect(loadConfig(root).adjudicator).toStrictEqual(adjudicatorDefaults());
    }
  });

  it("the bare security switch skips the adjudicator schema; anything else in security builds it", () => {
    // ConfigSchema.safeParse is the slow path of parseConfig (the full adjudicator schema).
    const slow = vi.spyOn(ConfigSchema, "safeParse");
    personal({ security: { enabled: false } });
    loadConfig(root);
    process.env.EMINIAR_ADJUDICATOR_SECURITY = "0";
    loadConfig(root);
    expect(slow).not.toHaveBeenCalled();
    personal({ security: { enabled: false, store: false } });
    loadConfig(root);
    expect(slow).toHaveBeenCalledTimes(1);
    delete process.env.EMINIAR_ADJUDICATOR_SECURITY;
    // security-only mode (`enabled: true` and nothing else, from any layer) pays no zod pass either
    personal({ security: { enabled: true } });
    loadConfig(root);
    process.env.EMINIAR_ADJUDICATOR_SECURITY = "1";
    personal({});
    loadConfig(root);
    delete process.env.EMINIAR_ADJUDICATOR_SECURITY;
    project({ security: { enabled: true } });
    loadConfig(root);
    expect(slow).toHaveBeenCalledTimes(1);
    // a switch that is not a boolean is the schema's to refuse
    project({});
    personal({ security: { enabled: "yes" } });
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadConfig(root).adjudicator.security.enabled).toBe(false);
    // the merged layers, then the personal file alone (loadConfig drops only the invalid layer)
    expect(slow).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("invalid config");
  });

  it("the fast path for the bare switch equals the schema's answer", () => {
    for (const section of [
      { security: { enabled: true } },
      { enabled: false, security: { enabled: true } },
    ]) {
      personal(section);
      const fast = loadConfig(root).adjudicator;
      expect(fast).toStrictEqual(AdjudicatorConfigSchema.parse(section));
      expect(JSON.stringify(fast)).toBe(JSON.stringify(AdjudicatorConfigSchema.parse(section)));
      expect(fast.security.enabled).toBe(true);
    }
  });

  it("the personal config sets every security key", () => {
    personal({ security: FULL });
    expect(loadConfig(root).adjudicator.security).toEqual(FULL);
    // and it does not turn the routing adjudicator on
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
  });

  it("a bad personal security value drops the whole config to the defaults", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    personal({ security: { minLevel: "low" } });
    expect(loadConfig(root).adjudicator).toStrictEqual(adjudicatorDefaults());
    expect(String(err.mock.calls[0]?.[0])).toMatch(/invalid config/);
  });
});

describe("project layer: a repo may only switch security on", () => {
  it("keeps security.enabled: true, and nothing else of the security section", () => {
    project({ security: { ...FULL, enabled: true } });
    const c = loadConfig(root).adjudicator.security;
    expect(c).toEqual({ ...DEFAULT_SECURITY, enabled: true });
    // the egress opt-in in particular
    expect(c.model).toBe("off");
  });

  it("names every dropped key by its path, sorted, in the one-line warning", () => {
    project({ security: { ...FULL, enabled: true } });
    const dropped = Object.keys(FULL)
      .filter((k) => k !== "enabled")
      .map((k) => `security.${k}`)
      .sort();
    expect(droppedProjectAdjudicatorKeys({ adjudicator: { security: FULL } })).toEqual(dropped);
    const w = projectAdjudicatorWarning(root);
    expect(w).toBe(
      `eminiar.config.json sets adjudicator.${dropped.join(", adjudicator.")}: ignored, only ~/.eminiar/config.json may set them`,
    );
    expect(w).not.toMatch(/\n/);
    project({ security: { enabled: true, minLevel: "critical" } });
    expect(projectAdjudicatorWarning(root)).toBe(
      "eminiar.config.json sets adjudicator.security.minLevel: ignored, only ~/.eminiar/config.json may set it",
    );
  });

  it("security.enabled: true on its own is no warning", () => {
    project({ security: { enabled: true } });
    expect(projectAdjudicatorWarning(root)).toBeUndefined();
    expect(droppedProjectAdjudicatorKeys({ adjudicator: { security: { enabled: true } } })).toEqual(
      [],
    );
    expect(droppedProjectAdjudicatorKeys({ adjudicator: { security: {} } })).toEqual([]);
  });

  it("a repo cannot switch it off, hide a warning or shrink what is judged", () => {
    personal({ security: { enabled: true, minLevel: "medium", notifyUser: "high", store: true } });
    project({
      security: {
        enabled: false,
        minLevel: "critical",
        notifyUser: "off",
        surfaces: { agent: false, plan: false, prompt: false },
        store: false,
        taintLookbackMin: 0,
        modelFloor: "haiku",
        trustedMcpServers: ["evil"],
        secretPaths: ["nothing-here"],
      },
    });
    const c = loadConfig(root).adjudicator.security;
    expect(c).toEqual({
      ...DEFAULT_SECURITY,
      enabled: true,
      minLevel: "medium",
      notifyUser: "high",
    });
    expect(
      droppedProjectAdjudicatorKeys(
        JSON.parse(readFileSync(join(root, "eminiar.config.json"), "utf8")),
      ),
    ).toContain("security.enabled");
  });

  it("only a boolean true counts as on", () => {
    for (const enabled of ["true", 1, "yes", null, [true], { v: true }]) {
      project({ security: { enabled } });
      expect(loadConfig(root).adjudicator.security.enabled, JSON.stringify(enabled)).toBe(false);
      expect(droppedProjectAdjudicatorKeys({ adjudicator: { security: { enabled } } })).toEqual([
        "security.enabled",
      ]);
    }
  });

  it("a security section that is not an object is dropped and named, without breaking the config", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const security of [true, "on", 1, ["enabled"], null]) {
      project({ enabled: true, security, minPromptChars: 33 });
      const c = loadConfig(root).adjudicator;
      expect(c.security).toEqual(DEFAULT_SECURITY);
      expect(c.enabled, JSON.stringify(security)).toBe(true); // the rest of the section applies
      expect(c.minPromptChars).toBe(33);
      expect(droppedProjectAdjudicatorKeys({ adjudicator: { security } })).toEqual(["security"]);
    }
    expect(err).not.toHaveBeenCalled();
  });

  it("a project secretPaths does not make the whole config invalid", () => {
    // `secretPaths` matches the key-like field check's name pattern; it is exempt at
    // security.secretPaths, so the cut can drop it instead of the schema refusing the file.
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({
        search: { defaultLimit: 7 },
        adjudicator: { security: { enabled: true, secretPaths: ["x/*"] } },
      }),
    );
    const c = loadConfig(root);
    expect(err).not.toHaveBeenCalled();
    expect(c.search.defaultLimit).toBe(7);
    expect(c.adjudicator.security).toEqual({ ...DEFAULT_SECURITY, enabled: true });
  });

  it("a key-like field in a project security section still refuses the whole config", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    project({ security: { enabled: true, apiKey: "sk-leak" } });
    expect(loadConfig(root).adjudicator).toStrictEqual(adjudicatorDefaults());
    expect(String(err.mock.calls[0]?.[0])).toMatch(/invalid config/);
  });

  it("a __proto__ key in the project's security section grants nothing", () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      '{"adjudicator":{"security":{"__proto__":{"model":"provider","enabled":true},"constructor":{"model":"provider"}}}}',
    );
    const c = loadConfig(root).adjudicator.security;
    expect(c.model).toBe("off");
    expect(c.enabled).toBe(false);
    expect(({} as Record<string, unknown>).model).toBeUndefined();
  });

  it("a project may turn security on without the adjudicator, and the adjudicator stays off", () => {
    project({ security: { enabled: true } });
    const c = loadConfig(root).adjudicator;
    expect([c.enabled, c.security.enabled, c.security.model]).toEqual([false, true, "off"]);
  });

  it("an untrusted personal config (inside the project) gets the same cut", () => {
    const em = join(root, ".em");
    mkdirSync(em, { recursive: true });
    writeFileSync(
      join(em, "config.json"),
      JSON.stringify({ adjudicator: { security: { ...FULL, enabled: true } } }),
    );
    process.env.EMINIAR_HOME = em;
    expect(personalConfigTrusted(root)).toBe(false);
    const c = loadConfig(root).adjudicator.security;
    expect(c).toEqual({ ...DEFAULT_SECURITY, enabled: true });
    expect(c.model).toBe("off");
    const w = projectAdjudicatorWarning(root) ?? "";
    expect(w).toMatch(
      /^adjudicator\.security\.minLevel, adjudicator\.security\.model, .* ignored: .*inside this project/,
    );
    expect(w).toMatch(/adjudicator\.security\.trustedMcpServers/);
    expect(w).not.toMatch(/\n/);
  });

  it("a trusted personal config keeps its own security keys under a project that sets enabled", () => {
    personal({ security: { ...FULL, enabled: false } });
    project({ security: { enabled: true } });
    expect(loadConfig(root).adjudicator.security).toEqual({ ...FULL, enabled: true });
  });
});

describe("EMINIAR_ADJUDICATOR_SECURITY", () => {
  it("=1 turns the heuristic advice on and changes nothing else", () => {
    process.env.EMINIAR_ADJUDICATOR_SECURITY = "1";
    const c = loadConfig(root).adjudicator;
    expect(c).toEqual({
      ...adjudicatorDefaults(),
      security: { ...DEFAULT_SECURITY, enabled: true },
    });
    expect(c.enabled).toBe(false);
    expect(c.security.model).toBe("off");
  });

  it("=1 grants no model opt-in: that stays in the personal config", () => {
    process.env.EMINIAR_ADJUDICATOR_SECURITY = "1";
    project({ security: { model: "provider" } });
    expect(loadConfig(root).adjudicator.security.model).toBe("off");
    personal({ security: { model: "provider" } });
    expect(loadConfig(root).adjudicator.security.model).toBe("provider");
  });

  it("=0 is the kill switch over the project and the personal config, and keeps the other keys", () => {
    process.env.EMINIAR_ADJUDICATOR_SECURITY = "0";
    project({ security: { enabled: true } });
    expect(loadConfig(root).adjudicator.security.enabled).toBe(false);
    personal({ security: FULL });
    expect(loadConfig(root).adjudicator.security).toEqual({ ...FULL, enabled: false });
  });

  it("=0 and =1 each touch only security, and EMINIAR_ADJUDICATOR only the adjudicator", () => {
    personal({ enabled: true, security: { enabled: true } });
    process.env.EMINIAR_ADJUDICATOR_SECURITY = "0";
    let c = loadConfig(root).adjudicator;
    expect([c.enabled, c.security.enabled]).toEqual([true, false]);
    delete process.env.EMINIAR_ADJUDICATOR_SECURITY;
    process.env.EMINIAR_ADJUDICATOR = "0";
    c = loadConfig(root).adjudicator;
    expect([c.enabled, c.security.enabled]).toEqual([false, true]);
  });

  it("anything but 0 or 1 is ignored", () => {
    personal({ security: { enabled: true } });
    for (const v of ["", "yes", "true", "2", " 1", "off"]) {
      process.env.EMINIAR_ADJUDICATOR_SECURITY = v;
      expect(loadConfig(root).adjudicator.security.enabled, JSON.stringify(v)).toBe(true);
    }
  });

  it("=0 without any config is the plain defaults (the fast path)", () => {
    process.env.EMINIAR_ADJUDICATOR_SECURITY = "0";
    expect(loadConfig(root).adjudicator).toStrictEqual(adjudicatorDefaults());
  });
});

describe("adjudicatorWanted", () => {
  const cfg = (
    enabled: boolean,
    security: { enabled?: boolean; agent?: boolean; plan?: boolean; prompt?: boolean } = {},
  ) => ({
    enabled,
    security: {
      enabled: security.enabled ?? false,
      surfaces: {
        agent: security.agent ?? true,
        plan: security.plan ?? true,
        prompt: security.prompt ?? true,
      },
    },
  });

  it("both switches off: nothing is wanted, at any point", () => {
    const off = loadConfig(root).adjudicator;
    expect(adjudicatorWanted(off, "prompt")).toBe(false);
    expect(adjudicatorWanted(off, "plan")).toBe(false);
    for (const tool of ["Agent", "Task", "Bash", "Read", "mcp__x__y", ""])
      expect(adjudicatorWanted(off, "preTool", tool)).toBe(false);
    // surfaces on, security off: still nothing
    expect(adjudicatorWanted(cfg(false, { enabled: false }), "preTool", "Agent")).toBe(false);
  });

  it("the routing adjudicator on wants every point", () => {
    expect(adjudicatorWanted(cfg(true), "prompt")).toBe(true);
    expect(adjudicatorWanted(cfg(true), "plan")).toBe(true);
    expect(adjudicatorWanted(cfg(true), "preTool", "Bash")).toBe(true);
    expect(adjudicatorWanted(cfg(true, { enabled: true, agent: false }), "preTool", "Bash")).toBe(
      true,
    );
  });

  it("security alone wants a PreToolUse only for a subagent start, behind surfaces.agent", () => {
    const on = cfg(false, { enabled: true });
    expect(adjudicatorWanted(on, "preTool", "Agent")).toBe(true);
    expect(adjudicatorWanted(on, "preTool", "Task")).toBe(true);
    for (const tool of ["Bash", "Read", "WebFetch", "agent", "mcp__srv__Agent", "AgentX"])
      expect(adjudicatorWanted(on, "preTool", tool), tool).toBe(false);
    expect(adjudicatorWanted(cfg(false, { enabled: true, agent: false }), "preTool", "Agent")).toBe(
      false,
    );
  });

  it("security alone wants the prompt and the plan behind their own surface", () => {
    expect(adjudicatorWanted(cfg(false, { enabled: true }), "prompt")).toBe(true);
    expect(adjudicatorWanted(cfg(false, { enabled: true }), "plan")).toBe(true);
    expect(adjudicatorWanted(cfg(false, { enabled: true, prompt: false }), "prompt")).toBe(false);
    expect(adjudicatorWanted(cfg(false, { enabled: true, plan: false }), "plan")).toBe(false);
    // each surface is independent
    expect(adjudicatorWanted(cfg(false, { enabled: true, prompt: false }), "plan")).toBe(true);
    expect(adjudicatorWanted(cfg(false, { enabled: true, agent: false }), "prompt")).toBe(true);
  });

  it("takes the loaded config's section as it is", () => {
    personal({ security: { enabled: true, surfaces: { prompt: false } } });
    const a = loadConfig(root).adjudicator;
    expect(adjudicatorWanted(a, "preTool", "Agent")).toBe(true);
    expect(adjudicatorWanted(a, "prompt")).toBe(false);
    expect(adjudicatorWanted(a, "plan")).toBe(true);
  });
});

describe("the generated JSON schema", () => {
  it("lists adjudicator.security with its defaults", () => {
    const schema = JSON.parse(
      readFileSync(join(__dirname, "../../eminiar.config.schema.json"), "utf8"),
      // biome-ignore lint/suspicious/noExplicitAny: walking untyped JSON
    ) as any;
    const s = schema.properties?.adjudicator?.properties?.security?.properties;
    expect(s, "run npm run build to regenerate eminiar.config.schema.json").toBeDefined();
    expect(s.enabled).toMatchObject({ type: "boolean", default: false });
    expect(s.model).toMatchObject({ default: "off", enum: [...SECURITY_MODEL_SETTINGS] });
    expect(s.minLevel).toMatchObject({ default: "high", enum: [...MIN_LEVELS] });
    expect(s.notifyUser).toMatchObject({ default: "critical", enum: [...NOTIFY_LEVELS] });
    expect(s.modelFloor).toMatchObject({ default: "sonnet", enum: [...TIERS] });
    expect(s.taintLookbackMin).toMatchObject({ default: 240, minimum: 0, maximum: 1440 });
    expect(s.store).toMatchObject({ type: "boolean", default: true });
    expect(s.trustedMcpServers).toMatchObject({ type: "array", maxItems: 64, default: [] });
    expect(s.secretPaths).toMatchObject({ type: "array", maxItems: 64, default: [] });
    expect(Object.keys(s.surfaces.properties)).toEqual(["agent", "plan", "prompt"]);
  });
});

describe("security/types.ts (the web-safe leaf)", () => {
  it("imports and re-exports nothing but the pure ../types.js (the hooks must not load it while off)", () => {
    const text = readFileSync(join(__dirname, "../../src/adjudicator/security/types.ts"), "utf8");
    const sources = [...text.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(src).toBe("../types.js");
    for (const m of text.matchAll(/^import\s[\s\S]*?;/gm)) expect(m[0]).toMatch(/^import type /);
  });

  it("src/config.ts imports no security module: the enums it reads live in adjudicator/types.ts", () => {
    const text = readFileSync(join(__dirname, "../../src/config.ts"), "utf8");
    expect(text).not.toMatch(/from\s+"\.\/adjudicator\/security\//);
    for (const name of ["MIN_LEVELS", "NOTIFY_LEVELS", "SECURITY_MODEL_SETTINGS"])
      expect(text).toContain(name);
    // security/types.ts re-exports the very same arrays
    expect(MIN_LEVELS).toBe(ADJUDICATOR_MIN_LEVELS);
    expect(NOTIFY_LEVELS).toBe(ADJUDICATOR_NOTIFY_LEVELS);
    expect(SECURITY_MODEL_SETTINGS).toBe(ADJUDICATOR_MODEL_SETTINGS);
  });

  it("names every capability once, with a provider-safe tag", () => {
    expect([...CAPS]).toEqual(["U", "S", "E", "X", "W", "D", "P", "T"]);
    expect(Object.keys(CAP_TAG)).toEqual([...CAPS]);
    const tags = Object.values(CAP_TAG);
    expect(new Set(tags).size).toBe(tags.length);
    for (const t of tags) expect(t).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it("orders the levels and keeps the config enums inside them", () => {
    expect([...LEVELS]).toEqual(["low", "medium", "high", "critical"]);
    expect([...MIN_LEVELS]).toEqual(["medium", "high", "critical"]);
    for (const l of MIN_LEVELS) expect(LEVELS).toContain(l);
    for (const l of NOTIFY_LEVELS)
      expect(l === "off" || (LEVELS as readonly string[]).includes(l)).toBe(true);
    expect([...SECURITY_ACTIONS]).toEqual(["allow", "advise", "warn"]);
    expect([...AUTONOMIES]).toEqual(["manual", "default", "autonomous"]);
    expect([...SECURITY_MODEL_SETTINGS]).toEqual(["off", "provider"]);
  });

  it("uses the adjudicator's surface names", () => {
    for (const s of SECURITY_SURFACES) expect(SURFACES).toContain(s);
  });

  it("lists unique ids for rules, floors, threats, remedies, cues and grants", () => {
    for (const list of [
      RULE_IDS,
      FLOOR_IDS,
      THREATS,
      REMEDY_ACTION_IDS,
      CUE_IDS,
      INTENT_CUE_IDS,
      GRANT_KINDS,
    ])
      expect(new Set(list).size).toBe(list.length);
    expect([...RULE_IDS]).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
    expect([...FLOOR_IDS]).toEqual([
      "H-R1",
      "H-R2",
      "H-R3",
      "H-R6",
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      "C6",
    ]);
    expect(THREATS).toHaveLength(6);
    expect(SECURITY_VERSION).toBe("1");
  });
});
