import type { ProjectContext } from "../context.js";
import type { ParsedFile } from "../graph/treesitter.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { GraphEdgeRow } from "../storage/types.js";
import { treeSitterBackend } from "./treesitter-backend.js";

/**
 * What the symbol tools need from a language backend. Queries over symbols
 * (overview, find, body) read the graph tables and are backend-independent; only
 * parsing and reference lookup differ. A language-server backend would parse the
 * same way into the graph and answer `references` on demand with precise results.
 */
export interface CodeBackend {
  id: "tree-sitter" | "lsp";
  supports(rel: string): boolean;
  /** Language name recorded in file_index (e.g. "typescript"), undefined when unsupported. */
  languageOf(rel: string): string | undefined;
  parse(root: string, rel: string, code: string): Promise<ParsedFile>;
  /** Incoming edges that mean "uses this symbol": calls, references, extends, implements. */
  references(db: StorageAdapter, symbolId: string): GraphEdgeRow[];
}

export function getCodeBackend(_ctx: ProjectContext): CodeBackend {
  // Only tree-sitter exists today, so there is nothing to choose.
  return treeSitterBackend;
}
