/**
 * `eminiar adjudicator security …` (docs/design/adjudicator-security.md part 4, §12) and the
 * doctor lines for it. Advice only: switching it on or off writes ONLY ~/.eminiar/config.json
 * (never eminiar.config.json), the model opt-in names exactly what is sent, and a provider is
 * only ever called through the existing consent flow (resolveEvalCandidates: consent and key must
 * already exist; this module never grants either).
 *
 * adjudicator/cli.ts hands in the pieces it owns (Io, config loading, the personal-file write and
 * its trust check) so this file imports only types from it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AdjudicatorConfig } from "../../config.js";
import { type Config, projectAdjudicatorWarning } from "../../config.js";
import { paths } from "../../paths.js";
import type { StorageAdapter } from "../../storage/adapter.js";
import { activeSwarmConfig } from "../../swarm/config.js";
import { parseSince } from "../../tools/em_usage.js";
import type { DoctorCheck, Io } from "../cli.js";
import { resolveAdjudicator } from "../config.js";
import { adjudicate } from "../engine.js";
import { resolveEvalCandidates } from "../eval.js";
import type { ProviderDeps } from "../providers/http.js";
import type { AdjudicationRequest, AdjudicatorProvider, ProviderStatus } from "../types.js";
import { explain, viewOfRow } from "./advice.js";
import { assessText, type SecurityConfig } from "./assess.js";
import { SECURITY_EVAL_SET } from "./data/evalset.js";
import {
  formatSecurityEval,
  type JevLeg,
  mergeSecurityItems,
  parseSecurityFixture,
  runSecurityEval,
  type SecurityEvalReport,
  saveSecurityEval,
} from "./eval.js";
import { lastEvalOf, modelState } from "./report.js";
import { AUTONOMIES, type Autonomy, CAP_TAG, LEVELS, type Level } from "./types.js";

/** What adjudicator/cli.ts hands this module. */
export interface SecurityCliContext {
  root: string;
  io: Io;
  load(): Config;
  db(): Promise<StorageAdapter>;
  /** Merge a patch into the adjudicator section of ~/.eminiar/config.json (validated). */
  writePersonal(patch: Record<string, unknown>): void;
  /** True (after printing why) when the personal file cannot be trusted: nothing is written then. */
  personalUntrusted(): boolean;
  /** Test seams, the same as `adjudicator test|eval`. */
  provider?: AdjudicatorProvider | null | undefined;
  providerDeps?: ProviderDeps | undefined;
}

export const SECURITY_USAGE = `eminiar adjudicator security <command>   (opt-in advice; nothing is ever blocked)
  status [--json]                     On/off, who turned it on, model status, counts, last eval
  on [--model]                        Turn it on (~/.eminiar/config.json only). --model also asks Jev
                                      the security questions: tool ids and capability tags are sent
                                      next to the task text that already goes (asks y/N, or --yes)
  off [--model]                       Turn it off; with --model only the Jev questions stop
  test "<task>" [--tools a,b] [--agent T] [--role R] [--autonomy manual|default|autonomous]
       [--provider typesafe] [--json] Assess one task now; nothing is stored
  explain <id> [--json]               The full reasoning of a stored assessment
  list [--since 7d] [--level high] [--limit N] [--json]   Stored assessments, newest first
  eval [--provider typesafe] [--fixture f.json] [--replace] [--save] [--json]
                                      Per-level precision/recall, confusion matrix and FP/FN rates
                                      over the labelled set: heuristic always, Jev only when
                                      consented, keyed and security.model is "provider"`;

const RECONNECT = "Run /mcp reconnect so the MCP server picks up the change.";
const EVAL_STALE_NOTE = "advice only";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const pct = (n: unknown) => (typeof n === "number" ? `${Math.round(n * 100)}%` : "–");
const up = (l: string) => l.toUpperCase();

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The security section a file sets (undefined when none). */
const securityOf = (
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const a = raw?.adjudicator;
  return isObj(a) && isObj(a.security) ? a.security : undefined;
};

