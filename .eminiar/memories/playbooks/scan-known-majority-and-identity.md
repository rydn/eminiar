---
name: playbooks/scan-known-majority-and-identity
kind: decision
tags: [playbooks, extraction, known-check]
related: [file:src/playbooks/extract.ts, file:tests/unit/playbooks-r2-extract.test.ts]
created: 2026-11-11T20:50:14.918Z
updated: 2026-11-11T20:50:14.918Z
---

Playbook scan "known" check (swarm run 20261111-e068a8, tasks #270/#271, branch feature/run_book-r2-extract, commit e3bbcd8, 2026-11-11), src/playbooks/extract.ts Known/identityOf.
- A mined cluster is known (not proposed) when its signature was proposed before OR when MORE THAN HALF of its prompts (per prompt, duplicates counted) match a past suggestion on a shared server: full fingerprint, a kept short prompt id, >=0.5 word Jaccard with the stored prompt or the kept core words, or embeddings dot >= 0.82. A tie is new. Rejected: any-member match (one stray prompt that names a dismissed task hid new tasks: 3-15% false suppression) and rep-only match (forgets the rest of the cluster).
- A suggestion's evidence string (no schema change, store caps it at 500 chars) is `sig:<16hex> seen in N sessions on D days; servers: a, b; words: <core words>; ids: <8-hex ids>`. Core words = top 8 tokens that MORE than half the evidence prompts share (a stray prompt's own words must not enter: that caused first-scan misses). ids = short playbookFingerprint of the representative then member texts by frequency, as many as fit. A scan's in-memory add() uses exactly what is persisted. Old evidence without words/ids still works (sig + prompt only).
- In embeddings mode, past suggestion prompts that share a server with any candidate are re-embedded each scan (newest 1000), so a rewording the model groups with a dismissed task stays known after its old prompts leave the 3000-prompt window.
- Known limit (accepted): in word mode a rewording sharing < half its words with the stored prompt, the core words and every kept id is a different task (0.5-1% resurrection in the benchmark).
- Benchmark: scratchpad r2x/bench.ts (seeded, 15 tasks, rewordings, strays, window slide), r2x/ab.mjs (A/B and mutants); tests in tests/unit/playbooks-r2-extract.test.ts kill every mutant.
