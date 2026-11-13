---
name: adjudicator/advise-respects-pins-and-agent-effort
kind: decision
tags: [adjudicator, effort, agent-pin, savings]
related: [file:src/adjudicator/swarm.ts, file:src/adjudicator/hooks.ts, file:src/adjudicator/savings.ts, file:src/adjudicator/learn.ts, file:src/adjudicator/types.ts, file:src/adjudicator/heuristic.ts, file:src/tools/em_swarm.ts, file:src/swarm/brief.ts, file:docs/adjudicator.md, file:docs/design/adjudicator.md]
created: 2026-11-04T13:50:50.813Z
updated: 2026-11-11T19:48:28.740Z
---

Adjudicator advice: model pins and per-call effort (tasks #66/#68, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator).

(1) Per-call effort, checked against code.claude.com/docs/en/sub-agents.md "Choose an effort level" and model-config "Adjust effort level": from Claude Code 2.1.292 the Agent call takes an `effort` parameter for non-fork subagents. It overrides the agent file's `effort`, and CLAUDE_CODE_EFFORT_LEVEL outranks both. The levels are low, medium, high, xhigh and max; a model that lacks a level falls back to the next level down.
- types.ts: EFFORTS gained "max"; AGENT_EFFORT_SINCE = "2.1.292".
- heuristic.ts effortFor: c ≥ MAX_EFFORT_AT (3.75) → max, so max is only suggested at the top of the scale.
- Plan advice and the PreToolUse(Agent) note tell the coordinator to pass effort: "pass effort:'X' (Claude Code 2.1.292+)". They fall back to "suggested effort X" when the call already passes effort or CLAUDE_CODE_EFFORT_LEVEL is set.
- SUPERSEDED 2026-11-11 (user decision, swarm run 20261111-14ebfc): apply mode now ALWAYS sets the advised effort in the same updatedInput as the model; see [[adjudicator/apply-sets-effort]]. Advise mode still never injects effort. (Original rule: the hook never injected effort, in apply mode too.)

(2) Coordinator decision: advise mode respects agent model pins the same way apply mode does, under the same apply.respectFrontmatter rule.
- Plan advice: adjudicatePlan calls resolveAgentPin once per agentType and sets PlanAdvice.pin to {status: pinned|unknown}. The line then reads "#N → agent · pinned opus (adjudicator would pick haiku; remove the pin in swarm.yaml to let it choose) · effort …" or "model pin is unknown (…)", never "model X". The head adds "a pinned agent keeps its model: pass no `model`".
- onPreAgent writes the same pinned note, built by swarm.ts pinnedPart.
- The row's scores JSON gets pinDeferred: true. The pin is pinned or unknown, not forced and not applied, and the flag is set even when the coordinator passes a model anyway.
- Savings: savings.ts pinDeferred(row). learn.ts pricePatch then skips follow detection and gives no credit, and SAVINGS_ASSUMPTIONS states this.

(3) em_swarm plan advice fails open. The tasks are already inserted, so an advice error goes to stderr and the plan returns its normal text plus "Adjudicator advice unavailable for this plan (the tasks are planned)." Reporting the error instead would make the coordinator re-plan and create duplicate tasks.
