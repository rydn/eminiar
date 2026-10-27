---
name: decision/proactive-recall-in-hooks
kind: decision
tags: [hooks, memory, docs, history, graph, recall]
related: [file:src/session/recall.ts, file:src/hooks/capture.ts, file:src/hooks/routing.ts, file:src/hooks/session-start.ts, file:src/session/brief.ts, file:src/history/model.ts, file:src/server.ts, file:hooks/hooks.json]
created: 2026-10-15T17:01:57.400Z
updated: 2026-10-26T19:51:14.056Z
---

Project knowledge is pushed to Claude by hooks, not only pulled via em_* tools (branch feature/docs-memory-recall, v0.5.0, 2026-10-15). `src/session/recall.ts` powers every path:
- UserPromptSubmit: up to 3 memories + 2 docs pages matching the prompt ("eminiar recall").
- PreToolUse Read/Edit/MultiEdit/Write: memories whose `related` names the file or a symbol in it, whose body names the path, or that name one of its symbols ("eminiar memory"; widened in v0.9.0, see mem:decision/knowledge-routing-and-recall-tuning); the fix record of bug-prone files on reads and edits ("eminiar history"); on edits, when 5 or more other files import or use it, their count ("eminiar graph: X is imported by N files"; distinct dependent files via graphDependentFileCounts, not the metrics fan-in, which also counts calls inside the file and quoted e.g. 89 for routing.ts against 8 real dependents; fix re-applied from 5ecafdd on fix/validation-findings).
- PreToolUse Bash `git commit`: bug-prone / widely imported files among `git diff --cached` (+ tracked changes with -a).
- PostToolUseFailure (made synchronous; async hook output only arrives next turn): earlier occurrences of the error with the `error_resolution` recorded after them in that session, plus memories.
- PreToolUse WebSearch/WebFetch: indexed doc pages covering the query ("eminiar docs").
- Agent/Task briefs: recall for the subagent's task.
All knowledge pushes run in every routing mode, including off.

Why these rules: hooks open storage with vectors:false and never run git log, so recall is lexical FTS and history comes from the `history_files` meta table that buildHistory persists (top 300 files with fixes) and the server warm-up rebuilds when HEAD moves (`refreshHistorySummary`, traceBudget 40). Relevance is gated on rerank's `matched` terms: >= 2 for prompts (3 for long ones), max(3, 40%) for errors, whose text is wordy. Onboarding memories are excluded from prompt and file recall (they match / link everything; the brief carries them), superseded/deprecated always. Each item is shown once per context window (`recall` events, reset at the latest `session_start`) and again after `recall.repeatAfter` prompts (v0.9.0). The matched-term bar is counted with word-start matches, and one term that names the memory (slug word or tag) is enough for a short prompt (v0.9.0). Config: `recall.{onPrompt,onFile,onAgent,onCommit,onError,onWeb,maxMemories,maxDocs,repeatAfter}`.
