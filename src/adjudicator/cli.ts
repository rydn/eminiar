import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  type AdjudicatorConfig,
  AdjudicatorConfigSchema,
  type Config,
  ConfigSchema,
  loadConfig,
  parseJsonSafe,
  personalConfigProblem,
  personalConfigTrusted,
  projectAdjudicatorWarning,
} from "../config.js";
import type { ProjectContext } from "../context.js";
import { paths } from "../paths.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { EXCHANGE_KEEP } from "../storage/sqlite/adjudicator.js";
import { activeSwarmConfig } from "../swarm/config.js";
import { formatStats } from "../tools/em_adjudicate.js";
import { parseSince } from "../tools/em_usage.js";
import { resolveAgentPin } from "./agent-pin.js";
import { callsToday, p95, spendToday } from "./breaker.js";
import {
  consentedOrigins,
  keyFor,
  PRESETS,
  type PresetId,
  type Resolved,
  type ResolvedWithLockout,
  resolveAdjudicator,
  withAuthLockout,
  withConsentedOrigin,
} from "./config.js";
import { adjudicateOne, surfaceBudget } from "./engine.js";
import { subagentModelForced } from "./env.js";
import * as ev from "./eval.js";
import { reconcile } from "./learn.js";
import { defaultEmbeddingFactory } from "./providers/embedding.js";
import { PROBE_TIMEOUT_MS, type ProviderDeps } from "./providers/http.js";
import { createProvider, hasProvider, registerProvider } from "./providers/index.js";
import { isSecretName } from "./redact.js";
import { SAVINGS_ASSUMPTIONS, savingsReport } from "./savings.js";
import { clearKey, type KeyId, keyFileStatus, mask, setKey, storedKeyIds } from "./secrets.js";
import { securityCommand, securityDoctorChecks } from "./security/cli.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  MODES,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderResult,
  type Verdict,
} from "./types.js";

/**
 * `eminiar adjudicator …` (docs/design/adjudicator.md §17) and the install/onboarding question
 * (§18). Loaded lazily from src/cli.ts; the MCP server reaches it through src/doctor.ts, so its
 * own internal imports stay static (the server is one file: tsup.config.ts). Keys are never read from argv: a hidden TTY prompt,
 * stdin, or the NAME of an env var (`--from-env`). Consent to send text off the machine is a
 * y/N on a TTY or `--accept-remote`; `--yes` never implies it.
 */

// --- io ------------------------------------------------------------------------------

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** stdin and stdout are both terminals: prompts are possible. */
  isTTY: boolean;
  /** A visible prompt; returns the line typed. */
  ask(question: string): Promise<string>;
  /** A prompt whose input is not echoed (keys). */
  askHidden(question: string): Promise<string>;
  /** Everything piped on stdin (non-TTY key input). */
  readStdin(): Promise<string>;
  env: NodeJS.ProcessEnv;
  now(): number;
}

export function defaultIo(): Io {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask: askLine,
    askHidden: readHidden,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    env: process.env,
    now: Date.now,
  };
}

async function askLine(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((res) => rl.question(question, res));
  } finally {
    rl.close();
  }
}

/** Raw-mode read without echo; Ctrl-C cancels, backspace edits. */
function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let buf = "";
    const wasRaw = stdin.isRaw;
    // Echo goes off before the prompt appears, so nothing typed after it is ever shown.
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    process.stdout.write(question);
    const done = (err?: Error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * A y/N question that defaults to No: no TTY means No. Unlike install's confirm(), `--yes`
 * does not answer it, so callers skip it under --yes instead.
 */
export async function askNo(io: Io, question: string): Promise<boolean> {
  if (!io.isTTY) {
    io.out(`${question} [y/N] (non-interactive: no)`);
    return false;
  }
  return /^y(es)?$/i.test((await io.ask(`${question} [y/N] `)).trim());
}

// --- config files -------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readRaw(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let v: unknown;
  try {
    // No __proto__/constructor/prototype key survives (task #62): applyPatch assigns into it.
    v = parseJsonSafe(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); fix it first`);
  }
  if (!isObj(v)) throw new Error(`${file} is not a JSON object; fix it first`);
  return v;
}

/** Merge `patch` into `target`; a null value deletes the key. Returns `target`. */
function applyPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v === null) delete target[k];
    else if (isObj(v)) target[k] = applyPatch(isObj(target[k]) ? { ...target[k] } : {}, v);
    else target[k] = v;
  }
  return target;
}

function writeAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
}

/**
 * Merge `patch` into the `adjudicator` section of a config file (null deletes a key) and write
 * it back, after checking the section still validates. Other sections are kept as they are.
 */
export function writeAdjudicatorPatch(file: string, patch: Record<string, unknown>): void {
  const raw = readRaw(file);
  const adj = applyPatch(isObj(raw.adjudicator) ? { ...raw.adjudicator } : {}, patch);
  const parsed = AdjudicatorConfigSchema.safeParse(adj);
  if (!parsed.success)
    throw new Error(
      `invalid adjudicator config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  raw.adjudicator = adj;
  writeAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
}

const projectFile = (root: string) => join(root, "eminiar.config.json");

const tilde = (p: string) => {
  const h = homedir();
  return h && p.startsWith(h) ? `~${p.slice(h.length)}` : p;
};

/** Which layer decides `enabled`: env > project > global > default. */
export function enabledSource(root: string, env: NodeJS.ProcessEnv): string {
  const e = env.EMINIAR_ADJUDICATOR;
  if (e === "0" || e === "1") return `env EMINIAR_ADJUDICATOR=${e}`;
  const enabledIn = (file: string) => {
    try {
      const a = readRaw(file).adjudicator;
      return isObj(a) && typeof a.enabled === "boolean";
    } catch {
      return false;
    }
  };
  if (enabledIn(projectFile(root))) return "project eminiar.config.json";
  if (enabledIn(paths().configFile)) return `global ${tilde(paths().configFile)}`;
  return "default";
}

/** The global config already says on or off (an earlier install or enable/disable). */
export function adjudicatorConfigured(): boolean {
  try {
    const a = readRaw(paths().configFile).adjudicator;
    return isObj(a) && typeof a.enabled === "boolean";
  } catch {
    return false;
  }
}

// --- provider choices -----------------------------------------------------------------

/** What `--adjudicator=<x>`, `enable --provider/--preset` and onboarding accept. */
export const CHOICES = [
  "heuristic",
  "embedding",
  "typesafe",
  "jev",
  "groq",
  "cerebras",
  "ollama",
  "lmstudio",
  "llamacpp",
  "custom",
] as const;

export interface Choice {
  provider: ProviderId;
  preset?: PresetId;
}

const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** "jev" is TypeSafe's model; a preset name means openai-compatible with that preset. */
export function parseChoice(s: string | undefined): Choice | undefined {
  const v = s?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "jev" || v === "typesafe") return { provider: "typesafe" };
  if (v === "openai" || v === "openai-compatible") return { provider: "openai-compatible" };
  if ((PRESET_IDS as string[]).includes(v))
    return { provider: "openai-compatible", preset: v as PresetId };
  if ((PROVIDER_IDS as readonly string[]).includes(v)) return { provider: v as ProviderId };
  return undefined;
}

// --- never echo a pasted key --------------------------------------------------------------

/** Prefixes of common API keys; a short pasted key with one of these is still hidden. */
const KEY_PREFIX =
  /^(?:sk|gsk|csk|pk|rk|xai|ghp|gho|ghs|ghu|github_pat|glpat|hf|AIza|nvapi|pplx|tsk)[-_]/i;

/** The fixed answer to a key typed on the command line; it never repeats the argument. */
export const KEY_NOT_FROM_ARGV =
  "That looks like a key: keys are never taken from the command line (they would land in shell history and the process list). Run `eminiar adjudicator key set [provider]` and paste it at the hidden prompt, or pipe it on stdin.";

/**
 * True when a command-line argument is not a known provider/preset name and could be a pasted
 * key: any unknown token of 16+ chars (every known name is shorter or recognised first) or one
 * with a common key prefix. Such an argument is never echoed back.
 */
export function looksLikeKey(arg: string | undefined): boolean {
  const v = arg?.trim();
  if (!v) return false;
  if (parseChoice(v)) return false;
  if (/^openai:/i.test(v) && (PRESET_IDS as string[]).includes(v.slice(7).toLowerCase()))
    return false;
  return v.length >= 16 || KEY_PREFIX.test(v);
}

/**
 * True when a flag value (a model id, a date, a path, a URL part) could carry a key (task #57):
 * a common key prefix, or a segment of 20+ characters between separators that holds a digit.
 * Model ids, dates and paths are made of short segments ("openai/gpt-oss-20b",
 * "2026-11-04T12:00:00Z"), so they pass; looksLikeKey's 16-char rule would refuse them.
 */
