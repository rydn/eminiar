import { realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { getContext } from "../context.js";
import { type DocSource, readManifestAt } from "../docs/manifest.js";
import { git } from "../history/log.js";
import { renderProjectBrief } from "../session/brief.js";
import {
  commitContext,
  fileContext,
  memoriesForFile,
  recallForText,
  recordShown,
} from "../session/recall.js";
import { serverAlive } from "../session/server-alive.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { contextModeInstalled, effectiveRoutingMode } from "./coexist.js";
import { hookLog } from "./log.js";
import type { HookHandler, HookInput, HookOutput } from "./types.js";

const SYMBOL_KINDS = ["function", "class", "method", "interface", "type", "enum", "variable"];

/** The longest identifier-like run in a Grep/Glob pattern (`parse\w+File` → `parse`). */
export function literalOf(pattern: string): string | undefined {
  const runs = pattern.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const best = runs.sort((a, b) => b.length - a.length)[0];
  return best && !/^(ts|js|tsx|jsx|src|lib|test|spec|index)$/i.test(best) ? best : undefined;
}

/**
 * Graph symbols whose name contains the pattern's literal: a jump target instead of a
 * grep, delivered as context without blocking the call.
 */
export function symbolHints(db: StorageAdapter, pattern: string): string | undefined {
  const lit = literalOf(pattern);
  if (!lit) return undefined;
  const nodes = db.graphFindNodes({ query: lit, kinds: SYMBOL_KINDS, limit: 5 });
  if (!nodes.length) return undefined;
  const list = nodes
    .map((n) => `${n.kind} ${n.name} (${n.path}:${n.start_line ?? "?"})`)
    .join("; ");
  return `eminiar graph: symbols matching "${lit}": ${list}. em_symbols {name_path, include_body: true} reads one; {mode:"references"} lists its callers.`;
}

/** Why a file is not fully in the graph, so absence of callers is not over-trusted. */
export function coverageHint(db: StorageAdapter, rel: string): string | undefined {
  const row = db.fileIndexGet(rel);
  if (!row || row.status === "indexed") return undefined;
  return `eminiar graph: ${rel} is ${row.status}${row.reason ? ` (${row.reason})` : ""}; graph answers about it may be incomplete.`;
}

interface Suggestion {
  tool: string;
  reason: string;
  /** For Agent/Task in enforce mode: prefix the prompt instead of denying. */
  prefixPrompt?: string;
  /** Context only, never a denial (the native tool is still the right one). */
  annotateOnly?: boolean;
}

/** Registered documentation sources (default manifest location; cheap, cached by the OS). */
function docsSources(root: string): DocSource[] {
  try {
    return readManifestAt(join(root, ".eminiar", "docs.json")).sources;
  } catch {
    return [];
  }
}

/** The documentation source whose seed hosts cover this URL, if any. */
export function docsSourceFor(url: string, root: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const s of docsSources(root)) {
    for (const u of s.urls ?? []) {
      try {
        const h = new URL(u).hostname.toLowerCase();
        if (host === h || host.endsWith(`.${h.replace(/^(www|docs|developer|developers)\./, "")}`))
          return s.name;
      } catch {
        // skip malformed seed
      }
    }
  }
  return undefined;
}

const HEAVY_BASH =
  /^\s*(git\s+(log|diff|show|blame)|npm\s+(test|run|ls|list|outdated|audit|why)|pnpm\s+(test|run|ls|list|outdated|why)|yarn\s+(test|run|list|why)|npx\s+(vitest|jest|tsc|eslint|biome)|cat\s|head\s|tail\s|find\s|grep\s|rg\s|ls\s+-[a-zA-Z]*R|tree\b|curl\s|wget\s|docker\s|kubectl\s|du\s|df\s|ps\s|lsof\s|brew\s+(list|outdated)|pip\s+(list|freeze)|cargo\s+(test|build)|go\s+(test|build)|make\b|pytest\b|mvn\b|gradle\b)/;
const TINY_BASH =
  /^\s*(git\s+(status|branch)\b[^|]*|pwd|ls(\s+-[a-zA-Z]+)?(\s+\S+)?|echo\s.*|which\s+\S+|node\s+-v|npm\s+-v|cd\s+\S+|mkdir\s.*|touch\s.*|cp\s.*|mv\s.*|rm\s.*|chmod\s.*|date|whoami)\s*$/;
