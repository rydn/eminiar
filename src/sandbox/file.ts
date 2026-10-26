import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionRules } from "../permissions/rules.js";
import { matchRead } from "../permissions/rules.js";
import { checkRead, checkReadPath, type ReadCheck } from "../permissions/settings.js";

/**
 * `em_execute_file` may only touch files under the project root, unless a Claude
 * Code `Read(<path>)` allow rule opts a path in. A matching `Read` deny or ask rule
 * refuses the path, inside the root or out. Returns the real absolute path.
 *
 * This guards the `path` argument only: the code the tool runs is checked against Bash
 * rules, like `em_execute`, and can still open other files.
 */
export function confinePath(root: string, target: string, rules: PermissionRules): string {
  const abs = resolve(root, target);
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
  if (rules.allow.some((r) => matchRead(r, real))) return real;
  throw new Error(
    `${target} is outside the project root; add a Read(${real}) rule to permissions.allow to opt it in`,
  );
}

function refuse(check: ReadCheck, target: string): void {
  if (!check.allowed)
    throw new Error(`refused by permission rule ${check.rule} (${check.kind}) on path: ${target}`);
}
