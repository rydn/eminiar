---
name: decision/usage-insights-no-proxy
kind: decision
tags: [usage, cost, insights, gateway]
related: []
created: 2026-10-26T20:56:43.971Z
updated: 2026-10-26T20:56:43.971Z
---

Usage insights scope (2026-10-26, branch feature/usage-insights): eminiar gets per-model-call depth (tokens, cache, cost, savings, usage patterns, insights) from passive sources only: transcript JSONL tailing, statusline snapshots, hooks, and optionally Claude Code's OTEL export. The proxy gateway at ANTHROPIC_BASE_URL was researched (see gateway/usage-data-sources-research) and explicitly rejected by Ryan: no model routing, no multi-account, no request interception. Reasons: it puts eminiar in the user's API path (failure risk, OAuth/header passthrough rules, managed allowedProviders), and the passive sources already carry per-request usage. Per-request latency and HTTP status are therefore out of scope unless OTEL is enabled.
