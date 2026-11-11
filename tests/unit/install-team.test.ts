import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { writeInstallRecord } from "../../src/install/claude-config.js";
import { writeTeamFiles } from "../../src/install/install.js";
import { registerSettings } from "../../src/install/register.js";
import { replaceContextMode } from "../../src/install/replace.js";
import { uninstall } from "../../src/install/uninstall.js";
import { paths } from "../../src/paths.js";

const saved = { home: process.env.EMINIAR_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
let claude: string;
beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  claude = mkdtempSync(join(tmpdir(), "em-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claude;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
  if (saved.home === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = saved.home;
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
});

const repoHooks = fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url));
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));

describe("writeTeamFiles: additions only", () => {
  it("writes routing only, so no default list is frozen into the repo", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    writeTeamFiles(root);
    const written = json(join(root, "eminiar.config.json"));
    expect(Object.keys(written).sort()).toEqual(["$schema", "routing"]);
    // Defaults such as venv/vendor excludes and the mdx doc glob still come from the package.
    const cfg = loadConfig(root);
    const d = ConfigSchema.parse({});
    expect(cfg.graph.exclude).toEqual(d.graph.exclude);
    expect(cfg.graph.exclude).toContain("**/.venv/**");
    expect(cfg.index.docs).toEqual(d.index.docs);
    expect(cfg.index.docs).toContain("**/*.mdx");
  });

  it("never overwrites an existing project config", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    writeFileSync(join(root, "eminiar.config.json"), '{"routing":{"mode":"off"}}');
    writeTeamFiles(root);
    expect(json(join(root, "eminiar.config.json"))).toEqual({ routing: { mode: "off" } });
  });
});

describe("writeTeamFiles: --marketplace", () => {
  it("adds a github marketplace and enables the plugin, keeping other settings", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "other@x": true }, model: "opus" }),
    );
    writeTeamFiles(root, "github:acme/plugins");
    const s = json(join(root, ".claude", "settings.json"));
    expect(s.extraKnownMarketplaces.eminiar).toEqual({
      source: { source: "github", repo: "acme/plugins" },
    });
    expect(s.enabledPlugins).toEqual({ "other@x": true, "eminiar@eminiar": true });
    expect(s.model).toBe("opus");
  });

  it("accepts a url source", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    writeTeamFiles(root, "https://example.com/m.json");
    expect(json(join(root, ".claude", "settings.json")).extraKnownMarketplaces.eminiar).toEqual({
      source: { source: "url", url: "https://example.com/m.json" },
    });
  });

  it("writes no .claude/settings.json without --marketplace", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    writeTeamFiles(root);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(false);
  });
});

describe("writeTeamFiles: --cursor rules", () => {
  it("copies rules/eminiar.mdc to .cursor/rules once and leaves an existing one alone", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    const stable = mkdtempSync(join(tmpdir(), "em-stable-"));
    mkdirSync(join(stable, "rules"));
    writeFileSync(join(stable, "rules", "eminiar.mdc"), "rule v1");
    writeTeamFiles(root, undefined, { cursor: true, stable });
    const dst = join(root, ".cursor", "rules", "eminiar.mdc");
    expect(readFileSync(dst, "utf8")).toBe("rule v1");
    writeFileSync(dst, "edited");
    writeFileSync(join(stable, "rules", "eminiar.mdc"), "rule v2");
    writeTeamFiles(root, undefined, { cursor: true, stable });
    expect(readFileSync(dst, "utf8")).toBe("edited");
  });

  it("writes no .cursor directory without --cursor", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    const stable = mkdtempSync(join(tmpdir(), "em-stable-"));
    mkdirSync(join(stable, "rules"));
    writeFileSync(join(stable, "rules", "eminiar.mdc"), "rule");
    writeTeamFiles(root, undefined, { stable });
    expect(existsSync(join(root, ".cursor"))).toBe(false);
  });
});

describe("replaceContextMode", () => {
  it("removes only context-mode hooks and keeps gateway env unless asked", async () => {
    const file = join(claude, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "node /x/context-mode/hooks/pre.mjs" }] },
            { hooks: [{ type: "command", command: "/keep/me" }] },
          ],
          Stop: [{ hooks: [{ type: "command", command: "node /x/context-mode/hooks/stop.mjs" }] }],
        },
        env: { ANTHROPIC_BASE_URL: "https://gw.context-mode.example", KEEP: "1" },
      }),
    );
    expect(await replaceContextMode({ yes: true })).toBe(0);
    const s = json(file);
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("/keep/me");
    expect(s.hooks.Stop).toBeUndefined();
    expect(s.env.ANTHROPIC_BASE_URL).toBeDefined();
    expect(await replaceContextMode({ yes: true, revertGateway: true })).toBe(0);
    expect(json(file).env).toEqual({ KEEP: "1" });
    expect(statSync(`${file}`).isFile()).toBe(true);
  });

  it("does nothing when context-mode is absent", async () => {
    writeFileSync(join(claude, "settings.json"), "{}");
    expect(await replaceContextMode({ yes: true })).toBe(0);
    expect(json(join(claude, "settings.json"))).toEqual({});
  });
});

describe("uninstall", () => {
  it("removes the hooks it registered, keeps foreign ones, and drops the install record", async () => {
    const stable = mkdtempSync(join(tmpdir(), "em-stable-"));
    mkdirSync(join(stable, "bin"));
    mkdirSync(join(stable, "hooks"));
    writeFileSync(join(stable, "hooks", "hooks.json"), readFileSync(repoHooks, "utf8"));
    mkdirSync(join(stable, "skills", "em-demo"), { recursive: true });
    writeFileSync(join(stable, "skills", "em-demo", "SKILL.md"), "demo");
    writeFileSync(
      join(claude, "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "/foreign/hook" }] }] },
      }),
    );
    const wrote = registerSettings(stable);
    expect(JSON.stringify(json(join(claude, "settings.json")))).toContain("em-hook");
    writeInstallRecord({
      version: "0.0.0",
      method: "settings",
      node: process.execPath,
      stableRoot: stable,
      fromSpec: "self",
      installedAt: "now",
      wrote,
    });
    expect(await uninstall({ yes: true })).toBe(0);
    const after = JSON.stringify(json(join(claude, "settings.json")));
    expect(after).not.toContain("em-hook");
    expect(after).toContain("/foreign/hook");
    expect(existsSync(paths().installFile)).toBe(false);
    expect(existsSync(join(claude, "skills", "em-demo"))).toBe(false);
    expect(existsSync(paths().home)).toBe(true);
  });
});
