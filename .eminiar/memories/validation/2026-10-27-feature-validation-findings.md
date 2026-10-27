---
name: validation/2026-10-27-feature-validation-findings
kind: note
tags: [validation, fixes, usage, history, search, sandbox]
related: [file:src/storage/sqlite/schema.ts, file:src/storage/sqlite/adapter.ts, file:src/session/recall.ts, file:src/hooks/routing.ts, file:src/tools/em_batch_execute.ts, file:src/tools/em_docs.ts, file:src/sandbox/languages.ts, file:src/chunker/markdown.ts, file:src/index/indexer.ts, file:src/tools/em_search.ts]
created: 2026-10-26T22:24:15.520Z
updated: 2026-10-26T22:45:29.493Z
---

Feature validation run on main at c92abca (v0.10.0, 2026-10-27): build, typecheck, lint and all tests passed and every em_* tool, the CLI, the hook events and the dashboard API were exercised live. Seven defects were found and all fixed on branch fix/validation-findings (v0.10.1), with an adversarial review pass before commit:
1. `eminiar usage ingest` failed on databases created before the final usage-insights build (`transcript_files` lacked `head_hash`; migration v5 had been edited in place). Fixed by migration v6 (`hasColumn` + ALTER TABLE, idempotent for every v5 shape); `Migration` entries may now carry `sql` and/or `up(db)`. Lesson: never edit a shipped migration; add a new one. Hook/em_stats ingest failures are now logged once to ~/.eminiar/hook.log and shown in em_stats; `eminiar usage` failures print the error plus a doctor hint instead of the full doctor report.
2. PR #16 (5ecafdd) had been merged into feature/docs-memory-recall after that branch was already in main, so main never got it. Re-applied: `StorageAdapter.graphDependentFileCounts` (distinct other files importing a file or using its symbols) feeds the "imported by N files" edit note and the commit note instead of the inflated metrics fan-in; `VISUAL_EXT` keeps Read of large images/PDFs out of routing. Lesson: check `git merge-base --is-ancestor` for fix commits that only live on feature branches.
3. `SqliteAdapter.vecSearch` with filters now constrains the vec0 KNN with `chunk_id IN (SELECT …)` (sqlite-vec 0.1.9 accepts it; `rowid IN` does not) and falls back to widening k*4, k*16 … up to the vector count if a build rejects the constraint. Separately, `docs.embed` defaults to false so docs:* pages have no vectors at all; em_search now says so for an empty semantic result over docs sources.
4. em_batch_execute inlines outputs up to sandbox.indexThreshold (5 KB) when no queries/intent are given, smallest first within max_tokens*4 chars; with queries the 1 KB cap stays; elided outputs name `em_search {document_ids:[N]}`.
5. em_docs list reports orphaned docs:* sources (indexed pages without a manifest entry), remove can drop them, lookup flags hits from them, and the SessionStart brief mentions them.
6. The javascript/typescript sandbox prepends a one-line createRequire preamble when a snippet uses `require(` (anchored on EMINIAR_PROJECT_ROOT/package.json so bare packages resolve from the project; placed after a shebang; skipped when the snippet declares `require` or uses createRequire).
7. Heading-only markdown yields a chunk with the heading text (unless the heading is the parent of the next section), and the indexer stores content as one chunk when a chunker returns nothing, reporting it in the em_index result.
Also biome.json migrated to Biome 2.5.15 (`preset: "recommended"`). Leftovers from the validation run: graph concept node concept:validation-probe-2026-10-27 (no delete tool exists), index docs with source "probe", skills/ indexed under source "file".
