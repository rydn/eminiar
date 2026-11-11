import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyFingerprint } from "../../src/adjudicator/breaker.js";
import {
  adjudicatorCommand,
  adjudicatorDoctorChecks,
  adjudicatorLiveChecks,
  CHOICES,
  type CliDeps,
  detectLocal,
  type Io,
  keyIdFor,
  looksLikeKey,
  parseChoice,
  remoteNotice,
  setupAdjudicator,
  writeAdjudicatorPatch,
} from "../../src/adjudicator/cli.js";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import type { AdjudicatorProvider, ProviderResult } from "../../src/adjudicator/types.js";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { runDoctor } from "../../src/doctor.js";
import { frozenDefaults } from "../../src/install/install.js";
import { paths } from "../../src/paths.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { syncAgents } from "../../src/swarm/agents.js";
import { loadSwarmConfig } from "../../src/swarm/config.js";

const SENTINEL = "sk-SENTINEL-adjudicator-key-Zq9X";
const ENV_KEYS = [
  "EMINIAR_HOME",
  "EMINIAR_ADJUDICATOR",
  "EMINIAR_ADJUDICATOR_PROVIDER",
  "EMINIAR_ADJUDICATOR_MODE",
  "EMINIAR_ADJUDICATOR_REMOTE",
];

let home: string;
let root: string;
let db: SqliteAdapter;
let ctx: ProjectContext;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "em-adjcli-home-"));
  root = mkdtempSync(join(tmpdir(), "em-adjcli-root-"));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.EMINIAR_HOME = home;
  resetSecrets();
  const dbPath = join(root, "db.sqlite");
  db = new SqliteAdapter(dbPath, { vectors: false });
  ctx = { root, id: "test", dbPath, config: ConfigSchema.parse({}) };
});
afterEach(() => {
  db.close?.();
  for (const k of ENV_KEYS) delete process.env[k];
  resetSecrets();
});

/** A scripted terminal: `answers` feed ask(), `hidden` feeds askHidden(); everything is recorded. */
function fakeIo(
  o: {
    tty?: boolean;
    answers?: string[];
    hidden?: string[];
    stdin?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const lines: string[] = [];
  const answers = [...(o.answers ?? [])];
  const hidden = [...(o.hidden ?? [])];
  const io: Io = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    isTTY: o.tty ?? false,
    ask: async (q) => {
      const a = answers.shift() ?? "";
      lines.push(`${q}${a}`);
      return a;
    },
    askHidden: async (q) => {
      lines.push(`${q}[hidden]`);
      return hidden.shift() ?? "";
    },
    readStdin: async () => o.stdin ?? "",
    env: o.env ?? {},
    now: () => Date.UTC(2026, 10, 4, 12),
  };
  return { io, lines, text: () => lines.join("\n") };
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON
type Json = any;

const globalRaw = (): Record<string, Json> =>
  existsSync(paths().configFile)
    ? (JSON.parse(readFileSync(paths().configFile, "utf8")) as Record<string, Json>)
    : {};

async function run(args: string[], io: Io, extra: Partial<CliDeps> = {}) {
  return adjudicatorCommand(args, ctx, { io, db, ...extra });
}

describe("choices and config writes", () => {
  it("maps install/enable choices to providers and presets", () => {
    expect(parseChoice("jev")).toEqual({ provider: "typesafe" });
    expect(parseChoice("TypeSafe")).toEqual({ provider: "typesafe" });
    expect(parseChoice("ollama")).toEqual({ provider: "openai-compatible", preset: "ollama" });
    expect(parseChoice("embedding")).toEqual({ provider: "embedding" });
    expect(parseChoice("heuristic")).toEqual({ provider: "heuristic" });
    expect(parseChoice("nope")).toBeUndefined();
  });

  it("merges into the adjudicator section only, null deletes, and refuses secrets", () => {
    writeFileSync(paths().configFile, JSON.stringify({ routing: { mode: "auto" } }));
    writeAdjudicatorPatch(paths().configFile, {
      enabled: true,
      openai: { preset: "groq", model: "m" },
    });
    writeAdjudicatorPatch(paths().configFile, { openai: { model: null } });
    const raw = globalRaw();
    expect(raw.routing).toEqual({ mode: "auto" });
    expect(raw.adjudicator).toEqual({ enabled: true, openai: { preset: "groq" } });
    expect(() =>
      writeAdjudicatorPatch(paths().configFile, { openai: { apiKey: SENTINEL } }),
    ).toThrow(/must not hold keys/);
    expect(readFileSync(paths().configFile, "utf8")).not.toContain(SENTINEL);
  });

  it("install's frozen defaults leave the adjudicator section out", () => {
    const d = frozenDefaults();
    expect(d).not.toHaveProperty("adjudicator");
    expect(d).toHaveProperty("routing");
  });

  it("states exactly what leaves the machine", () => {
    const cfg = ConfigSchema.parse({ adjudicator: { provider: "typesafe" } }).adjudicator;
    const r = resolveAdjudicator(cfg, { context: "cli", env: {} });
    expect(remoteNotice(r, cfg)).toBe(
      "The text of your prompts and subagent tasks (redacted, at most 2000 chars) is sent to https://api.typesafe.ai to score them.",
    );
  });

  it("resolves key ids from provider names", () => {
    const r = resolveAdjudicator(ConfigSchema.parse({}).adjudicator, { context: "cli", env: {} });
    expect(keyIdFor("jev", r)).toBe("typesafe");
    expect(keyIdFor("groq", r)).toBe("openai:groq");
    expect(keyIdFor("openai:cerebras", r)).toBe("openai:cerebras");
    expect(keyIdFor(undefined, r)).toBeUndefined();
  });
});

describe("install / onboarding question", () => {
  it("--yes skips the question and writes nothing", async () => {
    const t = fakeIo({ tty: true, answers: ["y"] });
    const res = await setupAdjudicator(t.io, { yes: true });
    expect(res.enabled).toBe(false);
    expect(t.lines.some((l) => l.includes("[y/N]"))).toBe(false);
    expect(globalRaw().adjudicator).toBeUndefined();
  });

  it("defaults to No without a terminal", async () => {
    const t = fakeIo({ tty: false });
    const res = await setupAdjudicator(t.io, {});
    expect(res.enabled).toBe(false);
    expect(t.text()).toContain(
      "Use the adjudicator for tool, model and agent selection? [y/N] (non-interactive: no)",
    );
    expect(globalRaw().adjudicator).toBeUndefined();
  });

  it("Enter at the question means No", async () => {
    const t = fakeIo({ tty: true, answers: [""] });
    expect((await setupAdjudicator(t.io, {})).enabled).toBe(false);
    expect(globalRaw().adjudicator).toBeUndefined();
  });

  it("yes + heuristic writes enabled and the provider, no consent", async () => {
    const t = fakeIo({ tty: true, answers: ["y", ""] });
    const res = await setupAdjudicator(t.io, {});
    expect(res).toMatchObject({ enabled: true, provider: "heuristic", remote: false });
    expect(globalRaw().adjudicator).toEqual({ enabled: true, provider: "heuristic" });
  });

  it("yes + Jev asks consent, then stores the key from the hidden prompt in the 0600 key file", async () => {
    const t = fakeIo({ tty: true, answers: ["y", "3", "y"], hidden: [SENTINEL] });
    const res = await setupAdjudicator(t.io, {});
    expect(res).toMatchObject({
      enabled: true,
      provider: "typesafe",
      remote: true,
      keyStored: true,
    });
    expect(globalRaw().adjudicator).toEqual({
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
      remoteConsentOrigins: ["https://api.typesafe.ai"],
    });
    expect(readFileSync(paths().configFile, "utf8")).not.toContain(SENTINEL);
    const st = statSync(paths().adjudicatorKey);
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(paths().adjudicatorKey, "utf8"))).toEqual({
      typesafe: SENTINEL,
    });
    const out = t.text();
    expect(out).toContain("is sent to https://api.typesafe.ai to score them.");
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("****Zq9X");
  });

  it("declining consent for a hosted preset keeps everything local", async () => {
    const t = fakeIo({ tty: true, answers: ["y", "4", "4", "n"] });
    const res = await setupAdjudicator(t.io, {});
    expect(res.provider).toBe("heuristic");
    expect(globalRaw().adjudicator).toEqual({ enabled: true, provider: "heuristic" });
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
  });

  it("a local preset needs neither consent nor key", async () => {
    const t = fakeIo({ tty: true, answers: ["y", "4", ""] });
    const res = await setupAdjudicator(t.io, {});
    expect(res).toMatchObject({ provider: "openai-compatible", preset: "ollama", remote: false });
    expect(t.text()).not.toContain("is sent to");
    expect(t.lines.some((l) => l.includes("[hidden]"))).toBe(false);
  });

  it("--adjudicator=groq without a terminal needs --accept-remote; --yes never grants it", async () => {
    const t = fakeIo({ tty: false });
    await setupAdjudicator(t.io, { choice: "groq", yes: true });
    expect(globalRaw().adjudicator).toEqual({ enabled: true, provider: "heuristic" });
    const t2 = fakeIo({ tty: false });
    await setupAdjudicator(t2.io, { choice: "groq", acceptRemote: true });
    expect(globalRaw().adjudicator).toMatchObject({
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "groq" },
      remoteConsent: true,
    });
    expect(t2.text()).toContain("eminiar adjudicator key set groq");
  });

  it("does not ask again once the global config says on or off", async () => {
    writeAdjudicatorPatch(paths().configFile, { enabled: false });
    const t = fakeIo({ tty: true, answers: ["y"] });
    expect((await setupAdjudicator(t.io, {})).enabled).toBe(false);
    expect(t.text()).toContain("already configured");
  });
});

