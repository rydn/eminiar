---
name: adjudicator/hook-effort-probe
kind: fact
tags: []
related: [file:src/adjudicator/hooks.ts, file:src/adjudicator/types.ts]
created: 2026-11-11T19:33:38.808Z
updated: 2026-11-11T19:33:38.808Z
---

Empirical probe (task #222, swarm run 20261111-14ebfc, Claude Code 2.1.311, 2026-11-11): a PreToolUse hook's updatedInput.effort on an Agent call reaches the subagent. Ground truth is the transcript's api-request params.output_config.effort. It overrides the call's own effort and the agent-file `effort:`. It is overridden by the CLAUDE_CODE_EFFORT_LEVEL env var, which silently drops it. Forks silently ignore it and run at the parent's effort. A value outside low|medium|high|xhigh|max makes the whole Agent call FAIL ("updatedInput that failed schema validation"). haiku-5-5 and sonnet-5-5 accept xhigh and max. claude-haiku-4-5 sends no effort at all. An unknown extra updatedInput key is stripped, not rejected. The hook input carries no CLI version; the transcript_path records have "version". The hook input does carry `effort` (the session level), and CLAUDE_EFFORT is in the env. Versions below 2.1.292 were not tested.
