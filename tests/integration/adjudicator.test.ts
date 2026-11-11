import { type ChildProcess, spawn } from "node:child_process";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Real child processes: each CLI/hook call costs 50 ms to 1 s; the suite makes a few hundred.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

/**
 * End-to-end, latency-free privacy and behaviour checks for the adjudicator (task T15). They use
 * the BUILT artifacts (dist/hook.js via bin/em-hook, dist/cli.js via bin/eminiar, dist/server.js)
 * in real child processes, a scratch EMINIAR_HOME and project per scenario, and local HTTP stubs
 * standing in for the provider (Jev through typesafe.baseUrl): nothing here touches the network,
 * a real model, or the user's ~/.eminiar. Run `npm run build` first.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EM_HOOK = join(ROOT, "bin", "em-hook");
const EM_CLI = join(ROOT, "bin", "eminiar");
const DIST = join(ROOT, "dist");

// ---------------------------------------------------------------------------------------------
// A stub Jev endpoint (POST /v1/systemone, GET /v1/models) that records every request.

type StubMode = "ok" | "http500" | "echo500" | "echo401" | "slow" | "garbage";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

class JevStub {
  server: Server;
  seen: Seen[] = [];
  mode: StubMode = "ok";
  tier = "haiku";
  port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }

  /** Requests that scored something (not the GET /models probes). */
  get scoring(): Seen[] {
    return this.seen.filter((s) => s.method === "POST");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const auth = req.headers.authorization;
    this.seen.push({ method: req.method ?? "", url: req.url ?? "", auth, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (req.method === "GET") return send(200, { data: [{ id: "jev-1.14.0" }] });
    if (this.mode === "http500") return send(500, { error: "boom" });
    // A hostile server that reflects the credential it was sent, in the body and a header.
    if (this.mode === "echo500" || this.mode === "echo401") {
      const status = this.mode === "echo500" ? 500 : 401;
      res.setHeader("x-echo", String(auth));
      return send(status, { error: `rejected credential ${auth}`, authorization: auth });
    }
    if (this.mode === "garbage") return send(200, '{"answers": 5, "model":');
    if (this.mode === "slow") await new Promise((r) => setTimeout(r, 4000));
    let parsed: {
      questions?: Record<string, { type: string; criteria?: unknown }>;
    } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(400, { error: "bad json" });
    }
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(parsed.questions ?? {})) {
      if (q.type === "score") answers[id] = { type: "score", score: 0.2, confidence: 0.9 };
      else if (q.type === "noul") answers[id] = { type: "noul", noul: 0.1 };
      else {
        const options = Object.keys((q.criteria ?? {}) as Record<string, string>);
        const choice = id.endsWith(".tier") && options.includes(this.tier) ? this.tier : options[0];
        answers[id] = {
          type: "choice",
          choice,
          confidence: 0.95,
          probabilities: { [choice as string]: 0.95 },
        };
      }
    }
    return send(200, {
      model: "jev-1.14.0",
      answers,
      usage: { input_tokens: 120, output_tokens: 8 },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios: a scratch EMINIAR_HOME and project, and helpers that run the built binaries.

const cleanup: string[] = [];
const stubs: JevStub[] = [];
const children = new Set<ChildProcess>();

interface Scenario {
  home: string;
  root: string;
  env: NodeJS.ProcessEnv;
}

function scenario(extraEnv: Record<string, string> = {}): Scenario {
  const home = mkdtempSync(join(tmpdir(), "em-adj-e2e-home-"));
  const root = mkdtempSync(join(tmpdir(), "em-adj-e2e-root-"));
  // The shims point NODE_COMPILE_CACHE at <home>/compile-cache. A child that outlives its CLI call
  // (e.g. the em-server `eminiar doctor` probes and SIGTERMs) flushes its cache on the way out, into
  // a home the test is scanning or deleting. Keep that cache outside the scanned home.
  const cc = mkdtempSync(join(tmpdir(), "em-adj-e2e-cc-"));
  cleanup.push(home, root, cc);
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, ".git"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Nothing ambient may leak in or out: the scenario owns its whole eminiar environment.
  for (const k of Object.keys(env))
    if (/^(EMINIAR_|CLAUDE_|TYPESAFE_|GROQ_|CEREBRAS_|OPENAI_)/.test(k)) delete env[k];
  Object.assign(env, {
    EMINIAR_HOME: home,
    EMINIAR_PROJECT_ROOT: root,
    CLAUDE_PROJECT_DIR: root,
    EMINIAR_EMBEDDINGS: "0",
    NODE_COMPILE_CACHE: cc,
    ...extraEnv,
  });
  return { home, root, env };
}

/** The project's eminiar.config.json (read by every hook and CLI process of the scenario). */
function projectConfig(s: Scenario, cfg: Record<string, unknown>): void {
  writeFileSync(join(s.root, "eminiar.config.json"), JSON.stringify(cfg));
}

/**
 * Merge `patch` into the scenario's own ~/.eminiar/config.json. A committed project file may set
 * only the adjudicator's behaviour knobs; timeouts, breaker, budget, provider, endpoints, apply
 * mode, apply.* and tiers are the user's, so tests that tune them must write here, not to
 * projectConfig().
 */
function globalConfig(s: Scenario, patch: Record<string, unknown>): void {
  const file = join(s.home, "config.json");
  const merge = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const cur = out[k];
      out[k] =
        v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object"
          ? merge(cur as Record<string, unknown>, v as Record<string, unknown>)
          : v;
    }
    return out;
  };
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // no file yet
  }
  writeFileSync(file, JSON.stringify(merge(cur, patch)));
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function run(
  cmd: string,
  args: string[],
  s: Scenario,
  o: { stdin?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<Ran> {
  return new Promise((res, rej) => {
    const env = { ...s.env, ...o.env };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const t0 = performance.now();
    const child = spawn(cmd, args, { env, cwd: s.root, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error(`${cmd} ${args.join(" ")} timed out`));
    }, o.timeoutMs ?? 30_000);
    child.on("error", rej);
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      res({ code, stdout, stderr, ms: performance.now() - t0 });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin ?? "");
  });
}

const hook = (s: Scenario, payload: Record<string, unknown>, o: Parameters<typeof run>[3] = {}) =>
  run("sh", [EM_HOOK], s, { ...o, stdin: JSON.stringify(payload) });
const cli = (s: Scenario, args: string[], o: Parameters<typeof run>[3] = {}) =>
  run("sh", [EM_CLI, ...args], s, o);

let sessionN = 0;
const sid = () => `e2e-${process.pid}-${++sessionN}`;

const promptPayload = (s: Scenario, session: string, prompt: string) => ({
  session_id: session,
  cwd: s.root,
  hook_event_name: "UserPromptSubmit",
  prompt,
});

const AGENT_INPUT = {
  description: "find the parser",
  prompt: "Find where the config parser is defined and list its callers.",
  subagent_type: "general-purpose",
  run_in_background: true,
  extra_field: { nested: [1, 2] },
};
const agentPayload = (s: Scenario, session: string, tool = "Agent") => ({
  session_id: session,
  cwd: s.root,
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_use_id: `tu-${Math.random().toString(36).slice(2)}`,
  // A fresh prompt each time, so the verdict cache never answers instead of the provider.
  tool_input: {
    ...AGENT_INPUT,
    prompt: `${AGENT_INPUT.prompt} (variant ${Math.random().toString(36).slice(2)})`,
  },
});

const json = <T = Record<string, unknown>>(r: Ran): T => JSON.parse(r.stdout) as T;

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every adjudications row of the scenario's project databases, read directly (read-only). */
function dbFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".db")) out.push(p);
    }
  };
  if (existsSync(join(home, "projects"))) walk(join(home, "projects"));
  return out;
}
function adjRows(home: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const f of dbFiles(home)) {
    const db = new Database(f, { readonly: true, fileMustExist: true });
    try {
      const has = db
        .prepare("select 1 from sqlite_master where type='table' and name='adjudications'")
        .get();
      if (has) rows.push(...(db.prepare("select * from adjudications order by id").all() as []));
    } catch {
      // another process holds the write lock; the caller polls again
    } finally {
      db.close();
    }
  }
  return rows;
}

