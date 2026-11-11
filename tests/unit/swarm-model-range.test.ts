import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  agentFileRange,
  generatedState,
  modelRangeText,
  renderAgentFile,
  syncAgents,
} from "../../src/swarm/agents.js";
import { parseSwarmYaml, STARTER_YAML } from "../../src/swarm/config.js";
import type { ConfigIssue, ModelRange, SwarmConfig } from "../../src/swarm/types.js";

const parse = (yaml: string) =>
  parseSwarmYaml(yaml, "/x/.eminiar/swarm.yaml", ".eminiar/swarm.yaml");
const ok = (yaml: string): SwarmConfig => {
  const r = parse(yaml);
  if (r.state !== "ok") throw new Error(JSON.stringify(r));
  return r.config;
};
const issuesOf = (yaml: string): ConfigIssue[] => {
  const r = parse(yaml);
  if (r.state !== "invalid") throw new Error(`expected an invalid file:\n${yaml}`);
  return r.issues;
};
/** A one-swarm file; each role is `{ description: x, <keys> }`. */
const file = (agents: Record<string, string>, defaults?: string) =>
  [
    ...(defaults ? ["defaults:", ...defaults.split("\n").map((l) => `  ${l}`)] : []),
    "swarms:",
    "  s:",
    "    description: d",
    "    agents:",
    ...Object.entries(agents).map(
      ([role, keys]) => `      ${role}: { description: x${keys ? `, ${keys}` : ""} }`,
    ),
    "",
  ].join("\n");
const rangesOf = (c: SwarmConfig) =>
  Object.fromEntries(c.swarms[0]!.roles.map((r) => [r.role, r.range]));
const render = (c: SwarmConfig, i = 0) => renderAgentFile(c, c.swarms[0]!, c.swarms[0]!.roles[i]!);
const markerOf = (text: string) => text.split("\n").find((l) => l.startsWith("<!-- eminiar:"))!;
const frontmatterOf = (text: string) =>
  parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]!) as Record<string, unknown>;
const R = (floor: ModelRange["floor"], ceiling: ModelRange["ceiling"]): ModelRange => ({
  floor,
  ceiling,
});

