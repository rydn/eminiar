import { existsSync, rmSync } from "node:fs";
import { paths } from "../paths.js";
import { readInstallRecord } from "./claude-config.js";
import { unregisterCursor } from "./cursor.js";
import { clearStatusline, unregisterPlugin, unregisterSettings } from "./register.js";
import { confirm, log } from "./shell.js";

export async function uninstall(opts: { purgeData?: boolean; yes?: boolean }): Promise<number> {
  const rec = readInstallRecord();
  const p = paths();
  const plan = [
    rec?.method === "plugin" || !rec
      ? "claude plugin uninstall eminiar@eminiar + marketplace remove"
      : "",
    rec?.method === "settings"
      ? "remove eminiar hook entries from ~/.claude/settings.json, mcpServers.eminiar from ~/.claude.json, em-* skills"
      : "",
    rec?.wrote.cursor
      ? "remove eminiar hook entries from ~/.cursor/hooks.json, mcpServers.eminiar from ~/.cursor/mcp.json, em-* skills from ~/.cursor/skills"
      : "",
    rec?.wrote.statusline ? "clear the eminiar statusLine" : "",
    `delete ${p.plugin}`,
    opts.purgeData
      ? `delete ${p.home} (ALL indexes, memories, stats)`
      : `keep ${p.home} (indexes, memories, stats)`,
  ].filter(Boolean);
  console.log("This will:");
  for (const l of plan) console.log(`  - ${l}`);
  if (!(await confirm("Proceed?", !!opts.yes))) return 1;

  const stable = rec?.stableRoot ?? `${p.plugin}/node_modules/eminiar`;
  if (!rec || rec.method === "plugin") unregisterPlugin();
  if (rec?.method === "settings") unregisterSettings(stable, rec.wrote);
  if (rec?.wrote.cursor) unregisterCursor(stable, rec.wrote.cursor);
  if (rec?.wrote.statusline) clearStatusline(stable);
  if (existsSync(p.plugin)) rmSync(p.plugin, { recursive: true, force: true });
  if (opts.purgeData) rmSync(p.home, { recursive: true, force: true });
  else if (existsSync(p.installFile)) rmSync(p.installFile, { force: true });
  const from = [rec?.method !== "none" ? "Claude Code" : "", rec?.wrote.cursor ? "Cursor" : ""]
    .filter(Boolean)
    .join(" and ");
  log.ok(`eminiar removed from ${from || "Claude Code"}; restart it to finish`);
  return 0;
}
