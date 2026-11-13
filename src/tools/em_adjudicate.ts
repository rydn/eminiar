/**
 * em_adjudicate (docs/design/adjudicator.md §15): score text or tasks on demand, explain one
 * stored decision, summarise the decisions and their savings, and take feedback that teaches the
 * learned bias. Registered only while the adjudicator is enabled (`available`), so its schema
 * costs nothing in sessions that do not use it.
 */

import { z } from "zod";
import { resolveAdjudicator } from "../adjudicator/config.js";
import { adjudicate } from "../adjudicator/engine.js";
import { complexityBucket } from "../adjudicator/heuristic.js";
import { applyFeedbackResult, type Feedback, reconcile } from "../adjudicator/learn.js";
import {
  defaultEmbeddingFactory,
  type EmbeddingFactory,
} from "../adjudicator/providers/embedding.js";
import { registerProvider } from "../adjudicator/providers/index.js";
import { head } from "../adjudicator/redact.js";
import { type SavingsReportOptions, savingsReport } from "../adjudicator/savings.js";
import { explain as explainSecurity, mcpBlock, viewOfRow } from "../adjudicator/security/advice.js";
import { assessText, planModelStatus, record } from "../adjudicator/security/assess.js";
import { AUTONOMIES } from "../adjudicator/security/types.js";
import { learnedBias } from "../adjudicator/swarm.js";
import type {
  AdjudicationRequest,
  AdjudicationRow,
  Reason,
  ScoreTable,
  Verdict,
} from "../adjudicator/types.js";
import type { Config } from "../config.js";
import type { ProjectContext } from "../context.js";
import { getProvider } from "../embeddings/provider.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { findSwarm, loadSwarmConfig } from "../swarm/config.js";
import { capOutput } from "../swarm/format.js";
import type { RoleSpec } from "../swarm/types.js";
import { formatUsd } from "../usage/pricing.js";
import { parseSince } from "./em_usage.js";
import { defineTool, errorResult, LOCAL_WRITE, type ToolResult, text } from "./types.js";

export const ADJUDICATE_ACTIONS = ["score", "explain", "stats", "feedback", "security"] as const;
export const FEEDBACK_VALUES = ["good", "too_small", "too_big"] as const;

/** The compact actions stay under this; explain may run longer. */
export const COMPACT_MAX = 1000;
const EXPLAIN_MAX = 6000;
/** A feedback note is stored redact()ed and cut to this many chars. */
export const NOTE_MAX = 500;

const OFF =
  "The adjudicator is off for this project: run `eminiar adjudicator enable`, then /mcp reconnect.";
const SECURITY_OFF =
  "Security advice is off for this project: run `eminiar adjudicator security enable`, then /mcp reconnect.";

const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ms = (n: number | null | undefined) => (typeof n === "number" ? `${Math.round(n)} ms` : "–");
const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "unknown" : formatUsd(n);

// --- score ---------------------------------------------------------------------------

/** The three reasons that moved complexity most, as their short notes. */
export function topReasons(reasons: readonly Reason[], n = 3): string[] {
  return [...reasons]
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, n)
    .map((r) => clip(r.note || r.feature, 40));
}

/** One compact line for a scored item. */
export function scoreLine(v: Verdict, why = true): string {
  const id = v.id !== undefined ? `[${v.id}] ` : "";
  const src = v.source === "heuristic" ? "heuristic" : `${v.source} ${v.provider}`;
  const reasons = why ? topReasons(v.complexityReasons) : [];
  return [
    `${id}${v.key}: complexity ${complexityBucket(v.complexity)} (${r2(v.complexity)})`,
    `${v.tier.choice}/${v.effort}`,
    `tool ${v.tool.choice}`,
    `role ${v.role.choice}`,
    `conf ${r2(v.tier.confidence)}`,
    ...(reasons.length ? [`why: ${reasons.join("; ")}`] : []),
    `${src}${v.providerStatus !== "ok" && v.providerStatus !== "n/a" ? ` (${v.providerStatus})` : ""} ${ms(v.latencyMs)}`,
  ].join(" · ");
}

