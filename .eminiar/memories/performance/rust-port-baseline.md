---
name: performance/rust-port-baseline
kind: note
tags: [performance, rust, baseline]
related: [file:src/hook.ts, file:scripts/bench-hotpath.mjs, file:src/graph/treesitter.ts, file:src/storage/sqlite/adapter.ts, file:bin/_resolve.sh]
created: 2026-10-26T20:31:32.766Z
updated: 2026-10-26T20:31:32.766Z
---

Rust-port performance baseline (2026-10-26, M4 Pro, Node 25.2.1, v0.9.0, this repo = 212 files / 3762 chunks / 9395 edges). Investigation only; no port started. Conclusion: a Rust port is NOT justified on performance grounds — every hot path except hook process startup is bound by native code (SQLite/FTS5, ONNX, child-process spawn) that Rust would inherit unchanged.

Measured:
- Hook process (bin/em-hook, any event): ~50 ms wall end-to-end, ~76 MB RSS. Of that, bare Node boot is ~19 ms and 69% of sampled CPU (31 of 45 ms) is module loading of the 1.1 MB dist/hook.js bundle plus better-sqlite3 dlopen; actual hook logic + SQLite is ~5 ms. NODE_COMPILE_CACHE made no measurable difference (63 vs 65 ms). Shim overhead ~2 ms. This is the ONLY path where Rust would win: ~50 ms -> ~5 ms per synchronous hook (PreToolUse per tool call, UserPromptSubmit per prompt). Cheaper ways to get most of it without a port: a persistent hook daemon (shim forwards the payload over a unix socket to the live MCP server), lazy-loading in hook.js, or a V8 startup snapshot / SEA.
- MCP server (npm run bench): coldStart p50 74 ms (once per session); execTinyShell p50 2.5 ms vs spawnFloor 2.0 ms (0.5 ms of eminiar overhead — nothing left to gain); batch8Tiny 8.1 ms; execLarge400k p50 ~85-98 ms, of which ~60% is FTS5 chunk inserts inside upsertDocument's transaction, ~8% topTermsOf, ~3% GC. Server RSS ~94 MB.
- Full code reindex (eminiar reindex --scope code --full): 1.9 s wall. CPU: ~65% SQLite (graph node/edge upserts + document/chunk inserts; the "eminiar-js" bucket is transaction callbacks whose self time is inlined native run()), ~30% tree-sitter WASM, little pure JS. Native tree-sitter would cut parse ~2-3x -> maybe 1.9 s -> ~1.3 s, on a rare path.
- Search (eminiar search "q"): 90 ms wall, of which ~65% is Node process boot; the FTS query itself is a few ms.
- Embeddings: Xenova/bge-small-en-v1.5 via onnxruntime-node; a Rust port would use the same ONNX runtime (ort crate), no gain.
Cost side: ~38.8k lines of TS in src/, 6.6k in tests, Preact dashboard, MCP SDK, zod schemas; distribution would need per-platform binaries instead of one npm package.
