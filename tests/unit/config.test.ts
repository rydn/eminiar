import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, ownJson, PROJECT_RELATIVE_PATH_RE, parseJsonSafe } from "../../src/config.js";
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
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(
      join(root, "eminiar.config.json"),
      JSON.stringify({ routing: { mode: "bogus" } }),
    );
    expect(loadConfig(root).routing.mode).toBe("auto");
    vi.restoreAllMocks();
  });
});

describe("config layering: one bad layer, additive lists, unknown keys", () => {
  let home: string;
  let root: string;
  let err: { mock: { calls: unknown[][] } };
  const stderr = () => err.mock.calls.map((a) => String(a[0])).join("");
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "em-home-"));
    root = mkdtempSync(join(tmpdir(), "em-root-"));
    process.env.EMINIAR_HOME = home;
    err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    delete process.env.EMINIAR_HOME;
    delete process.env.EMINIAR_ROUTING_MODE;
    vi.restoreAllMocks();
  });
  const personal = (o: unknown) => writeFileSync(join(home, "config.json"), JSON.stringify(o));
  const project = (o: unknown) =>
    writeFileSync(join(root, "eminiar.config.json"), JSON.stringify(o));

  it("a bad personal value keeps the team's routing.mode enforce", () => {
    project({ routing: { mode: "enforce" }, search: { defaultLimit: 9 } });
    personal({ recall: { maxMemories: 50 }, sandbox: { timeoutMs: 5000 } });
    const c = loadConfig(root);
    expect([c.routing.mode, c.search.defaultLimit]).toEqual(["enforce", 9]);
    // The whole personal layer goes, its valid keys included; the bad value never applies.
    expect([c.recall.maxMemories, c.sandbox.timeoutMs]).toEqual([3, 60_000]);
    expect(stderr()).toContain(`invalid config in ${join(home, "config.json")}, ignoring it`);
    expect(stderr()).not.toContain("using defaults");
  });

  it("a bad project value drops only the project file, keeping the personal one", () => {
    personal({ routing: { mode: "enforce" }, recall: { maxDocs: 4 } });
    project({ routing: { mode: "annotate" }, recall: { maxMemories: 11 } });
    const c = loadConfig(root);
    expect([c.routing.mode, c.recall.maxDocs, c.recall.maxMemories]).toEqual(["enforce", 4, 3]);
    expect(stderr()).toContain("invalid config in eminiar.config.json, ignoring it");
  });

  it("env overrides still apply over a dropped layer", () => {
    project({ docs: { crawl: { depth: 9 } } });
    process.env.EMINIAR_ROUTING_MODE = "off";
    expect(loadConfig(root).routing.mode).toBe("off");
  });

  it("two bad layers fall back to the defaults", () => {
    personal({ recall: { repeatAfter: 5000 } });
    project({ docs: { crawl: { maxPages: 500 } } });
    const c = loadConfig(root);
    expect([c.recall.repeatAfter, c.docs.crawl.maxPages]).toEqual([10, 8]);
    expect(stderr()).toContain("invalid config in eminiar.config.json");
  });

  it("graph.exclude adds to the defaults and to the personal list", () => {
    const defaults = loadConfig(root).graph.exclude;
    expect(defaults).toContain("**/node_modules/**");
    personal({ graph: { exclude: ["**/tmp/**"] } });
    project({ graph: { exclude: ["**/generated/**", "**/node_modules/**"] } });
    const ex = loadConfig(root).graph.exclude;
    expect(ex).toEqual([...defaults, "**/tmp/**", "**/generated/**"]);
  });

  it('graph.exclude "!entry" removes a built-in default', () => {
    project({ graph: { exclude: ["!**/vendor/**", "!**/not-there/**"] } });
    let ex = loadConfig(root).graph.exclude;
    expect(ex).toContain("**/node_modules/**");
    expect(ex).not.toContain("**/vendor/**");
    expect(ex.some((e) => e.startsWith("!"))).toBe(false);
    personal({ graph: { exclude: ["!**/dist/**"] } });
    ex = loadConfig(root).graph.exclude;
    expect(ex).not.toContain("**/dist/**");
    expect(ex).not.toContain("**/vendor/**");
  });

  it('a project "!entry" cannot take back a personal graph.exclude entry', () => {
    personal({ graph: { exclude: ["**/private-client/**", "**/vendor/**"] } });
    project({ graph: { exclude: ["!**/private-client/**", "!**/vendor/**", "!**/build/**"] } });
    const ex = loadConfig(root).graph.exclude;
    expect(ex).toContain("**/private-client/**");
    // Also a default, but listed in the personal file: it stays.
    expect(ex).toContain("**/vendor/**");
    // A default nobody listed is still the project's to remove.
    expect(ex).not.toContain("**/build/**");
  });

  it("a project file adds deny rules and disabled languages but cannot remove personal ones", () => {
    personal({
      permissions: { extraDeny: ["Bash(rm -rf *)"] },
      sandbox: { disabledLanguages: ["javascript"] },
    });
    project({
      permissions: { extraDeny: [] },
      sandbox: { disabledLanguages: ["!javascript", "php"] },
    });
    let c = loadConfig(root);
    expect(c.permissions.extraDeny).toEqual(["Bash(rm -rf *)"]);
    // "!" is not a removal in the security lists: it stays a (harmless) literal entry.
    expect(c.sandbox.disabledLanguages).toEqual(["javascript", "!javascript", "php"]);
    project({ permissions: { extraDeny: ["Bash(curl *)", "Bash(rm -rf *)"] } });
    c = loadConfig(root);
    expect(c.permissions.extraDeny).toEqual(["Bash(rm -rf *)", "Bash(curl *)"]);
  });

  it("a non-list value in an additive list is still refused, for that layer only", () => {
    personal({ routing: { mode: "enforce" }, graph: { exclude: ["**/tmp/**"] } });
    project({ graph: { exclude: "**/generated/**" } });
    const c = loadConfig(root);
    expect(c.routing.mode).toBe("enforce");
    expect(c.graph.exclude).toContain("**/tmp/**");
    expect(c.graph.exclude).not.toContain("**/generated/**");
    expect(stderr()).toContain("invalid config in eminiar.config.json");
  });

  it("a non-list in an earlier layer is refused, not replaced by a later list", () => {
    const defaults = loadConfig(root).graph.exclude;
    personal({
      routing: { mode: "enforce" },
      graph: { exclude: "**/x/**" },
      permissions: { extraDeny: "Bash(rm *)" },
    });
    project({ graph: { exclude: ["**/gen/**"] }, permissions: { extraDeny: [] } });
    const c = loadConfig(root);
    expect(c.graph.exclude).toEqual([...defaults, "**/gen/**"]);
    expect(c.permissions.extraDeny).toEqual([]);
    // The personal file is invalid as a whole, so its routing.mode goes too, with a note.
    expect(c.routing.mode).toBe("auto");
    expect(stderr()).toContain(`invalid config in ${join(home, "config.json")}, ignoring it`);
  });

  it("a section that is not an object is refused, not spread into the merge", () => {
    personal({ permissions: { extraDeny: ["Bash(curl *)"] } });
    project({ routing: { mode: "enforce" }, permissions: "deny-all" });
    const c = loadConfig(root);
    expect(c.permissions.extraDeny).toEqual(["Bash(curl *)"]);
    expect(c.routing.mode).toBe("auto");
    expect(stderr()).toContain("invalid config in eminiar.config.json, ignoring it");
  });

  it("project weights.features that pass alone but overflow on merge cost only that field", () => {
    personal({
      permissions: { extraDeny: ["Bash(curl *)"] },
      routing: { mode: "enforce" },
      adjudicator: { weights: { features: { design: 2 } } },
    });
    const features = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`f${i}`, 1]));
    project({ search: { defaultLimit: 9 }, adjudicator: { weights: { features } } });
    const c = loadConfig(root);
    expect(c.permissions.extraDeny).toEqual(["Bash(curl *)"]);
    expect(c.routing.mode).toBe("enforce");
    expect(c.adjudicator.weights.features).toEqual({ design: 2 });
    expect(c.search.defaultLimit).toBe(9);
    expect(stderr()).toContain("ignoring adjudicator.weights.features in eminiar.config.json");
    expect(stderr()).not.toContain("using defaults");
  });

  it("project weights.tierCenters that overflow on merge cost only that field", () => {
    personal({
      permissions: { extraDeny: ["Bash(curl *)"] },
      routing: { mode: "enforce" },
      adjudicator: { weights: { tierCenters: { haiku: 1 } } },
    });
    const tierCenters = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`t${i}`, i]));
    project({ adjudicator: { weights: { tierCenters, lowConfidence: 0.3 } } });
    const c = loadConfig(root);
    expect(c.permissions.extraDeny).toEqual(["Bash(curl *)"]);
    expect(c.routing.mode).toBe("enforce");
    expect(c.adjudicator.weights.tierCenters.haiku).toBe(1);
    expect(c.adjudicator.weights.tierCenters.t0).toBeUndefined();
    expect(c.adjudicator.weights.lowConfidence).toBe(0.3);
    expect(stderr()).toContain("ignoring adjudicator.weights.tierCenters in eminiar.config.json");
    expect(stderr()).not.toContain("using defaults");
  });

  it("unknown keys are ignored and never invalidate a layer", () => {
    personal({ routing: { mode: "enforce" }, recall: { maxMemory: 5 }, nope: { x: 1 } });
    const c = loadConfig(root) as unknown as Record<string, Record<string, unknown>>;
    expect(c.routing?.mode).toBe("enforce");
    expect(c.recall?.maxMemory).toBeUndefined();
    expect(c.nope).toBeUndefined();
    expect(stderr()).toBe("");
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
