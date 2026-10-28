import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.js";

/**
 * Who called em_swarm, as vouched for by eminiar's PreToolUse hook. The hook sees the real
 * `agent_id` / `agent_type` / `session_id` of every tool call; the MCP server does not. So
 * the hook stamps those into the em_swarm input and signs them with a per-machine secret
 * (~/.eminiar/swarm.key, mode 0600). The server only trusts caller fields whose signature
 * checks out: a model cannot pose as a worker or as the coordinator by passing the fields
 * itself, and a call the hook never saw (hook timed out, stale settings matcher, hooks
 * disabled) is "unverified" instead of silently counting as the coordinator.
 */

export type CallerKind = "main" | "agent";

export interface CallerStamp {
  caller_kind: CallerKind;
  caller_agent_id?: string | undefined;
  caller_agent_type?: string | undefined;
  caller_session_id?: string | undefined;
  caller_sig: string;
}

/** Input fields only the hook may set; anything the model passed under these names is dropped. */
export const STAMP_FIELDS = [
  "caller_kind",
  "caller_agent_id",
  "caller_agent_type",
  "caller_session_id",
  "caller_sig",
] as const;

let cached: Buffer | undefined;

function keyFile(): string {
  return join(paths().home, "swarm.key");
}

/** The per-machine signing secret, created on first use. */
export function swarmSecret(): Buffer {
  if (cached) return cached;
  const file = keyFile();
  try {
    const hex = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) {
      cached = Buffer.from(hex, "hex");
      return cached;
    }
  } catch {
    // created below
  }
  const key = randomBytes(32);
  mkdirSync(paths().home, { recursive: true });
  try {
    // `wx`: if another hook process created it a moment ago, use theirs.
    writeFileSync(file, key.toString("hex"), { mode: 0o600, flag: "wx" });
    cached = key;
  } catch {
    cached = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  }
  return cached;
}

/** Test seam: forget the cached secret (EMINIAR_HOME changes between test files). */
export function resetSwarmSecret(): void {
  cached = undefined;
}

function payload(kind: string, agentId?: string, agentType?: string, sessionId?: string): string {
  return JSON.stringify([kind, agentId ?? "", agentType ?? "", sessionId ?? ""]);
}

export function signCaller(c: {
  kind: CallerKind;
  agentId?: string | undefined;
  agentType?: string | undefined;
  sessionId?: string | undefined;
}): CallerStamp {
  const sig = createHmac("sha256", swarmSecret())
    .update(payload(c.kind, c.agentId, c.agentType, c.sessionId))
    .digest("hex");
  return {
    caller_kind: c.kind,
    ...(c.agentId ? { caller_agent_id: c.agentId } : {}),
    ...(c.agentType ? { caller_agent_type: c.agentType } : {}),
    ...(c.sessionId ? { caller_session_id: c.sessionId } : {}),
    caller_sig: sig,
  };
}

export type VerifiedCaller =
  | {
      verified: true;
      kind: CallerKind;
      agentId?: string | undefined;
      agentType?: string | undefined;
      sessionId?: string | undefined;
    }
  | { verified: false; why: string };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** Check the stamp the hook put on an em_swarm call. */
export function verifyCaller(input: Record<string, unknown>): VerifiedCaller {
  const kind = input.caller_kind;
  const sig = str(input.caller_sig);
  if (!sig || (kind !== "main" && kind !== "agent"))
    return { verified: false, why: "the call carries no caller stamp from eminiar's hook" };
  const agentId = str(input.caller_agent_id);
  const agentType = str(input.caller_agent_type);
  const sessionId = str(input.caller_session_id);
  const want = createHmac("sha256", swarmSecret())
    .update(payload(kind, agentId, agentType, sessionId))
    .digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, "hex");
  } catch {
    return { verified: false, why: "the caller stamp is malformed" };
  }
  if (got.length !== want.length || !timingSafeEqual(got, want))
    return { verified: false, why: "the caller stamp does not verify" };
  if (kind === "agent" && !agentId)
    return { verified: false, why: "a subagent stamp without an agent id" };
  return { verified: true, kind, agentId, agentType, sessionId };
}
