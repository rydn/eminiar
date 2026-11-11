---
name: adjudicator/project-layer-mode-apply-tiers
kind: todo
tags: [adjudicator, security, trust-boundary]
related: [file:src/adjudicator/config.ts, file:src/config.ts, file:docs/configuration.md]
created: 2026-11-05T10:16:00.854Z
updated: 2026-11-08T14:01:35.000Z
---

Follow-up approved by Ryan (2026-11-05, after swarm run 20261104-672098, review #109): the project layer (<root>/eminiar.config.json, committed with any clone) can still set the adjudicator's `mode`, `apply.*` (scope, floor, ceiling, minConfidence, respectFrontmatter) and `tiers`. Decision: those keys become personal-config only (~/.eminiar/config.json), like provider/keys/budget already are (see adjudicator/project-layer-trust-boundary). A project file may still turn the adjudicator off or keep it advise-only (i.e. it may only make it more conservative). Touches src/adjudicator/config.ts projectLayer allowlist, docs/configuration.md, tests for the allowlist; status/doctor should say when a project key was ignored.

Resolved 2026-11-08 (branch fix/adjudicator-project-trust, memory adjudicator/project-allowlist-and-local-keys): the allowlist is in src/config.ts (not src/adjudicator/config.ts). PROJECT_ADJUDICATOR_KEYS lost mode, tiers and apply; projectKeeps(adj, k) also keeps `mode: "advise"`, so a project can keep the adjudicator advise-only (over a personal apply) but never switch it to apply. droppedProjectAdjudicatorKeys/projectLayer share projectKeeps, so doctor/status/dashboard name adjudicator.apply / mode / tiers when ignored with no change of their own. EMINIAR_ADJUDICATOR_MODE is unchanged: the decision covers the project file, and env stays a personal channel like EMINIAR_ADJUDICATOR_PROVIDER. Tests: tests/unit/adjudicator-config.test.ts "(F) a project cannot turn on apply mode, set apply.* or change the tiers" plus the updated allowlist, trust-anchor and tiers tests.
