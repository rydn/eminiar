---
name: swarm/worker-shell-tools
kind: decision
status: accepted
tags: [swarm, agents, tools, sandbox, routing]
related: [decision/agent-swarms-architecture, file:src/swarm/agents.ts, file:src/swarm/hooks.ts, file:src/hooks/routing.ts, file:docs/swarms.md, file:tests/unit/swarm-core.test.ts, file:tests/unit/swarm-hooks.test.ts]
created: 2026-11-08T17:24:42.318Z
updated: 2026-11-08T17:24:42.318Z
---

Swarm workers get em_execute, em_execute_file and em_batch_execute only when their role keeps Bash. Before, WORKER_EM_TOOLS added all three to every `tools` allowlist, so a `tools: [Read, Grep]` reviewer, or a role with `disallowed_tools: [Bash]`, could still run arbitrary code through them. Rule (src/swarm/agents.ts): roleHasShell(role) = (`tools` unset or lists `Bash`) and `Bash` not in `disallowed_tools`. workerTools adds EXEC_TOOLS only with shell. A role that disallows Bash also gets the six EXEC_TOOLS names (both MCP prefixes) in `disallowedTools`, because a role with no `tools` list inherits every MCP tool. Exactly `Bash` counts, as exact `Agent`/`Task` do for nested spawns; PowerShell is not routed, so it is not treated as shell here.

Routing side (needed, not optional): in enforce mode routing denies a big Read toward em_execute_file and a content Grep toward em_execute. A worker without those tools would be stranded, so route() checks workerLacksTool(input, agentType, tool) and lets the native call through (`allow`, why `no-shell`), the same reasoning as the no-server fallback. The Agent spawn prefix (subagentPrefix) leaves the runners and Bash out for such a worker too. workerLacksTool reads swarm files through swarmRoots(input) only (pure fs, no ProjectContext, no database) so it finds a nested repo's swarm whatever context route() is handed. `disallowed_tools: [Edit, Write, NotebookEdit]` (the READ_ONLY templates) still keeps Bash and the runners; that label means "no file tools", not "no writes". This covers eminiar's runners only: a role without a `tools` list inherits every MCP tool, including other servers' runners (context-mode's ctx_execute), so a role that must have no shell needs a `tools` allowlist. `disallowed_tools: [Bash(rm:*)]` is not `Bash`, so that role keeps the runners.
