import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StorageAdapter } from "../storage/adapter.js";
import type { GraphNodeRow } from "../storage/types.js";
import { matchesFile, matchesNamePath, parseNamePath } from "./namepath.js";

/** Graph node kinds that are not code symbols. */
const NON_SYMBOL = new Set(["file", "package", "person", "concept", "memory"]);

export const isSymbol = (n: GraphNodeRow): boolean => !NON_SYMBOL.has(n.kind) && !!n.path;

export function isExported(n: GraphNodeRow): boolean {
  if (!n.meta) return false;
  try {
    return !!(JSON.parse(n.meta) as { exported?: boolean }).exported;
  } catch {
    return false;
  }
}

const byPosition = (a: GraphNodeRow, b: GraphNodeRow) =>
  (a.path ?? "").localeCompare(b.path ?? "") ||
  (a.start_line ?? 0) - (b.start_line ?? 0) ||
  a.name.localeCompare(b.name);

/** Every symbol defined in one file, in source order (members follow their parent). */
export function overview(db: StorageAdapter, rel: string): GraphNodeRow[] {
  const path = rel.replace(/^\.\//, "");
  return db
    .graphFindNodes({ path, limit: 5000 })
    .filter((n) => isSymbol(n) && matchesFile(n.path, path))
    .sort(byPosition);
}

export interface FindOptions {
  substring?: boolean | undefined;
  kinds?: string[] | undefined;
  /** Restrict to this file (exact or suffix match on the path). */
  file?: string | undefined;
  limit?: number | undefined;
}

/** Symbols matching a name path, project-wide or within a file. */
export function findSymbols(
  db: StorageAdapter,
  query: string,
  opts: FindOptions = {},
): GraphNodeRow[] {
  const np = parseNamePath(query);
  const last = np.segments[np.segments.length - 1];
  if (!last) return [];
  const file = np.file ?? opts.file?.replace(/^\.\//, "");
  const candidates = db.graphFindNodes({ query: last, path: file, limit: 5000 });
  return candidates
    .filter(
      (n) =>
        isSymbol(n) &&
        matchesFile(n.path, file) &&
        (!opts.kinds?.length || opts.kinds.includes(n.kind)) &&
        matchesNamePath(n.name, np, !!opts.substring),
    )
    .sort(byPosition)
    .slice(0, opts.limit ?? 20);
}

/** Direct (depth 1) or deeper members of a symbol in the same file. */
export function children(db: StorageAdapter, parent: GraphNodeRow, depth = 1): GraphNodeRow[] {
  if (!parent.path || depth < 1) return [];
  const base = parent.name.split(".").length;
  return db
    .graphFindNodes({ query: `${parent.name}.`, path: parent.path, limit: 5000 })
    .filter(
      (n) =>
        isSymbol(n) &&
        n.path === parent.path &&
        n.name.startsWith(`${parent.name}.`) &&
        n.name.split(".").length - base <= depth,
    )
    .sort(byPosition);
}

/**
 * The source text of a symbol: the file's lines when it is on disk (always exact),
 * else the indexed chunks that carry its id.
 */
export function symbolBody(db: StorageAdapter, root: string, n: GraphNodeRow): string | undefined {
  if (!n.path || !n.start_line || !n.end_line) return undefined;
  const abs = join(root, n.path);
  if (existsSync(abs)) {
    try {
      return readFileSync(abs, "utf8")
        .split("\n")
        .slice(n.start_line - 1, n.end_line)
        .join("\n");
    } catch {
      // fall through to the index
    }
  }
  const chunks = db.chunksForSymbol(n.id);
  return chunks.length ? chunks.map((c) => c.body).join("\n") : undefined;
}

export function formatSymbol(n: GraphNodeRow): string {
  const loc = n.start_line ? `${n.path}:${n.start_line}-${n.end_line ?? n.start_line}` : n.path;
  return `${n.kind} ${n.name} · ${loc}${isExported(n) ? " · exported" : ""} · ${n.id}`;
}
