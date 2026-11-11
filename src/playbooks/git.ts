import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

/**
 * The two questions the playbook store and the skill export ask git: is this path ignored, and
 * which files under this folder does git track. One place for both so they are asked the same
 * way: execFile with fixed arguments and `--`, no GIT_* variables from the environment (they can
 * point git at another repository), core.fsmonitor off (a repo-local hook must not run), a
 * timeout, and the working directory set to the folder that holds the path, so a nested
 * repository or worktree (.claude/worktrees/wt) answers for its own files.
 */

export type IgnoreAnswer = "ignored" | "not-ignored" | "unknown";

const TIMEOUT_MS = 10_000;

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv;
}

/**
 * Where to ask about `abs`: the real path of the nearest existing folder above it, and `abs`
 * relative to that folder as written (nothing below an existing folder can be a link yet).
 */
function anchor(abs: string): { cwd: string; rel: string } | undefined {
  let d = dirname(abs);
  while (!lstatSync(d, { throwIfNoEntry: false })) {
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  try {
    return { cwd: realpathSync.native(d), rel: relative(d, abs) };
  } catch {
    return undefined; // a dangling link or a loop
  }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Does git ignore `path` (relative to `root`, or absolute)? Without `noIndex` a tracked file is
 * never ignored, which is what a writer needs to know. `unknown` covers no git, no repository, a
 * submodule, a timeout and any other error: callers treat anything but `ignored` as "not safe".
 */
export function gitIgnoredFor(
  root: string,
  path: string,
  opts: { noIndex?: boolean | undefined } = {},
): IgnoreAnswer {
  if (path.includes("\0")) return "unknown";
  const at = anchor(resolve(root, path));
  if (!at || at.rel === "") return "unknown";
  try {
    runGit(at.cwd, ["check-ignore", "-q", ...(opts.noIndex ? ["--no-index"] : []), "--", at.rel]);
    return "ignored"; // exit 0
  } catch (e) {
    return (e as { status?: unknown }).status === 1 ? "not-ignored" : "unknown";
  }
}

/**
 * The files git tracks under the folder `dir` (relative to `root`, or absolute), as paths
 * relative to that folder; undefined when git cannot say (no git, no repository, an error).
 */
export function gitTrackedIn(root: string, dir: string): string[] | undefined {
  if (dir.includes("\0")) return undefined;
  const abs = resolve(root, dir);
  // ask from inside the folder when it exists, so its own repository (if any) answers
  const at = anchor(resolve(abs, "x"));
  if (!at) return undefined;
  const spec = dirname(at.rel); // "." when the folder exists
  let out: string;
  try {
    out = runGit(at.cwd, ["ls-files", "-z", "--", spec]);
  } catch {
    return undefined;
  }
  const prefix = spec === "." ? "" : `${spec.split(sep).join("/")}/`;
  return out
    .split("\0")
    .filter(Boolean)
    .map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f));
}