describe("eminiar adjudicator enable / disable / provider", () => {
  it("refuses a remote provider without a terminal or --accept-remote and changes nothing", async () => {
    const t = fakeIo();
    expect(await run(["enable", "--provider", "typesafe"], t.io)).toBe(1);
    expect(globalRaw().adjudicator).toBeUndefined();
    expect(t.text()).toContain("--accept-remote");
  });

  it("enables with --accept-remote, tells the user to /mcp reconnect", async () => {
    const t = fakeIo();
    expect(
      await run(["enable", "--provider", "groq", "--accept-remote", "--mode", "apply"], t.io),
    ).toBe(0);
    expect(globalRaw().adjudicator).toMatchObject({
      enabled: true,
      provider: "openai-compatible",
      mode: "apply",
      remoteConsent: true,
    });
    expect(t.text()).toContain("/mcp reconnect");
    expect(t.text()).toContain("key set groq");
  });

  it("--project writes only enabled to eminiar.config.json", async () => {
    writeFileSync(join(root, "eminiar.config.json"), JSON.stringify({ routing: { mode: "auto" } }));
    const t = fakeIo();
    expect(await run(["enable", "--project"], t.io)).toBe(0);
    const proj = JSON.parse(readFileSync(join(root, "eminiar.config.json"), "utf8"));
    expect(proj).toEqual({ routing: { mode: "auto" }, adjudicator: { enabled: true } });
    expect(globalRaw().adjudicator).toBeUndefined();
    expect(loadConfig(root).adjudicator.enabled).toBe(true);
  });

  it("disable turns it off and keeps keys", async () => {
    await run(["enable"], fakeIo().io);
    const t = fakeIo();
    expect(await run(["disable"], t.io)).toBe(0);
    expect(loadConfig(root).adjudicator.enabled).toBe(false);
    expect(t.text()).toContain("off");
  });

  it("rejects unknown providers and modes", async () => {
    expect(await run(["enable", "--provider", "bogus"], fakeIo().io)).toBe(2);
    expect(await run(["enable", "--mode", "bogus"], fakeIo().io)).toBe(2);
  });

  it("provider --detect suggests a local server and changes nothing", async () => {
    const t = fakeIo();
    const portProbe = async (port: number) => port === 1234;
    expect(await run(["provider", "--detect"], t.io, { portProbe })).toBe(0);
    expect(t.text()).toContain("--preset lmstudio");
    expect(globalRaw().adjudicator).toBeUndefined();
    expect(await detectLocal(10, async () => false)).toEqual([]);
  });

  it("provider switches the preset and clears the old preset's overrides", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      provider: "openai-compatible",
      openai: { preset: "ollama", model: "llama3" },
    });
    expect(await run(["provider", "openai-compatible", "--preset", "lmstudio"], fakeIo().io)).toBe(
      0,
    );
    expect(globalRaw().adjudicator.openai).toEqual({ preset: "lmstudio" });
  });
});

