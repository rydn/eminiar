import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import {
  configWarnings,
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
