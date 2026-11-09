import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ConfigSchema, parseJsonSafe } from "../config.js";
import { getContext } from "../context.js";
import { type Check, runDoctor } from "../doctor.js";
import { contextModeInstalled, effectiveRoutingMode } from "../hooks/coexist.js";
import { paths } from "../paths.js";
import { loadPermissionRules } from "../permissions/settings.js";
import { availableLanguages } from "../sandbox/languages.js";
import { liveServers } from "../session/server-alive.js";
import { getStorage } from "../storage/index.js";
import {
  clearNeedsAuthEntry,
  needsAuthEntry,
  pluginCacheDirs,
  pluginInstalled,
  pluginInstallPath,
  readInstallRecord,
  settingsPath,
  writeJsonWithBackup,
} from "./claude-config.js";
import { cursorPresent, cursorStatus } from "./cursor.js";
import { stableRoot, stableVersion } from "./materialize.js";
import { pinNode, pinnedNode, pinnedRoot, pinRoot } from "./node-resolve.js";
import { pluginCacheStale, probeServer } from "./register.js";
import { run } from "./shell.js";

export interface HandshakeOptions {
  /** How long to wait for the child to exit after SIGTERM before SIGKILL (and again after SIGKILL before giving up). */
  exitMs?: number;
  /** Test seam: start the child. Defaults to `spawn(bin)` with piped stdio. */
  spawn?: (bin: string) => ChildProcess;
}

/**
 * Spawn a binary, send one MCP initialize request, expect a JSON-RPC reply within `ms`.
 * Resolves only after the child has exited: stdin is closed and SIGTERM sent, SIGKILL follows after
 * `exitMs`, and after a further `exitMs` it resolves regardless, so doctor never hangs or leaves the
 * server flushing (its compile cache lands in EMINIAR_HOME) after the CLI has returned.
 */
