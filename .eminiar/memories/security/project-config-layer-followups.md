---
name: security/project-config-layer-followups
kind: todo
tags: [security, config, followup]
related: [file:src/config.ts, file:bin/_resolve.sh]
created: 2026-11-04T14:07:52.957Z
updated: 2026-11-08T17:00:00.000Z
---

Pre-existing project-config trust issues found by swarm run 20261104-483f39 security review #71 (2026-11-04), present on main before the adjudicator and NOT fixed on branch feature/adjudicator (out of scope; needs its own PR):
1. A committed eminiar.config.json with {"permissions":{"extraDeny":[]}} wipes the user's personal extraDeny list, because project-layer arrays replace personal arrays in deepMerge (src/config.ts). Confirmed.
2. The project file can add entries to sandbox.envAllow (e.g. GITHUB_TOKEN), exposing that env var inside em_execute's sandbox.
3. Any schema error in the project file makes loadConfig fall back to defaults for the WHOLE config, discarding the user's personal settings.
4. (test hygiene, also on main) `npm test` writes em_history stats into whatever EMINIAR_HOME it runs under and creates projects/h and projects/test there; with no EMINIAR_HOME set that is the developer's real ~/.eminiar (seen by review #80). tests/setup-env.ts should point EMINIAR_HOME at a per-run temp dir.

Update 2026-11-08 (branch fix/team-template-keeps-personal-lists): `eminiar install --team` no longer writes list keys. It wrote `permissions.extraDeny: []` (item 1, from eminiar itself), a `graph.exclude` missing 7 current defaults, and `index.docs: ["**/*.md", "docs/**"]`, which dropped the default `**/*.mdx`. The template is now `$schema` + `routing`, and tests/unit/install.test.ts asserts it holds no arrays. docs/configuration.md says that lists replace; its example sets no list, and adding an exclude shows the full list. Merge semantics are unchanged, so item 1 is still open for a hand-written project file.

Suggested direction: apply the same allowlist idea as the adjudicator's PROJECT_ADJUDICATOR_KEYS to security-relevant sections (permissions, sandbox env), merge deny lists additively (project can only add denies), and on a project-layer schema error drop only the project layer. Context: a trusted .claude/settings.json env block already allows code execution (NODE_OPTIONS, EMINIAR_HOME + .em/node-path read by bin/_resolve.sh), so env-block findings are defense in depth; committed eminiar.config.json is the cheaper attack surface. Probes: scratchpad w71/probes/p-xd.mts (session-local).
