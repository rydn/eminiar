---
name: decision/ups-recall-index-and-deadline
kind: decision
status: proposed
tags: [hooks, recall, fts5, timeout, userpromptsubmit, performance, deadline]
related: [file:src/storage/sqlite/schema.ts, file:src/storage/sqlite/adapter.ts, file:src/search/pipeline.ts, file:src/session/recall.ts, file:src/hooks/capture.ts, file:src/hooks/budget.ts, file:src/hooks/dispatch.ts, file:src/hook.ts, file:bin/em-hook, file:hooks/hooks.json, file:src/install/register.ts, file:src/adjudicator/hooks.ts]
created: 2026-11-11T21:43:15.740Z
updated: 2026-11-11T21:43:15.740Z
---

Fix design for "UserPromptSubmit hook timed out after 5s" (task #278, swarm run 20261111-ffa38b, 2026-11-11). The full design is on blackboard keys ups-design, ups-design-2 and ups-design-3. It has two parts.

(1) Recall index. Prompt-path recall stops scanning the whole chunk index.
- Migration v10 adds recall_fts, a regular FTS5 table with the porter tokenizer and columns title, body and src.
- It holds only the chunks of memories (src 'memory'), docs:* pages (src 'docs') and session documents titled 'error' (src 'error').
- Triggers on chunks keep it in sync. They use built-in SQL only, because an older eminiar on the same DB fires them too. The update trigger fires only on `UPDATE OF title, body`, so markEmbedded skips it.
- The migration backfills the table. migrate() runs IMMEDIATE and re-reads schema_version inside the transaction.
- recallSearch MATCHes `{title body} : (...) AND src : "x"` with no JOIN.
- search() takes `recall: RecallSource`: porter AND then OR, no trigram, no typo correction, no vectors.
- recallForText and recallForError use it.
- UserPromptSubmit skips recall for harness envelopes. The isHarnessEnvelope matcher moves to src/capture/envelope.ts, and adjudicator/hooks.ts re-exports it. Leading system reminders are stripped before terms are taken.
- purge and remask include recall_fts (rebuild, secure-delete, merge).

Measured on a cold 1.38 GB / 134,774-chunk clone:
- today's 8 queries take 8.05 s; recall_fts takes 34 ms
- the backfill takes 1.2-1.6 s once and adds 53 MB

Rejected:
- `rowid IN (...)`: 13 s
- a JOIN source filter: 307 ms cold
- the contentless_delete variant: weaker purge/remask residue guarantees

(2) Hard deadline. hooks.json UserPromptSubmit runs `em-hook --deadline 4` with its timeout kept at 5 s.
- The sh shim runs node in the background with a `sleep` watchdog that kill -9s node at 4 s.
- On a kill the shim exits 0 with EMPTY stdout. A `{}` could follow an answer node had already written. It also appends one line to hook.log.
- Without the flag the shim still execs node, so PreToolUse and the hot path are unchanged.
- Node's soft budget (3.5 s) is measured from process start: performance.now(), with dispatch opts.startedAt = 0 from src/hook.ts.
- isOurHook in src/install/register.ts must accept `<bin> --deadline N`, or a settings-method reinstall duplicates the hook.

Why not a worker thread: Node joins worker threads at process.exit, and a thread inside sqlite3_step cannot be stopped. Measured: exit called at 302 ms, the process ended at 1.75 s. better-sqlite3 has no interrupt. A self-SIGKILL exits non-zero, which Claude Code reports as a hook error. A child process per prompt adds a second node boot. The shim supervisor costs about 1-2 ms per prompt.
