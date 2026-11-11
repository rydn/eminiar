---
name: swarm/run-2026-11-11-review-pr-65-branch-fix-review
kind: note
tags: [swarm, review]
related: [src/hooks/routing.ts, src/install/doctor.ts, src/swarm/brief.ts, src/config.ts, src/sandbox/env.ts]
created: 2026-11-11T19:46:23.514Z
updated: 2026-11-11T19:46:23.514Z
---

Swarm run 20261111-05b209 (swarm "review", mesh, 2026-11-11): done.
Goal: Review PR #65 (branch fix/review-followups) for regressions and bugs. The checkout is the git worktree /private/tmp/claude-501/-Users-ryandick-Dev-Projects-eminiar/1aae0709-61a2-40c7-a0c9-87510fc629c8/scratchpad/fu; the change is `git -C <wt> diff origin/main...HEAD`. Read-only review of that worktree, not the project root.
Outcome: Review of PR #65 (review follow-ups). Fixed after review: findAgentFile precedence (project dir fully before user dir), quadratic name regex, FIFO/non-file .md blocking the hook, scan cap before .md filter, repeated scans per spawn, readonly brief memory hint (configured memories.dir, no em_memory in project section, no Read tool), envAllow filter on an untrusted planted personal config, hermetic CLAUDE_CONFIG_DIR in routing tests, tests for doctor --fix wiring, workerBrief readonly, scan bounds. Not acted on: stricter envAllow policy (user decision), cosmetic merged-index in additive-list errors.
4 task(s), 4 worker(s), 9 min.
- #234 [done] (correctness) Correctness: agent lookup by name + spawn prefix — Read-only review of findAgentFile / agentLacksTool / spawn-prefix wiring in src/hooks/routing.ts (PR #65 worktree). 5 confirmed findings posted as finding-correctness-1..5: (1) medium: lookup order (…
- #235 [done] (correctness) Correctness: doctor, upgrade comment, readonly brief — Two confirmed findings in the readonly brief (finding-correctness-1, finding-correctness-2). doctor.ts and the upgrade comment are clean. 1) brief.ts hardcodes ".eminiar/memories", so a custom memori…
- #236 [done] (security) Security: envAllow project-layer filter — The committed eminiar.config.json filter holds. I probed loadConfig and buildEnv with tsx, with ANTHROPIC/CLAUDE/OPENAI/GEMINI keys set, and tried exact names, globs (*, ANTHROPIC_*, *_API_KEY), case…
- #237 [done] (tests) Tests: each change has a failing-without test — Mutation-tested every behaviour change in a scratch copy: 29 mutants, 21 killed. Surviving gaps posted as finding-tests-1 (doctor --fix wiring, workerBrief readonly, findAgentFile bounds, hermeticity…
