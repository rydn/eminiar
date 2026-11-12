import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
export function isOurs(cmd: unknown, stable: string): cmd is string {
  return typeof cmd === "string" && (cmd.includes("/.eminiar/plugin/") || cmd.includes(stable));
}

/**
 * Is this hook command exactly what install writes: the hook binary alone, quoted or not, with no
 * arguments? A user's own `em-hook --gate` entry (the fail-closed swarm gate) and other eminiar
 * commands they hook up stay.
 */
function isOurHook(cmd: unknown, stable: string): boolean {
  if (typeof cmd !== "string") return false;
  // `<bin> --deadline <digits>` is the UserPromptSubmit entry's watchdog flag (bin/em-hook); any
  // other argument, `--gate` included, marks a command that is not ours.
  const bin = cmd
    .trim()
    .replace(/ --deadline [0-9]+$/, "")
    .replace(/^"(.*)"$/, "$1");
  // The stable copy, the legacy plugin path, and the npm-installed layout of any install root.
  return (
    bin === join(stable, "bin", "em-hook") ||
    bin.endsWith("/.eminiar/plugin/bin/em-hook") ||
    /\/\.eminiar\/plugin\/node_modules\/eminiar\/bin\/em-hook$/.test(bin)
  );
}

/**
 * Take eminiar's hooks out of every event, one hook at a time as `eminiar replace` does: a user's
 * hook that shares an entry with ours stays, and only an entry left with no hooks goes. Every
 * event, not only the ones hooks.json lists now, so an event it drops later is cleaned up too.
 */
function removeOurHooks(hooks: Record<string, unknown>, stable: string): void {
  for (const [ev, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = (list as Json[]).flatMap((entry) => {
      // A malformed entry or hooks list is the user's; leave it alone rather than throw.
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return [entry];
      const all = entry.hooks as Json[];
      const rest = all.filter((h) => !(h && isOurHook(h.command, stable)));
      if (rest.length === all.length) return [entry];
      return rest.length ? [{ ...entry, hooks: rest }] : [];
    });
    if (kept.length) hooks[ev] = kept;
    else if (list.length) delete hooks[ev];
  }
}

const PLUGIN_ROOT = `\${CLAUDE_PLUGIN_ROOT}`;

/**
 * The plugin's own hook table, hooks/hooks.json in the stable copy, with the plugin root filled
 * in. The settings method writes exactly this, so the two registrations cannot drift apart: a
 * hand-kept copy once lacked Edit, MultiEdit, Write and WebSearch, and settings installs never
 * got the before-edit recall.
 */
function settingsHooks(stable: string): Record<string, Json[]> {
  const file = join(stable, "hooks", "hooks.json");
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  const table = readJson(file).hooks as Record<string, Json[]> | undefined;
  if (!table) throw new Error(`${file} has no hooks`);
  const fill = (h: Json): Json => {
    if (typeof h.command !== "string") return h;
    // Settings hooks get no plugin variables, so one left unfilled would run a broken path.
    if (h.command.replaceAll(PLUGIN_ROOT, "").includes(`\${CLAUDE_PLUGIN_`))
      throw new Error(`${file}: the settings method cannot fill the variable in ${h.command}`);
    // A function, so a `$&` or `$$` in the path is not read as a replacement pattern.
    return { ...h, command: h.command.replaceAll(PLUGIN_ROOT, () => stable) };
  };
  const out: Record<string, Json[]> = {};
  for (const [ev, entries] of Object.entries(table)) {
    out[ev] = entries.map((entry) => ({
      ...entry,
      hooks: ((entry.hooks as Json[] | undefined) ?? []).map(fill),
    }));
  }
  return out;
}

/**
 * Merge our hook table into settings.hooks and write settings.json. Returns the events written,
 * or none when settings.hooks is not an object (an array would silently drop what we add): that
 * value is the user's, so it is left alone with a warning and the install record claims no hooks.
 */
function registerSettingsHooks(
  settings: Json,
  ours: Record<string, Json[]>,
  stable: string,
): string[] {
  const current = settings.hooks;
  if (
    current !== undefined &&
    current !== null &&
    (typeof current !== "object" || Array.isArray(current))
  ) {
    log.warn(
      "settings.json `hooks` is not an object; leaving it alone, so eminiar's hooks are not registered (fix it and re-run install)",
    );
    return [];
  }
  const hooks = (current as Record<string, unknown> | undefined | null) ?? {};
  // A re-install or upgrade replaces the previous registration whole.
  removeOurHooks(hooks, stable);
  const odd: string[] = [];
  for (const [ev, entries] of Object.entries(ours)) {
    const list = hooks[ev];
    if (list !== undefined && list !== null && !Array.isArray(list)) odd.push(ev);
    hooks[ev] = [...(Array.isArray(list) ? list : []), ...entries];
  }
  if (odd.length) {
    // Not the shared .eminiar.bak: a later write (statusline) would overwrite that one.
    const file = settingsPath();
    if (existsSync(file)) copyFileSync(file, `${file}.eminiar.malformed.bak`);
    log.warn(
      `settings.json hooks for ${odd.join(", ")} were not lists and were replaced; the original is kept in ${file}.eminiar.malformed.bak`,
    );
  }
  settings.hooks = hooks;
  writeJsonWithBackup(settingsPath(), settings);
  return Object.keys(ours);
}

/** Fallback: write hooks + MCP server directly, context-mode style. */
export function registerSettings(stable: string): InstallRecord["wrote"] {
  const settings = readJson(settingsPath());
  const ours = settingsHooks(stable);
  const hookEvents = registerSettingsHooks(settings, ours, stable);

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
  return { hookEvents, mcpServer: true, skills };
}

export function unregisterSettings(stable: string, wrote: InstallRecord["wrote"]): void {
  if (wrote.hookEvents?.length) {
    const settings = readJson(settingsPath());
    const hooks = (settings.hooks as Record<string, unknown> | undefined) ?? {};
    removeOurHooks(hooks, stable);
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
