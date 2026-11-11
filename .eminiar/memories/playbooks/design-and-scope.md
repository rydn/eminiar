---
name: playbooks/design-and-scope
kind: decision
tags: [playbooks, design, scope]
related: [file:src/playbooks/store.ts, file:src/tools/em_playbook.ts, file:src/playbooks/extract.ts, file:src/playbooks/export.ts, mem:playbooks/config-gate-rule, mem:security/stored-data-privacy]
created: 2026-11-11T22:10:00.000Z
updated: 2026-11-11T22:10:00.000Z
---

Playbooks (swarm run 20261111-e068a8, branch feature/run_book, 2026-11-11, release 0.15.0). A playbook is a stored recurring task (name, title, prompt, parameters, optional schedule hint, tags, private flag) that eminiar lists and hands to Claude to run: check Slack for PRs and review them, check Datadog or Kubernetes for issues.

Decisions the user made (do not re-litigate):
- Name: Playbooks. "Skills" clashes with Claude Code Skills and the `skill` capture category, "routines" is Claude's cloud scheduler, "scheduled tasks" is Desktop and /loop.
- Scope: eminiar does NOT schedule or run playbooks, and has no `claude -p` runner or OS timer. The user: "we are not building a harness that schedules and runs tasks, we are creating an interface to ease running recurring tasks". A schedule is a plain hint; `em_playbook schedule` returns text that tells Claude to start a /loop or cron job. Run history is the rows eminiar records when a playbook is run through it (`run`, then `report`).
- Viewing, adding and running by hand are on by default. Extraction of candidates from session history is opt-in (`playbooks.extraction.enabled`), runs only on demand (never in a hook), and nothing becomes a playbook without an explicit accept.
- Delivery: parent branch feature/run_book, one sub-branch per task named feature/run_book-<task>, each built in its own git worktree, merged back into feature/run_book.

Storage: definitions are markdown with frontmatter in .eminiar/playbooks/*.md (committed); a private playbook goes to .eminiar/playbooks-private/ (0700/0600, verified gitignored through `git check-ignore`). Runs and suggestions live in the project SQLite db (schema migration v10: playbooks mirror, playbook_runs, playbook_suggestions); purging sessions deletes runs and suggestions, purging memories drops the mirror and keeps the files.

Open: migration v10 clashes with the unmerged branch feature/jev-integrations (its v10 is decision_calls, reserved in mem:security/stored-data-privacy). Playbooks lands first on current main (0.14.4 base), so jev-integrations must renumber to the next free version when it merges.

Not built: an LLM refiner for suggestion titles (the adjudicator provider/consent plumbing would be reused; off by default), automatic parameter extraction (events carry no tool arguments), and a Claude Code skill `/em-playbook`.