describe("swarm model_range: config", () => {
  it("resolves a role's range, an unset bound sitting at the fallback's tier", () => {
    const c = ok(
      file({
        both: "model: sonnet, model_range: { floor: haiku, ceiling: opus }",
        down: "model: sonnet, model_range: { floor: haiku }",
        up: "model: sonnet, model_range: { ceiling: opus }",
        wide: "model: haiku, model_range: { ceiling: fable }",
        pinned: "model: sonnet",
      }),
    );
    expect(rangesOf(c)).toEqual({
      both: R("haiku", "opus"),
      down: R("haiku", "sonnet"),
      up: R("sonnet", "opus"),
      wide: R("haiku", "fable"),
      pinned: undefined,
    });
    // `model` stays the fallback pin.
    expect(c.swarms[0]!.roles.map((r) => r.model)).toEqual([
      "sonnet",
      "sonnet",
      "sonnet",
      "haiku",
      "sonnet",
    ]);
  });

  it("takes defaults.model_range whole for roles without their own; {} and one-tier ranges are no range", () => {
    const c = ok(
      file(
        {
          plain: "",
          strong: "model: opus",
          own: "model_range: { ceiling: opus }",
          "opt-out": "model_range: {}",
          "inherit-opt-out": "model: inherit, model_range: {}",
          "one-tier": "model: opus, model_range: { floor: opus, ceiling: opus }",
          "floor-at-pin": "model: opus, model_range: { floor: opus }",
        },
        "model: sonnet\nmodel_range: { floor: haiku, ceiling: opus }",
      ),
    );
    expect(rangesOf(c)).toEqual({
      plain: R("haiku", "opus"),
      strong: R("haiku", "opus"),
      // replaced whole: the default floor (haiku) is not merged in
      own: R("sonnet", "opus"),
      "opt-out": undefined,
      "inherit-opt-out": undefined,
      "one-tier": undefined,
      "floor-at-pin": undefined,
    });
    // toEqual treats a missing key as undefined; make sure every role is there.
    expect(Object.keys(rangesOf(c))).toHaveLength(7);
  });

  it("reads a model id fallback as its family", () => {
    const c = ok(
      file({
        id: "model: claude-sonnet-5-5, model_range: { floor: haiku }",
        long: 'model: "sonnet[1m]", model_range: { ceiling: opus }',
        bedrock:
          'model: "us.anthropic.claude-opus-4-1-20250805-v1:0", model_range: { floor: sonnet }',
      }),
    );
    expect(rangesOf(c)).toEqual({
      id: R("haiku", "sonnet"),
      long: R("sonnet", "opus"),
      bedrock: R("sonnet", "opus"),
    });
  });

  it("rejects floor above ceiling, bounds that are not tier aliases and unknown keys", () => {
    const inverted = issuesOf(
      file({ a: "model: sonnet, model_range: { floor: opus, ceiling: haiku }" }),
    );
    expect(inverted).toEqual([
      expect.objectContaining({
        path: "swarms.s.agents.a.model_range",
        message: expect.stringMatching(
          /floor must not be above ceiling \(haiku < sonnet < opus < fable\)/,
        ),
        line: 5,
      }),
    ]);
    const inDefaults = issuesOf(
      file({ a: "" }, "model: sonnet\nmodel_range: { floor: fable, ceiling: sonnet }"),
    );
    expect(inDefaults.map((i) => i.path)).toEqual(["defaults.model_range"]);
    for (const bad of ['"sonnet[1m]"', "claude-opus-5-5", "inherit", "gpt-4o"]) {
      const is = issuesOf(file({ a: `model: sonnet, model_range: { floor: ${bad} }` }));
      expect(is.map((i) => i.path)).toEqual(["swarms.s.agents.a.model_range.floor"]);
    }
    const typo = issuesOf(
      file({ a: "model: sonnet, model_range: { floor: haiku, ceilng: opus }" }),
    );
    expect(
      typo.some(
        (i) =>
          i.path === "swarms.s.agents.a.model_range" && /did you mean "ceiling"/.test(i.message),
      ),
    ).toBe(true);
  });

  it("needs a fallback with a known tier inside the range", () => {
    const one = (keys: string) => {
      const is = issuesOf(file({ a: keys }));
      expect(is).toHaveLength(1);
      expect(is[0]!.path).toBe("swarms.s.agents.a.model_range");
      expect(is[0]!.line).toBe(5);
      return is[0]!.message;
    };
    expect(one("model_range: { floor: haiku, ceiling: opus }")).toMatch(
      /^model_range needs a fallback model inside it: set model on this role or defaults\.model/,
    );
    expect(one("model: inherit, model_range: { floor: haiku }")).toMatch(
      /^model inherit cannot be the fallback of model_range: the main session's model is not known/,
    );
    expect(one("model: opusplan, model_range: { floor: haiku }")).toMatch(
      /^model opusplan has no single tier/,
    );
    expect(one("model: claude-foo-1, model_range: { ceiling: opus }")).toMatch(
      /^model claude-foo-1 has no single tier/,
    );
    expect(one("model: opus, model_range: { ceiling: sonnet }")).toBe(
      "model opus is above the ceiling sonnet of model_range: the fallback must lie inside the range",
    );
    expect(one("model: haiku, model_range: { floor: sonnet, ceiling: opus }")).toBe(
      "model haiku is below the floor sonnet of model_range: the fallback must lie inside the range",
    );
  });

  it("reports a problem made of defaults once, at the defaults, and a role's own model at the role", () => {
    const inherit = issuesOf(
      file(
        { a: "", b: "", fine: "model: opus" },
        "model: inherit\nmodel_range: { floor: haiku, ceiling: opus }",
      ),
    );
    expect(inherit).toEqual([
      expect.objectContaining({
        path: "defaults.model_range",
        message: expect.stringMatching(
          /^defaults\.model inherit cannot be the fallback of defaults\.model_range/,
        ),
        line: 3,
      }),
    ]);
    const none = issuesOf(file({ a: "", b: "" }, "model_range: { floor: haiku, ceiling: opus }"));
    expect(none).toHaveLength(1);
    expect(none[0]!.path).toBe("defaults.model_range");
    expect(none[0]!.message).toMatch(
      /^defaults\.model_range needs a fallback model inside it: set defaults\.model, or model on every role without one/,
    );
    const role = issuesOf(
      file(
        { a: "model: haiku", b: "" },
        "model: sonnet\nmodel_range: { floor: sonnet, ceiling: opus }",
      ),
    );
    expect(role).toEqual([
      expect.objectContaining({
        path: "swarms.s.agents.a.model",
        message:
          "model haiku is below the floor sonnet of defaults.model_range: the fallback must lie inside the range",
      }),
    ]);
  });

  it("leaves the config hash alone without a range and changes it with one", () => {
    const pinned = ok(file({ a: "model: sonnet" }));
    expect(ok(file({ a: "model: sonnet, model_range: {}" })).hash).toBe(pinned.hash);
    expect(ok(file({ a: "model: sonnet, model_range: { floor: sonnet } " })).hash).toBe(
      pinned.hash,
    );
    expect(ok(file({ a: "model: sonnet, model_range: { floor: haiku }" })).hash).not.toBe(
      pinned.hash,
    );
    expect(ok(STARTER_YAML).swarms.flatMap((s) => s.roles.map((r) => r.range))).not.toContainEqual(
      expect.anything(),
    );
  });
});

