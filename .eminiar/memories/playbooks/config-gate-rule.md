---
name: playbooks/config-gate-rule
kind: decision
tags: [playbooks, config, gates]
related: [file:src/playbooks/store.ts, file:src/tools/em_playbook.ts, file:src/playbooks/cli.ts, file:src/ui/playbooks-api.ts, file:tests/unit/playbooks-gates.test.ts]
created: 2026-11-11T19:48:51.897Z
updated: 2026-11-11T19:48:51.897Z
---

Playbook config gates (swarm run 20261111-e068a8, tasks #220/#214, branch feature/run_book-rev-gates, 2026-11-11). One rule, enforced only in src/playbooks/store.ts by an exported PlaybookGateError{key}: playbooks.viewing gates every store call (reads and writes); playbooks.adding gates every write, including recordRun (run), closeRun (report), suggest, acceptSuggestion, dismissSuggestion and a non-dry scan; playbooks.extraction.enabled gates suggest, suggestions, accept, dismiss and scan. assertCanScan(ctx,{dryRun}) is the scan gate (surfaces call it before extract.scan). Surfaces translate, never re-check: em_playbook returns the message as isError, the CLI exits 1, the dashboard API maps PlaybookGateError to 403 (other errors 400). Exception by design: `run` with adding off (tool and CLI) still returns the filled prompt and records nothing, matching the dashboard's Copy run prompt (which ignores the 403 of /api/playbooks/run). em_playbook has `available: viewing !== false` like em_adjudicate, so it is not listed while playbooks are off (needs /mcp reconnect after a change); the store still refuses if config changes mid-session.
