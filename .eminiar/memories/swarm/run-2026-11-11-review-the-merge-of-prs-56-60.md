---
name: swarm/run-2026-11-11-review-the-merge-of-prs-56-60
kind: note
tags: [swarm, review]
related: [src/hooks/routing.ts, src/stats/statusline.ts, src/usage/savings.ts, src/tools/em_stats.ts, src/config.ts, src/install/doctor.ts, src/install/install.ts, src/install/upgrade.ts, src/server.ts, src/tools/types.ts, src/swarm/hooks.ts, src/swarm/agents.ts]
created: 2026-11-11T18:53:42.472Z
updated: 2026-11-11T18:53:42.472Z
---

Swarm run 20261111-a535a3 (swarm "review", mesh, 2026-11-11): done.
Goal: Review the merge of PRs #56-#60 (install robustness, docs honesty, config layering, coexist/savings labels, swarm safety) for behavior regressions. The merged result lives in the git worktree /private/tmp/claude-501/-Users-ryandick-Dev-Projects-eminiar/1aae0709-61a2-40c7-a0c9-87510fc629c8/scratchpad/wt (branch feat/swarm-safety, merge of origin/main already contains #56-#59 and #58; diff vs origin/main is #60 plus the merge resolution).
Outcome: Review of the merge of PRs #56-#60 found no regression of existing features: config layering, default swarm agent files (byte-identical), readonly profile, routing gate and savings labels all hold; full suite 3276 tests green, 34 mutations caught. Fixed on #60: em_graph_add destructive, em_adjudicate not idempotent. Open follow-ups: agentLacksTool only finds agents by filename in <root>/.claude/agents (name mismatch, user and plugin agents still dead-end); agentLacksEmTools unused in production; doctor graph.exclude advice stale after additive lists (#58); doctor --fix cannot clear retired code.backend key; upgrade can persist noModel for old records; readonly worker brief points to em_memory; em_stats marked READ_ONLY but ingestSession writes usage rows; pre-existing sandbox.envAllow project-config loosening (security/project-config-layer-followups item 2); missing test cases listed by the tests reviewer.
5 task(s), 5 worker(s), 10 min.
- #185 [done] (correctness) Correctness: hooks routing + coexist/savings (#59, #60 merge) — Reviewed the routing.ts diff vs origin/main (#60) and the #59 merge diff for routing, statusline, savings, record, em_stats and em_usage. Found 2 issues, both posted to the blackboard. finding-correc…
- #186 [done] (correctness) Correctness: config layering + install/doctor (#56, #58 merge) — Read-only review of the merged worktree. Ran 13 loadConfig layer scenarios through tsx (scripts in scratchpad/c186/t1-t3.mts): a bad layer drops only that layer, additive deny/exclude lists, "!" nega…
- #187 [done] (correctness) Correctness: MCP annotations, readonly profile, server (#60) — Read-only review of the wt worktree (diff 1b1fc01..HEAD for #60). Three low findings, no medium or high: finding-correctness-187-1 (the readonly worker brief points at em_memory, which the role lacks…
- #188 [done] (security) Security: readonly profile, config trust, routing gate — No new exploitable issues in the merge (diff 9b7bf9d..bec21c4: config.ts, server.ts/tools/types.ts, swarm/hooks.ts+agents.ts+config.ts, hooks/routing.ts, install/doctor.ts, em_stats/savings). I check…
- #189 [done] (tests) Tests: every changed behaviour has a failing-without test — Full suite green on merged tree (127 files pass, 3276 tests), tsc clean, biome clean, eminiar.config.schema.json in sync with zod (regenerated and compared). 34 scratch-copy mutations on swarm-safety…
