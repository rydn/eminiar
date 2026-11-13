---
name: decision/recall-fill-from-quiet-hooks
kind: decision
tags: [recall, hooks, backfill, upgrade]
related: [file:src/hooks/index.ts, file:src/index/indexer.ts, file:src/session/recall-explain.ts, file:src/doctor.ts, file:docs/troubleshooting.md, file:tests/unit/recall-index.test.ts]
created: 2026-11-12T08:53:44.896Z
updated: 2026-11-12T08:53:44.896Z
---

The recall index (recall_fts) fill is also advanced by hooks nobody waits on (swarm run 20261111-ffa38b, task #304, 2026-11-12). Why: only the MCP server (server.ts) and `eminiar reindex` ran backfillRecallIndex, so recall stayed [] forever on DBs no new-version server opens: an in-place `eminiar upgrade` (running sessions keep the old server build), hooks-only/CLI use, Cursor without em-server.

How: src/hooks/index.ts wraps Stop, SessionEnd, PreCompact and SubagentStop handlers (thenFillRecall). After the handler's own work it calls fillRecallIndexBriefly (src/index/indexer.ts). The budget is RECALL_FILL_BUDGET_MS=300 total, and the fill runs only while hasBudget(1000). Slices are the same adapter.recallBackfillStep (<=500 rows, hold 25 ms, 40 ms lock wait), REMASK_GAP_MS (40) apart. The next slice starts only if elapsed + gap + max(longest slice, 50 ms) fits the budget. A busy DB ends it with no retry. Any error is logged to hook.log and fails open. The pre-check is one meta read (recallIndexFilling), so a complete index costs no lock. UserPromptSubmit, PreToolUse, PostToolUse and PostToolUseFailure must NEVER run the fill.

Diagnostics: while the meta key recall_fts_backfill_after exists, `eminiar recall --explain` and `--replay`, `eminiar doctor` and em_doctor print "recall index still filling (after document N)" with the remedy: the server, the quiet hooks, `eminiar reindex`, or /mcp reconnect after an upgrade. They no longer say "none share a term". The text comes from recallFillingText in src/session/recall-explain.ts. The doctor check "recall index" is ok:true (it is transient). docs/troubleshooting.md covers both scenarios.