/** Which layer decides `enabled`: env > project (can only turn it on) > personal > default. */
export function securitySource(root: string, env: NodeJS.ProcessEnv): string {
  const e = env.EMINIAR_ADJUDICATOR_SECURITY;
  if (e === "0" || e === "1") return "EMINIAR_ADJUDICATOR_SECURITY";
  if (securityOf(readJson(join(root, "eminiar.config.json")))?.enabled === true)
    return "eminiar.config.json";
  if (typeof securityOf(readJson(paths().configFile))?.enabled === "boolean")
    return "~/.eminiar/config.json";
  return "default";
}

/** What the model part needs and whether it has it, in one phrase. */
export function securityModelStatus(
  config: Config,
  env: NodeJS.ProcessEnv,
): { setting: string; state: string; detail: string } {
  const a = config.adjudicator;
  const state = modelState(a);
  if (state === "off")
    return {
      setting: a.security.model,
      state,
      detail: "off (heuristic only; `security on --model` asks Jev too)",
    };
  if (state === "adjudicator-off")
    return {
      setting: a.security.model,
      state,
      detail: "needs adjudicator.enabled (`eminiar adjudicator enable --provider typesafe`)",
    };
  if (state === "unsupported")
    return {
      setting: a.security.model,
      state,
      detail: `unsupported for ${a.provider}: only Jev (typesafe) answers the security questions`,
    };
  const r = resolveAdjudicator(config, { context: "cli", env });
  if (r.provider !== r.configured)
    return {
      setting: a.security.model,
      state: "blocked",
      detail: `Jev cannot run (${r.degraded ?? "degraded"}${r.detail ? `: ${r.detail}` : ""}); the heuristic runs`,
    };
  return { setting: a.security.model, state, detail: "ready: Jev answers the security questions" };
}

// --- doctor -----------------------------------------------------------------------------------

function evalBrief(r: Record<string, unknown> | null | undefined): string | undefined {
  if (!r || !isObj(r.heuristic) || !isObj(r.heuristic.core)) return undefined;
  const core = r.heuristic.core;
  const warn = isObj(core.warn) ? core.warn : {};
  const ts = typeof r.ts === "number" ? new Date(r.ts).toISOString().slice(0, 10) : "?";
  const n = isObj(r.set) && typeof r.set.items === "number" ? r.set.items : "?";
  const jev =
    isObj(r.jev) && isObj(r.jev.core) ? ` · jev accuracy ${pct(r.jev.core.accuracy)}` : "";
  return `${ts} · ${n} items · heuristic (core) accuracy ${pct(core.accuracy)}, HIGH+ recall ${pct(warn.highRecall)}, LOW false-warn ${pct(warn.lowFalseWarn)}, CRITICAL precision ${pct(warn.criticalPrecision)}${jev}`;
}

/**
 * The cheap security checks of the doctor (no network). Nothing is reported while security is off,
 * its model setting is off and no eval was saved, so an untouched install shows no new line.
 */
export function securityDoctorChecks(
  config: Config,
  o: { root: string; db?: StorageAdapter | undefined; env?: NodeJS.ProcessEnv },
): DoctorCheck[] {
  const env = o.env ?? process.env;
  const sec = config.adjudicator.security;
  let last: Record<string, unknown> | null = null;
  try {
    last = o.db ? lastEvalOf(o.db) : null;
  } catch {
    last = null;
  }
  if (!sec.enabled && sec.model === "off" && !last) return [];
  const checks: DoctorCheck[] = [];
  if (!sec.enabled) {
    checks.push({
      name: "adjudicator security",
      ok: true,
      detail: `off (opt-in: \`eminiar adjudicator security on\`)${env.EMINIAR_ADJUDICATOR_SECURITY === "0" ? " · forced off by EMINIAR_ADJUDICATOR_SECURITY=0" : ""}`,
    });
  } else {
    const model = securityModelStatus(config, env);
    const modelOk = sec.model === "off" || model.state === "ready";
    let stored = "";
    let storeOk = true;
    try {
      if (o.db) {
        const s = o.db.security.summary(Date.now() - 7 * 86_400_000);
        stored = ` · 7 d: ${s.total} assessed, ${s.byLevel.high} high, ${s.byLevel.critical} critical`;
      }
    } catch (err) {
      storeOk = false;
      stored = ` · assessment store unreadable: ${(err as Error).message}`;
    }
    const surfaces = Object.entries(sec.surfaces)
      .filter(([, on]) => on)
      .map(([k]) => k)
      .join(",");
    checks.push({
      name: "adjudicator security",
      ok: modelOk && storeOk,
      detail: `on (${securitySource(o.root, env)}) · advice only · lines from ${up(sec.minLevel)} · surfaces ${surfaces || "none"} · model ${model.detail}${stored}`,
    });
  }
  if (last) {
    const brief = evalBrief(last);
    if (brief) checks.push({ name: "adjudicator security eval", ok: true, detail: brief });
  }
  return checks;
}

