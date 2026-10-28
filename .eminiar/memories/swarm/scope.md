---
name: swarm/scope
kind: constraint
tags: [swarm, scope, opt-in, ruflo]
related: []
created: 2026-10-27T22:09:25.219Z
updated: 2026-10-27T22:09:25.219Z
---

Agent swarms scope (Ryan, 2026-10-28, branch feature/agent-swarms): swarms are an OPT-IN feature inspired by ruvnet/ruflo but NOT a replica. Build only the core needed for a functional worker swarm: project-specific swarm config in a YAML file under `.eminiar/`, agent roles, prompts, shared memory and coordination, Claude Code skills + hooks (Claude Code is the only target for now), and a dashboard view of swarm activity styled after ruflo's layout but in eminiar's existing grey/blue palette. Out of scope: ruflo's consensus algorithms (Raft/Byzantine/Gossip), federation, neural/self-learning, 100+ agent catalogue, daemons, other harnesses (Codex etc.). Agents must be aware of eminiar memories, git history, code structure and insights. Every sub-feature gets an adversarial review before the PR.
