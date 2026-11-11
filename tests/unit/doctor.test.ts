import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import { resetContextCache } from "../../src/context.js";
import {
  configWarnings,
  frozenDefaultCount,
  fullDoctor,
  pruneDefaults,
  sandboxDenyWarning,
  staleGraphLists,
  unknownConfigKeys,
} from "../../src/install/doctor.js";

describe("doctor config checks", () => {
  it("prunes keys equal to the current default and keeps the rest", () => {
    const d = ConfigSchema.parse({});
    const raw = {
      $schema: "x",
      routing: { mode: d.routing.mode, deferToContextMode: !d.routing.deferToContextMode },
      graph: { include: d.graph.include, exclude: ["**/mine/**"] },
      search: { defaultLimit: d.search.defaultLimit },
      adjudicator: { enabled: true },
    };
    expect(pruneDefaults(raw)).toEqual({
      $schema: "x",
      routing: { deferToContextMode: !d.routing.deferToContextMode },
      graph: { exclude: ["**/mine/**"] },
      adjudicator: { enabled: true },
    });
  });

  it("flags graph lists that are a stale subset of the defaults", () => {
    const stale = {
      graph: { include: ["**/*.ts", "**/*.js"], exclude: ["**/node_modules/**", "**/dist/**"] },
    };
    const out = staleGraphLists(stale);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("**/*.py");
    expect(staleGraphLists({ graph: { exclude: ["**/generated/**"] } })).toEqual([]);
    expect(staleGraphLists({ graph: { include: ConfigSchema.parse({}).graph.include } })).toEqual(
      [],
    );
  });

  it("warns on unknown keys but not on schema keys or $schema", () => {
    expect(
      unknownConfigKeys({ $schema: "x", routing: { mode: "off", modee: 1 }, grph: {} }).sort(),
    ).toEqual(["grph", "routing.modee"]);
    expect(unknownConfigKeys({ routing: { mode: "off" }, adjudicator: { whatever: 1 } })).toEqual(
      [],
    );
  });

  it("warns when memories.dir resolves outside the project", () => {
    const root = join(tmpdir(), "em-proj");
    expect(configWarnings({ memories: { dir: "../shared" } }, root).join()).toContain(
      "outside the project",
    );
    expect(configWarnings({ memories: { dir: "/etc/mem" } }, root).join()).toContain(
      "outside the project",
    );
    expect(configWarnings({ memories: { dir: ".eminiar/memories" } }, root)).toEqual([]);
    // an absolute path inside the project is fine
    expect(configWarnings({ memories: { dir: join(root, ".eminiar", "memories") } }, root)).toEqual(
      [],
    );
    // a name that merely starts with two dots is a child, not a parent escape
    expect(configWarnings({ memories: { dir: "..foo/mem" } }, root)).toEqual([]);
  });
});

describe("sandbox deny warning", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "em-claude-"));
  });
  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.parse(over);

  it("is silent without Bash deny rules", () => {
    expect(sandboxDenyWarning(root, cfg())).toBeUndefined();
  });

  it("warns when a Bash deny rule exists and non-shell languages are enabled", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Bash(sudo *)"] } }),
    );
    expect(sandboxDenyWarning(root, cfg())).toContain("only shell snippets obey them");
    const all = [
      "javascript",
      "typescript",
      "python",
      "ruby",
      "go",
      "php",
      "perl",
      "r",
      "elixir",
      "rust",
      "csharp",
    ];
    expect(sandboxDenyWarning(root, cfg({ sandbox: { disabledLanguages: all } }))).toBeUndefined();
  });
});

describe("doctor reports frozen defaults in ~/.eminiar/config.json", () => {
  const KEYS = ["HOME", "EMINIAR_HOME", "CLAUDE_CONFIG_DIR", "EMINIAR_PROJECT_ROOT"];
  const saved: Record<string, string | undefined> = {};
  let home: string;
  let cfgFile: string;

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    home = mkdtempSync(join(tmpdir(), "em-frozen-home-"));
    const project = mkdtempSync(join(tmpdir(), "em-frozen-proj-"));
    writeFileSync(join(project, "package.json"), "{}");
    process.env.HOME = home;
    process.env.EMINIAR_HOME = join(home, ".eminiar");
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    process.env.EMINIAR_PROJECT_ROOT = project;
    mkdirSync(join(home, ".eminiar"), { recursive: true });
    cfgFile = join(home, ".eminiar", "config.json");
    resetContextCache();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetContextCache();
  });

  const warning = async (opts: { fix?: boolean } = {}) =>
    (await fullDoctor(opts)).find((c) => c.name === "config warnings")?.detail ?? "";

  it("counts keys equal to the default", () => {
    const d = ConfigSchema.parse({});
    expect(frozenDefaultCount({})).toBe(0);
    expect(
      frozenDefaultCount({
        routing: { mode: d.routing.mode },
        search: { defaultLimit: d.search.defaultLimit + 1 },
      }),
    ).toBe(1);
  });

  it("warns without --fix, and neither warns after the prune", async () => {
    const d = ConfigSchema.parse({});
    writeFileSync(
      cfgFile,
      JSON.stringify({ routing: { mode: d.routing.mode }, search: { defaultLimit: 7 } }),
    );
    expect(await warning()).toMatch(/1 key equals the current default.*doctor --fix/);
    expect(await warning({ fix: true })).toBe("");
    expect(JSON.parse(readFileSync(cfgFile, "utf8"))).toEqual({ search: { defaultLimit: 7 } });
    expect(await warning()).toBe("");
  });

  it("--fix prunes a frozen config once, keeps the original as .bak and leaves a bad file alone", async () => {
    const d = ConfigSchema.parse({});
    // the pre-fix shape: defaults frozen in, with graph lists lacking a later default entry
    const frozen = {
      routing: { mode: d.routing.mode },
      graph: { include: d.graph.include.filter((g) => g !== "**/*.py"), exclude: d.graph.exclude },
      search: { defaultLimit: 7 },
    };
    const original = `${JSON.stringify(frozen, null, 2)}\n`;
    writeFileSync(cfgFile, original);
    const bak = `${cfgFile}.eminiar.bak`;

    const checks = await fullDoctor({ fix: true });
    const kept = JSON.parse(readFileSync(cfgFile, "utf8"));
    expect(kept).toEqual({
      graph: { include: frozen.graph.include },
      search: { defaultLimit: 7 },
    });
    expect(readFileSync(bak, "utf8")).toBe(original);
    expect(checks.find((c) => c.name === "fix")?.detail).toContain("pruned");
    expect(checks.find((c) => c.name === "config warnings")).toMatchObject({ ok: true });

    // a second run changes nothing and does not replace the backup with the pruned file
    const pruned = readFileSync(cfgFile, "utf8");
    const again = await fullDoctor({ fix: true });
    expect(readFileSync(cfgFile, "utf8")).toBe(pruned);
    expect(readFileSync(bak, "utf8")).toBe(original);
    expect(again.find((c) => c.name === "fix")?.detail ?? "").not.toContain("pruned");

    // a malformed file is not touched
    writeFileSync(cfgFile, "{ not json");
    rmSync(bak);
    await fullDoctor({ fix: true });
    expect(readFileSync(cfgFile, "utf8")).toBe("{ not json");
    expect(existsSync(bak)).toBe(false);
  });
});
