#!/usr/bin/env node
// Benchmark the em_execute / em_batch_execute hot paths against the built server
// (dist/server.js) over real stdio, the way Claude Code drives it.
//
//   npm run build && node scripts/bench-hotpath.mjs [--runs 40] [--json]
//       [--only hooks|server] [--hook-runs 60] [--base <repo dir of a baseline build>] [--assert]
//
// Measures: cold start to first tools/list reply, round-trip latency for a tiny
// em_execute, em_batch_execute with 8 small commands, and em_execute on a large
// (≈400 KB) output with an intent. Uses a throwaway EMINIAR_HOME and project so
// nothing you have indexed is touched.
//
// The hook cases (bin/em-hook, a real process per call, one scratch EMINIAR_HOME each) measure what
// the adjudicator costs a hook: UserPromptSubmit and PreToolUse(Bash) with the adjudicator OFF
// (the default) against a baseline build when --base points at one (a checkout of the commit before
// the adjudicator, built with `npx tsup`, node_modules linked in), interleaved run by run; and an
// enabled heuristic UserPromptSubmit / Agent call. Budgets (--assert exits 1 when one is broken):
// disabled <= 1 ms p50 over the baseline; enabled heuristic UserPromptSubmit <= 150 ms p95.
//
// The security advice (adjudicator.security, off by default) is measured the same way: its own
// variants "security" (the routing adjudicator off) and "both", interleaved with the variant they
// extend, for UserPromptSubmit and PreToolUse(Agent). Budget: <= 10 ms p50 over that variant (the
// design's 10 ms p95 hook budget, measured as the added cost in the same run). With security off,
// the "off" check above already covers it: the default build has the switch off.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "dist", "server.js");
const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf("--runs") + 1]) || 40;
const JSON_OUT = args.includes("--json");
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const ONLY = arg("--only");
const HOOK_RUNS = Number(arg("--hook-runs")) || 60;
const BASE = arg("--base");
const ASSERT = args.includes("--assert");
const DO_SERVER = ONLY !== "hooks";
const DO_HOOKS = ONLY !== "server";

const home = mkdtempSync(join(tmpdir(), "em-bench-home-"));
const root = mkdtempSync(join(tmpdir(), "em-bench-root-"));
writeFileSync(join(root, "package.json"), "{}");
mkdirSync(join(root, ".git"));
// No embeddings (no model download), no code graph warm-up noise.
writeFileSync(
  join(root, "eminiar.config.json"),
  JSON.stringify({ embeddings: { enabled: false }, graph: { include: [] } }),
);

const env = {
  ...process.env,
  EMINIAR_HOME: home,
  EMINIAR_PROJECT_ROOT: root,
  EMINIAR_EMBEDDINGS: "0",
};

class Client {
  constructor() {
    this.id = 0;
    this.pending = new Map();
    this.buf = "";
    this.child = spawn(process.execPath, [SERVER], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p(msg);
        }
      }
    });
    this.stderr = "";
    this.child.stderr.on("data", (d) => {
      this.stderr += d;
    });
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bench", version: "0" },
    });
    this.notify("notifications/initialized", {});
  }
  call(name, a) {
    return this.request("tools/call", { name, arguments: a });
  }
  close() {
    this.child.kill("SIGTERM");
  }
}

const now = () => performance.now();
function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}
const fmt = (s) => `n=${s.n}  min ${s.min.toFixed(1)}  p50 ${s.p50.toFixed(1)}  p95 ${s.p95.toFixed(1)}  max ${s.max.toFixed(1)}  mean ${s.mean.toFixed(1)} ms`;

async function timed(fn) {
  const t = now();
  const r = await fn();
  return [now() - t, r];
}

const results = {};

