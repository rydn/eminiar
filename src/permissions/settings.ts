import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "../paths.js";
import { matchBash, type PermissionRules, parseRule, type Rule, readMatcher } from "./rules.js";
import { splitCommand } from "./split.js";

interface SettingsFile {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
}

function readRules(file: string): Partial<Record<keyof PermissionRules, string[]>> {
  if (!existsSync(file)) return {};
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as SettingsFile;
    return s.permissions ?? {};
  } catch {
    return {};
  }
}

/** mtime of a settings file, or -1 when it does not exist (so appearing later is a change). */
function stamp(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

const cache = new Map<string, { stamps: number[]; rules: PermissionRules }>();

/**
 * Claude Code's permission rules, merged from user, project and local settings,
 * plus eminiar's own `permissions.extraDeny`. The sandbox honours these so
 * `em_execute` cannot be used to sidestep a `Bash(sudo *)` deny.
 *
 * Every shell execution calls this, so the parsed rules are cached per root and
 * revalidated with one stat() per file instead of a read + JSON.parse each time.
 */
export function loadPermissionRules(root: string, extraDeny: string[] = []): PermissionRules {
  const files = [
    join(claudeConfigDir(), "settings.json"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ];
  // The user file moves with CLAUDE_CONFIG_DIR, so it is part of the key.
  const key = [...files, ...extraDeny].join("\0");
  const stamps = files.map(stamp);
  const hit = cache.get(key);
  if (hit?.stamps.every((s, i) => s === stamps[i])) return hit.rules;

  const out: PermissionRules = { allow: [], deny: [], ask: [], root };
  const push = (list: Rule[], raws: string[] | undefined) => {
    for (const raw of raws ?? []) {
      const r = parseRule(raw);
      if (r) list.push(r);
    }
  };
  for (const f of files) {
    const p = readRules(f);
    push(out.allow, p.allow);
    push(out.deny, p.deny);
    push(out.ask, p.ask);
  }
  push(out.deny, extraDeny);
  if (cache.size >= 16) cache.clear();
  cache.set(key, { stamps, rules: out });
  return out;
}

export interface CommandCheck {
  allowed: boolean;
  segment?: string;
  rule?: string;
  kind?: "deny" | "ask";
}

/** Deny wins; `ask` is treated as deny because the sandbox has no way to prompt. */
export function checkCommand(rules: PermissionRules, command: string): CommandCheck {
  for (const segment of splitCommand(command)) {
    for (const r of rules.deny) {
      if (matchBash(r, segment)) return { allowed: false, segment, rule: r.raw, kind: "deny" };
    }
    for (const r of rules.ask) {
      if (matchBash(r, segment)) return { allowed: false, segment, rule: r.raw, kind: "ask" };
    }
  }
  return { allowed: true };
}

export type ReadCheck = Omit<CommandCheck, "segment">;

/**
 * Claude Code's `Read` rules for absolute paths; relative patterns resolve against
 * `rules.root` (see matchRead). Deny wins, over allow rules too; `ask` is treated as deny
 * because the sandbox has no way to prompt. Each list is compiled once into one regex, so a
 * path that no rule matches costs one test per list however many rules there are.
 */
export function checkRead(rules: PermissionRules, absPaths: string[]): ReadCheck {
  for (const kind of ["deny", "ask"] as const) {
    const m = readMatcher(rules[kind], rules.root);
    for (const p of absPaths) {
      const r = m.which(p);
      if (r) return { allowed: false, rule: r.raw, kind };
    }
  }
  return { allowed: true };
}

/**
 * `checkRead` for an existing file: the path as given, then, only when that passes and they
 * differ from it, its symlink target and its on-disk letter case. `realpathSync` keeps the
 * requested case, so on macOS `.ENV` would miss `Read(**\/.env)` without
 * `realpathSync.native`. Shared by em_execute_file, routing and the indexers, so routing never
 * redirects a Read that em_execute_file refuses. Throws when it does not exist.
 */
export function checkReadPath(rules: PermissionRules, abs: string): ReadCheck {
  const asWritten = checkRead(rules, [abs]);
  if (!asWritten.allowed) return asWritten;
  const real = realpathSync(abs);
  const native = realpathSync.native(abs);
  const more = [real, native].filter((p, i, a) => p !== abs && a.indexOf(p) === i);
  return more.length ? checkRead(rules, more) : asWritten;
}
