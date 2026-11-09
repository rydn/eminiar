import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { minimalUserConfig, writeTeamFiles } from "../../src/install/install.js";

const saved = process.env.EMINIAR_HOME;
beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
});
afterAll(() => {
  if (saved === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = saved;
});

/** Dotted paths of every array in a JSON value. */
function arrayPaths(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) return [at];
  if (typeof v !== "object" || v === null) return [];
  return Object.entries(v).flatMap(([k, x]) => arrayPaths(x, at ? `${at}.${k}` : k));
}

describe("writeTeamFiles", () => {
  it("writes no list keys, so a teammate's personal lists and the defaults stay in force", () => {
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    writeFileSync(
      join(process.env.EMINIAR_HOME!, "config.json"),
      JSON.stringify({
        permissions: { extraDeny: ["Bash(kubectl *)"] },
        graph: { exclude: ["**/node_modules/**", "**/generated/**"] },
      }),
    );
    writeTeamFiles(root);
    const written = JSON.parse(readFileSync(join(root, "eminiar.config.json"), "utf8"));
    expect(arrayPaths(written)).toEqual([]);
    const cfg = loadConfig(root);
    expect(cfg.permissions.extraDeny).toEqual(["Bash(kubectl *)"]);
    expect(cfg.graph.exclude).toEqual(["**/node_modules/**", "**/generated/**"]);
    expect(cfg.index.docs).toEqual(["**/*.md", "**/*.mdx"]);
  });
});

describe("fresh ~/.eminiar/config.json", () => {
  it("holds only the schema pointer, so later default changes reach the user", () => {
    expect(Object.keys(minimalUserConfig())).toEqual(["$schema"]);
    const home = process.env.EMINIAR_HOME as string;
    const root = mkdtempSync(join(tmpdir(), "em-root-"));
    writeFileSync(join(home, "config.json"), JSON.stringify(minimalUserConfig()));
    const c = loadConfig(root);
    expect(c.graph.include).toEqual(ConfigSchema.parse({}).graph.include);
    expect(c.graph.include).toContain("**/*.py");
    expect(c.graph.exclude).toContain("**/.venv/**");
  });
});
