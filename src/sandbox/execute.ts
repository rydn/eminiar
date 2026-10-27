import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ProjectContext } from "../context.js";
import { checkCommand, loadPermissionRules } from "../permissions/settings.js";
import { buildEnv } from "./env.js";
import { detectInterpreter, prepareCode, resolveLanguage, writeScratch } from "./languages.js";
import { type RunResult, runProcess } from "./run.js";

export interface ExecuteInput {
  language: string;
  code: string;
  timeoutMs?: number | undefined;
  /** Extra env for the child (e.g. EM_FILE). */
  env?: Record<string, string> | undefined;
}

export type ExecuteResult = RunResult & { argv: string[] };

/**
 * Run a snippet in the chosen language inside the project root with a stripped
 * environment. Shell snippets are checked against Claude Code's Bash deny/ask
 * rules first; other languages cannot be checked and are gated by config.
 */
export async function execute(ctx: ProjectContext, input: ExecuteInput): Promise<ExecuteResult> {
  const lang = resolveLanguage(input.language);
  if (!lang) throw new Error(`unknown language "${input.language}"`);
  if (ctx.config.sandbox.disabledLanguages.includes(lang.id)) {
    throw new Error(`language "${lang.id}" is disabled by eminiar.config.json`);
  }
  const bin = detectInterpreter(lang);
  if (!bin) throw new Error(`${lang.id} is not installed (no interpreter on PATH)`);

  if (lang.id === "shell") {
    const rules = loadPermissionRules(ctx.root, ctx.config.permissions.extraDeny);
    const check = checkCommand(rules, input.code);
    if (!check.allowed) {
      throw new Error(
        `refused by permission rule ${check.rule} (${check.kind}) on segment: ${check.segment}`,
      );
    }
  }

  const file = writeScratch(prepareCode(lang, input.code), lang.ext);
  const env = buildEnv(ctx.config.sandbox.envAllow, {
    EMINIAR_PROJECT_ROOT: ctx.root,
    NODE_PATH: [join(ctx.root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(":"),
    ...input.env,
  });
  try {
    const argv = lang.argv(bin, file);
    const r = await runProcess(argv, {
      cwd: ctx.root,
      env,
      timeoutMs: input.timeoutMs ?? ctx.config.sandbox.timeoutMs,
      maxOutputBytes: ctx.config.sandbox.maxOutputBytes,
    });
    return { ...r, argv };
  } finally {
    try {
      unlinkSync(file);
      if (lang.id === "rust") unlinkSync(`${file}.bin`);
    } catch {
      // scratch file already gone
    }
  }
}

export function describeRun(r: RunResult): string {
  const kb = (r.stdout.length / 1024).toFixed(1);
  const parts = [
    `exit ${r.exitCode ?? (r.signal ? `signal ${r.signal}` : "?")}`,
    `${kb} KB stdout`,
    `${(r.durationMs / 1000).toFixed(1)}s`,
  ];
  if (r.timedOut) parts.push("TIMED OUT");
  if (r.truncated) parts.push("TRUNCATED at output cap");
  return parts.join(" · ");
}