describe("consent is bound to the origin the notice named (#33)", () => {
  it("records the origin, and a new preset or --base-url host asks again", async () => {
    expect(await run(["enable", "--provider", "groq", "--accept-remote"], fakeIo().io)).toBe(0);
    expect(globalRaw().adjudicator.remoteConsentOrigins).toEqual(["https://api.groq.com"]);

    // Same origin again: no question, nothing new recorded.
    let t = fakeIo();
    expect(await run(["provider", "groq"], t.io)).toBe(0);
    expect(t.text()).not.toContain("--accept-remote to agree");

    // Another preset: asked again; without a terminal or --accept-remote nothing changes.
    t = fakeIo();
    expect(await run(["provider", "cerebras"], t.io)).toBe(1);
    expect(t.text()).toContain("is sent to https://api.cerebras.ai to score them.");
    expect(t.text()).toContain("Provider not changed");
    expect(globalRaw().adjudicator.openai).toEqual({ preset: "groq" });

    // A custom host via --base-url: the notice names it, a "n" on a terminal refuses.
    t = fakeIo({ tty: true, answers: ["n"] });
    const custom = [
      "provider",
      "openai-compatible",
      "--preset",
      "custom",
      "--base-url",
      "https://other.example:8443/v1",
      "--model",
      "m",
    ];
    expect(await run(custom, t.io)).toBe(1);
    expect(t.text()).toContain("Send that text to https://other.example:8443?");
    expect(globalRaw().adjudicator.openai).toEqual({ preset: "groq" });

    // --accept-remote agrees to that origin and keeps the earlier one.
    t = fakeIo();
    expect(await run([...custom, "--accept-remote"], t.io)).toBe(0);
    expect(globalRaw().adjudicator.remoteConsentOrigins).toEqual([
      "https://api.groq.com",
      "https://other.example:8443",
    ]);
    expect(loadConfig(root).adjudicator.openai.baseUrl).toBe("https://other.example:8443/v1");
  });

  it("EMINIAR_ADJUDICATOR_REMOTE=1 never skips the question, even for a built-in host (#48)", async () => {
    const env = { EMINIAR_ADJUDICATOR_REMOTE: "1" };
    process.env.EMINIAR_ADJUDICATOR_REMOTE = "1";
    let t = fakeIo({ env });
    expect(await run(["enable", "--provider", "groq"], t.io)).toBe(1);
    expect(t.text()).toContain("https://api.groq.com");
    // Nothing is written down as a personal consent.
    expect(globalRaw().adjudicator?.remoteConsentOrigins).toBeUndefined();
    expect(globalRaw().adjudicator?.remoteConsent).not.toBe(true);
    t = fakeIo({ env });
    expect(
      await run(
        [
          "provider",
          "openai-compatible",
          "--preset",
          "custom",
          "--base-url",
          "https://x.example/v1",
          "--model",
          "m",
        ],
        t.io,
      ),
    ).toBe(1);
    expect(t.text()).toContain("https://x.example");
  });

  it("migrates a legacy remoteConsent to the configured origin without asking", async () => {
    writeFileSync(
      paths().configFile,
      JSON.stringify({
        adjudicator: {
          provider: "openai-compatible",
          openai: { preset: "groq" },
          remoteConsent: true,
        },
      }),
    );
    let t = fakeIo();
    expect(await run(["enable"], t.io)).toBe(0);
    expect(globalRaw().adjudicator).toMatchObject({
      enabled: true,
      remoteConsent: true,
      remoteConsentOrigins: ["https://api.groq.com"],
    });
    // The legacy flag no longer stretches to the other built-in host.
    t = fakeIo();
    expect(await run(["provider", "cerebras"], t.io)).toBe(1);
  });

  it("a legacy migration records only the origin the notice named, never an env-swapped one (#55)", async () => {
    const legacy = {
      adjudicator: {
        provider: "openai-compatible",
        openai: { preset: "groq" },
        remoteConsent: true,
      },
    };
    // The env (e.g. a project's .claude/settings.json) swaps the provider to typesafe.
    writeFileSync(paths().configFile, JSON.stringify(legacy));
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "typesafe";
    let t = fakeIo({ env: { EMINIAR_ADJUDICATOR_PROVIDER: "typesafe" } });
    expect(await run(["provider", "cerebras", "--accept-remote"], t.io)).toBe(0);
    expect(t.text()).toContain("is sent to https://api.cerebras.ai");
    // The only notice shown names cerebras (the env-picked typesafe stays unconsented).
    expect(t.lines.filter((l) => l.includes("is sent to"))).toEqual([
      expect.stringContaining("is sent to https://api.cerebras.ai"),
    ]);
    expect(globalRaw().adjudicator.remoteConsentOrigins).toEqual(["https://api.cerebras.ai"]);
    delete process.env.EMINIAR_ADJUDICATOR_PROVIDER;

    // Without the env: moving off the legacy provider records the new origin alone; the old one
    // (never named by this notice) asks again later.
    writeFileSync(paths().configFile, JSON.stringify(legacy));
    t = fakeIo();
    expect(await run(["provider", "cerebras", "--accept-remote"], t.io)).toBe(0);
    expect(globalRaw().adjudicator.remoteConsentOrigins).toEqual(["https://api.cerebras.ai"]);
    t = fakeIo();
    expect(await run(["provider", "groq"], t.io)).toBe(1);

    // Re-confirming the legacy provider itself records exactly the origin the printed notice
    // names; while the env picks a provider, a legacy consent covers nothing, so it asks.
    writeFileSync(paths().configFile, JSON.stringify(legacy));
    process.env.EMINIAR_ADJUDICATOR_PROVIDER = "typesafe";
    t = fakeIo({ env: { EMINIAR_ADJUDICATOR_PROVIDER: "typesafe" } });
    expect(await run(["provider", "groq"], t.io)).toBe(1);
    expect(globalRaw().adjudicator.remoteConsentOrigins).toBeUndefined();
    delete process.env.EMINIAR_ADJUDICATOR_PROVIDER;
    t = fakeIo();
    expect(await run(["provider", "groq"], t.io)).toBe(0);
    expect(t.text()).toContain("is sent to https://api.groq.com");
    expect(globalRaw().adjudicator.remoteConsentOrigins).toEqual(["https://api.groq.com"]);
  });

  it("refuses to write provider, consent or keys into a personal config inside the project (#54)", async () => {
    process.env.EMINIAR_HOME = join(root, ".em");
    let t = fakeIo();
    expect(await run(["provider", "groq", "--accept-remote"], t.io)).toBe(1);
    expect(t.text()).toContain("inside this project");
    expect(existsSync(paths().configFile)).toBe(false);
    t = fakeIo();
    expect(await run(["enable", "--provider", "groq", "--accept-remote"], t.io)).toBe(1);
    t = fakeIo({ env: { GITHUB_TOKEN: "x" } });
    expect(await run(["key", "set", "--from-env", "GITHUB_TOKEN"], t.io)).toBe(1);
    t = fakeIo({ stdin: `${SENTINEL}\n` });
    expect(await run(["key", "set", "groq"], t.io)).toBe(1);
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
    expect(existsSync(paths().configFile)).toBe(false);
    expect(t.text()).not.toContain(SENTINEL);
    // `enable --project` writes only the project file, which is fine.
    t = fakeIo();
    expect(await run(["enable", "--project"], t.io)).toBe(0);
    expect(existsSync(paths().configFile)).toBe(false);
  });

  it("status and doctor name the origin and whether consent covers it", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      enabled: true,
      provider: "openai-compatible",
      openai: { preset: "cerebras" },
      remoteConsent: true,
      remoteConsentOrigins: ["https://api.groq.com"],
    });
    const t = fakeIo();
    expect(await run(["status"], t.io)).toBe(0);
    expect(t.text()).toContain(
      "remote: sends redacted prompt text to https://api.cerebras.ai · consent NOT given for this origin (given for https://api.groq.com)",
    );
    const checks = adjudicatorDoctorChecks(loadConfig(root), { root, db, env: {} });
    expect(checks.find((c) => c.name === "adjudicator consent")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not given for https://api.cerebras.ai"),
    });
  });
});

