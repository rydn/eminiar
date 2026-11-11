import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeJsonPath } from "../../src/install/claude-config.js";
import { registerSettings, unregisterSettings } from "../../src/install/register.js";

const repoHooks = fileURLToPath(new URL("../../hooks/hooks.json", import.meta.url));
type Entry = { matcher?: string; hooks: { type: string; command: string }[] };

const ENV = ["CLAUDE_CONFIG_DIR", "HOME", "EMINIAR_HOME"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let claudeDir: string;

beforeAll(() => {
  // The settings method also writes the MCP server to .claude.json: keep it off the real one.
  process.env.HOME = mkdtempSync(join(tmpdir(), "em-userhome-"));
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
});
beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "em-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A stable copy with the real hooks/hooks.json, the way materialize leaves it. */
function stableCopy(prefix = "em-stable-", hooksJson = readFileSync(repoHooks, "utf8")): string {
  const stable = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(stable, "bin"));
  mkdirSync(join(stable, "hooks"));
  writeFileSync(join(stable, "hooks", "hooks.json"), hooksJson);
  mkdirSync(join(stable, "skills", "em-docs"), { recursive: true });
  writeFileSync(join(stable, "skills", "em-docs", "SKILL.md"), "---\nname: em-docs\n---\n");
  return stable;
}
/** hooks.json's table as the settings method must write it for `stable`. */
function pluginTable(stable: string): Record<string, Entry[]> {
  const raw = readFileSync(repoHooks, "utf8").replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, () => stable);
  return JSON.parse(raw).hooks;
}
const settingsFile = () => join(claudeDir, "settings.json");
const writeSettings = (hooks: Record<string, Entry[]>) =>
  writeFileSync(settingsFile(), JSON.stringify({ hooks }));
const readHooks = () =>
  (JSON.parse(readFileSync(settingsFile(), "utf8")).hooks ?? {}) as Record<string, Entry[]>;
const hook = (command: string) => ({ type: "command", command });

