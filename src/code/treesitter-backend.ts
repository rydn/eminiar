import { grammarFor, parseFile } from "../graph/treesitter.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { GraphEdgeRow } from "../storage/types.js";

export const USE_EDGES = ["calls", "references", "extends", "implements"];

/** The default backend: web-tree-sitter grammars shipped under vendor/grammars (TS/TSX/JS). */
export const treeSitterBackend = {
  id: "tree-sitter" as const,
  supports: (rel: string) => grammarFor(rel) !== undefined,
  parse: parseFile,
  references: (db: StorageAdapter, symbolId: string): GraphEdgeRow[] =>
    db.graphEdgesTo([symbolId], USE_EDGES),
};
