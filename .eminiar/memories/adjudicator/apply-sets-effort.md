---
name: adjudicator/apply-sets-effort
kind: decision
tags: []
related: []
created: 2026-11-11T19:48:29.239Z
updated: 2026-11-11T19:48:29.239Z
---

Apply mode always sets effort (user decision 2026-11-11, swarm run 20261111-14ebfc, branch feature/adjudicator-effort-followthrough, PR #64). Supersedes the "hook never injects effort" rule in [[adjudicator/advise-respects-pins-and-agent-effort]]. Evidence: [[adjudicator/hook-effort-probe]] (Claude Code 2.1.311, 22 claude -p runs): a PreToolUse hook's updatedInput.effort reaches the subagent and beats both the call's own effort and the agent file's `effort:`.

Rules (src/adjudicator/hooks.ts withModel(out, input, model?, effort?) builds ONE updatedInput {...input, model?, effort?}):
- In apply mode, in apply.scope, with an advised effort: always set it, even when the model is NOT applied (model pin kept, ranged role keeping its fallback, explicit model, FORCE) and even when apply.minConfidence blocks the model (minConfidence gates only the model, by decision: "always"). It overrides the call's effort and the agent file's.
- Skip it for: a fork (silently dropped by Claude Code), CLAUDE_CODE_EFFORT_LEVEL set (the env outranks the hook; note says why), deny/ask, advise mode. NEVER send a level outside EFFORTS: an invalid value fails the whole Agent call (probe case f).
- No per-model clamp: a model without effort support ignores it (actual level unknown, row not counted). No Claude Code version gating (reading transcript_path would add hot-path I/O; CLI strips unknown keys, so older than 2.1.292 probably drops it; untested).
- A saturated brief still gets its effort applied but is not counted in the follow verdict.
- Scores key effortApplied (EFFORT_APPLIED_FIELD). Follow rule with an applied effort: followed iff ran === advised (replaces the passed/agent shortcut). The store's private copy (scoresEffort) counts set = effortApplied ?? passedEffort. effortSource order in the decisions view: env > applied > call > fork > agent-file > agent-default; chip label "<level> (applied)".
- Plan lines in apply mode read "effort X (applied by the hook)" and the Next: line tells the coordinator to pass no `effort`; advise mode unchanged.
- Reconcile also runs Reconciler.backfillEffort(): final agent rows with no actualEffort key get ONLY the effort scores keys (scan cap EFFORT_BACKFILL_SCAN=1000, repair cap EFFORT_BACKFILL_LIMIT=200 per pass, idempotent, no-op when learning is off).
Also: tsconfig.web.json is back to types:[] (SwarmDecision* types moved to the node-free leaf src/adjudicator/swarm-decision-types.ts); .claude/worktrees/ is gitignored (it broke root lint with a nested biome root).
