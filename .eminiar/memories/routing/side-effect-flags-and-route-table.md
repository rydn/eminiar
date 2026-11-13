---
name: routing/side-effect-flags-and-route-table
kind: decision
tags: [routing, security, context-savings]
related: [file:src/hooks/routing.ts, file:tests/unit/routing-regression.test.ts, file:tests/unit/hooks.test.ts]
created: 2026-11-09T21:15:20.290Z
updated: 2026-11-09T21:15:20.290Z
---

Bash routing (src/hooks/routing.ts, PR #46 fix 9f0b44d, 2026-11-09): side-effect forms of reader commands are closed by targeted denials (FLAG_WRITES per tool on shell words with quotes removed; CHANGES per tool with cwd; GIT_ENV), never by un-routing the read form. tests/unit/routing-regression.test.ts pins 194 ordinary read commands to the routes the branch head returned before the fix; any change to a row is a change to eminiar's context savings and must be deliberate. Intentional moves: `npx tsc` routes only with --noEmit or a tsconfig containing "noEmit": true; cat/grep operands are sized at the `cd` target. Cost bounds: raw >64 KB, classified >8 KB, >64 commands -> native; cd / git -C / $() levels capped at 16; heredoc stripping is a one-pass scan equal to the old regex (fuzz test). Unpairable or too-deep $(...) -> native; kubectl/docker options outside VALUE_OPTS/FLAG_OPTS are read both ways.
