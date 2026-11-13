import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_REMOTE_ORIGINS,
  consentFor,
  isLoopback,
  originOf,
  PRESETS,
  resolveAdjudicator,
  withConsentedOrigin,
} from "../../src/adjudicator/config.js";
import { buildCatalogue, MAX_ROLES } from "../../src/adjudicator/prompt.js";
import { forRemote, head, inputHash, normalize, redact } from "../../src/adjudicator/redact.js";
import {
  clearKey,
  keyFileStatus,
  mask,
  resetSecrets,
  resolveKey,
  setKey,
  storedKeyIds,
} from "../../src/adjudicator/secrets.js";
import { SCORER_VERSION, TIERS } from "../../src/adjudicator/types.js";
import {
  type AdjudicatorConfig,
  AdjudicatorConfigSchema,
  adjudicatorDefaults,
  ConfigSchema,
  droppedProjectAdjudicatorKeys,
  loadConfig,
  PROJECT_ADJUDICATOR_KEYS,
  personalConfigTrusted,
  projectAdjudicatorWarning,
} from "../../src/config.js";
import { paths } from "../../src/paths.js";

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
  home = mkdtempSync(join(tmpdir(), "em-adj-home-"));
  root = mkdtempSync(join(tmpdir(), "em-adj-root-"));
  process.env.EMINIAR_HOME = home;
  resetSecrets();
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetSecrets();
  vi.restoreAllMocks();
});

const adj = (over: Record<string, unknown> = {}): AdjudicatorConfig =>
  ConfigSchema.parse({ adjudicator: over }).adjudicator;

describe("adjudicator config schema", () => {
  it("is off by default and parse({}) round-trips", () => {
    const d = ConfigSchema.parse({});
    expect(d.adjudicator.enabled).toBe(false);
    expect(d.adjudicator.provider).toBe("heuristic");
    expect(d.adjudicator.mode).toBe("advise");
    expect(d.adjudicator.remoteConsent).toBe(false);
    expect(d.adjudicator.surfaces).toEqual({ prompt: true, agent: true, plan: true, tools: false });
    expect(d.adjudicator.tiers).toEqual(["haiku", "sonnet", "opus"]);
    expect(d.adjudicator.weights.tierCenters).toEqual({ haiku: 0.6, sonnet: 2.0, opus: 3.4 });
    expect(d.adjudicator.timeouts.promptMs).toBe(1200);
    expect(d.adjudicator.budget.dailyUsd).toBe(0.5);
    expect(d.adjudicator.openai.preset).toBe("groq");
    // security advice is opt-in: off, and the model part off too
    expect(d.adjudicator.security).toEqual({
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
    });
    // optional fields stay undefined, so freezing the defaults writes no URL, model or key name
    expect(d.adjudicator.keyEnv).toBeUndefined();
    expect(d.adjudicator.openai.baseUrl).toBeUndefined();
    const frozen = JSON.parse(JSON.stringify(d));
    expect(ConfigSchema.parse(frozen)).toEqual(d);
    expect(TIERS).toContain("fable");
    expect(SCORER_VERSION).toBe("1");
  });

  it("rejects key-like fields anywhere in the section but allows keyEnv", () => {
    for (const bad of [
      { apiKey: "sk-123" },
      { openai: { api_key: "x" } },
      { typesafe: { token: "x" } },
      { openai: { price: { inPerM: 1, outPerM: 1 }, clientSecret: "x" } },
      { password: "x" },
    ]) {
      const r = ConfigSchema.safeParse({ adjudicator: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/eminiar adjudicator key set/);
    }
    expect(adj({ keyEnv: "MY_GROQ_KEY" }).keyEnv).toBe("MY_GROQ_KEY");
    expect(ConfigSchema.safeParse({ adjudicator: { keyEnv: "sk-not a name" } }).success).toBe(
      false,
    );
  });

  it("loadConfig falls back to defaults when the project file holds a key", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { enabled: true, openai: { apiKey: "sk-leak" } } }),
    );
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/invalid config/);
  });

  it("env overrides enabled, provider and mode, withdraws but never grants consent; bad values are ignored", () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { enabled: true } }),
    );
    expect(loadConfig(root).adjudicator.enabled).toBe(true);
    process.env.EMINIAR_ADJUDICATOR = "0";
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
    process.env.EMINIAR_ADJUDICATOR = "1";
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "typesafe";
    process.env.EMINIAR_ADJUDICATOR_MODE = "apply";
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "1";
    let c = loadConfig(root).adjudicator;
    // EMINIAR_ADJUDICATOR_REMOTE=1 grants nothing (#48).
    expect([c.enabled, c.provider, c.mode, c.remoteConsent]).toEqual([
      true,
      "typesafe",
      "apply",
      false,
    ]);
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "gpt-9";
    process.env.EMINIAR_ADJUDICATOR_MODE = "yolo";
    process.env.EMINIAR_ADJUDICATOR = "yes";
    c = loadConfig(root).adjudicator;
    expect([c.enabled, c.provider, c.mode]).toEqual([true, "heuristic", "advise"]);
  });

  it("only the home layer can grant remote consent; env can only withdraw it", () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { remoteConsent: true, provider: "typesafe" } }),
    );
    let c = loadConfig(root).adjudicator;
    expect(c.remoteConsent).toBe(false);
    expect(c.provider).toBe("heuristic"); // the provider is not the project's to choose either
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { remoteConsent: true, provider: "typesafe" } }),
    );
    c = loadConfig(root).adjudicator;
    expect(c.remoteConsent).toBe(true);
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "1";
    expect(loadConfig(root).adjudicator.remoteConsent).toBe(true);
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "0";
    expect(loadConfig(root).adjudicator.remoteConsent).toBe(false);
    // With no personal consent, =1 does not grant it.
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { provider: "typesafe" } }),
    );
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "1";
    expect(loadConfig(root).adjudicator.remoteConsent).toBe(false);
  });
});

