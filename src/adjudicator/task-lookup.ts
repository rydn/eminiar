/**
 * The swarm task of a worker dispatch, shared by the adjudicator's PreToolUse(Agent) path
 * (hooks.ts) and the security advice (security/hook.ts), which must not load hooks.ts: its
 * imports are the engine and the providers, and security-only mode never wants them.
 *
 * Light on purpose: storage and the swarm hook's coordination root, nothing else.
 */

import { getContext, type ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { coordinationRoot } from "../swarm/hooks.js";
import type { TaskRow } from "../swarm/types.js";

/**
 * The swarm task of a worker dispatch: this project's ledger, else the coordination root's (a
 * worker in a git worktree has its tasks in the main checkout's database). The database it was
 * found in comes back with it: the dispatch's rows belong beside the task.
 */
export function findTask(
  ctx: Pick<ProjectContext, "root">,
  db: StorageAdapter,
  runId: string,
  taskId: number,
): { db: StorageAdapter; task: TaskRow } | undefined {
  const t = db.swarm.taskGet(taskId);
  if (t && t.run_id === runId) return { db, task: t };
  const main = coordinationRoot(ctx.root);
  if (main === ctx.root) return undefined;
  const mdb = getStorage(getContext(main), { vectors: false });
  const m = mdb.swarm.taskGet(taskId);
  return m && m.run_id === runId ? { db: mdb, task: m } : undefined;
}