function formatScores(verdicts: readonly Verdict[]): string {
  let out = verdicts.map((v) => scoreLine(v)).join("\n");
  if (out.length > COMPACT_MAX) out = verdicts.map((v) => scoreLine(v, false)).join("\n");
  const hint = verdicts.some((v) => v.id !== undefined)
    ? 'em_adjudicate {action:"explain", id} shows one decision in full'
    : undefined;
  return capOutput(out, COMPACT_MAX, hint);
}

// --- explain -------------------------------------------------------------------------

interface StoredScores {
  complexity?: number;
  complexityReasons?: Reason[];
  tool?: ScoreTable;
  tier?: ScoreTable;
  role?: ScoreTable;
  effort?: string;
  features?: Record<string, unknown>;
  alpha?: Record<string, number>;
  bias?: Record<string, number>;
}

function parseScores(row: AdjudicationRow): StoredScores | undefined {
  if (!row.scores) return undefined;
  try {
    const s = JSON.parse(row.scores) as unknown;
    return s && typeof s === "object" ? (s as StoredScores) : undefined;
  } catch {
    return undefined;
  }
}

function tableLines(t: ScoreTable | undefined): string[] {
  if (!t?.entries?.length) return [];
  return [
    `${t.dimension}: ${t.choice} (conf ${r2(t.confidence)})`,
    ...t.entries.slice(0, 5).map((e) => {
      const why = e.reasons
        .slice(0, 3)
        .map((r) => clip(r.note || r.feature, 50))
        .join("; ");
      return `  ${e.option} ${r2(e.score)}${why ? ` — ${why}` : ""}`;
    }),
  ];
}

function compactJson(o: Record<string, unknown> | undefined): string {
  if (!o) return "–";
  const kept = Object.entries(o).filter(
    ([, v]) => v !== 0 && v !== false && v !== null && v !== undefined,
  );
  return kept.length ? clip(JSON.stringify(Object.fromEntries(kept)), 400) : "–";
}

export function formatExplain(
  row: AdjudicationRow,
  status: { provider: string; detail?: string; breaker?: string },
): string {
  const s = parseScores(row);
  const head = `Decision ${row.id} · ${new Date(row.ts).toISOString()} · surface ${row.surface}${
    row.runId ? ` · run ${row.runId}${row.taskId != null ? ` task #${row.taskId}` : ""}` : ""
  }${row.inputHead ? `\ninput: "${row.inputHead}"${row.inputChars ? ` (${row.inputChars} chars)` : ""}` : ""}`;
  const verdict = `verdict: complexity ${row.complexity != null ? r2(row.complexity) : "–"} · ${row.tier ?? "–"}/${row.effort ?? "–"} · tool ${row.tool ?? "–"} · role ${row.role ?? "–"} · conf ${row.confidence != null ? r2(row.confidence) : "–"}`;
  const complexity = s?.complexityReasons?.length
    ? `complexity reasons: ${s.complexityReasons
        .slice()
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
        .slice(0, 6)
        .map((r) => `${r.feature} ${r.weight >= 0 ? "+" : ""}${r2(r.weight)}`)
        .join(", ")}`
    : undefined;
  const provider = [
    `source ${row.source ?? "–"} · provider ${row.provider ?? "–"}${row.providerModel ? ` (${row.providerModel})` : ""} · status ${row.providerStatus ?? "–"}`,
    `latency ${ms(row.latencyMs)} (provider ${ms(row.providerLatencyMs)}) · tokens ${row.tokensIn ?? 0} in / ${row.tokensOut ?? 0} out · cost ${row.tokensIn || row.tokensOut ? usd(row.costUsd) : "$0.00"}`,
    `now: provider ${status.provider}${status.detail ? ` (${status.detail})` : ""}${status.breaker ? ` · breaker ${status.breaker}` : ""}`,
  ];
  const blend = `alpha ${compactJson(s?.alpha)} · bias ${compactJson(s?.bias)}`;
  const features = `features ${compactJson(s?.features)}`;
  const outcome = [
    `action ${row.action ?? "–"} · requested ${row.modelRequested ?? "–"} · final ${row.modelFinal ?? "–"} · baseline ${row.baselineModel ?? "–"}`,
    `outcome ${row.outcome}${row.outcomeSource ? ` (${row.outcomeSource})` : ""}${row.final ? ", final" : ""} · actual ${row.actualModel ?? "–"}${
      row.actualTokens != null ? `, ${row.actualTokens} tokens` : ""
    }${row.actualCostUsd != null ? `, ${usd(row.actualCostUsd)}` : ""} · baseline cost ${usd(row.baselineCostUsd)} · savings ${usd(row.savingsUsd)}`,
    ...(row.feedbackNote ? [`feedback note: "${row.feedbackNote}"`] : []),
  ];
  return capOutput(
    [
      head,
      verdict,
      ...(complexity ? [complexity] : []),
      ...tableLines(s?.tier),
      ...tableLines(s?.role),
      ...tableLines(s?.tool),
      blend,
      features,
      ...provider,
      ...outcome,
    ].join("\n"),
    EXPLAIN_MAX,
  );
}