describe("registerSettings", () => {
  it("writes the plugin's hooks.json entries and replaces an older registration", () => {
    const stable = stableCopy();
    const oldHook = hook(`"${join(stable, "bin", "em-hook")}"`);
    const mine = { matcher: "Bash", hooks: [hook("./hooks/mine.sh")] };
    // What an install before this change wrote: the narrow matcher, plus our entry on an event
    // hooks.json does not list.
    writeSettings({
      PreToolUse: [
        mine,
        {
          matcher: "^(Bash|Read|Grep|Glob|WebFetch|Agent|Task|mcp__.*__em_swarm)$",
          hooks: [{ ...oldHook, timeout: 10 } as Entry["hooks"][0]],
        },
      ],
      Notification: [{ hooks: [oldHook] }],
    });

    const wrote = registerSettings(stable);
    registerSettings(stable); // a second run must not duplicate

    const plugin = pluginTable(stable);
    const hooks = readHooks();
    expect(wrote.hookEvents).toEqual(Object.keys(plugin));
    expect(hooks).toEqual({ ...plugin, PreToolUse: [mine, ...(plugin.PreToolUse ?? [])] });
    expect(JSON.stringify(hooks)).not.toContain(`\${CLAUDE_PLUGIN_`);
    const matcher = new RegExp(hooks.PreToolUse?.[1]?.matcher ?? "$^");
    for (const tool of ["Edit", "MultiEdit", "Write", "WebSearch", "Bash", "Read"])
      expect(matcher.test(tool)).toBe(true);
    const cj = JSON.parse(readFileSync(claudeJsonPath(), "utf8"));
    expect(cj.mcpServers.eminiar.command).toBe(join(stable, "bin", "em-server"));

    // Uninstall sweeps every event too, not only the recorded ones.
    writeSettings({ ...readHooks(), Notification: [{ hooks: [oldHook] }] });
    unregisterSettings(stable, wrote);
    expect(readHooks()).toEqual({ PreToolUse: [mine] });
  });

  it("removes only our hooks: a user's hook in the same entry, or one running eminiar, stays", () => {
    const stable = stableCopy();
    const ours = hook(`"${join(stable, "bin", "em-hook")}"`);
    const lint = hook("./mine-lint.sh");
    const stats = hook("~/.eminiar/plugin/node_modules/.bin/eminiar stats --notify");
    writeSettings({
      PreToolUse: [{ matcher: "Bash", hooks: [lint, ours] }],
      Notification: [{ hooks: [stats] }],
    });

    const wrote = registerSettings(stable);
    const hooks = readHooks();
    expect(hooks.PreToolUse?.[0]).toEqual({ matcher: "Bash", hooks: [lint] });
    expect(hooks.Notification).toEqual([{ hooks: [stats] }]);

    unregisterSettings(stable, wrote);
    expect(readHooks()).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [lint] }],
      Notification: [{ hooks: [stats] }],
    });
  });

  it("keeps a user's `em-hook --gate` entry and tolerates malformed entries", () => {
    const stable = stableCopy();
    const gate = hook(`"${join(stable, "bin", "em-hook")}" --gate`);
    const ours = hook(`"${join(stable, "bin", "em-hook")}"`);
    writeSettings({
      PreToolUse: [{ matcher: "Bash", hooks: [gate, ours] }],
      Stop: [null, { matcher: "x", hooks: "nope" }, { hooks: [null, ours] }] as never,
    });

    const wrote = registerSettings(stable);
    expect(readHooks().PreToolUse?.[0]).toEqual({ matcher: "Bash", hooks: [gate] });

    unregisterSettings(stable, wrote);
    const left = readHooks();
    expect(left.PreToolUse).toEqual([{ matcher: "Bash", hooks: [gate] }]);
    expect(left.Stop).toEqual([null, { matcher: "x", hooks: "nope" }, { hooks: [null] }]);
  });

  it("keeps a user's `--gate` entry through an upgrade, quoted or not, without duplicating it", () => {
    const stable = stableCopy();
    const bin = join(stable, "bin", "em-hook");
    const gateQuoted = hook(`"${bin}" --gate`);
    const gatePlain = hook(`${bin} --gate`);
    const gateLegacy = hook(`"${join("/home/u", ".eminiar", "plugin", "bin", "em-hook")}" --gate`);
    writeSettings({
      PreToolUse: [{ matcher: "Bash", hooks: [gateQuoted, gatePlain, gateLegacy] }],
    });

    const wrote = registerSettings(stable);
    registerSettings(stable); // upgrade over an install
    registerSettings(stable);

    const gates = (readHooks().PreToolUse ?? [])
      .flatMap((e) => e.hooks)
      .filter((h) => h.command.endsWith("--gate"));
    expect(gates).toEqual([gateQuoted, gatePlain, gateLegacy]);
    unregisterSettings(stable, wrote);
    expect(readHooks()).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [gateQuoted, gatePlain, gateLegacy] }],
    });
  });

  it("tolerates malformed entries in every event on install, upgrade and uninstall", () => {
    const stable = stableCopy();
    const ours = hook(`"${join(stable, "bin", "em-hook")}"`);
    const junk = [null, 7, "x", { matcher: "m" }, { hooks: null }, { hooks: { a: 1 } }];
    const events = Object.keys(pluginTable(stable));
    const seeded = Object.fromEntries(
      events.map((ev) => [ev, [...junk, { hooks: [null, 3, ours] }]]),
    );
    writeFileSync(settingsFile(), JSON.stringify({ hooks: { ...seeded, Custom: "not-a-list" } }));

    let wrote!: ReturnType<typeof registerSettings>;
    expect(() => {
      wrote = registerSettings(stable);
      registerSettings(stable);
    }).not.toThrow();
    const hooks = readHooks() as Record<string, unknown>;
    expect(hooks.Custom).toBe("not-a-list");
    for (const ev of events) expect((hooks[ev] as unknown[]).slice(0, junk.length)).toEqual(junk);

    expect(() => unregisterSettings(stable, wrote)).not.toThrow();
    const left = readHooks() as Record<string, unknown>;
    expect(left.Custom).toBe("not-a-list");
    for (const ev of events) expect(left[ev]).toEqual([...junk, { hooks: [null, 3] }]);
  });

  it("copes with settings whose `hooks` is not an object holding lists", () => {
    const stable = stableCopy();
    writeFileSync(settingsFile(), JSON.stringify({ hooks: { Stop: null, Notification: {} } }));
    const wrote = registerSettings(stable);
    expect(readHooks().Stop).toEqual(pluginTable(stable).Stop);
    expect(() => unregisterSettings(stable, wrote)).not.toThrow();
  });

  it("raises `has no hooks` and leaves settings.json byte-identical on a refused install", () => {
    const stable = stableCopy("em-stable-", JSON.stringify({ name: "no table here" }));
    const original = `{\n  "theme": "dark",\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "./mine.sh"}]}]}\n}\n`;
    writeFileSync(settingsFile(), original);
    const cjBefore = (() => {
      try {
        return readFileSync(claudeJsonPath(), "utf8");
      } catch {
        return undefined;
      }
    })();

    expect(() => registerSettings(stable)).toThrow(/hooks\.json has no hooks/);
    expect(readFileSync(settingsFile(), "utf8")).toBe(original);
    const cjAfter = (() => {
      try {
        return readFileSync(claudeJsonPath(), "utf8");
      } catch {
        return undefined;
      }
    })();
    expect(cjAfter).toBe(cjBefore);
  });

  it("leaves settings.json byte-identical when hooks.json is unusable or missing", () => {
    const original = `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"./mine.sh"}]}]}}`;
    const bad = {
      hooks: { Stop: [{ hooks: [hook(`"\${CLAUDE_PLUGIN_DATA}/bin/em-hook"`)] }] },
    };
    const stable = stableCopy("em-stable-", JSON.stringify(bad));
    writeFileSync(settingsFile(), original);
    expect(() => registerSettings(stable)).toThrow(/cannot fill the variable/);
    expect(readFileSync(settingsFile(), "utf8")).toBe(original);
    rmSync(join(stable, "hooks", "hooks.json"));
    expect(() => registerSettings(stable)).toThrow(/is missing/);
    expect(readFileSync(settingsFile(), "utf8")).toBe(original);
  });

  it("fills a stable root holding `$&` or `$$` literally", () => {
    const stable = stableCopy("em-st$&$$-");
    registerSettings(stable);
    expect(readHooks().SessionStart?.[0]?.hooks[0]?.command).toBe(
      `"${join(stable, "bin", "em-hook")}"`,
    );
    expect(readHooks()).toEqual(pluginTable(stable));
  });

  it("refuses a hooks.json it cannot use rather than write broken commands", () => {
    const table = { hooks: { Stop: [{ hooks: [hook(`"\${CLAUDE_PLUGIN_DATA}/bin/em-hook"`)] }] } };
    const stable = stableCopy("em-stable-", JSON.stringify(table));
    expect(() => registerSettings(stable)).toThrow(/cannot fill the variable/);
    rmSync(join(stable, "hooks", "hooks.json"));
    expect(() => registerSettings(stable)).toThrow(/hooks\.json is missing/);
  });

  it("removes a hook written at the legacy or npm plugin path, and leaves no empty hooks object", () => {
    const stable = stableCopy();
    const gate = hook('"/x/.eminiar/plugin/bin/em-hook" --gate');
    writeSettings({
      Notification: [
        { hooks: [hook('"/Users/u/.eminiar/plugin/bin/em-hook"')] },
        { hooks: [hook("/Users/u/.eminiar/plugin/node_modules/eminiar/bin/em-hook")] },
        { hooks: [hook('"/Users/u/.eminiar/plugin/node_modules/eminiar/bin/em-hook" --gate')] },
      ],
    });
    const wrote = registerSettings(stable);
    expect(readHooks().Notification).toEqual([
      { hooks: [hook('"/Users/u/.eminiar/plugin/node_modules/eminiar/bin/em-hook" --gate')] },
    ]);
    unregisterSettings(stable, wrote);
    writeSettings({ Stop: [{ hooks: [gate] }] });
    expect(readHooks().Stop).toEqual([{ hooks: [gate] }]);

    // Nothing of the user's left: the `hooks` key itself goes.
    writeFileSync(settingsFile(), JSON.stringify({ theme: "dark" }));
    const w2 = registerSettings(stable);
    unregisterSettings(stable, w2);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({ theme: "dark" });
  });

  it("claims no hook events and leaves settings.hooks alone when it is not an object", () => {
    const stable = stableCopy();
    for (const bad of [[], "oops", 3]) {
      writeFileSync(settingsFile(), JSON.stringify({ hooks: bad }));
      const wrote = registerSettings(stable);
      expect(wrote.hookEvents).toEqual([]);
      expect(JSON.parse(readFileSync(settingsFile(), "utf8")).hooks).toEqual(bad);
      expect(() => unregisterSettings(stable, wrote)).not.toThrow();
    }
  });

  it("keeps a copy of a non-list event value it has to replace", () => {
    const stable = stableCopy();
    const original = JSON.stringify({ hooks: { Stop: "oops" } });
    writeFileSync(settingsFile(), original);
    registerSettings(stable);
    expect(readFileSync(`${settingsFile()}.eminiar.malformed.bak`, "utf8")).toBe(original);
    expect(readHooks().Stop).toEqual(pluginTable(stable).Stop);
  });

  it("refuses an unfilled CLAUDE_PLUGIN_ variable other than the root, in any event", () => {
    for (const v of ["CLAUDE_PLUGIN_DATA", "CLAUDE_PLUGIN_OTHER"]) {
      const table = {
        hooks: { Stop: [{ hooks: [hook(`"\${${v}}/x" "\${CLAUDE_PLUGIN_ROOT}/bin/em-hook"`)] }] },
      };
      const stable = stableCopy("em-stable-", JSON.stringify(table));
      expect(() => registerSettings(stable)).toThrow(/cannot fill the variable/);
    }
  });
});
