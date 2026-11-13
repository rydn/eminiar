---
name: decision/recall-index-v12-background-backfill
kind: decision
tags: [recall, schema, migration, hooks, performance]
related: [file:src/storage/sqlite/schema.ts, file:src/storage/sqlite/adapter.ts, file:src/index/indexer.ts, file:src/server.ts, file:src/cli.ts]
created: 2026-11-12T08:12:03.757Z
updated: 2026-11-12T08:12:03.757Z
---

Recall index (recall_fts) schema numbering and backfill (swarm run 20261111-ffa38b, tasks #298-#300, 2026-11-12, worktree eminiar-ups-timeout).
- The migration is v12, not v10: a jev-integrations dev build already put real DBs at 10 (decision_calls, decision_cache), and run_book puts playbooks at 11. Never reuse 10, 11 or 12.
- ensureRecallIndex (schema.ts) is idempotent (IF NOT EXISTS) and runs both as the v12 migration and as a heal at EVERY open, whatever schema_version says. It checks the table, its 3 triggers (chunks_recall_ai/ad/au) and the persistent FTS5 secure-delete. A partial state is dropped and recreated empty. A heal-only open waits 250 ms for the lock and fails open on SQLITE_BUSY.
- NO hook ever backfills. Opening only creates the empty index; if chunks exist, meta recall_fts_backfill_after='0' (cursor = last document id done, and not-ready flag). recallSearch returns [] while the key exists and never falls back to the whole-index query. The MCP server runs indexer.backfillRecallIndex in the background (its own 500 ms unref'd timer), and so does `eminiar reindex`: slices of at most 500 rows or 25 ms, IMMEDIATE, 40 ms lock wait, 40 ms gap, resumable. A slice inserts only chunks not already in recall_fts (read, then insert), and the triggers cover changes mid-backfill. Measured on the 1.38 GB Spendl clone: open 1.3-6 ms (was 3.3 s), max slice hold 24 ms, whole fill about 0.6 s warm.
- recall_fts keeps FTS5 secure-delete ON persistently (stored in recall_fts_config), so trigger deletes from older eminiar versions also erase tokens. purgeDocumentsBySource never resets it to 0.
- purge(index/sessions/memories) and remaskMergeStep skip recall_fts when the table is missing.