// --- stats ---------------------------------------------------------------------------

const counts = (o: Record<string, number>) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ") || "–";

export function formatStats(
  db: StorageAdapter,
  config: Pick<Config, "adjudicator" | "usage">,
  since?: number,
): string {
  try {
    reconcile(db, { config, limit: 500 });
  } catch {
    // stale figures beat no figures
  }
  const s = db.adjudicator.summary(since);
  if (!s.total)
    return `No adjudicator decisions${since ? ` since ${new Date(since).toISOString().slice(0, 10)}` : ""} yet.`;
  const sv = savingsReport(db, {
    since,
    pricing: config.usage?.pricing as SavingsReportOptions["pricing"],
  });
  const lines = [
    `Adjudicator${since ? ` since ${new Date(since).toISOString().slice(0, 10)}` : ""}: ${s.total} decision(s) · ${counts(s.bySurface)}`,
    `source ${counts(s.bySource)} · provider ${counts(s.byProviderStatus)}`,
    `latency p50 ${ms(s.latency.p50)} p95 ${ms(s.latency.p95)} · provider p50 ${ms(s.providerLatency.p50)} p95 ${ms(s.providerLatency.p95)}`,
    `advice followed ${pct(s.rates.follow)} · applied ${pct(s.rates.apply)} · respected ${pct(s.rates.respect)}${
      s.applyChecked ? ` · apply ineffective ${s.applyIneffective} of ${s.applyChecked}` : ""
    }`,
    ...(s.effortFollowed + s.effortIgnored
      ? [
          `effort followed ${pct(s.rates.effortFollow)} (${s.effortFollowed} followed, ${s.effortIgnored} ignored of ${s.effortFollowed + s.effortIgnored})${
            s.effortIneffective ? ` · set but not run ${s.effortIneffective}` : ""
          }`,
        ]
      : []),
    `outcomes ${counts(s.byOutcome)}`,
    `spend ${formatUsd(sv.spendUsd)} · realised ${formatUsd(sv.realisedUsd)}${
      sv.redoPenaltyUsd ? ` (redo ${formatUsd(sv.redoPenaltyUsd)})` : ""
    } · net ${formatUsd(sv.netUsd)} · potential ${formatUsd(sv.potentialUsd)} (main session, not in net)${
      sv.usageAvailable ? "" : " · no usage data yet"
    }`,
  ];
  return capOutput(lines.join("\n"), COMPACT_MAX);
}

// --- server start --------------------------------------------------------------------

export interface ServerProviderOptions {
  /** Load the exemplar vectors and the model in the background once registered. */
  warm?: boolean;
  /** Test seams: the factory to register and the shared embedder the warm-up loads. */
  factory?: EmbeddingFactory;
  embedder?: () => Promise<{ warm?(): void } | undefined>;
}

/**
 * Register the runtime-only providers the MCP server can run (the embedding provider) when
 * the adjudicator is enabled and embedding is the effective provider. Returns whether it
 * registered one; a disabled server never runs the embedding module. It is imported
 * statically: the server is one file (tsup.config.ts), and only the CLI and server reach
 * this module, never a hook. `warm` never delays the return: the warm-up runs detached and its failure only
 * means the first plan or score call loads the model instead.
 */
