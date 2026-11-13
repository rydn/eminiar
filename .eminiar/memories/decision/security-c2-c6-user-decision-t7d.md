---
name: decision/security-c2-c6-user-decision-t7d
kind: decision
status: accepted
tags: [adjudicator, security, floors, eval]
related: [file:src/adjudicator/security/score.ts, file:src/adjudicator/security/taxonomy.ts, file:tests/unit/adjudicator-security-score.test.ts, file:src/ui/web/views/security-helpers.ts]
created: 2026-11-13T19:47:06.918Z
updated: 2026-11-13T19:47:06.918Z
---

The user decided two floor questions on 2026-11-13 (task #332 / T7d, swarm run 20261113-bef5ea, branch feature/security-adjudication).

(1) C2 (trifecta, every leg >= .8) now also needs the sensitive read or the egress to come from the task text at >= .8: max(caps.S.task, caps.E.task) >= LEG_STRONG, in score.ts findFloors. Grant-only strong legs (SaaS read S 1, SaaS write E 1, browser S 1/E 1) stay HIGH. They still reach CRITICAL through C1 when the run is autonomous. A task-text push/post/credential cue keeps C2. Review wording halves the cue below .8.

(2) C6_INTENTS = ignore-instructions, exfiltrate, conceal (taxonomy.ts). disable-safeguards is deliberately NOT a C6 intent, because "--no-verify" and "skip the hooks" are routine.

Eval after the change: core accuracy 98.1%, HIGH+ recall 100%, CRITICAL precision 100%, LOW false-warn 0, HIGH+ false positives 0/27. The 3 remaining mismatches are expected: high-07 (debatable, task "post" keeps C2), high-12 (debatable, D11 em_remember W* .4) and crit-11 (disable-safeguards is not C6).

src/ui/web/views/security-helpers.ts RULE_LABEL duplicates the C2 and C6 notes and needs updating by the ui role.
