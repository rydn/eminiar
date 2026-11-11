import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { sessionContext } from "../context.js";
import { type DocSource, readManifestAt } from "../docs/manifest.js";
import { git } from "../history/log.js";
import { loadPermissionRules } from "../permissions/settings.js";
import { confinePath } from "../sandbox/file.js";
import { renderProjectBrief } from "../session/brief.js";
import {
  commitContext,
  fileContext,
  fileSymbols,
  memoriesForFile,
  recallForText,
  recordShown,
} from "../session/recall.js";
import { type RoutingEvent, recordRouting } from "../session/routing-stats.js";
import { serverAlive } from "../session/server-alive.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import {
  isSwarmTool,
  spawnType,
  swarmPreAgent,
  swarmStampCaller,
  swarmTouch,
  workerLacksTool,
} from "../swarm/hooks.js";
import { contextModeInstalled, effectiveRoutingMode } from "./coexist.js";
import { hookLog } from "./log.js";
import type { HookHandler, HookInput, HookOutput } from "./types.js";

const SYMBOL_KINDS = [
  "function",
  "class",
  "method",
  "interface",
  "trait",
  "type",
  "enum",
  "variable",
];

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
  const nodes = db.graphFindNodes({
    query: lit,
    kinds: SYMBOL_KINDS,
    limit: 5,
  });
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

/** A history read: [1] the options before the subcommand (`-C dir`), [2] it, [3] its arguments. */
const GIT_HISTORY =
  /(?:^|[;&|]\s*)git\s+((?:(?:-C|--git-dir|--work-tree)[= ]\S+\s+|--no-pager\s+)*)(log|blame|shortlog|show|whatchanged|reflog)\b([^;&|]*)/;
/** One commit, printed short: `git log -1 --format=%H` is a lookup, not a history read. */
const ONE_COMMIT = /(^|\s)(-1|-n\s*1|-n1|--max-count[= ]1)(?=\s|$)/;

/**
 * The em_history call that answers a `git log` / `blame` / `show` / `shortlog` command,
 * or undefined when the command is not a history read (or prints a file, like
 * `git show HEAD:path`).
 */