export async function registerServerProviders(
  config: Config,
  opts: ServerProviderOptions = {},
): Promise<boolean> {
  if (!config.adjudicator?.enabled) return false;
  const r = resolveAdjudicator(config, { context: "server" });
  if (r.provider !== "embedding") return false;
  const factory = opts.factory ?? defaultEmbeddingFactory(config);
  registerProvider("embedding", factory);
  if (opts.warm) {
    const embedder = opts.embedder ?? (() => getProvider(config));
    // Exemplar vectors first (usually from the disk cache), then the model itself: a cached
    // load never runs the model, which would leave it for the first query.
    void (async () => {
      await factory(r, config.adjudicator, {}).warm();
      (await embedder())?.warm?.();
    })().catch(() => undefined);
  }
  return true;
}

// --- tool ----------------------------------------------------------------------------

const Task = z.object({
  key: z.string().min(1).max(40),
  title: z.string().min(1).max(400),
  detail: z.string().max(4000).optional(),
  role: z.string().max(60).optional(),
});

const SCHEMA = {
  action: z.enum(ADJUDICATE_ACTIONS),
  text: z.string().max(8000).optional().describe("score: the request to score"),
  tasks: z.array(Task).max(20).optional().describe("score: tasks to score in one batch"),
  id: z.number().int().positive().optional().describe("explain/feedback: decision id"),
  outcome: z.enum(FEEDBACK_VALUES).optional().describe("feedback: how the advice turned out"),
  note: z
    .string()
    .max(4000)
    .optional()
    .describe(`feedback: a short note, kept redacted and cut to ${NOTE_MAX} chars`),
  since: z.string().optional().describe("stats: ISO date or relative like 7d, 12h"),
  tools: z
    .array(z.string().max(100))
    .max(60)
    .optional()
    .describe("security: the tools the agent gets (names as an agent file spells them)"),
  agent_type: z
    .string()
    .max(100)
    .optional()
    .describe("security: a subagent_type whose definition gives the tools"),
  role: z
    .string()
    .max(60)
    .optional()
    .describe("security: a swarm role whose tools are the agent's (a task's role wins)"),
  autonomy: z
    .enum(AUTONOMIES)
    .optional()
    .describe("security: how unattended the work is (default: from the agent's permission mode)"),
};

type Args = z.infer<z.ZodObject<typeof SCHEMA>>;

export const emAdjudicate = defineTool({
  name: "em_adjudicate",
  annotations: { ...LOCAL_WRITE, openWorldHint: true, idempotentHint: false },
  description:
    'The adjudicator (opt-in): score how complex a request or task is and which tool, Claude model size (Agent `model`: haiku|sonnet|opus|fable) and swarm role fit it. score {text} or {tasks:[{key,title,detail?,role?}]} returns one line per item with its decision id; explain {id} shows the full score tables, provider status, cost and outcome; stats {since} summarises decisions, follow rate and savings; feedback {id, outcome:"good"|"too_small"|"too_big", note?} teaches the learned bias; security {text | tasks, tools? | agent_type? | role?, autonomy?} rates the security risk of the work for an agent with those tools (advice only, needs adjudicator.security.enabled).',
  schema: SCHEMA,
  available: (config) => !!config.adjudicator?.enabled || !!config.adjudicator?.security?.enabled,
  handler: (args, ctx) => runAdjudicate(args, ctx),
});