export function mcpHandshake(
  bin: string,
  ms = 15_000,
  opts: HandshakeOptions = {},
): Promise<string> {
  const exitMs = opts.exitMs ?? 2_000;
  const start = opts.spawn ?? ((b: string) => spawn(b, [], { stdio: ["pipe", "pipe", "pipe"] }));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = start(bin);
    } catch (e) {
      resolve(`spawn failed: ${(e as Error).message}`);
      return;
    }
    let buf = "";
    let err = "";
    let exited = child.exitCode !== null || child.signalCode !== null;
    let result: string | undefined;
    const timers: NodeJS.Timeout[] = [];
    const done = () => {
      for (const t of timers) clearTimeout(t);
      if (result !== undefined) resolve(result);
    };
    const finish = (r: string) => {
      if (result !== undefined) return;
      result = r;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      if (exited) return done();
      try {
        child.stdin?.end();
      } catch {}
      try {
        child.kill("SIGTERM");
      } catch {}
      timers.push(
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          timers.push(setTimeout(done, exitMs));
        }, exitMs),
      );
    };
    child.on("exit", () => {
      exited = true;
      if (result !== undefined) done();
    });
    child.on("error", (e) => {
      // A spawn failure never produces 'exit'; there is no process to wait for.
      if (child.pid === undefined) exited = true;
      finish(`spawn failed: ${e.message}`);
    });
    // EPIPE when the child dies before reading the request is reported via 'exit'/'error' above.
    child.stdin?.on("error", () => {});
    timers.push(
      setTimeout(
        () => finish(`no reply in ${ms / 1000}s${err ? `: ${err.trim().slice(-200)}` : ""}`),
        ms,
      ),
    );
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('"result"')) {
        const m = /"serverInfo":\{"name":"([^"]+)","version":"([^"]+)"/.exec(buf);
        finish(m ? `${m[1]} v${m[2]}` : "ok");
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "doctor", version: "0" } } })}\n`,
    );
  });
}

type Obj = Record<string, unknown>;

/** Every schema default except the adjudicator section (written only when the user enables it). */
function schemaDefaults(): Obj {
  const { adjudicator: _a, ...rest } = ConfigSchema.parse({});
  return rest;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `raw` without the keys whose value equals the current default, so a later default change
 * reaches the user again. Empty sections go too. `$schema` and the adjudicator section (not part
 * of schemaDefaults) are kept as they are.
 */
export function pruneDefaults(raw: Obj, defaults: Obj = schemaDefaults()): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) {
    const d = defaults[k];
    if (d === undefined) out[k] = v;
    else if (isObj(v) && isObj(d)) {
      const inner = pruneDefaults(v, d);
      if (Object.keys(inner).length) out[k] = inner;
    } else if (JSON.stringify(v) !== JSON.stringify(d)) out[k] = v;
  }
  return out;
}

/** graph.include / graph.exclude lists that are a strict subset of the current default list. */
export function staleGraphLists(raw: Obj): string[] {
  const graph = raw.graph;
  const defaults = schemaDefaults().graph as Record<string, string[]>;
  if (!isObj(graph)) return [];
  const out: string[] = [];
  for (const key of ["include", "exclude"] as const) {
    const list = graph[key];
    const def = defaults[key];
    if (!def || !Array.isArray(list)) continue;
    const missing = def.filter((e) => !list.includes(e));
    if (list.every((e) => def.includes(e as string)) && missing.length)
      out.push(
        `graph.${key} lacks current default entries (${missing.join(", ")}); remove the key to inherit the defaults`,
      );
  }
  return out;
}

/** Dotted paths of keys the schema does not define (typos pass as valid, then do nothing). */
export function unknownConfigKeys(raw: Obj): string[] {
  const schema = z.toJSONSchema(ConfigSchema, { io: "input" }) as Obj;
  const out: string[] = [];
  const walk = (value: Obj, node: unknown, prefix: string): void => {
    if (!isObj(node) || !isObj(node.properties) || isObj(node.additionalProperties)) return;
    for (const [k, v] of Object.entries(value)) {
      const child = (node.properties as Obj)[k];
      if (child === undefined) {
        if (!(prefix === "" && k === "$schema")) out.push(`${prefix}${k}`);
      } else if (isObj(v) && !(prefix === "" && k === "adjudicator"))
        walk(v, child, `${prefix}${k}.`);
    }
  };
  walk(raw, schema, "");
  return out;
}

/** Problems with one config file's raw content, worded for the doctor line. */
export function configWarnings(raw: Obj, root: string): string[] {
  const out = [...staleGraphLists(raw)];
  const unknown = unknownConfigKeys(raw);
  if (unknown.length) out.push(`unknown keys, ignored: ${unknown.join(", ")}`);
  const dir = isObj(raw.memories) ? raw.memories.dir : undefined;
  if (typeof dir === "string") {
    const rel = relative(root, resolve(root, dir));
    const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) out.push(`memories.dir "${dir}" resolves outside the project`);
  }
  return out;
}

/** A Bash deny rule only binds shell snippets; the other sandbox languages run unchecked. */
export function sandboxDenyWarning(
  root: string,
  config: ReturnType<typeof getContext>["config"],
): string | undefined {
  const deny = loadPermissionRules(root, config.permissions.extraDeny).deny;
  if (!deny.some((r) => r.tool === "Bash")) return undefined;
  const open = availableLanguages()
    .filter((l) => l.bin && l.id !== "shell" && !config.sandbox.disabledLanguages.includes(l.id))
    .map((l) => l.id);
  if (!open.length) return undefined;
  return `Bash deny rules exist but only shell snippets obey them; ${open.join(", ")} can run anything (disable with sandbox.disabledLanguages)`;
}

function readRawConfig(file: string): Obj | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = parseJsonSafe(readFileSync(file, "utf8"));
    return isObj(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Everything `runDoctor` checks plus installation, hooks, MCP and config.
 * With `fix`, re-pin node and the stable root, forget Claude Code's cached launch failure and
 * prune keys equal to the current default from ~/.eminiar/config.json (a .bak copy is kept).
 */
export async function fullDoctor(opts: { fix?: boolean } = {}): Promise<Check[]> {
  const rec = readInstallRecord();
  const stable = rec?.stableRoot ?? stableRoot();
  const hasStable = existsSync(join(stable, "dist", "server.js"));
  const bins = hasStable ? stable : join(process.argv[1] ?? "", "..", "..");
  const fixed: string[] = [];
  if (opts.fix && hasStable) {
    try {
      pinRoot(stable);
      fixed.push("root-path pinned");
      if (rec?.node) {
        pinNode(rec.node);
        fixed.push("node-path pinned");
      }
    } catch (err) {
      fixed.push(`pin failed: ${(err as Error).message}`);
    }
  }

  if (opts.fix) {
    const personal = readRawConfig(paths().configFile);
    if (personal) {
      const pruned = pruneDefaults(personal);
      if (JSON.stringify(pruned) !== JSON.stringify(personal)) {
        try {
          writeJsonWithBackup(paths().configFile, pruned);
          fixed.push("config.json pruned of default values");
        } catch (err) {
          fixed.push(`config prune failed: ${(err as Error).message}`);
        }
      }
    }
  }

  let ctxDb:
    | {
        config: ReturnType<typeof getContext>["config"];
        root: string;
        db?: ReturnType<typeof getStorage>;
      }
    | undefined;
  try {
    const ctx = getContext();
    ctxDb = { config: ctx.config, root: ctx.root };
    try {
      ctxDb.db = getStorage(ctx, { vectors: false });
    } catch {
      // the "project" check below reports a broken DB
    }
  } catch {
    ctxDb = undefined;
  }
  const checks = runDoctor(ctxDb ?? {});
  // runDoctor treats a missing pin as informational; for a plugin install it is the
  // difference between the desktop app connecting or not.
  if (rec?.method === "plugin" && !pinnedRoot()) {
    const c = checks.find((x) => x.name === "root-path pin");
    if (c) {
      c.ok = false;
      c.detail = `${c.detail}; Claude Code's cached plugin copy cannot start without it — run \`eminiar doctor --fix\``;
    }
  }

  checks.push({
    name: "install",
    ok: !!rec,
    detail: rec
      ? `v${rec.version} via ${rec.method === "none" ? "cursor" : rec.method}${rec.wrote.cursor && rec.method !== "none" ? " + cursor" : ""} at ${rec.installedAt.slice(0, 10)} (${rec.stableRoot})`
      : "not installed (run `npx eminiar install`)",
  });
  const pinned = pinnedNode();
  checks.push({
    name: "pinned node",
    ok: !!pinned,
    detail: pinned ? `${pinned.path} v${pinned.version}` : "none (hooks will use PATH node)",
  });

  if (rec?.method === "plugin" || !rec) {
    const reg = pluginInstalled("eminiar@eminiar");
    const stale = reg && hasStable ? pluginCacheStale(stable) : undefined;
    checks.push({
      name: "plugin registration",
      ok: (reg && !stale) || !rec,
      detail: reg
        ? stale
          ? `eminiar@eminiar installed but Claude Code's cached copy is out of date (${stale}); run \`eminiar upgrade\``
          : "eminiar@eminiar installed, cache matches the stable copy"
        : "not in installed_plugins.json",
    });
    // Claude Code launches the plugin from its cache (dist/ only, no node_modules). Start
    // every cached version the way Claude Code would; the registered one must pass.
    const live = pluginInstallPath("eminiar@eminiar");
    const dirs = pluginCacheDirs();
    if (dirs.length) {
      let liveOk = !live;
      const lines = dirs.map((dir) => {
        const bad = probeServer(dir);
        const isLive = dir === live;
        if (isLive) liveOk = !bad;
        const ver = dir.split("/").pop();
        const tag = isLive ? "registered" : "leftover, safe to delete";
        return `${ver} (${tag}): ${bad ?? "starts ok"}`;
      });
      const liveVer = live?.split("/").pop();
      const sv = stableVersion();
      const drift =
        live && liveVer && sv && liveVer !== sv
          ? `; cache is v${liveVer} but the stable copy is v${sv} — run \`eminiar upgrade\``
          : "";
      checks.push({
        name: "plugin cache copies",
        ok: liveOk,
        detail: `${lines.join(" · ")}${drift}${liveOk ? "" : " — run `eminiar doctor --fix`, then `eminiar upgrade` if it still fails"}`,
      });
    }
  } else if (rec.method === "settings") {
    const s = existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf8") : "";
    checks.push({
      name: "hooks in settings.json",
      ok: s.includes("em-hook"),
      detail: s.includes("em-hook") ? "present" : "missing",
    });
  }

  // Cursor: registered natively (install --cursor) or merely present on the machine.
  if (rec?.wrote.cursor || cursorPresent()) {
    const cs = cursorStatus();
    const registered = !!rec?.wrote.cursor;
    checks.push({
      name: "Cursor",
      ok: registered ? cs.hooks && cs.mcp : true,
      detail: registered
        ? `${cs.hooks ? `hooks on ${cs.events.length} events` : "hooks missing from ~/.cursor/hooks.json"} · ${cs.mcp ? "MCP server in ~/.cursor/mcp.json" : "MCP server missing from ~/.cursor/mcp.json"}${cs.hooks && cs.mcp ? "" : " — run `npx eminiar install --cursor`"}`
        : cs.hooks || cs.mcp
          ? "partly configured by hand; `npx eminiar install --cursor` completes and tracks it"
          : "installed but not registered; `npx eminiar install --cursor` adds hooks, MCP server and skills",
    });
    if (registered && rec?.method === "settings")
      checks.push({
        name: "Cursor third-party import",
        ok: false,
        detail:
          "Cursor also runs the Claude Code hooks in ~/.claude/settings.json (Settings → Agents → Third-Party Imports, on by default), so each event fires twice there; turn that setting off or reinstall Claude Code with `--method plugin`",
      });
  }

  // Claude Code remembers a plugin server that died at launch and skips it for ~15 min.
  const failed = needsAuthEntry();
  if (failed && opts.fix && clearNeedsAuthEntry()) fixed.push("cached launch failure cleared");
  const stillFailed = needsAuthEntry();
  checks.push({
    name: "Claude Code failure cache",
    ok: !stillFailed,
    detail: stillFailed
      ? `a failed launch at ${new Date(stillFailed.timestamp).toISOString()} is cached; Claude Code skips the server until ${new Date(stillFailed.timestamp + 15 * 60_000).toISOString()} — run \`eminiar doctor --fix\` to clear it, then restart Claude Code`
      : failed
        ? "cleared; restart Claude Code to reconnect"
        : "no cached launch failure",
  });
  if (opts.fix)
    checks.push({ name: "fix", ok: true, detail: fixed.join(", ") || "nothing to fix" });

  const hookBin = join(bins, "bin", "em-hook");
  if (existsSync(hookBin)) {
    const r = run(hookBin, ["--selftest"], { env: { ...process.env } });
    checks.push({
      name: "hook self-test",
      ok: r.ok && r.stdout.includes("eminiar hook ok"),
      detail: r.ok ? r.stdout.trim() : r.stderr.trim().slice(-200) || "failed",
    });
  }
  const serverBin = join(bins, "bin", "em-server");
  if (existsSync(serverBin)) {
    const reply = await mcpHandshake(serverBin);
    checks.push({ name: "MCP handshake", ok: /^eminiar v|^ok$/.test(reply), detail: reply });
  }

  try {
    const ctx = getContext();
    const db = getStorage(ctx, { vectors: false });
    checks.push({
      name: "project",
      ok: true,
      detail: `${ctx.root} · ${db.countDocuments()} docs · ${db.memoryCount()} memories · graph ${db.graphCounts().nodes} nodes`,
    });
    const cfgFile = join(ctx.root, "eminiar.config.json");
    if (existsSync(cfgFile)) {
      try {
        const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(cfgFile, "utf8")));
        checks.push({
          name: "eminiar.config.json",
          ok: parsed.success,
          detail: parsed.success
            ? "valid"
            : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
      } catch (err) {
        checks.push({ name: "eminiar.config.json", ok: false, detail: (err as Error).message });
      }
    }
    // Warnings: informational, they never fail the run.
    const warnings: string[] = [];
    for (const [label, file] of [
      ["~/.eminiar/config.json", paths().configFile],
      ["eminiar.config.json", cfgFile],
    ] as const) {
      const raw = readRawConfig(file);
      if (raw) for (const w of configWarnings(raw, ctx.root)) warnings.push(`${label}: ${w}`);
    }
    const denyWarn = sandboxDenyWarning(ctx.root, ctx.config);
    if (denyWarn) warnings.push(denyWarn);
    if (warnings.length)
      checks.push({
        name: "config warnings",
        ok: true,
        detail: `WARNING: ${warnings.join(" · ")}`,
      });
    const mode = effectiveRoutingMode(ctx.config);
    const cm = contextModeInstalled();
    checks.push({
      name: "routing",
      ok: !(mode === "enforce" && cm && ctx.config.routing.mode !== "auto"),
      detail: `${ctx.config.routing.mode} → ${mode}${cm ? " · context-mode installed (coexisting; run `eminiar replace-context-mode` when ready)" : ""}${mode === "enforce" && cm && ctx.config.routing.mode !== "auto" ? " · WARNING: enforce + context-mode will deny each other's suggestions" : ""}`,
    });
    const live = liveServers(ctx);
    checks.push({
      name: "MCP server",
      ok: true,
      detail: live.length
        ? `running for this project (pid ${live.join(", ")})`
        : "none running for this project right now; enforce routing annotates instead of denying until one connects",
    });
    // A project-scope .mcp.json cannot use plugin variables: Claude Code leaves
    // ${CLAUDE_PLUGIN_ROOT} empty there, so the server fails with ENOENT at startup.
    const projectMcp = join(ctx.root, ".mcp.json");
    if (existsSync(projectMcp)) {
      const raw = readFileSync(projectMcp, "utf8");
      const bad = raw.includes(`\${CLAUDE_PLUGIN_ROOT}`) && raw.includes("em-server");
      checks.push({
        name: "project .mcp.json",
        ok: !bad,
        detail: bad
          ? "registers em-server via the CLAUDE_PLUGIN_ROOT variable, which is empty for project-scope servers (ENOENT at startup); declare it under mcpServers in .claude-plugin/plugin.json instead"
          : "present, no eminiar entry using plugin variables",
      });
    }
  } catch (err) {
    checks.push({ name: "project", ok: false, detail: (err as Error).message });
  }
  // Live adjudicator probe (2 s): the provider's /models, or local server detection.
  if (ctxDb?.config.adjudicator.enabled) {
    try {
      const { adjudicatorLiveChecks } = await import("../adjudicator/cli.js");
      checks.push(...(await adjudicatorLiveChecks(ctxDb.config)));
    } catch (err) {
      checks.push({ name: "adjudicator probe", ok: false, detail: (err as Error).message });
    }
  }
  checks.push({
    name: "sandbox languages",
    ok: true,
    detail: availableLanguages()
      .filter((l) => l.bin)
      .map((l) => l.id)
      .join(", "),
  });
  return checks;
}