export function historyCall(cmd: string): string | undefined {
  const m = GIT_HISTORY.exec(cmd);
  if (!m) return undefined;
  const sub = m[2]!;
  const rest = (m[3] ?? "").trim();
  const args = rest.split(/\s+/).filter(Boolean);
  const q = (s: string) => JSON.stringify(s.replace(/^['"]|['"]$/g, ""));
  const positional = (a: string) => !a.startsWith("-");
  if (sub === "show") {
    if (/\S+:\S+/.test(rest)) return undefined; // `git show REF:path` prints a file
    const sha = args.find(positional);
    return `{action:"commit", sha:${q(sha ?? "HEAD")}}`;
  }
  if (sub === "blame") {
    const path = args.filter(positional).pop();
    return path ? `{action:"file", path:${q(path)}}` : undefined;
  }
  if (sub === "log" && ONE_COMMIT.test(rest) && !/(^|\s)(-p|--patch|--stat)\b/.test(rest))
    return undefined;
  const lineRange = /-L\s*:?([^:\s]+):(\S+)/.exec(rest);
  if (lineRange) {
    const [, fn, file] = lineRange;
    return /^[A-Za-z_$]/.test(fn!)
      ? `{action:"symbol", name_path:${q(`${file}#${fn}`)}}`
      : `{action:"file", path:${q(file!)}}`;
  }
  const grep = /--grep[= ]("[^"]*"|'[^']*'|\S+)/.exec(rest);
  if (grep) return `{action:"search", query:${q(grep[1]!)}}`;
  const author = /--author[= ]("[^"]*"|'[^']*'|\S+)/.exec(rest);
  const range = args.find((a) => positional(a) && /\.\.\.?/.test(a));
  if (range) {
    const [a, b] = range.split(/\.\.\.?/);
    return `{action:"branch", name:${q(b || a || "HEAD")}}`;
  }
  const dash = args.indexOf("--");
  const path =
    dash !== -1
      ? args[dash + 1]
      : args.find((a) => positional(a) && /[/.]/.test(a) && !/^[0-9a-f]{7,40}$/i.test(a));
  if (path) return `{action:"file", path:${q(path)}}`;
  if (author) return `{action:"timeline", author:${q(author[1]!)}}`;
  if (sub === "shortlog") return `{action:"timeline"}`;
  return `{action:"overview"}`;
}

/**
 * The directory the first history read in these segments runs in: the shell's, moved by each
 * `cd` before it and by `git -C`. Undefined when the shell decides (`cd $X`, `cd -`) or git is
 * pointed at a repository directly (`--git-dir`, `--work-tree`).
 */
function historyDir(segments: string[], cwd: string): string | undefined {
  let dir: string | undefined = cwd;
  // Each step resolves a longer path: past MAX_STEPS of them, only the shell knows where it is.
  let steps = 0;
  const step = (arg: string) => {
    dir = ++steps > MAX_STEPS ? undefined : dir && changeDir(dir, arg);
  };
  for (const segment of segments) {
    const m = GIT_HISTORY.exec(segment);
    if (m) {
      const opts = m[1] ?? "";
      if (/--(git-dir|work-tree)\b/.test(opts)) return undefined;
      for (const c of opts.matchAll(/-C[= ](\S+)/g)) {
        step(c[1]!);
        if (!dir) return undefined;
      }
      return dir;
    }
    const cd = CD.exec(segment);
    if (cd) step(cd[1]!);
    if (!dir) return undefined;
  }
  return dir;
}

/** A directory change: `cd dir`, `pushd dir`, `(cd dir`. */
const CD = /^\(?\s*(?:cd|pushd)\b(.*)$/;
/** Most `cd` / `git -C` steps followed, and `$(…)` levels unwrapped, before giving up. */
const MAX_STEPS = 16;
/** The longest raw command looked at, and the longest line (heredoc bodies cut) classified. */
const MAX_RAW = 64 * 1024;
const MAX_CLASSIFIED = 8 * 1024;
/** The most file operands a cat / grep stage is sized by, and commands a routed line holds. */
const MAX_OPERANDS = 64;
const MAX_SEGMENTS = 64;

/** Where `cd <arg>` from `dir` lands, or undefined when only the shell knows. */
function changeDir(dir: string, arg: string): string | undefined {
  const a = arg.trim().replace(/^(['"])(.*)\1$/, "$2") || "~";
  if (/^-|^~[^/]|[\s$`*?[\]{}()\\]/.test(a)) return undefined;
  return a === "~" || a.startsWith("~/") ? join(homedir(), a.slice(1)) : resolve(dir, a);
}

/**
 * Is `dir` in the root's own repository: under the root, with the nearest `.git` (a folder, or
 * a worktree's file) at or above the root rather than in a nested repository on the way?
 */
function inRootRepo(root: string, dir: string): boolean {
  try {
    const top = realpathSync(root);
    let inside = false;
    for (let d = realpathSync(dir); ; d = dirname(d)) {
      if (d === top) inside = true;
      if (existsSync(join(d, ".git"))) return inside;
      if (dirname(d) === d) return false; // no repository at all
    }
  } catch {
    return false; // a directory that does not exist: git fails there too
  }
}

/** The repository (its `.git` folder's parent) a directory belongs to, or undefined for none. */
function repoOf(dir: string): string | undefined {
  try {
    for (let d = realpathSync(dir); ; d = dirname(d)) {
      if (existsSync(join(d, ".git"))) return d;
      if (dirname(d) === d) return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Would a git command run from the root (where em_execute runs) read the repository `dir` is in? */
function sameRepo(root: string, dir: string): boolean {
  return repoOf(root) === repoOf(dir);
}

export interface Suggestion {
  tool: string;
  reason: string;
  /** Which rule fired (heavy, pipe, big-read, history, symbol, …), for routing statistics. */
  rule?: string;
  /** For Agent/Task in enforce mode: prefix the prompt instead of denying. */
  prefixPrompt?: string;
  /** Context only, never a denial (the native tool is still the right one). */
  annotateOnly?: boolean;
}

/** What preToolUse already knows that changes a suggestion. */
export interface SuggestExtra {
  /** For Grep: the pattern's identifier when the graph defines symbols by that name. */
  symbol?: string | undefined;
  /** For Bash: the directory relative paths resolve against (the hook's cwd). */
  cwd?: string | undefined;
}

/** Registered documentation sources (default manifest location; cheap, cached by the OS). */
function docsSources(root: string): DocSource[] {
  try {
    // `root` keeps a committed docs.json symlink that points outside the project unread.
    return readManifestAt(join(root, ".eminiar", "docs.json"), root).sources;
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

/**
 * Commands that usually print a lot. kubectl, docker, curl, wget, make and `npm run` reach this only
 * in their read-only forms: `staysNative` keeps the others native first.
 */
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

/**
 * A command with its heredoc bodies cut out: they are data, not commands to classify. The rest of
 * the `<<EOF` line stays (`cat <<EOF | kubectl apply -f -`).
 */
export function withoutHeredocs(cmd: string): string {
  if (!cmd.includes("<<")) return cmd;
  // One pass: each `<<WORD` header looks for its terminator line once per word (a word whose
  // terminator is missing from one position is missing from every later one too), so a line of
  // thousands of unterminated `<<A` costs what reading it does.
  const head = /<<-?\s*(['"]?)(\w+)\1/y;
  const seen = new Map<string, { from: number; at: number; end: number }>();
  const terminator = (word: string, from: number): number => {
    const c = seen.get(word);
    if (c && from >= c.from && (c.at === -1 || from <= c.at)) return c.end;
    // The last line break before the word: `\n\s*WORD` with `\s*` across lines would rescan a
    // run of blank lines from each of its line breaks.
    const re = new RegExp(String.raw`\n[^\S\n]*${word}\s*(?=\n|$)`, "g");
    re.lastIndex = from;
    const m = re.exec(cmd);
    const rec = m ? { from, at: m.index, end: m.index + m[0].length } : { from, at: -1, end: -1 };
    seen.set(word, rec);
    return rec.end;
  };
  let out = "";
  let copied = 0;
  for (let k = cmd.indexOf("<<"); k !== -1; k = cmd.indexOf("<<", Math.max(k + 1, copied))) {
    head.lastIndex = k;
    const m = head.exec(cmd);
    if (!m) continue;
    const word = m[2]!;
    const eol = cmd.indexOf("\n", head.lastIndex);
    if (eol === -1) break; // no body, here or after
    const end = terminator(word, eol + 1);
    if (end === -1) continue;
    out += `${cmd.slice(copied, k)}<<${word}${cmd.slice(head.lastIndex, eol)}`;
    copied = end;
  }
  return out + cmd.slice(copied);
}

/**
 * Split `s` at every unquoted position where `sep` returns the separator's length. A backslash
 * outside single quotes escapes the next character (`"x\\"` ends at its second `"`); single quotes
 * have no escapes, `$'…'` does.
 */
function splitUnquoted(s: string, sep: (s: string, i: number) => number): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote === "'") {
      cur += ch;
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote[quote.length - 1]) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // `$'…'` is quoted like "…" for escapes, closed by '
      quote = ch === "'" && s[i - 1] === "$" ? "$'" : ch;
      cur += ch;
      continue;
    }
    const n = sep(s, i);
    if (n) {
      out.push(cur);
      cur = "";
      i += n - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** The simple commands a shell line runs in sequence: split at `;`, `&`, `&&`, `||` and newlines. */
export function commandSegments(cmd: string): string[] {
  return splitUnquoted(cmd, (s, i) => {
    const ch = s[i];
    if (ch === ";" || ch === "\n") return 1;
    if ((ch === "&" || ch === "|") && s[i + 1] === ch) return 2;
    // A lone `&` backgrounds the command before it; not `2>&1`, `&>f`, `<&3`, `|&`.
    if (ch === "&" && !/[&<>|]/.test(s[i - 1] ?? "") && !/[&>]/.test(s[i + 1] ?? "")) return 1;
    return 0;
  });
}

/**
 * The words of a simple command as the program receives them: quotes removed, backslash escapes
 * resolved (`r''m`, `"rm"`, `\rm` are all `rm`; `$'DELETE'` is `DELETE`). Expansions stay as written.
 */
function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === "\\") {
      cur += s[++i] ?? "";
    } else if (ch === "'" && s[i - 1] !== "$") {
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      cur += s.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"' || (ch === "$" && s[i + 1] === "'")) {
      const close = ch === '"' ? '"' : "'";
      if (ch === "$") i++;
      for (i++; i < s.length && s[i] !== close; i++) {
        if (s[i] === "\\" && i + 1 < s.length) i++;
        cur += s[i];
      }
    } else {
      cur += ch;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** The stages of one pipeline: `a | b | c` → [a, b, c]. */
function pipeStages(segment: string): string[] {
  return splitUnquoted(segment, (s, i) => (s[i] === "|" && s[i + 1] !== "|" ? 1 : 0));
}

/** Lines a `head` / `tail` stage keeps: its -n / -N argument, or the default 10. */
function headLines(stage: string): number {
  const m = /(?:^|\s)(?:-n\s*=?\s*|-)(\d+)(?=\s|$)|--lines[= ](\d+)/.exec(stage);
  return m ? Number(m[1] ?? m[2]) : 10;
}

/** The most lines a bounded final stage may print before it counts as a lot. */
const BOUNDED_LINES = 400;

/** Does this pipe stage cap the output (`head -40`, `tail -5`, `wc -l`)? */
function bounds(stage: string): boolean {
  if (/^\s*wc\b/.test(stage)) return true;
  if (!/^\s*(head|tail)\b/.test(stage) || /(^|\s)-c\b|--bytes\b/.test(stage)) return false;
  return headLines(stage) <= BOUNDED_LINES;
}

/**
 * Commands whose point is a side effect: commits, installs, file writes, deploys, running a
 * project's own scripts or recipes (`make`, `npm run <x>`: judged in CHANGES below). Their output
 * is secondary and the native Bash tool is where Claude Code's permission prompts live, so a
 * command containing one is never redirected to the sandbox.
 */
const GIT_MUTATING =
  /^(git\s+(?:(?:-[Cc]\s*[^-\s]\S*|--(?:git-dir|work-tree)[= ]\S+|--no-pager)\s+)*(add|commit|checkout|switch|push|pull|fetch|merge|rebase|stash|reset|restore|cherry-pick|revert|tag|init|clone|worktree|mv|rm|am|apply|submodule|clean|branch\s(?:.*\s)?(-[a-zA-Z]*[dDmM][a-zA-Z]*|--delete|--move)|config(?:\s+--(?:global|local|system|worktree))*\s+(?:set|unset|--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)|-e|\w[\w.-]*\s+\S+)))(?![\w-])/;
const OTHER_MUTATING =
  /^(npm\s+(install|i|ci|uninstall|un|link|publish|version|update|up|dedupe|audit\s+fix)|pnpm\s+(install|i|add|remove|rm|update|up|link|audit\s.*--fix)|yarn\s+(add|remove|install|upgrade)|pip3?\s+(install|uninstall)|cargo\s+(add|install)|brew\s+(install|uninstall|upgrade)|gh\s+(pr|issue|release|repo)\s+(create|edit|merge|close|comment|delete|ready)|terraform\s+(?:-\S+\s+)*(apply|destroy|import|taint|untaint|state\s+(rm|mv|push))|helm\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*(install|upgrade|uninstall|rollback|delete)|mvnw?(?:\s.*)?\s(deploy|install|release:\S*)|gradlew?(?:\s.*)?[\s:](publish|upload)\w*|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|sed\s+(?:-\S+\s+)*-i|tee|eval|sh|bash|zsh|find\s.*\s-(delete|exec|execdir|ok|okdir))(?![\w-])/;
const MUTATING_WORDS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "cargo",
  "brew",
  "gh",
  "terraform",
  "helm",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "sed",
  "tee",
  "eval",
  "sh",
  "bash",
  "zsh",
  "find",
]);
const MUTATING = {
  test(cmd: string): boolean {
    const word = /^[A-Za-z0-9]*/.exec(cmd)![0];
    if (word === "git") return GIT_MUTATING.test(cmd);
    return MUTATING_WORDS.has(word) && OTHER_MUTATING.test(cmd);
  },
};
/**
 * Commands that run the one after them, with the options they take (`sudo -u root`, `timeout 30`).
 * Each option is either one that takes a value or one that does not, never both: an ambiguous
 * split backtracks exponentially on a line of many flags.
 */
const longOpts = (valued: string) =>
  String.raw`--(?:${valued})\s+[^-\s]\S*|--(?!(?:${valued})(?:\s|$))\S*`;
const RUNNERS = [
  String.raw`sudo(?:\s+(?:-[ugCDhpRrtTU]\s*[^-\s]\S*|-(?![ugCDhpRrtTU-])\S+|${longOpts("user|group|chdir|host|prompt|close-from|role|type|other-user|chroot|command-timeout")}))*`,
  String.raw`env(?:\s+(?:-[uC]\s*[^-\s]\S*|-(?![uC-])\S+|${longOpts("unset|chdir|split-string")}))*`,
  String.raw`(?:xargs|parallel)(?:\s+(?:-[nILPsdEaj]\s*[^-\s]\S*|-(?![nILPsdEaj-])\S+|${longOpts("max-args|max-procs|max-lines|max-chars|delimiter|arg-file|eof|jobs")}))*`,
  String.raw`timeout(?:\s+(?:-[sk]\s*[^-\s]\S*|-(?![sk-])\S+|${longOpts("signal|kill-after")}))*\s+\d\S*`,
  String.raw`nice(?:\s+-n\s*\S+|\s+-\d+|\s+--adjustment(?:=|\s+)\S+)?`,
  String.raw`stdbuf(?:\s+-[ioe]\s*\S+)*`,
  String.raw`(?:time|command)(?:\s+-p)?`,
  "nohup",
  String.raw`[A-Z_][A-Z0-9_]*=\S*`,
];
/** Shell grammar before a command: `{ rm x; }`, `( … )`, `! cmd`, `then cmd`, `do cmd` …. */
const SHELL_WORDS = /^(?:\s*(?:[({!]|(?:then|do|else|exec|if|elif|while|until)\s))*\s*/;
/** What runs the command after it, which is the one to judge: `sudo`, `FOO=1`, `xargs -0` …. */
const RUNNER = new RegExp(String.raw`^\s*(?:(?:${RUNNERS.join("|")})\s+)*`);
const RUNNER_HEAD = /^\s*(?:sudo|env|xargs|parallel|timeout|nice|stdbuf|time|command|nohup|[A-Z_])/;
const stripRunners = (s: string) =>
  RUNNER_HEAD.test(s) ? s.replace(RUNNER, "") : s.replace(/^\s+/, "");
/**
 * A redirection into a file (`> f`, `>> f`, `&> f`, `cmd>f`; not /dev/null, not `2>&1`) writes
 * something. `=>` and `->` are not redirections.
 */
const WRITES_FILE = /(?:^|[\s\d&])>{1,2}\s*(?!&)(?!\/dev\/null)\S/;
/** The same for a `>` glued to the word before it (`cmd>f`), once quoted text is taken out. */
const GLUED_WRITE = /(?<![-=>])>{1,2}\s*(?!&)(?!\/dev\/null)\S/;
/** A program read from a pipe (`curl … | python3`): whatever it does, it does like `| sh`. */
const RUNS_STDIN = /^(python3?|node|perl|ruby|deno|bun)(\s+-\S*)*$/;
/** Commands that never finish (follow, `--watch`): em_execute would only time out on them. */
const FOLLOWS =
  /^((kubectl|docker)(\s.*)?\s(-f|-w|--follow)(?=[\s=]|$)|tail(\s.*)?\s(-[a-zA-Z]*[fF]|--follow)|.*\s--watch(All)?(?=[\s=]|$))/;

/**
 * curl sending or saving something: a method other than GET / HEAD, a body, an upload, an output
 * file, a header dump (`-D`), a cookie jar (`-c`), a trace or a config file. In a flag cluster,
 * everything after `X` is its value (`-sXGET`).
 */
const CURL_SENDS =
  /\s(?:-(?:(?!X)[a-zA-Z])*[dFTOoKDc]|(?:-[a-zA-Z]*X|--request)(?![\s=]*['"]?(?:GET|HEAD)\b)|--(?:data|json|form|upload-file|output|remote-name|config|dump-header|cookie-jar|trace|stderr|create-dirs|libcurl|etag-save|hsts|alt-svc))/;
/** wget printing instead of saving: `-O -`, `-qO-`, `--output-document=-`, or `--spider`. */
const WGET_PRINTS = /\s(?:-[a-zA-Z]*O\s*-|--output-document[= ]-|--spider)(?=\s|$)/;
/** wget sending, or writing a log (`-o` / `-a`) or running a wgetrc command (`-e`). */
const WGET_SENDS =
  /\s(?:--(post-data|post-file|body-data|body-file|method|output-file|append-output|execute|config)\b|-[a-zA-Z]*[oae])/;
const KUBECTL_READS =
  /^(get|describe|logs|top|explain|api-resources|api-versions|events|version|cluster-info|config\s+(view|get-contexts|current-context)|rollout\s+(status|history)|auth\s+can-i)\b/;
const DOCKER_READS =
  /^(ps|logs|images|inspect|history|version|info|stats\s.*--no-stream|(container|image|network|volume)\s+(ls|inspect)|compose\s+(ps|logs|config|images|ls)|system\s+df)\b/;
/**
 * Scripts and make targets that only test or check (`test:unit`, `lint`, `typecheck`), not ones
 * that fix, write, install, deploy or clean (`test-install`, `check:release`).
 */
const CHECK_SCRIPT =
  /^(t|test|lint|type-?check|check)(?=$|[:.-])(?![\w:.-]*(fix|write|update|install|deploy|publish|push|release|clean))/;
/** Arguments that turn a check into a write: `-- --fix`, `--write`, `-u` (update snapshots). */
const FIX_ARGS =
  /(?:^|\s)(--fix|--write|--apply(-unsafe)?|-u|--update(-?[sS]napshots?)?)(?=[\s=]|$)/;
/** npx tools that only check or test, unless told to fix or write (`jest`, `jest@29`; not `jest-x`). */
const NPX_CHECKS = /^(vitest|jest|tsc|eslint|biome|prettier)(?:@[\w.^~-]*)?$/;
/** pnpm / yarn words that are their own read-only commands, not scripts (`pnpm ls`, `yarn why`). */
const PM_READS = /^(ls|list|outdated|why|info|view|audit|licenses|bin|root|help)$/;
/**
 * Options that take the next word, before a subcommand, per tool: `-n prod` for kubectl,
 * `--prefix a` for npm. `-s` and `-w` are flags for most tools, so each tool has its own set.
 */
const VALUE_OPTS: Record<string, ReadonlySet<string>> = {
  kubectl: new Set([
    "-n",
    "--namespace",
    "--context",
    "--cluster",
    "--kubeconfig",
    "--user",
    "-s",
    "--server",
    "--token",
    "--as",
    "--as-group",
    "--as-uid",
    "--cache-dir",
    "--certificate-authority",
    "--client-certificate",
    "--client-key",
    "--password",
    "--username",
    "--profile",
    "--profile-output",
    "--request-timeout",
    "--tls-server-name",
    "--log-dir",
    "--log-file",
    "--log-file-max-size",
    "--vmodule",
    "-v",
    "--v",
  ]),
  docker: new Set([
    "-H",
    "--host",
    "-c",
    "--context",
    "--config",
    "-l",
    "--log-level",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
  ]),
  npm: new Set(["--prefix", "-w", "--workspace", "--userconfig", "--registry", "--cache"]),
  pnpm: new Set(["-C", "--dir", "--filter", "-F", "--workspace-dir"]),
  yarn: new Set(["--cwd", "--cache-folder", "--registry"]),
};
/**
 * Options before kubectl's / docker's subcommand known to take no value. One in neither set may
 * take the next word or not, so both readings are judged (`kubectl --x get delete pod p`).
 */
const FLAG_OPTS: Record<string, ReadonlySet<string>> = {
  kubectl: new Set([
    "--insecure-skip-tls-verify",
    "--match-server-version",
    "--warnings-as-errors",
    "--disable-compression",
    "--alsologtostderr",
    "--logtostderr",
    "--add-dir-header",
    "--skip-headers",
    "--skip-log-headers",
    "--one-output",
    "-h",
    "--help",
  ]),
  docker: new Set(["-D", "--debug", "--tls", "--tlsverify", "-v", "--version", "--help"]),
};
/** More readings than a real command line has: the options are not ones we can follow. */
const MAX_READINGS = 4;

/** The words after the options before them: ` -n prod get pods` → [get, pods]. */
function afterOptions(tool: string, args: string): string[] {
  const words = args.trim().split(/\s+/);
  const valued = VALUE_OPTS[tool];
  let i = 0;
  while (words[i]?.startsWith("-")) i += valued?.has(words[i]!) ? 2 : 1;
  return words.slice(i);
}

/**
 * The subcommands a kubectl / docker call may run (` --context prod get pods` → [get pods]). An
 * option in neither VALUE_OPTS nor FLAG_OPTS is read both ways; undefined when that gives more
 * readings than a real command line has.
 */
function subcommands(tool: string, args: string): string[] | undefined {
  const words = args.trim().split(/\s+/);
  const valued = VALUE_OPTS[tool];
  const flags = FLAG_OPTS[tool];
  const starts = new Set<number>();
  const seen = new Set<number>();
  const todo = [0];
  while (todo.length) {
    const i = todo.pop()!;
    if (seen.has(i)) continue;
    seen.add(i);
    const w = words[i];
    if (w === undefined || !w.startsWith("-")) {
      starts.add(i);
      if (starts.size > MAX_READINGS) return undefined;
    } else if (valued?.has(w)) todo.push(i + 2);
    else if (flags?.has(w) || w.includes("=") || /^-[^-]./.test(w)) todo.push(i + 1);
    else todo.push(i + 1, i + 2);
  }
  // The read-only forms are named by their first words (`rollout status`), `docker stats` also
  // by `--no-stream` wherever it is; a few words keep this linear in the number of readings.
  const tail = /\s--no-stream\b/.test(args) ? " --no-stream" : "";
  return [...starts].map((i) => words.slice(i, i + 3).join(" ") + tail);
}

/** Does a kubectl / docker call (any reading of its options) do more than read? */
function verbChanges(tool: string, reads: RegExp, args: string): boolean {
  const subs = subcommands(tool, args);
  return !subs || subs.some((s) => !reads.test(s));
}

/**
 * `npm run <script>`, `yarn <script>`, `pnpm --filter x <script>`: anything but a test or check
 * script run as a check. npm's own commands (`npm ls`) are not scripts; MUTATING names those that
 * change something.
 */
function runsScript(tool: string, args: string): boolean {
  const words = afterOptions(tool, args);
  let script = words.shift();
  if (script === "run" || script === "run-script") script = words.shift();
  else if (script === undefined || PM_READS.test(script) || (tool === "npm" && script !== "test"))
    return false;
  if (script === undefined) return false; // `npm run` lists the scripts
  return !CHECK_SCRIPT.test(script) || FIX_ARGS.test(words.join(" "));
}

/**
 * `make`: recipes run anything; only test / check / lint targets, not told to fix, read. `-j` and
 * `-l` take a number only when one follows (`make -j install` installs).
 */
function makeChanges(args: string): boolean {
  const words = shellWords(args);
  const targets: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^(-E|--eval)/.test(w)) return true; // make code given on the line
    if (w.startsWith("-")) {
      if (
        /^(-[CfIoW]|--(directory|file|makefile|include-dir|old-file|assume-old|what-if|new-file|assume-new))$/.test(
          w,
        ) ||
        (/^(-[jl]|--jobs|--load-average|--max-load)$/.test(w) &&
          /^\d+(\.\d+)?$/.test(words[i + 1] ?? ""))
      )
        i++;
      continue;
    }
    if (!w.includes("=")) targets.push(w);
  }
  return !targets.length || !targets.every((t) => CHECK_SCRIPT.test(t)) || FIX_ARGS.test(args);
}

/** gh api options that take the next word when it is not glued (`-H 'Accept: x'`). */
const GH_API_VALUED =
  /^(-[FfHXpqt]|--(method|field|raw-field|input|header|jq|template|preview|hostname|cache))$/;

/** `gh api`: a method other than GET, fields (which make it a POST), or a GraphQL mutation. */
function ghApiSends(args: string): boolean {
  // Words as gh receives them: `-X $'DELETE'`, `query='mut''ation{…}'`, `-ftitle=x` hide nothing.
  const words = shellWords(args);
  if (words[0] !== "api") return false;
  let method: string | undefined;
  let fields = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const long = /^--(method|field|raw-field|input)(?:=|$)/.exec(w)?.[1];
    if (long) {
      if (long === "method")
        method = w.includes("=") ? w.slice(w.indexOf("=") + 1) : (words[i + 1] ?? "");
      else fields = true;
    } else if (/^-[a-zA-Z]/.test(w)) {
      // a flag cluster: `-i` takes no value, the first letter that does takes the rest or the next word
      const c = w.slice(1).replace(/^i+/, "")[0];
      const value = w.slice(w.indexOf(c ?? "") + 1) || (words[i + 1] ?? "");
      if (c === "X") method = value;
      else if (c === "f" || c === "F") fields = true;
    }
    if (GH_API_VALUED.test(w)) i++;
  }
  if (method !== undefined) return method.toUpperCase() !== "GET";
  if (words.includes("graphql")) return /\bmutation\b/.test(words.join(" "));
  return fields;
}

/**
 * `npx`: only the check tools, as checks. Not a package that merely starts with one's name
 * (`jest-x`), not one run from another package (`-p`), not one told to fix or write a file
 * (`eslint -o f`, `--outputFile`, `prettier -w`), and `tsc` only when it emits nothing.
 */
function npxChanges(args: string, cwd: string): boolean {
  const words = shellWords(args);
  let i = 0;
  for (; words[i]?.startsWith("-"); i++)
    if (/^(-p|--package|-c|--call)(=|$)/.test(words[i]!)) return true;
  const [name = "", ...rest] = words.slice(i);
  const tool = NPX_CHECKS.exec(name)?.[1];
  if (!tool || FIX_ARGS.test(args)) return true;
  const has = (re: RegExp) => rest.some((w) => re.test(w));
  if (has(/^--(output-?file|outputFile|out-?dir|outFile|generateTrace)(=|$)/i)) return true;
  if (tool === "eslint" && has(/^-o/)) return true;
  if (tool === "prettier" && has(/^-[a-zA-Z]*w$/)) return true;
  return tool === "tsc" && !tscEmitsNothing(rest, cwd);
}

/** Does this `tsc` call only check: `--noEmit`, or a tsconfig that says so (not `-b`, not files)? */
function tscEmitsNothing(words: string[], cwd: string): boolean {
  if (words.some((w) => /^(-b|--build|--generateTrace)(=|$)/i.test(w))) return false;
  const noEmit = words.findIndex((w) => /^--noEmit(=true)?$/i.test(w));
  if (noEmit !== -1) return words[noEmit + 1] !== "false";
  let project = "tsconfig.json";
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^(-p|--project)$/i.test(w)) project = words[++i] ?? "";
    else if (!w.startsWith("-")) return false; // files, or an option's value we cannot place
  }
  try {
    let file = resolve(cwd, project);
    if (statSync(file).isDirectory()) file = join(file, "tsconfig.json");
    const st = statSync(file);
    if (st.size > 256 * 1024) return false;
    return /"noEmit"\s*:\s*true\b/.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Tools with read-only forms worth routing (`kubectl logs`, `curl -s url`, `npm test`): does
 * this call (the arguments after the tool's name, run in `cwd`) change something instead?
 */
const CHANGES = new Map<string, (args: string, cwd: string) => boolean>([
  ["curl", (a) => CURL_SENDS.test(a)],
  ["wget", (a) => !WGET_PRINTS.test(a) || WGET_SENDS.test(a)],
  ["kubectl", (a) => verbChanges("kubectl", KUBECTL_READS, a)],
  ["docker", (a) => verbChanges("docker", DOCKER_READS, a)],
  ["gh", ghApiSends],
  ["make", makeChanges],
  ["npx", npxChanges],
  ["npm", (a) => runsScript("npm", a)],
  ["pnpm", (a) => runsScript("pnpm", a)],
  ["yarn", (a) => runsScript("yarn", a)],
]);

/** How many words of `words` are operands rather than options (or the values `valued` options take). */
function operands(words: string[], valued: RegExp): number {
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") return n + words.length - i - 1;
    if (w.startsWith("-") && w.length > 1) {
      if (valued.test(w)) i++;
    } else n++;
  }
  return n;
}

/** gawk / awk running a command or writing a file from its program, or loading code from a file. */
function awkRuns(words: string[]): boolean {
  let program: string | undefined;
  for (let i = 0; i < words.length && program === undefined; i++) {
    const w = words[i]!;
    if (w === "--") program = words[i + 1];
    else if (/^(-[fiEl]|--(file|include|load|exec))/.test(w)) return true;
    else if (/^(-e|--source)$/.test(w)) program = words[i + 1];
    else if (/^(-[FvW]|--(field-separator|assign))$/.test(w)) i++;
    else if (!w.startsWith("-")) program = w;
  }
  return (
    program !== undefined &&
    /\bsystem\s*\(|\|\s*&?\s*getline|\bprintf?\b[^;{}\n]*[>|]|@(load|include)\b/.test(program)
  );
}

/** sed writing a file (`-i`, `--in-place`, a `w` command or flag) or running one (`e`). */
function sedWrites(words: string[]): boolean {
  const scripts: string[] = [];
  let first: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === "--") {
      first ??= words[i + 1];
      break;
    }
    if (w.startsWith("--")) {
      const [name, value] = w.split(/=(.*)/s);
      if (name === "--in-place" || name === "--file") return true;
      if (name === "--expression") scripts.push(value ?? words[++i] ?? "");
      else if (name === "--line-length" && value === undefined) i++;
    } else if (/^-./.test(w)) {
      // a cluster: `-i` (any suffix: `-ie` keeps a backup `…e`), `-f` (script from a file) end it
      for (let k = 1; k < w.length; k++) {
        const c = w[k]!;
        if (c === "i" || c === "f") return true;
        if (c === "e" || c === "l") {
          const value = w.slice(k + 1) || words[++i] || "";
          if (c === "e") scripts.push(value);
          break;
        }
      }
    } else if (first === undefined) first = w;
  }
  if (!scripts.length && first !== undefined) scripts.push(first);
  return scripts.some(sedScriptWrites);
}

/** Does a sed script write a file (`w`, `W`, `s///w`) or run a command (`e`, `s///e`)? */
function sedScriptWrites(script: string): boolean {
  if (script.length > 2048) return true; // not a script anyone reads a file with
  let flagged = false;
  // `s` and `y` bodies are data: only an `s` command's flags can write or run something
  const t = script
    .replace(
      /(^|[^a-zA-Z\\])([sy])([^\\\n\sa-zA-Z0-9])((?:\\[\s\S]|(?!\3)[^\\])*)\3((?:\\[\s\S]|(?!\3)[^\\])*)\3([a-zA-Z0-9]*)/g,
      (_m, pre: string, cmd: string, _d, _a, _b, flags: string) => {
        if (cmd === "s" && /[we]/.test(flags)) flagged = true;
        return `${pre};`;
      },
    )
    // `/regex/` addresses are data too
    .replace(/\/(?:\\[\s\S]|[^/\\\n])*\//g, ";");
  return flagged || /(?:^|[^a-zA-Z_.-])(?:[wW]|e(?![a-zA-Z]))/.test(t);
}

/**
 * Readers that write a file or run a program when given a certain flag, by tool: the words after
 * the tool's name, quotes removed (`rg '--pre' rm` is `rg --pre rm`).
 */
const FLAG_WRITES = new Map<string, (words: string[]) => boolean>([
  // `--pre cmd` runs cmd on every file searched
  ["rg", (w) => w.some((x) => /^--pre(-glob)?(=|$)/.test(x))],
  ["git", gitRunsOrWrites],
  ["find", (w) => w.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(x))],
  ["tree", (w) => w.some((x) => /^(-[a-zA-Z]*o|--output)/.test(x))],
  ["sed", sedWrites],
  ["gsed", sedWrites],
  ["awk", awkRuns],
  ["gawk", awkRuns],
  ["mawk", awkRuns],
  ["nawk", awkRuns],
  ["sort", (w) => w.some((x) => /^(-[a-zA-Z]*o|--output(=|$))/.test(x))],
  // `uniq IN OUT` and `xxd IN OUT` write OUT
  ["uniq", (w) => operands(w, /^(-[fsw]|--(skip-fields|skip-chars|check-chars))$/) > 1],
  ["xxd", (w) => operands(w, /^-(c|g|l|o|s|n|cols|groupsize|len|offset|seek|name)$/) > 1],
  ["yq", (w) => w.some((x) => /^(-[a-zA-Z]*i[a-zA-Z]*|--inplace)(=|$)/.test(x))],
]);

/**
 * `git`: options that run a program or set config (`-c diff.external=…`, `--exec-path=`), an
 * external diff or tool, an output file (`--output`), or `git grep -O` (opens a pager command).
 */
function gitRunsOrWrites(words: string[]): boolean {
  let i = 0;
  for (; i < words.length && words[i]!.startsWith("-"); i++) {
    const w = words[i]!;
    if (/^(-c|--config-env|--exec-path=)/.test(w)) return true;
    if (/^(-C|--git-dir|--work-tree|--namespace|--super-prefix)$/.test(w)) i++;
  }
  const sub = words[i];
  const rest = words.slice(i + 1);
  if (sub === "difftool" || sub === "mergetool") return true;
  if (rest.some((w) => /^--(output|ext-diff)(=|$)/.test(w))) return true;
  return sub === "grep" && rest.some((w) => /^(-[a-zA-Z]*O|--open-files-in-pager)/.test(w));
}

/** Environment that makes git run a program or read other config: `GIT_EXTERNAL_DIFF=rm git diff`. */
const GIT_ENV =
  /(?:^|\s)GIT_(?:EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR|SSH|SSH_COMMAND|ASKPASS|PROXY_COMMAND|EXEC_PATH|CONFIG\w*|TRACE\w*|DIFF_OPTS|TEMPLATE_DIR)=/;

/** `$((…))` without a nested `(` or backtick: arithmetic, no command in it. */
const ARITHMETIC = /\$\(\(([^()`]*)\)\)/g;

/**
 * The commands inside `$(…)`, backticks and process substitutions `<(…)` / `>(…)`, innermost
 * first; undefined when they nest deeper than MAX_STEPS or hold parentheses that cannot be paired
 * (`$( (touch x) )`), whose commands are then unknown.
 */
function substitutions(segment: string): string[] | undefined {
  const found: string[] = [];
  const inner = /[$<>]\(([^()]*)\)|`([^`]*)`/g;
  let s = segment.replace(ARITHMETIC, "_");
  for (let level = 0; ; level++) {
    const next = s.replace(inner, (_, a: string | undefined, b: string | undefined) => {
      found.push(a ?? b ?? "");
      return "_";
    });
    if (next === s) break;
    if (level >= MAX_STEPS) return undefined;
    s = next;
  }
  return /[$<>]\(/.test(s) ? undefined : found;
}

/**
 * Must this segment run natively? It changes something (in any pipe stage), or it never
 * finishes. Each stage is judged by the command a runner prefix
 * starts, by its name without a path or quotes (`sudo /usr/bin/kubectl delete …` is
 * `kubectl delete …`, `r''m` is `rm`).
 */
function staysNative(segment: string, cwd: string): boolean {
  // A `>` inside quotes counts when it stands apart (`awk '{print > "out"}'`, `ssh h "echo x > f"`);
  // glued to a word it is data there (`rg 'Promise<string>'`, `jq 'select(.n>3)'`) and a
  // redirection outside quotes (`npm test>out.log`).
  if (WRITES_FILE.test(segment)) return true;
  if (GLUED_WRITE.test(segment.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''"))) return true;
  return pipeStages(segment).some((stage, i) => {
    const plain = stage.replace(SHELL_WORDS, "");
    if (plain.includes("GIT_") && GIT_ENV.test(plain)) return true;
    const cmd = stripRunners(plain).replace(/^\S*\//, "");
    const [, quoted = "", args = ""] = /^(\S+)([\s\S]*)$/.exec(cmd) ?? [];
    const tool = quoted.replace(/['"\\]/g, "");
    const named = tool + args;
    // `npm --prefix api install`, `npm -g install`: judge the subcommand, not the options.
    const bare = /^(npm|pnpm|yarn)$/.test(tool)
      ? `${tool} ${afterOptions(tool, args).join(" ")}`
      : named;
    return (
      MUTATING.test(named) ||
      MUTATING.test(bare) ||
      ((/^(?:kubectl|docker|tail)(?![^\s])/.test(named) || named.includes("--watch")) &&
        FOLLOWS.test(named)) ||
      (i > 0 && RUNS_STDIN.test(named)) ||
      CHANGES.get(tool)?.(args, cwd) === true ||
      FLAG_WRITES.get(tool)?.(shellWords(args)) === true
    );
  });
}

/** Commands that only read (or navigate), by name; the other tools are judged by `readsOnly`. */
const READ_ONLY =
  /^(?:(?:cd|pushd|popd|pwd|true|false|:|test|\[|sleep|echo|printf|ls|tree|cat|head|tail|wc|grep|egrep|fgrep|rg|sort|uniq|cut|tr|nl|column|awk|sed|jq|yq|diff|cmp|du|df|stat|file|which|type|date|basename|dirname|realpath|readlink|ps|lsof|strings|xxd|od|find)|git\s+(?:(?:-[Cc]\s*[^-\s]\S*|--no-pager)\s+)*(?:diff|log|show|status|ls-files|ls-tree|grep|blame|branch(?=\s*$|\s+(?:-[avr]+|--(?:list|show-current|merged|no-merged|contains))(?:\s|$))|rev-list|rev-parse|for-each-ref|cat-file|describe|shortlog|reflog|merge-base|name-rev|config\s+(?:--(?:global|local|system|worktree)\s+)*(?:--get\S*|--list|-l)))(?![\w-])/;
/** Read-only forms of the tools judged by CHANGES (which only rules out the known writes). */
const TOOL_READS: Record<string, (args: string) => boolean> = {
  gh: (a) =>
    /^\s+(?:api|(?:pr|issue|run|search|repo|release)\s+(?:list|view|diff|checks|status))\b/.test(a),
  npm: (a) =>
    /^(?:test|t|run|run-script|ls|ll|list|outdated|view|show|info|why|explain|audit|root|bin|prefix|help)$/.test(
      afterOptions("npm", a)[0] ?? "",
    ),
  pnpm: (a) => afterOptions("pnpm", a).length > 0,
  yarn: (a) => afterOptions("yarn", a).length > 0, // bare `yarn` installs
};

/** Is this simple command (every pipe stage of it) known to only read? Unknown means no. */
function readsOnly(segment: string, cwd: string): boolean {
  return pipeStages(segment).every((stage) => {
    const cmd = stripRunners(stage.replace(SHELL_WORDS, "")).replace(/^\S*\//, "");
    const [, tool = "", args = ""] = /^(\S+)([\s\S]*)$/.exec(cmd) ?? [];
    // Flags that make a reader write: `git diff --output=f`, `sort -o f`.
    if (/(?:^|\s)--output(?=[\s=]|$)/.test(args) || (tool === "sort" && /\s-\w*o\b/.test(args)))
      return false;
    if (CHANGES.has(tool)) return TOOL_READS[tool]?.(args) ?? !CHANGES.get(tool)!(args, cwd);
    return READ_ONLY.test(cmd);
  });
}

/** Output size Read tolerates natively; a `cat` of that much is the same read through Bash. */
const READ_LIMIT = 200 * 1024;
const BIG_TEXT_LIMIT = 20 * 1024;

/** Flags of grep / rg that take the next token as their value. */
const GREP_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "-d",
  "-g",
  "-t",
  "-T",
  "--regexp",
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--include",
  "--exclude",
  "--glob",
  "--type",
]);

/**
 * The files a `cat` / `grep` / `rg` stage reads, or undefined when a glob, variable,
 * directory or missing operand makes them unknowable (`grep -r x src`, `cat *.log`).
 */
function fileOperands(stage: string, cwd: string): string[] | undefined {
  const tokens = stage.trim().split(/\s+/);
  const cmd = tokens[0]!;
  const isGrep = /^(grep|egrep|fgrep|rg)$/.test(cmd);
  const files: string[] = [];
  let patternGiven = !isGrep;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") {
      files.push(...tokens.slice(i + 1));
      break;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (/^-[ef]$|^--(regexp|file)$/.test(t)) patternGiven = true;
      if (GREP_VALUE_FLAGS.has(t)) i++;
      continue;
    }
    if (!patternGiven) {
      patternGiven = true;
      continue;
    }
    files.push(t);
  }
  // More files than anyone names by hand: not worth a stat each.
  if (!files.length || files.length > MAX_OPERANDS) return undefined;
  const out: string[] = [];
  for (let f of files) {
    if (/[*?[\]{}$`\\]/.test(f)) return undefined;
    f = f.replace(/^['"]|['"]$/g, "");
    if (f.startsWith("~/")) f = join(homedir(), f.slice(2));
    out.push(resolve(cwd, f));
  }
  return out;
}

/**
 * Bytes a `cat` / `grep` stage can print at most (the files it reads), or undefined when
 * that is unknowable. A missing file costs nothing: one error line.
 */
function stageBytes(stage: string, cwd: string): number | undefined {
  const files = fileOperands(stage, cwd);
  if (!files) return undefined;
  let total = 0;
  for (const f of files) {
    try {
      const st = statSync(f);
      if (st.isDirectory()) return undefined;
      if (BIG_TEXT_EXT.has(extname(f).toLowerCase()) && st.size > BIG_TEXT_LIMIT)
        return READ_LIMIT + st.size;
      total += st.size;
    } catch {
      // missing: an error line
    }
  }
  return total;
}

/** A `sed -n 'A,Bp'` range: at most B-A+1 lines. */
function sedRangeLines(stage: string): number | undefined {
  const m = /^\s*sed\s+(?:-\S+\s+)*-n\s+['"]?(\d+),(\d+)p['"]?/.exec(stage);
  return m ? Number(m[2]) - Number(m[1]) + 1 : undefined;
}

interface Heavy {
  rule: string;
  text: string;
}

/**
 * Is the first stage of a pipeline bounded on its own: a short head / tail / sed range,
 * a `du -s`, a `grep -l` / `-c`, or a cat / grep over named files small enough for Read?
 * Later stages only narrow it. Returns a Heavy when it is known to be big instead.
 */
function firstStageBound(first: string, cwd: string): true | Heavy | undefined {
  if (/^\s*(head|tail)\s/.test(first)) return bounds(first) || undefined;
  const sed = sedRangeLines(first);
  if (sed !== undefined) return sed <= BOUNDED_LINES || undefined;
  if (/^\s*du\s+-[a-zA-Z]*s/.test(first)) return true;
  if (/^\s*git\s+log\b/.test(first) && ONE_COMMIT.test(first)) return true;
  if (
    /^\s*(grep|egrep|fgrep|rg)\s/.test(first) &&
    /(^|\s)-[a-zA-Z]*[lLcq][a-zA-Z]*(?=\s|$)|--(files-with-matches|files-without-match|count|quiet)\b/.test(
      first,
    )
  )
    return true;
  if (/^\s*(cat|grep|egrep|fgrep|rg)\s/.test(first)) {
    const bytes = stageBytes(first, cwd);
    if (bytes === undefined) return undefined;
    if (bytes <= READ_LIMIT) return true; // what Read would show anyway
    return {
      rule: "big-read",
      text: `reads about ${Math.round(bytes / 1024)} KB`,
    };
  }
  return undefined;
}

/**
 * Read-only commands whose output can be long: a filter after them still reads all of it. Not
 * `env`: em_execute runs with an allowlisted environment, so it would answer about a different one.
 */
const READ_SOURCE =
  /^\s*(ls|cat|sed|awk|cut|sort|uniq|tr|nl|echo|printf|ps|lsof|jq|yq|diff|strings|xxd|od|git\s+(diff|ls-files|ls-tree|grep|status|show|log|blame|branch|rev-list|for-each-ref|cat-file)|gh\s+(api|pr\s+(list|view|diff|checks)|issue\s+(list|view)|run\s+(list|view)|search))\b/;
/** Stages that only filter what they are given; the pipe rule needs one that does not bound it. */
const FILTERS =
  /^\s*(grep|egrep|fgrep|rg|sort|uniq|jq|head|tail|wc|cut|tr|column|less|awk|sed|python3?\s+-m\s+json\.tool)\b/;
const UNBOUNDED_FILTERS = /^\s*(grep|rg|sort|uniq|jq|less)\b/;

/** Why one simple command would print a lot, or undefined when its output is bounded. */
function heavySegment(segment: string, cwd: string): Heavy | undefined {
  if (TINY_BASH.test(segment)) return undefined;
  const stages = pipeStages(segment);
  const first = stages[0];
  if (!first) return undefined;
  // `… | head -40` caps whatever came before it.
  if (stages.length > 1 && bounds(stages[stages.length - 1]!)) return undefined;
  // A later stage that does something with the output (`| patch -p1`, `| psql db`) may change
  // something: only a pipe through known filters is routed.
  const rest = stages.slice(1);
  if (!rest.every((s) => FILTERS.test(s))) return undefined;
  const bound = firstStageBound(first, cwd);
  if (bound === true) return undefined;
  if (bound) return bound;
  if (HEAVY_BASH.test(first)) return { rule: "heavy", text: "usually prints a lot" };
  // Only a source known to just read: an unknown one (`ssh`, `psql`, `aws`) may change something.
  if (READ_SOURCE.test(first) && rest.some((s) => UNBOUNDED_FILTERS.test(s)))
    return {
      rule: "pipe",
      text: "streams an unbounded output through a filter",
    };
  return undefined;
}

/** A short label for a command segment in a reason or a log line. */
function headOf(segment: string, n = 60): string {
  const one = segment.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Routing for a Bash command, one simple command at a time: a command that changes
 * something stays native; a history read goes to em_history; a segment that prints a lot
 * (and is not capped by `| head`, and is not a cat of what Read would show anyway) goes to
 * em_execute.
 */
function bashSuggestion(raw: string, root: string, cwd: string): Suggestion | undefined {
  if (raw.length > MAX_RAW) return undefined;
  const cmd = withoutHeredocs(raw);
  if (!cmd.trim()) return undefined;
  // Nobody types a read this long; judging it would cost the hook more than routing saves.
  if (cmd.length > MAX_CLASSIFIED) return undefined;
  const segments = commandSegments(cmd);
  if (segments.length > MAX_SEGMENTS) return undefined; // a script, not a read: each may stat files
  // `$(…)` and backticks run too: their commands are judged like the line's own, and ones we
  // cannot unwrap (`$( (cmd) )`, nested past MAX_STEPS) are unknown, so the line stays native.
  const subs = substitutions(cmd);
  if (!subs) return undefined;
  if ([...segments, ...subs.flatMap(commandSegments)].some((s) => staysNative(s, cwd)))
    return undefined;
  // A line of several commands is routed only when every one of them is known to just read:
  // anything else in it would run in the sandbox without Claude Code's Bash permission prompt.
  if (segments.length > 1 && !segments.every((s) => readsOnly(s, cwd))) return undefined;
  // git history reads have a classified answer: fixes traced to their origin, risk per
  // file, branches vs base — em_history, not a raw log through em_execute. em_history reads
  // the root's repository only, so a read of another one (or of none) is judged like any command.
  const history = historyCall(cmd);
  const dir = history && historyDir(segments, cwd);
  // A git read in another repository is not em_history's (nor em_execute's, which runs in the root).
  if (history && dir && !sameRepo(root, dir)) return undefined;
  if (history && dir && inRootRepo(root, dir)) {
    return {
      tool: "em_history",
      rule: "history",
      reason: `the git history is already classified (commit kinds, fixes traced to the change that caused them, risk per file); em_history ${history} answers this without the raw log`,
    };
  }
  // Relative paths resolve where the shell is by then: `cd logs && cat app.log` reads logs/app.log.
  let at: string | undefined = cwd;
  let steps = 0;
  for (const segment of segments) {
    const heavy = heavySegment(segment, at ?? cwd);
    if (heavy)
      return {
        tool: "em_execute",
        rule: heavy.rule,
        reason: `\`${headOf(segment)}\` ${heavy.text}; em_execute {language:"shell", code, intent} keeps the output out of context and returns only matching sections`,
      };
    const cd = CD.exec(segment);
    if (cd) at = ++steps > MAX_STEPS ? undefined : at && changeDir(at, cd[1]!);
  }
  return undefined;
}

/** Would em_execute_file accept this path? It is given the root as a real path, like the server. */
function executeFileTakes(root: string, fp: string): boolean {
  try {
    const real = realpathSync(root);
    confinePath(real, resolve(root, fp), loadPermissionRules(real));
    return true;
  } catch {
    return false;
  }
}

/** Decide whether a native tool call is better served by an em_* tool. */
export function suggest(
  toolName: string,
  input: Record<string, unknown>,
  root: string,
  extra: SuggestExtra = {},
): Suggestion | undefined {
  switch (toolName) {
    case "Bash":
      return bashSuggestion(String(input.command ?? ""), root, extra.cwd ?? root);
    case "Read": {
      const fp = String(input.file_path ?? "");
      if (!fp) return undefined;
      // An offset or limit is a window the model already chose: bounded, like `sed -n 'A,Bp'`.
      if (input.offset != null || input.limit != null) return undefined;
      const ext = extname(fp).toLowerCase();
      if (VISUAL_EXT.has(ext)) return undefined;
      try {
        const st = statSync(resolve(root, fp));
        if (st.size > 200 * 1024 || (BIG_TEXT_EXT.has(ext) && st.size > 20 * 1024)) {
          // em_execute_file refuses a file outside the root (Claude Code's own saved tool
          // outputs among them) and what a Read deny or ask rule matches; leave the native Read
          // to Claude Code's own permission check instead of redirecting to a dead end.
          if (!executeFileTakes(root, fp)) return undefined;
          return {
            tool: "em_execute_file",
            rule: "big-read",
            reason: `${fp} is ${Math.round(st.size / 1024)} KB; em_execute_file {path, code} processes it in the sandbox so only what you print enters context`,
          };
        }
      } catch {
        // missing file: let Read report it
      }
      return undefined;
    }
    case "Grep": {
      const content = input.output_mode === "content" && !input.head_limit;
      if (extra.symbol) {
        // The graph already knows this identifier: symbol-level answers beat raw matches.
        // A files-only grep is cheap, so that one is annotated rather than denied.
        return {
          tool: "em_symbols",
          rule: "symbol",
          annotateOnly: !content,
          reason: `the graph indexes "${extra.symbol}": em_symbols {name_path:"${extra.symbol}", mode:"references"} lists its uses, {include_body:true} its definition; em_search {queries:["${extra.symbol}"], source:"code"} finds the code by symbol`,
        };
      }
      if (content) {
        return {
          tool: "em_execute",
          rule: "content-grep",
          reason: `content-mode grep can be large; em_execute with rg and an intent returns only matching sections (em_search {queries, mode:"regex"} scans the indexed files with context)`,
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
        prefixPrompt: subagentPrefix(true),
      };
    default:
      return undefined;
  }
}

/** The prompt prefix for a subagent; without `shell` it leaves out the command runners. */
function subagentPrefix(shell: boolean): string {
  const runners = shell ? "em_execute, em_batch_execute, em_execute_file, " : "";
  return `Use the eminiar tools (${runners}em_fetch_and_index, em_search, em_symbols, em_history) instead of ${shell ? "Bash/" : ""}Read/Grep/WebFetch whenever output may be large; return only derived answers. Check em_recall {query} for project decisions and constraints before proposing changes, em_history {action:"file", path} before editing a file, em_symbols / em_search {source:"code"} before grepping for an identifier, and em_docs {action:"lookup", query} before WebFetch/WebSearch for anything the project depends on.\n\n`;
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
 * Before a file is read or edited: the memories about it (linked, naming its path or one
 * of its symbols) and its fix history; before an edit, also its fan-in. Each once per
 * context window, again after `recall.repeatAfter` prompts.
 */
function fileKnowledge(ctx: ProjectContext, input: HookInput): string | undefined {
  if (!ctx.config.recall.onFile || !FILE_TOOLS.has(input.tool_name ?? "")) return undefined;
  try {
    const rel = projectRel(ctx, String(input.tool_input?.file_path ?? ""));
    if (!rel) return undefined;
    const db = getStorage(ctx, { vectors: false });
    const sessionId = input.session_id || undefined;
    const repeatAfter = ctx.config.recall.repeatAfter;
    const edit = EDIT_TOOLS.has(input.tool_name ?? "");
    const results = [
      memoriesForFile(db, rel, {
        sessionId,
        symbols: fileSymbols(db, rel),
        repeatAfter,
      }),
      fileContext(db, rel, { sessionId, edit, repeatAfter }),
    ];
    const shown = results.filter((r) => r.text);
    if (!shown.length) return undefined;
    if (sessionId)
      recordShown(
        db,
        sessionId,
        shown.flatMap((r) => r.keys),
        { path: "file" },
      );
    return shown.map((r) => r.text).join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Files a `git commit` command will include: the index, plus tracked changes with -a. git runs
 * where the command does (the hook cwd, which follows a `cd` into a nested repository) and names
 * files from that repository's top level; each is re-keyed onto the session root, which the
 * database's paths are relative to, whether the root lies above the repository or inside it.
 */
function commitFiles(root: string, cwd: string, cmd: string): string[] {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true }).trim();
  if (!top) return [];
  // -z: names unquoted, so non-ASCII paths match the database's.
  const list = (args: string[]) =>
    git(cwd, [...args, "-z"], { allowFail: true })
      .split("\0")
      .filter(Boolean);
  const files = new Set(list(["diff", "--cached", "--name-only"]));
  if (/\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(cmd))
    for (const f of list(["diff", "--name-only"])) files.add(f);
  return [...files].map((f) => relative(root, join(top, f)));
}

/** Before `git commit`: the bug-prone and widely imported files it includes. */
function commitKnowledge(ctx: ProjectContext, input: HookInput): string | undefined {
  if (!ctx.config.recall.onCommit || input.tool_name !== "Bash") return undefined;
  const cmd = withoutHeredocs(String(input.tool_input?.command ?? ""));
  if (!/(^|[;&|]\s*)git\s+commit\b/.test(cmd)) return undefined;
  try {
    const db = getStorage(ctx, { vectors: false });
    return commitContext(db, commitFiles(ctx.root, input.cwd || ctx.root, cmd)) || undefined;
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
    const r = await recallForText(db, text, {
      maxMemories: 0,
      maxDocs: 3,
      path: "web",
    });
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
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: extra,
      },
    };
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
  // em_swarm is eminiar's own tool: stamp (or strip) its caller, never route or annotate it.
  if (isSwarmTool(input.tool_name)) return swarmStampCaller(input);
  const ctx = sessionContext(input.cwd);
  // A swarm worker starting a tool is alive: keep its capacity slot and its task.
  if (input.agent_id) swarmTouch(ctx, input);
  // Swarm capacity holds in every routing mode, and a denial wins over everything else.
  const spawn = swarmPreAgent(ctx, input);
  if (spawn?.kind === "deny") return spawn.output;
  // A swarm worker is briefed at SubagentStart; a prompt brief as well would say it twice.
  const out = await route(ctx, input as RoutedInput, spawn?.kind === "worker");
  // The adjudicator (off by default) is loaded only when enabled, so off costs this one check.
  // It extends routing's output (the Agent model joins routing's one updatedInput); never denies.
  if (!ctx.config.adjudicator.enabled || input.client === "cursor") return out;
  try {
    const { afterRouting } = await import("../adjudicator/hooks.js");
    return await afterRouting(ctx, input, spawn, out);
  } catch {
    return out;
  }
};

type RoutedInput = HookInput & {
  tool_name: string;
  tool_input: Record<string, unknown>;
};

/** Routing proper: knowledge hints, then the routing mode's decision for this call. */
async function route(
  ctx: ProjectContext,
  input: RoutedInput,
  swarmWorker: boolean,
): Promise<HookOutput | undefined> {
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

  const graph = graphContext(ctx, input);
  const hint = joinHints(graph, memo);
  // graphContext names matching symbols only when the graph has them: that is the signal
  // to route a Grep for the identifier to em_symbols / em_search instead of rg.
  const symbol =
    input.tool_name === "Grep" && graph
      ? literalOf(String(input.tool_input.pattern ?? ""))
      : undefined;
  const s = suggest(input.tool_name, input.tool_input, ctx.root, {
    symbol,
    cwd: input.cwd,
  });
  const record = routingRecorder(ctx, input, s);
  if (!s) {
    record("allow");
    return withContext(undefined, hint);
  }
  if (s.annotateOnly) {
    record("annotate", "annotate-only");
    return withContext(annotate(s), hint);
  }

  if (mode === "enforce") {
    if (s.prefixPrompt) {
      // A swarm worker without Bash has no em_execute*: do not point it at them.
      const prefix =
        swarmWorker && workerLacksTool(input, spawnType(input), "em_execute")
          ? subagentPrefix(false)
          : s.prefixPrompt;
      const prompt = String(input.tool_input.prompt ?? "");
      if (prompt.startsWith(prefix)) return undefined;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            ...input.tool_input,
            prompt: prefix + (swarmWorker ? "" : await briefFor(ctx, prompt)) + prompt,
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
      record("annotate", "no-server");
      return withContext(
        annotate(
          s,
          " eminiar MCP server is not running, so this call is allowed; /em-doctor explains.",
        ),
        hint,
      );
    }
    // Nor if the caller cannot call it: a swarm worker without Bash has no em_execute*, so
    // the native call is its only way and the suggestion would be noise.
    if (input.agent_id && workerLacksTool(input, input.agent_type, s.tool)) {
      record("allow", "no-shell");
      return withContext(undefined, hint);
    }
    record("deny");
    hookLog("info", `deny ${input.tool_name} → ${s.tool} [${s.rule ?? "?"}]: ${callHead(input)}`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `eminiar: ${s.reason}. Retry with ${s.tool}.${hint ? ` ${hint}` : ""}`,
      },
    };
  }
  // Annotate mode: subagents get the project brief as context since their prompt is untouched.
  record("annotate", "mode");
  const extra =
    s.prefixPrompt && !swarmWorker
      ? joinHints((await briefFor(ctx, String(input.tool_input.prompt ?? ""))).trim(), hint)
      : hint;
  return withContext(annotate(s), extra);
}

/** Native tools routing may redirect; their every call is counted, denied or not. */
const ROUTED_TOOLS = new Set(["Bash", "Read", "Grep", "WebFetch", "WebSearch"]);

/** The command, path, pattern or URL of a native call, shortened for a log line. */
function callHead(input: HookInput): string {
  const t = input.tool_input ?? {};
  const v = t.command ?? t.file_path ?? t.pattern ?? t.url ?? t.query ?? "";
  return headOf(String(v), 120);
}

/**
 * A recorder for this call's routing decision: one `routing` event per native call, so
 * em_stats can show how often Bash / Read / Grep are intercepted and by which rule. Never
 * throws; a call that cannot be recorded is still routed.
 */
function routingRecorder(
  ctx: ProjectContext,
  input: HookInput,
  s: Suggestion | undefined,
): (decision: RoutingEvent["decision"], why?: string) => void {
  const tool = input.tool_name ?? "";
  const sessionId = input.session_id;
  if (!sessionId || !ROUTED_TOOLS.has(tool)) return () => {};
  return (decision, why) => {
    try {
      recordRouting(getStorage(ctx, { vectors: false }), sessionId, {
        tool,
        decision,
        target: s?.tool,
        rule: s?.rule,
        why,
        head: callHead(input),
      });
    } catch {
      // statistics are optional
    }
  };
}

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
        path: "agent",
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
