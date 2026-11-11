---
name: security/read-rule-relative-patterns
kind: todo
tags: [security, permissions, pr-45]
related: [file:src/permissions/rules.ts, file:src/docs/sync.ts, file:src/tools/em_graph.ts]
created: 2026-11-09T18:23:29.798Z
updated: 2026-11-09T21:06:21.057Z
---

FIXED on fix/path-containment (PR #45) at af86b6b, swarm run 20261109-82e284 task #63: readSource in src/permissions/rules.ts resolves //x, ~/x, ./x, x/y, /x (root + legacy absolute), slash-less names at any depth, **… anywhere, against PermissionRules.root; see memory security/path-containment. Original note: Relative Read deny patterns never match (found 2026-11-09 while fixing PR #45, swarm run 20261109-6881be). matchRead in src/permissions/rules.ts:81-87 compiles the rule pattern to a regex anchored to the whole absolute path, so Read(./.env), Read(.env) and Read(/.env) never match /proj/.env; only **/.env and fully absolute patterns do. Everything that uses it (em_index, the dashboard file viewer, docs sync, em_reindex docs, other permission checks) therefore ignores the most common project-relative deny form. Pre-existing on main, not part of PR #45's diff; the PR #45 tests use Read(**/x) for that reason. Why it is open: fixing it means choosing how ./x, x, /x and //x resolve (Claude Code treats ./x and x as relative, /x as project-root-relative, //x as absolute) and passing the project root into matchRead, which other checks share. How to apply: before relying on a Read deny rule to keep a file out of the index, check the pattern form; when this is fixed, add a test with Read(./.env) and a docs.json glob **/.env (the original PR #45 review repro).
