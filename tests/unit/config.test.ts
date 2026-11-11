import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigSchema,
  loadConfig,
  ownJson,
  PROJECT_RELATIVE_PATH_RE,
  parseJsonSafe,
} from "../../src/config.js";
import { findProjectRoot, projectId } from "../../src/project.js";

describe("config", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
    delete process.env.EMINIAR_ROUTING_MODE;
  });

  it("uses defaults with no files", () => {
    const c = loadConfig(root);
    expect(c.routing.mode).toBe("auto");
    expect(c.sandbox.indexThreshold).toBe(5120);
  });

  it("project file overrides home file, env overrides both", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ routing: { mode: "off" } }));
    expect(loadConfig(root).routing.mode).toBe("off");
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "annotate" } }),
    );
    expect(loadConfig(root).routing.mode).toBe("annotate");
    process.env.EMINIAR_ROUTING_MODE = "enforce";
    expect(loadConfig(root).routing.mode).toBe("enforce");
  });

  it("falls back to defaults on invalid config", () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "bogus" } }),
    );
    expect(loadConfig(root).routing.mode).toBe("auto");
  });
});

describe("unsafe docs.manifest in a config layer (#152, #153)", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
    vi.restoreAllMocks();
  });

  it("drops only a bad personal docs.manifest, keeping the rest of the personal config", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const manifest of ["/Users/shared/docs.json", "../x.json", "a\n../b", 5]) {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({
          routing: { mode: "enforce" },
          docs: { manifest, ttlHours: 3 },
        }),
      );
      const c = loadConfig(root);
      expect([c.routing.mode, c.docs.manifest, c.docs.ttlHours], String(manifest)).toEqual([
        "enforce",
        ".eminiar/docs.json",
        3,
      ]);
    }
    const out = err.mock.calls.map((a) => String(a[0])).join("");
    expect(out).toContain("ignoring docs.manifest");
    expect(out).not.toContain("invalid config");
  });

  it("keeps a valid personal docs.manifest, and a bad project one falls back to it", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ docs: { manifest: "p/docs.json" } }));
    expect(loadConfig(root).docs.manifest).toBe("p/docs.json");
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ docs: { manifest: "/abs.json" } }),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(loadConfig(root).docs.manifest).toBe("p/docs.json");
  });

  it("the path check sees a .. segment after a line break and refuses control characters", () => {
    for (const m of ["a\n../b", "a/\n../b", "\n..", "a\r\n..\\b", "a\nb", "x\ty", "a\x7f"])
      expect(PROJECT_RELATIVE_PATH_RE.test(m), JSON.stringify(m)).toBe(false);
    // Windows trims trailing dots and spaces from a segment, so these name the parent there.
    for (const m of [".. /x.json", "a/... /b", "...", "a\\.. \\b", "docs/.. "])
      expect(PROJECT_RELATIVE_PATH_RE.test(m), JSON.stringify(m)).toBe(false);
    for (const m of [".eminiar/docs.json", "docs/..hidden/x.json", "a..b", "dir with space/m.json"])
      expect(PROJECT_RELATIVE_PATH_RE.test(m), m).toBe(true);
  });
});

describe("memories.dir schema rule", () => {
  it("accepts a project-relative directory and refuses one that leaves the project", () => {
    const ok = (dir: string) => ConfigSchema.safeParse({ memories: { dir } }).success;
    for (const dir of [".eminiar/memories", "notes/mem", "a..b"]) expect(ok(dir), dir).toBe(true);
    for (const dir of ["/abs/mem", "../mem", "a/../../mem", "C:\\m", ""])
      expect(ok(dir), dir).toBe(false);
  });
});

