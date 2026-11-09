import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { tools } from "../../src/tools/index.js";

const byName = (n: string) => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`no tool ${n}`);
  return t;
};

describe("tool annotations", () => {
  it("every registered tool declares all four hints", () => {
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined();
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(
          typeof (t.annotations as unknown as Record<string, unknown>)[k],
          `${t.name}.${k}`,
        ).toBe("boolean");
      }
    }
  });

  it("read-only tools are flagged readOnly", () => {
    for (const n of ["em_search", "em_recall", "em_symbols", "em_architecture"])
      expect(byName(n).annotations.readOnlyHint, n).toBe(true);
  });

  it("destructive and mixed tools are not read-only", () => {
    expect(byName("em_purge").annotations.destructiveHint).toBe(true);
    for (const n of ["em_memory", "em_swarm", "em_docs", "em_index", "em_reindex", "em_purge"])
      expect(byName(n).annotations.readOnlyHint, n).toBe(false);
    expect(byName("em_memory").annotations.destructiveHint).toBe(true);
  });

  it("read-only tools are never destructive", () => {
    for (const t of tools)
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
  });
});

/** Words that name an action able to delete or overwrite data. */
const DESTRUCTIVE_WORD =
  /(^|_)(delete|remove|replace|purge|sync|force|drop|prune|overwrite|wipe)($|_)/;
/**
 * Flags with a destructive word that delete or overwrite nothing, each with its reason.
 * em_fetch_and_index.force only bypasses the fetch cache.
 */
const NOT_DESTRUCTIVE = new Set(["em_fetch_and_index.force"]);

/** The zod schema under optional/default wrappers. */
function unwrap(s: unknown): { options?: unknown; type?: unknown; def?: { innerType?: unknown } } {
  let cur = s as { def?: { innerType?: unknown } } | undefined;
  while (cur?.def?.innerType) cur = cur.def.innerType as typeof cur;
  return (cur ?? {}) as ReturnType<typeof unwrap>;
}

/** The destructive actions and flags of a tool's input schema, as "param=value" / "param". */
function destructiveInputs(t: (typeof tools)[number]): string[] {
  const out: string[] = [];
  for (const [key, schema] of Object.entries(t.schema)) {
    const s = unwrap(schema);
    if (Array.isArray(s.options))
      for (const o of s.options)
        if (typeof o === "string" && DESTRUCTIVE_WORD.test(o)) out.push(`${key}=${o}`);
    if (
      s.type === "boolean" &&
      DESTRUCTIVE_WORD.test(key) &&
      !NOT_DESTRUCTIVE.has(`${t.name}.${key}`)
    )
      out.push(key);
  }
  return out;
}

describe("destructiveHint follows the input schema", () => {
  it("finds the destructive actions it is meant to (the derivation works)", () => {
    expect(destructiveInputs(byName("em_memory"))).toContain("action=delete");
    expect(destructiveInputs(byName("em_docs"))).toEqual(
      expect.arrayContaining(["action=remove", "action=sync", "force"]),
    );
    expect(destructiveInputs(byName("em_swarm"))).toEqual(
      expect.arrayContaining(["action=sync", "force"]),
    );
    expect(destructiveInputs(byName("em_remember"))).toContain("replace");
    expect(destructiveInputs(byName("em_search"))).toEqual([]);
  });

  it("marks every tool with a delete/remove/replace/purge/sync/force action or flag destructive", () => {
    for (const t of tools) {
      const hits = destructiveInputs(t);
      if (hits.length)
        expect(t.annotations.destructiveHint, `${t.name}: ${hits.join(", ")}`).toBe(true);
    }
  });

  it("em_swarm, em_docs and em_remember are destructive, not read-only", () => {
    for (const n of ["em_swarm", "em_docs", "em_remember"]) {
      expect(byName(n).annotations.destructiveHint, n).toBe(true);
      expect(byName(n).annotations.readOnlyHint, n).toBe(false);
    }
  });

  it("the command runners are not read-only, destructive and open-world", () => {
    for (const n of ["em_execute", "em_execute_file", "em_batch_execute"])
      expect(byName(n).annotations, n).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      });
  });
});

const repo = join(__dirname, "..", "..");

describe("the MCP server's tools/list", () => {
  // Starts src/server.ts (through tsx) in an empty project: the annotations a client sees are
  // what server.ts passes to registerTool, so dropping them there fails this test.
  it("carries every tool's annotations", { timeout: 60_000 }, async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "em-ann-")));
    writeFileSync(join(project, "package.json"), "{}");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
    env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-ann-home-"));
    env.EMINIAR_PROJECT_ROOT = project;
    const client = new Client({ name: "annotations-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: join(repo, "node_modules", ".bin", "tsx"),
        args: [join(repo, "src", "server.ts")],
        cwd: project,
        env,
        stderr: "ignore",
      }),
    );
    try {
      const { tools: listed } = await client.listTools();
      expect(listed.length).toBeGreaterThan(10);
      for (const t of listed) expect(t.annotations, t.name).toEqual(byName(t.name).annotations);
      const swarm = listed.find((t) => t.name === "em_swarm");
      expect(swarm?.annotations?.destructiveHint).toBe(true);
    } finally {
      await client.close();
    }
  });
});
