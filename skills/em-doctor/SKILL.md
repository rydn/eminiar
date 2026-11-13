---
name: em-doctor
description: Diagnose the eminiar installation — node, SQLite FTS5, sqlite-vec, embedding model, sandbox languages, routing mode, context-mode coexistence, project root, and the opt-in adjudicator and its security advice (provider, key, consent, health).
user-invocable: true
allowed-tools: mcp__plugin_eminiar_eminiar__em_doctor
---

Call `em_doctor` and show the checklist verbatim. For any failed check, suggest the fix in one
line (usually `npx eminiar install` or `eminiar doctor --fix` from a terminal).

When the adjudicator is on, the `adjudicator*` checks cover: the config is valid; the
configured provider is the one that runs (or why the heuristic runs instead: no key, no
consent, an API key rejected, misconfigured); the key is present and `~/.eminiar/adjudicator.key`
is mode 0600; consent for a remote provider; breaker state and p95 latency against the budget;
the last 24 h fallback rate; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set while mode is apply; in
apply mode, `adjudicator swarm pins` (information, not a failure) when every role of a swarm
pins a model without a range, so apply mode cannot change any of its workers; and, for the
embedding provider, whether the exemplar vectors are cached. Fixes are
`eminiar adjudicator key set`, `eminiar adjudicator enable --accept-remote`, `chmod 600
~/.eminiar/adjudicator.key`, `eminiar adjudicator status`, or for swarm pins a `model_range` on
the roles in `.eminiar/swarm.yaml` followed by `eminiar swarm sync`. `eminiar doctor` (terminal) also
probes the provider live with a 2 s timeout.

When the opt-in security advice is on (or its model setting is set, or an eval was saved), two more
checks appear: `adjudicator security` (on or off and who decides it, the surfaces, the lowest level
that gets a line, the model status, and the last 7 days' assessed, high and critical counts) and `adjudicator security eval`
(the last saved eval). A model status of "needs adjudicator.enabled" or "unsupported" means only
the heuristic runs. A project `eminiar.config.json` that sets a security key other than
`enabled: true` is reported as ignored under the adjudicator project config check. Fixes are
`eminiar adjudicator security status`, `eminiar adjudicator security on|off`, `eminiar
adjudicator security on --model` (needs the adjudicator on with Jev, consent and a key) and
`eminiar adjudicator security eval --save`. `EMINIAR_ADJUDICATOR_SECURITY=0` forces it off.
