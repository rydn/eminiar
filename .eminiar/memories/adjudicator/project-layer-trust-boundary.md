---
name: adjudicator/project-layer-trust-boundary
kind: constraint
tags: [adjudicator, security, privacy, consent]
related: [file:src/config.ts, file:src/adjudicator/config.ts, file:src/adjudicator/redact.ts, file:src/adjudicator/providers/openai.ts, file:src/adjudicator/providers/typesafe.ts, file:src/adjudicator/cli.ts]
created: 2026-11-04T11:45:02.841Z
updated: 2026-11-08T14:01:35.000Z
---

Adjudicator trust boundary (security review #31, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator). <root>/eminiar.config.json is committed and comes with any cloned repo, so it is attacker-controlled. It must never decide where adjudicator text or keys go, which key is sent, how much text leaves the machine, or how much is spent. On HEAD 0aca5d7, projectLayer() stripped only remoteConsent. A project file could set provider, openai.baseUrl/preset, typesafe.baseUrl, keyEnv, privacy.maxChars and budget, and the review showed it exfiltrating the user's Groq/TypeSafe key, or any env var via keyEnv, to an arbitrary host (tasks #32 and #33). Rules: (1) the project layer is an allowlist for the adjudicator section (enabled and behaviour knobs only; never provider, baseUrl, preset, keyEnv, remoteConsent, privacy, budget or timeouts); (2) remote consent is bound to the host the notice named, not a bare boolean. EMINIAR_ADJUDICATOR_REMOTE=1 must not cover a custom baseUrl, and the CLI asks again when the host changes; (3) a local (loopback) provider gets no key from keyEnv or the generic env var. redact() is best-effort (gaps filed as #34), so consent text must not promise more than it does.

Update 2026-11-08 (branch fix/adjudicator-project-trust): rule (1) also covers the model choice. The project file may not set mode "apply", apply.* or tiers; it may still set enabled and keep mode "advise" (see adjudicator/project-allowlist-and-local-keys).