/** The handler body; `deps.provider` is the test seam (null forces the heuristic). */
export async function runAdjudicate(
  args: Args,
  ctx: ProjectContext,
  deps: {
    db?: StorageAdapter;
    provider?: Parameters<typeof adjudicate>[1]["provider"];
    now?: () => number;
  } = {},
): Promise<ToolResult> {
  const cfg = ctx.config.adjudicator;
  const db = () => deps.db ?? getStorage(ctx);
  switch (args.action) {
    case "score": {
      if (!cfg?.enabled) return text(OFF);
      const reqs: AdjudicationRequest[] = [];
      if (args.text?.trim()) reqs.push({ key: "text", surface: "mcp", text: args.text });
      for (const t of args.tasks ?? []) {
        const req: AdjudicationRequest = {
          key: t.key,
          surface: "mcp",
          text: [t.title, t.detail ?? ""].join("\n").trim(),
        };
        if (t.role) req.hints = { role: t.role };
        reqs.push(req);
      }
      if (!reqs.length) return errorResult("score needs text or tasks:[{key, title}]");
      const store = db();
      const out = await adjudicate(reqs, {
        config: cfg,
        store: store.adjudicator,
        context: "server",
        call: "inline",
        budgetMs: cfg.timeouts.planMs,
        row: { action: "none" },
        bias: learnedBias(store, cfg),
        projectRoot: ctx.root,
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      return text(formatScores(out.map((a) => a.verdict)));
    }
    case "explain": {
      if (args.id === undefined) return errorResult("explain needs id (a decision id from score)");
      const store = db();
      const row = store.adjudicator.get(args.id);
      if (!row) return errorResult(`no adjudicator decision ${args.id}`);
      const r = resolveAdjudicator(ctx.config, { context: "server" });
      let breaker: string | undefined;
      try {
        breaker = store.adjudicator.providerState(r.provider)?.state;
      } catch {
        breaker = undefined;
      }
      const out = formatExplain(row, {
        provider: r.enabled ? r.provider : "off",
        ...(r.detail ? { detail: r.detail } : {}),
        ...(breaker ? { breaker } : {}),
      });
      return text(cfg?.security?.enabled ? withSecurityLink(out, store, row) : out);
    }
    case "stats": {
      let since: number | undefined;
      try {
        since = parseSince(args.since);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      return text(formatStats(db(), ctx.config, since));
    }
    case "security":
      return runSecurity(args, ctx, deps);
    case "feedback": {
      if (!cfg?.enabled) return text(OFF);
      if (args.id === undefined || !args.outcome)
        return errorResult('feedback needs id and outcome: "good", "too_small" or "too_big"');
      const fb = applyFeedbackResult(db(), args.id, args.outcome as Feedback, {
        config: ctx.config,
        ...(deps.now ? { now: deps.now() } : {}),
      });
      if (!fb) return errorResult(`no adjudicator decision ${args.id}`);
      const { row } = fb;
      const note = args.note?.trim() ? head(args.note, NOTE_MAX) : undefined;
      if (note) db().adjudicator.update(row.id, { feedbackNote: note });
      // Feedback replaces the decision's earlier lesson, so repeating it changes nothing.
      const learned = !cfg.learning.enabled
        ? ""
        : fb.learned > 0
          ? "; the learned bias was updated"
          : "; the learned bias already reflects this";
      return text(
        `Feedback ${args.outcome} on decision ${row.id} (${row.tier ?? "–"}${row.role ? `, ${row.role}` : ""}): outcome ${row.outcome}, final${learned}.${
          note ? ` Note: ${clip(note, 200)}` : ""
        }`,
      );
    }
  }
  return errorResult(`unknown action "${String(args.action)}"`);
}

// --- security ------------------------------------------------------------------------------

/** A swarm role by role name or agent type, from the project's swarm file. */
function findRole(root: string, name: string): RoleSpec | undefined {
  const loaded = loadSwarmConfig(root);
  if (loaded.state !== "ok") return undefined;
  for (const sw of loaded.config.swarms) {
    const hit = findSwarm(loaded.config, sw.name)?.roles.find(
      (r) => r.role === name || r.agentType === name,
    );
    if (hit) return hit;
  }
  return undefined;
}

/** Explain, plus the security assessment stored beside this decision (when there is one). */
function withSecurityLink(out: string, store: StorageAdapter, row: AdjudicationRow): string {
  try {
    const s = store.security.byAdjudication(row.id);
    if (!s) return out;
    const sec = explainSecurity(viewOfRow(s), {
      surface: s.surface,
      ts: s.ts,
      agentType: s.agentType,
      runId: s.runId,
      taskId: s.taskId,
    });
    return `${out}\n\n${capOutput(sec, 3000)}`;
  } catch {
    return out;
  }
}

/**
 * security: one block per item (the text, or each task) with its level, legs, rules, floors, the
 * grant, the model and the remedy. The heuristic always answers; with security.model "provider"
 * and the adjudicator on, the provider's answer is blended in too (it can only raise a level).
 * Every item is stored as an `mcp` assessment. Advice only.
 */
async function runSecurity(
  args: Args,
  ctx: ProjectContext,
  deps: {
    db?: StorageAdapter;
    provider?: Parameters<typeof adjudicate>[1]["provider"];
    now?: () => number;
  },
): Promise<ToolResult> {
  const cfg = ctx.config.adjudicator;
  const sec = cfg?.security;
  if (!cfg || !sec?.enabled) return text(SECURITY_OFF);
  const items: Array<{ key: string; text: string; role?: string | undefined }> = [];
  if (args.text?.trim()) items.push({ key: "text", text: args.text, role: args.role });
  for (const t of args.tasks ?? [])
    items.push({
      key: t.key,
      text: [t.title, t.detail ?? ""].join("\n").trim(),
      role: t.role ?? args.role,
    });
  if (!items.length) return errorResult("security needs text or tasks:[{key, title}]");
  const roles = new Map<string, RoleSpec>();
  for (const name of new Set(items.map((i) => i.role).filter((r): r is string => !!r))) {
    const r = findRole(ctx.root, name);
    if (!r) return errorResult(`no swarm role "${name}" in the project's swarm file`);
    roles.set(name, r);
  }
  const base = (it: (typeof items)[number], o: Parameters<typeof assessText>[2] = {}) => {
    const r = it.role ? roles.get(it.role) : undefined;
    return assessText(
      sec,
      {
        text: it.text,
        ...(args.tools ? { tools: args.tools } : {}),
        ...(args.agent_type ? { agentType: args.agent_type } : {}),
        ...(r
          ? {
              role: {
                tools: r.tools,
                disallowedTools: r.disallowedTools,
                description: r.description,
              },
            }
          : {}),
        ...(args.autonomy ? { autonomy: args.autonomy } : {}),
      },
      { root: ctx.root, cwd: ctx.root, ...(deps.now ? { now: deps.now } : {}), ...o },
    );
  };
  let assessed = items.map((it) => base(it));
  const store = deps.db ?? getStorage(ctx);
  let rowIds: Array<number | undefined> = [];
  if (sec.model === "provider" && cfg.enabled) {
    try {
      const out = await adjudicate(
        items.map((it, i) => ({
          key: it.key,
          surface: "mcp" as const,
          text: it.text,
          hints: { security: (assessed[i] as (typeof assessed)[number]).hint },
        })),
        {
          config: cfg,
          store: store.adjudicator,
          context: "server",
          call: "inline",
          budgetMs: cfg.timeouts.planMs,
          row: { action: "none" },
          bias: learnedBias(store, cfg),
          projectRoot: ctx.root,
          ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
      );
      rowIds = out.map((a) => a.rowId);
      assessed = items.map((it, i) => {
        const v = out[i]?.verdict;
        const status = planModelStatus(sec, true, {
          security: v?.security,
          provider: v?.provider,
          providerStatus: v?.providerStatus,
        });
        return base(it, {
          answer: v?.security,
          status: v?.security ? undefined : status,
          source: v?.security ? "blend" : "heuristic",
        });
      });
    } catch {
      // the heuristic stands: modelStatus says no answer came
    }
  }
  const blocks = assessed.map((a, i) => {
    const it = items[i] as (typeof items)[number];
    const id = record(store, cfg, {
      surface: "mcp",
      assessed: a,
      text: it.text,
      ...(rowIds[i] !== undefined ? { adjudicationId: rowIds[i] } : {}),
    });
    return mcpBlock(id !== undefined ? { ...a.view, id } : a.view, { label: it.key });
  });
  return text(capOutput(blocks.join("\n"), 8000));
}
