---
name: workflow/subagents-and-adversarial-review
kind: preference
tags: [workflow, review, subagents]
related: []
created: 2026-10-26T20:56:43.987Z
updated: 2026-10-26T20:56:43.987Z
---

Workflow preference (Ryan, 2026-10-26): for feature work, use subagents whenever the work can be split (parallel implementation, research, tests), and before committing run an adversarial review agent that tries to break the change (correctness, edge cases, tests, conventions) and fix what it finds. Then open a PR (one feature per branch, PR bumps the package version per release/pr-version-bump).
