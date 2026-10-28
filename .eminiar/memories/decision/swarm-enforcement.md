---
name: decision/swarm-enforcement
kind: decision
status: accepted
tags: []
related: []
created: 2026-10-28T09:24:21.353Z
updated: 2026-10-28T10:15:45.007Z
---

Swarm enforcement (run 20261028-f66150, branch feature/agent-swarms / PR #32, v0.12.0, 2026-10-28; docs/swarms.md "Enforcement"). Opt-in through two top-level keys in .eminiar/swarm.yaml: `enforce: true` (default false) and `allowed_agents: [...]` (exact agent types, no swarm- entries, ignored unless enforce is on). While enforcing, PreToolUse(Agent|Task) (swarmPreAgent):
- Denies every subagent_type that isn't a configured role (an omitted type counts as general-purpose; Explore, Plan, fork, plugin agents and stale swarm-* types) unless allow-listed.
- Denies a configured worker when its swarm has no active run (reserveSpawn requireRun, code no_run).
- Denies every Agent call made INSIDE a subagent (agent_id set) unless allow-listed.
- Holds in every routing mode and skips Cursor.

WHICH FILE GOVERNS: enforcement and the SessionStart text come ONLY from the session root (sessionRoot(): CLAUDE_PROJECT_DIR, then EMINIAR_PROJECT_ROOT, then cwd) plus its coordinationRoot. A repo Claude cd's into never turns enforcement on or off; an earlier "any file enforces" rule let a cloned repo lock out a non-opted-in session. Tracking (swarmScope) is broader: session root first, then the hook cwd's root.

FAIL-CLOSED is in-process and only on positive evidence of enforce: true:
- An invalid file with an enforce line denies everything (enforceIntent: a line regex that agrees with the parser on true/True/TRUE, quoted keys, BOM, CRLF and comments; table in tests/unit/swarm-enforce-forms.ts).
- A check error denies; a busy DB gets a retry deny.
- A handler crash is caught by the dispatch.ts failClosed fallback.
- No node or no install: the bin/em-hook swarm_gate shim denies.
- Gap: a hook timeout or a crash at load still lets the call through.

Claude Code facts (hooks reference, 2026-10-28):
- `onFailure: "continue" | "block"` exists on command/http hooks since v2.1.295.
- eminiar does NOT set it in its plugin hooks.json, because a plugin entry applies to every user.
- For a hard guarantee, users add a project-level `.claude/settings.json` ^(Agent|Task)$ entry running `"$HOME/.eminiar/plugin/node_modules/eminiar/bin/em-hook" --gate` with onFailure block. --gate decides only: no reservation, no DB, exit 1 on any error. Running the full hook twice would double-reserve capacity.

Not covered:
- Skills with `context: fork` and other non-Agent dispatch paths (Workflow).
- A session STARTED inside a workspace sub-repo.
- Claude editing swarm.yaml itself (a permission rule denying Edit on it stops that).
