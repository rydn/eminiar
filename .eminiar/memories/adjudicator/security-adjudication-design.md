---
name: adjudicator/security-adjudication-design
kind: decision
status: proposed
tags: [adjudicator, security, design, swarm, dashboard]
related: [file:src/adjudicator/hooks.ts, file:src/adjudicator/engine.ts, file:src/adjudicator/prompt.ts, file:src/adjudicator/providers/typesafe.ts, file:src/adjudicator/swarm.ts, file:src/adjudicator/agent-pin.ts, file:src/config.ts, file:src/hooks/routing.ts, file:src/hooks/capture.ts, file:src/tools/em_swarm.ts, file:src/tools/em_adjudicate.ts, file:src/ui/swarm-api.ts, file:src/ui/adjudicator-api.ts, file:src/storage/sqlite/schema.ts, file:docs/design/adjudicator.md]
created: 2026-11-13T17:57:35.348Z
updated: 2026-11-13T17:57:35.348Z
---

Security-aware adjudication design: PROPOSED (task #310, swarm run 20261113-bef5ea, 2026-11-13, architect). The full design is on blackboard design-security and -2 to -6. Builds on research/security-adjudication-taxonomy and research/security-classifier-models. Decisions D1-D12 still need the user's answer.

Scope and switches:
- Opt-in `adjudicator.security`, off by default. It works without routing advice (D1). Its model part needs adjudicator.enabled with Jev.
- Off costs nothing: no import, no DB access, no network, nothing in the UI.
- Trust: a project eminiar.config.json may only set security.enabled:true. Every other security key is personal-only (~/.eminiar/config.json), and an untrusted personal file gets the same cut. EMINIAR_ADJUDICATOR_SECURITY=0|1.

Code layout:
- New dir src/adjudicator/security/: types (web-safe leaf), taxonomy, grant, signals, score, combine, prompt, advice, assess, hook, report, swarm-risk, cli, eval, data/evalset.
- The storage is separate: StorageAdapter.security (src/storage/sqlite/security.ts), table adjudicator_security, migration v13.
- In security-only mode, routing.ts and capture.ts import security/hook.js. Only Agent/Task PreToolUse and UserPromptSubmit load it.

Signals:
- Tool grant: a swarm role via the new roleToolGrant, shared with frontmatter(); an agent file via AgentPin.grant, from the same file reads; built-ins; INHERIT for fork or unknown.
- MCP tools are normalised to mcp:<class>:<verb>.
- Text cues are read over task + prompt + agent description: 8 KB cap, linear regexes.
- Session taint comes from one events query, at U .4 (it ranks, it never warns alone).
- Autonomy comes from permission_mode.

Scoring:
- Research weights and combos R1-R7.
- Levels are rule-driven (D7): score bands give only LOW/MEDIUM. HIGH needs a complete combination with every leg ≥ .5, or the model. CRITICAL comes only from the fixed floors C1-C6.
- Jev adds questions only to requests with hints.security (plan, em_adjudicate security, CLI test/eval): 1 severity score + 6 threat nouls; no Choice question.
- level = max(heuristic, model). The model never makes CRITICAL and never lowers a level.
- The hook path never waits for a model. Dispatch uses the plan row's model answer.

Behaviour:
- Advice only. Apply mode stands down on HIGH/CRITICAL (D5): no model, no effort, so no auto-allow.
- On HIGH+, advice never names a tier below modelFloor (sonnet) or the baseline.
- Surfaces: Agent-spawn note, prompt line, em_swarm plan lines + head, em_adjudicate security action, CLI `adjudicator security`.
- Adjudicator-tab SecurityPanel gated like jevActive.
- Swarm UI: role, task and run worst-risk badges.
- Coders own the data/API (report.ts, security-api.ts, swarm-risk.ts, swarm-api.ts, web api.ts types). The ui role owns only the Preact components (src/ui/web/security.tsx, SecurityPanel, swarm badges), per memory adjudicator/ui-role-cross-layer.

Why:
- The adjudicator already sees the agent's tools, task text and permission mode, so offline heuristics can rank exfiltration and malicious-code risk.
- Jev can be steered by injected state, so it may only raise risk.
- Banding by score alone flagged almost every general-purpose dispatch HIGH.

How to apply: before implementing, read the design keys and get answers to D1-D12. Update this memory to accepted (or superseded) when the user rules.
