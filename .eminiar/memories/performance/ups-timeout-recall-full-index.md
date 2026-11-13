---
name: performance/ups-timeout-recall-full-index
kind: fact
tags: [hooks, performance, recall, fts5, timeout, userpromptsubmit]
related: [file:src/hooks/capture.ts, file:src/session/recall.ts, file:src/search/pipeline.ts, file:src/storage/sqlite/adapter.ts, file:src/project.ts, file:src/context.ts, file:src/hooks/dispatch.ts, file:src/hooks/budget.ts]
created: 2026-11-11T21:22:58.126Z
updated: 2026-11-11T21:22:58.126Z
---

Root cause of `UserPromptSubmit hook timed out after 5s` in 0.13.4+ / 0.14.x (task #276, swarm run 20261111-ffa38b, 2026-11-11). The cause is proactive recall in userPromptSubmit (src/hooks/capture.ts:138). recallForText (src/session/recall.ts:331, :378) runs 8 synchronous FTS5 queries: porter and trigram, AND then OR of up to 16 prompt terms, for the memory search and the docs search (src/search/pipeline.ts lexical). Each query scans the WHOLE chunk index. ftsSearch (src/storage/sqlite/adapter.ts:781) applies the source filter as a JOIN after MATCH and bm25, so the cost grows with all captured code, exec and session output, not with the memories and docs.

Spendl umbrella DB (1.32 GB, 134,774 chunks, 579 MB trigram index):
- recall takes 4.2-13.9 s with a cold page cache (one query up to 3.7 s) and about 0.5 s warm
- the whole hook takes 14-15 s cold in 0.13.1 and 0.14.6 alike

eminiar DB (212 MB): recall 0.63 s cold, 0.08 s warm.

The dispatch deadline (3.5 s, a Promise.race timer started after node boot) cannot interrupt synchronous better-sqlite3. A 14.7 s run therefore logs nothing, which matches the real ~/.eminiar/hook.log: 0 "hook budget … exceeded" lines ever.

Release attribution: b7012be (v0.13.4, sessionRoot: CLAUDE_PROJECT_DIR before the payload cwd) made cd'ed multi-repo sessions and worktree workers recall from the umbrella DB. Example: a Spendl session cd'ed into spendl-money-itt took 0.9-1.2 s cold on 0.13.1/0.13.2 (itt DB, 272 MB) and 3.9-14 s cold on 0.13.4..0.14.6 (umbrella DB).

The UPS code path itself did not regress from 0.13.1 to 0.14.7. Measured on the eminiar DB:
- alone: about 111 ms
- 12 concurrent: about 0.4 s
- under an 8 s held write lock: about 1.35 s

Host conditions at the time: swap 14.4 of 15.4 GB used and fseventsd at 1.9 GB RSS, so FTS pages get evicted within minutes.

Repro scripts are in that session's scratchpad (cdab.py, cold.py, recallprof.mts).
