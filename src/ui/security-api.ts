/**
 * Dashboard API for the security panel of the Adjudicator tab (docs/design/adjudicator-security.md
 * §13). adjudicatorRoute delegates every /api/adjudicator/security* path here.
 *
 *   GET  /api/adjudicator/security             the window's report (totals, rules, model effect, recent, worst)
 *   GET  /api/adjudicator/security/assessment  one stored assessment in full (?id=)
 *   POST /api/adjudicator/security/test        try-it: the heuristic assessment of a text; never stored
 *
 * The gate is the first thing every route does, as in the Jev impact route: with
 * adjudicator.security.enabled off the answer is {active:false} and neither the database nor the
 * request body has been touched. These routes do not need adjudicator.enabled (security works
 * alone) and never reconcile or call a provider. Payloads hold counts, ids, tags, reason codes and
 * the stored 80-char redacted head; the try-it response does not echo its text. The server has
 * already checked the loopback origin and the JSON content type of the POST.
 */

import { explain } from "../adjudicator/security/advice.js";
import { assessText, type TextInput } from "../adjudicator/security/assess.js";
import {
  assessmentPayload,
  type SecurityAssessmentPayload,
  type SecurityInactive,
  type SecurityReport,
  type SecurityTryItPayload,
  securityReport,
} from "../adjudicator/security/report.js";
import { AUTONOMIES, type Autonomy } from "../adjudicator/security/types.js";
import { type Config, loadConfig } from "../config.js";
import type { ProjectContext } from "../context.js";
import { getStorage } from "../storage/index.js";
import { parseSince } from "../tools/em_usage.js";
import type { AdjudicatorRouteDeps } from "./adjudicator-api.js";
import type { Reply } from "./swarm-api.js";

/** The overview's window when no `since` is given (the same as the Adjudicator tab's). */
const DEFAULT_SINCE = "30d";
/** Longest try-it text; the signals only read what they need of it. */
export const SECURITY_TEXT_MAX = 20_000;
const TOOLS_MAX = 64;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const AGENT_TYPE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const UNAVAILABLE = "the adjudication database is unavailable (busy or missing); try again";

export type SecurityReportResponse = SecurityReport | SecurityInactive;
export type SecurityAssessmentResponse = SecurityAssessmentPayload | SecurityInactive;
export type SecurityTryItResponse = SecurityTryItPayload | SecurityInactive;

const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });

/** The security section when it is on, else the {active:false} answer. Reads the config only. */
function gate(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps,
  now: number,
): { config: Config; reply?: undefined } | { reply: Reply } {
  const config = deps.config ?? loadConfig(ctx.root);
  if (!config.adjudicator.security.enabled) {
    const off: SecurityInactive = { active: false, reason: "disabled", now };
    return { reply: ok(off) };
  }
  return { config };
}

function sinceOf(q: URLSearchParams, now: number): { value?: number | undefined; error?: Reply } {
  const raw = q.get("since");
  try {
    if (raw === null || raw.trim() === "") return { value: parseSince(DEFAULT_SINCE, now) };
    if (raw === "all") return { value: undefined };
    return { value: parseSince(raw, now) };
  } catch (err) {
    return { error: fail(400, (err as Error).message) };
  }
}

// --- GET /api/adjudicator/security -------------------------------------------------------

export function securityPayload(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps = {},
  since?: number,
): Reply {
  const now = (deps.now ?? Date.now)();
  const g = gate(ctx, deps, now);
  if (g.reply) return g.reply;
  try {
    const db = deps.db ?? getStorage(ctx);
    return ok(securityReport(db, g.config.adjudicator, { since, now }));
  } catch {
    return fail(503, UNAVAILABLE);
  }
}

// --- GET /api/adjudicator/security/assessment --------------------------------------------

export function assessmentRoutePayload(
  ctx: ProjectContext,
  deps: AdjudicatorRouteDeps,
  id: number,
): Reply {
  const now = (deps.now ?? Date.now)();
  const g = gate(ctx, deps, now);
  if (g.reply) return g.reply;
  try {
    const db = deps.db ?? getStorage(ctx);
    const row = db.security.get(id);
    if (!row) return fail(404, `assessment ${id} not found`);
    return ok(assessmentPayload(row, now));
  } catch {
    return fail(503, UNAVAILABLE);
  }
}

// --- POST /api/adjudicator/security/test -------------------------------------------------

type Parsed<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function names(v: unknown, key: string): Parsed<string[] | undefined> {
  if (v === undefined) return { value: undefined };
  if (
    !Array.isArray(v) ||
    v.length > TOOLS_MAX ||
    v.some((x) => typeof x !== "string" || !x.trim() || x.length > NAME_MAX)
  )
    return { error: `${key} must be a list of at most ${TOOLS_MAX} tool names` };
  return { value: v as string[] };
}