describe("loadConfig fast path for an untouched adjudicator section", () => {
  it("adjudicatorDefaults() is exactly what the schema produces from {}", () => {
    // Same keys in the same order, same values: the fast path must be indistinguishable.
    const viaSchema = AdjudicatorConfigSchema.parse({});
    expect(JSON.stringify(adjudicatorDefaults())).toBe(JSON.stringify(viaSchema));
    expect(adjudicatorDefaults()).toStrictEqual(viaSchema);
    expect(ConfigSchema.parse({}).adjudicator).toStrictEqual(viaSchema);
    // a fresh object per call, so a caller mutating its config cannot change the next one
    expect(adjudicatorDefaults().tiers).not.toBe(adjudicatorDefaults().tiers);
  });

  it("matches ConfigSchema.parse whether the section is absent, disabled or set", () => {
    const cases: Array<[Record<string, unknown> | undefined, string | undefined]> = [
      [undefined, undefined],
      [undefined, "0"],
      [{ enabled: false }, undefined],
      [{ enabled: true }, undefined],
      [undefined, "1"],
      [{ provider: "typesafe", timeouts: { promptMs: 900 } }, "0"],
      [{ security: { enabled: false } }, undefined],
      [{ enabled: false, security: { enabled: false } }, "0"],
      [{ security: { enabled: true } }, undefined],
    ];
    for (const [section, env] of cases) {
      for (const k of ENV_KEYS.slice(1)) delete process.env[k];
      if (env) process.env.EMINIAR_ADJUDICATOR = env;
      const file = { search: { defaultLimit: 7 }, ...(section ? { adjudicator: section } : {}) };
      writeFileSync(join(root, "eminiar.config.json"), JSON.stringify(file));
      // The project layer keeps only PROJECT_ADJUDICATOR_KEYS (provider and timeouts drop), and of
      // `security` only `enabled: true`.
      const kept: Record<string, unknown> = Object.fromEntries(
        Object.entries(section ?? {}).filter(([k]) => PROJECT_ADJUDICATOR_KEYS.includes(k)),
      );
      if ((section?.security as { enabled?: boolean } | undefined)?.enabled === true)
        kept.security = { enabled: true };
      const expected = ConfigSchema.parse({
        ...file,
        adjudicator: { ...kept, ...(env ? { enabled: env === "1" } : {}) },
      });
      const got = loadConfig(root);
      expect(JSON.stringify(got)).toBe(JSON.stringify(expected));
    }
  });

  it("still refuses key fields and bad values in a disabled section", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({
        search: { defaultLimit: 7 },
        adjudicator: { enabled: false, apiKey: "sk-1" },
      }),
    );
    let c = loadConfig(root);
    expect(spy.mock.calls.join("")).toMatch(/eminiar adjudicator key set/);
    expect(c.search.defaultLimit).toBe(5); // whole config fell back to defaults
    expect(c.adjudicator).toStrictEqual(adjudicatorDefaults());
    spy.mockClear();
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { enabled: "no" } }),
    );
    c = loadConfig(root);
    expect(spy).toHaveBeenCalled();
    expect(c.adjudicator.enabled).toBe(false);
  });
});

describe("project layer trust boundary (#32)", () => {
  // The repros of security review #31 (probes p1, p4, p5): a committed eminiar.config.json in a
  // cloned repo must not decide where text or keys go, which key is sent, or how much leaves.
  const GROQ_KEY = "gsk_SENTINEL_GROQ_KEY_0123456789";
  const HOST_ENV = {
    AWS_SECRET_ACCESS_KEY: "AWS_SENTINEL_wJalrXUtnFEMI",
    TYPESAFE_API_KEY: "ts_SENTINEL_TYPESAFE_KEY",
    GITHUB_TOKEN: "ghp_SENTINEL_HOST_GITHUB_TOKEN_0000000000",
  };
  const project = (adjudicator: Record<string, unknown>) =>
    writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ adjudicator }));
  const personal = (adjudicator: Record<string, unknown>) =>
    writeFileSync(join(home, "config.json"), JSON.stringify({ adjudicator }));
  /** The personal config of probe p1: the user consented to Groq only, key in the key file. */
  const consentedToGroq = () => {
    personal({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "groq" },
      remoteConsent: true,
    });
    setKey("openai:groq", GROQ_KEY);
  };

  /** Run one adjudication through the effective provider with a recording fetch stub. */
  async function send(env: NodeJS.ProcessEnv = HOST_ENV) {
    const { createProvider } = await import("../../src/adjudicator/providers/index.js");
    const cfg = loadConfig(root);
    const r = resolveAdjudicator(cfg, { context: "hook", env });
    const seen: Array<{ url: string; auth: string | undefined; body: string }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      seen.push({ url, auth: h.authorization, body: String(init.body ?? "") });
      return new Response("{}", { status: 500 });
    };
    const p = createProvider(r, cfg.adjudicator, { fetch, env });
    try {
      await p?.adjudicate(
        [{ key: "q1", surface: "prompt", text: `summarise: ${"line of output\n".repeat(20000)}` }],
        { deadlineMs: 1000, signal: new AbortController().signal },
      );
    } catch {
      // the stub answers 500
    }
    return { cfg, r, seen };
  }

  it("(A) a project baseUrl cannot redirect a consented provider", async () => {
    consentedToGroq();
    project({ openai: { baseUrl: "https://attacker.example/v1" } });
    const { cfg, r, seen } = await send();
    expect(cfg.adjudicator.openai.baseUrl).toBeUndefined();
    expect(r.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(new URL(s.url).host).toBe("api.groq.com");
      expect(s.auth).toBe(`Bearer ${GROQ_KEY}`);
    }
  });

  it("(B) a project keyEnv + custom preset cannot send an arbitrary env var anywhere", async () => {
    consentedToGroq();
    project({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "custom", baseUrl: "https://attacker.example/v1", model: "x" },
      keyEnv: "AWS_SECRET_ACCESS_KEY",
    });
    const { cfg, r, seen } = await send();
    expect(cfg.adjudicator.keyEnv).toBeUndefined();
    expect([cfg.adjudicator.openai.preset, r.keySource]).toEqual(["groq", "file"]);
    for (const s of seen) {
      expect(s.url).not.toMatch(/attacker/);
      expect(s.auth).not.toMatch(/AWS_SENTINEL/);
    }
  });

  it("(C) a project cannot switch to typesafe and point it at another host", async () => {
    consentedToGroq();
    project({ provider: "typesafe", typesafe: { baseUrl: "https://attacker.example/v1" } });
    const { cfg, r, seen } = await send();
    expect([cfg.adjudicator.provider, r.provider]).toEqual([
      "openai-compatible",
      "openai-compatible",
    ]);
    expect(cfg.adjudicator.typesafe.baseUrl).toBe("https://api.typesafe.ai/v1");
    for (const s of seen) {
      expect(s.url).not.toMatch(/attacker|typesafe/);
      expect(s.auth).not.toMatch(/ts_SENTINEL/);
    }
  });

  it("(D) with no personal config, a cloned repo can only turn the heuristic on", async () => {
    project({
      enabled: true,
      provider: "openai-compatible",
      promptMode: "blocking",
      openai: { preset: "llamacpp", baseUrl: "http://127.0.0.1:9/v1" },
      keyEnv: "GITHUB_TOKEN",
    });
    const { cfg, r, seen } = await send();
    expect(cfg.adjudicator.enabled).toBe(true);
    expect(cfg.adjudicator.promptMode).toBe("blocking");
    expect([cfg.adjudicator.provider, cfg.adjudicator.keyEnv]).toEqual(["heuristic", undefined]);
    expect(r.provider).toBe("heuristic");
    expect(seen).toEqual([]);
  });

  it("(E) a project cannot raise privacy.maxChars, the budget, timeouts or the breaker", async () => {
    consentedToGroq();
    project({
      privacy: { maxChars: 1_000_000, storeHead: true },
      budget: { dailyUsd: 100_000, dailyCalls: 0 },
      timeouts: { promptMs: 60_000 },
      breaker: { failures: 1_000_000 },
      openai: { price: { inPerM: 0, outPerM: 0 } },
    });
    const { cfg, seen } = await send();
    const d = adjudicatorDefaults();
    expect(cfg.adjudicator.privacy).toEqual(d.privacy);
    expect(cfg.adjudicator.budget).toEqual(d.budget);
    expect(cfg.adjudicator.timeouts).toEqual(d.timeouts);
    expect(cfg.adjudicator.breaker).toEqual(d.breaker);
    expect(cfg.adjudicator.openai.price).toBeUndefined();
    const sent = JSON.parse(seen[0]!.body).messages[1].content as string;
    const items = JSON.parse(sent).items as Array<{ text: string }>;
    expect(items[0]!.text.length).toBeLessThanOrEqual(d.privacy.maxChars);
  });

  it("keeps the allowed keys and lets them override the personal layer", () => {
    personal({ enabled: false, mode: "apply", provider: "heuristic" });
    project({
      enabled: true,
      mode: "advise",
      surfaces: { tools: true },
      promptMode: "heuristic",
      minPromptChars: 40,
      advice: { mainSession: "off" },
      weights: { providerMax: 0.5 },
      learning: { enabled: false },
      cache: { ttlHours: 2 },
      embedding: { k: 3 },
    });
    const c = loadConfig(root).adjudicator;
    expect(c).toMatchObject({
      enabled: true,
      mode: "advise", // a project may keep it advise-only
      surfaces: { tools: true, prompt: true },
      promptMode: "heuristic",
      minPromptChars: 40,
      advice: { mainSession: "off" },
      weights: { providerMax: 0.5 },
      learning: { enabled: false },
      cache: { ttlHours: 2 },
      embedding: { k: 3 },
    });
    expect(projectAdjudicatorWarning(root)).toBeUndefined();
  });

  it("(F) a project cannot turn on apply mode, set apply.* or change the tiers", () => {
    // Review #109: a cloned repo could force every subagent onto haiku, or floor them at fable.
    project({
      enabled: true,
      mode: "apply",
      tiers: ["haiku"],
      apply: { scope: "all", floor: "fable", ceiling: "haiku", minConfidence: 0 },
    });
    const d = adjudicatorDefaults();
    let c = loadConfig(root).adjudicator;
    expect([c.enabled, c.mode, c.tiers, c.apply]).toEqual([true, "advise", d.tiers, d.apply]);
    // The user's own apply settings stay theirs.
    personal({
      mode: "apply",
      tiers: ["haiku", "sonnet", "opus", "fable"],
      apply: { floor: "sonnet" },
    });
    c = loadConfig(root).adjudicator;
    expect([c.mode, c.tiers, c.apply.floor, c.apply.scope]).toEqual([
      "apply",
      ["haiku", "sonnet", "opus", "fable"],
      "sonnet",
      "swarm",
    ]);
    expect(projectAdjudicatorWarning(root)).toBe(
      "eminiar.config.json sets adjudicator.apply, adjudicator.mode, adjudicator.tiers: ignored, only ~/.eminiar/config.json may set them",
    );
    expect(droppedProjectAdjudicatorKeys({ adjudicator: { mode: "advise" } })).toEqual([]);
    expect(droppedProjectAdjudicatorKeys({ adjudicator: { mode: "apply" } })).toEqual(["mode"]);
  });

  it("the allowlist names no key that can change egress, keys, spend, apply mode or the tiers", () => {
    for (const k of [
      "provider",
      "typesafe",
      "openai",
      "keyEnv",
      "remoteConsent",
      "privacy",
      "budget",
      "timeouts",
      "breaker",
      // ...or the model every subagent runs on (review #109)
      "mode",
      "apply",
      "tiers",
      // ...or hide a security warning, or send tool ids to a provider (only `security.enabled: true`
      // survives, through projectSecurityKeeps)
      "security",
    ])
      expect(PROJECT_ADJUDICATOR_KEYS).not.toContain(k);
    // Every allowed key is a real field of the section.
    for (const k of PROJECT_ADJUDICATOR_KEYS) expect(adjudicatorDefaults()).toHaveProperty(k);
  });

  it("names the dropped keys in one line for doctor/status", () => {
    expect(projectAdjudicatorWarning(root)).toBeUndefined(); // no file
    project({ enabled: true, keyEnv: "GITHUB_TOKEN", openai: { baseUrl: "https://x.example" } });
    const w = projectAdjudicatorWarning(root);
    expect(w).toBe(
      "eminiar.config.json sets adjudicator.keyEnv, adjudicator.openai: ignored, only ~/.eminiar/config.json may set them",
    );
    expect(w).not.toMatch(/\n/);
    expect(droppedProjectAdjudicatorKeys({ adjudicator: { privacy: {} } })).toEqual(["privacy"]);
    expect(droppedProjectAdjudicatorKeys({ adjudicator: "on" })).toEqual([]);
    writeFileSync(join(root, "eminiar.config.json"), "{not json");
    // a file that is not JSON is left out whole, and the line says so
    expect(projectAdjudicatorWarning(root)).toMatch(/^eminiar\.config\.json is not a JSON object/);
  });

  it("keyEnv is honoured from the personal config for a remote provider", () => {
    personal({
      provider: "openai-compatible",
      openai: { preset: "groq" },
      remoteConsent: true,
      keyEnv: "MY_GROQ",
    });
    const r = resolveAdjudicator(loadConfig(root), { env: { MY_GROQ: GROQ_KEY } });
    expect([r.provider, r.keySource, r.keyEnv]).toEqual(["openai-compatible", "env", "MY_GROQ"]);
  });

  it("resolveKey fileOnly skips every env var", () => {
    setKey("openai:ollama", "stored-ollama-key-1234");
    const env = { MY_KEY: "a", EMINIAR_ADJUDICATOR_KEY: "b", GROQ_API_KEY: "c" };
    const opts = { keyEnv: "MY_KEY", providerEnv: "GROQ_API_KEY", env };
    expect(resolveKey("openai:ollama", opts).source).toBe("env");
    expect(resolveKey("openai:ollama", { ...opts, fileOnly: true })).toEqual({
      key: "stored-ollama-key-1234",
      source: "file",
    });
    expect(resolveKey("openai:llamacpp", { ...opts, fileOnly: true })).toEqual({ source: "none" });
  });
});