describe("eminiar adjudicator key", () => {
  it("never takes a key from argv", async () => {
    const t = fakeIo();
    expect(await run(["key", "set", "typesafe", SENTINEL], t.io)).toBe(2);
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
    expect(await run(["key", "set", SENTINEL], fakeIo().io)).toBe(2);
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
  });

  it("reads the key from stdin, stores it 0600 and shows it masked", async () => {
    const t = fakeIo({ stdin: `${SENTINEL}\n` });
    expect(await run(["key", "set", "jev"], t.io)).toBe(0);
    if (process.platform !== "win32")
      expect(statSync(paths().adjudicatorKey).mode & 0o777).toBe(0o600);
    const s = fakeIo();
    expect(await run(["key", "status"], s.io)).toBe(0);
    expect(s.text()).toContain("typesafe: file ****Zq9X");
    expect(`${t.text()}\n${s.text()}`).not.toContain(SENTINEL);
    expect(await run(["key", "clear", "typesafe"], fakeIo().io)).toBe(0);
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
  });

  it("uses the hidden prompt on a terminal", async () => {
    const t = fakeIo({ tty: true, hidden: [SENTINEL] });
    expect(await run(["key", "set", "groq"], t.io)).toBe(0);
    expect(t.text()).toContain("[hidden]");
    expect(JSON.parse(readFileSync(paths().adjudicatorKey, "utf8"))).toEqual({
      "openai:groq": SENTINEL,
    });
  });

  it("--from-env stores the variable's name, not a key", async () => {
    expect(await run(["key", "set", "--from-env", "MY_JEV_KEY"], fakeIo().io)).toBe(0);
    expect(globalRaw().adjudicator).toEqual({ keyEnv: "MY_JEV_KEY" });
    expect(existsSync(paths().adjudicatorKey)).toBe(false);
    expect(await run(["key", "set", "--from-env", "not a name"], fakeIo().io)).toBe(2);
  });

  it("an empty stdin is an error", async () => {
    expect(await run(["key", "set", "typesafe"], fakeIo({ stdin: "" }).io)).toBe(1);
  });

  it("key status never reports an env key for a local target (#46)", async () => {
    const env = {
      EMINIAR_ADJUDICATOR_KEY: "generic-env-key-0001",
      TYPESAFE_API_KEY: "ts-env-key-0002",
      GROQ_API_KEY: "gsk_env_key_0003",
      MY_KEY: "my-env-key-0004",
    };
    writeAdjudicatorPatch(paths().configFile, {
      provider: "typesafe",
      typesafe: { baseUrl: "http://127.0.0.1:9911/v1" },
      keyEnv: "MY_KEY",
    });
    // An ollama key in the file: the env vars are not what a loopback server would get.
    expect(
      await run(["key", "set", "ollama"], fakeIo({ stdin: "ollama-file-key-0005\n", env }).io),
    ).toBe(0);
    const s = fakeIo({ env });
    expect(await run(["key", "status"], s.io)).toBe(0);
    const out = s.text();
    expect(out).toContain("typesafe (in use): none");
    expect(out).toContain("openai:ollama: file ****0005");
    expect(out).toContain("openai:groq: env $MY_KEY ****0004");
    const j = fakeIo({ env });
    expect(await run(["key", "status", "--json"], j.io)).toBe(0);
    const rows = JSON.parse(j.text()).keys as Json[];
    expect(rows.find((x) => x.id === "typesafe")).toMatchObject({ source: "none", inUse: true });
    // Storing a key for a local target does not claim an env var takes precedence.
    const set = fakeIo({ stdin: "ts-file-key-0006\n", env });
    expect(await run(["key", "set", "typesafe"], set.io)).toBe(0);
    expect(set.text()).not.toContain("takes precedence");
    const remote = fakeIo({ stdin: "gsk-file-key-0007\n", env });
    expect(await run(["key", "set", "groq"], remote.io)).toBe(0);
    expect(remote.text()).toContain("Note: $MY_KEY is set and takes precedence over the key file.");
  });

  describe("never echoes a key pasted on the command line", () => {
    // The bug report's shape (no dash, matches an env-var name), the suite's sentinel, a long
    // token with no known prefix, and a short one that only the prefix gives away.
    const KEYS = [
      "gsk_SENTINELkeyPastedAsArg0123456789",
      SENTINEL,
      "SENTINELnoPrefixButLong42",
      "sk-SNTNL9q",
    ];
    const invocations = (k: string): string[][] => [
      ["key", "set", k],
      ["key", k],
      ["key", "set", "--provider", k],
      [k],
      ["key", "set", "typesafe", k],
      ["key", "clear", k],
      ["key", "status", k],
      ["key", "set", "--from-env", k],
    ];

    for (const k of KEYS)
      for (const args of invocations(k))
        it(`${args.join(" ").replace(k, "<key>")} (${k.slice(0, 4)}…)`, async () => {
          // stdin carries the same key: even reading it must not happen or echo it
          const t = fakeIo({ stdin: `${k}\n` });
          expect(await run(args, t.io)).toBe(2);
          expect(t.text()).not.toContain(k);
          if (args[0] === "key") expect(t.text()).toContain("never taken from the command line");
          expect(existsSync(paths().adjudicatorKey)).toBe(false);
          if (existsSync(paths().configFile))
            expect(readFileSync(paths().configFile, "utf8")).not.toContain(k);
        });

    it("other commands hide a key-shaped provider, preset or mode", async () => {
      const k = KEYS[0] as string;
      for (const args of [
        ["enable", "--provider", k],
        ["enable", "--provider", "openai-compatible", "--preset", k],
        ["enable", "--mode", k],
        ["provider", k],
        ["test", "hello", "--provider", k],
        ["eval", "--provider", k],
      ]) {
        const t = fakeIo();
        expect(await run(args, t.io)).toBe(2);
        expect(t.text()).not.toContain(k);
        expect(t.text()).toContain("argument hidden");
      }
      expect(globalRaw().adjudicator).toBeUndefined();
    });

    it("still names an ordinary unknown provider and accepts --provider as the target", async () => {
      const t = fakeIo();
      expect(await run(["key", "set", "bogus"], t.io)).toBe(2);
      expect(t.text()).toContain('unknown provider "bogus"');
      const s = fakeIo({ stdin: `${SENTINEL}\n` });
      expect(await run(["key", "set", "--provider", "groq"], s.io)).toBe(0);
      expect(JSON.parse(readFileSync(paths().adjudicatorKey, "utf8"))).toEqual({
        "openai:groq": SENTINEL,
      });
      expect(s.text()).not.toContain(SENTINEL);
    });

    it("looksLikeKey spares every known name and a set --from-env variable", async () => {
      for (const n of [...CHOICES, "openai-compatible", "openai:cerebras", "OpenAI:Groq"])
        expect(looksLikeKey(n)).toBe(false);
      for (const k of KEYS) expect(looksLikeKey(k)).toBe(true);
      expect(looksLikeKey("bogus")).toBe(false);
      expect(looksLikeKey(undefined)).toBe(false);
      const env = { ADJUDICATOR_JEV_KEY_2026xY: "v" };
      expect(
        await run(["key", "set", "--from-env", "ADJUDICATOR_JEV_KEY_2026xY"], fakeIo({ env }).io),
      ).toBe(0);
      expect(globalRaw().adjudicator).toEqual({ keyEnv: "ADJUDICATOR_JEV_KEY_2026xY" });
    });
  });
});

