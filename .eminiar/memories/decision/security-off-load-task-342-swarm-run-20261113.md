---
name: decision/security-off-load-task-342-swarm-run-20261113
kind: decision
tags: []
related: []
created: 2026-11-13T20:45:38.683Z
updated: 2026-11-13T20:45:38.683Z
---

Security-off load (task #342, swarm run 20261113-bef5ea, branch feature/security-adjudication). The MCP server is ONE bundle and scripts/check-bundle.mjs forbids any dynamic import() of an internal module in the server graph (zod lazy-init crash), so em_swarm.ts / em_adjudicate.ts keep static imports of security/assess+advice; server start cannot be made lazy and the tool description cannot shrink when security is off (ToolDef.description is static, registry is server.ts/types.ts). The hook path can: engine.ts, prompt.ts and providers/typesafe.ts no longer import security/prompt.js or security/types.js; they call security() from src/adjudicator/security/load.ts, a leaf registry with no imports. security/register.ts (imported for its effect by security/advice.ts, which every producer of a hints.security loads: assess, CLI, eval) registers prompt.ts and types.ts there. Reading security() before registration throws; consumers are gated on hints.security / item.tools so the hook path never reads it. Tested in tests/unit/adjudicator-hooks-off.test.ts ('adjudicator on, security off': real hooks.ts, zero security/* files but load.ts) and tests/unit/adjudicator-security-off-load.test.ts. Known remaining static importer: src/doctor.ts -> adjudicator/cli.ts -> security/cli.ts (sync runDoctor; em_doctor tool and CLI), not on the hook path. Also #333: em_swarm plan security block has its own 1500-char budget (securityBlock in em_swarm.ts), appended after the capped task list.
