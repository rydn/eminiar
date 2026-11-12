import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The two questions the playbook store and the skill export ask git: is this path ignored, and
 * which files under this folder does git track. One place for both so they are asked the same
 * way: execFile of a git found on an absolute PATH entry, fixed arguments and `--`, the path
 * spelled `./<path>` so pathspec magic (`:/x`, `:(top)x`, `:!x`) is read as a file name, no
 * GIT_* variables from the environment (they can point git at another repository),
 * core.fsmonitor off (a repo-local hook must not run), a timeout, and the working directory set
 * to the folder that holds the path, so a nested repository or worktree (.claude/worktrees/wt)
 * answers for its own files.
 */

export type IgnoreAnswer = "ignored" | "not-ignored" | "unknown";

const TIMEOUT_MS = 10_000;

const isPathKey = (k: string): boolean => k.toUpperCase() === "PATH";

/**
 * PATH without its empty, `.` and relative entries. git runs with its working directory inside
 * the project (.eminiar/, .claude/skills/<name>), so any of those would find a committed `git`
 * there before the real one.
 */
function absolutePath(): string {
  const raw = Object.entries(process.env).find(([k]) => isPathKey(k))?.[1] ?? "";
  return raw
    .split(delimiter)
    .filter((e) => e !== "" && isAbsolute(e))
    .join(delimiter);
}

function gitEnv(path: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !isPathKey(k)),
  ) as NodeJS.ProcessEnv;
  env.PATH = path;
  return env;
}

const found = new Map<string, string>();

/**
 * The absolute file of the first git on the absolute PATH entries, undefined when there is none.
 * Resolved here rather than by the spawn, which on Windows also looks in the working directory.
 */
function gitBinary(path: string): string | undefined {
  const hit = found.get(path);
  if (hit !== undefined) return hit;
  const names = process.platform === "win32" ? ["git.exe", "git.com"] : ["git"];
  for (const dir of path.split(delimiter)) {
    for (const n of names) {
      const f = join(dir, n);
      try {
        if (!statSync(f).isFile()) continue;
        accessSync(f, constants.X_OK);
      } catch {
        continue;
      }
      found.set(path, f);
      return f;
    }
  }
  return undefined; // not cached: git may be installed later
}

/** `rel` as a pathspec git reads literally: `./` first, so it cannot start with `:`. */
const literal = (rel: string): string => `.${sep}${rel}`;

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
  const path = absolutePath();
  const bin = gitBinary(path);
  if (!bin) throw new Error("git not found on an absolute PATH entry");
  return execFileSync(bin, ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: gitEnv(path),
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
    // not --literal-pathspecs: check-ignore refuses it (exit 128) for every path
    runGit(at.cwd, [
      "check-ignore",
      "-q",
      ...(opts.noIndex ? ["--no-index"] : []),
      "--",
      literal(at.rel),
    ]);
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
    out = runGit(at.cwd, ["ls-files", "-z", "--", spec === "." ? "." : literal(spec)]);
  } catch {
    return undefined;
  }
  const prefix = spec === "." ? "" : `${spec.split(sep).join("/")}/`;
  return out
    .split("\0")
    .filter(Boolean)
    .map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f));
}
