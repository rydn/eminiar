---
name: adjudicator/security-docs-and-release-t15
kind: decision
tags: [adjudicator, security, docs, release]
related: []
created: 2026-11-13T19:57:31.634Z
updated: 2026-11-13T19:57:31.634Z
---

Security advice docs and version (task #325 / T15, swarm run 20261113-bef5ea, branch feature/security-adjudication, 2026-11-13). Docs written from the code: docs/design/adjudicator-security.md (design as built, deviations from the proposal, known limits, phase 2, prior art), a "Security advice" section in docs/adjudicator.md (privacy table of what Jev receives, trust rule, kill switch EMINIAR_ADJUDICATOR_SECURITY=0, levels, surfaces, noise rules), keys in docs/configuration.md (checked against eminiar.config.schema.json: 12 keys, defaults match), CLI in docs/cli.md, dashboard panel and swarm badges in docs/dashboard.md, em_adjudicate security and the purge scope in docs/tools.md (appended after the unchanged text 'learned bias, captured Jev requests'; a docs test requires it), README, em-doctor skill. Version set to 0.15.0 with npm version --no-git-tag-version. The assessment table is schema migration v13: RECHECK RESERVED/RELEASED_SCHEMA_VERSIONS AT MERGE. Eval numbers (60 items, heuristic): core accuracy 98.1%, HIGH+ recall 100%, CRITICAL precision 100%, 3 mismatches (high-07, high-12, crit-11); the items were written by the same design as the scorer, so they show consistency, not independent accuracy. Jev data retention is unverified (third-party claims only). Not documented as a promise: Jev leg never measured against the real API; weights untuned.