if (DO_SERVER) {
// --- cold start: spawn → initialize → tools/list -------------------------------
{
  const xs = [];
  for (let i = 0; i < Math.min(RUNS, 10); i++) {
    const t = now();
    const c = new Client();
    await c.init();
    await c.request("tools/list", {});
    xs.push(now() - t);
    c.close();
    await new Promise((r) => c.child.on("exit", r));
  }
  results.coldStart = stats(xs);
}

const c = new Client();
await c.init();
await c.request("tools/list", {});

// Pre-warm once so the first-call costs (db open, migrations) are not in the steady-state numbers.
await c.call("em_execute", { language: "shell", code: "echo warm" });
await c.call("em_batch_execute", { commands: [{ label: "a", command: "echo warm" }] });

// --- em_execute, tiny shell ------------------------------------------------------
{
  const xs = [];
  for (let i = 0; i < RUNS; i++) {
    const [ms, r] = await timed(() => c.call("em_execute", { language: "shell", code: `echo hi ${i}` }));
    if (r.error || r.result?.isError) throw new Error(`em_execute failed: ${JSON.stringify(r).slice(0, 300)}`);
    xs.push(ms);
  }
  results.execTinyShell = stats(xs);
}

// --- raw spawn floor: what the shell itself costs ---------------------------------
{
  const xs = [];
  const sh = /\/(zsh|bash)$/.test(process.env.SHELL ?? "") ? process.env.SHELL : "bash";
  for (let i = 0; i < RUNS; i++) {
    const [ms] = await timed(
      () =>
        new Promise((resolve) => {
          const p = spawn(sh, ["-c", `echo hi ${i}`], { stdio: ["ignore", "pipe", "pipe"] });
          p.stdout.on("data", () => {});
          p.on("close", resolve);
        }),
    );
    xs.push(ms);
  }
  results.spawnFloor = stats(xs);
}

// --- em_execute, tiny javascript (node startup dominates) -------------------------
{
  const xs = [];
  for (let i = 0; i < Math.min(RUNS, 15); i++) {
    const [ms, r] = await timed(() => c.call("em_execute", { language: "javascript", code: `console.log(${i})` }));
    if (r.error || r.result?.isError) throw new Error(`em_execute js failed: ${JSON.stringify(r).slice(0, 300)}`);
    xs.push(ms);
  }
  results.execTinyJs = stats(xs);
}

// --- em_batch_execute, 8 tiny commands -----------------------------------------
{
  const xs = [];
  const commands = Array.from({ length: 8 }, (_, i) => ({ label: `cmd ${i}`, command: `echo batch ${i}; echo second line` }));
  for (let i = 0; i < Math.min(RUNS, 25); i++) {
    const [ms, r] = await timed(() => c.call("em_batch_execute", { commands, queries: ["second line"] }));
    if (r.error || r.result?.isError) throw new Error(`em_batch_execute failed: ${JSON.stringify(r).slice(0, 300)}`);
    xs.push(ms);
  }
  results.batch8Tiny = stats(xs);
}

// --- em_execute, large output (~400 KB) with intent -------------------------------
{
  const xs = [];
  const code =
    'for i in $(seq 1 12000); do echo "line $i: lorem ipsum dolor sit amet, consectetur $((i % 97)) adipiscing"; done; echo "ERROR: needle in the haystack at the end"';
  for (let i = 0; i < Math.min(RUNS, 8); i++) {
    const [ms, r] = await timed(() =>
      c.call("em_execute", { language: "shell", code, intent: "error needle", queries: ["haystack"] }),
    );
    if (r.error || r.result?.isError) throw new Error(`em_execute large failed: ${JSON.stringify(r).slice(0, 300)}`);
    xs.push(ms);
  }
  results.execLarge400k = stats(xs);
}

c.close();
}
rmSync(home, { recursive: true, force: true });
rmSync(root, { recursive: true, force: true });

