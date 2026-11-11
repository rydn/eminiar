import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetContextCache } from "../../src/context.js";
import {
  claudeJsonPath,
  pluginsDir,
  settingsPath,
  writeInstallRecord,
} from "../../src/install/claude-config.js";
import { fullDoctor } from "../../src/install/doctor.js";
import { registerSettings } from "../../src/install/register.js";
import { claudeConfigDir, claudeJsonFile, claudePluginsDir } from "../../src/paths.js";
import { checkCommand, loadPermissionRules } from "../../src/permissions/settings.js";
import { closeAllStorage } from "../../src/storage/index.js";
import { transcriptDirFor, claudeDir as transcriptsRoot } from "../../src/usage/ingest.js";

/**
 * With CLAUDE_CONFIG_DIR set, Claude Code keeps every ~/.claude file under that directory, and
 * .claude.json inside it (code.claude.com/docs/en/claude-directory). eminiar must use the same
 * files. Every test runs with a temp HOME and config dir.
 */
const KEYS = [
  "HOME",
  "EMINIAR_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "EMINIAR_CLAUDE_DIR",
  "EMINIAR_PROJECT_ROOT",
];
const saved: Record<string, string | undefined> = {};
let scratch: string[] = [];
let home: string;
let config: string;

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = tmp("em-cfg-home-");
  config = tmp("em-cfg-dir-");
  process.env.HOME = home;
  process.env.EMINIAR_HOME = join(home, ".eminiar");
});
afterEach(() => {
  closeAllStorage();
  resetContextCache();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch = [];
});

describe("Claude Code config paths", () => {
  it("default to ~/.claude and ~/.claude.json beside it", () => {
    expect(claudeConfigDir({}, "/h")).toBe(join("/h", ".claude"));
    expect(claudeJsonFile({}, "/h")).toBe(join("/h", ".claude.json"));
    expect(claudePluginsDir({}, "/h")).toBe(join("/h", ".claude", "plugins"));
    // A blank value counts as unset, as CLAUDE_CODE_PLUGIN_CACHE_DIR always did in agent-pin.
    const blank = { CLAUDE_CONFIG_DIR: " ", CLAUDE_CODE_PLUGIN_CACHE_DIR: " " };
    expect(claudeJsonFile(blank, "/h")).toBe(join("/h", ".claude.json"));
    expect(claudePluginsDir(blank, "/h")).toBe(join("/h", ".claude", "plugins"));
  });

  it("move under CLAUDE_CONFIG_DIR, .claude.json included; CLAUDE_CODE_PLUGIN_CACHE_DIR wins for plugins", () => {
    const env = { CLAUDE_CONFIG_DIR: "/c" };
    expect(claudeConfigDir(env, "/h")).toBe("/c");
    expect(claudeJsonFile(env, "/h")).toBe(join("/c", ".claude.json"));
    expect(claudePluginsDir(env, "/h")).toBe(join("/c", "plugins"));
    expect(claudePluginsDir({ ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "/p" }, "/h")).toBe("/p");
  });

  it("follow process.env and the home directory by default", () => {
    expect(settingsPath()).toBe(join(home, ".claude", "settings.json"));
    expect(claudeJsonPath()).toBe(join(home, ".claude.json"));
    process.env.CLAUDE_CONFIG_DIR = config;
    expect(settingsPath()).toBe(join(config, "settings.json"));
    expect(claudeJsonPath()).toBe(join(config, ".claude.json"));
    expect(pluginsDir()).toBe(join(config, "plugins"));
  });
});

describe("call sites under CLAUDE_CONFIG_DIR", () => {
  it("a settings-method install registers the MCP server in that account's .claude.json", () => {
    const stable = tmp("em-cfg-stable-");
    mkdirSync(join(stable, "skills", "em-x"), { recursive: true });
    writeFileSync(join(stable, "skills", "em-x", "SKILL.md"), "x");
    mkdirSync(join(stable, "hooks"));
    writeFileSync(
      join(stable, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `"\${CLAUDE_PLUGIN_ROOT}/bin/em-hook"` }] }],
        },
      }),
    );
    process.env.CLAUDE_CONFIG_DIR = config;
    registerSettings(stable);
    const cj = JSON.parse(readFileSync(join(config, ".claude.json"), "utf8"));
    expect(cj.mcpServers.eminiar.command).toBe(join(stable, "bin", "em-server"));
    expect(readFileSync(join(config, "settings.json"), "utf8")).toContain("em-hook");
    expect(existsSync(join(config, "skills", "em-x", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  it("permission rules come from that account's settings.json, re-read when it changes", () => {
    const root = tmp("em-cfg-root-");
    const user = join(home, ".claude", "settings.json");
    const other = join(config, "settings.json");
    mkdirSync(join(home, ".claude"));
    writeFileSync(user, JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }));
    writeFileSync(other, JSON.stringify({ permissions: { deny: ["Bash(sudo *)"] } }));
    // Same mtime on both, so only the file list can tell the cached rules apart.
    utimesSync(user, 1_700_000_000, 1_700_000_000);
    utimesSync(other, 1_700_000_000, 1_700_000_000);
    const allowed = (cmd: string) => checkCommand(loadPermissionRules(root), cmd).allowed;
    expect([allowed("rm -rf x"), allowed("sudo ls")]).toEqual([false, true]);
    process.env.CLAUDE_CONFIG_DIR = config;
    expect([allowed("rm -rf x"), allowed("sudo ls")]).toEqual([true, false]);
  });

  it("doctor looks for settings-method hooks in that account's settings.json", async () => {
    const project = tmp("em-cfg-proj-");
    writeFileSync(join(project, "package.json"), "{}");
    process.env.EMINIAR_PROJECT_ROOT = project;
    process.env.CLAUDE_CONFIG_DIR = config;
    mkdirSync(join(home, ".eminiar"));
    // A stable root without dist/: doctor then has no shims to self-test or handshake.
    writeInstallRecord({
      version: "0",
      method: "settings",
      node: process.execPath,
      stableRoot: tmp("em-cfg-stable-"),
      fromSpec: "x",
      installedAt: new Date().toISOString(),
      wrote: {},
    });
    writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: { Stop: ["em-hook"] } }));
    const checks = await fullDoctor();
    expect(checks.find((c) => c.name === "hooks in settings.json")).toMatchObject({
      ok: true,
      detail: "present",
    });
    expect(checks.map((c) => c.name)).not.toContain("hook self-test");
  });

  it("transcripts: EMINIAR_CLAUDE_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude", () => {
    expect(transcriptsRoot()).toBe(join(home, ".claude"));
    process.env.CLAUDE_CONFIG_DIR = config;
    expect(transcriptDirFor("/p/x")).toBe(join(config, "projects", "-p-x"));
    process.env.EMINIAR_CLAUDE_DIR = join(home, "override");
    expect(transcriptsRoot()).toBe(join(home, "override"));
  });
});
