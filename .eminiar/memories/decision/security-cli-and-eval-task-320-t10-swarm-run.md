---
name: decision/security-cli-and-eval-task-320-t10-swarm-run
kind: decision
tags: [adjudicator, security, cli, eval]
related: []
created: 2026-11-13T19:12:41.515Z
updated: 2026-11-13T19:12:41.515Z
---

Security CLI and eval (task #320 / T10, swarm run 20261113-bef5ea, branch feature/security-adjudication). `eminiar adjudicator security <status|on|off|test|explain|list|eval|help>` lives in src/adjudicator/security/cli.ts; adjudicator/cli.ts only delegates (args[0]==="security", before its own parseArgs) and passes Io, config loader, personal-file writer and trust check, so security/cli.ts imports only types from cli.ts. on/off write ONLY ~/.eminiar/config.json (--project refused, exit 2); `on --model` needs adjudicator on + Jev + consent + key, prints exactly what is sent (tool ids, capability tags) and asks y/N or --yes; it never grants consent. Eval harness src/adjudicator/security/eval.ts: heuristic always; Jev only via resolveEvalCandidates (consent+key) AND security.model "provider" AND adjudicator.enabled, otherwise skipped with the reason and no provider call. Metrics: per-level precision/recall, confusion matrix, warn (HIGH+) FNR/FPR, HIGH+ recall, LOW false-warn, CRITICAL precision, core vs debatable; mismatches by item id (no text). `eval --save` stores under SECURITY_EVAL_META_KEY (report.ts). Mismatches are reported, never fixed by changing labels or weights. Doctor: securityDoctorChecks adds "adjudicator security" and "adjudicator security eval" lines only when security is on, security.model is set, or an eval was saved (an untouched install shows no new line).