// --- helpers ----------------------------------------------------------------------------------

const label = (s: string) => s.replace(/[^A-Za-z0-9_.:@/-]/g, "").slice(0, 80);

const MODEL_NOTICE = (origin: string) =>
  `With security.model "provider", each security assessment that asks Jev sends, next to the redacted task text that already goes to ${origin}: the tool ids the agent holds (an MCP tool as mcp:<class>:<verb>, never a server name; at most 40) and capability tags (${Object.values(CAP_TAG).join(", ")}). Never file paths, tool arguments, session history or our own verdict. Only the plan, \`security test --provider\` and \`security eval --provider\` ask Jev; agent dispatch hooks never wait for it.`;

/** Resolve a Jev leg for eval/test through the consent flow; returns why not when it cannot run. */
function jevLeg(
  c: SecurityCliContext,
  config: Config,
  requested: readonly string[],
): { leg?: JevLeg; skipped: Array<{ provider: string; reason: string }> } {
  const skipped: Array<{ provider: string; reason: string }> = [];
  const a = config.adjudicator;
  const ids = [...new Set(requested.map((s) => (s === "jev" ? "typesafe" : s)))];
  for (const id of ids) {
    if (id !== "typesafe") {
      skipped.push({
        provider: id,
        reason: "unsupported: only Jev (typesafe) answers the security questions",
      });
      continue;
    }
    if (!a.enabled) {
      skipped.push({
        provider: id,
        reason: "needs adjudicator.enabled (`eminiar adjudicator enable --provider typesafe`)",
      });
      continue;
    }
    if (a.security.model !== "provider") {
      skipped.push({
        provider: id,
        reason:
          "security.model is off: `eminiar adjudicator security on --model` is the opt-in to send tool ids and tags",
      });
      continue;
    }
    const cfg: AdjudicatorConfig = { ...a, provider: "typesafe" };
    if (c.provider) {
      const m = resolveAdjudicator(
        { ...config, adjudicator: cfg },
        { context: "cli", env: c.io.env },
      );
      return {
        leg: {
          provider: c.provider,
          resolved: {
            ...m,
            provider: c.provider.id,
            configured: c.provider.id,
            consent: true,
            remote: c.provider.remote,
            configuredRemote: c.provider.remote,
          },
          config: { ...cfg, provider: c.provider.id },
        },
        skipped,
      };
    }
    const res = resolveEvalCandidates(cfg, ["typesafe"], {
      env: c.io.env,
      ...(c.providerDeps ? { deps: c.providerDeps } : {}),
    });
    skipped.push(...res.skipped);
    const cand = res.candidates[0];
    if (cand?.resolved)
      return {
        leg: {
          provider: cand.provider,
          resolved: cand.resolved,
          config: cfg,
          ...(cand.model ? { model: cand.model } : {}),
        },
        skipped,
      };
  }
  return { skipped };
}

// --- the command ------------------------------------------------------------------------------

