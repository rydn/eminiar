import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The CLI commands that took a bad flag value and carried on: a bad --limit, a mistyped
 * reindex scope, broken pattern JSON, `graph find` without a query, `--help` of the two
 * commands that have their own help, and the search defaults. Runs the built CLI, so run
 * `npm run build` first.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

let home: string;
let proj: string;
const saved = { home: process.env.EMINIAR_HOME };

function cli(args: string[], cwd = proj) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, EMINIAR_HOME: home, EMINIAR_EMBEDDINGS: "0" },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function project(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "em-cli-"));
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "eminiar.config.json"), JSON.stringify(config));
  return dir;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "em-cli-home-"));
  proj = project({});
  for (const i of [1, 2, 3])
    writeFileSync(
      join(proj, `note-${i}.md`),
      `# Note ${i}\n\nThe zebra ledger reconciles quarterly, entry ${i}.\n`,
    );
  expect(cli(["index", "."]).code).toBe(0);
});
afterAll(() => {
  if (saved.home === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = saved.home;
});

describe("search", () => {
  it("rejects a --limit that is not a positive whole number", () => {
    for (const bad of ["abc", "0", "-3", "2.5"]) {
      const r = cli(["search", "zebra", "--limit", bad]);
      expect(r.code, bad).toBe(2);
      expect(r.err).toContain("--limit");
    }
  });

  it("uses search.defaultLimit when --limit is absent, and --limit wins over it", () => {
    const one = project({ search: { defaultLimit: 1 } });
    for (const i of [1, 2, 3])
      writeFileSync(join(one, `n${i}.md`), `# N${i}\n\nzebra ledger ${i}\n`);
    expect(cli(["index", "."], one).code).toBe(0);
    const hits = (args: string[]) => JSON.parse(cli(args, one).out).length as number;
    expect(hits(["search", "zebra ledger", "--json", "--lexical"])).toBe(1);
    expect(hits(["search", "zebra ledger", "--json", "--lexical", "--limit", "3"])).toBe(3);
  });
});

describe("reindex", () => {
  it("fails on a scope that does not exist", () => {
    const r = cli(["reindex", "--scope", "cod"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--scope");
  });
});

describe("graph", () => {
  it("exits 2 on broken pattern JSON without the doctor dump", () => {
    const r = cli(["graph", "pattern", "{not json"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not valid JSON");
    expect(r.err).not.toContain("eminiar doctor");
    expect(r.err).not.toMatch(/\bnode\b.*(ok|fail)/i);
  });

  it("treats `graph find` without a query as a usage error", () => {
    const r = cli(["graph", "find"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: eminiar graph find");
  });

  it("rejects a --limit that is not a positive whole number", () => {
    expect(cli(["graph", "hotspots", "--limit", "x"]).code).toBe(2);
  });
});

describe("--help", () => {
  it("prints the subcommand help for adjudicator and swarm", () => {
    const adj = cli(["adjudicator", "--help"]);
    expect(adj.code).toBe(0);
    expect(adj.out).toContain("eminiar adjudicator <command>");
    const swarm = cli(["swarm", "--help"]);
    expect(swarm.code).toBe(0);
    expect(swarm.out).toContain("usage: eminiar swarm");
  });

  it("lists the install flags the command parses", () => {
    const top = cli(["--help"]).out;
    expect(top).toContain("--marketplace");
    expect(top).toContain("--statusline");
  });
});

describe("usage ingest", () => {
  it("does nothing when usage.enabled is false", () => {
    const off = project({ usage: { enabled: false } });
    const r = cli(["usage", "ingest"], off);
    expect(r.code).toBe(0);
    expect(r.err).toContain("usage.enabled");
    expect(r.out).not.toContain("file(s) read");
  });
});
