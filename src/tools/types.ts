import type { z } from "zod";
import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** MCP behaviour hints, sent with the tool listing. See the classification note below. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/*
 * Classification rule: a tool is readOnlyHint only when none of its actions writes anything.
 * A tool with both read and write actions (em_memory, em_swarm, em_docs, em_index, em_reindex,
 * em_usage) takes the conservative value: not read-only, and destructive when any action can
 * delete or overwrite (em_memory delete). Opt-out defaults in the MCP spec are the worst case,
 * so each flag is set explicitly.
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Writes the local eminiar store only; repeating a call leaves the same state. */
export const LOCAL_WRITE: ToolAnnotations = { ...READ_ONLY, readOnlyHint: false };
/** Deletes data permanently. */
export const DESTRUCTIVE: ToolAnnotations = {
  ...LOCAL_WRITE,
  destructiveHint: true,
  idempotentHint: false,
};
/** Runs arbitrary code in the sandbox: it can change files and reach the network. */
export const RUNS_CODE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  annotations: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ProjectContext) => Promise<ToolResult>;
  /**
   * Whether the server lists the tool for the config loaded at start (default: always). An
   * opt-in feature's tool is left out while the feature is off, so its schema costs nothing.
   */
  available?: (config: Config) => boolean;
}

/** The tools to register for `config`: those without `available`, or whose check passes. */
export function availableTools<T extends Pick<ToolDef, "available">>(
  all: readonly T[],
  config: Config,
): T[] {
  return all.filter((t) => {
    try {
      return t.available ? t.available(config) : true;
    } catch {
      return false;
    }
  });
}

/** Identity helper that pins the generic so handlers get typed args. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function errorResult(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}
