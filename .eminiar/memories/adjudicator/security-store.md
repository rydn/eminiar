---
name: adjudicator/security-store
kind: decision
tags: []
related: [file:src/storage/sqlite/security.ts, file:src/storage/sqlite/schema.ts, file:src/storage/types.ts, file:src/storage/adapter.ts]
created: 2026-11-13T18:21:55.740Z
updated: 2026-11-13T18:21:55.740Z
---

Security assessment store (task #314 / T4, swarm run 20261113-bef5ea, branch feature/security-adjudication, 2026-11-13). Table adjudicator_security, migration v13 (origin/main has 10 reserved, 11 playbooks, 12 recall index; 13 was free on 25f304a, recheck at merge). DDL is SECURITY_SQL in src/storage/sqlite/schema.ts (IF NOT EXISTS); SqliteSecurityStore (src/storage/sqlite/security.ts) runs it lazily on first use for a database that claims v13+ without the table, so a build with security off never touches it. StorageAdapter.security is a separate store from adjudicator (try-it wrapper and routing stats unaffected). insert() never throws (invalid input, busy database, read-only all return undefined; lock wait 0 by default) and prunes rows older than 90 days on every 100th id. Privacy is enforced in the store: input_head goes through head() (80 chars redacted), detail JSON drops argument-like keys (args, command, prompt, text, path, env, url...) and secret-named keys at any depth, masks strings with redactSecrets, and is shrunk to 8 KB. adapter.purge('adjudicator'|'all') clears it (secure_delete + WAL checkpoint); sessions/index/graph/memories/usage do not. The store copies the level/action/surface/autonomy/grant-status lists locally (STORED_*) because tests/unit/adjudicator-hooks-off.test.ts forbids any runtime import of src/adjudicator/security/* from boot-loaded modules; a test pins the copies to security/types.ts.
