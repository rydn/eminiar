---
name: decision/bash-routing-per-segment
kind: decision
tags: [hooks, routing, bash, observability, stats]
related: [file:src/hooks/routing.ts, file:src/session/routing-stats.ts, file:src/tools/em_stats.ts, file:tests/unit/hooks.test.ts, file:docs/how-it-works.md]
created: 2026-10-26T21:20:00.000Z
updated: 2026-10-26T21:20:00.000Z
---

Bash routing precision (branch worktree-routing-precision, v0.9.1, 2026-10-26). Ryan saw eminiar deny more Bash commands after the knowledge-routing PR (v0.9.0). Measured from the Claude Code transcripts of 2026-10-26 (5 sessions, 23 Bash calls): 17 denied (74%), all to em_execute, one session 7/7. Replaying them through `suggest()` showed the same 17, and `git log -S` showed HEAVY_BASH / TINY_BASH / the pipe rule unchanged since the initial commit: not a regression of the rules, the rules were coarse and the model started composing more compound commands. The false positives fell into three classes: pipes ending in `| head` / `| tail` / `| wc` (the output is bounded by construction), `cat` of a few small source files (what Read shows natively anyway), and compound commands that commit or write a file (`git commit … | wc -l`, `cat >> file <<EOF … npx tsc | head`).

Decision: judge a Bash line one simple command at a time (`commandSegments`: split at `;`, `&&`, `||`, newlines outside quotes, heredoc bodies removed first), and classify each with `heavySegment`:
- a segment containing a mutation (`git commit/checkout/pull/…`, `npm install`, `rm`, `mv`, `sed -i`, a `>` redirection into a file) makes the whole command native: its output is secondary and the permission prompts live in Bash;
- `git log/blame/show/shortlog` anywhere → em_history (unchanged);
- a segment is bounded when its last pipe stage is `head`/`tail` (≤ 400 lines) or `wc`, or its first stage is `head`/`tail`, `sed -n 'A,Bp'` (≤ 400 lines), `du -s`, `grep -l/-c/-q`, `git log -1`, or `cat`/`grep` over named existing files within Read's limits (200 KB total, 20 KB for data extensions); globs, variables and directories are unknowable and stay heavy;
- otherwise the old rules apply per segment: HEAVY_BASH on the first stage, or an unknown source piped into `grep|sort|uniq|jq|less`. The denial reason names the heavy segment.
Replaying the 23 recorded commands: 3 routed instead of 17 (a `git diff`, a 420-line sed range into grep, and a cd + grep -r), with no new denial.

Observability: every routed native call (Bash, Read, Grep, WebFetch, WebSearch) records a `routing` session event {tool, decision allow|annotate|deny, target, rule, why, head}; `em_stats` / `eminiar stats` print "routing (session|project): Bash 3/23 denied (13%) … denied → em_execute ×3; by rule: heavy ×2, pipe ×1", and `~/.eminiar/hook.log` gets one line per denial. The `routing` category is P4 and never in the guide, like `recall`. Suggestions carry a `rule` label (heavy, pipe, big-read, history, symbol, content-grep) for this.

Not done: Grep tool routing is unchanged; `git diff <one file>` is still heavy; a `for … do … done` loop is split at its `;` so only its body commands are judged.
