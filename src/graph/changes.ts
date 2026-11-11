import { spawnSync } from "node:child_process";
import type { StorageAdapter } from "../storage/adapter.js";
import type { GraphNodeRow } from "../storage/types.js";
import { fileId } from "./ids.js";
import { type Hit, impact } from "./query.js";

export interface ChangedSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  /** Changed line ranges inside the symbol (new-file numbering). */
  lines: Array<[number, number]>;
  fanIn: number;
  exported: boolean;
  route: string | undefined;
  risk: "high" | "medium" | "low";
  reasons: string[];
}

export interface ChangeSet {
  /** What the diff was taken against (`working tree` or the ref). */
  base: string;
  files: Array<{ path: string; hunks: number; indexed: boolean }>;
  symbols: ChangedSymbol[];
  /** Files affected through the graph, merged over all changed symbols. */
  affected: Hit[];
  /** Changed files the graph knows nothing about (not code, or not indexed). */
  unindexed: string[];
}

interface Hunk {
  path: string;
  start: number;
  end: number;
}

/** Parse `git diff --unified=0` into per-file new-side line ranges. */
export function parseUnifiedDiff(text: string): Hunk[] {
  const out: Hunk[] = [];
  let path: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      path = p === "/dev/null" ? undefined : p.replace(/^b\//, "");
      continue;
    }
    if (!path || !line.startsWith("@@")) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion has length 0: treat the line after it as touched.
    out.push({ path, start: Math.max(1, start), end: Math.max(1, start + Math.max(len, 1) - 1) });
  }
  return out;
}

function git(root: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error((r.stderr || `git ${args[0]} failed`).trim());
  return r.stdout ?? "";
}

/**
 * Innermost symbols covering each changed range. A hunk inside `Service.run` yields
 * `Service.run`, not also `Service`; a hunk outside any symbol yields nothing (the
 * file itself is still reported).
 */
function symbolsAt(db: StorageAdapter, path: string, hunks: Hunk[]): Map<string, ChangedSymbol> {
  const out = new Map<string, ChangedSymbol>();
  for (const h of hunks) {
    const nodes = db.graphNodesAtLines(path, h.start, h.end);
    const chosen: GraphNodeRow[] = [];
    for (const n of nodes) {
      // skip ancestors of an already chosen (more specific) symbol
      if (chosen.some((c) => c.name.startsWith(`${n.name}.`))) continue;
      if (n.kind === "route") continue;
      chosen.push(n);
      if (chosen.length >= 3) break;
    }
    for (const n of chosen) {
      const cur = out.get(n.id) ?? {
        id: n.id,
        name: n.name,
        kind: n.kind,
        path,
        lines: [],
        fanIn: 0,
        exported: false,
        route: undefined,
        risk: "low" as const,
        reasons: [],
      };
      cur.lines.push([
        Math.max(h.start, n.start_line ?? h.start),
        Math.min(h.end, n.end_line ?? h.end),
      ]);
      out.set(n.id, cur);
    }
  }
  return out;
}

/**
 * True when `ref` can only be read as a revision or range (`HEAD~1`, `main...HEAD`, a sha,
 * `main@{2 weeks ago}`): never an option (a leading `-`), and no control characters. It is
 * passed as one argument with no shell, so only the leading dash matters to git.
 */
export function isDiffRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && !ref.startsWith("-") && !/\p{Cc}/u.test(ref);
}

/**
 * Map a git diff (working tree by default, or against `ref`) to the symbols it
 * touches, classify each by how exposed it is, and merge the impact of all of them
 * into one list of affected files. Untracked files count as fully changed.
 */
