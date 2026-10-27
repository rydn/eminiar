import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../config.js";
import { formatDoctor } from "../doctor.js";
import { ensureDirs } from "../paths.js";
import { resolveProjectRoot } from "../project.js";
import { globalDb } from "../stats/global.js";
import { version } from "../version.js";
import {
  clearNeedsAuthEntry,
  type Json,
  needsAuthEntry,
  readJson,
  writeInstallRecord,
  writeJsonWithBackup,
} from "./claude-config.js";
import { cursorPresent, registerCursor } from "./cursor.js";
import { fullDoctor } from "./doctor.js";
import { downloadModel, materialize, nativeCheck, rebuildNative } from "./materialize.js";
import { pinNode, pinRoot } from "./node-resolve.js";
import { registerPlugin, registerSettings, setStatusline } from "./register.js";
import { claudeCli, confirm, log } from "./shell.js";

export interface InstallOptions {
  noModel?: boolean;
  method?: "plugin" | "settings" | undefined;
  team?: boolean;
  marketplace?: string | undefined;
  node?: string | undefined;
  yes?: boolean;
  statusline?: boolean | undefined;
  /** Also register with Cursor (~/.cursor/hooks.json, mcp.json, skills/). */
  cursor?: boolean;
  /** Registry spec to install instead of packing the running copy (upgrade uses this). */
  spec?: string | undefined;
  /** Re-pack and reinstall the stable copy even when its version number is unchanged. */
  force?: boolean;
}

export async function install(opts: InstallOptions): Promise<number> {
  console.log(`eminiar v${version()} installer`);

  log.step("node");
  const node = pinNode(opts.node);
  log.ok(`pinned ${node.path} (v${node.version})`);

  log.step("stable copy");
  const { root: stable, fromSpec } = materialize(opts.spec, !!opts.force);
  // Claude Code's plugin cache copies dist/ but not node_modules/; the bin/ shims run
  // this pinned copy instead when they are launched from such a directory.
  pinRoot(stable);
  log.ok(`pinned as root-path (the bin/ shims fall back to it from Claude Code's plugin cache)`);

  log.step("native modules");
  let failures = nativeCheck(node.path, stable);
  if (failures.length) {
    log.warn(`${failures.join("; ")} — rebuilding better-sqlite3 for node ${node.version}`);
    rebuildNative(stable);
    failures = nativeCheck(node.path, stable);
  }
  if (failures.length) {
    for (const f of failures) log.fail(f);
    if (!failures.every((f) => f.startsWith("@huggingface"))) {
      log.fail("core native modules do not load; aborting before touching Claude Code config");
      log.info(`try: cd ${stable} && npm rebuild`);
      return 1;
    }
    log.warn("embeddings will be unavailable (lexical search still works)");
  } else {
    log.ok("better-sqlite3, sqlite-vec, web-tree-sitter, transformers load");
  }

  log.step("data directory");
  const p = ensureDirs();
  if (!existsSync(p.configFile))
    writeFileSync(p.configFile, `${JSON.stringify(ConfigSchema.parse({}), null, 2)}\n`);
  globalDb();
  log.ok(p.home);

  if (!opts.noModel && !failures.some((f) => f.startsWith("@huggingface"))) {
    log.step("embedding model (one-time download, ~35 MB)");
    const err = downloadModel(node.path, stable, ConfigSchema.parse({}).embeddings.model);
    if (err) log.warn(`download failed (${err}); it will be retried lazily on first hybrid search`);
    else log.ok("ready");
  }

  // Claude Code is the default client. With --cursor and no `claude` CLI (and no explicit
  // --method), the machine is treated as Cursor-only rather than writing unused settings.
  const claude = claudeCli();
  const wantClaude = !opts.cursor || !!claude || !!opts.method;
  const method = opts.method ?? (claude ? "plugin" : "settings");
  const targets = [wantClaude ? `Claude Code (${method} method)` : "", opts.cursor ? "Cursor" : ""]
    .filter(Boolean)
    .join(" and ");
  log.step(`register with ${targets}`);
  if (opts.cursor && !cursorPresent())
    log.warn(`${cursorDirHint()} not found; Cursor files are written anyway for its first launch`);
  if (
    !(await confirm(
      `Register eminiar with ${targets}? This edits your user-level ${[wantClaude ? "Claude" : "", opts.cursor ? "Cursor" : ""].filter(Boolean).join(" and ")} config.`,
      !!opts.yes,
    ))
  ) {
    log.warn("skipped registration; re-run with --yes or confirm interactively");
    return 1;
  }
  let wrote: Parameters<typeof writeInstallRecord>[0]["wrote"] = {};
  let usedMethod: "plugin" | "settings" | "none" = wantClaude ? method : "none";
  if (usedMethod === "plugin") {
    const r = registerPlugin(stable);
    if (r.ok) {
      log.ok(r.detail);
      wrote = { marketplace: true };
    } else {
      log.warn(`${r.detail}; falling back to settings method`);
      usedMethod = "settings";
    }
  }
  if (usedMethod === "settings") {
    wrote = registerSettings(stable);
    log.ok(
      "hooks written to ~/.claude/settings.json, MCP server to ~/.claude.json, skills to ~/.claude/skills",
    );
  }
  if (wantClaude) {
    // A previous launch that died (e.g. the cache copy before root-path existed) is remembered
    // by Claude Code for ~15 minutes. Forget it so the next session connects straight away.
    if (needsAuthEntry() && clearNeedsAuthEntry())
      log.ok("cleared Claude Code's cached connection failure for the plugin server");
    // Fresh `--yes` installs opt in; an explicit value (upgrade replays the previous choice) wins.
    const wantStatusline = opts.statusline ?? (!!opts.yes && !opts.team);
    if (wantStatusline) {
      if (setStatusline(stable)) {
        wrote.statusline = true;
        log.ok("statusLine set to `eminiar statusline`");
      }
    }
  }
  if (opts.cursor) {
    wrote.cursor = registerCursor(stable);
    log.ok(
      `hooks written to ${cursorDirHint()}/hooks.json, MCP server to ${cursorDirHint()}/mcp.json, skills to ${cursorDirHint()}/skills`,
    );
    if (usedMethod === "settings")
      log.warn(
        "Cursor also imports Claude Code hooks from ~/.claude/settings.json (Settings → Agents → Third-Party Imports); turn that off or each event fires twice in Cursor",
      );
  }

  writeInstallRecord({
    version: version(),
    method: usedMethod,
    node: node.path,
    stableRoot: stable,
    fromSpec,
    installedAt: new Date().toISOString(),
    wrote,
  });

  if (opts.team) {
    log.step("team defaults");
    writeTeamFiles(resolveProjectRoot(), opts.marketplace, { cursor: !!opts.cursor, stable });
  }

  log.step("doctor");
  const checks = await fullDoctor();
  console.log(formatDoctor(checks));
  const restart = [wantClaude ? "Claude Code" : "", opts.cursor ? "Cursor" : ""]
    .filter(Boolean)
    .join(" and ");
  console.log(
    `\nRestart ${restart} to load eminiar. Try ${wantClaude ? "/em-doctor, then " : ""}em_execute with an intent.`,
  );
  return checks.every((c) => c.ok) ? 0 : 1;
}