const BIG_TEXT_EXT = new Set([
  ".log",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".xml",
  ".txt",
  ".ndjson",
  ".sql",
  ".har",
]);
/**
 * Files Read shows to the model as images or pages, not as text. em_execute_file only returns
 * what code prints, so routing these there loses the content instead of saving context.
 * (SVG is text and stays routable.)
 */
const VISUAL_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"]);

/** A command with its heredoc bodies cut out: they are data, not commands to classify. */
export function withoutHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<$2");
}

/** Decide whether a native tool call is better served by an em_* tool. */
export function suggest(
  toolName: string,
  input: Record<string, unknown>,
  root: string,
): Suggestion | undefined {
  switch (toolName) {
    case "Bash": {
      const cmd = withoutHeredocs(String(input.command ?? ""));
      if (!cmd || TINY_BASH.test(cmd)) return undefined;
      // `cat > file` / `cat >> file <<EOF` writes a file and prints nothing
      if (/^\s*cat\b[^|\n]*>/.test(cmd) && !cmd.includes("|")) return undefined;
      if (HEAVY_BASH.test(cmd) || /\|\s*(head|tail|grep|wc|sort|uniq|jq|less)\b/.test(cmd)) {
        return {
          tool: "em_execute",
          reason: `this command is likely to print a lot; em_execute {language:"shell", code, intent} keeps the output out of context and returns only matching sections`,
        };
      }
      return undefined;
    }
    case "Read": {
      const fp = String(input.file_path ?? "");
      if (!fp) return undefined;
      const ext = extname(fp).toLowerCase();
      if (VISUAL_EXT.has(ext)) return undefined;
      try {
        const st = statSync(resolve(root, fp));
        if (st.size > 200 * 1024 || (BIG_TEXT_EXT.has(ext) && st.size > 20 * 1024)) {
          return {
            tool: "em_execute_file",
            reason: `${fp} is ${Math.round(st.size / 1024)} KB; em_execute_file {path, code} processes it in the sandbox so only what you print enters context`,
          };
        }
      } catch {
        // missing file: let Read report it
      }
      return undefined;
    }
    case "Grep": {
      if (input.output_mode === "content" && !input.head_limit) {
        return {
          tool: "em_execute",
          reason: `content-mode grep can be large; em_execute with rg and an intent returns only matching sections`,
        };
      }
      return undefined;
    }
    case "WebFetch": {
      const url = String(input.url ?? "");
      const covered = url ? docsSourceFor(url, root) : undefined;
      return {
        tool: "em_fetch_and_index",
        reason: covered
          ? `this site is already indexed as documentation source "${covered}" — em_docs {action:"lookup", query} answers from the index; em_fetch_and_index {url, queries} fetches one page if it is missing`
          : `em_fetch_and_index {url, queries} indexes the page and returns only the relevant sections; em_docs {action:"add", url} keeps documentation permanently`,
      };
    }
    case "WebSearch": {
      const sources = docsSources(root);
      if (!sources.length) return undefined;
      const names = sources.slice(0, 10).map((s) => s.name);
      return {
        tool: "em_docs",
        annotateOnly: true,
        reason: `${sources.length} documentation source(s) are indexed locally (${names.join(", ")}${sources.length > 10 ? ", …" : ""}); em_docs {action:"lookup", query} answers from them without a web round trip`,
      };
    }
    case "Agent":
    case "Task":
      return {
        tool: "em_*",
        reason:
          "subagents should prefer em_execute / em_batch_execute / em_search over Bash, Read and Grep",
        prefixPrompt:
          'Use the eminiar tools (em_execute, em_batch_execute, em_execute_file, em_fetch_and_index, em_search) instead of Bash/Read/Grep/WebFetch whenever output may be large; return only derived answers. Check em_recall {query} for project decisions and constraints before proposing changes, and em_docs {action:"lookup", query} before WebFetch/WebSearch for anything the project depends on.\n\n',
      };
    default:
      return undefined;
  }
}

/** Project-relative path of a tool's file_path, or undefined when it is outside the project. */
function projectRel(ctx: ProjectContext, fp: string): string | undefined {
  if (!fp) return undefined;
  let abs = resolve(ctx.root, fp);
  try {
    abs = realpathSync(abs); // the project root is a real path; tool paths may go through symlinks
  } catch {
    // missing file (a Write creating it, or Read about to report it)
  }
  const rel = relative(ctx.root, abs).split("\\").join("/");
  return rel.startsWith("..") ? undefined : rel;
}