describe("eminiar adjudicator status", () => {
  it("shows off by default", async () => {
    const t = fakeIo();
    expect(await run(["status"], t.io)).toBe(0);
    expect(t.text()).toContain("adjudicator: off (default)");
  });

  it("--json shows the degraded reason and never the key", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
    });
    const t = fakeIo();
    await run(["status", "--json"], t.io);
    const s = JSON.parse(t.lines[0] ?? "{}");
    expect(s).toMatchObject({
      enabled: true,
      configured: "typesafe",
      effective: "heuristic",
      degraded: "no_key",
      remote: true,
      host: "api.typesafe.ai",
      consent: true,
    });
  });

  it("shows API key rejected while the provider is locked out", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      enabled: true,
      provider: "typesafe",
      remoteConsent: true,
    });
    const env = { TYPESAFE_API_KEY: SENTINEL };
    const now = Date.UTC(2026, 10, 4, 12);
    db.adjudicator.saveProviderState("typesafe", {
      state: "auth_failed",
      authFingerprint: keyFingerprint(SENTINEL),
      retryAt: now + 3_600_000,
      lastErrorClass: "http_error:401",
    });
    const t = fakeIo({ env });
    await run(["status"], t.io);
    expect(t.text()).toContain("API key rejected (HTTP 401)");
    expect(t.text()).not.toContain(SENTINEL);
    const checks = adjudicatorDoctorChecks(loadConfig(root), { root, db, env, now });
    const main = checks.find((c) => c.name === "adjudicator");
    expect(main?.ok).toBe(false);
    expect(main?.detail).toContain("API key rejected");
  });
});

