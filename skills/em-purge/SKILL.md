---
name: em-purge
description: Permanently delete eminiar data for this project (index, sessions, graph, memories, usage or all).
user-invocable: true
disable-model-invocation: true
argument-hint: <index|sessions|graph|memories|usage|all>
allowed-tools: mcp__plugin_eminiar_eminiar__em_purge
---

The user asked to purge: $ARGUMENTS

This cannot be undone. State exactly what will be deleted for the requested scope and ask for an
explicit "yes" before calling `em_purge { scope, confirm: true }`. Without a scope, ask which one.
