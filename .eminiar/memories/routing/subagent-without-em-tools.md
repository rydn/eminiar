---
name: routing/subagent-without-em-tools
kind: fact
tags: [routing, subagent, enforce, gotcha]
related: []
created: 2026-10-27T22:12:17.671Z
updated: 2026-10-27T22:12:17.671Z
---

Routing gotcha (2026-10-28): in enforce mode eminiar's PreToolUse hook denies native WebFetch/Bash/Read inside subagents whose toolset has NO em_* tools (seen with the built-in `claude-code-guide` agent: tools Bash, Read, WebFetch, WebSearch). The denial tells it to retry with em_fetch_and_index, which it cannot call, so it is stranded and falls back to WebSearch snippets. Hook stdin carries `agent_type` for calls made inside a subagent, so routing can tell. Swarm agents avoid this because generated agent files always add the em_* tools to any `tools` allowlist. A general fix (skip denial for agent types known to lack MCP tools) is still open.
