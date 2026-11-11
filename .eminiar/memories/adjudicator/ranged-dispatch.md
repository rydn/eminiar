---
name: adjudicator/ranged-dispatch
kind: decision
tags: [adjudicator, model-range, agent-pin, apply, savings, swarm]
related: [file:src/adjudicator/agent-pin.ts, file:src/adjudicator/swarm.ts, file:src/adjudicator/hooks.ts, file:tests/unit/adjudicator-ranged.test.ts, file:tests/unit/adjudicator-swarm.test.ts]
created: 2026-11-05T08:27:25.215Z
updated: 2026-11-11T20:04:09.000Z
---

Ranged swarm roles in dispatch (task #104, swarm run 20261104-672098, 2026-11-05, branch feature/adjudicator). This builds on swarm/model-range (#103), adjudicator/brief-units (#102) and the savings fields of #105.

Pin lookup (src/adjudicator/agent-pin.ts):
- resolveAgentPin returns status "ranged" {model: fallback, range: {floor, ceiling}} only when the agent file is a generated swarm file whose marker hash still verifies (agentFileRange), the range spans two tiers or more, and tierOf(fallback) is inside it.
- Anything else counts as the plain pin of the frontmatter model: a hand edit, opusplan, an unknown id, a one-tier range, a fallback outside the range, or same-name definitions that disagree on the range.
- An unpinned result carries `inherit: true` when the file says `model: inherit`. Such an agent runs on the main session's model even when CLAUDE_CODE_SUBAGENT_MODEL is set.

Rule table (src/adjudicator/swarm.ts dispatchRule):
- Row order: fork > FORCE > ranged > pin > pass. Unranged agents get exactly the old rows; an exhaustive test checks this.
- A ranged agent passes the pick clamped to the role range ∩ apply.floor..ceiling (rangedTier). When that pick is the fallback's tier, or no tier is left, it passes NO model and counts as a kept pin (KeptModel "pin", pinDeferred). That way a pinned id or [1m] variant is never swapped for a bare alias.
- With apply.respectFrontmatter off, the range is ignored like any pin.
- The effort is informational when CLAUDE_CODE_EFFORT_LEVEL is set, the call already passes one, or the brief is saturated (units.saturated). Plan lines read "effort X: informational (brief saturated; …)". The Agent note reads "effort X: informational (brief saturated)".
- Role notes ("role suggested", and "role X" in the Agent note) need a role-table confidence of at least ROLE_NOTE_MIN = 0.7. The confidence comes from the plan row's scores.role.confidence, then units.roleConfidence, then the live verdict's.
- The plan block puts ALL_PINNED_NOTE ("every role pins a model: the adjudicator cannot change any worker (add model_range in swarm.yaml)") under its head when every swarm role resolves to status pinned, pins are respected and FORCE is off.

Hook (src/adjudicator/hooks.ts onPreAgent):
- Apply mode sets the ranged pick only when it moves the model, conf >= apply.minConfidence, and there is no explicit model, no FORCE and no fork. That is the MODEL rule; since 2026-11-11 apply mode also always sets the advised effort on the same call, even when the ranged pick keeps the fallback (see [[adjudicator/apply-sets-effort]]; it used to never set effort).
- Rows (plan and agent) store {ranged: true, fallbackPin} and pin {status: "ranged", …}. The baseline is the fallback.
- CLAUDE_CODE_SUBAGENT_MODEL becomes the baseline only for an agent with no model line (not a fork, not under FORCE, not inherit). Only that variable is passed to resolveBaseline.
- Main-session advice passes env {}.

Tests: tests/unit/adjudicator-ranged.test.ts. Blackboard: ranged-dispatch, ranged-hooks.