// --- hooks: a real process per call, the adjudicator off vs a baseline build, and on -----------
const checks = [];
if (DO_HOOKS) {
  const pkgRoot = join(here, "..");
  /** A scratch HOME + project for one variant, so no variant sees another's state. */
  const variant = (name, repo, config, globalConfig) => {
    const h = mkdtempSync(join(tmpdir(), `em-bench-hook-home-${name}-`));
    const r = mkdtempSync(join(tmpdir(), `em-bench-hook-root-${name}-`));
    writeFileSync(join(r, "package.json"), "{}");
    mkdirSync(join(r, ".git"));
    writeFileSync(join(r, "eminiar.config.json"), JSON.stringify({ embeddings: { enabled: false }, graph: { include: [] }, ...config }));
    if (globalConfig) writeFileSync(join(h, "config.json"), JSON.stringify(globalConfig));
    const env = { ...process.env, EMINIAR_HOME: h, EMINIAR_PROJECT_ROOT: r, CLAUDE_PROJECT_DIR: r, EMINIAR_EMBEDDINGS: "0" };
    for (const k of Object.keys(env)) if (/^(EMINIAR_ADJUDICATOR|TYPESAFE_|CLAUDE_CODE_)/.test(k)) delete env[k];
    return { name, shim: join(repo, "bin", "em-hook"), env, cwd: r, home: h, root: r, cleanup: () => { rmSync(h, { recursive: true, force: true }); rmSync(r, { recursive: true, force: true }); } };
  };
  const payloads = {
    prompt: (v) => ({ session_id: "bench", cwd: v.root, hook_event_name: "UserPromptSubmit", prompt: "Refactor the whole payment module across the repo and add tests for the new flow" }),
    bash: (v) => ({ session_id: "bench", cwd: v.root, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } }),
    agent: (v) => ({ session_id: "bench", cwd: v.root, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "find the parser", prompt: "Find where the config parser is defined and list its callers." } }),
  };
  const once = (v, payload) =>
    new Promise((resolve, reject) => {
      const t = now();
      const p = spawn("sh", [v.shim], { env: v.env, cwd: v.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", () => {});
      p.on("error", reject);
      p.on("close", (code) => {
        const ms = now() - t;
        if (code !== 0) return reject(new Error(`${v.name}: hook exited ${code}`));
        try { JSON.parse(out || "{}"); } catch { return reject(new Error(`${v.name}: hook stdout is not JSON: ${out.slice(0, 120)}`)); }
        resolve(ms);
      });
      p.stdin.end(JSON.stringify(payload));
    });
  /** Interleaved: every round runs each variant once, alternating who goes first. */
  async function race(vs, kind, runs) {
    const xs = Object.fromEntries(vs.map((v) => [v.name, []]));
    for (let i = 0; i < 5; i++) for (const v of vs) await once(v, payloads[kind](v)); // warm
    for (let i = 0; i < runs; i++) {
      const order = i % 2 ? [...vs].reverse() : vs;
      for (const v of order) xs[v.name].push(await once(v, payloads[kind](v)));
    }
    return Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, stats(v)]));
  }
  const enabledHeuristic = { adjudicator: { enabled: true, provider: "heuristic", promptMode: "heuristic" } };
  const cur = variant("current", pkgRoot, {});
  const base = BASE ? variant("base", resolve(BASE), {}) : null;
  const on = variant("enabled", pkgRoot, enabledHeuristic);
  const securityOn = { adjudicator: { security: { enabled: true } } };
  const sec = variant("security", pkgRoot, {}, securityOn);
  const both = variant("both", pkgRoot, enabledHeuristic, securityOn);
  try {
    for (const kind of ["prompt", "bash"]) {
      const r = await race(base ? [base, cur] : [cur], kind, HOOK_RUNS);
      results[`hook.${kind}.disabled`] = r.current;
      if (base) {
        results[`hook.${kind}.base`] = r.base;
        const d50 = r.current.p50 - r.base.p50;
        checks.push({ name: `hook ${kind}: adjudicator off, p50 over baseline`, value: d50, budget: 1.0, unit: "ms", ok: d50 <= 1.0 });
      }
    }
    for (const kind of ["prompt", "agent"]) {
      const r = await race([cur, on, sec, both], kind, HOOK_RUNS);
      results[`hook.${kind}.enabledHeuristic`] = r.enabled;
      results[`hook.${kind}.securityOnly`] = r.security;
      results[`hook.${kind}.adjudicatorAndSecurity`] = r.both;
      if (kind === "prompt") checks.push({ name: "hook prompt: enabled heuristic, p95 incl. process", value: r.enabled.p95, budget: 150, unit: "ms", ok: r.enabled.p95 <= 150 });
      // What the security advice adds to the hook it rides on (same run, interleaved).
      const d1 = r.security.p50 - r.current.p50;
      const d2 = r.both.p50 - r.enabled.p50;
      checks.push({ name: `hook ${kind}: security on (adjudicator off), p50 over off`, value: d1, budget: 10, unit: "ms", ok: d1 <= 10 });
      checks.push({ name: `hook ${kind}: security on (adjudicator on), p50 over adjudicator alone`, value: d2, budget: 10, unit: "ms", ok: d2 <= 10 });
    }
  } finally {
    cur.cleanup();
    base?.cleanup();
    on.cleanup();
    sec.cleanup();
    both.cleanup();
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ results, checks }, null, 2));
} else {
  const w = Math.max(...Object.keys(results).map((k) => k.length));
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(w)}  ${fmt(v)}`);
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.value.toFixed(2)} ${c.unit} (budget ${c.budget} ${c.unit})`);
  if (DO_HOOKS && !BASE) console.log("note: no --base build given, so the adjudicator-off cost over a baseline was not measured");
}
if (ASSERT && checks.some((c) => !c.ok)) process.exit(1);