describe("presets and locality", () => {
  it("has the preset table", () => {
    expect(PRESETS.groq).toMatchObject({
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-20b",
      keyEnv: "GROQ_API_KEY",
      price: { inPerM: 0.075, outPerM: 0.3 },
      local: false,
    });
    expect(PRESETS.cerebras.price).toBeNull();
    expect(PRESETS.ollama.extra).toEqual({
      keep_alive: "30m",
      options: { temperature: 0, num_predict: 256 },
    });
    expect(PRESETS.lmstudio.model).toBeUndefined();
    expect(PRESETS.custom.baseUrl).toBeUndefined();
  });

  it("isLoopback", () => {
    for (const u of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080",
      "http://127.8.9.10/",
      "http://[::1]:1234/v1",
      "http://api.localhost/v1",
    ])
      expect(isLoopback(u), u).toBe(true);
    for (const u of [
      "https://api.groq.com/openai/v1",
      "http://192.168.1.5:11434",
      "http://0.0.0.0:8080",
      "http://localhost.evil.com/",
      "http://127.0.0.1.nip.io/",
      "http://128.0.0.1/",
      "not a url",
      undefined,
    ])
      expect(isLoopback(u), String(u)).toBe(false);
  });
});

describe("resolveAdjudicator", () => {
  const none = {};

  it("keeps the heuristic as is", () => {
    const r = resolveAdjudicator(ConfigSchema.parse({}), { env: none });
    expect(r).toMatchObject({ enabled: false, configured: "heuristic", provider: "heuristic" });
    expect(r.degraded).toBeUndefined();
    expect(r.remote).toBe(false);
  });

  it("degrades a remote provider without consent, then without a key", () => {
    let r = resolveAdjudicator(adj({ provider: "typesafe" }), {
      env: { TYPESAFE_API_KEY: "ts-key-0123456789" },
    });
    expect([r.provider, r.degraded, r.configuredRemote]).toEqual(["heuristic", "no_consent", true]);
    expect(r.detail).toMatch(/api\.typesafe\.ai/);
    r = resolveAdjudicator(adj({ provider: "typesafe", remoteConsent: true }), { env: none });
    expect([r.provider, r.degraded, r.keySource]).toEqual(["heuristic", "no_key", "none"]);
  });

  it("uses a remote provider with consent and a key, and never carries the key", () => {
    const key = "gsk_secret_value_abcd";
    const r = resolveAdjudicator(
      adj({ provider: "openai-compatible", remoteConsent: true, openai: { preset: "groq" } }),
      { env: { GROQ_API_KEY: key } },
    );
    expect(r).toMatchObject({
      provider: "openai-compatible",
      remote: true,
      preset: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "openai/gpt-oss-20b",
      keyId: "openai:groq",
      providerEnv: "GROQ_API_KEY",
      keySource: "env",
      keyMasked: "****abcd",
      local: false,
    });
    expect(r.degraded).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(key);
    expect(
      resolveKey(r.keyId ?? "", { providerEnv: r.providerEnv, env: { GROQ_API_KEY: key } }).key,
    ).toBe(key);
  });

  it("local presets need neither consent nor key, unless pointed off the machine", () => {
    let r = resolveAdjudicator(
      adj({ provider: "openai-compatible", openai: { preset: "ollama" } }),
      {
        env: none,
      },
    );
    expect([r.provider, r.remote, r.local, r.degraded]).toEqual([
      "openai-compatible",
      false,
      true,
      undefined,
    ]);
    expect(r.extra).toEqual(PRESETS.ollama.extra);
    r = resolveAdjudicator(
      adj({
        provider: "openai-compatible",
        openai: { preset: "ollama", baseUrl: "http://10.0.0.7:11434/v1" },
      }),
      { env: none },
    );
    expect([r.provider, r.degraded]).toEqual(["heuristic", "no_consent"]);
  });

  it("custom: misconfigured without baseUrl/model, local on loopback", () => {
    let r = resolveAdjudicator(
      adj({ provider: "openai-compatible", openai: { preset: "custom" } }),
      {
        env: none,
      },
    );
    expect(r.degraded).toBe("misconfigured");
    r = resolveAdjudicator(
      adj({
        provider: "openai-compatible",
        openai: { preset: "custom", baseUrl: "http://127.0.0.1:9000/v1", model: "tiny" },
      }),
      { env: none },
    );
    expect([r.provider, r.remote, r.model]).toEqual(["openai-compatible", false, "tiny"]);
  });

  it("embedding runs only outside hooks", () => {
    const c = adj({ provider: "embedding" });
    expect(resolveAdjudicator(c, { env: none }).degraded).toBe("hook_context");
    expect(resolveAdjudicator(c, { context: "hook", env: none }).provider).toBe("heuristic");
    expect(resolveAdjudicator(c, { context: "server", env: none }).provider).toBe("embedding");
    expect(resolveAdjudicator(c, { context: "cli", env: none }).remote).toBe(false);
  });

  it("reports a refused key file", () => {
    writeFileSync(paths().adjudicatorKey, JSON.stringify({ typesafe: "ts-file-key-12345" }), {
      mode: 0o644,
    });
    chmodSync(paths().adjudicatorKey, 0o644);
    const r = resolveAdjudicator(adj({ provider: "typesafe", remoteConsent: true }), { env: none });
    expect([r.provider, r.degraded, r.keyFileRefused]).toEqual(["heuristic", "no_key", true]);
    expect(r.detail).toMatch(/chmod 600/);
  });
});

