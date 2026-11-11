import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionRules } from "../permissions/rules.js";
import { readMatcher } from "../permissions/rules.js";
import { checkRead, checkReadPath, type ReadCheck } from "../permissions/settings.js";

/**
 * `em_execute_file` may only touch files under the project root, unless a Claude
 * Code `Read(<path>)` allow rule opts a path in. A matching `Read` deny or ask rule
 * refuses the path, inside the root or out. Returns the real absolute path.
 *
 * This guards the `path` argument only: the code the tool runs is checked against Bash
 * rules, like `em_execute`, and can still open other files.
 */
export function confinePath(root: string, target: string, given: PermissionRules): string {
  const abs = resolve(root, target);
  // Relative Read patterns (`./.env`, `.env`, `/secrets/**`) resolve against this root.
  const rules = given.root ? given : { ...given, root };
  // The path as written, before any stat, so that spelling of a denied name is refused
  // whether or not the file exists.
  refuse(checkRead(rules, [abs]), target);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`file not found: ${target}`);
  }
  // Then its resolved forms, so a symlink or a change of letter case cannot route around it.
  refuse(checkReadPath(rules, abs), target);
  const rel = relative(root, real);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside) return real;
  if (readMatcher(rules.allow, rules.root).test(real)) return real;
  // `//` marks an absolute path in a Claude Code Read rule; a single `/` is project-relative.
  throw new Error(
    `${target} is outside the project root; add a Read(/${real}) rule to permissions.allow to opt it in`,
  );
}

/**
 * Why `abs` must not be read, or undefined: the Read deny and ask rules checked as confinePath
 * checks them (the path as written, then, when it exists, its resolved forms) and worded as its
 * refusal. For readers that keep their own root rules: em_index and the dashboard file viewer.
 */
export function readRefusal(
  rules: PermissionRules,
  abs: string,
  target: string,
): string | undefined {
  let check = checkRead(rules, [abs]);
  try {
    if (check.allowed && existsSync(abs)) check = checkReadPath(rules, abs);
  } catch {
    // removed after the existence check: the reader reports it as missing
  }
  return check.allowed ? undefined : refusal(check, target);
}

function refusal(check: ReadCheck, target: string): string {
  return `refused by permission rule ${check.rule} (${check.kind}) on path: ${target}`;
}

function refuse(check: ReadCheck, target: string): void {
  if (!check.allowed) throw new Error(refusal(check, target));
}
