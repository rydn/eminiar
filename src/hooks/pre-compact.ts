import { sessionContext } from "../context.js";
import { renderGuide } from "../session/guide.js";
import { getStorage } from "../storage/index.js";
import type { HookHandler } from "./types.js";

export const SNAPSHOT_BUDGET = 2048;

/**
 * PreCompact cannot inject context; it only has time to persist a snapshot.
 * SessionStart(source=compact) replays it as the Session Guide.
 */
export const preCompact: HookHandler = (input) => {
  const ctx = sessionContext(input.cwd);
  const db = getStorage(ctx, { vectors: false });
  const sessionId = input.session_id || "unknown";
  const body = renderGuide(db, sessionId, SNAPSHOT_BUDGET);
  if (!body) return undefined;
  db.snapshotInsert({ sessionId, trigger: input.trigger ?? "unknown", body });
  return undefined;
};