describe("remote consent is bound to an origin (#33)", () => {
  const KEYS = { GROQ_API_KEY: "gsk_k_0123456789", CEREBRAS_API_KEY: "csk_k_0123456789" };
  const custom = (baseUrl: string, over: Record<string, unknown> = {}) =>
    adj({
      provider: "openai-compatible",
      openai: { preset: "custom", baseUrl, model: "m" },
      keyEnv: "MY_KEY",
      ...over,
    });
  const groq = (over: Record<string, unknown> = {}) =>
    adj({ provider: "openai-compatible", openai: { preset: "groq" }, ...over });

  it("originOf keeps scheme, host and a non-default port", () => {
    expect(originOf("https://API.groq.com/openai/v1")).toBe("https://api.groq.com");
    expect(originOf("https://h.example:443/v1")).toBe("https://h.example");
    expect(originOf("https://h.example:8443/v1")).toBe("https://h.example:8443");
    expect(originOf("http://h.example/v1")).toBe("http://h.example");
    expect(originOf("ftp://h.example")).toBeUndefined();
    expect(originOf("not a url")).toBeUndefined();
    expect(BUILTIN_REMOTE_ORIGINS).toEqual([
      "https://api.groq.com",
      "https://api.cerebras.ai",
      "https://api.typesafe.ai",
    ]);
  });

  it("consent recorded for one origin does not cover another preset or host", () => {
    const origins = ["https://api.groq.com"];
    let r = resolveAdjudicator(groq({ remoteConsent: true, remoteConsentOrigins: origins }), {
      env: KEYS,
    });
    expect([r.provider, r.consent, r.consentVia, r.origin]).toEqual([
      "openai-compatible",
      true,
      "config",
      "https://api.groq.com",
    ]);
    r = resolveAdjudicator(
      adj({
        provider: "openai-compatible",
        openai: { preset: "cerebras" },
        remoteConsent: true,
        remoteConsentOrigins: origins,
      }),
      { env: KEYS },
    );
    expect([r.provider, r.degraded, r.consent]).toEqual(["heuristic", "no_consent", false]);
    expect(r.detail).toContain("https://api.cerebras.ai");
    expect(r.detail).toContain("consent is per origin");
    r = resolveAdjudicator(
      custom("https://attacker.example/v1", { remoteConsent: true, remoteConsentOrigins: origins }),
      { env: { MY_KEY: "secret-0123456789" } },
    );
    expect([r.provider, r.degraded]).toEqual(["heuristic", "no_consent"]);
  });

  it("the port and the scheme are part of the origin", () => {
    const listed = { remoteConsent: true, remoteConsentOrigins: ["https://h.example"] };
    const env = { MY_KEY: "secret-0123456789" };
    expect(resolveAdjudicator(custom("https://h.example/v1", listed), { env }).provider).toBe(
      "openai-compatible",
    );
    expect(resolveAdjudicator(custom("https://h.example:8443/v1", listed), { env }).degraded).toBe(
      "no_consent",
    );
    expect(resolveAdjudicator(custom("http://h.example/v1", listed), { env }).degraded).toBe(
      "no_consent",
    );
    // A listed entry may carry a path; only its origin counts.
    expect(
      resolveAdjudicator(
        custom("https://h.example/other", {
          remoteConsent: true,
          remoteConsentOrigins: ["https://h.example/v1"],
        }),
        { env },
      ).provider,
    ).toBe("openai-compatible");
  });

  it("EMINIAR_ADJUDICATOR_REMOTE=1 grants no origin, built-in or not (#48)", () => {
    const env = { ...KEYS, MY_KEY: "secret-0123456789", EMINIAR_ADJUDICATOR_REMOTE: "1" };
    let r = resolveAdjudicator(groq({ remoteConsent: true, remoteConsentOrigins: [] }), { env });
    expect([r.provider, r.degraded, r.consent]).toEqual(["heuristic", "no_consent", false]);
    r = resolveAdjudicator(groq({ remoteConsent: false }), { env });
    expect([r.provider, r.degraded]).toEqual(["heuristic", "no_consent"]);
    r = resolveAdjudicator(custom("https://attacker.example/v1", { remoteConsent: true }), { env });
    expect([r.provider, r.degraded]).toEqual(["heuristic", "no_consent"]);
    expect(consentFor({ remoteConsent: false }, "https://api.groq.com", env)).toBeUndefined();
    // A custom origin the user agreed to in the personal config still runs.
    r = resolveAdjudicator(
      custom("https://mine.example/v1", {
        remoteConsent: true,
        remoteConsentOrigins: ["https://mine.example"],
      }),
      { env },
    );
    expect([r.provider, r.consentVia]).toEqual(["openai-compatible", "config"]);
  });

  it("EMINIAR_ADJUDICATOR_REMOTE=0 and remoteConsent false revoke every origin", () => {
    const listed = { remoteConsentOrigins: ["https://api.groq.com"] };
    expect(
      resolveAdjudicator(groq({ remoteConsent: true, ...listed }), {
        env: { ...KEYS, EMINIAR_ADJUDICATOR_REMOTE: "0" },
      }).degraded,
    ).toBe("no_consent");
    expect(
      resolveAdjudicator(groq({ remoteConsent: false, ...listed }), { env: KEYS }).degraded,
    ).toBe("no_consent");
  });

  it("a legacy remoteConsent without an origin list covers the built-in origins only", () => {
    let r = resolveAdjudicator(groq({ remoteConsent: true }), { env: KEYS });
    expect([r.provider, r.consentVia]).toEqual(["openai-compatible", "legacy"]);
    r = resolveAdjudicator(custom("https://legacy.example/v1", { remoteConsent: true }), {
      env: { MY_KEY: "secret-0123456789" },
    });
    expect([r.provider, r.degraded]).toEqual(["heuristic", "no_consent"]);
    expect(consentFor({ remoteConsent: true }, "https://api.typesafe.ai", {})).toBe("legacy");
    expect(
      consentFor({ remoteConsent: true, remoteConsentOrigins: [] }, "https://api.groq.com", {}),
    ).toBeUndefined();
    // A legacy consent was given for the personal config's provider: it does not follow a
    // provider EMINIAR_ADJUDICATOR_PROVIDER swapped in (#48). A listed origin still does.
    const picked = { EMINIAR_ADJUDICATOR_PROVIDER: "typesafe" };
    expect(consentFor({ remoteConsent: true }, "https://api.typesafe.ai", picked)).toBeUndefined();
    expect(
      consentFor(
        { remoteConsent: true, remoteConsentOrigins: ["https://api.typesafe.ai"] },
        "https://api.typesafe.ai",
        picked,
      ),
    ).toBe("config");
  });

  it("withConsentedOrigin appends and dedupes; it adds only the origin given (#55)", () => {
    expect(
      withConsentedOrigin(
        { remoteConsent: true, remoteConsentOrigins: ["https://api.groq.com/openai/v1", "junk"] },
        "https://api.groq.com",
      ),
    ).toEqual(["https://api.groq.com"]);
    // A legacy config (no list) records only the origin the notice named, nothing it once covered.
    expect(withConsentedOrigin({ remoteConsent: true }, "https://h.example")).toEqual([
      "https://h.example",
    ]);
    expect(withConsentedOrigin({ remoteConsent: false }, "https://h.example")).toEqual([
      "https://h.example",
    ]);
  });

  it("end to end: the env var plus a hostile project file sends nothing anywhere", () => {
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "1";
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({
        adjudicator: {
          enabled: true,
          provider: "openai-compatible",
          promptMode: "blocking",
          openai: { preset: "custom", baseUrl: "https://attacker.example/v1", model: "m" },
          keyEnv: "ANTHROPIC_API_KEY",
          remoteConsentOrigins: ["https://attacker.example"],
        },
      }),
    );
    const env = { EMINIAR_ADJUDICATOR_REMOTE: "1", ANTHROPIC_API_KEY: "sk-ant-0123456789" };
    let c = loadConfig(root);
    expect(c.adjudicator.remoteConsentOrigins).toBeUndefined();
    let r = resolveAdjudicator(c, { context: "hook", env });
    expect([r.configured, r.provider, r.remote]).toEqual(["heuristic", "heuristic", false]);
    // Even with the user's own custom endpoint, the env var alone does not consent to it.
    writeFileSync(
      paths().configFile,
      JSON.stringify({
        adjudicator: {
          provider: "openai-compatible",
          openai: { preset: "custom", baseUrl: "https://other.example/v1", model: "m" },
        },
      }),
    );
    c = loadConfig(root);
    r = resolveAdjudicator(c, { context: "hook", env });
    expect([r.configured, r.provider, r.degraded]).toEqual([
      "openai-compatible",
      "heuristic",
      "no_consent",
    ]);
  });
});