describe("swarm model_range: agent files", () => {
  const RANGED = file({ a: "model: sonnet, model_range: { floor: haiku, ceiling: opus }" });
  const PINNED = file({ a: "model: sonnet" });

  it("pins the fallback in the frontmatter and writes the range into the hashed marker", () => {
    const text = render(ok(RANGED));
    expect(frontmatterOf(text).model).toBe("sonnet");
    expect(markerOf(text)).toMatch(
      /^<!-- eminiar:swarm swarm=s role=a range=haiku\.\.opus hash=[0-9a-f]{12} · generated from \.eminiar\/swarm\.yaml /,
    );
    expect(generatedState(text)).toBe("generated");
    expect(agentFileRange(text)).toEqual(R("haiku", "opus"));
    expect(agentFileRange(text.replace(/\n/g, "\r\n"))).toEqual(R("haiku", "opus"));
    expect(modelRangeText(R("haiku", "opus"))).toBe("haiku..opus");
    // The range changes the marker line and nothing else.
    const pinned = render(ok(PINNED));
    const withoutMarker = (t: string) => t.replace(markerOf(t), "");
    expect(withoutMarker(text)).toBe(withoutMarker(pinned));
    expect(markerOf(text)).not.toBe(markerOf(pinned));
  });

  it("keeps an unranged file as before: no range= and the hash of frontmatter and body alone", () => {
    const text = render(ok(PINNED));
    const marker = markerOf(text);
    expect(marker).not.toContain("range=");
    const fm = text.slice(4, text.indexOf("\n---\n"));
    const body = text.slice(text.indexOf(`${marker}\n`) + marker.length + 1);
    const legacy = createHash("sha1").update(`${fm}\n${body}`).digest("hex").slice(0, 12);
    expect(marker).toContain(` hash=${legacy} `);
    expect(generatedState(text)).toBe("generated");
    expect(agentFileRange(text)).toBeUndefined();
  });

  it("counts a hand-edited range as an edit and trusts no range from an edited or foreign file", () => {
    const text = render(ok(RANGED));
    const pinned = render(ok(PINNED));
    const edits = {
      widened: text.replace("range=haiku..opus", "range=haiku..fable"),
      dropped: text.replace(" range=haiku..opus", ""),
      inverted: text.replace("range=haiku..opus", "range=opus..haiku"),
      added: pinned.replace(" hash=", " range=haiku..opus hash="),
      body: text.replace("## Swarm protocol", "## My protocol"),
      model: text.replace("model: sonnet", "model: opus"),
    };
    for (const [what, t] of Object.entries(edits)) {
      expect(generatedState(t), what).toBe("edited");
      expect(agentFileRange(t), what).toBeUndefined();
    }
    const foreign =
      "---\nname: swarm-s-a\nmodel: sonnet\n---\nrange=haiku..opus hash=0123456789ab\n";
    expect(generatedState(foreign)).toBe("foreign");
    expect(agentFileRange(foreign)).toBeUndefined();
  });

  it("syncs a changed range as an update and keeps a hand-edited range as a conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "em-swarm-range-"));
    const path = join(root, ".claude", "agents", "swarm-s-a.md");
    expect(syncAgents(root, ok(RANGED)).actions[0]!.action).toBe("create");
    expect(agentFileRange(readFileSync(path, "utf8"))).toEqual(R("haiku", "opus"));

    const narrower = ok(file({ a: "model: sonnet, model_range: { floor: haiku }" }));
    expect(syncAgents(root, narrower).actions[0]!.action).toBe("update");
    const synced = readFileSync(path, "utf8");
    expect(agentFileRange(synced)).toEqual(R("haiku", "sonnet"));
    expect(frontmatterOf(synced).model).toBe("sonnet");
    expect(syncAgents(root, narrower).changed).toBe(0);

    writeFileSync(path, synced.replace("range=haiku..sonnet", "range=haiku..fable"));
    const conflict = syncAgents(root, narrower);
    expect(conflict.actions[0]).toMatchObject({ action: "conflict" });
    expect(readFileSync(path, "utf8")).toContain("range=haiku..fable");

    const pinned = ok(PINNED);
    expect(syncAgents(root, pinned, { force: true }).actions[0]!.action).toBe("update");
    expect(readFileSync(path, "utf8")).toBe(render(pinned));
  });
});
