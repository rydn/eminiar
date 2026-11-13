---
name: playbooks/test-layout-and-known-defects
kind: note
tags: [playbooks, tests]
related: [file:tests/unit/playbooks-known-bugs.test.ts, file:tests/unit/playbooks-safety.test.ts, file:tests/unit/playbook-extract-thresholds.test.ts]
created: 2026-11-11T18:39:40.013Z
updated: 2026-11-11T18:39:40.013Z
---

Playbook test layout (swarm run 20261111-e068a8, task #148, branch feature/run_book-tests). Tests live in tests/unit/playbook*.test.ts plus tests/integration/playbooks-dashboard.test.ts. Areas: playbooks.test.ts (store core), playbooks-safety.test.ts (private folder + real git check-ignore, links/paths leaving the project, header injection incl. real YAML parse of exported SKILL.md, masking on every export), playbooks-runs.test.ts (closeRun ordering/races via stale snapshot, v10 migration on a v9 db, purge scopes), playbook-extract-thresholds.test.ts (3 sessions, 2 UTC days, 30 min window inclusive, 60% server share, exclusions, stub EmbeddingProvider), playbooks-gates.test.ts (viewing/adding/extraction switches on tool, API, CLI; CLI exit codes 0/1/2; hook bundles carry no playbook code), playbooks-client.test.ts (dashboard fillPrompt == store fillPrompt; loads the web module by a variable path so the Node tsconfig does not need the DOM lib). tests/unit/playbooks-known-bugs.test.ts holds confirmed defects as it.fails: fix the code, then flip it.fails to it. Rules: scans in tests must pass an explicit embeddings provider or set EMINIAR_EMBEDDINGS=0 (a default scan constructs the real model and starts warming it). Mutation checks were run in a scratch copy (about 125 mutants, all killed except documented defense-in-depth ones: the oneLine calls in store.clean are shadowed by the same call in frontmatter serialize).
