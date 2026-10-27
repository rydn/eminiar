---
name: decision/cursor-support
kind: decision
tags: [cursor, hooks, install, clients]
related: [file:src/hooks/cursor.ts, file:src/hooks/dispatch.ts, file:src/install/cursor.ts, file:hooks/cursor.json, file:.cursor-plugin/plugin.json, file:rules/eminiar.mdc]
created: 2026-10-26T20:11:23.117Z
updated: 2026-10-26T20:11:23.117Z
---

Cursor support (branch feature/cursor-support, 2026-10-26). `npx eminiar install --cursor` registers eminiar with Cursor the native way: eminiar hook entries in ~/.cursor/hooks.json (9 events), the MCP server in ~/.cursor/mcp.json, skills copied to ~/.cursor/skills/ (src/install/cursor.ts; CURSOR_CONFIG_DIR overrides ~/.cursor for tests). Without the `claude` CLI and no --method, --cursor installs for Cursor only (install record method "none"). uninstall/upgrade/doctor replay or check the Cursor side from install.json `wrote.cursor`. `--team --cursor` also writes .cursor/rules/eminiar.mdc (copied from rules/eminiar.mdc).

Hook protocol: one bin/em-hook for both clients. src/hooks/dispatch.ts picks the dialect from `--client cursor` or detects it from the payload (cursor_version, workspace_roots, conversation_id, camelCase event). src/hooks/cursor.ts maps events (sessionStart→SessionStart, beforeSubmitPrompt→UserPromptSubmit, preToolUse/postToolUse/postToolUseFailure, subagentStop, preCompact, afterAgentResponse→Stop (Cursor's `stop` has no text), afterFileEdit→PostToolUse/Edit, sessionEnd), fields (conversation_id→session_id, workspace_roots[0]→cwd, Shell→Bash, MCP:x→mcp__cursor__x, tool_output JSON string→tool_response, duration→duration_ms, error_message→error, text/summary→last_assistant_message) and output (hookSpecificOutput→flat permission/agent_message/updated_input/additional_context/continue/env).

Why "parked context": Cursor's beforeSubmitPrompt accepts only `continue` and preToolUse only a permission, so recalled memories / file knowledge / routing hints are stashed per session (~/.eminiar/projects/<id>/pending-context/<session>.json, 10 min TTL, deduped, 8 KB cap) and delivered as additional_context on the next postToolUse/postToolUseFailure. preToolUse must always answer with a `permission` (an unknown shape blocks the call). Enforce routing denies in Cursor only when ~/.cursor/mcp.json names em-server (cursorHasServer), otherwise it allows and parks the hint — the "never strand the model" rule.

Rejected: installing via ~/.cursor/plugins/local (needs a real copy not a symlink, and an enterprise setting) and project-level .cursor/hooks.json (command path is not portable, npx per hook is too slow). Kept: .cursor-plugin/plugin.json + .cursor-plugin/mcp.json + hooks/cursor.json + rules/ so the repo is also a valid Cursor plugin for a future marketplace listing; scripts/sync-plugin-version.mjs keeps both manifests at the package version. Cursor also imports Claude Code hooks from ~/.claude/settings.json by default (Third-Party Imports), so with --method settings each event fires twice there; doctor flags it.