describe("doctor", () => {
  it("one ok line while off", () => {
    const checks = adjudicatorDoctorChecks(ConfigSchema.parse({}), { root, env: {} });
    expect(checks).toEqual([
      { name: "adjudicator", ok: true, detail: "off (opt-in: `eminiar adjudicator enable`)" },
    ]);
    expect(
      runDoctor({ config: ConfigSchema.parse({}), root }).some((c) => c.name === "adjudicator"),
    ).toBe(true);
  });

  it("flags no key, no consent, an insecure key file, invalid config and a forced model in apply mode", () => {
    writeFileSync(paths().adjudicatorKey, JSON.stringify({ "openai:groq": SENTINEL }), {
      mode: 0o644,
    });
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { mode: "bogus" } }),
    );
    const config = ConfigSchema.parse({
      adjudicator: { enabled: true, provider: "openai-compatible", mode: "apply" },
    });
    const checks = adjudicatorDoctorChecks(config, {
      root,
      db,
      env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" },
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(by["adjudicator config"]?.ok).toBe(false);
    expect(by.adjudicator?.ok).toBe(false);
    expect(by["adjudicator consent"]?.ok).toBe(false);
    if (process.platform !== "win32") expect(by["adjudicator key"]?.ok).toBe(false);
    expect(by["adjudicator apply"]?.ok).toBe(false);
    expect(JSON.stringify(checks)).not.toContain(SENTINEL);
  });

  it("reads CLAUDE_CODE_SUBAGENT_MODEL_FORCE with Claude Code's on/off rule, like the hook (#59)", async () => {
    writeAdjudicatorPatch(paths().configFile, { enabled: true, mode: "apply" });
    const config = loadConfig(root);
    for (const [value, on] of [
      ["yes", true],
      ["ON", true],
      ["True", true],
      ["1", true],
      ["no", false],
      ["off", false],
      ["0", false],
      ["false", false],
      ["", false],
      ["maybe", false],
    ] as const) {
      const env = { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: value };
      const checks = adjudicatorDoctorChecks(config, { root, db, env });
      expect(
        checks.some((c) => c.name === "adjudicator apply"),
        value,
      ).toBe(on);
      const t = fakeIo({ env });
      expect(await run(["status"], t.io)).toBe(0);
      expect(t.text().includes("CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on"), value).toBe(on);
      const j = fakeIo({ env });
      expect(await run(["status", "--json"], j.io)).toBe(0);
      expect(JSON.parse(j.text()).modelForced, value).toBe(on);
    }
  });

  it("status, doctor and the dashboard name project keys that were ignored, even while off (#46)", async () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({
        adjudicator: {
          enabled: false,
          provider: "openai-compatible",
          openai: { preset: "custom", baseUrl: "https://attacker.example/v1", model: "m" },
          keyEnv: "ANTHROPIC_API_KEY",
        },
      }),
    );
    const line =
      "eminiar.config.json sets adjudicator.keyEnv, adjudicator.openai, adjudicator.provider: ignored, only ~/.eminiar/config.json may set them";
    const t = fakeIo();
    expect(await run(["status"], t.io)).toBe(0);
    expect(t.text()).toContain(`warning: ${line}`);
    const j = fakeIo();
    await run(["status", "--json"], j.io);
    expect(JSON.parse(j.text()).projectIgnored).toBe(line);
    const checks = adjudicatorDoctorChecks(loadConfig(root), { root, env: {} });
    expect(checks).toContainEqual({ name: "adjudicator project config", ok: true, detail: line });
    expect(
      runDoctor({ config: loadConfig(root), root }).find(
        (c) => c.name === "adjudicator project config",
      )?.detail,
    ).toBe(line);
    const { overviewPayload } = await import("../../src/ui/adjudicator-api.js");
    const ov = overviewPayload(ctx, { db, config: loadConfig(root), env: {} });
    expect(ov.projectIgnored).toBe(line);
    // No project file: nothing extra.
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ adjudicator: { mode: "advise" } }),
    );
    expect(
      adjudicatorDoctorChecks(loadConfig(root), { root, env: {} }).some(
        (c) => c.name === "adjudicator project config",
      ),
    ).toBe(false);
  });

  it("the live check probes the configured provider", async () => {
    const config = ConfigSchema.parse({
      adjudicator: { enabled: true, provider: "openai-compatible", openai: { preset: "ollama" } },
    });
    const checks = await adjudicatorLiveChecks(config, {
      env: {},
      deps: { provider: fakeProvider().provider },
    });
    expect(checks).toEqual([expect.objectContaining({ name: "adjudicator probe", ok: true })]);
  });
});

