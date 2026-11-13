---
name: research/security-adjudication-taxonomy
kind: note
tags: [adjudicator, security, research]
related: []
created: 2026-11-13T17:30:18.605Z
updated: 2026-11-13T17:30:18.605Z
---

Security-aware adjudication research (task #308, swarm run 20261113-bef5ea, 2026-11-13; full text on blackboard keys research-taxonomy, -2, -3). Proposed capability model for agent tools: 8 flags U untrusted-input, S sensitive-read (repo 0.4 / secrets 1.0), E egress, X code-exec (adds latent S/E/D/P/U used only in combos), W local-write (W* persistence paths 1.0: .claude/**, CLAUDE.md, .mcp.json, .eminiar/**, .git/hooks, workflows, package.json scripts), D destructive, P privilege, T tool-supply (third-party MCP, installs, curl|sh; also counts as U). Taint is sticky per context. Combos: R1 lethal trifecta U,S,E (Willison); R2 Meta Agents Rule of Two U,S,max(E,W,D,P); R3 U,X; R4 T,X; R5 U,D/P; R6 U,W*; R7 secret egress. Tier = score band (LOW<25, MEDIUM 25-49, HIGH>=50) capped at HIGH; CRITICAL only via floors (trifecta + autonomous, trifecta min>=.8, secret->egress, fetch-and-exec). Recommended fit: heuristic computes it offline as default/fallback; external model (Jev/openai-compatible) may only raise a tier, never go below a rule floor; output includes a "drop a leg" remedy; advice-only. Weights are unmeasured: needs a labelled eval set. Key sources: simonwillison.net/2025/Jun/16/the-lethal-trifecta/, ai.meta.com/blog/practical-ai-agent-security/, OWASP LLM06:2025 and Agentic Top 10 2026 (ASI01-10), MITRE ATLAS AML.T0053/T0086/T0077/T0081/T0083/M0030, Invariant MCP tool poisoning + GitHub MCP toxic flow, CaMeL arXiv 2503.18813, CVE-2025-55284 (Claude Code DNS exfil). The OWASP Agentic Threats & Mitigations T-numbers could not be verified from a primary source.