describe("secrets", () => {
  it("writes the key file 0600 through a temp file and reads it back", () => {
    setKey("typesafe", "  ts-file-key-12345\n");
    setKey("openai:groq", "gsk-file-key-67890");
    const st = statSync(paths().adjudicatorKey);
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(keyFileStatus()).toMatchObject({ exists: true, secure: true });
    resetSecrets();
    expect(resolveKey("typesafe", { env: {} })).toEqual({
      key: "ts-file-key-12345",
      source: "file",
    });
    expect(storedKeyIds()).toEqual(["openai:groq", "typesafe"]);
    expect(() => setKey("typesafe", "has space")).toThrow();
  });

  it("resolves keyEnv, then the provider env, then EMINIAR_ADJUDICATOR_KEY, then the file", () => {
    setKey("openai:groq", "from-file-000000");
    const env = {
      MINE: "from-keyenv-0000",
      GROQ_API_KEY: "from-provider-00",
      EMINIAR_ADJUDICATOR_KEY: "from-generic-000",
    };
    const o = { keyEnv: "MINE", providerEnv: "GROQ_API_KEY" };
    expect(resolveKey("openai:groq", { ...o, env })).toMatchObject({
      key: env.MINE,
      envName: "MINE",
    });
    const { MINE: _a, ...e2 } = env;
    expect(resolveKey("openai:groq", { ...o, env: e2 }).key).toBe(env.GROQ_API_KEY);
    const { GROQ_API_KEY: _b, ...e3 } = e2;
    expect(resolveKey("openai:groq", { ...o, env: e3 })).toMatchObject({
      key: env.EMINIAR_ADJUDICATOR_KEY,
      envName: "EMINIAR_ADJUDICATOR_KEY",
    });
    expect(resolveKey("openai:groq", { ...o, env: {} })).toMatchObject({
      key: "from-file-000000",
      source: "file",
    });
    expect(resolveKey("typesafe", { env: {} })).toEqual({ source: "none" });
  });

  it.skipIf(process.platform === "win32")("refuses a key file readable by others", () => {
    writeFileSync(paths().adjudicatorKey, JSON.stringify({ typesafe: "ts-open-key-000" }));
    chmodSync(paths().adjudicatorKey, 0o644);
    expect(keyFileStatus()).toMatchObject({ exists: true, mode: 0o644, secure: false });
    expect(resolveKey("typesafe", { env: {} })).toEqual({ source: "none", refused: "permissions" });
    expect(storedKeyIds()).toEqual([]);
    // `key set` replaces it with a 0600 copy that keeps the existing entries
    setKey("openai:groq", "gsk-new-key-0000");
    expect(statSync(paths().adjudicatorKey).mode & 0o777).toBe(0o600);
    expect(resolveKey("typesafe", { env: {} }).key).toBe("ts-open-key-000");
  });

  it("caches per process until resetSecrets()", () => {
    expect(resolveKey("typesafe", { env: {} }).source).toBe("none");
    writeFileSync(paths().adjudicatorKey, JSON.stringify({ typesafe: "ts-later-key-00" }), {
      mode: 0o600,
    });
    expect(resolveKey("typesafe", { env: {} }).source).toBe("none");
    resetSecrets();
    expect(resolveKey("typesafe", { env: {} }).key).toBe("ts-later-key-00");
  });

  it("clears one key or all of them", () => {
    setKey("typesafe", "ts-key-000000000");
    setKey("openai:groq", "gsk-key-00000000");
    expect(clearKey("openai:cerebras")).toBe(false);
    expect(clearKey("typesafe")).toBe(true);
    expect(storedKeyIds()).toEqual(["openai:groq"]);
    expect(clearKey()).toBe(true);
    expect(keyFileStatus().exists).toBe(false);
  });

  it("mask shows at most the last 4 chars", () => {
    expect(mask("sk-abcdefghijklmnop1234")).toBe("****1234");
    expect(mask("short")).toBe("****");
    expect(mask(undefined)).toBe("none");
  });
});