describe("apply mode while every swarm role pins a model (#108)", () => {
  const PINS =
    'every role of swarm "feat" pins a model, so apply mode cannot change any worker\'s model (add model_range in swarm.yaml, then `eminiar swarm sync`)';
  const yaml = (coder: string) =>
    `version: 1\nswarms:\n  feat:\n    description: a swarm\n    agents:\n      coder:\n        description: writes code\n${coder}      reviewer:\n        description: reviews code\n        model: opus\n`;
  /** swarm.yaml plus the agent files `eminiar swarm sync` writes from it. */
  function swarm(coder = "        model: sonnet\n") {
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), yaml(coder));
    const r = loadSwarmConfig(root);
    if (r.state !== "ok") throw new Error(JSON.stringify(r));
    syncAgents(root, r.config);
  }
  // User agents come from HOME: keep the real ~/.claude/agents out.
  const env = () => ({ HOME: home });
  async function status(e: NodeJS.ProcessEnv = env()) {
    const t = fakeIo({ env: e });
    expect(await run(["status"], t.io)).toBe(0);
    const j = fakeIo({ env: e });
    expect(await run(["status", "--json"], j.io)).toBe(0);
    const doctor = adjudicatorDoctorChecks(loadConfig(root), { root, db, env: e }).find(
      (c) => c.name === "adjudicator swarm pins",
    );
    return { text: t.text(), json: JSON.parse(j.text()).pinnedSwarms, doctor };
  }

  it("status warns and doctor informs in apply mode; advise mode stays quiet", async () => {
    swarm();
    writeAdjudicatorPatch(paths().configFile, { enabled: true, mode: "apply" });
    const on = await status();
    expect(on.text).toContain(`warning: ${PINS}`);
    expect(on.json).toEqual(["feat"]);
    // Information, not a failure: install and doctor still pass.
    expect(on.doctor).toEqual({ name: "adjudicator swarm pins", ok: true, detail: PINS });

    writeAdjudicatorPatch(paths().configFile, { mode: "advise" });
    const advise = await status();
    expect(advise.text).not.toContain("pins a model");
    expect(advise.json).toBeNull();
    expect(advise.doctor).toBeUndefined();
  });

  it("a ranged or unpinned role, FORCE, respectFrontmatter off or no swarm file clear it", async () => {
    writeAdjudicatorPatch(paths().configFile, { enabled: true, mode: "apply" });
    const quiet = (s: Awaited<ReturnType<typeof status>>) => {
      expect(s.text).not.toContain("pins a model");
      expect(s.json).toEqual([]);
      expect(s.doctor).toBeUndefined();
    };
    quiet(await status()); // no swarm.yaml
    swarm("        model: sonnet\n        model_range: { floor: haiku, ceiling: opus }\n");
    quiet(await status());
    swarm("        model: inherit\n");
    quiet(await status());
    swarm();
    expect((await status()).json).toEqual(["feat"]);
    // FORCE has its own warning; the pins are moot under it.
    const forcedRun = await status({ ...env(), CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" });
    expect(forcedRun.text).toContain("CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on");
    quiet(forcedRun);
    writeAdjudicatorPatch(paths().configFile, { apply: { respectFrontmatter: false } });
    quiet(await status());
  });
});

function fakeProvider() {
  let calls = 0;
  const provider: AdjudicatorProvider = {
    id: "openai-compatible",
    remote: false,
    dims: ["complexity", "tier", "role", "tool"],
    async adjudicate(reqs): Promise<ProviderResult> {
      calls++;
      return {
        answers: reqs.map((r) => ({
          key: r.key,
          complexity: { value: 3.5, confidence: 0.9 },
          tier: {
            probs: { haiku: 0.05, sonnet: 0.15, opus: 0.8 },
            confidence: 0.8,
            calibrated: true,
          },
        })),
        usage: { inTok: 120, outTok: 20, costUsd: 0 },
        latencyMs: 42,
        model: "fake-1",
      };
    },
    async probe() {
      return { ok: true, latencyMs: 3, detail: "fake-1 listed" };
    },
  };
  return { provider, calls: () => calls };
}

describe("eminiar adjudicator test / eval / stats", () => {
  it("test shows heuristic, raw and blended with one provider call, and persists nothing", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      provider: "openai-compatible",
      openai: { preset: "ollama" },
    });
    const f = fakeProvider();
    const t = fakeIo();
    const code = await run(
      ["test", "redesign the storage layer across every module and migrate the schema"],
      t.io,
      { provider: f.provider },
    );
    expect(code).toBe(0);
    expect(f.calls()).toBe(1);
    const out = t.text();
    expect(out).toMatch(/^probe: +ok/m);
    expect(out).toMatch(/^heuristic /m);
    expect(out).toMatch(/^raw .*tier opus \(0\.80\).*fake-1.*120\+20 tok/m);
    expect(out).toMatch(/^blended /m);
    expect(db.adjudicator.summary().total).toBe(0);
  });

  it("test --json reports a failed provider and exits 1", async () => {
    writeAdjudicatorPatch(paths().configFile, {
      provider: "openai-compatible",
      openai: { preset: "ollama" },
    });
    const f = fakeProvider();
    f.provider.adjudicate = async () => {
      throw Object.assign(new Error("connection refused"), { kind: "http_error" });
    };
    const t = fakeIo();
    expect(
      await run(["test", "fix the typo in README", "--json"], t.io, { provider: f.provider }),
    ).toBe(1);
    const j = JSON.parse(t.lines[0] ?? "{}");
    expect(j.rawError).toContain("connection refused");
    expect(j.blended.source).not.toBe("blend");
    expect(j.persisted).toBe(false);
  });

  it("test needs text", async () => {
    expect(await run(["test"], fakeIo().io)).toBe(2);
  });

  it("eval runs the heuristic on the built-in set and checks fixture types", async () => {
    const t = fakeIo();
    expect(await run(["eval", "--json"], t.io)).toBe(0);
    const report = JSON.parse(t.lines.join("\n"));
    expect(report.set.source).toBe("builtin");
    expect(report.rows.some((r: { kind: string }) => r.kind === "heuristic")).toBe(true);
    expect(await run(["eval", "--fixture", "x.yaml"], fakeIo().io)).toBe(2);
    expect(await run(["eval", "--repeat", "0"], fakeIo().io)).toBe(2);
  });

  it("eval --fixture merges a .json fixture and --save stores the report", async () => {
    const file = join(root, "fx.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          text: "rename a variable in utils",
          tool: "Edit",
          tier: "haiku",
          role: "coder",
          complexity: 0,
        },
      ]),
    );
    const t = fakeIo();
    expect(await run(["eval", "--fixture", file, "--save"], t.io)).toBe(0);
    expect(t.text()).toContain("saved as the last eval");
    expect(db.metaGet("adjudicator:eval:last")).toContain('"fixture":"fx.json"');
  });

  it("stats reports none yet, --json gives summary and savings, --reset-learning clears bias", async () => {
    const t = fakeIo();
    expect(await run(["stats"], t.io)).toBe(0);
    expect(t.text()).toContain("No adjudicator decisions");
    const j = fakeIo();
    expect(await run(["stats", "--json", "--since", "7d"], j.io)).toBe(0);
    const parsed = JSON.parse(j.lines.join("\n"));
    expect(parsed.summary.total).toBe(0);
    expect(parsed.savings).toHaveProperty("assumptions");
    const r = fakeIo();
    expect(await run(["stats", "--reset-learning"], r.io)).toBe(0);
    expect(r.text()).toContain("Learned bias reset");
    expect(await run(["stats", "--since", "yesterday"], fakeIo().io)).toBe(2);
  });

  it("unknown subcommands print usage and exit 2", async () => {
    const t = fakeIo();
    expect(await run(["frobnicate"], t.io)).toBe(2);
    expect(t.text()).toContain("eminiar adjudicator <command>");
  });
});

