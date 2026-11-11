---
name: adjudicator/hook-integration
kind: decision
tags: [adjudicator, hooks]
related: [file:src/adjudicator/hooks.ts, file:src/hooks/routing.ts, file:src/hooks/capture.ts, file:src/hooks/session-start.ts, file:tests/unit/adjudicator-hooks.test.ts]
created: 2026-11-04T11:14:20.146Z
updated: 2026-11-11T20:04:08.510Z
---

Adjudicator hook integration (branch feature/adjudicator, swarm run 20261104-483f39, task T8 #13, 2026-11-04). src/adjudicator/hooks.ts is the only module that src/hooks/* calls. Every call-out is `await import("../adjudicator/hooks.js")` behind `ctx.config.adjudicator.enabled && input.client !== "cursor"`, so a disabled adjudicator costs one boolean check. tests/unit/adjudicator-hooks-off.test.ts proves this (task #135): every test boots a fresh module registry and the stand-in for hooks.ts records whether its mock factory ever ran. tests/unit/adjudicator-hooks.test.ts shares one registry across its tests (task #132), so it can only assert that no export of the module was read during the test.
- routing.ts: preToolUse runs the swarm checks, then `route()` (the old body, unchanged), then `afterRouting(ctx, input, spawn, out)`. The Agent model is merged by withModel into routing's ONE updatedInput, or into {...tool_input} on the early return, annotate and off paths. withModel never turns a deny/ask into allow. Since 2026-11-11 withModel(out, input, model?, effort?) also carries the advised `effort` in the same updatedInput in apply mode (see [[adjudicator/apply-sets-effort]]; it used to never add `effort`).
- Apply rules: mode apply; scope; CLAUDE_CODE_SUBAGENT_MODEL_FORCE unset or "0"; no explicit model; no frontmatter pin (.claude/agents/<type>.md, which also covers swarm agents because syncAgents writes RoleSpec.model there; "inherit" = not pinned); conf ≥ minConfidence. A plan row for (run, task) supplies the decision, so no provider call is made. Advise mode always uses engine call "never".
- Agent row actions: advised, respected (force, explicit or pin), applied. Prompt rows leave `action` NULL so they don't skew the dispatch follow rate.
- surfaces.tools hint: one SELECT (latestForSession). Once per prompt, tracked by writing the hinted call's id into the prompt row's tool_use_id; a skipped prompt marks the previous row "superseded".
- The main-session cooldown counter lives in meta `adjudicator:main:<sessionId>` = {n, last}.
- sessionStart and sessionEnd handlers became async. SessionEnd runs reconcile after ingestUsage.