describe("unsafe memories.dir in a config layer", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
    vi.restoreAllMocks();
    for (const d of [home, root]) rmSync(d, { recursive: true, force: true });
  });

  it("drops only a project memories.dir that leaves the project, keeping the rest", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const dir of ["../../shared/memories", "/Users/shared/memories", "C:\\m", 5]) {
      writeFileSync(
        join(root, "eminiar.config.json"),
        JSON.stringify({ memories: { dir }, recall: { maxMemories: 5 } }),
      );
      const c = loadConfig(root);
      expect([c.memories.dir, c.recall.maxMemories], String(dir)).toEqual([".eminiar/memories", 5]);
    }
    const out = err.mock.calls.map((a) => String(a[0])).join("");
    expect(out).toContain("ignoring memories.dir");
    expect(out).not.toContain("invalid config");
  });

  it("keeps a valid personal memories.dir, which a bad project one falls back to", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(join(home, "config.json"), JSON.stringify({ memories: { dir: "notes/mem" } }));
    expect(loadConfig(root).memories.dir).toBe("notes/mem");
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ memories: { dir: "../elsewhere" } }),
    );
    expect(loadConfig(root).memories.dir).toBe("notes/mem");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ routing: { mode: "enforce" }, memories: { dir: "/abs/mem" } }),
    );
    const c = loadConfig(root);
    expect([c.routing.mode, c.memories.dir]).toEqual(["enforce", ".eminiar/memories"]);
  });
});

describe("prototype keys in config files (#62)", () => {
  let home: string;
  let root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
  });

  const unpolluted = () => {
    const probe: Record<string, unknown> = {};
    for (const k of ["routing", "mode", "adjudicator", "sandbox", "polluted"])
      expect(probe[k]).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("routing");
  };

  it("parseJsonSafe drops __proto__, constructor and prototype at every depth", () => {
    const v = parseJsonSafe(
      '{"a": {"__proto__": {"x": 1}, "b": [{"constructor": {"prototype": {"y": 2}}, "c": 3}]}, "prototype": 1, "__proto__": {"polluted": true}}',
    ) as { a: Record<string, unknown>; polluted?: unknown };
    expect(v).toEqual({ a: { b: [{ c: 3 }] } });
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(v.a)).toBe(Object.prototype);
    expect(v.a.x).toBeUndefined();
    expect(v.polluted).toBeUndefined();
    // ownJson copies own enumerable keys only: inherited ones are not read.
    const inherited = Object.create({ routing: { mode: "off" } }) as Record<string, unknown>;
    inherited.own = 1;
    expect(ownJson(inherited)).toEqual({ own: 1 });
    unpolluted();
  });

  it("a top-level __proto__ in the project file sets nothing, in any section", () => {
    writeFileSync(
      join(root, "eminiar.config.json"),
      '{"__proto__": {"routing": {"mode": "off"}, "sandbox": {"indexThreshold": 1}}, "embeddings": {"enabled": false}}',
    );
    const c = loadConfig(root);
    expect(c.routing.mode).toBe("auto");
    expect(c.sandbox.indexThreshold).toBe(5120);
    expect(c.embeddings.enabled).toBe(false); // the rest of the file still applies
    unpolluted();
  });

  it("a nested __proto__ or constructor.prototype in either file sets nothing", () => {
    writeFileSync(
      join(home, "config.json"),
      '{"routing": {"constructor": {"prototype": {"mode": "off"}}}, "constructor": {"prototype": {"sandbox": {"indexThreshold": 7}}}}',
    );
    writeFileSync(
      join(root, "eminiar.config.json"),
      '{"routing": {"__proto__": {"mode": "off"}}, "prototype": {"routing": {"mode": "off"}}}',
    );
    const c = loadConfig(root);
    expect(c.routing.mode).toBe("auto");
    expect(c.sandbox.indexThreshold).toBe(5120);
    unpolluted();
  });

  it("ordinary keys still merge: personal < project, nested objects combined", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ sandbox: { indexThreshold: 9000 }, routing: { mode: "off" } }),
    );
    writeFileSync(
      join(root, "eminiar.config.json"),
      '{"__proto__": {}, "routing": {"mode": "annotate"}}',
    );
    const c = loadConfig(root);
    expect([c.routing.mode, c.sandbox.indexThreshold]).toEqual(["annotate", 9000]);
    unpolluted();
  });
});

describe("project", () => {
  it("finds the root by marker and hashes it stably", () => {
    const root = mkdtempSync(join(tmpdir(), "em-proj-"));
    writeFileSync(join(root, "package.json"), "{}");
    const nested = join(root, "src", "deep");
    expect(findProjectRoot(nested)).toBe(root);
    expect(projectId(root)).toHaveLength(16);
    expect(projectId(root)).toBe(projectId(root));
  });
});