describe("flag values never echo or store a key (#57)", () => {
  const K = "gsk_SENTINELKEY0123456789abcdef";
  const RAW = "SENTINELKEY0123456789abcdef0123"; // no known prefix, still key-shaped
  const cases: string[][] = [
    ["provider", "groq", "--model", K, "--accept-remote"],
    ["provider", "groq", "--model", RAW, "--accept-remote"],
    [
      "provider",
      "custom",
      "--base-url",
      `https://h.example/v1?api_key=${K}`,
      "--model",
      "m",
      "--accept-remote",
    ],
    [
      "provider",
      "custom",
      "--base-url",
      "https://h.example/v1?api_key=short",
      "--model",
      "m",
      "--accept-remote",
    ],
    [
      "provider",
      "custom",
      "--base-url",
      `https://h.example/v1?x=${RAW}`,
      "--model",
      "m",
      "--accept-remote",
    ],
    [
      "provider",
      "custom",
      "--base-url",
      `https://u:${K}@h.example/v1`,
      "--model",
      "m",
      "--accept-remote",
    ],
    [
      "provider",
      "custom",
      "--base-url",
      `https://h.example/${RAW}/v1`,
      "--model",
      "m",
      "--accept-remote",
    ],
    [
      "provider",
      "custom",
      "--base-url",
      `https://h.example/v1#${K}`,
      "--model",
      "m",
      "--accept-remote",
    ],
    ["stats", "--since", K],
    ["stats", "--since", "nonsense-value"],
    ["eval", "--fixture", `${RAW}.json`],
    ["eval", "--fixture", K],
    ["eval", "--repeat", K],
  ];
  it.each(cases)("refuses %s %s … without echoing or writing it", async (...args) => {
    const t = fakeIo();
    expect(await run(args, t.io)).toBe(2);
    for (const secret of [K, RAW, "short", "nonsense-value"])
      expect(t.text()).not.toContain(secret);
    if (existsSync(paths().configFile))
      expect(readFileSync(paths().configFile, "utf8")).not.toMatch(/SENTINEL|short/);
  });

  it("ordinary model ids, URLs and dates still pass", async () => {
    let t = fakeIo();
    expect(
      await run(
        [
          "provider",
          "custom",
          "--base-url",
          "https://h.example/openai/v1?api-version=2024-10-21",
          "--model",
          "meta-llama/Llama-3.1-8B-Instruct-Turbo",
          "--accept-remote",
        ],
        t.io,
      ),
    ).toBe(0);
    expect(globalRaw().adjudicator.openai).toMatchObject({
      baseUrl: "https://h.example/openai/v1?api-version=2024-10-21",
      model: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
    });
    t = fakeIo();
    expect(await run(["provider", "ollama", "--model", "qwen2.5:1.5b-instruct"], t.io)).toBe(0);
    t = fakeIo();
    expect(await run(["stats", "--since", "2026-10-01T00:00:00Z"], t.io)).toBe(0);
    t = fakeIo();
    expect(await run(["stats", "--since", "7d"], t.io)).toBe(0);
  });

  it("--fixture reads a file under a long folder name (macOS $TMPDIR), not a key-named file", async () => {
    // /var/folders/xx/<30 letters and digits>/T/ on macOS: only the file name is checked.
    const dir = join(root, "q7xk2m9v4b8n1c6z3l5j0h7g2f9d4s", "T");
    mkdirSync(dir, { recursive: true });
    const item = {
      text: "rename a variable",
      tool: "Edit",
      tier: "haiku",
      role: "coder",
      complexity: 0,
    };
    const ok = join(dir, "fx.json");
    writeFileSync(ok, JSON.stringify([item]));
    expect(await run(["eval", "--fixture", ok], fakeIo().io)).toBe(0);
    // An existing file whose name is key-shaped is still refused, without echoing it.
    const keyed = join(dir, `${RAW}.json`);
    writeFileSync(keyed, JSON.stringify([item]));
    const t = fakeIo();
    expect(await run(["eval", "--fixture", keyed], t.io)).toBe(2);
    expect(t.text()).not.toContain(RAW);
    const prefixed = join(dir, "sk-live7.json"); // a short key with a known prefix
    writeFileSync(prefixed, JSON.stringify([item]));
    expect(await run(["eval", "--fixture", prefixed], fakeIo().io)).toBe(2);
  });
});
