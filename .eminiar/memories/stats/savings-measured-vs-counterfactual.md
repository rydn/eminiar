---
name: stats/savings-measured-vs-counterfactual
kind: decision
tags: []
related: [file:src/usage/savings.ts, file:src/tools/em_stats.ts, file:src/stats/statusline.ts, file:src/ui/web/views/Usage.tsx]
created: 2026-11-09T21:33:28.712Z
updated: 2026-11-09T21:33:28.712Z
---

Token savings are labelled as estimates and split by kind (swarm run 20261109-0b73c5, task #85, branch fix/coexist-and-savings, 2026-11-09). All savings are chars/4 estimates shown with "≈". src/usage/savings.ts savingsKind(tool) is the single classification: "measured" = em_execute, em_execute_file, em_batch_execute, em_fetch_and_index (output really produced and kept out); everything else, including unknown/new tools, is "counterfactual" (raw = what a native Read/Grep/git call might have returned, e.g. every file a graph answer touches, every whole search chunk; can overstate). splitSavings nets each kind over its own rows, floored at 0; pricedSavings returns measuredTokens + counterfactualTokens summing to savedTokens. No schema change: derived from the stats rows' tool name. A new tool that records real output must be added to MEASURED_TOOLS. Not done: capping graph-tool raw counts; em_usage text, dashboard Overview/Sessions still unlabelled.