function cursorDirHint(): string {
  return process.env.CURSOR_CONFIG_DIR || "~/.cursor";
}

/** Commit-able defaults so teammates get the same behaviour from `npx eminiar install`. */
export function writeTeamFiles(
  root: string,
  marketplace?: string,
  extra: { cursor?: boolean; stable?: string } = {},
): void {
  const cfg = join(root, "eminiar.config.json");
  if (!existsSync(cfg)) {
    writeFileSync(
      cfg,
      `${JSON.stringify(
        {
          $schema: "https://raw.githubusercontent.com/rydn/eminiar/main/eminiar.config.schema.json",
          routing: { mode: "auto", deferToContextMode: true },
          graph: {
            exclude: [
              "**/node_modules/**",
              "**/dist/**",
              "**/build/**",
              "**/.git/**",
              "**/coverage/**",
              "**/*.d.ts",
            ],
          },
          index: { docs: ["**/*.md", "docs/**"] },
          permissions: { extraDeny: [] },
        },
        null,
        2,
      )}\n`,
    );
    log.ok(`wrote ${cfg} — commit it`);
  } else {
    log.ok(`${cfg} already exists`);
  }
  if (marketplace) {
    const m = /^github:(.+)$/.exec(marketplace);
    const file = join(root, ".claude", "settings.json");
    const settings = readJson(file);
    const known = (settings.extraKnownMarketplaces as Json | undefined) ?? {};
    known.eminiar = m
      ? { source: { source: "github", repo: m[1] } }
      : { source: { source: "url", url: marketplace } };
    settings.extraKnownMarketplaces = known;
    const enabled = (settings.enabledPlugins as Json | undefined) ?? {};
    enabled["eminiar@eminiar"] = true;
    settings.enabledPlugins = enabled;
    writeJsonWithBackup(file, settings);
    log.ok(
      `${file}: marketplace + enabledPlugins added — teammates are prompted to install on next launch`,
    );
  } else {
    log.info(
      `teammates: \`npx eminiar install${extra.cursor ? " --cursor" : ""}\` (reads the committed eminiar.config.json)`,
    );
  }
  if (extra.cursor) {
    // Cursor reads project rules from .cursor/rules/*.mdc; this one keeps the agent aware of
    // the em_* tools even in a session where the sessionStart hook did not run.
    const src = join(extra.stable ?? "", "rules", "eminiar.mdc");
    const dst = join(root, ".cursor", "rules", "eminiar.mdc");
    if (existsSync(dst)) log.ok(`${dst} already exists`);
    else if (existsSync(src)) {
      mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
      copyFileSync(src, dst);
      log.ok(`wrote ${dst} — commit it`);
    }
  }
}
