import { emArchitecture } from "./em_architecture.js";
import { emBatchExecute } from "./em_batch_execute.js";
import { emDocs } from "./em_docs.js";
import { emDoctor } from "./em_doctor.js";
import { emExecute } from "./em_execute.js";
import { emExecuteFile } from "./em_execute_file.js";
import { emFetchAndIndex } from "./em_fetch_and_index.js";
import { emGraphAdd, emGraphImpact, emGraphQuery, emReindex } from "./em_graph.js";
import { emGraphChanges } from "./em_graph_changes.js";
import { emHistory } from "./em_history.js";
import { emIndex } from "./em_index.js";
import { emIndexStatus } from "./em_index_status.js";
import { emMemory } from "./em_memory.js";
import { emPurge } from "./em_purge.js";
import { emRecall } from "./em_recall.js";
import { emRemember } from "./em_remember.js";
import { emSearch } from "./em_search.js";
import { emStats } from "./em_stats.js";
import { emSwarm } from "./em_swarm.js";
import { emSymbols } from "./em_symbols.js";
import { emUsage } from "./em_usage.js";
import type { ToolDef } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas in one registry
export const tools: ToolDef<any>[] = [
  emExecute,
  emExecuteFile,
  emBatchExecute,
  emSearch,
  emIndex,
  emFetchAndIndex,
  emDocs,
  emRemember,
  emRecall,
  emMemory,
  emSymbols,
  emArchitecture,
  emGraphQuery,
  emGraphImpact,
  emGraphChanges,
  emHistory,
  emSwarm,
  emGraphAdd,
  emReindex,
  emIndexStatus,
  emStats,
  emUsage,
  emPurge,
  emDoctor,
];
