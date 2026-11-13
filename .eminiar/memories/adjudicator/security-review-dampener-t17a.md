---
name: adjudicator/security-review-dampener-t17a
kind: decision
tags: [security, adjudicator, review-context, floors]
related: [file:src/adjudicator/security/signals.ts, file:src/adjudicator/security/score.ts, file:src/adjudicator/security/assess.ts]
created: 2026-11-13T20:45:34.974Z
updated: 2026-11-13T20:45:34.974Z
---

Security review-context dampener contract (task #338, swarm run 20261113-bef5ea, branch feature/security-adjudication, 2026-11-13). T17a found one review word ('(audit log)' in a task, or 'audits code' in an agent/role description) cleared CRITICAL/HIGH floors. Decision: (1) review wording counts only in the task's own text: signals.ts extractAll(task, opts, context) takes descriptions as `context` (cues count, review wording never); assess.ts ScoreInput has `task` (title/detail, Agent call description+prompt, typed prompt, try-it text) and `texts` (grant.description only), both optional, so a caller passing only `texts` (swarm-risk roleRisk) gets no dampening. (2) review-context is added only when the MERGED intent set of all texts is empty. (3) score.ts evaluate(): with review-context the floors come from a second evaluate() of the same input without it; review wording lowers only the score/band (REVIEW_DAMPEN 0.5), never a floor. Trade-off: a genuine review task whose grant + cues complete a floor rates as high as without the wording (eval set: no item changed). (4) 'tests for|that / write tests' need a flaw noun (vulnerab, inject, leak, exfil, xss, csrf, ssrf, 'security bugs/issues'); 'review / scan for' keep the broad noun list; 'audit log/trail/event/entry/record/table' is a noun, not review. Do not reintroduce dampening into findFloors. Also #340: URL_CHAR excludes | ; backtick so blankUrls leaves '|sh' for pipeShell, and PIPE_TO accepts sudo flags, env, /bin/, /usr/bin/env.
