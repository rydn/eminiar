---
name: security/remask-bounded-lock
kind: decision
tags: [security, remask, sqlite, locking, performance]
related: [file:src/storage/sqlite/adapter.ts, file:src/index/indexer.ts, file:tests/unit/stored-output.test.ts]
created: 2026-11-09T22:22:57.152Z
updated: 2026-11-09T22:22:57.152Z
---

The remask of captured output (remaskDocuments / remaskCapturedOutput, PR #55 branch fix/remask-older-output, swarm task #69, 2026-11-10) works like this. It reads and masks documents ahead with no lock held, then writes them in IMMEDIATE transactions of 30 ms at most (lock wait 40 ms). A busy lock throws SQLITE_BUSY, which the caller retries after 50 ms, doubling up to 2 s, for 40 tries. It pauses 40 ms after each slice that wrote. Each write is a compare-and-set against the masked-from text. A large document's chunks are written last first. Old FTS tokens are removed by FTS5 'merge' -16 steps in 30 ms transactions once the run ends; the remask_fts_optimize mark is set in the first rewrite transaction. PRAGMA secure_delete is on for all of it. Rejected: FTS5 secure-delete (what purge uses). It does its work at COMMIT, 54-192 ms for one chunk on a 1.4 GB index, so the hold cannot be bounded. Also rejected: a deferred per-document transaction, which died with SQLITE_BUSY_SNAPSHOT when a hook committed. Also rejected: one final 'optimize', which held the lock 9.9 s. On 1.4 GB the vec0 delete of one chunk costs ~30 ms. The 'merge' -64 steps sometimes took 70-190 ms, hence -16. Benchmarks on the 1.44 GB synthetic db: 106 s before vs 75 s after; longest lock hold 9.9 s before vs 83 ms after (external 1 ms poller).
