---
name: adjudicator/effort-follow-through
kind: decision
tags: []
related: []
created: 2026-11-11T18:51:50.205Z
updated: 2026-11-11T19:48:40.844Z
---

Effort follow-through (swarm run 20261111-7946b2, branch feature/adjudicator-effort-followthrough, 2026-11-11).

Finding: a per-call `effort` on the Agent call is honoured 44/44 (transcript `effort` field), but the adjudicator's effort was ADVISED ONLY: never compared with what ran, never in follow rate/stats. 65% of 125 dispatches passed no effort and ran on agent-file or session effort; advice matched only 42 of those 81 (high advised -> ran medium 22; max -> high 6). A subagent's meta.json `effort` only echoes the call; the real level is api_calls.effort (transcript).

Change: no schema change, everything in the scores JSON. New pure module src/adjudicator/effort.ts (keys passedEffort, effortEnv, agentEffort, actualEffort, effortFollow; dominantEffort, effortFollowOf, rowEffort, withEffortScores). learn.ts effortPatch writes actualEffort (dominant api_calls.effort) and effortFollow on agent rows; commit() now keeps those keys (withTaught(d.scores ?? row.scores, lesson)). Follow rule: not counted when no advice, ran unknown, fork, CLAUDE_CODE_EFFORT_LEVEL set, or saturated brief; followed when ran == advised OR the effort set for the call (passed ?? agent-file) == advised (a model lacking a level runs one lower); ignored otherwise. agent-pin.ts reads frontmatter `effort:` (same single file read); the Agent note says "the agent file already sets it" / "pass effort:'X' over the agent file's Y". Summary gains rates.effortFollow, effortFollowed, effortIgnored, effortIneffective, effortChecked; stats line, Adjudicator tab, decision chip "(ignored)".

Constraints worth keeping: (1) src/storage/sqlite/adjudicator.ts keeps a PRIVATE copy of the effort levels (scoresEffort) because the hooks-off test forbids any src/adjudicator import at boot; a store test fails if EFFORTS grows without it. (2) fork rows are never an effort mismatch. (3) The web typecheck used to pass only through a transitive @types/node leak (better-sqlite3 types via swarm.js); fixed: SwarmDecision* types are in the node-free leaf src/adjudicator/swarm-decision-types.ts and tsconfig.web.json has types:[] (keep src/ui/web free of node-typed imports).

RESOLVED 2026-11-11: the user decided apply mode ALWAYS sets effort, see [[adjudicator/apply-sets-effort]] (it supersedes the "hook never injects effort" rule in [[adjudicator/advise-respects-pins-and-agent-effort]]). Rows already final before this change get their effort verdict from the bounded backfill in reconcile (also in apply-sets-effort). The tsconfig.web.json types:["node"] workaround below was removed: the SwarmDecision* types now live in the node-free leaf src/adjudicator/swarm-decision-types.ts and types is [] again. Related: [[adjudicator/dispatch-rule-table]].
