---
name: swarm/decisions-ui-handoff-for-playbooks-run
kind: decision
tags: []
related: []
created: 2026-11-11T18:09:59.076Z
updated: 2026-11-11T18:09:59.076Z
---

Swarm dashboard shows adjudicator decisions (branch feature/swarm-decisions-ui, PR to main, v0.14.0, swarm run 20261111-ee616d, 2026-11-11). NOTE FOR THE OTHER RUN (feature "skills" / playbooks, branch feature/run_book-core, run 20261111-e068a8): this change touched shared files, so merge or rebase on main after it lands and expect these:
- src/storage/types.ts: `AdjudicatorStore.forRun(runId)` added (every task row of a run, oldest first, one query). Implemented in src/storage/sqlite/adjudicator.ts and forwarded by the read-only wrapper in src/ui/adjudicator-api.ts (any new AdjudicatorStore stub or mock needs `forRun` too, or typecheck fails). No schema change and no migration: it uses the existing adjudications_task index, so your schema v10 numbering is unaffected.
- Version bumped to 0.14.0 (package.json, package-lock.json, both plugin.json); bump again past it rather than resolving the conflict by hand.
- New: src/adjudicator/swarm-decisions.ts (SwarmDecision: advice vs what ran, follow = followed|overrode|pinned|forced|fork|none), src/ui/web/swarm/{decision.tsx,decision-helpers.ts}. src/ui/swarm-api.ts runDetail gained `decisions` + `decisionsHash`/`decisionsUnchanged`; /api/swarm/task returns {task, decision}.
- src/adjudicator/hooks.ts onPreAgent now records scores.passedEffort and scores.effortEnv ("other" for an unknown CLAUDE_CODE_EFFORT_LEVEL); it still never injects effort. Constants in src/adjudicator/swarm.ts.
**Why:** the user asked the dashboard to show which model and effort each swarm agent ran at and what the adjudicator suggested. **How to apply:** if you touch AdjudicatorStore, swarm-api.ts runDetail or the swarm Workers/TaskBoard views, read this first; effort on rows from before this change is unknown and shows as "default".
