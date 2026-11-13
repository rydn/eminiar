import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STARTER_YAML } from "../../src/swarm/config.js";
import type { SwarmDoc } from "../../src/swarm/doc-types.js";
import {
  deepEqual,
  docWarnings,
  hashText,
  lineDiff,
  readSwarmDoc,
  renderSwarmDoc,
  starterDoc,
} from "../../src/swarm/edit.js";

const BASE = `# header comment
version: 1
enabled: true # keep me on
swarms:
  team:
    description: A team
    topology: pipeline
    max_agents: 3
    stages: [writer, checker]
    agents:
      # the writer
      writer:
        description: Writes # writer note
        model: sonnet # model note
        prompt: |-
          Write the thing.
          Carefully.
      checker:
        description: Checks
        prompt: Check it.
`;

const clone = <T>(v: T): T => structuredClone(v);
const load = (text: string): SwarmDoc => {
  const dir = mkdtempSync(join(tmpdir(), "em-edit-load-"));
  try {
    mkdirSync(join(dir, ".eminiar"));
    writeFileSync(join(dir, ".eminiar/swarm.yaml"), text);
    const read = readSwarmDoc(dir);
    if (!read.doc) throw new Error("no doc");
    return read.doc;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

function ok(r: ReturnType<typeof renderSwarmDoc>) {
  if (!r.ok) throw new Error(`render failed: ${r.code}: ${r.error}`);
  return r;
}

describe("renderSwarmDoc", () => {
  it("round-trips an unchanged doc byte-identical", () => {
    const r = ok(renderSwarmDoc(BASE, load(BASE)));
    expect(r.text).toBe(BASE);
    expect(r.changed).toBe(false);
    expect(r.result.state).toBe("ok");
  });

  it("keeps a scalar's line comment and a block literal's style on edit", () => {
    const doc = load(BASE);
    doc.swarms.team!.agents.writer!.model = "opus";
    doc.swarms.team!.agents.writer!.prompt = "Write it.\nSlowly.";
    const r = ok(renderSwarmDoc(BASE, doc));
    expect(r.changed).toBe(true);
    expect(r.text).toContain("model: opus # model note");
    expect(r.text).toContain("prompt: |-\n          Write it.\n          Slowly.");
    expect(r.text).toContain("# header comment");
    expect(r.text).toContain("enabled: true # keep me on");
  });

  it("renames a role, keeping its comments and rewriting stages", () => {
    const doc = load(BASE);
    const agents = doc.swarms.team!.agents;
    agents.author = agents.writer!;
    delete agents.writer;
    doc.swarms.team!.stages = ["author", "checker"];
    const r = ok(renderSwarmDoc(BASE, doc, [{ swarm: "team", role: "writer", to: "author" }]));
    expect(r.text).toContain("# the writer");
    expect(r.text).toContain("author:");
    expect(r.text).not.toContain("writer:");
    expect(r.text).toContain("description: Writes # writer note");
    expect(r.text).toContain("stages: [author, checker]");
    expect(r.result.state).toBe("ok");
  });

  it("renames a swarm", () => {
    const doc = load(BASE);
    doc.swarms.crew = doc.swarms.team!;
    delete doc.swarms.team;
    const r = ok(renderSwarmDoc(BASE, doc, [{ swarm: "team", to: "crew" }]));
    expect(r.text).toContain("\n  crew:\n");
    expect(r.text).not.toContain("team:");
  });

  it("refuses a rename onto an existing name or of a missing one", () => {
    const doc = load(BASE);
    const clash = renderSwarmDoc(BASE, doc, [{ swarm: "team", role: "writer", to: "checker" }]);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.code).toBe("rename");
    const gone = renderSwarmDoc(BASE, doc, [{ swarm: "team", role: "ghost", to: "x" }]);
    expect(gone.ok).toBe(false);
  });

  it("adds a role in conventional key order and a swarm from nothing", () => {
    const doc = load(BASE);
    doc.swarms.team!.agents.editor = { prompt: "Edit.", model: "haiku", description: "Edits" };
    const r = ok(renderSwarmDoc(BASE, doc));
    const at = (s: string) => r.text.indexOf(s);
    const block = r.text.slice(at("editor:"));
    expect(block.indexOf("description")).toBeLessThan(block.indexOf("model"));
    expect(block.indexOf("model")).toBeLessThan(block.indexOf("prompt"));
  });

  it("writes tools_profile after isolation and before tools", () => {
    const doc = load(BASE);
    doc.swarms.team!.agents.scout = {
      tools: ["Read"],
      tools_profile: "readonly",
      isolation: "worktree",
      description: "Looks",
    } as never;
    const r = ok(renderSwarmDoc(BASE, doc));
    const block = r.text.slice(r.text.indexOf("scout:"));
    const at = (k: string) => block.indexOf(`${k}:`);
    expect(at("description")).toBeLessThan(at("isolation"));
    expect(at("isolation")).toBeLessThan(at("tools_profile"));
    expect(at("tools_profile")).toBeLessThan(at("tools"));
  });

  it("deletes a role and keeps a valid file", () => {
    const doc = load(BASE);
    delete doc.swarms.team!.agents.checker;
    doc.swarms.team!.stages = ["writer"];
    const r = ok(renderSwarmDoc(BASE, doc));
    expect(r.text).not.toContain("checker");
    expect(r.result.state).toBe("ok");
  });

  it("reports the validator's issues for an invalid draft without throwing", () => {
    const doc = load(BASE);
    doc.swarms.team!.max_agents = 99;
    const r = ok(renderSwarmDoc(BASE, doc));
    expect(r.result.state).toBe("invalid");
  });

  it("creates from the starter, keeping its header comments", () => {
    const r = ok(renderSwarmDoc(null, starterDoc()));
    expect(r.changed).toBe(true);
    expect(r.text).toBe(STARTER_YAML);
  });

  it("rejects an edit at an aliased (locked) path", () => {
    const text = `version: 1
x-common: &common
  description: shared
  prompt: Shared prompt.
swarms:
  one:
    description: One
    agents:
      a:
        <<: *common
        model: sonnet
`;
    const doc = load(text);
    doc.swarms.one!.agents.a!.prompt = "Changed";
    const r = renderSwarmDoc(text, doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["locked", "mismatch"]).toContain(r.code);
    // an unchanged doc still round-trips
    expect(ok(renderSwarmDoc(text, load(text))).text).toBe(text);
  });

  it("rejects an edit to x-* keys and role hooks", () => {
    const text = `version: 1
x-note: &note
  a: 1
swarms:
  one:
    description: One
    agents:
      a:
        description: A
        prompt: P
        hooks:
          Stop:
            - hooks:
                - type: command
                  command: echo done
`;
    const doc = load(text);
    doc["x-note"] = { a: 2 };
    const a = renderSwarmDoc(text, doc);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("locked");

    const doc2 = load(text);
    doc2.swarms.one!.agents.a!.hooks = {};
    const b = renderSwarmDoc(text, doc2);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe("locked");
  });

  it("fires the enforce guard when the line is not greppable", () => {
    const text = `version: 1
enforce: !!bool true
swarms:
  one:
    description: One
    agents:
      a:
        description: A
        prompt: P
`;
    const doc = load(text);
    doc.swarms.one!.description = "One!";
    const r = renderSwarmDoc(text, doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("enforce");
  });

  it("refuses a base file with YAML errors", () => {
    const r = renderSwarmDoc("swarms: [unclosed\n", { swarms: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("yaml");
  });

  it("preserves CRLF line endings", () => {
    const crlf = BASE.replace(/\n/g, "\r\n");
    const doc = load(crlf);
    doc.swarms.team!.max_agents = 2;
    const r = ok(renderSwarmDoc(crlf, doc));
    expect(r.text).toContain("max_agents: 2\r\n");
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("splices a scalar into a mixed line-ending file without touching other bytes", () => {
    const base =
      "version: 1\r\nswarms:\n  a:\n    description: A\n    agents:\n      w:\n        description: W\n        prompt: p";
    const doc = load(base);
    doc.swarms.a!.description = "B";
    const r = ok(renderSwarmDoc(base, doc));
    expect(r.text).toBe(base.replace("description: A", "description: B"));
    expect(r.changed).toBe(true);
  });

  it("keeps x-* keys holding .inf and .nan when the form sends null for them", () => {
    for (const v of [".inf", "-.inf", ".nan"]) {
      const base = `x-meta: ${v}\n${BASE}`;
      const doc = load(base) as SwarmDoc & Record<string, unknown>;
      doc["x-meta"] = null; // what the form sends back after JSON turned the number into null
      expect(ok(renderSwarmDoc(base, doc)).text).toBe(base);
      doc.swarms.team!.description = "Changed";
      const r = ok(renderSwarmDoc(base, doc));
      expect(r.text).toBe(base.replace("A team", "Changed"));
      doc.swarms.team!.stages = ["checker", "writer"];
      expect(ok(renderSwarmDoc(base, doc)).text).toContain(`x-meta: ${v}`);
    }
  });

  it("edits and deletes under an unquoted true: role key", () => {
    const base = BASE.replace("      checker:", "      true:");
    const doc = load(base);
    expect(Object.keys(doc.swarms.team!.agents)).toContain("true");
    const edited = clone(doc);
    edited.swarms.team!.agents.true!.description = "Edited";
    edited.swarms.team!.agents.true!.model = "opus";
    expect(ok(renderSwarmDoc(base, edited)).text).toContain("model: opus");
    const gone = clone(doc);
    delete gone.swarms.team!.agents.true;
    gone.swarms.team!.stages = ["writer"];
    const r = ok(renderSwarmDoc(base, gone));
    expect(r.text).not.toContain("true:");
  });
});

describe("renderSwarmDoc bool-like keys", () => {
  const TRUE_SWARM = `version: 1
swarms:
  true:
    description: Bool-named swarm # c1
    topology: pipeline
    stages: [coder]
    agents:
      coder:
        description: Writes # c2
        prompt: p
`;

  it("renames a role inside an unquoted true: swarm, keeping comments and stages", () => {
    const d = load(TRUE_SWARM);
    const swarm = d.swarms.true!;
    swarm.agents = { builder: swarm.agents.coder! };
    swarm.stages = ["builder"];
    const r = ok(renderSwarmDoc(TRUE_SWARM, d, [{ swarm: "true", role: "coder", to: "builder" }]));
    expect(r.text).toContain("      builder:");
    expect(r.text).toContain("# c1");
    expect(r.text).toContain("# c2");
    expect(r.text).toContain("stages: [builder]");
    expect(r.text).not.toContain("coder");
  });

  it('edits the last of a duplicate true: and "true": key, as the draft sees it', () => {
    const base = `version: 1
swarms:
  feat:
    description: F
    agents:
      true:
        description: Bool role
        prompt: p
      "true":
        description: String role # keep
        prompt: q
`;
    const d = load(base);
    expect(d.swarms.feat!.agents.true!.description).toBe("String role");
    d.swarms.feat!.agents.true!.description = "Edited";
    const r = ok(renderSwarmDoc(base, d));
    expect(r.text).toContain("description: Edited # keep");
    expect(r.text).toContain("description: Bool role");
  });
});

describe("renderSwarmDoc list edits", () => {
  const LISTS = `version: 1
swarms:
  feat:
    description: F
    topology: pipeline
    stages:
      - coder    # writes the change
      - tester   # must run after coder
    agents:
      coder:
        description: C
        prompt: p
        tools:
          - Read   # read files
          - Bash   # needed for npm test
          - Edit   # the only writer
      tester:
        description: T
        prompt: q
`;
  const PLAIN = `version: 1
swarms:
  feat:
    description: F
    agents:
      coder:
        description: C
        prompt: p
        tools:
          - Read
          - Bash
`;
  const withTools = (text: string, tools: string[]) => {
    const d = load(text);
    d.swarms.feat!.agents.coder!.tools = tools;
    return ok(renderSwarmDoc(text, d)).text;
  };
  const line = (text: string, item: string) =>
    text.split("\n").find((l) => new RegExp(`^\\s+- ${item}\\b`).test(l));

  it("keeps each comment on its own item when one tool is removed and another added", () => {
    const out = withTools(LISTS, ["Bash", "Edit", "Write"]);
    expect(line(out, "Bash")).toMatch(/# needed for npm test$/);
    expect(line(out, "Edit")).toMatch(/# the only writer$/);
    expect(line(out, "Write")).not.toContain("#");
    expect(out).not.toContain("# read files");
    expect(out).toContain("          - Bash");
  });

  it("keeps each comment on its own item on a reorder", () => {
    const out = withTools(LISTS, ["Edit", "Read", "Bash"]);
    expect(line(out, "Edit")).toMatch(/# the only writer$/);
    expect(line(out, "Read")).toMatch(/# read files$/);
    expect(line(out, "Bash")).toMatch(/# needed for npm test$/);
    expect(out.indexOf("- Edit")).toBeLessThan(out.indexOf("- Read"));
  });

  it("keeps each stage comment on its role when the stages swap", () => {
    const d = load(LISTS);
    d.swarms.feat!.stages = ["tester", "coder"];
    const out = ok(renderSwarmDoc(LISTS, d)).text;
    expect(line(out, "coder")).toMatch(/# writes the change$/);
    expect(line(out, "tester")).toMatch(/# must run after coder$/);
    expect(out.indexOf("- tester")).toBeLessThan(out.indexOf("- coder"));
  });

  it("keeps a block list in block style when an item is removed or added, with comments", () => {
    const removed = withTools(LISTS, ["Bash", "Edit"]);
    expect(removed).toContain("          - Bash");
    expect(removed).not.toMatch(/tools:\s*\[/);
    expect(line(removed, "Bash")).toMatch(/# needed for npm test$/);
    const added = withTools(LISTS, ["Read", "Bash", "Edit", "Write"]);
    expect(added).not.toMatch(/tools:\s*\[/);
    expect(line(added, "Read")).toMatch(/# read files$/);
    expect(line(added, "Write")).toBeDefined();
  });

  it("keeps a block list in block style without comments", () => {
    const added = withTools(PLAIN, ["Read", "Bash", "Edit"]);
    expect(added).toContain(
      "        tools:\n          - Read\n          - Bash\n          - Edit\n",
    );
    const removed = withTools(PLAIN, ["Bash"]);
    expect(removed).toContain("        tools:\n          - Bash\n");
  });

  it("still rewrites a true in-place replacement and keeps its comment", () => {
    const out = withTools(LISTS, ["Read", "Grep", "Edit"]);
    expect(line(out, "Grep")).toMatch(/# needed for npm test$/);
    expect(out).not.toContain("- Bash");
  });

  it("keeps a flow list in flow style when its length changes", () => {
    const d = load(BASE);
    d.swarms.team!.stages = ["writer", "checker", "extra"];
    const out = ok(renderSwarmDoc(BASE, d)).text;
    expect(out).toContain("stages: [writer, checker, extra]");
  });
});

describe("readSwarmDoc", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-edit-read-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports absent when there is no file", () => {
    const r = readSwarmDoc(dir);
    expect(r.state).toBe("absent");
    expect(r.doc).toBeNull();
    expect(r.hash).toBeNull();
  });

  it("returns text, hash, doc and locked paths", () => {
    mkdirSync(join(dir, ".eminiar"));
    const text = `version: 1
swarms:
  one:
    description: One
    agents:
      a:
        description: A
        prompt: P
        hooks: {}
`;
    writeFileSync(join(dir, ".eminiar/swarm.yaml"), text);
    const r = readSwarmDoc(dir);
    expect(r.state).toBe("ok");
    expect(r.hash).toBe(hashText(text));
    expect(r.doc?.swarms.one?.description).toBe("One");
    expect(r.locked).toContain("swarms.one.agents.a.hooks");
  });

  it("keeps the doc but reports issues when the file fails the schema", () => {
    mkdirSync(join(dir, ".eminiar"));
    writeFileSync(
      join(dir, ".eminiar/swarm.yaml"),
      "version: 1\nswarms:\n  one:\n    description: One\n    topology: bogus\n    agents: {}\n",
    );
    const r = readSwarmDoc(dir);
    expect(r.state).toBe("invalid");
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.doc).not.toBeNull();
  });

  it("has no doc when the YAML does not parse", () => {
    mkdirSync(join(dir, ".eminiar"));
    writeFileSync(join(dir, ".eminiar/swarm.yaml"), "swarms: [oops\n");
    const r = readSwarmDoc(dir);
    expect(r.state).toBe("invalid");
    expect(r.doc).toBeNull();
  });
});

describe("docWarnings", () => {
  const base = (): SwarmDoc => clone(load(BASE));

  it("warns when the counts exceed max_agents", () => {
    const doc = base();
    doc.swarms.team!.max_agents = 1;
    expect(docWarnings(doc).some((w) => w.kind === "capacity")).toBe(true);
  });

  it("warns about pipeline roles missing from stages and empty prompts", () => {
    const doc = base();
    doc.swarms.team!.stages = ["writer"];
    doc.swarms.team!.agents.checker!.prompt = "";
    const kinds = docWarnings(doc).map((w) => w.kind);
    expect(kinds).toContain("stages");
    expect(kinds).toContain("prompt");
  });

  it("warns when an active run's swarm or role disappears", () => {
    const prev = base();
    const doc = clone(prev);
    delete doc.swarms.team!.agents.checker;
    const runs = [{ id: "r1", swarm: "team" }];
    expect(docWarnings(doc, runs, prev).some((w) => w.kind === "active-run")).toBe(true);
    const gone = docWarnings({ swarms: {} }, runs, prev);
    expect(gone.some((w) => w.kind === "active-run" && w.path === "swarms.team")).toBe(true);
  });

  it("warns on turning enforce on and on disabling", () => {
    const prev = base();
    const on = { ...clone(prev), enforce: true as const };
    expect(docWarnings(on, [], prev).some((w) => w.kind === "enforce")).toBe(true);
    expect(docWarnings(on, [], on).some((w) => w.kind === "enforce")).toBe(false);
    const off = { ...clone(prev), enabled: false as const };
    expect(docWarnings(off, [], prev).some((w) => w.kind === "disable")).toBe(true);
  });
});

describe("lineDiff and helpers", () => {
  it("marks only changed lines and counts removed ones", () => {
    const a = "a\nb\nc\nd\n";
    const b = "a\nB\nc\nd\ne\n";
    const d = lineDiff(a, b);
    expect(d.changed).toEqual([2, 5]);
    expect(d.removed).toBe(1);
    expect(lineDiff(a, a)).toEqual({ changed: [], removed: 0 });
  });

  it("marks everything past the size cap", () => {
    const a = Array.from({ length: 3100 }, (_, i) => `l${i}`).join("\n");
    const b = `${a}\nextra`;
    const d = lineDiff(a, `x\n${b}`);
    expect(d.changed.length).toBeGreaterThan(3000);
  });

  it("deepEqual ignores key order but not values or array order", () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});