/** Every file under `dir` (databases, WAL and SHM sidecars, logs, caches) containing `needle`. */
function filesContaining(dir: string, needles: string[], skip: string[] = []): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // removed while scanning
      throw e;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (skip.includes(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        let buf: Buffer;
        try {
          buf = readFileSync(p);
        } catch (err) {
          // A temp file a still-exiting child renamed or removed between readdir and read.
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        for (const n of needles) if (buf.includes(n)) hits.push(`${p} contains ${n.slice(0, 12)}…`);
      }
    }
  };
  walk(dir);
  return hits;
}

/**
 * The adjudicator's own tables (decisions, cache, provider state, bias) and meta rows as one JSON
 * string. eminiar's session capture (sessions/events) keeps raw prompts by design and is not
 * the adjudicator's, so prompt-text checks look here rather than at the whole database.
 */
function dumpAdjudicator(home: string): string {
  const parts: string[] = [];
  for (const f of dbFiles(home)) {
    const db = new Database(f, { readonly: true, fileMustExist: true });
    try {
      const tables = db
        .prepare(
          "select name from sqlite_master where type='table' and (name = 'adjudications' or name like 'adjudicator%')",
        )
        .all() as Array<{ name: string }>;
      for (const t of tables)
        parts.push(JSON.stringify(db.prepare(`select * from "${t.name}"`).all()));
      parts.push(
        JSON.stringify(db.prepare("select * from meta where key like 'adjudicator%'").all()),
      );
    } finally {
      db.close();
    }
  }
  return parts.join("\n");
}

/** Every table of every project database as one JSON string (a DB dump, not raw pages). */
function dumpDatabases(home: string): string {
  const parts: string[] = [];
  for (const f of dbFiles(home)) {
    const db = new Database(f, { readonly: true, fileMustExist: true });
    try {
      const tables = db
        .prepare(
          "select name from sqlite_master where type='table' and name not like '%\\_fts%' escape '\\' and name not like 'vec%'",
        )
        .all() as Array<{ name: string }>;
      for (const t of tables) {
        try {
          parts.push(JSON.stringify(db.prepare(`select * from "${t.name}"`).all()));
        } catch {
          // virtual tables that need an extension
        }
      }
    } finally {
      db.close();
    }
  }
  return parts.join("\n");
}

/** Prompt secrets in the adjudicator's own storage and in every file outside the project databases. */
function promptLeaks(s: Scenario): string[] {
  const hits = filesContaining(s.home, SECRET_IN_PROMPT, [join(s.home, "projects")]);
  const dump = dumpAdjudicator(s.home);
  for (const secret of SECRET_IN_PROMPT)
    if (dump.includes(secret)) hits.push(`adjudicator tables contain ${secret}`);
  return hits;
}

