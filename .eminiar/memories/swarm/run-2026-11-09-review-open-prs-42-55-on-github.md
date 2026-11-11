---
name: swarm/run-2026-11-09-review-open-prs-42-55-on-github
kind: note
tags: [swarm, review]
related: []
created: 2026-11-09T17:44:56.477Z
updated: 2026-11-09T17:44:56.477Z
---

Swarm run 20261109-827149 (swarm "review", mesh, 2026-11-09): done.
Goal: Review open PRs #42-#55 on github.com/rydn/eminiar (from fork Beerloaf/eminiar) from correctness, security and test angles; collect verified findings per PR so they can be logged on GitHub and then fixed by separate agents.
Outcome: Reviewed open PRs #42-#55 (fork Beerloaf/eminiar) with 8 tasks across security, correctness and tests; all findings posted as one comment per PR via gh as rydn (GitHub connector was read-only). Headline findings: #55 HIGH remask masks per chunk so split private keys survive; #54/#55 purge/remask leave tokens in FTS5 segments (needs FTS optimize before VACUUM); #46 blocklist routing lets side-effect commands reach em_execute without a Bash prompt (needs read-only allowlist for multi-command lines), plus a quoted-redirect regression; #45 docs sync skips Read rules; #42 ?root= from the page URL lets a foreign page choose the dashboard's project folder; #50 known keys at the wrong level are silently ignored; #51 isOurHook deletes users' own --gate hooks; #53 joined stdout/stderr preview regression; #47 EMINIAR_ADJUDICATOR_MODE=apply via repo settings env is a decision for the owner (left unchanged). #43, #44, #49, #52 clean apart from low notes. Left open: #47 env-var decision; #44 low note; over-masking of ordinary code in #54 is a design tradeoff.
8 task(s), 8 worker(s), 17 min.
- #23 [done] (security) Security review PRs #42, #45, #47 — Security review of PRs #42, #45 and #47. All three main fixes hold, and I found one bypass in each PR. Read-only: PR heads checked out in an isolated scratchpad clone, nothing posted to GitHub.
- #24 [done] (security) Security review PRs #53, #54, #55 — Security review of PRs #53, #54 and #55. Read-only: I used a separate clone in the scratchpad, linked to the main node_modules, and posted nothing to GitHub. #55 is stacked on #54 (it contains commit…
- #25 [done] (security) Security review PRs #43, #46, #49, #51 — Security review of #43, #46, #49, #51 (read-only, scratch clone; each routing finding reproduced by calling suggest("Bash", …) from the PR head via tsx; the #51 finding by running registerSettings/un…
- #26 [done] (correctness) Correctness review PRs #48, #50, #51, #52 — Correctness review of PRs #48, #50, #51 and #52 (read-only; PR heads fetched into a scratch clone, never the shared tree). Blackboard keys finding-26-1 to finding-26-4.
- #27 [done] (correctness) Correctness review PRs #43, #44, #46, #47 — Correctness review of PRs #43, #44, #46 and #47. I checked out each PR into its own scratchpad worktree and ran its relevant unit tests: all pass (43: 137, 44: 100, 46: 30, 47: 93). I tested routing …
- #28 [done] (correctness) Correctness review PRs #45, #53, #54, #55 — Correctness review of PRs #45, #53, #54 and #55, read-only. I reviewed the diffs in scratchpad worktrees under …/scratchpad/rev/w{45,53,54,55}; #55 is stacked on #54. Findings were confirmed with tsx…
- #29 [done] (tests) Test coverage review PRs #42-#47 — Test coverage review of PRs #42-#47. Method: each PR head was checked out in a scratch worktree (since removed). I mutated each changed behaviour one at a time and ran the PR's tests. A mutant that "…
- #30 [done] (tests) Test coverage review PRs #48-#55 — Test coverage review of #48-#55. Verification: each PR head checked out in a scratchpad worktree (tw48..tw55, node_modules symlinked). I ran the changed test files at head, then again with every non-…
