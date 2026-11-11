---
name: swarm/no-git-stash-in-shared-tree
kind: constraint
tags: [swarm, git, workers]
related: [file:.eminiar/swarm.yaml, file:src/swarm/agents.ts]
created: 2026-11-05T10:34:51.934Z
updated: 2026-11-08T17:24:42.318Z
---

Swarm workers share one working tree with other workers' uncommitted edits. A worker must never use git stash / checkout / reset / restore (even path-limited) to test "without the fix": in run 20261104-672098 (#131) and 20261105-f530e8 (#148) workers stashed and popped src/adjudicator files while other coders were active; no work was lost only by luck of timing. Mutation-check in a scratch copy under the scratchpad instead (copy the file or src/ and run vitest with a probe config). Since 2026-11-08 the generated worker protocol says it (src/swarm/agents.ts SHARED_TREE_RULE, step 3) for every role that has a shell (roleHasShell) and no `isolation: worktree`, so coordinators no longer need to repeat it in spawn prompts. It names stash, checkout, switch, reset, restore and clean, warns that `git add -A` / `git commit -a` sweeps other workers' unfinished work into a commit, and points mutation checks at a copy outside the tree.
