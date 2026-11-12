---
name: playbooks/accept-claim-first
kind: decision
tags: []
related: [file:src/playbooks/store.ts, file:src/adjudicator/redact.ts, file:src/storage/sqlite/playbooks.ts]
created: 2026-11-11T20:49:18.179Z
updated: 2026-11-11T20:49:18.179Z
---

Playbook suggestion accept is claim-first (swarm run 20261111-e068a8, task #269, branch feature/run_book-r2-store, commit 5673b1a, 2026-11-11).

1. acceptSuggestion validates every field and picks a name.
2. It claims the suggestion with the guarded UPDATE (pending -> accepted, playbook=name) BEFORE any file exists.
3. It creates the file exclusively: writePlaybook(…, exclusive=true) hard-links the complete tmp file to the final name, with a `wx` fallback. It never replaces a file.
4. A name taken in the window raises NameTakenError. The claim is then released with db.playbooks.suggestionRelease(id, name), which only works while the row is still accepted under that name. An auto-chosen name retries with freeName up to 3 times; a caller-chosen name throws.
5. If mirroring fails after the file was created, the file is removed only while its dev+ino match the ones this call created (unlinkIfOurs).

Crash recovery: accepting an accepted suggestion whose playbook file is missing re-creates the file under the accepted name and returns recreated:true. If a concurrent in-flight accept then hits EEXIST on a file with source:suggested and the same prompt, it treats the accept as done (holdsSuggestion).

Related rules from the same commit:
- Deleting a private playbook that hides a committed one goes through removeReport, which returns nowActive. Every surface (tool, CLI, API) must say the committed file is now active.
- The playbook store masks text with redactSecretsClean (NFKC and zero-width aware). Plain redactSecrets stays byte-identical for the indexer.
