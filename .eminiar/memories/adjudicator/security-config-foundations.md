---
name: adjudicator/security-config-foundations
kind: decision
tags: [adjudicator, security, config, swarm]
related: []
created: 2026-11-13T18:14:00.374Z
updated: 2026-11-13T18:14:00.374Z
---

Security adjudication foundations (task #311 / T1, swarm run 20261113-bef5ea, branch feature/security-adjudication, 2026-11-13). Implemented in src/config.ts, src/adjudicator/types.ts, src/adjudicator/security/types.ts, eminiar.config.schema.json.

- adjudicator.security is the LAST key of the adjudicator section (the defaults pin test compares key order): enabled false, model "off"|"provider", surfaces {agent, plan, prompt} true, minLevel "high", notifyUser "critical", modelFloor "sonnet", trustedMcpServers [], secretPaths [], taintLookbackMin 240, store true. adjudicatorDefaults() carries the same values.
- Project cut: a committed eminiar.config.json keeps only `security.enabled: true` (projectSecurityKeeps). Everything else in security, including `enabled: false` and a non-object `security`, is dropped and named in projectAdjudicatorWarning as adjudicator.security.<key> (droppedProjectAdjudicatorKeys returns "security.<key>"). An untrusted personal file gets the same cut through personalLayer. PROJECT_ADJUDICATOR_KEYS deliberately does not list "security".
- EMINIAR_ADJUDICATOR_SECURITY=0|1 sets only security.enabled; no env var sets security.model.
- adjudicatorWanted(adjudicator, "preTool", tool) | "prompt" | "plan": true when the adjudicator is on, or security is on for that surface (preTool only for Agent/Task). "plan" was added beyond the design because the plan-surface owner does not own config.ts.
- loadConfig's fast path also treats `security: {enabled: false}` as untouched (the kill switch costs no schema build).
- findSecretFields exempts the name secretPaths at adjudicator.security only (it matches /secret/); anything key-like elsewhere in security is still refused.
- The three config enums (MIN_LEVELS, NOTIFY_LEVELS, SECURITY_MODEL_SETTINGS) are defined in src/adjudicator/types.ts and re-exported by security/types.ts: tests/unit/adjudicator-hooks-off.test.ts fails if config.ts imports any other src/adjudicator module while the adjudicator is off. Do not import src/adjudicator/security/* from config.ts.
- AdjudicatorProvider.dims was left unchanged: adding "security" breaks the Tally typing in src/adjudicator/eval.ts.
- `npm run lint` (biome check .) fails in this checkout with "nested root configuration" because untracked .claude/worktrees/*/biome.json exist; run biome on src tests scripts and the root config files instead.
