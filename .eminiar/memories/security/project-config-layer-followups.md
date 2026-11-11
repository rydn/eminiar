---
name: security/project-config-layer-followups
kind: todo
tags: []
related: []
created: 2026-11-04T14:07:52.957Z
updated: 2026-11-11T20:09:48.483Z
---

Project-config trust issues found by swarm run 20261104-483f39 security review #71 (2026-11-04). Status as of 2026-11-11 (main 0.14.5; PRs #58, #65 merged, #66 open):
1. DONE (#58): a project `permissions.extraDeny: []` no longer wipes the personal list; extraDeny, sandbox.disabledLanguages and graph.exclude are additive across layers (ADDITIVE_LISTS in src/config.ts), and graph.exclude takes "!<entry>" to drop a built-in default.
2. DONE once PR #66 merges (decided by Ryan 2026-11-11): a project eminiar.config.json, or a personal config the repo plants (EMINIAR_HOME pointed into the project, personalConfigTrusted false), has the whole sandbox.envAllow key ignored with a stderr note (withoutEnvAllow in src/config.ts). #65 had dropped only the withheld names (ANTHROPIC_*, CLAUDE_*, OPENAI_*, *_API_KEY, EMINIAR_PLUGIN*). Behaviour change: a team that committed envAllow for ordinary names must put them in each developer's ~/.eminiar/config.json.
3. DONE (#58): a schema error in one layer drops only that layer.
4. (test hygiene) `npm test` writes em_history stats into whatever EMINIAR_HOME it runs under; tests/setup-env.ts should point EMINIAR_HOME at a per-run temp dir. Not checked since 2026-11-08.

Why: a cloned repo must not choose which of the user's secrets reach its own scripts.
How to apply: before touching src/config.ts layering or src/sandbox/env.ts, re-read ADDITIVE_LISTS, withoutEnvAllow and personalLayer; a new security-relevant list belongs in ADDITIVE_LISTS, and a new key that decides what the sandbox can see belongs in the personal layer only. Once #66 is merged, change item 2's "once PR #66 merges" to done.
