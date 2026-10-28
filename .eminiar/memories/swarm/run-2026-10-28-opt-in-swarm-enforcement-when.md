---
name: swarm/run-2026-10-28-opt-in-swarm-enforcement-when
kind: note
tags: [swarm, feature]
related: [src/swarm/config.ts, src/swarm/types.ts, src/swarm/hooks.ts, src/hooks/routing.ts, src/swarm/runtime.ts, hooks/hooks.json, src/swarm/format.ts, src/swarm/cli.ts, docs/swarms.md, docs/configuration.md, tests/unit/swarm-core.test.ts, tests/unit/swarm-hooks.test.ts, src/hook.ts, bin/em-hook, src/hooks/dispatch.ts, src/project.ts, src/hooks/session-start.ts, vitest.config.ts, tests/unit/hooks.test.ts, tests/unit/recall.test.ts]
created: 2026-10-28T10:15:45.481Z
updated: 2026-10-28T10:15:45.481Z
---

Swarm run 20261028-f66150 (swarm "feature", hierarchical, 2026-10-28): done.
Goal: Opt-in swarm enforcement: when .eminiar/swarm.yaml turns it on, eminiar's own PreToolUse(Agent/Task) hook denies every subagent dispatch that is not a configured swarm worker (swarm-<swarm>-<role>), with a deny message that says which swarm to use and how to start a run; SessionStart tells Claude the rule up front; enforcement fails closed. Ships in the plugin hooks so it holds in every Claude Code session of the project, replacing the user's hand-written .claude/hooks/require-swarm-subagent.sh + settings.local.json approach.
Outcome: Shipped on feature/agent-swarms (PR #32, v0.12.0).

(1) Root-cause fix for swarm tracking. Swarm hooks resolved the ledger from the hook cwd, so a coordinator that cd'd into a nested repo of a multi-repo workspace lost every spawn, worker and tool count. The dashboard showed tasks done with 0 workers. Hooks now resolve from the session root first (CLAUDE_PROJECT_DIR, then EMINIAR_PROJECT_ROOT), and the em_swarm stamp hook fills project_root so the MCP server uses the same ledger.

(2) Opt-in enforcement: `enforce: true` and `allowed_agents` in swarm.yaml.
- Non-worker subagents, workers without an active run, and nested Agent calls are denied.
- It is decided only by the session root's swarm file.
- It fails closed in-process: an invalid file with intent, check errors, the dispatch fallback, and the no-node shim.
- `em-hook --gate` is a decide-only check for an optional project-level onFailure:block entry.
- Generated workers disallow the Agent tool, so they are leaves.

Two adversarial review rounds: 14 findings fixed (#8–#15, #17–#22). Verified with build, typecheck, biome, and npm test 590 passed / 1 skipped (pre-existing). The shim passes sh -n and dash -n, and its exec path is unchanged.

Not covered (documented): context:fork skills, the Workflow tool, sessions started inside a workspace sub-repo, and a hook timeout or crash at load.
22 task(s), 12 worker(s), 67 min.
- #1 [done] (architect) Design opt-in swarm enforcement (config schema, hook semantics, fail-closed, session guidance) — The design is posted on the blackboard under three keys, split to fit the 8000-character note limit: "design" (v2: schema, hook rule, resolver contract with #6, Cursor, task split), "design-texts" (e…
- #2 [done] (coder) Config schema, types, starter YAML, list/validate output and docs for swarm enforcement — enforce/allowed_agents schema, types, enforceIntent, list/validate output, docs/swarms.md Enforcement section. typecheck clean; swarm-core + swarm-tool 38/38 pass.
- #3 [done] (coder) Enforce swarm-only subagents in PreToolUse(Agent/Task) and announce it at SessionStart — Enforcement deny path, fail-closed matrix, texts, swarmRoots, requireRun/no_run, dispatch fallback, client:cursor and shim gate implemented. typecheck clean; unit suite 482/482 incl. new enforcement …
- #4 [done] (tester) Tests pinning swarm enforcement — Added enforcement tests to swarm-core.test.ts and swarm-hooks.test.ts. npm test: 41 files passed, 1 skipped (it was already skipped); 535 tests passed, 1 skipped. typecheck clean, biome clean on both…
- #5 [done] (reviewer) Adversarial review of the swarm enforcement diff — Reviewed the full 14-file diff and filed 8 coder tasks. 1 HIGH: #8, nested subagents bypass enforcement; Claude Code allows 3 levels by default and workers keep the Agent tool. 5 MEDIUM: #9 Skill con…
- #6 [done] (coder) Swarm hooks resolve the ledger from the session project root, not the drifted shell cwd — swarmScope and swarmSessionStart now try the session root first, then the hook cwd root. New test fails without the fix. Unit suite: 38 files, 481 tests pass. tsc and biome clean.
- #7 [done] (coder) em-hook --gate: decision-only enforcement check for a project-level onFailure:block entry — em-hook --gate added (swarmGate in hooks.ts, gate() in dispatch.ts, exit 1 handling in hook.ts, shim exit 1 in gate mode). notWorkerText now shrinks the swarm list so enforce: false survives. Docs up…
- #8 [done] (coder) HIGH: nested subagents bypass enforcement (agent_id calls are never checked) — nestedText + nested enforcement in swarmPreAgent/swarmGate/dispatch failClosed; tests flipped; vitest unit 562 pass
- #9 [done] (coder) MEDIUM: Skill context:fork (and other non-Agent dispatch paths) run subagents unenforced; docs claim everything is blocked — docs/swarms.md: fixed "everything else" claim, added not-covered (context:fork, Workflow), nested calls, governing rule, root order, line-reading rule. #15 config/format doc comments fixed. #8 shim+a…
- #10 [done] (coder) MEDIUM: inherited EMINIAR_PROJECT_ROOT overrides CLAUDE_PROJECT_DIR in hooks, so a nested claude session in a non-opted-in project gets another project's enforcement — sessionRoot(): CLAUDE_PROJECT_DIR > EMINIAR_PROJECT_ROOT > cwd in src/swarm/hooks.ts; test added; unit 562 pass
- #11 [done] (coder) MEDIUM: an enforcing sub-repo file overrides the workspace swarm after a cd, so the workspace's own workers are denied — enforcementFor/rawEnforced: first candidate with a swarm file decides; both-direction tests pass
- #12 [done] (coder) MEDIUM: enforce parse divergence (zod vs enforceIntent/rawEnforced vs shim) fails open on True/quoted/flow YAML — enforceIntent rewritten (true/True/TRUE, quoted keys, BOM, CRLF, space before colon, trailing comment; enabled false/False/FALSE); shim uses the same rule, worktree follow, agent_id denied, CLAUDE_PR…
- #13 [done] (coder) MEDIUM: tests depend on the ambient EMINIAR_PROJECT_ROOT/CLAUDE_PROJECT_DIR; 3 tests fail when the session root enforces — tests/setup-env.ts (deletes both vars) wired via setupFiles in vitest.config.ts. hooks.test.ts + recall.test.ts: 3 fail with the vars pointing at an enforcing project before the setup file, 30/30 pas…
- #14 [done] (coder) LOW: enforcement reserves with a trimmed subagent_type but PostToolUse releases with the raw one, so the reservation leaks for 2 min — spawnType() trims once for reserve and release; test with trailing-space type then PostToolUseFailure then clean retry passes
- #15 [done] (coder) LOW: displaced/stale doc comments from the diff — Comment fixes landed in both lanes (hooks.ts header and doc comments; config.ts parseSwarmYaml/enforceIntent; format.ts formatSwarmList). Verified by the round-2 reviewer (#16).
- #16 [done] (reviewer) Second adversarial pass: verify fixes #8-#15 and hunt regressions they introduced — Round 2 is done. The fixes for #8, #9, #10, #11, #12, #13 and #14 are verified by re-running the round-1 probes plus new ones in scratchpad/probe. #15's edits are in the tree, but the task was never …
- #17 [done] (coder) MEDIUM: enforcement follows the cwd into a repo the session never opted into (unsatisfiable deny) — Enforcement, rawEnforced, swarmGate and SessionStart (incl. agent file sync) now use enforcementRoots() = sessionRoot + its coordinationRoot only. Tracking keeps cwd fallback. New tests added; full s…
- #18 [done] (coder) LOW: SessionStart announces enforcement that PreToolUse does not apply (and syncs agent files into a sub-repo) — swarmSessionStart now looks at the session root only (no fall-through to the cwd root); test for enabled:false session root + enforcing sub-repo: no enforcement sentence, no .claude/agents in sub. ro…
- #19 [done] (coder) LOW: workers lose Agent even without enforce; a role's tools: [Agent] is silently overridden — agents.ts: Agent added to disallowedTools unless role tools lists Agent/Task; key omitted when empty. Tests pin both cases; docs under Generated agent files.
- #20 [done] (coder) LOW: nestedText tells non-worker subagents to use em_swarm plan, which em_swarm refuses them — nestedText reworded per coordinator: subagents can't start subagents under enforcement; finish and report back to the main session, which can start a run or spawn workers; em_swarm plan mentioned onl…
- #21 [done] (coder) LOW: hooks and MCP server resolve different projects in a nested claude, so an enforcing project can never start a run — swarmStampCaller fills project_root with sessionRoot() when absent/empty, never overriding an explicit one. Server strips project_root generically (server.ts) and the HMAC covers only caller fields, …
- #22 [done] (coder) LOW (optional, no-node shim only): bin/em-hook root walk diverges from node in three exotic layouts — bin/em-hook swarm_gate: marker walk-up, no-gitdir/no-commondir skip, CR strip; 3 shim tests; exec path unchanged; 568 tests pass.
