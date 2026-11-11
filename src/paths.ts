import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Root of all eminiar state. Override with EMINIAR_HOME (used by tests and the installer). */
export function eminiarHome(): string {
  return process.env.EMINIAR_HOME || join(homedir(), ".eminiar");
}

/**
 * Claude Code's configuration directory: CLAUDE_CONFIG_DIR, else ~/.claude. It holds the user
 * settings, agents, skills, plugins and transcripts (code.claude.com/docs/en/claude-directory).
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
}

/**
 * Claude Code's global config (account, user- and local-scope MCP servers): ~/.claude.json
 * beside ~/.claude, or inside CLAUDE_CONFIG_DIR when that is set.
 */
export function claudeJsonFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? join(dir, ".claude.json") : join(home, ".claude.json");
}

/** Claude Code's plugins root: CLAUDE_CODE_PLUGIN_CACHE_DIR, else plugins/ in the config dir. */
export function claudePluginsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim() || join(claudeConfigDir(env, home), "plugins");
}

export interface EminiarPaths {
  home: string;
  projects: string;
  models: string;
  tmp: string;
  plugin: string;
  globalDb: string;
  configFile: string;
  nodePathFile: string;
  /** Package root the bin/ shims fall back to when their own copy has no node_modules. */
  rootPathFile: string;
  installFile: string;
  hookLog: string;
  statuslineCache: string;
  /** Adjudicator provider keys (JSON, mode 0600); written only by `eminiar adjudicator key set`. */
  adjudicatorKey: string;
}

export function paths(): EminiarPaths {
  const home = eminiarHome();
  return {
    home,
    projects: join(home, "projects"),
    models: join(home, "models"),
    tmp: join(home, "tmp"),
    plugin: join(home, "plugin"),
    globalDb: join(home, "global.db"),
    configFile: join(home, "config.json"),
    nodePathFile: join(home, "node-path"),
    rootPathFile: join(home, "root-path"),
    installFile: join(home, "install.json"),
    hookLog: join(home, "hook.log"),
    statuslineCache: join(home, "statusline.cache"),
    adjudicatorKey: join(home, "adjudicator.key"),
  };
}

/** The home this process has already checked, so hooks pay for it once. */
let checkedHome: string | undefined;

/**
 * Whether an existing home is eminiar's own to tighten: the default ~/.eminiar, or a folder that
 * holds eminiar's global.db or install.json and nothing that is not eminiar's. An empty folder, or
 * one with only bare subfolders, does not count. EMINIAR_HOME can come from a repo's settings and
 * be relative ("." is the project), and a project or a shared folder keeps its owner's mode.
 */
function ownHome(p: EminiarPaths): boolean {
  if (p.home === join(homedir(), ".eminiar")) return true;
  const own = new Set([...Object.values(p).map((f) => basename(f)), "swarm.key", ".DS_Store"]);
  try {
    const names = readdirSync(p.home).map((n) => n.replace(/-(?:wal|shm|journal)$/, ""));
    const marked = names.includes(basename(p.globalDb)) || names.includes(basename(p.installFile));
    return marked && names.every((n) => own.has(n));
  } catch {
    return false;
  }
}

/**
 * Create the data directories. Idempotent and cheap; safe to call from hooks. On macOS and Linux
 * the home is the owner's alone (0700, like ~/.ssh): its databases and hook.log hold prompts and
 * command output. A home eminiar creates gets that mode; an existing one is tightened when it is
 * eminiar's own (ownHome) and looser than 0700. Best effort: a failed stat or chmod never throws.
 */
export function ensureDirs(): EminiarPaths {
  const p = paths();
  const created = mkdirSync(p.home, { recursive: true, mode: 0o700 });
  if (checkedHome !== p.home) {
    checkedHome = p.home;
    try {
      if (!created && statSync(p.home).mode & 0o077 && ownHome(p)) chmodSync(p.home, 0o700);
    } catch {
      // owned by someone else: leave it as its owner set it
    }
  }
  for (const dir of [p.projects, p.models, p.tmp]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}

/**
 * Make a database and its -wal / -shm files owner-only (0600). Call it right after opening and
 * before the first write: SQLite gives the sidecars the main file's mode, so a new database's
 * are created 0600, and an existing install's are tightened here. Never throws.
 */
export function restrictDbFiles(dbPath: string): void {
  if (dbPath === "" || dbPath === ":memory:") return;
  // SQLite gives -wal / -shm the main file's mode: a main file that is already owner-only needs
  // nothing, so a hook pays one stat per database instead of three chmods (two of them throwing).
  try {
    const st = statSync(dbPath, { throwIfNoEntry: false });
    if (st && (st.mode & 0o077) === 0) return;
  } catch {
    // fall through to the chmods
  }
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // no sidecar yet, or not ours to change
    }
  }
}

export function projectDir(projectId: string): string {
  const dir = join(paths().projects, projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectDbPath(projectId: string): string {
  return join(projectDir(projectId), "eminiar.db");
}
