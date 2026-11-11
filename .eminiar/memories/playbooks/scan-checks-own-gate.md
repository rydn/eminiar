---
name: playbooks/scan-checks-own-gate
kind: decision
tags: []
related: [file:src/playbooks/extract.ts, file:src/playbooks/store.ts, file:src/ui/playbooks-api.ts, file:tests/unit/playbooks-regressions.test.ts]
created: 2026-11-11T20:04:07.510Z
updated: 2026-11-11T20:04:07.510Z
---

Playbook scan gate (swarm run 20261111-e068a8, task #238, branch feature/run_book-docs-final, a416b78, 2026-11-11): scan() in src/playbooks/extract.ts calls store.assertCanScan(ctx,{dryRun}) itself, so a direct library call is refused like the CLI/tool/dashboard (viewing+extraction always, adding unless dryRun). store.ts stays the only place that throws PlaybookGateError; surfaces still call assertCanScan first so a refused scan reads nothing. The dashboard run/close route relies on store.closeRun for the adding gate (no local check). The playbook regression tests now live in tests/unit/playbooks-regressions.test.ts (was playbooks-known-bugs.test.ts; no it.fails remain).
