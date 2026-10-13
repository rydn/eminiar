import { emBatchExecute } from "./em_batch_execute.js";
import { emDoctor } from "./em_doctor.js";
import { emExecute } from "./em_execute.js";
import { emExecuteFile } from "./em_execute_file.js";
import { emFetchAndIndex } from "./em_fetch_and_index.js";
import { emGraphAdd, emGraphImpact, emGraphQuery, emReindex } from "./em_graph.js";
import { emIndex } from "./em_index.js";
import { emMemory } from "./em_memory.js";
import { emPurge } from "./em_purge.js";
import { emRecall } from "./em_recall.js";
import { emRemember } from "./em_remember.js";
import { emSearch } from "./em_search.js";
import { emStats } from "./em_stats.js";
import { emSymbols } from "./em_symbols.js";
import type { ToolDef } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous schemas in one registry
export const tools: ToolDef<any>[] = [
  emExecute,
  emExecuteFile,
  emBatchExecute,
  emSearch,
  emIndex,
  emFetchAndIndex,
  emRemember,
  emRecall,
  emMemory,
  emSymbols,
  emGraphQuery,
  emGraphImpact,
  emGraphAdd,
  emReindex,
  emStats,
  emPurge,
  emDoctor,
];
