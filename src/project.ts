import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT_MARKERS = [
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
];

/** Walk up from `start` until a project marker is found; falls back to `start`. */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * The root for the MCP server, the CLI and the tools: (1) an explicit hint (tool arg),
 * (2) EMINIAR_PROJECT_ROOT / CLAUDE_PROJECT_DIR env (Claude Code sets the latter for the MCP
 * server too), (3) walking up from cwd.
 */
export function resolveProjectRoot(hint?: string): string {
  const candidate =
    hint || process.env.EMINIAR_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findProjectRoot(candidate);
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * This session's project root: CLAUDE_PROJECT_DIR (Claude Code sets it per hook command for
 * THIS session, and it stays put when Claude cd's), then EMINIAR_PROJECT_ROOT (inherited by
 * nested `claude` processes started from Bash, so it must not win), then `cwd` (a hook
 * payload's, which follows the cd; the only signal a CLI or test call gives), then the process
 * cwd. Unlike resolveProjectRoot, which the MCP server uses, the hook order puts the
 * per-session variable first.
 */
export function sessionRoot(cwd?: string): string {
  return resolveProjectRoot(
    process.env.CLAUDE_PROJECT_DIR || process.env.EMINIAR_PROJECT_ROOT || cwd || process.cwd(),
  );
}

/** Stable per-project identifier used for the data directory name. */
export function projectId(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}
