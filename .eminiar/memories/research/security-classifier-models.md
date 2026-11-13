---
name: research/security-classifier-models
kind: fact
tags: [adjudicator, security, jev, research]
related: [file:src/adjudicator/providers/typesafe.ts, file:src/adjudicator/prompt.ts, file:src/adjudicator/blend.ts]
created: 2026-11-13T17:31:06.376Z
updated: 2026-11-13T17:31:06.376Z
---

Security-classification model research (task #309, swarm run 20261113-bef5ea, 2026-11-13; blackboard research-models, research-models-2).

Jev fit:
- Jev (typesafe, jev-1.14.0) takes custom label sets: Choice with up to 255 options, Score with 2-10 levels, and Noul with optional true/false criteria.
- There is no limit on the number of questions, only context limits: 64k per request and 32k per question.
- The docs say added questions barely change latency.
- Live probe: 10 synthetic agent tasks with granted tools, 4 security questions each (category choice, 5-level severity score, exfil noul, injection noul), sent in one request. Result: 413 ms, 5,058 input tokens, $0.00021.
- Severity separated benign tasks (<= 1.0) from malicious ones (>= 3.5) on all 10. The category choice nearly tied when two labels applied, so use Nouls for multi-label.
- Jev docs warn that adversarial state can steer answers and that Choice leans toward the first option. Combine risk as max(heuristic, model), and do not list "none" first.

Prompt Guard 2 22M:
- Runs locally through @huggingface/transformers with the q8 ONNX file (72.5 MB, ungated third-party mirror gravitee-io; upstream is gated, Llama 4 licence).
- Measured on M5 Pro: load 348 ms, about 4 ms per prompt warm, 50 ms at 512 tokens, about 620 MB process RSS.
- It flagged only the explicit "ignore previous instructions" probe. It scored the exfiltration and malicious-code task requests benign (0.002-0.019).
- Use it only to scan untrusted content, not to rank task risk.

Other guard models:
- Llama Guard 4, ShieldGemma, Qwen3Guard and Granite Guardian are content-safety taxonomies that do not consider which tools an agent is given.
- gpt-oss-safeguard-20b on Groq (Apache 2.0, bring-your-own-policy, $0.075/$0.30 per Mtok, preview) is the only other hosted option that takes a custom policy.

Recommendation: heuristics-only by default. Jev is the first external model; add its security questions to the existing request. Optionally, run gpt-oss-safeguard through the openai-compatible provider.
