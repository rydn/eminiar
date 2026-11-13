---
name: adjudicator/security-orchestration
kind: decision
tags: [adjudicator, security, hooks, swarm]
related: []
created: 2026-11-13T18:56:21.412Z
updated: 2026-11-13T18:56:21.412Z
---

Security adjudication orchestration (task #317 / T7, swarm run 20261113-bef5ea, branch feature/security-adjudication, 2026-11-13). Code: src/adjudicator/security/{assess,advice,hook}.ts, src/adjudicator/task-lookup.ts (findTask moved out of hooks.ts; hooks.ts keeps its copy until T8). The contract for the wiring and the API tasks is on blackboard t7-orchestration-contract.

- Advice only, always: nothing in security/ writes permissionDecision or updatedInput; a denied call is not assessed or annotated; Cursor is skipped. A HIGH or CRITICAL dispatch sets SecurityAdvice.hold, which the routing adjudicator must honour (apply mode stands down: no model, no effort, note "apply held: security HIGH"). On HIGH+ model advice never names a tier below max(security.modelFloor, the baseline's tier): assess.secureModel returns {tier, keep?}; keep means say "keep <model>: security HIGH" instead of "pass model:X". The plan uses finishPlan(...).tierFor (floor only: the baseline is resolved at dispatch).
- Agent-spawn hooks never wait for a model: securityPreAgent is heuristic plus indexed reads; a worker's task reuses the plan row's model answer (db.security.forTask(run, task), detail.model.answer), source "plan". The model is asked only at plan time, em_adjudicate security and CLI test/eval (hints.security from assess.securityHint: tool ids and capability tags only).
- Level = combine(heuristic, model): the model can only raise, never CRITICAL. Every assessed dispatch, prompt and plan task is stored (all levels) unless security.store is false; lines appear from security.minLevel; the user message from security.notifyUser.
- A stored row's detail is SecurityDetail v1 (advice.ts) and viewOfRow(row) rebuilds the same view the live assessment had, so every surface words an assessment identically. The remedy sentence is `line` in the detail, because the store drops keys named text/path/url/input/... at any depth. Local MCP server names are scrubbed from stored reasons (ToolGrant.local is never stored).
- Hot path cost: db.eventToolsSince(session, since, limit) is the cheap taint read; its SQL says INDEXED BY events_session because SQLite otherwise plans events_cat and scans every session's tool calls. The prompt hook's envelope and slash rules (assess.typedPrompt) copy hooks.ts isHarnessEnvelope/stripLeadingReminders (security-only mode must not load hooks.ts); a parity test keeps them equal.
- Names from outside (subagent_type, role) are reduced to [A-Za-z0-9_.:@/-] in every line the user reads.
- Open, reported to the coordinator (blackboard t7-signals-findings): signals.ts gives a false CRITICAL on review text ("don't leak secrets" fires the exfiltrate intent), review-context is set by bare prevent/detect/harden/sanitize/redact, persistence is not emitted for .eminiar/*, .profile, .vscode/tasks.json, .gitlab-ci.yml, and URL path words (/post, /share, /release) emit egress.
