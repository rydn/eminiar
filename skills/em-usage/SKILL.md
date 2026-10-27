---
name: em-usage
description: Show token, cache and cost insights for Claude Code sessions (cost today / this week, cache hit rate, per-model and per-session breakdowns, 5-hour billing blocks and burn rate, the context timeline of a session, which tools fill the context, detected insights with scores, and what eminiar saved), from the transcripts on this machine.
user-invocable: true
allowed-tools: mcp__plugin_eminiar_eminiar__em_usage
---

Call `em_usage` and show the result verbatim. Map what the user asked for onto the view:

- nothing, "usage", "cost", "how much" → `view: "summary"` (project scope)
- "this session", "my session" → `scope: "session"`
- "per day" / "per week" / "per month" → `daily` / `weekly` / `monthly`
- "which model", "models" → `models`; "sessions" → `sessions`; "blocks", "5-hour", "burn" → `blocks`
- "context", "turns", "compactions" → `scope: "session", view: "turns"`
- "which tools", "what fills the context" → `tools`
- "insights", "what should I change", "why is it expensive" → `insights`
- "what did eminiar save" → `savings`

Pass `since` when the user names a period (`30d`, `12h`, an ISO date). Costs are estimates at
list price and everything stays local. Do not add commentary beyond one line; if an insight has a
recommendation, that line is the recommendation.
