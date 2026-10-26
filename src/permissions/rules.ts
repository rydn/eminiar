export interface Rule {
  raw: string;
  tool: string;
  /** undefined = the whole tool (e.g. "Bash"). */
  pattern?: string | undefined;
}

export interface PermissionRules {
  allow: Rule[];
  deny: Rule[];
  ask: Rule[];
}

/** Parse a Claude Code permission rule like `Bash(git log:*)` or `Read(~/.ssh/**)`. */
export function parseRule(raw: string): Rule | undefined {
  const m = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s.exec(raw.trim());
  if (!m) return undefined;
  return { raw, tool: m[1]!, pattern: m[2] };
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bash patterns: `cmd:*` and the legacy `cmd *` are prefix rules (the command must
 * start with `cmd` at a word boundary); other `*` are wildcards; no `*` is exact.
 */
function compileBash(pattern: string): RegExp {
  if (pattern.endsWith(":*")) {
    return new RegExp(`^\\s*${escapeRe(pattern.slice(0, -2))}(\\s|$)`);
  }
  if (pattern.endsWith(" *")) {
    return new RegExp(`^\\s*${escapeRe(pattern.slice(0, -2))}(\\s|$)`);
  }
  if (!pattern.includes("*")) {
    return new RegExp(`^\\s*${escapeRe(pattern)}\\s*$`);
  }
  return new RegExp(`^\\s*${pattern.split("*").map(escapeRe).join(".*")}\\s*$`);
}

// Rule sets are small and stable; compiling each pattern once instead of per
// (rule × command segment) keeps the permission check off the sandbox hot path.
const bashRegexCache = new Map<string, RegExp>();
function bashRegex(pattern: string): RegExp {
  let re = bashRegexCache.get(pattern);
  if (!re) {
    if (bashRegexCache.size >= 1024) bashRegexCache.clear();
    re = compileBash(pattern);
    bashRegexCache.set(pattern, re);
  }
  return re;
}

export function matchBash(rule: Rule, command: string): boolean {
  if (rule.tool !== "Bash") return false;
  if (rule.pattern === undefined) return true;
  return bashRegex(rule.pattern).test(command);
}

// em_execute_file and routing check every Read deny/ask rule against several paths per call,
// so Read globs are compiled once, like the Bash ones. Keyed by the expanded pattern, so a
// changed $HOME compiles afresh.
const readRegexCache = new Map<string, RegExp>();
function readRegex(pattern: string): RegExp {
  let re = readRegexCache.get(pattern);
  if (!re) {
    if (readRegexCache.size >= 1024) readRegexCache.clear();
    re = new RegExp(
      `^${pattern
        .split("**")
        .map((seg) => seg.split("*").map(escapeRe).join("[^/]*"))
        .join(".*")}$`,
    );
    readRegexCache.set(pattern, re);
  }
  return re;
}

/** Read(path) rules: glob with `**` and `*`; `~` expands to $HOME. */
export function matchRead(rule: Rule, absPath: string): boolean {
  if (rule.tool !== "Read") return false;
  if (rule.pattern === undefined) return true;
  let p = rule.pattern;
  if (p.startsWith("~")) p = (process.env.HOME ?? "") + p.slice(1);
  return readRegex(p).test(absPath);
}