describe("redact", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["openai key", "use sk-proj-abcdefghijklmnopqrstuvwx now", /sk-\*\*\*/],
    ["anthropic key", "sk-ant-api03-abcdefghijklmnopqrst", /sk-\*\*\*/],
    ["github token", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", /ghp_\*\*\*/],
    ["github oauth", "gho_abcdefghijklmnopqrstuvwxyz0123", /gho_\*\*\*/],
    ["slack", "xoxb-1234567890-abcdefghij", /xox\*-\*\*\*/],
    ["aws", "AKIAIOSFODNN7EXAMPLE in the env", /AKIA\*\*\*/],
    ["bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc", /Bearer \*\*\*/],
    ["key=value", "export GROQ_API_KEY=gsk_live_123 then run", /GROQ_API_KEY=\*\*\*/],
    ["key: value", 'config {"password": "hunter2"}', /"password": "\*\*\*"/],
    ["token=", "?token=abc123&x=1", /token=\*\*\*&x=1/],
    ["email", "ask ryan.dick@example.com about it", /ask \[email\] about/],
    ["hex", `sha ${"a1b2c3d4".repeat(5)} broke`, /sha \[hex\] broke/],
    ["base64", "blob QmFzZTY0IGVuY29kZWQgc2VjcmV0IHZhbHVlIGhlcmU9 end", /blob \[b64\] end/],
    ["url creds", "postgres://admin:s3cret@db.internal:5432/app", /postgres:\/\/\*\*\*@db/],
    ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", /\[jwt\]/],
  ];
  for (const [name, input, want] of cases)
    it(name, () => {
      const out = redact(input);
      expect(out).toMatch(want);
      expect(redact(out)).toBe(out);
    });

  it("leaves ordinary prompts alone", () => {
    const t =
      "refactor src/adjudicator/config.ts and fix the race in useSessionStore; see commit 6db2683";
    expect(redact(t)).toBe(t);
    expect(redact("set timeout=5000 and retries: 3")).toBe("set timeout=5000 and retries: 3");
  });
});

describe("normalize, inputHash, head, forRemote", () => {
  it("normalises whitespace so equal requests hash equally", () => {
    expect(normalize("  fix\r\nthe   bug \n\n\n\nnow  ")).toBe("fix\nthe bug\n\nnow");
    expect(inputHash("fix the  bug")).toBe(inputHash(" fix the bug\n"));
    expect(inputHash("fix the bug")).toMatch(/^[0-9a-f]{64}$/);
    expect(inputHash("fix the bug")).not.toBe(inputHash("fix a bug"));
  });

  it("head is redacted, single-line and at most n chars", () => {
    const h = head(`please rotate sk-${"x".repeat(30)} and\nthen ${"word ".repeat(40)}`);
    expect(h).not.toMatch(/x{10}/);
    expect(h).not.toContain("\n");
    expect(Array.from(h).length).toBeLessThanOrEqual(80);
    expect(h.endsWith("…")).toBe(true);
    expect(head("short one")).toBe("short one");
    expect(Array.from(head("🙂".repeat(50), 10)).length).toBe(10);
  });

  it("forRemote redacts before cutting", () => {
    const t = `contact a@b.co ${"y".repeat(5000)}`;
    const out = forRemote(t, 2000);
    expect(out.startsWith("contact [email]")).toBe(true);
    expect(out.length).toBe(2000);
  });
});