/** Run `fn` in this process with the scenario's environment (and fresh caches), then restore. */
async function inScenario<T>(s: Scenario, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(s.env).filter((k) => /^(EMINIAR_|CLAUDE_|TYPESAFE_)/.test(k));
  const saved: Record<string, string | undefined> = {};
  for (const k of [...keys, "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]) saved[k] = process.env[k];
  Object.assign(process.env, Object.fromEntries(keys.map((k) => [k, s.env[k]])));
  const { resetContextCache } = await import("../../src/context.js");
  const { closeAllStorage } = await import("../../src/storage/index.js");
  const { resetSecrets } = await import("../../src/adjudicator/secrets.js");
  resetContextCache();
  resetSecrets();
  try {
    return await fn();
  } finally {
    closeAllStorage();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetContextCache();
    resetSecrets();
  }
}

async function freeDeadPort(): Promise<number> {
  return new Promise((res) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function newStub(): Promise<JevStub> {
  const s = await new JevStub().start();
  stubs.push(s);
  return s;
}

/** Point a scenario at a stub: typesafe provider, key on stdin, enabled. */
async function enableJev(
  s: Scenario,
  stub: JevStub,
  key: string,
  opts: { mode?: "advise" | "apply" } = {},
): Promise<void> {
  const prov = await cli(s, ["adjudicator", "provider", "typesafe", "--base-url", stub.baseUrl]);
  expect(prov.code, prov.stderr + prov.stdout).toBe(0);
  const set = await cli(s, ["adjudicator", "key", "set", "typesafe"], { stdin: `${key}\n` });
  expect(set.code, set.stderr + set.stdout).toBe(0);
  const en = await cli(s, ["adjudicator", "enable", "--mode", opts.mode ?? "advise"]);
  expect(en.code, en.stderr + en.stdout).toBe(0);
}

// A prompt carrying text a remote provider must never receive in clear.
const SECRET_IN_PROMPT = ["AKIAABCDEFGHIJKLMNOP", "hunter2hunter2"];
const SECRET_PROMPT = `Refactor the config loader module across the codebase and update all callers, using AWS key ${SECRET_IN_PROMPT[0]} and api_key=${SECRET_IN_PROMPT[1]} for the migration scripts`;

beforeAll(() => {
  for (const f of [
    EM_HOOK,
    EM_CLI,
    join(DIST, "hook.js"),
    join(DIST, "cli.js"),
    join(DIST, "server.js"),
  ])
    if (!existsSync(f)) throw new Error(`${f} is missing: run \`npm run build\` first`);
});
afterAll(async () => {
  for (const c of children) c.kill("SIGKILL");
  for (const s of stubs) await s.stop();
  for (const d of cleanup) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

// ---------------------------------------------------------------------------------------------

describe("off by default and the kill switch", () => {
  it("a default install: the hook adds nothing, writes nothing, calls nobody", async () => {
    const s = scenario();
    const stub = await newStub();
    const p = await hook(
      s,
      promptPayload(s, sid(), "Refactor the whole payment module and add tests"),
    );
    expect(p.code).toBe(0);
    expect(p.stdout).not.toMatch(/adjudicator/i);
    const a = await hook(s, agentPayload(s, sid()));
    expect(a.code).toBe(0);
    expect(a.stdout).not.toMatch(/adjudicator/i);
    expect(a.stdout).not.toContain('"model"');
    expect(adjRows(s.home)).toEqual([]);
    expect(stub.seen).toEqual([]);
    const st = json<{ enabled: boolean; effective: string }>(
      await cli(s, ["adjudicator", "status", "--json"]),
    );
    expect(st.enabled).toBe(false);
    expect(st.effective).toBe("heuristic");
  });

  it("EMINIAR_ADJUDICATOR=0 turns every surface off even when the config enables it", async () => {
    const s = scenario();
    const stub = await newStub();
    await enableJev(s, stub, "SENTINEL-killswitch-0000000000", { mode: "apply" });
    globalConfig(s, { adjudicator: { apply: { scope: "all", minConfidence: 0 } } });
    projectConfig(s, {
      routing: { mode: "enforce", deferToContextMode: false },
      adjudicator: { promptMode: "blocking" },
    });
    const off = { EMINIAR_ADJUDICATOR: "0" };
    const p = await hook(
      s,
      promptPayload(s, sid(), "Refactor the whole payment module and add tests"),
      { env: off },
    );
    expect(p.stdout).not.toMatch(/adjudicator/i);
    const a = await hook(s, agentPayload(s, sid()), { env: off });
    const out = JSON.parse(a.stdout || "{}");
    expect(out.hookSpecificOutput?.updatedInput?.model).toBeUndefined();
    expect(a.stdout).not.toMatch(/adjudicator/i);
    const st = json<{ enabled: boolean; enabledBy: string }>(
      await cli(s, ["adjudicator", "status", "--json"], { env: off }),
    );
    expect(st.enabled).toBe(false);
    expect(st.enabledBy).toMatch(/^env/);
    // Nothing was scored, stored or sent anywhere while the switch was off.
    expect(stub.scoring).toEqual([]);
    expect(adjRows(s.home)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("enabled, heuristic provider (offline)", () => {
  it("answers a prompt with one advice line and a row, with no provider anywhere", async () => {
    const s = scenario();
    expect((await cli(s, ["adjudicator", "enable"])).code).toBe(0);
    projectConfig(s, { adjudicator: { promptMode: "heuristic" } });
    const session = sid();
    const r = await hook(
      s,
      promptPayload(s, session, "Refactor the whole payment module across the repo and add tests"),
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput?.additionalContext ?? out.systemMessage ?? "").toMatch(
      /adjudicator/i,
    );
    const rows = adjRows(s.home).filter((x) => x.session_id === session);
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------------------------

describe("Jev through a local stub: async job, apply merge, privacy", () => {
  const KEY = "SENTINEL-jev-file-key-8f3a91c27d4e5b60";
  let s: Scenario;
  let stub: JevStub;
  let jobDump: string;

  beforeAll(async () => {
    s = scenario();
    stub = await newStub();
    await enableJev(s, stub, KEY, { mode: "apply" });
    // A wrapper as the hook script, so the detached --adjudicate child's stdin can be captured.
    jobDump = join(s.home, "..", `jobs-${process.pid}-${Date.now()}.log`);
    cleanup.push(jobDump);
    const wrapper = join(s.root, "capture-hook.mjs");
    writeFileSync(
      wrapper,
      `import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";
if (process.argv.includes("--adjudicate")) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks);
  appendFileSync(${JSON.stringify(jobDump)}, raw.toString("utf8") + "\\n---JOB---\\n");
  Object.defineProperty(process, "stdin", { value: Readable.from([raw]), configurable: true });
}
await import(${JSON.stringify(join(DIST, "hook.js"))});
`,
    );
    globalConfig(s, { adjudicator: { apply: { scope: "all", minConfidence: 0 } } });
    projectConfig(s, { routing: { mode: "enforce", deferToContextMode: false } });
    (s as Scenario & { wrapper: string }).wrapper = wrapper;
  });

  const wrapperHook = (payload: Record<string, unknown>) =>
    run(process.execPath, [(s as Scenario & { wrapper: string }).wrapper], s, {
      stdin: JSON.stringify(payload),
    });

  it("async mode: the hook answers at once from the heuristic, then the child updates the row", async () => {
    const session = sid();
    const r = await wrapperHook(promptPayload(s, session, SECRET_PROMPT));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(JSON.stringify(out)).toMatch(/adjudicator/i);
    // The child (a detached process) scores through the stub and updates the hook's row.
    await until("the Jev request", () => stub.scoring.length >= 1);
    await until("the row to become a blend", () =>
      adjRows(s.home).some((x) => x.session_id === session && x.source === "blend"),
    );
    const sent = stub.scoring[0]!;
    // The key travels only in the Authorization header.
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    expect(sent.body).not.toContain(KEY);
    expect(sent.url).toBe("/v1/systemone");
    // The prompt text is redacted before it leaves the process.
    for (const secret of SECRET_IN_PROMPT) expect(sent.body).not.toContain(secret);
    expect(sent.body).toContain("Refactor the config loader");
    // The job the child received on stdin carried the text and config, never the key.
    const jobs = readFileSync(jobDump, "utf8");
    expect(jobs).toContain('"v":1');
    expect(jobs).not.toContain(KEY);
    expect(JSON.parse(jobs.split("\n---JOB---\n")[0]!).config.enabled).toBe(true);
    const row = adjRows(s.home).find((x) => x.session_id === session)!;
    expect(row.provider_status).toBe("ok");
    expect(row.input_head as string).not.toContain(SECRET_IN_PROMPT[0]!);
    expect(row.input_head as string).not.toContain(SECRET_IN_PROMPT[1]!);
  });

  for (const routing of ["enforce", "annotate"] as const) {
    it(`apply mode keeps every Agent field through the real dispatch (routing ${routing})`, async () => {
      projectConfig(s, {
        routing: { mode: routing, deferToContextMode: false },
        adjudicator: { promptMode: "blocking" },
      });
      const session = sid();
      const before = stub.scoring.length;
      const payload = agentPayload(s, session);
      const sentInput = payload.tool_input;
      const r = await hook(s, payload);
      expect(r.code).toBe(0);
      const h = JSON.parse(r.stdout).hookSpecificOutput;
      expect(h.permissionDecision).toBe("allow");
      const ui = h.updatedInput as Record<string, unknown>;
      for (const [k, v] of Object.entries(sentInput)) if (k !== "prompt") expect(ui[k]).toEqual(v);
      expect(String(ui.prompt)).toContain(sentInput.prompt);
      expect(["haiku", "sonnet", "opus", "fable"]).toContain(ui.model);
      expect(ui).not.toHaveProperty("effort");
      if (routing === "enforce")
        expect(String(ui.prompt).startsWith("Use the eminiar tools")).toBe(true);
      else expect(ui.prompt).toBe(sentInput.prompt);
      expect(h.additionalContext).toMatch(/adjudicator: model \w+ applied/);
      // The Agent call went to the stub inline (apply, no plan row), with the key in the header only.
      expect(stub.scoring.length).toBeGreaterThan(before);
      expect(stub.scoring.at(-1)!.auth).toBe(`Bearer ${KEY}`);
      const row = adjRows(s.home).find((x) => x.session_id === session && x.surface === "agent")!;
      expect(row.action).toBe("applied");
      expect(row.model_final).toBe(ui.model);
    });
  }

  it("respects an explicit model", async () => {
    projectConfig(s, { routing: { mode: "enforce", deferToContextMode: false } });
    const withModel = agentPayload(s, sid());
    (withModel.tool_input as Record<string, unknown>).model = "opus";
    const r = await hook(s, withModel);
    const out = JSON.parse(r.stdout).hookSpecificOutput as Record<string, unknown>;
    expect((out.updatedInput as Record<string, unknown>).model).toBe("opus");
    const row = adjRows(s.home).find(
      (x) => x.tool_use_id === (withModel as { tool_use_id: string }).tool_use_id,
    );
    expect(row?.action).toBe("respected");
  });

  it("a Jev outage leaves the answer, exit code and stdout JSON intact", async () => {
    stub.mode = "http500";
    projectConfig(s, {
      routing: { mode: "enforce", deferToContextMode: false },
      adjudicator: { promptMode: "blocking" },
    });
    const r = await hook(
      s,
      promptPayload(
        s,
        sid(),
        "Rename the helper function in utils and update imports across files",
      ),
    );
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    stub.mode = "ok";
  });

  /** The em_adjudicate actions with real provider calls; each output is checked for both secrets. */
  function checkTool(outs: string[]) {
    expect(outs[0]).toMatch(/complexity/);
    for (const o of outs) {
      expect(o).not.toContain(KEY);
      for (const secret of SECRET_IN_PROMPT) expect(o).not.toContain(secret);
    }
  }

  it("em_adjudicate (handler, in this process): score, stats, explain and feedback never show the key", async () => {
    const outs = await inScenario(s, async () => {
      const { runAdjudicate } = await import("../../src/tools/em_adjudicate.js");
      const { getContext } = await import("../../src/context.js");
      const ctx = getContext(s.root);
      const text = async (args: Parameters<typeof runAdjudicate>[0]) =>
        (await runAdjudicate(args, ctx)).content.map((c) => ("text" in c ? c.text : "")).join("\n");
      const score = await text({ action: "score", text: SECRET_PROMPT });
      const id = Number(/\[(\d+)\]/.exec(score)?.[1]);
      expect(Number.isInteger(id)).toBe(true);
      return [
        score,
        await text({ action: "stats" }),
        await text({ action: "explain", id }),
        await text({ action: "feedback", id, outcome: "good", note: `token=${KEY}` }),
      ];
    });
    checkTool(outs);
    // The scoring call went to the stub with the key in the header only.
    expect(stub.scoring.at(-1)!.auth).toBe(`Bearer ${KEY}`);
    expect(stub.scoring.at(-1)!.body).not.toContain(KEY);
  });

  it("em_adjudicate (built MCP server over stdio): score, stats, explain and feedback never show the key", async () => {
    const first = await mcpCall(s, [
      { name: "em_adjudicate", arguments: { action: "score", text: SECRET_PROMPT } },
      { name: "em_adjudicate", arguments: { action: "stats" } },
    ]);
    const id = Number(/\[(\d+)\]/.exec(first[0]!)?.[1]);
    expect(Number.isInteger(id), first[0]).toBe(true);
    const more = await mcpCall(s, [
      { name: "em_adjudicate", arguments: { action: "explain", id } },
      {
        name: "em_adjudicate",
        arguments: { action: "feedback", id, outcome: "good", note: `token=${KEY}` },
      },
    ]);
    checkTool([...first, ...more]);
  });

  it("sentinel key: not in hook.log, the DB (+WAL/SHM), CLI output, the job stdin or MCP output", async () => {
    // Exercise every CLI subcommand (text and --json) with the key in the key file.
    const cmds: string[][] = [
      ["adjudicator", "status"],
      ["adjudicator", "status", "--json"],
      ["adjudicator", "key", "status"],
      ["adjudicator", "key", "status", "--json"],
      ["adjudicator", "key", "show"],
      ["adjudicator", "test", SECRET_PROMPT],
      ["adjudicator", "test", SECRET_PROMPT, "--json"],
      ["adjudicator", "stats"],
      ["adjudicator", "stats", "--json"],
      ["adjudicator", "eval", "--providers", "heuristic", "--json"],
      ["adjudicator", "provider", "--detect"],
      ["adjudicator", "help"],
      ["doctor"],
      ["doctor", "--json"],
    ];
    for (const args of cmds) {
      const r = await cli(s, args);
      expect(r.stdout + r.stderr, args.join(" ")).not.toContain(KEY);
      expect(r.stdout + r.stderr, args.join(" ")).not.toMatch(
        /SENTINEL-jev-file-key-8f3a91c27d4e5b60/,
      );
      for (const secret of SECRET_IN_PROMPT) expect(r.stdout, args.join(" ")).not.toContain(secret);
    }
    // key status shows the mask at most (last 4), never more of the key.
    const ks = await cli(s, ["adjudicator", "key", "status"]);
    expect(ks.stdout).toContain("****");
    expect(ks.stdout).not.toContain(KEY.slice(0, 20));
    // (em_adjudicate has its own tests below.)

    // Everything on disk except the key file itself.
    const keyFile = join(s.home, "adjudicator.key");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, "utf8")).toContain(KEY);
    expect(filesContaining(s.home, [KEY], [keyFile])).toEqual([]);
    expect(filesContaining(s.root, [KEY, ...SECRET_IN_PROMPT])).toEqual([]);
    expect(promptLeaks(s)).toEqual([]);
    expect(existsSync(join(s.home, "hook.log"))).toBe(true);
    expect(dumpDatabases(s.home)).not.toContain(KEY);
    // The config the CLI wrote carries the provider and URL, never a key.
    const cfg = readFileSync(join(s.home, "config.json"), "utf8");
    expect(cfg).not.toContain(KEY);
    expect(JSON.parse(cfg).adjudicator.typesafe.baseUrl).toBe(stub.baseUrl);
  });

  it("dashboard payloads (real server process) never carry the key or the prompt secrets", async () => {
    const port = await freeDeadPort();
    const child = spawn("sh", [EM_CLI, "ui", "--port", String(port), "--no-open"], {
      env: s.env,
      cwd: s.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    try {
      const base = `http://127.0.0.1:${port}`;
      await until("the dashboard", async () => {
        try {
          return (await fetch(`${base}/api/adjudicator`)).ok;
        } catch {
          return false;
        }
      });
      const bodies: string[] = [];
      for (const p of [
        "/api/adjudicator",
        "/api/adjudicator?since=all",
        "/api/adjudicator/decisions",
        "/api/adjudicator/savings",
        "/api/adjudicator/eval",
      ])
        bodies.push(await (await fetch(base + p)).text());
      const decisions = JSON.parse(bodies[2]!) as { rows: Array<{ id: number }> };
      expect(decisions.rows.length).toBeGreaterThan(0);
      for (const row of decisions.rows.slice(0, 5))
        bodies.push(await (await fetch(`${base}/api/adjudicator/decision?id=${row.id}`)).text());
      const t = await fetch(`${base}/api/adjudicator/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: SECRET_PROMPT, useProvider: true }),
      });
      bodies.push(await t.text());
      for (const b of bodies) {
        expect(b).not.toContain(KEY);
        for (const secret of SECRET_IN_PROMPT) expect(b).not.toContain(secret);
      }
      const overview = JSON.parse(bodies[0]!) as { keySource: string; enabled: boolean };
      expect(overview.enabled).toBe(true);
      expect(overview.keySource).toBe("file");
      // Run the scan again: the dashboard's own writes (reconcile, try-it) must stay clean too.
      const keyFile = join(s.home, "adjudicator.key");
      expect(filesContaining(s.home, [KEY], [keyFile])).toEqual([]);
      expect(promptLeaks(s)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      children.delete(child);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("key from an environment variable", () => {
  const KEY = "SENTINEL-jev-env-key-1b7c44d0aa9e3f58";

  it("a non-loopback endpoint: only the NAME is stored; the value never reaches disk, logs or CLI output", async () => {
    const s = scenario({ MY_JEV_KEY: KEY });
    const stub = await newStub();
    // 0.0.0.0 reaches the stub on this machine but is not a loopback address for the adjudicator,
    // so it counts as remote: consent is needed and an env key may be used.
    const remoteUrl = stub.baseUrl.replace("127.0.0.1", "0.0.0.0");
    // Pointing a non-interactive process at a remote host needs --accept-remote; without it nothing changes.
    const refused = await cli(s, ["adjudicator", "provider", "typesafe", "--base-url", remoteUrl]);
    expect(refused.code).toBe(1);
    const prov = await cli(s, [
      "adjudicator",
      "provider",
      "typesafe",
      "--base-url",
      remoteUrl,
      "--accept-remote",
    ]);
    expect(prov.code, prov.stderr + prov.stdout).toBe(0);
    const set = await cli(s, ["adjudicator", "key", "set", "typesafe", "--from-env", "MY_JEV_KEY"]);
    expect(set.code, set.stderr).toBe(0);
    const en = await cli(s, ["adjudicator", "enable"]);
    expect(en.code, en.stderr + en.stdout).toBe(0);
    projectConfig(s, { adjudicator: { promptMode: "blocking" } });
    const r = await hook(s, promptPayload(s, sid(), SECRET_PROMPT));
    expect(r.code).toBe(0);
    await until("the Jev request", () => stub.scoring.length >= 1);
    expect(stub.scoring[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(stub.scoring[0]!.body).not.toContain(KEY);
    for (const secret of SECRET_IN_PROMPT) expect(stub.scoring[0]!.body).not.toContain(secret);
    for (const args of [
      ["adjudicator", "status"],
      ["adjudicator", "status", "--json"],
      ["adjudicator", "key", "status", "--json"],
      ["adjudicator", "test", "fix the failing unit test in the parser", "--json"],
      ["adjudicator", "stats", "--json"],
      ["doctor", "--json"],
    ]) {
      const o = await cli(s, args);
      expect(o.stdout + o.stderr, args.join(" ")).not.toContain(KEY);
    }
    expect(existsSync(join(s.home, "adjudicator.key"))).toBe(false);
    expect(filesContaining(s.home, [KEY])).toEqual([]);
    expect(filesContaining(s.root, [KEY])).toEqual([]);
    expect(dumpDatabases(s.home)).not.toContain(KEY);
    expect(readFileSync(join(s.home, "config.json"), "utf8")).toContain("MY_JEV_KEY");
    const ks = json<{ key: { source: string } }>(await cli(s, ["adjudicator", "status", "--json"]));
    expect(ks.key.source).toBe("env");
  });

  it("a loopback endpoint never receives an environment key (only a key-file entry), and falls back to the heuristic", async () => {
    const s = scenario({ MY_JEV_KEY: KEY, TYPESAFE_API_KEY: KEY, EMINIAR_ADJUDICATOR_KEY: KEY });
    const stub = await newStub();
    expect(
      (await cli(s, ["adjudicator", "provider", "typesafe", "--base-url", stub.baseUrl])).code,
    ).toBe(0);
    await cli(s, ["adjudicator", "key", "set", "typesafe", "--from-env", "MY_JEV_KEY"]);
    expect((await cli(s, ["adjudicator", "enable"])).code).toBe(0);
    projectConfig(s, { adjudicator: { promptMode: "blocking" } });
    const r = await hook(s, promptPayload(s, sid(), SECRET_PROMPT));
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout))).toMatch(/adjudicator/i);
    expect(stub.seen).toEqual([]);
    const st = json<{ effective: string; degraded: string | null }>(
      await cli(s, ["adjudicator", "status", "--json"]),
    );
    expect(st).toMatchObject({ effective: "heuristic", degraded: "no_key" });
    // A key in the key file is what a loopback provider gets.
    const set = await cli(s, ["adjudicator", "key", "set", "typesafe"], {
      stdin: "SENTINEL-file-0000000000\n",
    });
    expect(set.code).toBe(0);
    await hook(
      s,
      promptPayload(
        s,
        sid(),
        "Rename the helper function in utils and update imports across files",
      ),
    );
    await until("the Jev request", () => stub.scoring.length >= 1);
    expect(stub.scoring[0]!.auth).toBe("Bearer SENTINEL-file-0000000000");
  });
});

// ---------------------------------------------------------------------------------------------

describe("a committed project config cannot redirect text or keys", () => {
  it("provider, endpoint, keyEnv, consent, budget and timeouts in eminiar.config.json are ignored", async () => {
    const KEY = "SENTINEL-trust-file-key-77aa91bc02de";
    const s = scenario({ LEAKME: "SENTINEL-trust-env-leakme-5521" });
    const real = await newStub();
    const evil = await newStub();
    await enableJev(s, real, KEY);
    projectConfig(s, {
      adjudicator: {
        promptMode: "blocking",
        provider: "openai-compatible",
        typesafe: { baseUrl: evil.baseUrl },
        openai: { preset: "custom", baseUrl: evil.baseUrl, model: "x" },
        keyEnv: "LEAKME",
        remoteConsent: true,
        privacy: { maxChars: 100000 },
        budget: { dailyUsd: 9999, dailyCalls: 999999 },
        timeouts: { promptMs: 60000 },
      },
    });
    const r = await hook(s, promptPayload(s, sid(), SECRET_PROMPT));
    expect(r.code).toBe(0);
    await until("the real stub", () => real.scoring.length >= 1);
    expect(real.scoring[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(evil.seen).toEqual([]);
    const st = json<{ configured: string; key: { source: string } }>(
      await cli(s, ["adjudicator", "status", "--json"]),
    );
    expect(st.configured).toBe("typesafe");
    expect(st.key.source).toBe("file");
    // Nothing of the env var named by the project file went anywhere.
    for (const x of [...real.seen, ...evil.seen])
      expect(`${x.auth}${x.body}`).not.toContain("SENTINEL-trust-env-leakme");
  });
});

// ---------------------------------------------------------------------------------------------

describe("a hostile provider that reflects the credential", () => {
  for (const mode of ["echo500", "echo401"] as const) {
    it(`${mode}: errors are scrubbed in hook.log, the DB, CLI and dashboard text`, async () => {
      const KEY = `SENTINEL-reflect-${mode}-5d2e8c1f9a7b3044`;
      const s = scenario();
      const stub = await newStub();
      stub.mode = mode;
      await enableJev(s, stub, KEY);
      projectConfig(s, { adjudicator: { promptMode: "blocking" } });
      for (let i = 0; i < 3; i++) {
        const r = await hook(
          s,
          promptPayload(
            s,
            sid(),
            `Rename the helper function number ${i} in utils and update imports`,
          ),
        );
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain(KEY);
      }
      expect(stub.scoring.length).toBeGreaterThanOrEqual(1);
      for (const args of [
        ["adjudicator", "test", "fix the failing unit test in the parser"],
        ["adjudicator", "test", "fix the failing unit test in the parser", "--json"],
        ["adjudicator", "status"],
        ["adjudicator", "status", "--json"],
        ["adjudicator", "stats", "--json"],
        ["doctor"],
      ]) {
        const o = await cli(s, args);
        expect(o.stdout + o.stderr, args.join(" ")).not.toContain(KEY);
      }
      const keyFile = join(s.home, "adjudicator.key");
      expect(filesContaining(s.home, [KEY], [keyFile])).toEqual([]);
      expect(dumpDatabases(s.home)).not.toContain(KEY);
      if (mode === "echo401") {
        // A rejected key locks the provider out and says so, without the key.
        const st = await cli(s, ["adjudicator", "status"]);
        expect(st.stdout).toMatch(/rejected|auth/i);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------

describe("circuit breaker and dead endpoints", () => {
  it("a stub returning 500: the breaker opens after 2 failures and later prompts never call it", async () => {
    const s = scenario();
    const stub = await newStub();
    stub.mode = "http500";
    await enableJev(s, stub, "SENTINEL-breaker-00000000000000");
    projectConfig(s, {
      adjudicator: { promptMode: "blocking" },
    });
    for (let i = 0; i < 6; i++) {
      const r = await hook(
        s,
        promptPayload(
          s,
          sid(),
          `Rename the helper function number ${i} in utils and update imports`,
        ),
      );
      expect(r.code).toBe(0);
      expect(JSON.stringify(JSON.parse(r.stdout))).toMatch(/adjudicator/i);
    }
    expect(stub.scoring.length).toBe(2);
    const st = json<{ breaker: { state: string } | null }>(
      await cli(s, ["adjudicator", "status", "--json"]),
    );
    expect(String(st.breaker?.state)).toMatch(/open/);
    const statuses = adjRows(s.home).map((x) => x.provider_status);
    expect(statuses.filter((x) => x === "http_error").length).toBe(2);
    expect(statuses.filter((x) => x === "breaker_open").length).toBeGreaterThanOrEqual(1);
  });

  it("a provider slower than the prompt budget: the hook still answers in time, from the heuristic", async () => {
    const s = scenario();
    const stub = await newStub();
    stub.mode = "slow";
    await enableJev(s, stub, "SENTINEL-slow-0000000000000000");
    projectConfig(s, { adjudicator: { promptMode: "blocking" } });
    globalConfig(s, { adjudicator: { timeouts: { promptMs: 500 } } });
    const session = sid();
    const r = await hook(
      s,
      promptPayload(
        s,
        session,
        "Rename the helper function in utils and update imports across files",
      ),
    );
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout))).toMatch(/adjudicator/i);
    // 500 ms budget + process start; far below the stub's 4 s answer.
    expect(r.ms).toBeLessThan(2000);
    expect(adjRows(s.home).find((x) => x.session_id === session)?.provider_status).toBe("timeout");
  });

  it("a malformed provider answer (HTTP 200, broken JSON) falls back without breaking the hook", async () => {
    const s = scenario();
    const stub = await newStub();
    stub.mode = "garbage";
    await enableJev(s, stub, "SENTINEL-garbage-0000000000000");
    projectConfig(s, { adjudicator: { promptMode: "blocking" } });
    const session = sid();
    const r = await hook(
      s,
      promptPayload(
        s,
        session,
        "Rename the helper function in utils and update imports across files",
      ),
    );
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout))).toMatch(/adjudicator/i);
    const row = adjRows(s.home).find((x) => x.session_id === session)!;
    expect(row.source).toBe("fallback");
    expect(row.provider_status).toBe("invalid");
  });

  it("a dead localhost port: hooks stay valid JSON, exit 0, log no stack traces", async () => {
    const s = scenario();
    const dead = await freeDeadPort();
    expect(
      (
        await cli(s, [
          "adjudicator",
          "provider",
          "typesafe",
          "--base-url",
          `http://127.0.0.1:${dead}/v1`,
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await cli(s, ["adjudicator", "key", "set", "typesafe"], {
          stdin: "SENTINEL-dead-0000000000000\n",
        })
      ).code,
    ).toBe(0);
    expect((await cli(s, ["adjudicator", "enable"])).code).toBe(0);
    projectConfig(s, { adjudicator: { promptMode: "blocking" } });
    for (let i = 0; i < 4; i++) {
      const r = await hook(
        s,
        promptPayload(
          s,
          sid(),
          `Rename the helper function number ${i} in utils and update imports`,
        ),
      );
      expect(r.code).toBe(0);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    }
    const log = existsSync(join(s.home, "hook.log"))
      ? readFileSync(join(s.home, "hook.log"), "utf8")
      : "";
    expect(log).not.toMatch(/\bat .*\.js:\d+/);
    expect(log).not.toContain("SENTINEL-dead");
    const st = json<{ breaker: { state: string } | null }>(
      await cli(s, ["adjudicator", "status", "--json"]),
    );
    expect(String(st.breaker?.state)).toMatch(/open/);
  });

  it("once the breaker is open a call adds at most 5 ms over the heuristic alone (engine, dead port)", async () => {
    const s = scenario();
    const dead = await freeDeadPort();
    const { getContext } = await import("../../src/context.js");
    const { getStorage } = await import("../../src/storage/index.js");
    const { adjudicate } = await import("../../src/adjudicator/engine.js");
    const { setKey } = await import("../../src/adjudicator/secrets.js");
    await inScenario(s, async () => {
      setKey("typesafe", "SENTINEL-engine-dead-0000000000");
      projectConfig(s, {});
      const ctx = getContext(s.root);
      const store = getStorage(ctx, { vectors: false }).adjudicator;
      const base = ctx.config.adjudicator;
      const jev = {
        ...base,
        enabled: true,
        provider: "typesafe" as const,
        typesafe: { ...base.typesafe, baseUrl: `http://127.0.0.1:${dead}/v1` },
        breaker: { failures: 2, cooldownSec: 120 },
      };
      const heur: typeof base = { ...base, enabled: true, provider: "heuristic" };
      const req = (n: number) => ({
        key: `k${n}`,
        surface: "agent" as const,
        text: `Rename the helper function number ${n} in utils and update imports across the repo`,
      });
      // Two failures open the breaker.
      for (let i = 0; i < 2; i++) {
        const [a] = await adjudicate([req(1000 + i)], {
          config: jev,
          store,
          context: "cli",
          call: "inline",
          budgetMs: 800,
        });
        expect(a!.verdict.providerStatus).toBe("http_error");
      }
      const [third] = await adjudicate([req(2000)], {
        config: jev,
        store,
        context: "cli",
        call: "inline",
        budgetMs: 800,
      });
      expect(third!.verdict.providerStatus).toBe("breaker_open");
      const time = async (config: typeof base, n0: number) => {
        const xs: number[] = [];
        for (let i = 0; i < 60; i++) {
          const t0 = performance.now();
          await adjudicate([req(n0 + i)], {
            config,
            store,
            context: "cli",
            call: "inline",
            budgetMs: 800,
            persist: false,
          });
          xs.push(performance.now() - t0);
        }
        xs.sort((a, b) => a - b);
        return xs[Math.floor(xs.length / 2)]!;
      };
      await time(heur, 5000); // warm
      const heurMs = await time(heur, 6000);
      const openMs = await time(jev, 7000);
      console.info(
        `breaker open: p50 ${openMs.toFixed(2)} ms vs heuristic-only ${heurMs.toFixed(2)} ms`,
      );
      expect(
        openMs - heurMs,
        `open ${openMs.toFixed(2)} ms vs heuristic ${heurMs.toFixed(2)} ms`,
      ).toBeLessThanOrEqual(5);
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe("eval offline", () => {
  it("`eminiar adjudicator eval --providers heuristic` runs with no network, even when a remote provider is configured", async () => {
    const s = scenario();
    const stub = await newStub();
    await enableJev(s, stub, "SENTINEL-eval-0000000000000000");
    const r = await cli(s, ["adjudicator", "eval", "--providers", "heuristic", "--json"], {
      timeoutMs: 60_000,
    });
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(JSON.stringify(report)).toMatch(/heuristic/);
    expect(stub.seen).toEqual([]);
    const text = await cli(s, ["adjudicator", "eval", "--providers", "heuristic"], {
      timeoutMs: 60_000,
    });
    expect(text.code).toBe(0);
    expect(stub.seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("onboarding with a scratch HOME", () => {
  const KEY = "SENTINEL-onboard-key-6c0d2e9b7a41f358";

  function checkOnboarded(home: string, root: string) {
    const keyFile = join(home, "adjudicator.key");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(keyFile, "utf8"))).toEqual({ typesafe: KEY });
    const rawCfg = readFileSync(join(home, "config.json"), "utf8");
    expect(rawCfg).not.toContain(KEY);
    const cfg = JSON.parse(rawCfg);
    expect(cfg.adjudicator.enabled).toBe(true);
    expect(cfg.adjudicator.provider).toBe("typesafe");
    expect(cfg.adjudicator.remoteConsent).toBe(true);
    expect(filesContaining(home, [KEY], [keyFile])).toEqual([]);
    expect(filesContaining(root, [KEY])).toEqual([]);
  }

  it("the install step (setupAdjudicator, --adjudicator=typesafe --accept-remote) writes a 0600 key file and a config without the key", async () => {
    const s = scenario();
    const saved = process.env.EMINIAR_HOME;
    process.env.EMINIAR_HOME = s.home;
    try {
      const { resetSecrets } = await import("../../src/adjudicator/secrets.js");
      const { setupAdjudicator } = await import("../../src/adjudicator/cli.js");
      resetSecrets();
      const lines: string[] = [];
      const asked: string[] = [];
      const result = await setupAdjudicator(
        {
          out: (l) => lines.push(l),
          err: (l) => lines.push(l),
          isTTY: true,
          ask: async (q) => {
            asked.push(q);
            return "";
          },
          askHidden: async () => KEY,
          readStdin: async () => "",
          env: {},
          now: Date.now,
        },
        { choice: "typesafe", acceptRemote: true, yes: false },
      );
      expect(result).toMatchObject({
        enabled: true,
        provider: "typesafe",
        remote: true,
        keyStored: true,
      });
      // The explicit flag and --accept-remote mean no consent question was needed.
      expect(asked.join("\n")).not.toMatch(/send|consent|\[y\/N\]/i);
      expect(lines.join("\n")).not.toContain(KEY);
      checkOnboarded(s.home, s.root);
    } finally {
      if (saved === undefined) delete process.env.EMINIAR_HOME;
      else process.env.EMINIAR_HOME = saved;
    }
  });

  it("install with the key on a non-TTY stdin stores no key and says how to set one", async () => {
    const s = scenario();
    const saved = process.env.EMINIAR_HOME;
    process.env.EMINIAR_HOME = s.home;
    try {
      const { resetSecrets } = await import("../../src/adjudicator/secrets.js");
      const { setupAdjudicator } = await import("../../src/adjudicator/cli.js");
      resetSecrets();
      const lines: string[] = [];
      const result = await setupAdjudicator(
        {
          out: (l) => lines.push(l),
          err: (l) => lines.push(l),
          isTTY: false,
          ask: async () => "",
          askHidden: async () => {
            throw new Error("no hidden prompt without a TTY");
          },
          readStdin: async () => `${KEY}\n`,
          env: {},
          now: Date.now,
        },
        { choice: "typesafe", acceptRemote: true, yes: true },
      );
      expect(result.enabled).toBe(true);
      expect(result.keyStored).toBeUndefined();
      expect(existsSync(join(s.home, "adjudicator.key"))).toBe(false);
      expect(lines.join("\n")).toMatch(/eminiar adjudicator key set typesafe/);
      expect(readFileSync(join(s.home, "config.json"), "utf8")).not.toContain(KEY);
    } finally {
      if (saved === undefined) delete process.env.EMINIAR_HOME;
      else process.env.EMINIAR_HOME = saved;
    }
  });

  it("the built CLI: enable --provider typesafe --accept-remote, then key set from stdin", async () => {
    const s = scenario();
    const en = await cli(s, ["adjudicator", "enable", "--provider", "typesafe", "--accept-remote"]);
    expect(en.code, en.stderr + en.stdout).toBe(0);
    // Before a key exists, the heuristic runs and status says why.
    const pre = json<{ degraded: string | null; effective: string }>(
      await cli(s, ["adjudicator", "status", "--json"]),
    );
    expect(pre.effective).toBe("heuristic");
    expect(pre.degraded).toBe("no_key");
    const set = await cli(s, ["adjudicator", "key", "set", "typesafe"], { stdin: `${KEY}\n` });
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout + set.stderr).not.toContain(KEY);
    checkOnboarded(s.home, s.root);
    const post = json<{
      effective: string;
      remote: boolean;
      consent: boolean;
      key: { source: string };
    }>(await cli(s, ["adjudicator", "status", "--json"]));
    expect(post).toMatchObject({ effective: "typesafe", remote: true, consent: true });
    expect(post.key.source).toBe("file");
  });

  it("without --accept-remote and without a TTY the remote provider is refused and nothing changes", async () => {
    const s = scenario();
    const en = await cli(s, ["adjudicator", "enable", "--provider", "typesafe"]);
    expect(en.code).toBe(1);
    expect(
      existsSync(join(s.home, "config.json"))
        ? readFileSync(join(s.home, "config.json"), "utf8")
        : "{}",
    ).not.toMatch(/"enabled":\s*true/);
    const yes = await cli(s, ["adjudicator", "enable", "--provider", "typesafe", "--yes"]);
    expect(yes.code).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// A minimal MCP client over stdio against dist/server.js.

interface RpcMsg {
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

async function mcpSession<T>(
  s: Scenario,
  env: Record<string, string | undefined>,
  fn: (rpc: (method: string, params: unknown) => Promise<RpcMsg>) => Promise<T>,
): Promise<T> {
  const e = { ...s.env, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const child = spawn("sh", [join(ROOT, "bin", "em-server")], {
    env: e,
    cwd: s.root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let buf = "";
  let stderr = "";
  const pending = new Map<number, { ok: (m: RpcMsg) => void; fail: (e: Error) => void }>();
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as RpcMsg;
      if (m.id !== undefined) {
        pending.get(m.id)?.ok(m);
        pending.delete(m.id);
      }
    }
  });
  // A server that dies at start-up fails the call at once, with its own stderr.
  child.on("exit", (code) => {
    for (const p of pending.values())
      p.fail(
        new Error(`the MCP server exited (${code}) before answering:\n${stderr.slice(0, 600)}`),
      );
    pending.clear();
  });
  let id = 0;
  const rpc = (method: string, params: unknown) =>
    new Promise<RpcMsg>((ok, fail) => {
      const n = ++id;
      const t = setTimeout(() => fail(new Error(`mcp ${method} timed out`)), 25_000);
      pending.set(n, {
        ok: (m) => {
          clearTimeout(t);
          ok(m);
        },
        fail: (e) => {
          clearTimeout(t);
          fail(e);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  try {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    return await fn(rpc);
  } finally {
    child.kill("SIGTERM");
    children.delete(child);
  }
}

async function mcpToolNames(
  s: Scenario,
  env: Record<string, string | undefined> = {},
): Promise<string[]> {
  return mcpSession(s, env, async (rpc) => {
    const r = await rpc("tools/list", {});
    return ((r.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
  });
}

async function mcpCall(
  s: Scenario,
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  env: Record<string, string | undefined> = {},
): Promise<string[]> {
  return mcpSession(s, env, async (rpc) => {
    const out: string[] = [];
    for (const c of calls) {
      const r = await rpc("tools/call", c);
      out.push(JSON.stringify(r.result ?? r.error));
    }
    return out;
  });
}

describe("MCP surface", () => {
  it("em_adjudicate is listed only while the adjudicator is enabled", async () => {
    const s = scenario();
    const off = await mcpToolNames(s);
    expect(off).toContain("em_execute");
    expect(off).not.toContain("em_adjudicate");
    expect((await cli(s, ["adjudicator", "enable"])).code).toBe(0);
    expect(await mcpToolNames(s)).toContain("em_adjudicate");
    // The kill switch beats the enabled config: no tool, no schema.
    const killed = await mcpToolNames(s, { EMINIAR_ADJUDICATOR: "0" });
    expect(killed).toContain("em_execute");
    expect(killed).not.toContain("em_adjudicate");
  });
});