/**
 * Non-blocking context for navigation tools: matching graph symbols for Grep/Glob
 * patterns, coverage gaps for files about to be read. Never denies anything.
 */
function graphContext(ctx: ProjectContext, input: HookInput): string | undefined {
  try {
    const db = getStorage(ctx, { vectors: false });
    if (!db.graphCounts().nodes) return undefined;
    if (input.tool_name === "Grep" || input.tool_name === "Glob") {
      const pattern = String(input.tool_input?.pattern ?? "");
      return pattern ? symbolHints(db, pattern) : undefined;
    }
    if (input.tool_name === "Read") {
      const rel = projectRel(ctx, String(input.tool_input?.file_path ?? ""));
      return rel ? coverageHint(db, rel) : undefined;
    }
  } catch {
    // hints are optional
  }
  return undefined;
}

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * Before a file is read or edited: the memories linked to it; before an edit, also its fix
 * history and fan-in. Each once per context window.
 */
function fileKnowledge(ctx: ProjectContext, input: HookInput): string | undefined {
  if (!ctx.config.recall.onFile || !FILE_TOOLS.has(input.tool_name ?? "")) return undefined;
  try {
    const rel = projectRel(ctx, String(input.tool_input?.file_path ?? ""));
    if (!rel) return undefined;
    const db = getStorage(ctx, { vectors: false });
    const sessionId = input.session_id || undefined;
    const results = [memoriesForFile(db, rel, { sessionId })];
    if (EDIT_TOOLS.has(input.tool_name ?? "")) results.push(fileContext(db, rel, { sessionId }));
    const shown = results.filter((r) => r.text);
    if (!shown.length) return undefined;
    if (sessionId)
      recordShown(
        db,
        sessionId,
        shown.flatMap((r) => r.keys),
      );
    return shown.map((r) => r.text).join("\n");
  } catch {
    return undefined;
  }
}

/** Files a `git commit` command will include: the index, plus tracked changes with -a. */
function commitFiles(root: string, cmd: string): string[] {
  const list = (args: string[]) =>
    git(root, args, { allowFail: true })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const files = new Set(list(["diff", "--cached", "--name-only"]));
  if (/\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(cmd))
    for (const f of list(["diff", "--name-only"])) files.add(f);
  return [...files];
}

/** Before `git commit`: the bug-prone and widely imported files it includes. */
function commitKnowledge(ctx: ProjectContext, input: HookInput): string | undefined {
  if (!ctx.config.recall.onCommit || input.tool_name !== "Bash") return undefined;
  const cmd = withoutHeredocs(String(input.tool_input?.command ?? ""));
  if (!/(^|[;&|]\s*)git\s+commit\b/.test(cmd)) return undefined;
  try {
    const db = getStorage(ctx, { vectors: false });
    return commitContext(db, commitFiles(ctx.root, cmd)) || undefined;
  } catch {
    return undefined;
  }
}

