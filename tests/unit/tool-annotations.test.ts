import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  it("em_graph_add replaces existing nodes, so it is destructive", () => {
    expect(byName("em_graph_add").annotations.destructiveHint).toBe(true);
  });

  it("em_adjudicate score stores a new decision each call, so it is not idempotent", () => {
    expect(byName("em_adjudicate").annotations.idempotentHint).toBe(false);
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
const TSX = join(repo, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

/**
 * A fresh temp dir with a short path: tsx's IPC socket lives under the child's tmpdir, and a
 * long macOS TMPDIR overflows the 104-char socket path limit (listen EINVAL). Prefers /tmp.
 */
function shortTempDir(prefix: string): string {
  if (process.platform !== "win32")
    try {
      return realpathSync(mkdtempSync(join("/tmp", prefix)));
    } catch {
      // no writable /tmp: fall back to the default
    }
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe("the MCP server's tools/list", () => {
  // Starts src/server.ts (through tsx) in an empty project: the annotations a client sees are
  // what server.ts passes to registerTool, so dropping them there fails this test.
  it("carries every tool's annotations", { timeout: 60_000 }, async () => {
    // One temp dir holds the project, EMINIAR_HOME and the child's TMPDIR; removed at the end.
    const dir = shortTempDir("em-ann-");
    const project = join(dir, "p");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && k !== "CLAUDE_PROJECT_DIR") env[k] = v;
    env.EMINIAR_HOME = join(dir, "h");
    env.EMINIAR_PROJECT_ROOT = project;
    env.TMPDIR = join(dir, "t");
    for (const d of [project, env.EMINIAR_HOME, env.TMPDIR]) mkdirSync(d);
    writeFileSync(join(project, "package.json"), "{}");
    const transport = new StdioClientTransport({
      command: TSX,
      args: [join(repo, "src", "server.ts")],
      cwd: project,
      env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const client = new Client({ name: "annotations-test", version: "0" });
    try {
      await client.connect(transport);
      const { tools: listed } = await client.listTools();
      expect(listed.length).toBeGreaterThan(10);
      for (const t of listed) expect(t.annotations, t.name).toEqual(byName(t.name).annotations);
      const swarm = listed.find((t) => t.name === "em_swarm");
      expect(swarm?.annotations?.destructiveHint).toBe(true);
    } catch (err) {
      // A server that fails to start only shows up as "Connection closed": add what it printed.
      if (err instanceof Error) err.message += `\nserver stderr:\n${stderr.trim() || "(empty)"}`;
      throw err;
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
