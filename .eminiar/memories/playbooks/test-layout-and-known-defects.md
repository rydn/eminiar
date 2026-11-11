---
name: playbooks/test-layout-and-known-defects
kind: note
tags: [playbooks, tests]
related: [file:tests/unit/playbooks-safety.test.ts, file:tests/unit/playbooks-lows.test.ts, file:tests/unit/playbook-extract-thresholds.test.ts, file:tests/unit/playbooks-gates.test.ts]
created: 2026-11-11T18:39:40.013Z
updated: 2026-11-11T22:10:00.000Z
---

Playbook test layout (swarm run 20261111-e068a8, branch feature/run_book, 2026-11-11). Tests live in tests/unit/playbook*.test.ts plus tests/integration/playbooks-dashboard.test.ts.

Areas: playbooks.test.ts (store core), playbooks-safety.test.ts (private folder against real git check-ignore, links and paths leaving the project, header injection incl. a real YAML parse of exported SKILL.md, masking on every export path, export target confinement, private-playbook export, shadowing of a private playbook by a committed one), playbooks-runs.test.ts (closeRun ordering and races via a stale snapshot, v10 migration on a v9 db, purge scopes), playbook-extract.test.ts and playbook-extract-thresholds.test.ts (3 sessions, 2 local days, 30 min window, 60% server share, exclusions, dismissal memory when a cluster grows, bounded scan, stub EmbeddingProvider), playbooks-gates.test.ts (the viewing/adding/extraction switches on the store, tool, API and CLI; CLI exit codes 0/1/2; hook bundles carry no playbook code), playbooks-lows.test.ts (the review's low findings L1-L10), playbooks-api.test.ts and playbooks-route.test.ts and playbooks-client.test.ts (dashboard API, `?tab=` route parsing, fillPrompt parity with the store).

Review-found defects (B1-B11 from the tester, S1-S7 security, M1-M4 and L1-L10 logic, C1-C11 conventions) were each pinned by a failing test and then fixed; tests/unit/playbooks-known-bugs.test.ts holds the first batch as plain `it` now. There are no `it.fails` pins left.

Rules for new tests: scans must pass an explicit embeddings provider or set EMINIAR_EMBEDDINGS=0 (a default scan constructs the real model and starts warming it); pass `timeZone: "UTC"` to scan when thresholds are written in UTC (days are local calendar days); build an extraction-enabled context for suggest/accept/dismiss (the store refuses them otherwise, see mem:playbooks/config-gate-rule).

tests/unit/check-bundle.test.ts (real esbuild and tsup builds, 20 s per test) times out under machine load, also on a clean origin/main; it is not a playbook failure. Run the full suite on a quiet machine before trusting it.
