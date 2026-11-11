import { posix } from "node:path";

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
  /** The project root relative Read patterns (`./x`, `/x`, `x`) resolve against. */
  root?: string | undefined;
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

/**
 * A glob as a regex source, unanchored: `**` any depth (`/**\/` also no folder at all, so
 * `~/.aws/**\/credentials` covers `~/.aws/credentials`), `*` within one segment, `?` one
 * character. `[...]` stays literal.
 */
function globSource(glob: string): string {
  return glob
    .split("/**/")
    .map((part) =>
      part
        .split("**")
        .map((seg) =>
          seg
            .split("*")
            .map((s) => s.split("?").map(escapeRe).join("[^/]"))
            .join("[^/]*"),
        )
        .join(".*"),
    )
    .join("/(?:.*/)?");
}

/** `prefix` (a literal directory, no trailing slash) followed by the glob `rest` (starts with `/`). */
function anchored(prefix: string, rest: string): string {
  // `..` and `.` segments and doubled slashes, as Claude Code resolves the path.
  const full = posix.normalize(`${prefix}${rest}`);
  if (prefix && (full === prefix || full.startsWith(`${prefix}/`))) {
    return literal(prefix) + globSource(full.slice(prefix.length));
  }
  return globSource(full);
}

/** A literal path (a project root, the home folder) in a regex: `*` is not a wildcard there. */
function literal(s: string): string {
  return escapeRe(s).replace(/\*/g, "\\*");
}

/**
 * The regex source of a Read pattern, resolved the way Claude Code resolves it
 * (gitignore-style):
 *   `//x`  absolute path `/x`
 *   `~/x`  under the home folder
 *   `/x`   under the project root; also matched as the absolute path `/x`, which is how earlier
 *          versions read it, so an existing `Read(/Users/me/.ssh/**)` keeps working
 *   `./x`, `x/y`  under the project root
 *   `x`    (no slash) a name at any depth under the project root, e.g. `.env`, `*.pem`
 *   `**…`  anywhere, as before
 * A trailing `/` names a directory. Every form also matches what lies under a matched path, so
 * a denied folder denies its files, as in gitignore.
 */
function readSource(pattern: string, root: string, home: string): string {
  const dir = pattern.endsWith("/") && pattern.length > 1;
  const p = dir ? pattern.slice(0, -1) : pattern;
  let body: string;
  if (p.startsWith("**")) body = globSource(p);
  else if (p.startsWith("//")) body = anchored("", p.slice(1));
  else if (p === "~" || p.startsWith("~/")) body = anchored(home, p.slice(1));
  else if (p.startsWith("/")) body = `(?:${anchored(root, p)}|${globSource(posix.normalize(p))})`;
  else if (p.startsWith("./")) body = anchored(root, p.slice(1));
  else if (p.includes("/")) body = anchored(root, `/${p}`);
  else body = `${literal(root)}/(?:.*/)?${globSource(p)}`;
  return `^${body}(?:/.*)?$`;
}

// em_execute_file, routing and the indexers check every Read deny/ask rule against each path,
// so Read patterns are compiled once per (project root, home, pattern), like the Bash ones.
const readRegexCache = new Map<string, RegExp>();
function readRegex(pattern: string, root: string, home: string): RegExp {
  const key = `${root}\0${home}\0${pattern}`;
  let re = readRegexCache.get(key);
  if (!re) {
    if (readRegexCache.size >= 4096) readRegexCache.clear();
    re = new RegExp(readSource(pattern, root, home));
    readRegexCache.set(key, re);
  }
  return re;
}

/** The project root relative Read patterns resolve against when none is given. */
function defaultRoot(): string {
  return process.cwd();
}

/**
 * Read(path) rules, matched against an absolute path; relative patterns resolve against `root`
 * (the project root; default: the working directory). See readSource for the forms.
 */
export function matchRead(rule: Rule, absPath: string, root?: string): boolean {
  if (rule.tool !== "Read") return false;
  if (rule.pattern === undefined) return true;
  return readRegex(rule.pattern, root ?? defaultRoot(), process.env.HOME ?? "").test(absPath);
}

/**
 * A literal every path the pattern matches contains (the longest run without a wildcard after
 * the prefix is resolved), or "" when there is none worth testing. `path.includes(needle)` is
 * far cheaper than the regex, and almost every path fails it, so a long rule list costs a
 * substring scan per rule instead of a backtracking match per rule.
 */
function needleOf(pattern: string): string {
  const p = pattern.endsWith("/") && pattern.length > 1 ? pattern.slice(0, -1) : pattern;
  if (p.includes("..")) return ""; // normalisation may drop literal parts
  let tail: string;
  if (p.startsWith("**") || !p.includes("/")) tail = p;
  else if (p.startsWith("//")) tail = posix.normalize(p.slice(1));
  else if (p === "~" || p.startsWith("~/")) tail = posix.normalize(p.slice(1) || "/");
  else if (p.startsWith("./")) tail = posix.normalize(p.slice(1));
  else tail = posix.normalize(p.startsWith("/") ? p : `/${p}`);
  let best = "";
  for (const piece of tail.split(/[*?]/)) if (piece.length > best.length) best = piece;
  return best;
}

/** The Read rules of one list, compiled once: `which` names the first rule matching a path. */
export interface ReadMatcher {
  test(absPath: string): boolean;
  which(absPath: string): Rule | undefined;
}

const listCache = new WeakMap<Rule[], { key: string; matcher: ReadMatcher }>();

/**
 * A ReadMatcher for the Read rules in `rules`, cached per list and (root, home): the rule list
 * a settings file yields is compiled once, not per path checked. Patterns resolve as in
 * matchRead.
 */
export function readMatcher(rules: Rule[], root?: string): ReadMatcher {
  const r = root ?? defaultRoot();
  const home = process.env.HOME ?? "";
  const key = `${r}\0${home}\0${rules.length}`;
  const hit = listCache.get(rules);
  if (hit && hit.key === key) return hit.matcher;
  const compiled = rules
    .filter((x) => x.tool === "Read")
    .map((rule) =>
      rule.pattern === undefined
        ? { rule, needle: "", re: /^/ }
        : { rule, needle: needleOf(rule.pattern), re: readRegex(rule.pattern, r, home) },
    );
  const which = (p: string): Rule | undefined => {
    for (const c of compiled) {
      if (c.needle && !p.includes(c.needle)) continue;
      if (c.re.test(p)) return c.rule;
    }
    return undefined;
  };
  const matcher: ReadMatcher = { test: (p) => which(p) !== undefined, which };
  listCache.set(rules, { key, matcher });
  return matcher;
}
