---
name: swarm/parallel-worker-git-rules
kind: constraint
tags: [swarm, git, workflow]
related: []
created: 2026-11-09T18:23:30.304Z
updated: 2026-11-09T18:23:30.304Z
---

Rules for swarm workers that fetch from the same repo in parallel (learned in swarm run 20261109-6881be, 2026-11-09, fixing 9 fork PR branches at once). (1) Workers share one FETCH_HEAD, so a plain `git fetch URL branch` followed by FETCH_HEAD can start a worktree on another worker's branch (it happened once; the push was rejected as non-fast-forward, so no damage). Fetch into a dedicated ref (`git fetch URL branch:refs/heads/wNN-base`) and base the worktree on it. (2) Before pushing, check `git merge-base --is-ancestor <remote tip> HEAD` and that the commit touches only the task's files; on rejection rebase your own commit, never merge another branch and never --force. (3) A worker that ends its turn to wait on a background test run is released back to pending by the board; run tests in the foreground (Bash timeout up to 600000 ms). (4) Worktrees with a node_modules symlink to the main repo lack dist/ and any newly declared dependencies: five tests (bundle, check-bundle, adjudicator, cli-pipe, swarm-watch-pipe) cannot pass there and check-bundle can time out under load, and typecheck can show a false TS7016 for a dependency the branch declares. Verify a branch with a real `npm run build` and the full `npm test`, one branch at a time. (5) The coordinator checked each pushed branch with the GitHub compare API (ahead/behind, merge commits, files) before trusting a worker's report. (6) The GitHub MCP connector in this setup was read-only (403 on comments); gh as the repo owner worked, with the user's approval.
