import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  claudeJsonPath,
  type InstallRecord,
  type Json,
  marketplaceKnown,
  pluginInstalled,
  pluginInstallPath,
  readJson,
  settingsPath,
  writeJsonWithBackup,
} from "./claude-config.js";
import { claudeCli, log, run } from "./shell.js";

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStop",
  "PreCompact",
  "Stop",
  "SessionEnd",
];

/** Files whose content must match between the stable copy and Claude Code's cached copy. */
const CACHE_FINGERPRINT = [
  "dist/server.js",
  "dist/hook.js",
  ".claude-plugin/plugin.json",
  "bin/_resolve.sh",
  "bin/em-server",
  "bin/em-hook",
];

function fileHash(file: string): string | undefined {
  try {
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Run `bin/em-server --probe` from a package root. Success proves that copy can resolve
 * and load its dependencies the way Claude Code will launch it; undefined means ok.
 */
export function probeServer(root: string): string | undefined {
  const bin = join(root, "bin", "em-server");
  if (!existsSync(bin)) return "bin/em-server is missing";
  const r = run(bin, ["--probe"], { timeoutMs: 20_000 });
  if (r.ok && / ok /.test(r.stdout)) return undefined;
  // Node prints a stack with "Node.js vX" last; the useful line names the error or our shim.
  const lines = (r.stderr || r.stdout).trim().split("\n").filter(Boolean);
  const why = lines.find((l) => /Error|eminiar:/.test(l)) ?? lines.pop() ?? "no output";
  return `cannot start (${why.trim().slice(-220)})`;
}

/**
 * Claude Code copies a plugin into ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>
 * and `claude plugin update` is a no-op while the version number is unchanged, so a
 * re-packed dev build never reaches the running plugin. Compare content instead.
 */
export function pluginCacheStale(stable: string): string | undefined {
  const cache = pluginInstallPath("eminiar@eminiar");
  if (!cache || cache === stable) return undefined;
  if (!existsSync(cache)) return `${cache} is missing`;
  for (const rel of CACHE_FINGERPRINT) {
    if (fileHash(join(cache, rel)) !== fileHash(join(stable, rel))) return `${rel} differs`;
  }
  // The old plugin-root .mcp.json must not come back: as a project-scope file it fails
  // with ENOENT because ${CLAUDE_PLUGIN_ROOT} is empty there.
  if (existsSync(join(cache, ".mcp.json")) && !existsSync(join(stable, ".mcp.json")))
    return ".mcp.json is present in the cache but not in the stable copy";
  // Content matches; now prove the copy actually starts from where Claude Code runs it.
  // The cache has no node_modules, so this exercises the root-path fallback in bin/_resolve.sh.
  const probe = probeServer(cache);
  if (probe) return `cached copy ${probe}`;
  return undefined;
}

/** Register through Claude Code's plugin system (preferred). */
export function registerPlugin(stable: string): { ok: boolean; detail: string } {
  const claude = claudeCli();
  if (!claude) return { ok: false, detail: "claude CLI not on PATH" };
  if (!marketplaceKnown("eminiar")) {
    const add = run(claude, ["plugin", "marketplace", "add", stable]);
    if (!add.ok)
      return {
        ok: false,
        detail: `marketplace add failed: ${(add.stderr || add.stdout).trim().slice(-300)}`,
      };
  } else {
    run(claude, ["plugin", "marketplace", "update", "eminiar"]);
  }
  const fresh = () => run(claude, ["plugin", "install", "eminiar@eminiar", "--scope", "user"]);
  let inst = pluginInstalled("eminiar@eminiar")
    ? run(claude, ["plugin", "update", "eminiar@eminiar"])
    : fresh();
  let reinstalled = false;
  if (pluginInstalled("eminiar@eminiar") && pluginCacheStale(stable)) {
    // Same version, different content: `update` kept the old cache. Reinstall to refresh it.
    run(claude, ["plugin", "uninstall", "eminiar@eminiar"]);
    inst = fresh();
    reinstalled = true;
  }
  if (!inst.ok && !pluginInstalled("eminiar@eminiar")) {
    return {
      ok: false,
      detail: `plugin install failed: ${(inst.stderr || inst.stdout).trim().slice(-300)}`,
    };
  }
  const stale = pluginCacheStale(stable);
  if (stale) {
    return {
      ok: false,
      detail: `Claude Code's cached copy is out of date (${stale}); try \`claude plugin uninstall eminiar@eminiar\` then re-run`,
    };
  }
  return {
    ok: true,
    detail: pluginInstalled("eminiar@eminiar")
      ? `registered via claude plugin${reinstalled ? " (cache was stale; reinstalled)" : ""}`
      : "install command ran; verify with `claude plugin list`",
  };
}

export function unregisterPlugin(): void {
  const claude = claudeCli();
  if (!claude) return;
  run(claude, ["plugin", "uninstall", "eminiar@eminiar"]);
  run(claude, ["plugin", "marketplace", "remove", "eminiar"]);
}

/** Does a hook/server command string point at an eminiar binary (stable copy or `stable`)? */
export function isOurs(cmd: unknown, stable: string): boolean {
  return typeof cmd === "string" && (cmd.includes("/.eminiar/plugin/") || cmd.includes(stable));
}

/** Fallback: write hooks + MCP server directly, context-mode style. */
export function registerSettings(stable: string): InstallRecord["wrote"] {
  const settings = readJson(settingsPath());
  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
  const hookCmd = `"${join(stable, "bin", "em-hook")}"`;
  for (const ev of HOOK_EVENTS) {
    const list = (hooks[ev] as Json[] | undefined) ?? [];
    const filtered = list.filter(
      (entry) =>
        !((entry.hooks as Json[] | undefined) ?? []).some((h) => isOurs(h.command, stable)),
    );
    const entry: Json = {
      hooks: [{ type: "command", command: hookCmd, timeout: ev === "PreCompact" ? 15 : 10 }],
    };
    if (ev === "PreToolUse") entry.matcher = "Bash|Read|Grep|Glob|WebFetch|Agent|Task";
    if (ev === "PostToolUse" || ev === "PostToolUseFailure")
      (entry.hooks as Json[])[0]!.async = true;
    filtered.push(entry);
    hooks[ev] = filtered;
  }
  settings.hooks = hooks;
  writeJsonWithBackup(settingsPath(), settings);

  const cj = readJson(claudeJsonPath());
  const servers = (cj.mcpServers as Json | undefined) ?? {};
  servers.eminiar = {
    type: "stdio",
    command: join(stable, "bin", "em-server"),
    args: [],
    env: { EMINIAR_PLUGIN_ROOT: stable },
  };
  cj.mcpServers = servers;
  writeJsonWithBackup(claudeJsonPath(), cj);

  const skills: string[] = [];
  const skillsDir = join(settingsPath(), "..", "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const name of readdirSync(join(stable, "skills"))) {
    cpSync(join(stable, "skills", name), join(skillsDir, name), { recursive: true });
    skills.push(name);
  }
  return { hookEvents: HOOK_EVENTS, mcpServer: true, skills };
}

export function unregisterSettings(stable: string, wrote: InstallRecord["wrote"]): void {
  if (wrote.hookEvents?.length) {
    const settings = readJson(settingsPath());
    const hooks = (settings.hooks as Record<string, Json[]> | undefined) ?? {};
    for (const ev of wrote.hookEvents) {
      const list = hooks[ev];
      if (!list) continue;
      const kept = list.filter(
        (entry) =>
          !((entry.hooks as Json[] | undefined) ?? []).some((h) => isOurs(h.command, stable)),
      );
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;
    writeJsonWithBackup(settingsPath(), settings);
  }
  if (wrote.mcpServer) {
    const cj = readJson(claudeJsonPath());
    const servers = cj.mcpServers as Json | undefined;
    if (servers?.eminiar) {
      delete servers.eminiar;
      writeJsonWithBackup(claudeJsonPath(), cj);
    }
  }
  for (const name of wrote.skills ?? []) {
    const dir = join(settingsPath(), "..", "skills", name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

export function setStatusline(stable: string): boolean {
  const settings = readJson(settingsPath());
  if (settings.statusLine) {
    if (isOurs((settings.statusLine as Json).command, stable)) return true;
    log.warn(
      "a statusLine is already configured; leaving it alone (set it to `eminiar statusline` to show savings)",
    );
    return false;
  }
  settings.statusLine = {
    type: "command",
    command: `"${join(stable, "bin", "eminiar")}" statusline`,
  };
  writeJsonWithBackup(settingsPath(), settings);
  return true;
}

export function clearStatusline(stable: string): void {
  const settings = readJson(settingsPath());
  const sl = settings.statusLine as Json | undefined;
  if (sl && isOurs(sl.command, stable)) {
    delete settings.statusLine;
    writeJsonWithBackup(settingsPath(), settings);
  }
}
