---
name: security/redact-linear-and-purge-secure-delete
kind: decision
tags: [security, redaction, performance, purge, pr-54]
related: [file:src/adjudicator/redact.ts, file:src/capture/classify.ts, file:src/storage/sqlite/adapter.ts, file:tests/unit/adjudicator-redact.test.ts, file:tests/unit/purge-residue.test.ts, file:tests/unit/stored-stderr-mask.test.ts]
created: 2026-11-09T21:29:56.131Z
updated: 2026-11-09T21:29:56.131Z
---

PR #54 (branch fix/mask-stored-secrets, swarm run 20261109-82e284 task #61, head 2a214c0, 2026-11-09).

(1) Redaction regexes must never put two space quantifiers next to each other (`[ \t]*:?[ \t]+`, `[ \t]*=?[ \t]*`) or start a run match at every position (`[ \t]+$` with /m): they are quadratic, 1-18 s on 100 KB. Use `(?:[ \t]*:)?[ \t]+`, `[ \t]*(?:=[ \t]*)?` and a `(?<![ \t])` lookbehind. maskYamlBlocks builds a new array (splicing each block out was quadratic: 0.5 s at 16k blocks, 10 s at 64k).

(2) Assignment values are read by readValue() trying sticky ASSIGN_VALUES in order: escaped quotes (`\"x\"`, separator may follow up to 8 backslashes), one-line quoted up to 4096 chars, multi-line quoted only when its lines hold no whitespace and the closing quote ends the line/item (so `print("password: ")\nfoo()` is kept), an unclosed quote only when over 4096 chars or running to the end of the text (a clipped value), then bare. The old 512-char cap is gone (memory adjudicator/redact-rules still says 512).

(3) STORED/RULES additions: URL passwords holding `/` (not a `:port/`) or `@` (to the last `@` before the host, never past `/?#`), Azure SAS `[?&;]sig=`, Twilio `SK|AC` + 32 hex, and a TOKEN_SHAPES rule that base64-decodes a value after `:` and masks it when the text holds URL credentials, `"auths":`, `PRIVATE KEY-----` or a password/secret/token assignment (.dockerconfigjson, DATABASE_URL in k8s Secret data). It is matched from the `:` (from every identifier it cost 3x more). Test fixtures for Twilio keys must be built at run time: a literal trips GitHub push protection.

(4) classify.ts masks before it cuts: masked(text, n) = clip(redactSecrets(text.slice(0, 4096)), n) for tool_call/latency/error summaries, the error text, the git command and the external_ref URL.

(5) purge("sessions"/"memories") deletes the source's documents with purgeDocumentsBySource(): one chunk_vec DELETE … IN (join), set DELETEs for chunks and documents, with FTS5 'secure-delete' set to 1 on both FTS tables while the chunks go and back to 0 after (in finally). secure-delete removes the rows' tokens from shared segments, so no FTS 'optimize' (8-10 s on a 1.4 GB index) is needed. purge sessions on the 1.4 GB bench db: 37.4 s before, 12.0 s after, main 12.1 s.
