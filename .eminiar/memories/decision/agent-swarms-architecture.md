---
name: decision/agent-swarms-architecture
kind: decision
status: accepted
tags: [swarm, agents, hooks, architecture]
related: []
created: 2026-10-27T22:14:55.304Z
updated: 2026-10-27T22:14:55.304Z
---

Agent swarms architecture (branch feature/agent-swarms, v0.12.0, 2026-10-28; spec docs/design/agent-swarms.md). The main Claude Code session is the coordinator because subagents cannot spawn subagents. Workers are project agent files `.claude/agents/swarm-<swarm>-<role>.md` GENERATED from `.eminiar/swarm.yaml` (frontmatter emitted with the yaml lib; files carry an `eminiar:swarm` marker and sync never touches unmarked files). Project agents, not plugin agents, because plugin agents ignore frontmatter `hooks`. Coordination state (runs, tasks, workers, events, blackboard notes, spawn reservations) lives in the project SQLite DB (migration 7) behind `db.swarm`, a sub-store so the hot StorageAdapter interface only gains one property. Hooks do the integration: PreToolUse(Agent) enforces max_agents/count with spawn reservations in an immediate transaction; PreToolUse(em_swarm) stamps caller agent_id/agent_type via updatedInput; SubagentStart registers the worker, hands off `task #N` named in the spawn prompt and injects a knowledge brief (memories, history risk, structure, hot files); PostToolUse records activity; SubagentStop closes the worker and auto-closes a held task (flagged auto_closed). Topologies are real claim policies: hierarchical (role must match), mesh (anyone), pipeline (earliest unfinished stage). Opt-in: no YAML or `enabled: false` means every path no-ops. When a role lists `tools`, em_* tools are appended under both MCP name forms so routing never strands a worker.
