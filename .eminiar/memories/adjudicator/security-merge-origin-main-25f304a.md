---
name: adjudicator/security-merge-origin-main-25f304a
kind: decision
tags: [adjudicator, security, merge, schema, effort]
related: [file:src/adjudicator/hooks.ts, file:src/adjudicator/agent-pin.ts, file:src/swarm/agents.ts, file:src/config.ts, file:src/storage/sqlite/schema.ts, file:src/ui/swarm-api.ts, file:tests/unit/recall-index.test.ts, file:tests/unit/adjudicator-security-signals.test.ts]
created: 2026-11-13T20:27:31.983Z
updated: 2026-11-13T20:27:31.983Z
---

Merge of origin/main 25f304a (v0.14.8) into feature/security-adjudication (36a7d67), task #343 / T18, swarm run 20261113-bef5ea, 2026-11-13. Staged, not committed (the coordinator commits). How the 15 conflicts were resolved, and why:
- Versions: package.json, package-lock.json and both plugin.json are 0.15.0 with upstream's other fields; the two sides differed only in the version string. origin/feature/run_book is also 0.15.0, so whichever lands second needs a new number.
- Schema: main has v12 (recall index); ours is v13 (adjudicator_security), appended after it. RESERVED_SCHEMA_VERSIONS and RELEASED_SCHEMA_VERSIONS exist only on origin/feature/run_book (RESERVED [10], RELEASED [1..9, 11], tests/unit/schema-migrations.test.ts), not on main. 13 is free on both. The latest-version pins in adjudicator-store.test.ts and recall-index.test.ts are now 13. recall-index's "heal that finds the database locked" test now seeds 13: a database at 12 has v13 pending, so it takes the normal migration path (busy timeout, may throw), not the bounded heal.
- hooks.ts: onPreAgent(ctx, input, spawn, deps, blocked = false, sec?). Upstream's `blocked` (deny/ask) stays 5th because upstream tests pass it; `sec` is 6th. afterRoutingAgent computes both and calls withModel(out, ti, a.model, a.effort). The security hold (HIGH+, apply mode, in scope) also stops upstream's always-set effort: no effort, no provider call made only for the effort, no updatedInput (design D5: no model, no effort, no auto-allow). The "apply held: security HIGH" note also shows when apply mode would only have set the effort (pinned, explicit, FORCE or ranged-stay dispatch).
- agent-pin.ts: decide() = decideModel (upstream) plus the agent-file effort (upstream) plus agreedGrant (ours). readDef parses the effort always and the grant only for the wanted name.
- swarm/agents.ts: upstream's tools_profile readonly now lives inside roleToolGrant (readonlyTools allow plus READONLY_DENY), so the security grant and frontmatter() still agree. Checked: 9 roles x 15 tool variants (135 files) render byte-identical to origin/main's frontmatter(). tests/unit/adjudicator-security-signals.test.ts pins the readonly grant; the mutation check passed. Follow-up #344: assessText, em_adjudicate and the CLI drop toolsProfile, so they over-report risk.
- config.ts: upstream's layer-wise validation (mergeLayers, ADDITIVE_LISTS, parseLayers, withoutPaths) is kept alongside our securitySwitchOnly fast path. An invalid config now costs one more full-schema parse, on the error path only. Side effect: an invalid committed eminiar.config.json is dropped alone, so personal security.enabled survives. Before the merge, everything fell back to defaults. This likely resolves #339.
- swarm-api.ts: runDetail returns upstream's decisions, decisionsHash and decisionsUnchanged, plus our risk fields (security on only).
- TaskBoard.tsx: the DecisionChip and our RiskBadge both appear. styles.css: upstream's .sw-dec rules first, then our sec-* section.
- bench-hotpath.mjs: upstream's --deadline variant plus our security and both variants.
- adjudicator-hooks-off.test.ts: security-only mode may now load effort.ts, a pure leaf that agent-pin.ts imports.
Verified: typecheck clean; biome 0 errors (2 upstream infos); build and check-bundle pass and the regenerated schema is unchanged; vitest 4014 passed, 1 skipped; the security eval is unchanged (core 98.1%, HIGH+ recall 100%, CRITICAL precision 100%, LOW false-warn 0%).
