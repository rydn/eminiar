---
name: em-search
description: Search everything eminiar has indexed (sandbox outputs, files, docs, fetched pages, memories, session history) with hybrid keyword + semantic search.
user-invocable: true
argument-hint: <query> [--timeline] [--source name]
allowed-tools: mcp__plugin_eminiar_eminiar__em_search, mcp__plugin_eminiar_eminiar__em_recall
---

Run `em_search` with the user's query: $ARGUMENTS

- Split a compound question into several `queries` — one call, one round trip.
- `--timeline` or "what did we do" style questions → `sort: "timeline"`.
- Questions about past decisions, constraints or errors → also call `em_recall`.
- A pattern (`--regex`, or something with `\(`, `\d`, `|`) → `mode: "regex"`.

Summarise the hits briefly and cite `doc N` ids so the user can drill in.