export function detectChanges(
  db: StorageAdapter,
  root: string,
  opts: { ref?: string | undefined; limit?: number | undefined } = {},
): ChangeSet {
  const args = [
    "diff",
    "--unified=0",
    "--no-color",
    "--relative",
    "--no-ext-diff",
    "--no-textconv",
  ];
  if (opts.ref) {
    // The ref comes from the model (em_graph_changes) or a dashboard query string. An option
    // such as `--output=<file>` would make git write that file, so refuse anything that is not
    // a revision and mark the end of options for git too.
    if (!isDiffRef(opts.ref))
      throw new Error(`not a ref, sha or range: ${JSON.stringify(opts.ref)}`);
    args.push("--end-of-options", opts.ref);
  }
  const hunks = parseUnifiedDiff(git(root, args));
  if (!opts.ref) {
    for (const p of git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
      const path = p.trim();
      if (!path) continue;
      const row = db.fileIndexGet(path);
      hunks.push({
        path,
        start: 1,
        end: Math.max(1, (row && countLines(db, row.document_id)) || 1e6),
      });
    }
  }
  const byFile = new Map<string, Hunk[]>();
  for (const h of hunks) {
    const list = byFile.get(h.path) ?? [];
    list.push(h);
    byFile.set(h.path, list);
  }
  const symbols = new Map<string, ChangedSymbol>();
  const files: ChangeSet["files"] = [];
  const unindexed: string[] = [];
  for (const [path, list] of byFile) {
    const indexed = !!db.graphGetNode(fileId(path));
    files.push({ path, hunks: list.length, indexed });
    if (!indexed) {
      unindexed.push(path);
      continue;
    }
    for (const [id, s] of symbolsAt(db, path, list)) symbols.set(id, s);
  }
  // Exposure signals per symbol.
  const ids = [...symbols.keys()];
  const metrics = new Map(db.metricsGet(ids).map((m) => [m.node_id, m]));
  const nodes = new Map(db.graphGetNodes(ids).map((n) => [n.id, n]));
  const handles = db.graphEdgesFrom(ids, ["handles"]);
  for (const s of symbols.values()) {
    const m = metrics.get(s.id);
    s.fanIn =
      m?.fan_in ?? db.graphEdgesTo([s.id], ["calls", "references", "extends", "implements"]).length;
    const node = nodes.get(s.id);
    s.exported = !!node?.meta && /"exported":true/.test(node.meta);
    const route = handles.find((e) => e.src === s.id);
    s.route = route ? route.dst.slice(6) : undefined;
    if (s.route) s.reasons.push(`handles ${s.route}`);
    if (s.fanIn) s.reasons.push(`${s.fanIn} dependent${s.fanIn === 1 ? "" : "s"}`);
    if (s.exported) s.reasons.push("exported");
    s.risk = s.route || s.fanIn >= 10 ? "high" : s.fanIn >= 3 || s.exported ? "medium" : "low";
  }
  // Blast radius: union of impact over changed symbols (file-level), scores summed.
  const affected = new Map<string, Hit>();
  const changedFiles = new Set(files.map((f) => fileId(f.path)));
  for (const s of symbols.values()) {
    const r = impact(db, s.id, { depth: 2, includeGit: true });
    if (!r) continue;
    for (const h of r.hits) {
      if (changedFiles.has(h.id)) continue;
      const cur = affected.get(h.id) ?? {
        id: h.id,
        node: h.node,
        score: 0,
        hops: h.hops,
        reasons: [],
      };
      cur.score += h.score;
      cur.hops = Math.min(cur.hops, h.hops);
      for (const reason of h.reasons) {
        const tagged = `${reason} ← ${s.name}`;
        if (!cur.reasons.includes(tagged) && cur.reasons.length < 4) cur.reasons.push(tagged);
      }
      affected.set(h.id, cur);
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return {
    base: opts.ref ?? "working tree",
    files,
    symbols: [...symbols.values()].sort(
      (a, b) => order[a.risk] - order[b.risk] || b.fanIn - a.fanIn || a.id.localeCompare(b.id),
    ),
    affected: [...affected.values()].sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 30),
    unindexed,
  };
}

function countLines(db: StorageAdapter, documentId: number | null): number {
  if (!documentId) return 0;
  const chunks = db.chunksOfDocument(documentId);
  return chunks.reduce((a, c) => Math.max(a, c.end_line ?? 0), 0);
}