/** Words of a URL worth searching for (`/docs/api/rate-limits` → `docs api rate limits`). */
function urlWords(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.split(".").slice(0, -1).join(" ")} ${u.pathname.replace(/[/_\-.]+/g, " ")}`;
  } catch {
    return "";
  }
}

/** Before WebSearch / WebFetch: the indexed doc pages that already answer it. */
async function webKnowledge(ctx: ProjectContext, input: HookInput): Promise<string | undefined> {
  if (!ctx.config.recall.onWeb) return undefined;
  const ti = input.tool_input ?? {};
  const text =
    input.tool_name === "WebSearch"
      ? String(ti.query ?? "")
      : input.tool_name === "WebFetch"
        ? `${String(ti.prompt ?? "")} ${urlWords(String(ti.url ?? ""))}`
        : "";
  if (!text.trim()) return undefined;
  try {
    const db = getStorage(ctx, { vectors: false });
    const r = await recallForText(db, text, { maxMemories: 0, maxDocs: 3 });
    if (!r.text) return undefined;
    const pages = r.text.split("\n").filter((l) => l.startsWith("- docs:"));
    return [
      'eminiar docs: the local documentation index already has pages on this — try em_docs {action:"lookup", query} before the web:',
      ...pages,
    ].join("\n");
  } catch {
    return undefined;
  }
}

function joinHints(...hints: Array<string | undefined>): string | undefined {
  const h = hints.filter(Boolean);
  return h.length ? h.join("\n") : undefined;
}

function withContext(
  out: HookOutput | undefined,
  extra: string | undefined,
): HookOutput | undefined {
  if (!extra) return out;
  if (!out)
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: extra } };
  const cur = out.hookSpecificOutput?.additionalContext;
  return {
    ...out,
    hookSpecificOutput: {
      ...out.hookSpecificOutput,
      hookEventName: "PreToolUse",
      additionalContext: cur ? `${cur}\n${extra}` : extra,
    },
  };
}

export const preToolUse: HookHandler = async (
  input: HookInput,
): Promise<HookOutput | undefined> => {
  if (!input.tool_name || !input.tool_input) return undefined;
  const ctx = getContext(input.cwd);
  // Project knowledge is pushed in every routing mode: switching routing off should not
  // hide decisions, fix history or the docs that are already indexed.
  const memo = joinHints(
    fileKnowledge(ctx, input),
    commitKnowledge(ctx, input),
    await webKnowledge(ctx, input),
  );
  const mode = effectiveRoutingMode(ctx.config);
  if (mode === "off") return withContext(undefined, memo);
  const coexisting = contextModeInstalled() && ctx.config.routing.deferToContextMode;
  // context-mode already routes these; adding a second opinion only confuses the model.
  if (coexisting && ["Bash", "Read", "Grep", "WebFetch"].includes(input.tool_name))
    return withContext(undefined, memo);

  const hint = joinHints(graphContext(ctx, input), memo);
  const s = suggest(input.tool_name, input.tool_input, ctx.root);
  if (!s) return withContext(undefined, hint);
  if (s.annotateOnly) return withContext(annotate(s), hint);

  if (mode === "enforce") {
    if (s.prefixPrompt) {
      const prompt = String(input.tool_input.prompt ?? "");
      if (prompt.startsWith(s.prefixPrompt)) return undefined;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            ...input.tool_input,
            prompt: s.prefixPrompt + (await briefFor(ctx, prompt)) + prompt,
          },
        },
      };
    }
    // Denying only makes sense if there is an em_* server to retry with. If none is
    // running for this project (failed to start, not yet connected, dev checkout
    // without the plugin loaded), fall back to annotating so Claude is never stranded.
    if (!serverAlive(ctx)) {
      hookLog(
        "info",
        `enforce → annotate for ${input.tool_name}: no eminiar MCP server running for ${ctx.root}`,
      );
      return withContext(
        annotate(
          s,
          " eminiar MCP server is not running, so this call is allowed; /em-doctor explains.",
        ),
        hint,
      );
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `eminiar: ${s.reason}. Retry with ${s.tool}.${hint ? ` ${hint}` : ""}`,
      },
    };
  }
  // Annotate mode: subagents get the project brief as context since their prompt is untouched.
  const extra = s.prefixPrompt
    ? joinHints((await briefFor(ctx, String(input.tool_input.prompt ?? ""))).trim(), hint)
    : hint;
  return withContext(annotate(s), extra);
};

/**
 * The project brief for a subagent prompt, plus the memories and doc pages matching its
 * task: a subagent starts cold and never sees the parent's SessionStart or prompt recall.
 */
async function briefFor(ctx: ProjectContext, task: string): Promise<string> {
  const parts: string[] = [];
  try {
    const db = getStorage(ctx, { vectors: false });
    const brief = renderProjectBrief(ctx, db, 1200);
    if (brief)
      parts.push(
        `Project brief (eminiar):\n${brief}\nVerify structure with em_symbols / em_graph_impact before reading files; check em_index_status before claiming something is unused.`,
      );
    const { recall } = ctx.config;
    if (recall.onAgent && task) {
      const r = await recallForText(db, task, {
        maxMemories: recall.maxMemories,
        maxDocs: recall.maxDocs,
      });
      if (r.text) parts.push(r.text);
    }
  } catch {
    // the brief is optional
  }
  return parts.length ? `${parts.join("\n\n")}\n\n` : "";
}

function annotate(s: Suggestion, note = ""): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `eminiar: ${s.reason} (${s.tool}).${note}`.slice(0, 400),
    },
  };
}