/** The checked try-it input, or a message. */
export function parseTryIt(body: Record<string, unknown>): Parsed<TextInput> {
  const text = body.text;
  if (typeof text !== "string" || !text.trim()) return { error: "text required" };
  if (text.length > SECURITY_TEXT_MAX)
    return { error: `text is longer than ${SECURITY_TEXT_MAX} characters` };
  const out: TextInput = { text };
  const tools = names(body.tools, "tools");
  if (tools.error) return { error: tools.error };
  if (tools.value) out.tools = tools.value;
  const taint = names(body.taint, "taint");
  if (taint.error) return { error: taint.error };
  if (taint.value) out.taint = taint.value;
  if (body.agentType !== undefined) {
    if (typeof body.agentType !== "string" || !AGENT_TYPE.test(body.agentType))
      return { error: "agentType must be an agent name" };
    out.agentType = body.agentType;
  }
  if (body.role !== undefined) {
    if (!isObj(body.role)) return { error: "role must be an object" };
    const rt = names(body.role.tools, "role.tools");
    if (rt.error) return { error: rt.error };
    const rd = names(body.role.disallowedTools, "role.disallowedTools");
    if (rd.error) return { error: rd.error };
    const desc = body.role.description;
    if (desc !== undefined && (typeof desc !== "string" || desc.length > DESCRIPTION_MAX))
      return {
        error: `role.description must be a string of at most ${DESCRIPTION_MAX} characters`,
      };
    out.role = { tools: rt.value, disallowedTools: rd.value, description: desc };
  }
  if (body.autonomy !== undefined) {
    if (!(AUTONOMIES as readonly unknown[]).includes(body.autonomy))
      return { error: `autonomy must be one of ${AUTONOMIES.join(", ")}` };
    out.autonomy = body.autonomy as Autonomy;
  }
  return { value: out };
}

/**
 * The heuristic assessment of a text for the tools, role or agent type the form names. Nothing is
 * stored, no provider is asked and no session history is read.
 */
export function tryItPayload(
  ctx: ProjectContext,
  body: Record<string, unknown>,
  deps: AdjudicatorRouteDeps = {},
): Reply {
  const now = (deps.now ?? Date.now)();
  const g = gate(ctx, deps, now);
  if (g.reply) return g.reply;
  const input = parseTryIt(body);
  if (input.error !== undefined) return fail(400, input.error);
  try {
    const a = assessText(g.config.adjudicator.security, input.value, {
      root: ctx.root,
      ...(deps.env ? { env: deps.env } : {}),
      now: () => now,
    });
    const payload: SecurityTryItPayload = {
      active: true,
      view: a.view,
      badge: a.view.detail.badge,
      text: explain(a.view),
      persisted: false,
      chars: input.value.text.length,
      now,
    };
    return ok(payload);
  } catch {
    return fail(500, "the assessment failed");
  }
}

// --- routing ----------------------------------------------------------------------------

/**
 * Route `/api/adjudicator/security` and `/api/adjudicator/security/*`. Method first (a 405 is not
 * a read), then the gate, then validation and the database.
 */
export async function securityRoute(
  ctx: ProjectContext,
  req: {
    path: string;
    method: string;
    query: URLSearchParams;
    body: () => Promise<unknown>;
  },
  deps: AdjudicatorRouteDeps = {},
): Promise<Reply> {
  const { path, method, query } = req;
  const isGet = method === "GET" || method === "HEAD";
  const now = (deps.now ?? Date.now)();

  if (path === "/api/adjudicator/security") {
    if (!isGet) return fail(405, "GET only");
    const g = gate(ctx, deps, now);
    if (g.reply) return g.reply;
    const since = sinceOf(query, now);
    if (since.error) return since.error;
    return securityPayload(ctx, { ...deps, config: g.config }, since.value);
  }
  if (path === "/api/adjudicator/security/assessment") {
    if (!isGet) return fail(405, "GET only");
    const g = gate(ctx, deps, now);
    if (g.reply) return g.reply;
    const raw = query.get("id") ?? "";
    if (!/^\d{1,15}$/.test(raw) || Number(raw) < 1) return fail(400, "id must be an assessment id");
    return assessmentRoutePayload(ctx, { ...deps, config: g.config }, Number(raw));
  }
  if (path === "/api/adjudicator/security/test") {
    if (method !== "POST") return fail(405, "POST only");
    const g = gate(ctx, deps, now);
    if (g.reply) return g.reply;
    let body: unknown;
    try {
      body = await req.body();
    } catch {
      return fail(400, "invalid JSON body");
    }
    if (!isObj(body)) return fail(400, "body must be a JSON object");
    return tryItPayload(ctx, body, { ...deps, config: g.config });
  }
  return fail(404, "not found");
}
