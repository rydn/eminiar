---
name: playbooks/git-checks-helper
kind: decision
tags: []
related: [file:src/playbooks/git.ts, file:src/playbooks/store.ts, file:src/playbooks/export.ts, file:tests/unit/playbooks-r2-git.test.ts]
created: 2026-11-11T20:31:29.248Z
updated: 2026-11-11T20:31:29.248Z
---

Playbook git checks (swarm run 20261111-e068a8, tasks #261/#263/#265, branch feature/run_book-r2-git, aa3642a, 2026-11-11). All git questions from the playbook store and export go through src/playbooks/git.ts: gitIgnoredFor(root, path, {noIndex}) -> "ignored" | "not-ignored" | "unknown" and gitTrackedIn(root, dir). They run execFile with fixed args and `--`, GIT_* stripped, -c core.fsmonitor=false, a 10 s timeout, and cwd = the real path of the nearest existing folder holding the path, so a nested repo or worktree (.claude/worktrees/wt) answers for its own files. Callers fail closed on anything but "ignored". Store rules: a private write is refused (naming the files) while git tracks any file in playbooks.privateDir; ensurePrivateIgnored asks, with the index, about the real file being written plus a random eminiar-probe-<hex>.md (never a fixed probe name), adds `<privateDir>/` to the project .gitignore when either is not ignored, and re-checks. A project without its own .git keeps its own .gitignore line even when a parent repo already ignores it. A tracked file in the private folder never counts in locate/reconcile (ReconcileSummary.tracked + skipped), so it cannot shadow a committed playbook. Modes: private store files 0600 in a 0700 folder (an existing looser folder is tightened); a private playbook exported as a skill is written 0600 in a 0700 <name> folder (tighten rather than refuse).
