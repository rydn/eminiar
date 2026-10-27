import { z } from "zod";
import { findSymbols } from "../code/symbols.js";
import { KINDS } from "../history/classify.js";
import { workingTreeFiles } from "../history/log.js";
import { getHistory, resolveCommit } from "../history/model.js";
import {
  renderBranch,
  renderCommit,
  renderFile,
  renderOverview,
  renderRisk,
  renderSymbol,
  renderTimeline,
} from "../history/narrate.js";
import { fileBytes, recordStat } from "../stats/record.js";
import { ensureGraph } from "./em_graph.js";
import { defineTool, errorResult, text } from "./types.js";

function parseWhen(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const rel = /^(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)$/i.exec(s.trim());
  if (rel) {
    const n = Number(rel[1]);
    const u = (rel[2] ?? "d")[0]!.toLowerCase();
    const days = u === "d" ? n : u === "w" ? n * 7 : u === "m" ? n * 30 : n * 365;
    return Date.now() - days * 86_400_000;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

export const emHistory = defineTool({
  name: "em_history",
  description:
    "Understand the project's git history instead of running git log/blame/show (the hooks route those here): commits classified by kind (feat/fix/refactor/…), branches with ahead/behind and merge state, and a fix-origin trace that blames each fix's removed lines back to the commit that wrote them, so changes that later needed fixing are flagged. Use `overview` to orient (it also builds the table the hooks use to flag bug-prone files), `file` before editing a file (its fixes, what broke after past changes, who knows it), `risk` for the files in the working tree (or given paths), `commit` for one change, `branch` to compare a branch with the base, `symbol` for a function's line history, `timeline`/`search` to find when and why something happened. Commit messages are also indexed for em_search (source `git`).",
  schema: {
    action: z
      .enum(["overview", "timeline", "search", "file", "commit", "branch", "risk", "symbol"])
      .optional()
      .describe("default overview"),
    path: z.string().optional().describe("file: the file; timeline: restrict to this path prefix"),
    paths: z
      .array(z.string())
      .optional()
      .describe("risk: files to assess (default: working tree changes)"),
    sha: z.string().optional().describe("commit: sha prefix, tag or branch name"),
    name: z.string().optional().describe("branch: the branch name"),
    name_path: z.string().optional().describe("symbol: Class/method or src/x.ts#fn"),
    query: z
      .string()
      .optional()
      .describe("search: text or regex over subject, body, author, issue refs"),
    kinds: z
      .array(z.enum(KINDS as [string, ...string[]]))
      .optional()
      .describe("timeline/search: only these kinds"),
    author: z.string().optional().describe("timeline/search: author name or email substring"),
    since: z.string().optional().describe("ISO date or relative like 30d, 6w, 3m"),
    until: z.string().optional().describe("ISO date"),
    risky: z.boolean().optional().describe("timeline: only commits flagged in hindsight"),
    limit: z.number().int().min(1).max(200).optional().describe("rows to return (default 20)"),
    refresh: z.boolean().optional().describe("rebuild the model even if HEAD has not moved"),
  },
  handler: async (args, ctx) => {
    const started = Date.now();
    const db = await ensureGraph(ctx);
    let model: ReturnType<typeof getHistory>;
    try {
      model = getHistory(ctx, db, { refresh: args.refresh });
    } catch (err) {
      return errorResult(`git history failed: ${(err as Error).message}`);
    }
    if (!model) return errorResult("not a git repository (or no commits yet)");
    const limit = args.limit ?? 20;
    const action = args.action ?? "overview";
    let out: string;
    let rawPaths: Iterable<string | null | undefined> = [];
    switch (action) {
      case "overview":
        out = renderOverview(model, { limit });
        break;
      case "timeline":
      case "search": {
        if (action === "search" && !args.query) return errorResult("query is required for search");
        out = renderTimeline(
          model,
          {
            kinds: args.kinds as never,
            author: args.author,
            path: args.path,
            since: parseWhen(args.since),
            until: parseWhen(args.until),
            query: args.query,
            risky: args.risky,
          },
          limit,
        );
        break;
      }
      case "file": {
        if (!args.path) return errorResult("path is required");
        out = renderFile(model, db, args.path, { limit });
        rawPaths = [args.path];
        break;
      }
      case "commit": {
        if (!args.sha) return errorResult("sha is required");
        const c = resolveCommit(model, args.sha);
        if (!c)
          return errorResult(
            `no commit matching ${args.sha} in the last ${model.stats.commits} commits`,
          );
        out = renderCommit(model, db, c);
        rawPaths = c.files.map((f) => f.path);
        break;
      }
      case "branch": {
        const name = args.name ?? model.branch;
        if (!name) return errorResult("name is required (detached HEAD)");
        out = renderBranch(model, name, limit);
        break;
      }
      case "risk": {
        const paths = args.paths?.length ? args.paths : workingTreeFiles(ctx.root);
        out = renderRisk(
          model,
          paths,
          args.paths?.length
            ? `history risk for ${paths.length} path${paths.length === 1 ? "" : "s"}:`
            : `history risk for the ${paths.length} file${paths.length === 1 ? "" : "s"} changed in the working tree:`,
        );
        rawPaths = paths;
        break;
      }
      case "symbol": {
        if (!args.name_path) return errorResult("name_path is required");
        const matches = findSymbols(db, args.name_path, { limit: 3 });
        const node = matches[0];
        if (!node) return errorResult(`no symbol matching ${args.name_path}`);
        out = renderSymbol(model, node, limit);
        if (matches.length > 1)
          out += `\n(${matches.length - 1} other match${matches.length === 2 ? "" : "es"}: ${matches
            .slice(1)
            .map((n) => `${n.path}#${n.name}`)
            .join(", ")})`;
        rawPaths = [node.path];
        break;
      }
    }
    // What Claude would otherwise have read: git log for the window plus the files involved.
    const rawChars =
      model.commits.reduce(
        (a, c) => a + c.subject.length + c.body.length + c.files.length * 40 + 120,
        0,
      ) + fileBytes(db, rawPaths);
    recordStat(ctx, "em_history", {
      rawChars,
      returnedChars: out.length,
      durationMs: Date.now() - started,
    });
    return text(out);
  },
});
