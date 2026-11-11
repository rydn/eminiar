---
name: playbooks/design-and-scope
kind: decision
tags: [playbooks, design, scope]
related: [file:src/playbooks/store.ts, file:src/tools/em_playbook.ts, file:src/playbooks/extract.ts, file:src/playbooks/export.ts, mem:playbooks/config-gate-rule, mem:security/stored-data-privacy]
created: 2026-11-11T22:10:00.000Z
updated: 2026-11-11T22:40:00.000Z
---

Playbooks (swarm run 20261111-e068a8, branch feature/run_book, 2026-11-11, release 0.15.0). A playbook is a stored recurring task (name, title, prompt, parameters, optional schedule hint, tags, private flag) that eminiar lists and hands to Claude to run: check Slack for PRs and review them, check Datadog or Kubernetes for issues.

Decisions the user made (do not re-litigate):
- Name: Playbooks. "Skills" clashes with Claude Code Skills and the `skill` capture category, "routines" is Claude's cloud scheduler, "scheduled tasks" is Desktop and /loop.
- Scope: eminiar does NOT schedule or run playbooks, and has no `claude -p` runner or OS timer. The user: "we are not building a harness that schedules and runs tasks, we are creating an interface to ease running recurring tasks". A schedule is a plain hint; `em_playbook schedule` returns text that tells Claude to start a /loop or cron job. Run history is the rows eminiar records when a playbook is run through it (`run`, then `report`).
- Viewing, adding and running by hand are on by default. Extraction of candidates from session history is opt-in (`playbooks.extraction.enabled`), runs only on demand (never in a hook), and nothing becomes a playbook without an explicit accept.
- Delivery: parent branch feature/run_book, one sub-branch per task named feature/run_book-<task>, each built in its own git worktree, merged back into feature/run_book.

Storage: definitions are markdown with frontmatter in .eminiar/playbooks/*.md (committed); a private playbook goes to .eminiar/playbooks-private/ (0700/0600, verified gitignored through `git check-ignore`). Runs and suggestions live in the project SQLite db (schema migration v11: playbooks mirror, playbook_runs, playbook_suggestions); purging sessions deletes runs and suggestions, purging memories drops the mirror and keeps the files.

Migration number (task #266, review2 H1, branch feature/run_book-r2-migration): playbooks first took v10, which feature/jev-integrations had already given to decision_calls (mem:security/stored-data-privacy), and real project databases are at schema_version 10 from jev with no playbook tables. The runner (SqliteAdapter.migrate) applies only versions above meta.schema_version, so those databases skipped the playbook DDL: `eminiar playbook list` failed and purge sessions/memories/all threw "no such table". Fix: (1) the playbook DDL is migration v11, the next free version after main (9) and jev-integrations (10), all IF NOT EXISTS (schema.ts PLAYBOOKS_SQL); (2) healPlaybookTables runs at every adapter open after the migrations and creates the three tables and their indexes whenever any is missing, whatever schema_version says (one sqlite_master count, about 19 µs on the real 200 MB db; hook p50 unchanged against a build without it; fail open on a busy db); (3) purge skips playbook tables that do not exist. tests/unit/schema-migrations.test.ts fails on duplicate or non-increasing versions; tests/unit/playbooks-runs.test.ts covers the jev-shaped db, a db at v11+ without the tables, reopen as a no-op and purge without the tables.

Landing order: playbooks (v11) lands first, so jev's v10 would be skipped on every database already at 11. Version 10 is therefore listed in `RESERVED_SCHEMA_VERSIONS` (src/storage/sqlite/schema.ts), and jev lands as the next free version (v12), keeping IF NOT EXISTS so its own development databases at v10 rerun it harmlessly. The guard test "no migration is reserved or numbered below the highest released version" in tests/unit/schema-migrations.test.ts fails on a merge that keeps a v10 entry (or any new entry below the highest of its committed `RELEASED_SCHEMA_VERSIONS`), and its message names the version to renumber to. Append to `RELEASED_SCHEMA_VERSIONS` whenever a release ships a new migration. The heal step covers databases that ran another branch's number; it waits at most 25 ms for the write lock (`HEAL_LOCK_WAIT_MS`) and otherwise skips until the next open. Never resolve a merge by keeping two entries with one number.

Not built: an LLM refiner for suggestion titles (the adjudicator provider/consent plumbing would be reused; off by default), automatic parameter extraction (events carry no tool arguments), and a Claude Code skill `/em-playbook`.