export async function securityCommand(args: string[], c: SecurityCliContext): Promise<number> {
  const { io } = c;
  const { values, positionals } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      model: { type: "boolean" },
      yes: { type: "boolean" },
      tools: { type: "string" },
      agent: { type: "string" },
      role: { type: "string" },
      autonomy: { type: "string" },
      provider: { type: "string", multiple: true },
      fixture: { type: "string" },
      replace: { type: "boolean" },
      save: { type: "boolean" },
      since: { type: "string" },
      level: { type: "string" },
      limit: { type: "string" },
      project: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });
  const [sub = "status", ...rest] = positionals;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const providerFlag = (values.provider as string[] | undefined)?.filter(Boolean) ?? [];

  switch (sub) {
    case "status": {
      const config = c.load();
      const sec = config.adjudicator.security;
      let db: StorageAdapter | undefined;
      try {
        db = await c.db();
      } catch {
        db = undefined;
      }
      let summary: ReturnType<StorageAdapter["security"]["summary"]> | undefined;
      let last: Record<string, unknown> | null = null;
      try {
        summary = db?.security.summary(io.now() - 7 * 86_400_000);
        last = db ? lastEvalOf(db) : null;
      } catch {
        summary = undefined;
      }
      let projectIgnored: string | undefined;
      try {
        const w = projectAdjudicatorWarning(c.root);
        projectIgnored = w && /security/.test(w) ? w : undefined;
      } catch {
        projectIgnored = undefined;
      }
      const model = securityModelStatus(config, io.env);
      const out = {
        enabled: sec.enabled,
        enabledBy: securitySource(c.root, io.env),
        advisory: true,
        model,
        surfaces: sec.surfaces,
        minLevel: sec.minLevel,
        notifyUser: sec.notifyUser,
        modelFloor: sec.modelFloor,
        store: sec.store,
        last7d: summary
          ? { total: summary.total, byLevel: summary.byLevel, bySurface: summary.bySurface }
          : null,
        projectIgnored: projectIgnored ?? null,
        lastEval: last,
      };
      if (values.json) {
        io.out(JSON.stringify(out, null, 2));
        return 0;
      }
      io.out(
        `security: ${sec.enabled ? "on" : "off"} (${out.enabledBy}) · advice only, nothing is blocked · lines from ${up(sec.minLevel)} · user message from ${up(sec.notifyUser)} · surfaces ${
          Object.entries(sec.surfaces)
            .filter(([, on]) => on)
            .map(([k]) => k)
            .join(", ") || "none"
        }`,
      );
      io.out(`model: ${model.detail}`);
      io.out(`store: ${sec.store ? "on" : "off (advice only, nothing is recorded)"}`);
      if (summary)
        io.out(
          `last 7 d: ${summary.total} assessed · ${LEVELS.map((l) => `${l} ${summary?.byLevel[l] ?? 0}`).join(" · ")}`,
        );
      if (projectIgnored) io.out(`warning: ${projectIgnored}`);
      const brief = evalBrief(last);
      io.out(
        brief
          ? `last eval: ${brief}`
          : "last eval: none (`eminiar adjudicator security eval --save`)",
      );
      if (!sec.enabled) io.out("turn it on with `eminiar adjudicator security on`");
      return 0;
    }

    case "on":
    case "enable":
    case "off":
    case "disable": {
      const on = sub === "on" || sub === "enable";
      if (values.project) {
        io.err(
          "security is switched in ~/.eminiar/config.json only; a committed eminiar.config.json may set security.enabled: true by hand but this command never writes it",
        );
        return 2;
      }
      if (c.personalUntrusted()) return 1;
      const config = c.load();
      if (values.model) {
        if (!on) {
          c.writePersonal({ security: { model: "off" } });
          io.out(
            "security.model off: only the heuristic runs. Tool ids and tags are no longer sent.",
          );
          return 0;
        }
        const a = config.adjudicator;
        const r = resolveAdjudicator(config, { context: "cli", env: io.env });
        if (!a.enabled || r.configured !== "typesafe" || r.provider !== "typesafe") {
          io.err(
            `Not changed: the model part needs the adjudicator on with Jev, its consent and key (${
              !a.enabled
                ? "adjudicator is off"
                : r.configured !== "typesafe"
                  ? `provider is ${r.configured}`
                  : `${r.degraded ?? "degraded"}${r.detail ? `: ${r.detail}` : ""}`
            }). Run \`eminiar adjudicator enable --provider typesafe\` first.`,
          );
          return 1;
        }
        io.out(MODEL_NOTICE(r.origin ?? "api.typesafe.ai"));
        if (!values.yes) {
          if (!io.isTTY) {
            io.err("Not changed: no TTY to confirm on; pass --yes to accept this.");
            return 1;
          }
          const ans = (await io.ask("Send these to Jev with security questions? [y/N] "))
            .trim()
            .toLowerCase();
          if (ans !== "y" && ans !== "yes") {
            io.err("Not changed.");
            return 1;
          }
        }
        c.writePersonal({ security: { enabled: true, model: "provider" } });
      } else c.writePersonal({ security: { enabled: on } });
      const after = c.load().adjudicator.security;
      io.out(
        `security ${after.enabled ? "on" : "off"}${after.enabled !== on ? ` (${securitySource(c.root, io.env)} keeps it ${after.enabled ? "on" : "off"})` : ""} · model ${after.model} · wrote ~/.eminiar/config.json`,
      );
      io.out(RECONNECT);
      return 0;
    }

    case "test": {
      const text = rest.join(" ");
      if (!text.trim()) {
        io.err(
          'usage: eminiar adjudicator security test "<task>" [--tools a,b] [--agent T] [--role R] [--autonomy A] [--provider typesafe] [--json]',
        );
        return 2;
      }
      const autonomy = str(values.autonomy);
      if (autonomy && !(AUTONOMIES as readonly string[]).includes(autonomy)) {
        io.err(`unknown autonomy; use ${AUTONOMIES.join("|")}`);
        return 2;
      }
      const config = c.load();
      const sec: SecurityConfig = config.adjudicator.security;
      const tools = str(values.tools)
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const roleName = str(values.role);
      let role: { tools?: string[]; disallowedTools?: string[]; description?: string } | undefined;
      if (roleName) {
        const swarms = activeSwarmConfig(c.root)?.swarms ?? [];
        const found = swarms
          .flatMap((s) => s.roles)
          .find((r) => r.role === roleName || r.agentType === roleName);
        if (!found) {
          io.err(`no role ${label(roleName)} in the active swarm config`);
          return 2;
        }
        role = {
          ...(found.tools ? { tools: found.tools } : {}),
          ...(found.disallowedTools ? { disallowedTools: found.disallowedTools } : {}),
          description: found.description,
        };
      }
      const input = {
        text,
        ...(tools?.length ? { tools } : {}),
        ...(role ? { role } : {}),
        ...(str(values.agent) ? { agentType: str(values.agent) } : {}),
        ...(autonomy ? { autonomy: autonomy as Autonomy } : {}),
      };
      const opts = { root: c.root, cwd: c.root, env: io.env };
      let a = assessText(sec, input, opts);
      let modelNote: string | undefined;
      if (providerFlag.length) {
        const { leg, skipped } = jevLeg(c, config, providerFlag);
        if (!leg)
          modelNote = `no model answer: ${skipped.map((s) => `${s.provider}: ${s.reason}`).join("; ")}`;
        else {
          const req: AdjudicationRequest = {
            key: "t0",
            surface: "plan",
            text,
            hints: { security: a.hint },
          };
          const out = await adjudicate([req], {
            config: leg.config,
            resolved: leg.resolved,
            context: "cli",
            provider: leg.provider,
            persist: false,
            ignoreEnabled: true,
            units: false,
            env: io.env,
            budgetMs: leg.config.timeouts.planMs,
          });
          const v = out[0]?.verdict;
          const status: ProviderStatus = v?.providerStatus ?? "skipped";
          a = assessText({ ...sec, model: "provider" }, input, {
            ...opts,
            ...(v?.security ? { answer: v.security } : {}),
            status: v?.security ? "ok" : status,
            source: "blend",
          });
          modelNote = v?.security ? "Jev answered" : `no model answer: ${status}`;
        }
      }
      if (values.json) {
        io.out(
          JSON.stringify(
            {
              level: a.assessment.level,
              score: a.assessment.score,
              action: a.assessment.action,
              heuristicLevel: a.assessment.heuristic.level,
              modelStatus: a.assessment.modelStatus,
              detail: a.view.detail,
              hint: a.hint,
              persisted: false,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      io.out(explain(a.view));
      if (modelNote) io.out(`model: ${modelNote}`);
      io.out("(not persisted; advice only)");
      return 0;
    }

    case "explain": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id < 1) {
        io.err("usage: eminiar adjudicator security explain <assessment id>");
        return 2;
      }
      const db = await c.db();
      let row: ReturnType<StorageAdapter["security"]["get"]>;
      try {
        row = db.security.get(id);
      } catch (err) {
        io.err(`could not read assessments: ${(err as Error).message}`);
        return 1;
      }
      if (!row) {
        io.err(`no security assessment ${id}`);
        return 1;
      }
      const view = viewOfRow(row);
      if (values.json) {
        io.out(
          JSON.stringify(
            {
              id: row.id,
              ts: row.ts,
              surface: row.surface,
              runId: row.runId,
              taskId: row.taskId,
              view,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      io.out(
        explain(view, {
          surface: row.surface,
          ts: row.ts,
          agentType: row.agentType,
          runId: row.runId,
          taskId: row.taskId,
        }),
      );
      return 0;
    }

    case "list": {
      let since: number | undefined;
      try {
        since = parseSince(str(values.since), io.now());
      } catch {
        io.err(
          "invalid --since: use an ISO date (2026-10-01) or a relative value like 30d, 12h, 2w",
        );
        return 2;
      }
      const level = str(values.level);
      if (level && !(LEVELS as readonly string[]).includes(level)) {
        io.err(`unknown level; use ${LEVELS.join("|")}`);
        return 2;
      }
      const limit = str(values.limit) === undefined ? 20 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        io.err("--limit takes a whole number from 1 to 500");
        return 2;
      }
      const db = await c.db();
      let res: ReturnType<StorageAdapter["security"]["list"]>;
      try {
        res = db.security.list({
          ...(since !== undefined ? { since } : {}),
          ...(level ? { level: level as Level } : {}),
          limit,
        });
      } catch (err) {
        io.err(`could not read assessments: ${(err as Error).message}`);
        return 1;
      }
      if (values.json) {
        io.out(
          JSON.stringify(
            {
              total: res.total,
              rows: res.rows.map((r) => ({
                id: r.id,
                ts: r.ts,
                surface: r.surface,
                level: r.level,
                score: r.score,
                heuristicLevel: r.heuristicLevel,
                modelStatus: r.modelStatus,
                agentType: r.agentType,
                runId: r.runId,
                taskId: r.taskId,
                rules: r.rules,
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      if (!res.rows.length) {
        io.out("no security assessments in this window");
        return 0;
      }
      for (const r of res.rows)
        io.out(
          `${String(r.id).padStart(5)}  ${new Date(r.ts).toISOString().slice(0, 19)}Z  ${r.surface.padEnd(6)}  ${up(r.level).padEnd(8)} ${String(r.score).padStart(3)}  ${r.agentType ? label(r.agentType) : "-"}${r.runId ? ` ${r.runId}${r.taskId != null ? `#${r.taskId}` : ""}` : ""}  [${r.rules.join(" ")}]`,
        );
      io.out(`${res.rows.length} of ${res.total} (\`security explain <id>\` for one)`);
      return 0;
    }

    case "eval": {
      const config = c.load();
      let items = [...SECURITY_EVAL_SET];
      const fixtureFile = str(values.fixture);
      if (fixtureFile) {
        if (!/\.json$/i.test(fixtureFile)) {
          io.err("--fixture takes a .json file");
          return 2;
        }
        try {
          items = mergeSecurityItems(
            items,
            parseSecurityFixture(
              JSON.parse(readFileSync(fixtureFile, "utf8")),
              fixtureFile.split(/[\\/]/).pop() ?? "fixture",
            ),
            values.replace ? "replace" : "merge",
          );
        } catch (err) {
          io.err(
            err instanceof SyntaxError ? "the fixture is not valid JSON" : (err as Error).message,
          );
          return 2;
        }
      }
      const a = config.adjudicator;
      const requested = providerFlag.length
        ? providerFlag
        : a.provider !== "heuristic"
          ? [a.provider]
          : [];
      const { leg, skipped } = jevLeg(c, config, requested);
      const report: SecurityEvalReport = await runSecurityEval({
        security: a.security,
        items,
        ...(leg ? { jev: leg } : {}),
        skipped,
        env: io.env,
        now: io.now,
      });
      if (values.save) {
        try {
          saveSecurityEval(await c.db(), report);
        } catch (err) {
          io.err(`could not save the report: ${(err as Error).message}`);
          return 1;
        }
      }
      io.out(values.json ? JSON.stringify(report, null, 2) : formatSecurityEval(report));
      if (values.save && !values.json)
        io.out(`saved as the last security eval (dashboard → Adjudicator). ${EVAL_STALE_NOTE}.`);
      return 0;
    }

    case "help":
      io.out(SECURITY_USAGE);
      return 0;

    default:
      io.err(`unknown security command: ${label(sub)}\n`);
      io.out(SECURITY_USAGE);
      return 2;
  }
}
