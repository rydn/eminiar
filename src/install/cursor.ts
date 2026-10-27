import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cursorDir } from "../hooks/cursor.js";
import { findOnPath } from "../sandbox/languages.js";
import { type Json, readJson, writeJsonWithBackup } from "./claude-config.js";
import { isOurs } from "./register.js";

/**
 * Cursor has no plugin CLI, so eminiar registers the native way: user-level hooks in
 * ~/.cursor/hooks.json, the MCP server in ~/.cursor/mcp.json and the skills under
 * ~/.cursor/skills/. All three are documented, reload on save and survive upgrades
 * because they point at the stable copy. (~/.cursor/plugins/local would bundle the
 * same things, but it needs a copy rather than a symlink and an enterprise setting.)
 */
export const cursorHooksPath = (): string => join(cursorDir(), "hooks.json");
export const cursorMcpPath = (): string => join(cursorDir(), "mcp.json");
export const cursorSkillsDir = (): string => join(cursorDir(), "skills");

/** Cursor events eminiar subscribes to; see src/hooks/cursor.ts for the mapping. */
export const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStop",
  "preCompact",
  "afterAgentResponse",
  "sessionEnd",
];

/** Cursor's native tool names (Shell is Claude's Bash) plus the ones that match. */
export const CURSOR_PRE_TOOL_MATCHER = "Shell|Read|Write|Edit|Grep|Glob|WebFetch|WebSearch|Task";

const TIMEOUTS: Record<string, number> = { sessionStart: 10, preCompact: 15, postToolUse: 10 };

export interface CursorWrote {
  hookEvents: string[];
  mcpServer: boolean;
  skills: string[];
}

/** Is Cursor on this machine? The config dir appears on first launch. */
export function cursorPresent(): boolean {
  return (
    existsSync(cursorDir()) ||
    existsSync("/Applications/Cursor.app") ||
    !!findOnPath("cursor") ||
    !!findOnPath("cursor-agent")
  );
}

export function cursorHookCommand(stable: string): string {
  return `"${join(stable, "bin", "em-hook")}" --client cursor`;
}

/** Add (or refresh) eminiar's entries; other people's hooks and servers are left alone. */
export function registerCursor(stable: string): CursorWrote {
  const cfg = readJson(cursorHooksPath());
  if (typeof cfg.version !== "number") cfg.version = 1;
  const hooks = (cfg.hooks as Record<string, unknown> | undefined) ?? {};
  const command = cursorHookCommand(stable);
  for (const ev of CURSOR_HOOK_EVENTS) {
    const list = (Array.isArray(hooks[ev]) ? (hooks[ev] as Json[]) : []).filter(
      (h) => !isOurs(h.command, stable),
    );
    const entry: Json = { command, timeout: TIMEOUTS[ev] ?? 5 };
    if (ev === "preToolUse") entry.matcher = CURSOR_PRE_TOOL_MATCHER;
    list.push(entry);
    hooks[ev] = list;
  }
  cfg.hooks = hooks;
  writeJsonWithBackup(cursorHooksPath(), cfg);

  const mcp = readJson(cursorMcpPath());
  const servers = (mcp.mcpServers as Json | undefined) ?? {};
  servers.eminiar = {
    command: join(stable, "bin", "em-server"),
    args: [],
    env: { EMINIAR_PLUGIN_ROOT: stable },
  };
  mcp.mcpServers = servers;
  writeJsonWithBackup(cursorMcpPath(), mcp);

  const skills: string[] = [];
  const src = join(stable, "skills");
  if (existsSync(src)) {
    mkdirSync(cursorSkillsDir(), { recursive: true });
    for (const name of readdirSync(src)) {
      cpSync(join(src, name), join(cursorSkillsDir(), name), { recursive: true });
      skills.push(name);
    }
  }
  return { hookEvents: [...CURSOR_HOOK_EVENTS], mcpServer: true, skills };
}

/** Remove exactly what registerCursor wrote. */
export function unregisterCursor(stable: string, wrote: CursorWrote | undefined): void {
  if (!wrote) return;
  if (wrote.hookEvents.length && existsSync(cursorHooksPath())) {
    const cfg = readJson(cursorHooksPath());
    const hooks = (cfg.hooks as Record<string, unknown> | undefined) ?? {};
    for (const ev of wrote.hookEvents) {
      if (!Array.isArray(hooks[ev])) continue;
      const kept = (hooks[ev] as Json[]).filter((h) => !isOurs(h.command, stable));
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    cfg.hooks = hooks;
    writeJsonWithBackup(cursorHooksPath(), cfg);
  }
  if (wrote.mcpServer && existsSync(cursorMcpPath())) {
    const mcp = readJson(cursorMcpPath());
    const servers = mcp.mcpServers as Json | undefined;
    if (servers?.eminiar && isOurs((servers.eminiar as Json).command, stable)) {
      delete servers.eminiar;
      writeJsonWithBackup(cursorMcpPath(), mcp);
    }
  }
  for (const name of wrote.skills) {
    const dir = join(cursorSkillsDir(), name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

/** What the doctor needs to know about the Cursor side. */
export function cursorStatus(): { hooks: boolean; mcp: boolean; events: string[] } {
  const read = (f: string): string => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const hooksRaw = read(cursorHooksPath());
  let events: string[] = [];
  try {
    const cfg = hooksRaw ? (JSON.parse(hooksRaw) as Json) : {};
    const hooks = (cfg.hooks as Record<string, unknown> | undefined) ?? {};
    events = Object.keys(hooks).filter(
      (ev) =>
        Array.isArray(hooks[ev]) &&
        (hooks[ev] as Json[]).some(
          (h) => typeof h.command === "string" && h.command.includes("em-hook"),
        ),
    );
  } catch {
    // reported as missing
  }
  return { hooks: events.length > 0, mcp: read(cursorMcpPath()).includes("em-server"), events };
}
