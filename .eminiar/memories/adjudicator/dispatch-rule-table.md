---
name: adjudicator/dispatch-rule-table
kind: decision
tags: [adjudicator, fork, force, agent-pin, savings, effort]
related: [file:src/adjudicator/swarm.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/agent-pin.ts, file:src/adjudicator/savings.ts, file:src/adjudicator/learn.ts, file:src/storage/sqlite/adjudicator.ts, file:src/tools/em_swarm.ts, file:src/ui/web/views/Adjudicator.tsx, file:docs/adjudicator.md, file:docs/design/adjudicator.md]
created: 2026-11-04T14:24:16.500Z
updated: 2026-11-11T20:04:10.605Z
---

Adjudicator dispatch rule table (tasks #73-#76, #78, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator). Checked against code.claude.com/docs/en/sub-agents.md.

What advice tells the coordinator to pass is decided by ONE function, src/adjudicator/swarm.ts dispatchRule. It is shared by the em_swarm plan lines and head (planAdviceHead), the plan "Next:" line (planPassing/planNextHint, used by em_swarm planned()) and the PreToolUse(Agent) note (hooks.ts onPreAgent). The first matching row wins:
- fork (subagent_type "fork", agent-pin.ts isFork/FORK_AGENT): no `model` or `effort` to pass. A fork runs on the main session's model, and per-call effort is for non-fork subagents only. The note is informational only. It is never applied: action respected in apply mode, advised in advise mode. resolveAgentPin("fork") returns unpinned builtin. Row flag `fork: true`.
- CLAUDE_CODE_SUBAGENT_MODEL_FORCE on: the model is informational and no pin is named, because FORCE ignores pins too. Plan lines read "model X (informational)". The baseline is CLAUDE_CODE_SUBAGENT_MODEL, else the session model. Row flag `forced: true`.
- ranged (task #104; swarm.yaml model_range, resolveAgentPin status ranged, apply.respectFrontmatter): pass the pick clamped to the role range ∩ apply.floor..ceiling. When the pick is the fallback's tier, or no tier is left, pass no model and take the pin row. Row flags `ranged: true`, `fallbackPin`. See adjudicator/ranged-dispatch.
- pin respected (pinned or unknown, apply.respectFrontmatter): pass no `model`. Row flag `pinDeferred: true`.
- otherwise: pass `model`.
Effort rule (advise mode): pass `effort` unless CLAUDE_CODE_EFFORT_LEVEL is set, the call already has effort, or the brief is saturated (units.saturated, task #104); then it is informational. APPLY mode (2026-11-11, [[adjudicator/apply-sets-effort]]): the hook sets the advised effort itself on every in-scope non-fork dispatch (dispatchRule effort value `applied`, fact effortApply), overriding the call's and the agent file's, skipped only for a fork or when CLAUDE_CODE_EFFORT_LEVEL is set; plan lines then read "effort X (applied by the hook)" and the coordinator passes no `effort`.

The Next line names `model` only when some task has a model to pass. When some agents keep their pin it adds "leave `model` unset for pinned agents" (under FORCE: "leave `model` unset (CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets it)").

Savings (savings.ts keptModel/withKeptModel/keptPin, KEPT_MODEL_FLAG): a flagged row gets no follow detection and no credit (learn.ts pricePatch). The follow rate (store summary) leaves advised flagged rows out of its denominator and reports `keptModel {pin,force,fork}`. savingsReport leaves forced, fork and kept-pin rows out of the suggested×ran matrix and reports `keptModel`. A pin row counts as kept only when no model was passed and it ran on the pinned tier. Plan rows get the same flag (adjudicatePlan markPlanRow).

em_swarm passes `log` (stderr) and `onError` to adjudicatePlan, so an advice failure is visible and appends "Adjudicator advice unavailable for this plan (the tasks are planned)."
