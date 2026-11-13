---
name: playbooks/git-pathspec-and-export-race
kind: decision
tags: []
related: [file:src/playbooks/git.ts, file:src/playbooks/export.ts, file:src/config.ts, file:tests/unit/playbooks-r3-git.test.ts]
created: 2026-11-11T21:55:30.775Z
updated: 2026-11-11T21:55:30.775Z
---

Playbook git checks and skill export, round 3 (swarm run 20261111-e068a8, tasks #288/#289, branch feature/run_book-r3-git, 36af4af, 2026-11-11). src/playbooks/git.ts always hands git a literal path: `./<rel>` to check-ignore and ls-files (a leading `:/x`, `:(top)x`, `:!x` is pathspec magic that answers for another path). Do NOT use --literal-pathspecs: check-ignore exits 128 with it. git is run as an absolute file resolved from the absolute PATH entries only, and the child PATH keeps only those (empty, `.`, relative entries would find a committed `git` because git runs with cwd inside the project). PROJECT_RELATIVE_PATH_RE (src/config.ts) refuses a leading `:` (after any `./`); export resolveTarget refuses a target starting with `:`. src/playbooks/export.ts never mkdirs or chmods by a swappable path: makeDirs() creates one folder at a time from the real project root, checking the parent (same dev/ino, not a link) before and after each mkdir and rmdir-ing a folder made through a swapped link; tightenDir() fchmods a descriptor opened O_RDONLY|O_DIRECTORY|O_NOFOLLOW only when its dev/ino equals stat(realpath(dir)) and that real path is inside the project (Windows: no tightening). Node has no mkdirat, so the mkdir part detects a swap rather than ruling it out (an ABA swap back to the same inode inside the two-syscall window is the residual). Reviewer race probes (sec3 p4.mts, p4chmod.mts) ran 20000 tries each with nothing created or chmodded outside.
