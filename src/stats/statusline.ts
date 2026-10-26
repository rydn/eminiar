import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getContext } from "../context.js";
import { paths } from "../paths.js";
import { getStorage } from "../storage/index.js";
import type { StatuslineSnapshotInput } from "../storage/types.js";
import { formatUsd } from "../usage/pricing.js";
import { globalDb } from "./global.js";
import { fmtTokens, summarize } from "./record.js";

interface RateLimit {
  used_percentage?: number;
  resets_at?: number | string;
}

/** The Claude Code statusline JSON (stdin of `eminiar statusline`); every field optional. */
export interface StatuslineInput {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { id?: string; display_name?: string };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  prompt_cache?: { warm?: boolean; caching_observed?: boolean; ttl?: string; expires_at?: string };
  rate_limits?: { five_hour?: RateLimit; seven_day?: RateLimit };
}

const CACHE_TTL_MS = 5000;
/** The 7-day segment only appears once the week is half used. */
const SEVEN_DAY_SHOW_PCT = 50;

const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
const cents = (n: number | null): number | null => (n == null ? null : Math.round(n * 100));

/** resets_at as epoch ms: ISO string, epoch seconds or epoch ms. */
function epochMs(v: number | string | undefined): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Cache key: the session plus every figure that changes the rendered line. */
function cacheKey(input: StatuslineInput): string {
  return [
    input.session_id ?? "",
    cents(fin(input.cost?.total_cost_usd)) ?? "",
    fin(input.context_window?.used_percentage) ?? "",
    fin(input.rate_limits?.five_hour?.used_percentage) ?? "",
    fin(input.rate_limits?.seven_day?.used_percentage) ?? "",
  ].join("|");
}

/** `$0.88 · ctx 42% · 5h 31%` for whichever figures the input carries. */
export function usageSegments(input: StatuslineInput): string[] {
  const out: string[] = [];
  const cost = fin(input.cost?.total_cost_usd);
  if (cost != null) out.push(formatUsd(cost));
  const ctx = fin(input.context_window?.used_percentage);
  if (ctx != null) out.push(`ctx ${Math.round(ctx)}%`);
  const five = fin(input.rate_limits?.five_hour?.used_percentage);
  if (five != null) out.push(`5h ${Math.round(five)}%`);
  const seven = fin(input.rate_limits?.seven_day?.used_percentage);
  if (seven != null && seven >= SEVEN_DAY_SHOW_PCT) out.push(`7d ${Math.round(seven)}%`);
  return out;
}

function snapshotOf(
  input: StatuslineInput,
  sessionId: string,
  ts: number,
): StatuslineSnapshotInput {
  const cw = input.context_window;
  return {
    session_id: sessionId,
    ts,
    model_id: input.model?.id ?? null,
    cost_usd: fin(input.cost?.total_cost_usd),
    api_ms: fin(input.cost?.total_api_duration_ms),
    duration_ms: fin(input.cost?.total_duration_ms),
    ctx_input_tokens: fin(cw?.current_usage?.input_tokens) ?? fin(cw?.total_input_tokens),
    ctx_output_tokens: fin(cw?.current_usage?.output_tokens) ?? fin(cw?.total_output_tokens),
    ctx_size: fin(cw?.context_window_size),
    ctx_used_pct: fin(cw?.used_percentage),
    cache_warm: input.prompt_cache?.warm == null ? null : input.prompt_cache.warm ? 1 : 0,
    cache_ttl: input.prompt_cache?.ttl ?? null,
    five_hour_pct: fin(input.rate_limits?.five_hour?.used_percentage),
    five_hour_resets_at: epochMs(input.rate_limits?.five_hour?.resets_at),
    seven_day_pct: fin(input.rate_limits?.seven_day?.used_percentage),
    seven_day_resets_at: epochMs(input.rate_limits?.seven_day?.resets_at),
    lines_added: fin(input.cost?.total_lines_added),
    lines_removed: fin(input.cost?.total_lines_removed),
  };
}

/**
 * Claude Code statusline command: reads its JSON on stdin and prints one line.
 * Cached for 5 s (keyed on the session and the figures shown) because the
 * statusline is re-rendered often.
 */
export function renderStatusline(raw: string): string {
  let input: StatuslineInput = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as StatuslineInput) : {};
  } catch {
    // fall through with defaults
  }
  const key = cacheKey(input);
  const cache = paths().statuslineCache;
  try {
    if (existsSync(cache)) {
      const c = JSON.parse(readFileSync(cache, "utf8")) as {
        at: number;
        line: string;
        key: string;
      };
      if (Date.now() - c.at < CACHE_TTL_MS && c.key === key) return c.line;
    }
  } catch {
    // ignore cache errors
  }
  let line: string;
  try {
    const ctx = getContext(input.cwd ?? input.workspace?.current_dir);
    const db = getStorage(ctx, { vectors: false });
    const session = summarize(db.statsBySession(input.session_id ?? ""));
    const life = summarize(globalDb().lifetime());
    const pct = session.rawTokens
      ? Math.round(session.efficiency * 100)
      : life.rawTokens
        ? Math.round(life.efficiency * 100)
        : 0;
    line = `eminiar · ${fmtTokens(session.savedTokens)} saved · ${fmtTokens(life.savedTokens)} lifetime · ${pct}% efficient`;
    const usage = ctx.config.usage;
    if (usage.enabled && usage.statusline) {
      const segments = usageSegments(input);
      if (segments.length) line += ` · ${segments.join(" · ")}`;
      // The snapshot history is the durable record of cost / context / plan use; one row per
      // change, never on every render.
      try {
        if (input.session_id && segments.length) {
          const snap = snapshotOf(input, input.session_id, Date.now());
          const last = db.statuslineLatest(input.session_id);
          const changed =
            !last ||
            cents(last.cost_usd) !== cents(snap.cost_usd) ||
            last.ctx_used_pct !== snap.ctx_used_pct ||
            last.five_hour_pct !== snap.five_hour_pct;
          if (changed) db.statuslineSnapshotInsert(snap);
        }
      } catch {
        // the snapshot is bookkeeping; the line still renders
      }
    }
  } catch (err) {
    line = `eminiar · unavailable (${(err as Error).message.slice(0, 40)})`;
  }
  try {
    writeFileSync(cache, JSON.stringify({ at: Date.now(), line, key }));
  } catch {
    // cache is best effort
  }
  return line;
}
