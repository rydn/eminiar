import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { writeTeamFiles } from "../../src/install/install.js";

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
    // graph.exclude adds up: the defaults stay, the personal entry is added once.
    expect(cfg.graph.exclude.filter((e) => e === "**/node_modules/**")).toHaveLength(1);
    expect(cfg.graph.exclude).toEqual(expect.arrayContaining(["**/dist/**", "**/generated/**"]));
    expect(cfg.index.docs).toEqual(["**/*.md", "**/*.mdx"]);
  });
});
