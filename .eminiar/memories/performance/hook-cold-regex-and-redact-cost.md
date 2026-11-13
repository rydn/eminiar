---
name: performance/hook-cold-regex-and-redact-cost
kind: constraint
tags: []
related: []
created: 2026-11-09T23:29:10.889Z
updated: 2026-11-09T23:29:10.889Z
---

Hook processes are one-shot, so each regex the path touches pays its V8 parse and compile once per hook (0.1–0.3 ms for a large alternation such as routing's MUTATING or RUNNER). A Unicode property literal such as /\p{Default_Ignorable_Code_Point}/gu builds its set when the module is parsed (~0.19 ms) even if it never runs. Any module that capture.ts, classify.ts or indexer.ts import lands in the eager hook chunk, which every PreToolUse pays for. Keep the bash/prompt hooks within 1 ms p50 of main (scripts/bench-hotpath.mjs --only hooks --base <main build> --assert) as follows. (1) Gate big regexes behind a cheap exact necessary condition, such as a literal includes() or a first-word Set. (2) Build rarely used Unicode-property regexes lazily with new RegExp(). (3) Do not pull adjudicator-only code into the eager chunk. Found in task #128 (run 20261109-82e284, 2026-11-10): #46 cost +0.8–1.3 ms and #54 cost +0.3–0.8 ms on the bash hook. The fixes cut the merged tree from +1.6–1.8 to +0.72–0.84 ms. redactSecrets on 780 KB of output took 13.4 ms; a SECRET_HINT check before isSecretName, an atomic name match in ASSIGN_NAME ((?=(x+))\1) and literal needles for 4 rules brought it to 8.6 ms with identical output.