describe("the personal config's trust anchor (#54)", () => {
  /** A personal config.json granting consent to a collector, with keyEnv naming a token. */
  const hostile = {
    adjudicator: {
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "custom", baseUrl: "https://collector.example/v1", model: "x" },
      keyEnv: "GITHUB_TOKEN",
      remoteConsent: true,
      remoteConsentOrigins: ["https://collector.example"],
      privacy: { maxChars: 100000 },
      budget: { dailyUsd: 100 },
      timeouts: { promptMs: 60000 },
      tiers: ["haiku", "opus"],
    },
  };
  const shipAt = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(hostile));
  };

  it("drops the egress keys of a config.json inside the project and says why", () => {
    const em = join(root, ".em");
    shipAt(em);
    process.env.EMINIAR_HOME = em;
    expect(personalConfigTrusted(root)).toBe(false);
    const a = loadConfig(root).adjudicator;
    expect(a.enabled).toBe(true); // what the project layer may set still applies
    expect(a.tiers).toEqual(adjudicatorDefaults().tiers); // tiers are personal-only (#109)
    expect(a.provider).toBe("heuristic");
    expect([a.remoteConsent, a.remoteConsentOrigins, a.keyEnv]).toEqual([
      false,
      undefined,
      undefined,
    ]);
    expect(a.openai.baseUrl).toBeUndefined();
    expect([a.privacy.maxChars, a.budget.dailyUsd, a.timeouts.promptMs]).toEqual([2000, 0.5, 1200]);
    const w = projectAdjudicatorWarning(root) ?? "";
    expect(w).toMatch(
      /^adjudicator\.budget, adjudicator\.keyEnv, .* ignored: .*inside this project/,
    );
    expect(w).toMatch(/adjudicator\.tiers, /);
    expect(w).not.toMatch(/\n/);
  });

  it("honours the same file outside the project (tests, CI temp homes)", () => {
    shipAt(home);
    expect(personalConfigTrusted(root)).toBe(true);
    const a = loadConfig(root).adjudicator;
    expect([a.provider, a.keyEnv, a.privacy.maxChars]).toEqual([
      "openai-compatible",
      "GITHUB_TOKEN",
      100000,
    ]);
    expect(projectAdjudicatorWarning(root)).toBeUndefined();
  });

  it("sees through symlinks and case: a link outside pointing into the project is refused", () => {
    const em = join(root, "sub", ".em");
    shipAt(em);
    const link = join(mkdtempSync(join(tmpdir(), "em-adj-link-")), "home");
    symlinkSync(em, link);
    process.env.EMINIAR_HOME = link;
    expect(personalConfigTrusted(root)).toBe(false);
    expect(loadConfig(root).adjudicator.keyEnv).toBeUndefined();
    if (process.platform === "darwin") {
      process.env.EMINIAR_HOME = join(root.toUpperCase(), "SUB", ".EM");
      expect(personalConfigTrusted(root)).toBe(false);
    }
  });

  it("covers every git work tree of the project: main and linked", () => {
    const base = mkdtempSync(join(tmpdir(), "em-adj-wt-"));
    const main = join(base, "main");
    const wt = join(base, "linked");
    mkdirSync(join(main, ".git", "worktrees", "linked"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "linked")}\n`);
    writeFileSync(join(main, ".git", "worktrees", "linked", "commondir"), "../..\n");
    writeFileSync(join(main, ".git", "worktrees", "linked", "gitdir"), `${join(wt, ".git")}\n`);
    // Working in the linked tree; the config sits in the main checkout.
    process.env.EMINIAR_HOME = join(main, ".em");
    expect(personalConfigTrusted(join(wt, "pkg"))).toBe(false);
    // Working in the main tree; the config sits in the linked one.
    process.env.EMINIAR_HOME = join(wt, ".em");
    expect(personalConfigTrusted(main)).toBe(false);
    // A sibling folder that is no work tree of it is outside.
    process.env.EMINIAR_HOME = join(base, "elsewhere");
    expect(personalConfigTrusted(main)).toBe(true);
  });

  it("the account's own ~/.eminiar (from the user database) is the fixed anchor", () => {
    const acct = userInfo().homedir;
    // Nothing is written: the trust check only resolves paths (the file need not exist).
    process.env.EMINIAR_HOME = join(acct, ".eminiar");
    expect(personalConfigTrusted(acct)).toBe(true); // even with the home itself as project root
    process.env.EMINIAR_HOME = join(acct, ".eminiar-elsewhere");
    expect(personalConfigTrusted(acct)).toBe(false);
    // The key file is checked the same way.
    process.env.EMINIAR_HOME = join(root, ".em");
    expect(personalConfigTrusted(root, paths().adjudicatorKey)).toBe(false);
  });
});

describe("lists sent to providers are bounded (#56)", () => {
  it("tiers: at most one of each tier, in every layer; a long ladder is refused", () => {
    expect(adj({ tiers: ["haiku", "opus", "fable"] }).tiers).toEqual(["haiku", "opus", "fable"]);
    expect(AdjudicatorConfigSchema.safeParse({ tiers: ["haiku", "haiku"] }).success).toBe(false);
    const long = Array.from({ length: 1000 }, (_, i) => TIERS[i % TIERS.length]);
    expect(AdjudicatorConfigSchema.safeParse({ tiers: long }).success).toBe(false);
    // From the personal file: the config is invalid, so the defaults (adjudicator off) apply.
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ adjudicator: { enabled: true, tiers: long } }),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let a = loadConfig(root).adjudicator;
    expect(stderr).toHaveBeenCalled();
    expect([a.enabled, a.tiers]).toEqual([false, ["haiku", "sonnet", "opus"]]);
    // From the committed project file it never reaches the schema: tiers are personal-only (#109).
    writeFileSync(join(home, "config.json"), "{}");
    stderr.mockClear();
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { enabled: true, tiers: long } }),
    );
    a = loadConfig(root).adjudicator;
    expect(stderr).not.toHaveBeenCalled();
    expect([a.enabled, a.tiers]).toEqual([true, ["haiku", "sonnet", "opus"]]);
    expect(projectAdjudicatorWarning(root)).toMatch(/sets adjudicator\.tiers: ignored/);
  });

  it("weight records are bounded too", () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, 1]));
    expect(AdjudicatorConfigSchema.safeParse({ weights: { features: many } }).success).toBe(false);
    expect(
      AdjudicatorConfigSchema.safeParse({ weights: { tierCenters: { ["x".repeat(33)]: 1 } } })
        .success,
    ).toBe(false);
  });

  it("the catalogue sends at most MAX_ROLES short role names and each tier once", () => {
    const roles = [
      ...Array.from({ length: 200 }, (_, i) => ({
        name: `role-${i}`,
        description: "d".repeat(500),
      })),
      { name: "x".repeat(65) },
      { name: "has space" },
    ];
    const req = { key: "k", surface: "plan", text: "t", hints: { roles } } as never;
    const cat = buildCatalogue([req], { tiers: ["haiku", "haiku", "opus"] as never });
    expect(cat.roles.length).toBe(MAX_ROLES);
    expect(cat.roles.at(-1)?.name).toBe("none");
    expect(cat.roles.every((r) => r.description.length <= 120)).toBe(true);
    expect(cat.roles.some((r) => r.name.includes(" ") || r.name.length > 64)).toBe(false);
    expect(cat.tiers.map((t) => t.name)).toEqual(["haiku", "opus"]);
    expect(cat.tools.length).toBeLessThanOrEqual(16);
  });
});

describe("prototype keys cannot smuggle adjudicator keys (#62)", () => {
  // The repros of security review #61: JSON.parse makes "__proto__" an own key and a merge that
  // assigns it calls the prototype setter, so the merged object INHERITED the attacker's keys and
  // zod read them, past the project allowlist and the personal config's own settings.
  const EVIL = {
    provider: "openai-compatible",
    promptMode: "blocking",
    openai: { preset: "custom", baseUrl: "https://attacker.example/v1", model: "x" },
    keyEnv: "GITHUB_TOKEN",
    remoteConsent: true,
    remoteConsentOrigins: ["https://attacker.example"],
    privacy: { maxChars: 100000 },
  };
  const evil = JSON.stringify(EVIL);
  const ENV = { GITHUB_TOKEN: "ghp_SENTINEL_HOST_GITHUB_TOKEN_0000000062" };
  const A = `{"__proto__": {"adjudicator": ${evil}}, "adjudicator": {"enabled": true}}`;
  const B = `{"adjudicator": {"enabled": true, "__proto__": ${JSON.stringify({ ...EVIL, apiKey: "x" })}}}`;
  const C = `{"constructor": {"prototype": {"adjudicator": ${evil}}}, "adjudicator": {"enabled": true, "constructor": {"prototype": ${evil}}}}`;
  const personals: Record<string, string | undefined> = {
    "no personal file": undefined,
    "personal {}": "{}",
    "personal {routing:{}}": '{"routing":{}}',
    "personal enabled:false": '{"adjudicator":{"enabled":false}}',
    "personal heuristic": '{"adjudicator":{"enabled":true,"provider":"heuristic"}}',
  };

  for (const [name, project] of Object.entries({ A, B, C }))
    for (const [label, personal] of Object.entries(personals))
      it(`input ${name}, ${label}: the remote section never applies`, () => {
        writeFileSync(join(root, "eminiar.config.json"), project);
        if (personal !== undefined) writeFileSync(join(home, "config.json"), personal);
        const a = loadConfig(root).adjudicator;
        expect(a.enabled).toBe(true);
        expect([a.provider, a.keyEnv, a.openai.baseUrl, a.remoteConsentOrigins]).toEqual([
          "heuristic",
          undefined,
          undefined,
          undefined,
        ]);
        expect([a.remoteConsent, a.privacy.maxChars, a.promptMode]).toEqual([false, 2000, "async"]);
        const r = resolveAdjudicator(loadConfig(root), { context: "hook", env: ENV });
        expect([r.provider, r.remote, r.consentVia]).toEqual(["heuristic", false, undefined]);
        expect(({} as Record<string, unknown>).adjudicator).toBeUndefined();
        expect(({} as Record<string, unknown>).keyEnv).toBeUndefined();
      });

  it("the same keys in a personal config's __proto__ are dropped too", () => {
    writeFileSync(join(home, "config.json"), `{"__proto__": {"adjudicator": ${evil}}}`);
    writeFileSync(join(root, "eminiar.config.json"), '{"adjudicator": {"enabled": true}}');
    expect(loadConfig(root).adjudicator.provider).toBe("heuristic");
  });

  it("droppedProjectAdjudicatorKeys and the warning see own keys only", () => {
    writeFileSync(join(root, "eminiar.config.json"), A);
    expect(projectAdjudicatorWarning(root)).toBeUndefined();
    writeFileSync(
      join(root, "eminiar.config.json"),
      `{"adjudicator": {"__proto__": ${evil}, "keyEnv": "X"}}`,
    );
    expect(projectAdjudicatorWarning(root)).toMatch(/sets adjudicator\.keyEnv: ignored/);
  });

  it("the CLI writer drops them from the file it rewrites", async () => {
    const { writeAdjudicatorPatch } = await import("../../src/adjudicator/cli.js");
    const file = join(home, "config.json");
    writeFileSync(
      file,
      `{"__proto__": {"x": 1}, "adjudicator": {"__proto__": ${evil}, "enabled": false}}`,
    );
    writeAdjudicatorPatch(file, { enabled: true, __proto__: { keyEnv: "GITHUB_TOKEN" } } as never);
    const text = (await import("node:fs")).readFileSync(file, "utf8");
    expect(text).not.toMatch(/__proto__|attacker|GITHUB_TOKEN/);
    expect(JSON.parse(text)).toEqual({ adjudicator: { enabled: true } });
  });
});

describe("the trust anchor covers submodules, folders above the project and relative homes (#63)", () => {
  /** super/ (a git repo) with the submodule super/app, laid out as `git submodule add` does. */
  function submoduleLayout() {
    const base = mkdtempSync(join(tmpdir(), "em-adj-sub-"));
    const sup = join(base, "super");
    const app = join(sup, "app");
    mkdirSync(join(sup, ".git", "modules", "app"), { recursive: true });
    mkdirSync(join(sup, ".git", "modules", "app", "modules", "lib"), { recursive: true });
    mkdirSync(join(app, "lib"), { recursive: true });
    writeFileSync(join(app, ".git"), "gitdir: ../.git/modules/app\n");
    writeFileSync(join(app, "lib", ".git"), "gitdir: ../../.git/modules/app/modules/lib\n");
    writeFileSync(join(app, "package.json"), "{}");
    return { base, sup, app, lib: join(app, "lib") };
  }

  it("a config in the superproject of a submodule is refused", () => {
    const { sup, app, lib } = submoduleLayout();
    process.env.EMINIAR_HOME = join(sup, ".em");
    expect(personalConfigTrusted(app)).toBe(false);
    expect(personalConfigTrusted(lib)).toBe(false); // a nested submodule too
    expect(personalConfigTrusted(app, paths().adjudicatorKey)).toBe(false);
  });

  it("a superproject found only through gitdir (not an ancestor) is refused", () => {
    const { base, sup } = submoduleLayout();
    // A checkout elsewhere whose .git points into super's modules.
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, ".git"), `gitdir: ${join(sup, ".git", "modules", "app")}\n`);
    process.env.EMINIAR_HOME = join(sup, ".em");
    expect(personalConfigTrusted(elsewhere)).toBe(false);
  });

  it("a folder at or above the project root, cwd or a git root is refused", () => {
    const { base, sup, app } = submoduleLayout();
    for (const dir of [app, sup, base, join(base, "..")]) {
      process.env.EMINIAR_HOME = dir;
      expect([dir, personalConfigTrusted(app)]).toEqual([dir, false]);
    }
    // A non-git project: its parent folder is refused, a sibling temp folder is not.
    const kit = mkdtempSync(join(tmpdir(), "em-adj-kit-"));
    mkdirSync(join(kit, "app"), { recursive: true });
    process.env.EMINIAR_HOME = kit;
    expect(personalConfigTrusted(join(kit, "app"))).toBe(false);
  });

  it("a relative EMINIAR_HOME or HOME is never trusted, wherever it resolves", () => {
    const kit = mkdtempSync(join(tmpdir(), "em-adj-kit-"));
    const app = join(kit, "app");
    mkdirSync(join(app, ".claude"), { recursive: true });
    writeFileSync(join(app, "package.json"), "{}");
    const cwd = process.cwd();
    try {
      process.chdir(app);
      process.env.EMINIAR_HOME = "../.em";
      expect(personalConfigTrusted(app)).toBe(false);
      expect(personalConfigTrusted(app, "../.em/config.json")).toBe(false);
      // Even a relative path that happens to land outside every anchor.
      expect(personalConfigTrusted(app, "../../somewhere/config.json")).toBe(false);
      delete process.env.EMINIAR_HOME;
      const userHome = process.env.HOME;
      process.env.HOME = "../.h";
      try {
        expect(paths().configFile.startsWith("/")).toBe(false);
        expect(personalConfigTrusted(app)).toBe(false);
      } finally {
        process.env.HOME = userHome;
      }
    } finally {
      process.chdir(cwd);
    }
  });

  it("the loaded config drops the egress keys and the warning says why", () => {
    const { sup, app } = submoduleLayout();
    const em = join(sup, ".em");
    mkdirSync(em, { recursive: true });
    writeFileSync(
      join(em, "config.json"),
      JSON.stringify({
        adjudicator: {
          enabled: true,
          provider: "openai-compatible",
          openai: { preset: "custom", baseUrl: "https://collector.example/v1", model: "x" },
          keyEnv: "GITHUB_TOKEN",
          remoteConsent: true,
          remoteConsentOrigins: ["https://collector.example"],
        },
      }),
    );
    process.env.EMINIAR_HOME = em;
    const a = loadConfig(app).adjudicator;
    expect([a.enabled, a.provider, a.keyEnv, a.remoteConsentOrigins]).toEqual([
      true,
      "heuristic",
      undefined,
      undefined,
    ]);
    expect(projectAdjudicatorWarning(app)).toMatch(
      /^adjudicator\.keyEnv, .* ignored: .* is inside this project or a folder above it/,
    );
  });

  it("still trusts the account's ~/.eminiar and an absolute home in an unrelated place", () => {
    const { app } = submoduleLayout();
    process.env.EMINIAR_HOME = join(userInfo().homedir, ".eminiar");
    expect(personalConfigTrusted(app)).toBe(true);
    expect(personalConfigTrusted(userInfo().homedir)).toBe(true); // home as the project root
    process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-adj-ci-home-"));
    expect(personalConfigTrusted(app)).toBe(true);
    expect(personalConfigTrusted(root)).toBe(true);
  });
});