export function valueLooksLikeKey(value: string | undefined): boolean {
  const v = value?.trim();
  if (!v) return false;
  if (KEY_PREFIX.test(v)) return true;
  return v.split(/[\s\-_/.:@+=,;&?#%~]+/).some((seg) => seg.length >= 20 && /\d/.test(seg));
}

/**
 * valueLooksLikeKey for a path flag (--fixture). The folders of an existing file are not checked,
 * since the user did not type a key there: macOS puts temp files under
 * /var/folders/xx/<30 letters and digits>/T/, which the segment rule would refuse. Its file name
 * still is (key prefix and segment rule), and a value that is not an existing file (a pasted
 * key) gets the full check.
 */
function pathLooksLikeKey(value: string): boolean {
  const v = value.trim();
  let isFile = false;
  try {
    isFile = statSync(v).isFile();
  } catch {
    // missing or unreadable: check the whole value
  }
  return valueLooksLikeKey(isFile ? basename(v) : v);
}

/**
 * Why a --base-url is refused, or undefined when it may be stored (task #57). It must be a plain
 * http(s) URL: no user name or password, no fragment, no query parameter named like a secret or
 * holding a key-shaped value, no key-shaped path segment. The message never repeats the URL.
 */
export function baseUrlProblem(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "--base-url takes an http(s) URL such as https://host/v1";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return "--base-url takes an http(s) URL such as https://host/v1";
  const why =
    u.username || u.password
      ? "a user name or password"
      : [...u.searchParams].some(
            ([k, v]) => isSecretName(k) || valueLooksLikeKey(k) || valueLooksLikeKey(v),
          )
        ? "a key in its query string"
        : u.hash
          ? "a #fragment"
          : valueLooksLikeKey(decodeURIComponent(u.pathname))
            ? "a key-shaped path segment"
            : undefined;
  if (!why) return undefined;
  return `--base-url must not carry ${why}; keys are never taken from the command line. Use the endpoint's plain URL and \`eminiar adjudicator key set\` for the key.`;
}

/**
 * The first string flag that could carry a key, checked before any config is loaded (task
 * #57); its value is never echoed. Provider, preset and mode names go through shown().
 */
function argvKeyProblem(values: Record<string, unknown>): string | undefined {
  for (const flag of ["model", "since", "fixture", "repeat", "providers"]) {
    const v = values[flag];
    if (typeof v !== "string") continue;
    if (flag === "fixture" ? pathLooksLikeKey(v) : valueLooksLikeKey(v)) return KEY_NOT_FROM_ARGV;
  }
  const url = values["base-url"];
  if (typeof url === "string" && url) return baseUrlProblem(url);
  return undefined;
}

/** `"arg"` for an ordinary unknown value; a fixed placeholder when it could be a key. */
const shown = (arg: unknown): string =>
  looksLikeKey(String(arg)) ? "(argument hidden: it may be a key)" : `"${String(arg)}"`;

/**
 * --from-env takes a variable NAME; refuse one shaped like a key (a key prefix, or mixed case
 * with digits at key length) unless a variable of that name is actually set.
 */
function envNameLooksLikeKey(name: string, env: NodeJS.ProcessEnv): boolean {
  if (env[name] !== undefined) return false;
  return (
    KEY_PREFIX.test(name) ||
    (name.length >= 20 && /[a-z]/.test(name) && /[A-Z]/.test(name) && /\d/.test(name))
  );
}

function choicePatch(c: Choice, current: AdjudicatorConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = { provider: c.provider };
  if (c.preset) {
    const openai: Record<string, unknown> = { preset: c.preset };
    // Switching presets drops the old preset's URL/model overrides.
    if (c.preset !== current.openai.preset) Object.assign(openai, { baseUrl: null, model: null });
    patch.openai = openai;
  }
  return patch;
}

/** The adjudicator section that `patch` would produce on top of the effective config. */
function candidate(current: AdjudicatorConfig, patch: Record<string, unknown>): AdjudicatorConfig {
  const merged = applyPatch(structuredClone(current) as Record<string, unknown>, patch);
  return AdjudicatorConfigSchema.parse(merged);
}

/** The key id and display label a provider needs, or undefined when it needs none. */
function keyNeed(r: Resolved): { id: KeyId; label: string } | undefined {
  if (r.configured === "typesafe") return { id: "typesafe", label: "TypeSafe (Jev)" };
  if (r.configured === "openai-compatible" && r.configuredRemote && r.preset)
    return { id: `openai:${r.preset}`, label: presetLabel(r.preset) };
  return undefined;
}

function presetLabel(p: PresetId): string {
  return (
    {
      groq: "Groq",
      cerebras: "Cerebras",
      ollama: "Ollama",
      lmstudio: "LM Studio",
      llamacpp: "llama.cpp",
      custom: "custom endpoint",
    } as Record<PresetId, string>
  )[p];
}

function providerLabel(r: Pick<Resolved, "configured" | "preset">): string {
  if (r.configured === "typesafe") return "typesafe (Jev)";
  if (r.configured === "openai-compatible") return `openai-compatible/${r.preset ?? "?"}`;
  return r.configured;
}

function hostOf(url: string | undefined): string {
  if (!url) return "a remote host";
  try {
    return new URL(url).host;
  } catch {
    return "a remote host";
  }
}

/** The exact statement of what leaves the machine (§17), naming the origin consent is bound to. */
export function remoteNotice(
  r: Pick<Resolved, "baseUrl" | "origin">,
  cfg: AdjudicatorConfig,
): string {
  return `The text of your prompts and subagent tasks (redacted, at most ${cfg.privacy.maxChars} chars) is sent to ${r.origin ?? hostOf(r.baseUrl)} to score them.`;
}

/**
 * Task #54: true (after saying why) when `file`, the personal config by default, lies inside this
 * project because EMINIAR_HOME or HOME points into it. The adjudicator ignores provider, consent
 * and key settings there, and a key stored there could be committed, so the caller writes nothing.
 */
function personalFileUntrusted(io: Io, root: string, file = paths().configFile): boolean {
  const problem = personalConfigProblem(root, file);
  if (!problem) return false;
  io.err(
    `${file} ${problem}: the adjudicator ignores provider, consent and key settings there, and a key stored there could be committed. Nothing was changed; run this from a shell where EMINIAR_HOME and HOME are absolute paths outside the project.`,
  );
  return true;
}

/** The consent fields of ~/.eminiar/config.json alone: never the env var or the project file. */
function personalConsent(): Pick<AdjudicatorConfig, "remoteConsent" | "remoteConsentOrigins"> {
  try {
    const a = readRaw(paths().configFile).adjudicator;
    if (!isObj(a)) return { remoteConsent: false };
    const list = a.remoteConsentOrigins;
    return {
      remoteConsent: a.remoteConsent === true,
      ...(Array.isArray(list)
        ? { remoteConsentOrigins: list.filter((s): s is string => typeof s === "string") }
        : {}),
    };
  } catch {
    return { remoteConsent: false };
  }
}

/**
 * Whether the CLI must show the notice and ask before writing `r` (task #33): consent is bound to
 * an origin, so a new host asks again. A legacy consent (remoteConsent true, no origin list) still
 * covers, without asking, the provider it was given for (`previous`, from personalOrigin()), and
 * is then recorded.
 */
function mustAsk(r: Resolved, previous: string | undefined): boolean {
  if (!r.configuredRemote) return false;
  if (!r.consent) return true;
  return r.consentVia === "legacy" && r.origin !== previous;
}

/**
 * The consent fields to write once `r` is agreed to: remoteConsent true and its origin added to
 * remoteConsentOrigins. Only the origin the notice just named is added (task #55): migrating a
 * legacy config records nothing else, so another host it once covered asks again. Nothing when no
 * origin is known or the user was not asked and holds no legacy consent.
 */
function consentPatch(r: Resolved, asked: boolean): Record<string, unknown> {
  if (!r.configuredRemote || !r.origin) return {};
  if (!asked && r.consentVia !== "legacy") return {};
  const list = withConsentedOrigin(personalConsent(), r.origin);
  return { remoteConsent: true, remoteConsentOrigins: list };
}

/**
 * The remote origin ~/.eminiar/config.json itself configures (task #55): parsed from that file's
 * own values, with no project layer and no env var, so EMINIAR_ADJUDICATOR_PROVIDER cannot make
 * a host the user never picked look like the one a legacy consent was given for. Undefined for a
 * local target, an unreadable file or an untrusted one (personalConfigTrusted).
 */
function personalOrigin(root: string): string | undefined {
  try {
    if (!personalConfigTrusted(root)) return undefined;
    const a = readRaw(paths().configFile).adjudicator;
    const parsed = AdjudicatorConfigSchema.safeParse(isObj(a) ? a : {});
    if (!parsed.success) return undefined;
    const r = resolveAdjudicator(parsed.data, { context: "cli", env: {} });
    return r.configuredRemote ? r.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Consent for a remote provider: the notice is always printed; --accept-remote or a y on a
 * TTY grants it; no TTY without --accept-remote refuses. Local providers need none.
 */
export async function ensureConsent(
  io: Io,
  r: Resolved,
  cfg: AdjudicatorConfig,
  o: { acceptRemote?: boolean } = {},
): Promise<boolean> {
  if (!r.configuredRemote) return true;
  io.out(remoteNotice(r, cfg));
  if (o.acceptRemote) {
    io.out("Consent given with --accept-remote.");
    return true;
  }
  if (!io.isTTY) {
    io.err(
      "No consent: without a terminal, pass --accept-remote to agree to send that text (--yes does not).",
    );
    return false;
  }
  return askNo(io, `Send that text to ${r.origin ?? hostOf(r.baseUrl)}?`);
}

/** Read a key from a hidden TTY prompt or from stdin; "" when none was given. */
async function readKey(io: Io, label: string, optional: boolean): Promise<string> {
  if (io.isTTY)
    return (
      await io.askHidden(
        `Paste your ${label} API key (input hidden${optional ? "; Enter to skip" : ""}): `,
      )
    ).trim();
  return ((await io.readStdin()).split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
}

function storeKey(io: Io, id: KeyId, key: string): void {
  setKey(id, key);
  io.out(`Saved the ${id} key to ${tilde(paths().adjudicatorKey)} (mode 0600): ${mask(key)}`);
}

const RECONNECT =
  "Hooks pick this up on the next prompt. Run /mcp reconnect (or restart Claude Code) to load the em_adjudicate tool.";

// --- install / onboarding ---------------------------------------------------------

export interface SetupOptions {
  /** `--adjudicator[=choice]`: true = heuristic. */
  choice?: string | true | undefined;
  yes?: boolean;
  acceptRemote?: boolean;
}

export interface SetupResult {
  enabled: boolean;
  provider?: ProviderId;
  preset?: PresetId;
  remote?: boolean;
  keyStored?: boolean;
}

/**
 * The install step (§18). With `--adjudicator[=x]` it enables that choice; otherwise an
 * interactive install asks "Use the adjudicator for tool, model and agent selection?" (default
 * No) and, on yes, which provider. `--yes` skips the question (answer No) and never grants
 * remote consent. Writes only ~/.eminiar/config.json and the 0600 key file.
 */
export async function setupAdjudicator(io: Io, o: SetupOptions): Promise<SetupResult> {
  const base = ConfigSchema.parse({}).adjudicator;
  let choice: Choice | undefined;
  if (o.choice !== undefined) {
    choice = o.choice === true ? { provider: "heuristic" } : parseChoice(o.choice);
    if (!choice) {
      io.err(`unknown --adjudicator value ${shown(o.choice)}; use ${CHOICES.join("|")}`);
      return { enabled: false };
    }
  } else {
    if (o.yes) {
      io.out("adjudicator: off (skipped under --yes; `eminiar adjudicator enable` turns it on)");
      return { enabled: false };
    }
    if (adjudicatorConfigured()) {
      io.out(
        "adjudicator: already configured in ~/.eminiar/config.json; `eminiar adjudicator status` shows it",
      );
      return { enabled: false };
    }
    io.out(
      "The adjudicator scores each request's complexity and suggests the eminiar tool, Claude model size and swarm agent role for it. It is off by default; the built-in heuristic runs only on this machine.",
    );
    if (!(await askNo(io, "Use the adjudicator for tool, model and agent selection?"))) {
      io.out("adjudicator: off (`eminiar adjudicator enable` turns it on later)");
      return { enabled: false };
    }
    choice = await pickProvider(io);
  }

  if (personalFileUntrusted(io, process.cwd())) return { enabled: false };
  let patch: Record<string, unknown> = { enabled: true, ...choicePatch(choice, base) };
  let r = resolveAdjudicator(candidate(base, patch), { context: "cli", env: io.env });
  if (r.configuredRemote) {
    if (await ensureConsent(io, r, base, { acceptRemote: !!o.acceptRemote })) {
      patch = { ...patch, ...consentPatch(r, true) };
    } else {
      io.out(
        `Kept everything on this machine: using the heuristic. Switch later with \`eminiar adjudicator enable --provider ${choice.preset ?? choice.provider}\`.`,
      );
      patch = { enabled: true, provider: "heuristic" };
      choice = { provider: "heuristic" };
      r = resolveAdjudicator(candidate(base, patch), { context: "cli", env: io.env });
    }
  }
  writeAdjudicatorPatch(paths().configFile, patch);
  const result: SetupResult = {
    enabled: true,
    provider: choice.provider,
    remote: r.configuredRemote,
  };
  if (choice.preset) result.preset = choice.preset;
  io.out(
    `adjudicator: on · provider ${providerLabel(r)} · written to ${tilde(paths().configFile)}`,
  );

  const need = keyNeed(r);
  if (need) {
    // keyFor: a loopback target never takes a key from the environment, so none is reported.
    const have = keyFor(r, io.env) ?? {
      source: "none" as const,
      key: undefined,
      envName: undefined,
    };
    if (have.source === "env") io.out(`Using the key in $${have.envName} (${mask(have.key)}).`);
    else if (have.source === "file")
      io.out(`A ${need.id} key is already stored (${mask(have.key)}).`);
    else if (io.isTTY) {
      const key = await readKey(io, need.label, true);
      if (key) {
        storeKey(io, need.id, key);
        result.keyStored = true;
      } else
        io.out(
          `No key yet: run \`eminiar adjudicator key set ${keyArg(need.id)}\`; until then the heuristic runs.`,
        );
    } else
      io.out(
        `No key yet: run \`eminiar adjudicator key set ${keyArg(need.id)}\` (hidden prompt or stdin); until then the heuristic runs.`,
      );
  }
  if (choice.provider === "embedding")
    io.out(
      "The embedding provider uses the local embedding model (no network); `--no-model` installs fetch it on first use.",
    );
  return result;
}

const keyArg = (id: KeyId) => (id.startsWith("openai:") ? id.slice(7) : id);

async function pickProvider(io: Io): Promise<Choice> {
  for (const line of [
    "Which provider scores requests?",
    "  1) heuristic  built-in rules; offline, nothing leaves this machine (default)",
    "  2) embedding  nearest examples with the local embedding model; offline",
    "  3) Jev        TypeSafe's hosted model (api.typesafe.ai); sends prompt text off this machine; needs an API key",
    "  4) OpenAI-compatible: a local server (Ollama, LM Studio, llama.cpp) or a hosted one (Groq, Cerebras)",
  ])
    io.out(line);
  const a = (await io.ask("Choice [1]: ")).trim().toLowerCase();
  if (a === "2" || a === "embedding") return { provider: "embedding" };
  if (a === "3" || a === "jev" || a === "typesafe") return { provider: "typesafe" };
  if (a === "4" || a.startsWith("openai")) {
    for (const line of [
      "Which OpenAI-compatible server?",
      "  1) Ollama     localhost:11434, on this machine (default)",
      "  2) LM Studio  localhost:1234, on this machine",
      "  3) llama.cpp  localhost:8080, on this machine",
      "  4) Groq       hosted; sends prompt text off this machine; needs an API key",
      "  5) Cerebras   hosted; sends prompt text off this machine; needs an API key",
    ])
      io.out(line);
    const p = (await io.ask("Choice [1]: ")).trim().toLowerCase();
    const map: Record<string, PresetId> = {
      "2": "lmstudio",
      "3": "llamacpp",
      "4": "groq",
      "5": "cerebras",
    };
    const preset =
      map[p] ??
      ((PRESET_IDS as string[]).includes(p) && p !== "custom" ? (p as PresetId) : "ollama");
    return { provider: "openai-compatible", preset };
  }
  const direct = parseChoice(a);
  return direct && a !== "1" ? direct : { provider: "heuristic" };
}

// --- local server detection -----------------------------------------------------------

export const LOCAL_PORTS: ReadonlyArray<{ port: number; preset: PresetId }> = [
  { port: 11434, preset: "ollama" },
  { port: 1234, preset: "lmstudio" },
  { port: 8080, preset: "llamacpp" },
];

function portOpen(port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const end = (v: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => end(false), ms);
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

/** The local OpenAI-compatible servers listening on their default ports. */
export async function detectLocal(
  connectMs: number,
  probe: (port: number, ms: number) => Promise<boolean> = portOpen,
): Promise<PresetId[]> {
  const open = await Promise.all(LOCAL_PORTS.map((p) => probe(p.port, connectMs)));
  return LOCAL_PORTS.filter((_, i) => open[i]).map((p) => p.preset);
}

// --- status -------------------------------------------------------------------------

export interface StatusReport {
  enabled: boolean;
  enabledBy: string;
  configured: ProviderId;
  configuredLabel: string;
  effective: ProviderId;
  degraded: string | null;
  detail: string | null;
  mode: string;
  surfaces: string[];
  remote: boolean;
  host: string | null;
  /** scheme://host[:port] that consent must cover; null for local providers. */
  origin: string | null;
  /** Consent covers `origin` (always false for a local provider, which needs none). */
  consent: boolean;
  /** How consent was given: config (an origin you agreed to) or legacy (remoteConsent true, no origin list). Env vars never grant it. */
  consentVia: string | null;
  /** The origins ~/.eminiar/config.json records consent for. */
  consentedOrigins: string[];
  /** projectAdjudicatorWarning(): adjudicator keys the project file sets that are ignored. */
  projectIgnored: string | null;
  key: {
    id: string | null;
    source: string;
    masked: string;
    refused: boolean;
    file: { path: string; exists: boolean; mode: string | null; secure: boolean };
  };
  breaker: {
    state: string | null;
    failures: number;
    retryAt: number | null;
    lastErrorClass: string | null;
    p95Ms: number | null;
    budgetMs: number;
    callsToday: number;
    spendTodayUsd: number;
  } | null;
  last24h: {
    total: number;
    bySource: Record<string, number>;
    fallbackRate: number | null;
    p95Ms: number | null;
    providerP95Ms: number | null;
  } | null;
  apply: { checked: number; ineffective: number } | null;
  modelForced: boolean;
  /**
   * Apply mode only (null otherwise): the swarms whose every role pins a model without a range,
   * so apply mode cannot change any of their workers (pinnedSwarms).
   */
  pinnedSwarms: string[] | null;
  /**
   * Jev request capture (adjudicator.privacy.captureExchanges, a personal setting). `stored` is
   * null when the project database could not be read.
   */
  capture?: CaptureStatus;
}

export interface CaptureStatus {
  /** The effective setting: the personal file's value unless EMINIAR_ADJUDICATOR_CAPTURE=0 forces it off. */
  on: boolean;
  /** EMINIAR_ADJUDICATOR_CAPTURE=0 is set, so capture is off whatever the personal file says. */
  forcedOff: boolean;
  /** What ~/.eminiar/config.json itself says. */
  personal: boolean;
  keep: number;
  stored: number | null;
  newestTs: number | null;
}

export interface CliDeps {
  io?: Partial<Io>;
  db?: StorageAdapter;
  /** Test seam: the provider `test` and `eval` use (null forces none). */
  provider?: AdjudicatorProvider | null;
  /** Provider deps (fetch) for test/probe. */
  providerDeps?: ProviderDeps;
  /** Test seam for `provider --detect`. */
  portProbe?: (port: number, ms: number) => Promise<boolean>;
}

async function storage(ctx: ProjectContext, deps: CliDeps): Promise<StorageAdapter> {
  if (deps.db) return deps.db;
  return getStorage(ctx, { vectors: false });
}

/** CLAUDE_CODE_SUBAGENT_MODEL_FORCE with Claude Code's on/off rule, as the hook reads it. */
const forced = (env: NodeJS.ProcessEnv) => subagentModelForced(env);

/**
 * The opted-in swarms whose every role keeps a plain model pin (resolveAgentPin status pinned:
 * no model_range, or a ranged agent file edited by hand), read like em_swarm plan's all-pinned
 * nudge (swarm.ts ALL_PINNED_NOTE). Apply mode respects those pins, so it cannot change the model
 * of any of their workers (it still sets their effort). [] with apply.respectFrontmatter off, under FORCE (warned about on its own) and
 * without swarms. Read-only; never throws.
 */
export function pinnedSwarms(root: string, config: Config, env: NodeJS.ProcessEnv): string[] {
  if (!config.adjudicator.apply.respectFrontmatter || forced(env)) return [];
  const swarms = safe(() => activeSwarmConfig(root))?.swarms ?? [];
  return swarms
    .filter(
      (s) =>
        s.roles.length > 0 &&
        s.roles.every(
          (r) => resolveAgentPin(r.agentType, { root, cwd: root, env }).status === "pinned",
        ),
    )
    .map((s) => s.name);
}

/** The status warning and doctor detail for pinnedSwarms. */
export function pinnedSwarmsNote(names: readonly string[]): string {
  const which = `${names.length === 1 ? "swarm" : "swarms"} ${names.map((n) => `"${n}"`).join(", ")}`;
  return `every role of ${which} pins a model, so apply mode cannot change any worker's model (add model_range in swarm.yaml, then \`eminiar swarm sync\`)`;
}

export async function statusReport(
  ctx: ProjectContext,
  config: Config,
  io: Io,
  deps: CliDeps,
): Promise<StatusReport> {
  const a = config.adjudicator;
  const r0 = resolveAdjudicator(config, { context: "cli", env: io.env });
  let db: StorageAdapter | undefined;
  try {
    db = await storage(ctx, deps);
  } catch {
    db = undefined;
  }
  const state =
    r0.configured !== "heuristic" ? db?.adjudicator.providerState(r0.configured) : undefined;
  const r: ResolvedWithLockout = withAuthLockout(r0, state, { now: io.now(), env: io.env });
  const need = keyNeed(r0);
  const kf = keyFileStatus();
  const { breaker, last24h, apply } = await healthOf(db, r0, a, state, io.now());
  return {
    enabled: a.enabled,
    enabledBy: enabledSource(ctx.root, io.env),
    configured: r.configured,
    configuredLabel: providerLabel(r),
    effective: r.provider,
    degraded: r.degraded ?? null,
    detail: r.detail ?? null,
    mode: a.mode,
    surfaces: Object.entries(a.surfaces)
      .filter(([, on]) => on)
      .map(([s]) => s),
    remote: r0.configuredRemote,
    host: r0.configuredRemote ? hostOf(r0.baseUrl) : null,
    origin: r0.configuredRemote ? (r0.origin ?? null) : null,
    consent: r0.configuredRemote && r0.consent,
    consentVia: r0.consentVia ?? null,
    consentedOrigins: consentedOrigins(a),
    projectIgnored: safe(() => projectAdjudicatorWarning(ctx.root)) ?? null,
    key: {
      id: need?.id ?? null,
      source: need ? r0.keySource : "n/a",
      masked: need ? r0.keyMasked : "none",
      refused: !!r0.keyFileRefused,
      file: {
        path: kf.path,
        exists: kf.exists,
        mode: kf.mode !== undefined ? `0${kf.mode.toString(8)}` : null,
        secure: kf.secure,
      },
    },
    breaker,
    last24h,
    apply,
    modelForced: forced(io.env),
    pinnedSwarms: a.mode === "apply" ? pinnedSwarms(ctx.root, config, io.env) : null,
    capture: captureStatus(a, db, io.env),
  };
}

// --- Jev request capture (adjudicator.privacy.captureExchanges) -----------------------

/** What ~/.eminiar/config.json says about capture, ignoring the env var and the project file. */
function personalCapture(): boolean {
  try {
    const a = readRaw(paths().configFile).adjudicator;
    return isObj(a) && isObj(a.privacy) && a.privacy.captureExchanges === true;
  } catch {
    return false;
  }
}

function captureStatus(
  a: AdjudicatorConfig,
  db: StorageAdapter | undefined,
  env: NodeJS.ProcessEnv,
): CaptureStatus {
  let stored: number | null = null;
  let newestTs: number | null = null;
  try {
    if (db) {
      stored = db.adjudicator.exchangeCount();
      newestTs = db.adjudicator.exchangeList({ limit: 1 }).rows[0]?.ts ?? null;
    }
  } catch {
    stored = null;
  }
  return {
    on: a.privacy.captureExchanges === true,
    forcedOff: env.EMINIAR_ADJUDICATOR_CAPTURE === "0",
    personal: personalCapture(),
    keep: EXCHANGE_KEEP,
    stored,
    newestTs,
  };
}

/** The one-line form shared by `status` and the doctor. */
function captureLine(c: CaptureStatus): string {
  const n = c.stored === null ? "" : ` · ${c.stored} stored (newest ${c.keep} kept)`;
  if (c.forcedOff)
    return `jev request capture: off, forced by EMINIAR_ADJUDICATOR_CAPTURE=0${c.personal ? " (the personal setting is on)" : ""}${n}`;
  return `jev request capture: ${c.on ? "on" : "off"}${n}`;
}

async function healthOf(
  db: StorageAdapter | undefined,
  r: Resolved,
  a: AdjudicatorConfig,
  state: ReturnType<StorageAdapter["adjudicator"]["providerState"]>,
  now: number,
): Promise<Pick<StatusReport, "breaker" | "last24h" | "apply">> {
  const breaker =
    r.configured === "heuristic"
      ? null
      : {
          state: state?.state ?? null,
          failures: state?.failures ?? 0,
          retryAt: state?.retryAt ?? null,
          lastErrorClass: state?.lastErrorClass ?? null,
          p95Ms: state ? (p95(state.latencies) ?? null) : null,
          budgetMs: surfaceBudget(a, "prompt", !r.configuredRemote),
          callsToday: callsToday(state, now),
          spendTodayUsd: spendToday(state, now),
        };
  if (!db) return { breaker, last24h: null, apply: null };
  let s: ReturnType<StorageAdapter["adjudicator"]["summary"]>;
  try {
    s = db.adjudicator.summary(now - 86_400_000);
  } catch {
    return { breaker, last24h: null, apply: null };
  }
  return {
    breaker,
    last24h: {
      total: s.total,
      bySource: s.bySource,
      fallbackRate: s.total ? (s.bySource.fallback ?? 0) / s.total : null,
      p95Ms: s.latency.p95,
      providerP95Ms: s.providerLatency.p95,
    },
    apply: s.applyChecked ? { checked: s.applyChecked, ineffective: s.applyIneffective } : null,
  };
}

const ms = (n: number | null | undefined) => (typeof n === "number" ? `${Math.round(n)} ms` : "–");
const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "unknown" : `$${n < 0.01 && n > 0 ? n.toFixed(5) : n.toFixed(2)}`;
const counts = (o: Record<string, number>) =>
  Object.entries(o)
    .sort((x, y) => y[1] - x[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "–";

export function formatStatus(s: StatusReport): string {
  const lines = [
    `adjudicator: ${s.enabled ? "on" : "off"} (${s.enabledBy}) · mode ${s.mode} · surfaces ${s.surfaces.join(", ") || "none"}`,
    s.effective === s.configured
      ? `provider: ${s.configuredLabel}`
      : `provider: ${s.configuredLabel} configured → ${s.effective} runs (${s.degraded}: ${s.detail})`,
  ];
  if (s.remote)
    lines.push(
      `remote: sends redacted prompt text to ${s.origin ?? s.host} · consent ${
        s.consent
          ? `given${s.consentVia === "legacy" ? " (recorded before consent named a host; the next provider change asks again)" : ""}`
          : `NOT given for this origin${s.consentedOrigins.length ? ` (given for ${s.consentedOrigins.join(", ")})` : ""}`
      }`,
    );
  else lines.push("remote: no, nothing leaves this machine");
  if (s.projectIgnored) lines.push(`warning: ${s.projectIgnored}`);
  if (s.key.id)
    lines.push(
      `key ${s.key.id}: ${s.key.source === "none" ? "none" : `${s.key.source} ${s.key.masked}`}${
        s.key.refused ? " · key file ignored (not 0600: chmod 600 it)" : ""
      }`,
    );
  if (s.key.file.exists)
    lines.push(
      `key file: ${tilde(s.key.file.path)} ${s.key.file.mode ?? ""}${s.key.file.secure ? "" : " (readable by others: chmod 600)"}`,
    );
  if (s.breaker)
    lines.push(
      `breaker: ${s.breaker.state ?? "never called"}${s.breaker.failures ? ` · ${s.breaker.failures} failure(s)` : ""}${
        s.breaker.lastErrorClass ? ` · last error ${s.breaker.lastErrorClass}` : ""
      } · p95 ${ms(s.breaker.p95Ms)} (prompt budget ${ms(s.breaker.budgetMs)}) · today ${s.breaker.callsToday} call(s), ${usd(s.breaker.spendTodayUsd)}`,
    );
  if (s.last24h)
    lines.push(
      s.last24h.total
        ? `last 24 h: ${s.last24h.total} decision(s) · ${counts(s.last24h.bySource)} · fallback ${pct(s.last24h.fallbackRate)} · p95 ${ms(s.last24h.p95Ms)} · provider p95 ${ms(s.last24h.providerP95Ms)}`
        : "last 24 h: no decisions",
    );
  if (s.apply)
    lines.push(
      `apply: ${s.apply.checked - s.apply.ineffective} of ${s.apply.checked} applied dispatches ran the chosen model`,
    );
  if (s.capture && (s.capture.on || s.capture.forcedOff || s.configured === "typesafe"))
    lines.push(captureLine(s.capture));
  if (s.mode === "apply" && s.modelForced)
    lines.push(
      "warning: CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, so Claude Code ignores the applied `model`",
    );
  if (s.mode === "apply" && s.pinnedSwarms?.length)
    lines.push(`warning: ${pinnedSwarmsNote(s.pinnedSwarms)}`);
  if (!s.enabled) lines.push("turn it on with `eminiar adjudicator enable`");
  return lines.join("\n");
}

// --- doctor -------------------------------------------------------------------------

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The cheap adjudicator checks (§18): no network. Invalid config, a configured provider that
 * cannot run, an insecure key file and a forced subagent model in apply mode fail; the rest is
 * information. One line when the adjudicator is off.
 */
export function adjudicatorDoctorChecks(
  config: Config,
  o: {
    root: string;
    db?: StorageAdapter | undefined;
    env?: NodeJS.ProcessEnv;
    now?: number;
    surfaceBudgetMs?: number;
    p95?: (values: readonly number[]) => number | undefined;
  },
): DoctorCheck[] {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now();
  const checks: DoctorCheck[] = [];
  const invalid: string[] = [];
  for (const [label, file] of [
    ["~/.eminiar/config.json", paths().configFile],
    ["eminiar.config.json", projectFile(o.root)],
  ] as const) {
    try {
      const raw = readRaw(file).adjudicator;
      if (raw === undefined) continue;
      const p = AdjudicatorConfigSchema.safeParse(raw);
      if (!p.success)
        invalid.push(
          `${label}: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
    } catch (err) {
      invalid.push(`${label}: ${(err as Error).message}`);
    }
  }
  const a = config.adjudicator;
  if (invalid.length)
    checks.push({ name: "adjudicator config", ok: false, detail: invalid.join(" · ") });
  // Security advice works with the adjudicator off, so its lines come before that early return.
  checks.push(...securityDoctorChecks(config, { root: o.root, db: o.db, env }));
  // Information, not a failure: the keys are dropped, so nothing unsafe happens. Shown while the
  // adjudicator is off too, since a later `enable` would otherwise look like it uses them.
  const ignored = safe(() => projectAdjudicatorWarning(o.root));
  if (ignored) checks.push({ name: "adjudicator project config", ok: true, detail: ignored });
  if (!a.enabled) {
    if (!invalid.length)
      checks.push({
        name: "adjudicator",
        ok: true,
        detail: "off (opt-in: `eminiar adjudicator enable`)",
      });
    return checks;
  }
  const r0 = resolveAdjudicator(config, { context: "server", env });
  const state =
    r0.configured !== "heuristic"
      ? safe(() => o.db?.adjudicator.providerState(r0.configured))
      : undefined;
  const r = withAuthLockout(r0, state, { now, env });
  checks.push({
    name: "adjudicator",
    ok: r.provider === r.configured,
    detail:
      r.provider === r.configured
        ? `on · ${providerLabel(r)} · mode ${a.mode}${r0.configuredRemote ? ` · remote ${hostOf(r0.baseUrl)}` : " · local"}`
        : `on · ${providerLabel(r)} configured but the heuristic runs: ${r.detail ?? r.degraded}`,
  });
  const need = keyNeed(r0);
  const kf = keyFileStatus();
  if (need || kf.exists)
    checks.push({
      name: "adjudicator key",
      ok: kf.secure && (!need || r0.keySource !== "none"),
      detail: [
        need
          ? `${need.id}: ${r0.keySource === "none" ? "missing (`eminiar adjudicator key set`)" : `${r0.keySource} ${r0.keyMasked}`}`
          : "",
        kf.exists
          ? `key file ${kf.mode !== undefined ? `0${kf.mode.toString(8)}` : ""}${kf.secure ? "" : " readable by others: chmod 600 ~/.eminiar/adjudicator.key"}`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  if (r0.configuredRemote)
    checks.push({
      name: "adjudicator consent",
      ok: r0.consent,
      detail: r0.consent
        ? `given: redacted prompt text goes to ${r0.origin ?? hostOf(r0.baseUrl)}`
        : `not given for ${r0.origin ?? hostOf(r0.baseUrl)}: \`eminiar adjudicator enable --accept-remote\``,
    });
  if (r0.configured !== "heuristic") {
    const lat = state?.latencies ?? [];
    const p = o.p95?.(lat);
    const budget =
      o.surfaceBudgetMs ?? (r0.configuredRemote ? a.timeouts.promptMs : a.timeouts.localMs);
    checks.push({
      name: "adjudicator breaker",
      ok: true,
      detail: `${state?.state ?? "never called"}${state?.lastErrorClass ? ` · last error ${state.lastErrorClass}` : ""}${
        p !== undefined
          ? ` · p95 ${Math.round(p)} ms vs budget ${budget} ms${p > budget ? " (slow: raise timeouts or pick a faster provider)" : ""}`
          : ""
      }`,
    });
  }
  const s = safe(() => o.db?.adjudicator.summary(now - 86_400_000));
  if (s)
    checks.push({
      name: "adjudicator 24 h",
      ok: true,
      detail: s.total
        ? `${s.total} decision(s) · fallback ${pct((s.bySource.fallback ?? 0) / s.total)} · p95 ${ms(s.latency.p95)}${
            s.applyChecked
              ? ` · apply effective ${s.applyChecked - s.applyIneffective} of ${s.applyChecked}`
              : ""
          }`
        : "no decisions yet",
    });
  // Information, not a failure. Shown when capture is on or forced off, or when Jev is the provider.
  if (
    a.privacy.captureExchanges ||
    env.EMINIAR_ADJUDICATOR_CAPTURE === "0" ||
    r0.configured === "typesafe"
  )
    checks.push({
      name: "adjudicator jev capture",
      ok: true,
      detail: captureLine(
        captureStatus(
          a,
          safe(() => o.db),
          env,
        ),
      ).replace(/^jev request capture: /, ""),
    });
  if (a.mode === "apply" && forced(env))
    checks.push({
      name: "adjudicator apply",
      ok: false,
      detail:
        "CLAUDE_CODE_SUBAGENT_MODEL_FORCE is on, so Claude Code ignores the `model` apply mode sets; unset it or use mode advise",
    });
  // Information, not a failure: the pins are respected by design (apply.respectFrontmatter).
  const pinned = a.mode === "apply" ? pinnedSwarms(o.root, config, env) : [];
  if (pinned.length)
    checks.push({ name: "adjudicator swarm pins", ok: true, detail: pinnedSwarmsNote(pinned) });
  if (r0.configured === "embedding") {
    let cached = false;
    try {
      cached = readdirSync(paths().models).some((f) => /^adjudicator-exemplars-.*\.json$/.test(f));
    } catch {
      cached = false;
    }
    checks.push({
      name: "adjudicator embedding",
      ok: config.embeddings.enabled,
      detail: !config.embeddings.enabled
        ? "embeddings are disabled, so the embedding provider cannot run"
        : cached
          ? "exemplar vectors cached"
          : "exemplar vectors not cached yet (built on first use; `eminiar adjudicator test` warms them)",
    });
  }
  return checks;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** fullDoctor's live probe (2 s): the configured provider's /models, or local port detection. */
export async function adjudicatorLiveChecks(
  config: Config,
  o: { env?: NodeJS.ProcessEnv; deps?: CliDeps } = {},
): Promise<DoctorCheck[]> {
  const a = config.adjudicator;
  if (!a.enabled) return [];
  const env = o.env ?? process.env;
  const r = resolveAdjudicator(config, { context: "cli", env });
  if (r.configured === "heuristic" || r.configured === "embedding") {
    if (r.configured === "embedding") return [];
    const found = await detectLocal(Math.max(a.timeouts.connectMs, 150), o.deps?.portProbe);
    return [
      {
        name: "adjudicator local servers",
        ok: true,
        detail: found.length
          ? `${found.join(", ")} listening; \`eminiar adjudicator provider openai-compatible --preset ${found[0]}\` would use it`
          : "none on 11434/1234/8080 (the heuristic needs none)",
      },
    ];
  }
  if (r.provider === "heuristic") return [];
  const p = await providerFor(r, config, o.deps ?? {}, env);
  if (!p) return [];
  try {
    const res = await p.probe({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return [
      {
        name: "adjudicator probe",
        ok: res.ok,
        detail: `${providerLabel(r)}: ${res.detail} (${Math.round(res.latencyMs)} ms)`,
      },
    ];
  } catch (err) {
    return [{ name: "adjudicator probe", ok: false, detail: (err as Error).message }];
  }
}

async function providerFor(
  r: Resolved,
  config: Config,
  deps: CliDeps,
  env: NodeJS.ProcessEnv,
): Promise<AdjudicatorProvider | null> {
  if (deps.provider !== undefined) return deps.provider;
  if (r.provider === "embedding" && !hasProvider("embedding")) {
    registerProvider("embedding", defaultEmbeddingFactory(config));
  }
  return createProvider(r, config.adjudicator, { env, ...(deps.providerDeps ?? {}) });
}

// --- the command --------------------------------------------------------------------

export const ADJUDICATOR_USAGE = `eminiar adjudicator <command>   (opt-in; off by default)
  status [--json]                     On/off, configured vs effective provider, key, consent, health
  enable [--provider P] [--preset X] [--mode advise|apply] [--project] [--accept-remote]
                                      Turn it on (~/.eminiar/config.json; --project writes only
                                      adjudicator.enabled into eminiar.config.json)
  disable [--project]                 Turn it off
  provider <heuristic|embedding|typesafe|openai-compatible> [--preset X] [--base-url U] [--model M]
  provider --detect                   Look for Ollama / LM Studio / llama.cpp on this machine
  key set [provider] [--from-env NAME]   Store a key (hidden prompt or stdin; never argv) in the
                                      0600 key file, or the NAME of the env var holding it
  key clear [provider]                Remove a stored key
  key status [--json]                 Show where each key comes from (masked)
  test "<text>" [--provider P] [--json]  Probe the provider and score one sample, side by side
  eval [--provider P ...] [--providers a,b] [--fixture f.json|.js|.mjs] [--replace] [--repeat N]
       [--save] [--json]              Compare providers against the heuristic on labelled requests
  stats [--since 7d] [--json] [--reset-learning]
  exchanges [status] [--json]         Whether Jev request capture is on, and how many requests are stored here
  exchanges on [--yes]                Keep each request sent to Jev (redacted prompt text) and its
                                      answer in this project's database; asks y/N, personal setting only
  exchanges off                       Turn it off and delete this project's captured requests
  exchanges purge [--yes]             Delete this project's captured requests, leave the setting
  security <status|on|off|test|explain|list|eval>   Opt-in security advice (nothing is ever
                                      blocked); \`security help\` lists its options
Providers: heuristic (offline) · embedding (local model) · typesafe = Jev (api.typesafe.ai)
  · openai-compatible presets ${PRESET_IDS.join(", ")}`;

export async function adjudicatorCommand(
  args: string[],
  ctx: ProjectContext,
  deps: CliDeps = {},
): Promise<number> {
  const io: Io = { ...defaultIo(), ...deps.io };
  // `security` has its own flags (docs/design/adjudicator-security.md §12).
  if (args[0] === "security")
    return securityCommand(args.slice(1), {
      root: ctx.root,
      io,
      load: () => loadConfig(ctx.root),
      db: () => storage(ctx, deps),
      writePersonal: (patch) => writeAdjudicatorPatch(paths().configFile, patch),
      personalUntrusted: () => personalFileUntrusted(io, ctx.root),
      provider: deps.provider,
      providerDeps: deps.providerDeps,
    });
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      provider: { type: "string", multiple: true },
      providers: { type: "string" },
      preset: { type: "string" },
      mode: { type: "string" },
      project: { type: "boolean" },
      "accept-remote": { type: "boolean" },
      "base-url": { type: "string" },
      model: { type: "string" },
      detect: { type: "boolean" },
      "from-env": { type: "string" },
      fixture: { type: "string" },
      replace: { type: "boolean" },
      repeat: { type: "string" },
      save: { type: "boolean" },
      since: { type: "string" },
      "reset-learning": { type: "boolean" },
      yes: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  const [sub = "status", ...rest] = positionals;
  const argProblem = argvKeyProblem(values);
  if (argProblem) {
    io.err(argProblem);
    return 2;
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const providerFlag = (values.provider as string[] | undefined)?.filter(Boolean) ?? [];
  const load = () => loadConfig(ctx.root);

  switch (sub) {
    case "status": {
      const s = await statusReport(ctx, load(), io, deps);
      io.out(values.json ? JSON.stringify(s, null, 2) : formatStatus(s));
      return 0;
    }

    case "enable": {
      const current = load().adjudicator;
      const patch: Record<string, unknown> = { enabled: true };
      const given = providerFlag[0] ?? str(values.preset);
      if ((!values.project || given || str(values.mode)) && personalFileUntrusted(io, ctx.root))
        return 1;
      if (given) {
        const c = parseChoice(given);
        if (!c) {
          io.err(`unknown provider ${shown(given)}; use ${CHOICES.join("|")}`);
          return 2;
        }
        if (str(values.preset) && c.provider === "openai-compatible" && !c.preset) {
          const pc = parseChoice(str(values.preset));
          if (!pc?.preset) {
            io.err(`unknown preset ${shown(values.preset)}; use ${PRESET_IDS.join("|")}`);
            return 2;
          }
          c.preset = pc.preset;
        }
        Object.assign(patch, choicePatch(c, current));
      }
      const mode = str(values.mode);
      if (mode) {
        if (!(MODES as readonly string[]).includes(mode)) {
          io.err(`unknown mode ${shown(mode)}; use ${MODES.join("|")}`);
          return 2;
        }
        patch.mode = mode;
      }
      const next = candidate(current, patch);
      const r = resolveAdjudicator(next, { context: "cli", env: io.env });
      const previous = personalOrigin(ctx.root);
      const ask = mustAsk(r, previous);
      if (ask) {
        if (!(await ensureConsent(io, r, next, { acceptRemote: !!values["accept-remote"] }))) {
          io.err("Not enabled: no consent to send text off this machine. Nothing was changed.");
          return 1;
        }
      } else if (r.configuredRemote) io.out(remoteNotice(r, next));
      Object.assign(patch, consentPatch(r, ask));
      if (values.project) {
        writeAdjudicatorPatch(projectFile(ctx.root), { enabled: true });
        io.out(`Wrote adjudicator.enabled: true to ${projectFile(ctx.root)} (commit it to share).`);
        const { enabled: _e, ...personal } = patch;
        if (Object.keys(personal).length) writeAdjudicatorPatch(paths().configFile, personal);
      } else writeAdjudicatorPatch(paths().configFile, patch);
      const after = load();
      const ra = resolveAdjudicator(after, { context: "cli", env: io.env });
      io.out(
        `Adjudicator ${after.adjudicator.enabled ? "on" : "still off"} · ${providerLabel(ra)} · mode ${after.adjudicator.mode}${
          ra.provider !== ra.configured ? ` · the heuristic runs until: ${ra.detail}` : ""
        }`,
      );
      if (!after.adjudicator.enabled) io.out(`(${enabledSource(ctx.root, io.env)} keeps it off)`);
      const need = keyNeed(ra);
      if (
        need &&
        ra.keySource === "none" &&
        personalConfigTrusted(ctx.root, paths().adjudicatorKey)
      ) {
        if (io.isTTY) {
          const key = await readKey(io, need.label, true);
          if (key) storeKey(io, need.id, key);
          else io.out(`No key yet: \`eminiar adjudicator key set ${keyArg(need.id)}\`.`);
        } else io.out(`No key yet: \`eminiar adjudicator key set ${keyArg(need.id)}\`.`);
      }
      io.out(RECONNECT);
      return 0;
    }

    case "disable": {
      const file = values.project ? projectFile(ctx.root) : paths().configFile;
      writeAdjudicatorPatch(file, { enabled: false });
      const after = load();
      io.out(
        `Adjudicator ${after.adjudicator.enabled ? `still on (${enabledSource(ctx.root, io.env)} turns it on)` : "off"}; wrote ${tilde(file)}. Stored keys and consent are kept (\`eminiar adjudicator key clear\` removes keys).`,
      );
      io.out("Run /mcp reconnect to drop the em_adjudicate tool.");
      return 0;
    }

    case "provider": {
      const config = load();
      if (values.detect) {
        const found = await detectLocal(config.adjudicator.timeouts.connectMs, deps.portProbe);
        if (!found.length) {
          io.out("No local server on 11434 (Ollama), 1234 (LM Studio) or 8080 (llama.cpp).");
          io.out(
            "The heuristic needs none; `eminiar adjudicator provider embedding` is the other offline choice.",
          );
          return 0;
        }
        io.out(`Found: ${found.map((p) => `${p} (${PRESETS[p].baseUrl})`).join(", ")}`);
        io.out(
          `Suggestion: eminiar adjudicator provider openai-compatible --preset ${found[0]}   (nothing was changed)`,
        );
        return 0;
      }
      const id = rest[0] ?? providerFlag[0];
      if (!id) {
        const r = resolveAdjudicator(config, { context: "cli", env: io.env });
        io.out(
          `provider: ${providerLabel(r)}${r.provider !== r.configured ? ` (heuristic runs: ${r.detail})` : ""}`,
        );
        return 0;
      }
      const c = parseChoice(id);
      if (!c) {
        io.err(
          `unknown provider ${shown(id)}; use ${PROVIDER_IDS.join("|")} (or a preset: ${PRESET_IDS.join(", ")})`,
        );
        return 2;
      }
      const preset = str(values.preset);
      if (preset) {
        const pc = parseChoice(preset);
        if (c.provider !== "openai-compatible" || !pc?.preset) {
          io.err(`--preset applies to openai-compatible: ${PRESET_IDS.join("|")}`);
          return 2;
        }
        c.preset = pc.preset;
      }
      if (personalFileUntrusted(io, ctx.root)) return 1;
      const patch = choicePatch(c, config.adjudicator);
      const baseUrl = str(values["base-url"]);
      const model = str(values.model);
      if (baseUrl || model) {
        if (c.provider === "openai-compatible")
          patch.openai = {
            ...(isObj(patch.openai) ? patch.openai : {}),
            ...(baseUrl ? { baseUrl } : {}),
            ...(model ? { model } : {}),
          };
        else if (c.provider === "typesafe")
          patch.typesafe = { ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) };
      }
      const next = candidate(config.adjudicator, patch);
      const r = resolveAdjudicator(next, { context: "cli", env: io.env });
      // Consent is bound to the origin: a new host (another preset, --base-url) asks again.
      const previous = personalOrigin(ctx.root);
      const ask = mustAsk(r, previous);
      if (ask) {
        if (!(await ensureConsent(io, r, next, { acceptRemote: !!values["accept-remote"] }))) {
          io.err("Provider not changed: no consent to send text off this machine.");
          return 1;
        }
      } else if (r.configuredRemote) io.out(remoteNotice(r, next));
      Object.assign(patch, consentPatch(r, ask));
      writeAdjudicatorPatch(paths().configFile, patch);
      const ra = resolveAdjudicator(load(), { context: "cli", env: io.env });
      io.out(
        `provider: ${providerLabel(ra)}${ra.baseUrl ? ` (${ra.baseUrl}${ra.model ? `, ${ra.model}` : ""})` : ""}${
          ra.provider !== ra.configured ? ` · the heuristic runs until: ${ra.detail}` : ""
        }`,
      );
      if (!load().adjudicator.enabled)
        io.out("The adjudicator is off: `eminiar adjudicator enable`.");
      return 0;
    }

    case "key":
      return keyCommand(rest, values, io, load, ctx.root);

    case "test":
      return testCommand(rest.join(" "), providerFlag[0], !!values.json, load(), io, deps);

    case "eval": {
      const ids = [
        ...providerFlag,
        ...(str(values.providers)
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? []),
      ];
      return evalCommand(
        {
          ids,
          fixture: str(values.fixture),
          replace: !!values.replace,
          repeat: str(values.repeat),
          save: !!values.save,
          json: !!values.json,
        },
        ctx,
        load(),
        io,
        deps,
      );
    }

    case "stats": {
      const config = load();
      let since: number | undefined;
      try {
        since = parseSince(str(values.since), io.now());
      } catch {
        // A fixed message: the value is never echoed (task #57).
        io.err(
          "invalid --since: use an ISO date (2026-10-01) or a relative value like 30d, 12h, 2w",
        );
        return 2;
      }
      const db = await storage(ctx, deps);
      if (values["reset-learning"]) {
        const n = db.adjudicator.biasReset();
        io.out(`Learned bias reset: ${n} bucket(s) cleared.`);
      }
      if (values.json) {
        try {
          reconcile(db, { config, limit: 500 });
        } catch {
          // stale figures beat none
        }
        const summary = db.adjudicator.summary(since);
        const savings = savingsReport(db, {
          since,
          pricing: config.usage.pricing as NonNullable<
            Parameters<typeof savingsReport>[1]
          >["pricing"],
        });
        io.out(JSON.stringify({ summary, savings }, null, 2));
        return 0;
      }
      io.out(formatStats(db, config, since));
      if (Array.isArray(SAVINGS_ASSUMPTIONS) && SAVINGS_ASSUMPTIONS.length)
        io.out(`assumptions: ${SAVINGS_ASSUMPTIONS.join(" · ")}`);
      return 0;
    }

    case "exchanges":
      return exchangesCommand(rest[0], values, ctx, load, io, deps);

    case "help":
      io.out(ADJUDICATOR_USAGE);
      return 0;

    default:
      io.err(
        looksLikeKey(sub) ? `${KEY_NOT_FROM_ARGV}\n` : `unknown adjudicator command: ${sub}\n`,
      );
      io.out(ADJUDICATOR_USAGE);
      return 2;
  }
}

// --- exchanges ---------------------------------------------------------------------

/**
 * `exchanges [status|on|off|purge]`: the Jev request log (adjudicator.privacy.captureExchanges).
 * A personal setting only: a project's eminiar.config.json cannot turn it on, so `on` refuses
 * --project and a personal config file that sits inside the project. Captured requests hold
 * redacted prompt text in this project's database, so `on` asks y/N first (--yes answers it, and
 * is required without a terminal). `off` and `purge` delete this project's rows only.
 */
async function exchangesCommand(
  action: string | undefined,
  values: Record<string, unknown>,
  ctx: ProjectContext,
  load: () => Config,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const sub = action ?? "status";
  const yes = values.yes === true;
  const confirm = async (question: string, needYes: string): Promise<boolean> => {
    if (yes) return true;
    if (!io.isTTY) {
      io.err(needYes);
      return false;
    }
    return askNo(io, question);
  };
  if (sub === "status") {
    const a = load().adjudicator;
    let db: StorageAdapter | undefined;
    try {
      db = await storage(ctx, deps);
    } catch {
      db = undefined;
    }
    const c = captureStatus(a, db, io.env);
    if (values.json) {
      io.out(JSON.stringify({ ...c, db: ctx.dbPath }, null, 2));
      return 0;
    }
    io.out(
      `capture: ${c.on ? "on" : "off"} (personal ${tilde(paths().configFile)})${
        c.forcedOff ? " · EMINIAR_ADJUDICATOR_CAPTURE=0 is forcing it off" : ""
      } · stored here: ${c.stored === null ? "unknown (database unreadable)" : `${c.stored} of ${c.keep}`}${
        c.newestTs ? ` · newest ${new Date(c.newestTs).toISOString()}` : ""
      } · db ${tilde(ctx.dbPath)}`,
    );
    if (!c.on && !c.forcedOff) io.out("turn it on with `eminiar adjudicator exchanges on`");
    return 0;
  }
  if (sub !== "on" && sub !== "off" && sub !== "purge") {
    io.err(`unknown exchanges command: ${sub}\n`);
    io.out(ADJUDICATOR_USAGE);
    return 2;
  }
  if (values.project) {
    io.err(
      "exchanges is a personal setting: eminiar.config.json cannot set it. Run it without --project.",
    );
    return 2;
  }

  if (sub === "on") {
    if (personalFileUntrusted(io, ctx.root)) return 2;
    const a = load().adjudicator;
    io.out(
      `Keeps each request sent to ${hostOf(a.typesafe.baseUrl)} (your prompt text, redacted, up to ${a.privacy.maxChars} chars per item) and Jev's answer, with timing, in ${tilde(ctx.dbPath)}.`,
    );
    io.out(
      "Captured requests contain redacted prompt text and are stored in this project's database. Only the newest 100 are kept. `eminiar adjudicator exchanges purge` deletes them.",
    );
    if (
      !(await confirm(
        "Turn on?",
        "exchanges on stores redacted prompt text and needs a yes: run it in a terminal, or pass --yes. Nothing was changed.",
      ))
    ) {
      io.out("Nothing was changed.");
      return io.isTTY || yes ? 0 : 1;
    }
    // applyPatch merges objects, so privacy.maxChars and privacy.storeHead are kept.
    writeAdjudicatorPatch(paths().configFile, { privacy: { captureExchanges: true } });
    io.out(`Jev request capture is on; wrote ${tilde(paths().configFile)}.`);
    const after = load().adjudicator;
    if (io.env.EMINIAR_ADJUDICATOR_CAPTURE === "0")
      io.out("warning: EMINIAR_ADJUDICATOR_CAPTURE=0 is set in this shell and keeps capture off.");
    if (!after.enabled || after.provider !== "typesafe")
      io.out(
        `note: nothing is captured until Jev is the provider (now: adjudicator ${after.enabled ? "on" : "off"}, provider ${after.provider}); \`eminiar adjudicator enable --provider typesafe\`.`,
      );
    return 0;
  }

  if (sub === "off") {
    writeAdjudicatorPatch(paths().configFile, { privacy: { captureExchanges: false } });
    let n: number;
    try {
      n = (await storage(ctx, deps)).adjudicator.exchangePurge();
    } catch (err) {
      io.err(
        `Jev request capture is off, but deleting the stored requests failed: ${(err as Error).message}. Run \`eminiar adjudicator exchanges purge --yes\` to retry.`,
      );
      return 1;
    }
    io.out(
      `Jev request capture is off; deleted ${n} captured request${n === 1 ? "" : "s"} here. Other projects keep theirs (run \`eminiar adjudicator exchanges purge\` in each).`,
    );
    return 0;
  }

  // purge
  const db = await storage(ctx, deps);
  const count = db.adjudicator.exchangeCount();
  if (count === 0) {
    io.out("No captured requests in this project.");
    return 0;
  }
  if (
    !(await confirm(
      `Delete ${count} captured request${count === 1 ? "" : "s"} from this project?`,
      "exchanges purge deletes data and needs a yes: run it in a terminal, or pass --yes. Nothing was deleted.",
    ))
  ) {
    io.out("Nothing was deleted.");
    return io.isTTY ? 0 : 1;
  }
  const n = db.adjudicator.exchangePurge();
  io.out(
    `Deleted ${n} captured request${n === 1 ? "" : "s"} from this project; the capture setting is unchanged. Other projects keep theirs.`,
  );
  return 0;
}

// --- key --------------------------------------------------------------------------

/** "typesafe" | "jev" | a preset | "openai:<preset>" → key id. */
export function keyIdFor(arg: string | undefined, r: Resolved): KeyId | undefined {
  if (!arg) return keyNeed(r)?.id;
  const v = arg.toLowerCase();
  if (v.startsWith("openai:")) {
    const p = v.slice(7);
    return (PRESET_IDS as string[]).includes(p) ? v : undefined;
  }
  const c = parseChoice(v);
  if (c?.provider === "typesafe") return "typesafe";
  if (c?.preset) return `openai:${c.preset}`;
  return undefined;
}

/**
 * The resolution a key id would be sent with: `r` when it is the configured provider's id,
 * otherwise the provider/preset that id belongs to on top of the current config (a preset other
 * than the configured one with its default URL). keyFor() of it matches what a provider gets.
 */
function resolvedForKey(
  id: KeyId,
  a: AdjudicatorConfig,
  r: Resolved,
  env: NodeJS.ProcessEnv,
): Resolved {
  if (r.keyId === id) return r;
  if (id === "typesafe")
    return resolveAdjudicator({ ...a, provider: "typesafe" }, { context: "cli", env });
  const preset = id.slice(7) as PresetId;
  const openai =
    preset === a.openai.preset ? a.openai : { preset, json: a.openai.json, price: undefined };
  return resolveAdjudicator(
    { ...a, provider: "openai-compatible", openai: openai as AdjudicatorConfig["openai"] },
    { context: "cli", env },
  );
}

async function keyCommand(
  rest: string[],
  values: Record<string, unknown>,
  io: Io,
  load: () => Config,
  root: string,
): Promise<number> {
  const [action = "status", positional, ...extra] = rest;
  // `key set --provider groq` names the provider like `key set groq`.
  const target =
    positional ?? (values.provider as string[] | undefined)?.find((p) => typeof p === "string");
  // Every argument is checked for a key shape before any name validation, so a key pasted in
  // the wrong place is refused with a fixed message and never echoed.
  if ([action, target, ...extra].some((a) => looksLikeKey(a))) {
    io.err(KEY_NOT_FROM_ARGV);
    return 2;
  }
  const config = load();
  const r = resolveAdjudicator(config, { context: "cli", env: io.env });
  switch (action) {
    case "set": {
      if (extra.length) {
        io.err(KEY_NOT_FROM_ARGV);
        return 2;
      }
      const fromEnv = typeof values["from-env"] === "string" ? values["from-env"] : undefined;
      if (fromEnv) {
        if (envNameLooksLikeKey(fromEnv, io.env)) {
          io.err(KEY_NOT_FROM_ARGV);
          return 2;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fromEnv)) {
          io.err("--from-env takes the NAME of an environment variable, not a key");
          return 2;
        }
        if (personalFileUntrusted(io, root)) return 1;
        writeAdjudicatorPatch(paths().configFile, { keyEnv: fromEnv });
        io.out(
          `The adjudicator now reads its key from $${fromEnv}${io.env[fromEnv] ? ` (set: ${mask(io.env[fromEnv])})` : " (not set in this shell)"}; no key was stored.`,
        );
        return 0;
      }
      const id = keyIdFor(target, r);
      if (!id) {
        io.err(
          target
            ? `unknown provider ${shown(target)}; use typesafe (Jev) or a preset: ${PRESET_IDS.join(", ")}`
            : "Which provider? `eminiar adjudicator key set typesafe` (Jev) or a preset such as groq.",
        );
        return 2;
      }
      if (personalFileUntrusted(io, root, paths().adjudicatorKey)) return 1;
      const label = id === "typesafe" ? "TypeSafe (Jev)" : presetLabel(id.slice(7) as PresetId);
      let key: string;
      try {
        key = await readKey(io, label, false);
      } catch (err) {
        io.err((err as Error).message);
        return 1;
      }
      if (!key) {
        io.err(
          io.isTTY
            ? "No key entered; nothing changed."
            : "No key on stdin; pipe it in, e.g. `pbpaste | eminiar adjudicator key set typesafe`.",
        );
        return 1;
      }
      try {
        storeKey(io, id, key);
      } catch (err) {
        io.err((err as Error).message);
        return 1;
      }
      const k = keyFor(resolvedForKey(id, config.adjudicator, r, io.env), io.env);
      if (k?.source === "env" && k.envName)
        io.out(`Note: $${k.envName} is set and takes precedence over the key file.`);
      return 0;
    }
    case "clear": {
      if (!target) {
        const had = clearKey();
        io.out(had ? `Removed ${tilde(paths().adjudicatorKey)}.` : "No stored keys.");
        return 0;
      }
      const id = keyIdFor(target, r);
      if (!id) {
        io.err(`unknown provider ${shown(target)}`);
        return 2;
      }
      io.out(clearKey(id) ? `Removed the ${id} key.` : `No stored ${id} key.`);
      return 0;
    }
    case "status":
    case "show": {
      const ids = new Set<KeyId>(["typesafe", "openai:groq", "openai:cerebras", ...storedKeyIds()]);
      const need = keyNeed(r);
      if (need) ids.add(need.id);
      const rows = [...ids].map((id) => {
        // The key that would actually be sent: a local (loopback) target never gets an env key.
        const k = keyFor(resolvedForKey(id, config.adjudicator, r, io.env), io.env) ?? {
          source: "none" as const,
          key: undefined,
          envName: undefined,
        };
        return {
          id,
          source: k.source,
          envName: k.envName ?? null,
          masked: mask(k.key),
          inUse: need?.id === id,
        };
      });
      const kf = keyFileStatus();
      if (values.json) {
        io.out(
          JSON.stringify(
            {
              keys: rows,
              keyEnv: config.adjudicator.keyEnv ?? null,
              file: { path: kf.path, exists: kf.exists, mode: kf.mode ?? null, secure: kf.secure },
            },
            null,
            2,
          ),
        );
        return 0;
      }
      for (const row of rows)
        if (row.source !== "none" || row.inUse)
          io.out(
            `${row.id}${row.inUse ? " (in use)" : ""}: ${
              row.source === "none"
                ? "none"
                : row.source === "env"
                  ? `env $${row.envName} ${row.masked}`
                  : `file ${row.masked}`
            }`,
          );
      if (rows.every((x) => x.source === "none" && !x.inUse)) io.out("No keys stored or set.");
      io.out(
        `key file: ${tilde(kf.path)} ${kf.exists ? `0${(kf.mode ?? 0).toString(8)}${kf.secure ? "" : " — readable by others: chmod 600 it"}` : "absent"}`,
      );
      return 0;
    }
    default:
      io.err(
        "usage: eminiar adjudicator key set [provider] [--from-env NAME] | clear [provider] | status",
      );
      return 2;
  }
}

// --- test -------------------------------------------------------------------------

interface RawView {
  complexity: number | null;
  tier: string | null;
  tierConfidence: number | null;
  role: string | null;
  tool: string | null;
}

function rawView(res: ProviderResult): RawView | null {
  const a = res.answers[0];
  if (!a) return null;
  const top = (d: { probs: Record<string, number> } | undefined) =>
    d ? (Object.entries(d.probs).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null) : null;
  return {
    complexity: a.complexity?.value ?? null,
    tier: top(a.tier),
    tierConfidence: a.tier?.confidence ?? null,
    role: top(a.role),
    tool: top(a.tool),
  };
}

function verdictView(v: Verdict) {
  return {
    complexity: Math.round(v.complexity * 100) / 100,
    tier: v.tier.choice,
    effort: v.effort,
    tool: v.tool.choice,
    role: v.role.choice,
    confidence: Math.round(v.tier.confidence * 100) / 100,
    source: v.source,
    providerStatus: v.providerStatus,
    latencyMs: Math.round(v.latencyMs),
  };
}

async function testCommand(
  text: string,
  providerArg: string | undefined,
  json: boolean,
  config: Config,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  if (!text.trim()) {
    io.err('usage: eminiar adjudicator test "<text>" [--provider P] [--json]');
    return 2;
  }
  let cfg = config.adjudicator;
  if (providerArg) {
    const c = parseChoice(providerArg);
    if (!c) {
      io.err(`unknown provider ${shown(providerArg)}`);
      return 2;
    }
    cfg = candidate(cfg, choicePatch(c, cfg));
  }
  const full: Config = { ...config, adjudicator: cfg };
  const r = resolveAdjudicator(full, { context: "cli", env: io.env });
  const req: AdjudicationRequest = { key: "test", surface: "test", text };
  const base = { ignoreEnabled: true, persist: false, context: "cli" as const, env: io.env };
  const heuristic = (
    await adjudicateOne(req, { ...base, config: { ...cfg, provider: "heuristic" }, provider: null })
  ).verdict;

  const out: {
    configured: string;
    effective: string;
    degraded: string | null;
    detail: string | null;
    probe: { ok: boolean; latencyMs: number; detail: string } | null;
    heuristic: ReturnType<typeof verdictView>;
    raw:
      | (RawView & {
          latencyMs: number;
          inTok: number;
          outTok: number;
          costUsd: number | null;
          model: string;
        })
      | null;
    rawError: string | null;
    blended: ReturnType<typeof verdictView> | null;
    persisted: false;
  } = {
    configured: providerLabel(r),
    effective: r.provider,
    degraded: r.degraded ?? null,
    detail: r.detail ?? null,
    probe: null,
    heuristic: verdictView(heuristic),
    raw: null,
    rawError: null,
    blended: null,
    persisted: false,
  };
  let failed = false;
  if (r.provider !== "heuristic") {
    if (r.provider === "embedding") await warmEmbedding(r, full, deps);
    const p = await providerFor(r, full, deps, io.env);
    if (p) {
      try {
        out.probe = await p.probe({ signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      } catch (err) {
        out.probe = { ok: false, latencyMs: 0, detail: (err as Error).message };
      }
      if (!out.probe.ok) failed = true;
      const budget = cfg.timeouts.planMs;
      let raw: ProviderResult | undefined;
      let rawErr: unknown;
      try {
        raw = await p.adjudicate([req], {
          signal: AbortSignal.timeout(budget),
          deadlineMs: budget,
        });
        const v = rawView(raw);
        out.raw = v
          ? {
              ...v,
              latencyMs: Math.round(raw.latencyMs),
              inTok: raw.usage.inTok,
              outTok: raw.usage.outTok,
              costUsd: raw.usage.costUsd,
              model: raw.model,
            }
          : null;
        if (!v) out.rawError = "the provider returned no answer for the sample";
      } catch (err) {
        rawErr = err;
        out.rawError = `${(err as { kind?: string }).kind ?? "error"}: ${(err as Error).message}`;
        failed = true;
      }
      // Blend the same reply: one provider call, not two.
      const replay: AdjudicatorProvider = {
        id: p.id,
        remote: p.remote,
        dims: p.dims,
        probe: (o) => p.probe(o),
        adjudicate: async () => {
          if (rawErr !== undefined || !raw) throw rawErr ?? new Error("no reply");
          return raw;
        },
      };
      out.blended = verdictView(
        (
          await adjudicateOne(req, {
            ...base,
            config: cfg,
            resolved: r,
            provider: replay,
            budgetMs: budget,
          })
        ).verdict,
      );
    } else {
      out.rawError = "no provider factory for this provider";
      failed = true;
    }
  }

  if (json) {
    io.out(JSON.stringify(out, null, 2));
    return failed ? 1 : 0;
  }
  const line = (label: string, v: ReturnType<typeof verdictView>) =>
    `${label.padEnd(10)} complexity ${v.complexity.toFixed(2)} · ${v.tier}/${v.effort} · tool ${v.tool} · role ${v.role} · conf ${v.confidence.toFixed(2)} · ${v.source}${
      v.providerStatus !== "n/a" && v.providerStatus !== "ok" ? ` (${v.providerStatus})` : ""
    } · ${v.latencyMs} ms`;
  io.out(
    `provider: ${out.configured}${r.provider !== r.configured ? ` → heuristic (${r.degraded}: ${r.detail})` : ""}`,
  );
  if (out.probe)
    io.out(
      `probe:     ${out.probe.ok ? "ok" : "FAILED"} · ${out.probe.detail} · ${Math.round(out.probe.latencyMs)} ms`,
    );
  io.out(line("heuristic", out.heuristic));
  if (out.raw)
    io.out(
      `${"raw".padEnd(10)} complexity ${out.raw.complexity?.toFixed(2) ?? "–"} · tier ${out.raw.tier ?? "–"}${
        out.raw.tierConfidence !== null ? ` (${out.raw.tierConfidence.toFixed(2)})` : ""
      } · role ${out.raw.role ?? "–"} · tool ${out.raw.tool ?? "–"} · ${out.raw.model} · ${out.raw.latencyMs} ms · ${out.raw.inTok}+${out.raw.outTok} tok · ${usd(out.raw.costUsd)}`,
    );
  else if (out.rawError) io.out(`${"raw".padEnd(10)} ${out.rawError}`);
  if (out.blended) io.out(line("blended", out.blended));
  io.out("(not persisted)");
  return failed ? 1 : 0;
}

async function warmEmbedding(r: Resolved, config: Config, deps: CliDeps): Promise<void> {
  if (deps.provider !== undefined) return;
  const factory = defaultEmbeddingFactory(config);
  if (!hasProvider("embedding")) registerProvider("embedding", factory);
  try {
    // The first call would otherwise spend its budget loading the model.
    await factory(r, config.adjudicator, {}).warm();
  } catch {
    // the call reports the failure
  }
}

// --- eval -------------------------------------------------------------------------

async function evalCommand(
  o: {
    ids: string[];
    fixture: string | undefined;
    replace: boolean;
    repeat: string | undefined;
    save: boolean;
    json: boolean;
  },
  ctx: ProjectContext,
  config: Config,
  io: Io,
  deps: CliDeps,
): Promise<number> {
  const ids: ProviderId[] = [];
  for (const raw of o.ids.length ? o.ids : [config.adjudicator.provider]) {
    const c = parseChoice(raw);
    if (!c) {
      io.err(`unknown provider ${shown(raw)}`);
      return 2;
    }
    ids.push(c.provider);
  }
  const repeat = o.repeat === undefined ? 1 : Number(o.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    io.err("--repeat takes a whole number from 1 to 10");
    return 2;
  }
  let fixture:
    | { items: Awaited<ReturnType<typeof ev.loadFixture>>; mode: "merge" | "replace"; name: string }
    | undefined;
  if (o.fixture) {
    if (!/\.(json|js|mjs|ts)$/i.test(o.fixture)) {
      io.err("--fixture takes a .json, .js or .mjs file");
      return 2;
    }
    try {
      fixture = {
        items: await ev.loadFixture(o.fixture),
        mode: o.replace ? "replace" : "merge",
        name: o.fixture.split(/[\\/]/).pop() ?? o.fixture,
      };
    } catch (err) {
      io.err((err as Error).message);
      return 2;
    }
  }
  const cfg = config.adjudicator;
  let candidates: Parameters<typeof ev.runEval>[0]["candidates"] = [];
  let skipped: Parameters<typeof ev.runEval>[0]["skipped"] = [];
  if (deps.provider) {
    candidates = [{ id: deps.provider.id, provider: deps.provider }];
  } else if (ids.some((i) => i !== "heuristic")) {
    if (ids.includes("embedding")) {
      const r = resolveAdjudicator(
        { ...cfg, provider: "embedding" },
        { context: "cli", env: io.env },
      );
      io.err("warming the embedding provider…");
      await warmEmbedding(r, config, deps);
    }
    const res = ev.resolveEvalCandidates(cfg, ids, {
      env: io.env,
      ...(deps.providerDeps ? { deps: deps.providerDeps } : {}),
    });
    candidates = res.candidates;
    skipped = res.skipped;
  }
  const report = await ev.runEval({
    config: cfg,
    candidates,
    skipped,
    repeat,
    env: io.env,
    ...(fixture ? { fixture } : {}),
  });
  if (o.save) {
    const db = await storage(ctx, deps);
    ev.saveEvalReport(db, report);
  }
  io.out(o.json ? JSON.stringify(report, null, 2) : ev.formatEvalReport(report));
  if (o.save && !o.json) io.out("saved as the last eval (dashboard → Adjudicator).");
  return 0;
}
