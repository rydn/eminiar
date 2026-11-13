---
name: decision/security-hook-wiring-task-318-t8-swarm-run
kind: decision
tags: [adjudicator, security, hooks]
related: []
created: 2026-11-13T19:07:17.361Z
updated: 2026-11-13T19:07:17.361Z
---

Security hook wiring (task #318 / T8, swarm run 20261113-bef5ea, branch feature/security-adjudication). hooks.ts afterRoutingAgent: security on -> lazy import security/hook.js, resolveAgentPin once (shared with onPreAgent via sec.pin), securityPreAgent, onPreAgent(..., sec) holds apply on HIGH+ (held = sec.hold && applyMode && inScope: no model, no provider call, action advised, note "apply held: security HIGH") and applies secureModel to clamped/ranged picks (keep/"(security floor)" notes), then recordAdvice(adjudicationId=a.rowId) + withSecurity. Denied out: not assessed. routing.ts gates with adjudicatorWanted; security-only calls securityAfterRouting. Prompt line lives in capture.ts (SECURITY_NEEDS_MS=200), both modes, own part after the routing line; onPrompt in hooks.ts is unchanged. Prompt surface (user decision): speaks only at PROMPT_MIN_LEVEL=critical (named constant in security/hook.ts, no config key), each distinct warning (level + sorted rule ids/floors) once per session, state in meta key adjudicator:security:prompt (last 8 sessions x 16 signatures), touched only for a CRITICAL prompt; the row is stored at every level. Bench: security-only hook adds about 13-15 ms p50 incl. process (module load about 7 ms), above the 10 ms budget.
