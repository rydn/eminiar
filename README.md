# eminiar

Local-first context, memory and knowledge graph for Claude Code. Nothing leaves your machine.

eminiar keeps raw tool output out of the model's context window and gives Claude Code local tools
that make it work better:

- **Sandbox** — `em_execute`, `em_batch_execute`, `em_execute_file`: run shell / JS / TS (plus
  Python, Ruby, Go, PHP, Perl, R, Elixir, Rust, C# when installed) inside the project and get back
  only what matters. Large outputs are indexed; with an `intent` only the matching sections return.
- **Search** — `em_search`, `em_fetch_and_index`, `em_index`: SQLite FTS5 (porter + trigram, BM25,
  typo correction) fused with local ONNX embeddings (bge-small via sqlite-vec). Hybrid by default,
  never blocks on the model download.
- **Session continuity** — hooks capture prompts, decisions, constraints, files, errors and loops
  into 23 categories; a ≤2 KB Session Guide is snapshotted before `/compact` and replayed on resume.
- **Memory** — `em_remember` / `em_recall` / `em_memory`: named markdown memories under
  `.eminiar/memories/<topic>/<name>.md` (human-editable, committed with the repo), mirrored into
  the search index and the graph. `/em-onboard` writes the onboarding set.
- **Knowledge graph** — `em_graph_impact`, `em_graph_query`, `em_graph_add`: tree-sitter
  (TS/JS) symbols, imports, calls and references + git co-change coupling and hotspots +
  curated concepts and memories.
- **Symbols** — `em_symbols`: file overview, find by name path (`Class/method`,
  `src/x.ts#Class.method`) with the body, and references, Serena-style but without language
  servers. Code search chunks are cut at declarations and titled by symbol. A database built by
  an older version gets one automatic full code reindex on first use.
- **Stats** — `em_stats`, a statusline, and a local web dashboard (`eminiar serve`).

## Install

```sh
npx eminiar install            # pins node, installs a stable copy, registers the plugin, downloads the model
npx eminiar doctor             # verifies every piece
```

Teams: run `npx eminiar install --team` once, commit the generated `eminiar.config.json`, and
teammates run `npx eminiar install`. With `--team --marketplace github:org/repo` the project's
`.claude/settings.json` also prompts teammates to install the plugin on next launch.

Other commands: `upgrade`, `uninstall [--purge-data]`, `replace-context-mode` (removes the
context-mode plugin and its hooks once you are happy with parity; the hosted gateway env is a
separate, explicit choice).

## Using it from Claude Code

The plugin injects short routing guidance at session start. Slash commands: `/em-stats`,
`/em-doctor`, `/em-index`, `/em-search`, `/em-graph`, `/em-purge`.

| Tool | Use for |
|---|---|
| `em_execute {language, code, intent}` | git log/diff, tests, dependency trees, logs, API calls |
| `em_batch_execute {commands[{label, command}], queries}` | several commands + questions in one round trip |
| `em_execute_file {path, code}` | big files; your code gets `$EM_FILE` |
| `em_fetch_and_index {url, queries}` | docs and web pages (24 h cache) |
| `em_search {queries, sort}` | anything indexed, `sort: "timeline"` after a resume |
| `em_recall {query}` / `em_remember {content, kind, name?}` | past decisions, constraints, errors |
| `em_memory {action: list \| read \| edit \| rename \| delete, name}` | the memory files themselves |
| `em_symbols {mode: overview \| find \| references, file, name_path, include_body}` | navigate code by symbol instead of reading files |
| `em_search {queries, mode: "regex"}` | grep indexed content with context |
| `em_graph_impact {node}` | what breaks if a file/symbol changes, and why |
| `em_graph_query {preset: "hotspots" \| "coupled" \| "orphans"}` | where change concentrates |
| `em_stats`, `em_doctor`, `em_reindex`, `em_purge` | housekeeping |

Routing: `routing.mode` is `auto` — eminiar only *annotates* native Bash/Read/Grep/WebFetch calls
while the context-mode plugin is installed (so the two never deny each other), and switches to
hard `enforce` (deny + redirect to the `em_*` tool) once it is gone. Set `off`, `annotate` or
`enforce` explicitly in `eminiar.config.json`. `enforce` only denies while an eminiar MCP server
is running for the project (the server leaves a pid marker under `~/.eminiar/projects/<id>/servers/`);
with no server up it annotates instead, so Claude is never told to retry with a tool it cannot reach.

Permissions: shell snippets are checked against Claude Code's `permissions.deny` / `ask` Bash
rules per chained segment; `ask` counts as deny. Sandboxed processes get a stripped environment
plus credential passthrough for gh / aws / gcloud / kubectl / docker.

## Memories

`em_remember` writes `.eminiar/memories/<topic>/<name>.md` with a small header:

```markdown
---
name: auth/session-tokens
kind: decision
tags: [auth, security]
related: [file:src/auth.ts, sym:src/auth.ts#issueToken]
created: 2026-10-13T15:00:00Z
updated: 2026-10-13T15:04:11Z
---

Tokens rotate every 15 minutes because …
```

The files are the source of truth: edit, move or delete them by hand and the next memory call
re-imports them (`em_reindex {scope: "memories"}` forces it). Each file is indexed for hybrid
search (`em_recall`, `em_search {source: "memory"}`) and becomes a `memory:<name>` graph node whose
`mentions` edges make `em_graph_impact` list the memories to re-read before changing a file.
Commit the directory so teammates share it. Rows recorded before 0.1.2 are migrated into files
on first use. `/em-onboard` writes `onboarding/{overview,structure,commands,conventions}`, which
every session start points at until they exist.

## Configuration

`~/.eminiar/config.json` (user) < `<project>/eminiar.config.json` (team, commit it) < `EMINIAR_*` env.
See `eminiar.config.schema.json` for every key: `routing`, `sandbox` (timeouts, output cap, env
allowlist, disabled languages), `search`, `embeddings`, `graph.include/exclude`, `git.maxCommits`,
`index.docs`, `permissions.extraDeny`, `memories.dir` (default `.eminiar/memories`).

All data lives in `~/.eminiar/`: one SQLite DB per project (`projects/<id>/eminiar.db`), a global DB
for lifetime stats and the fetch cache, the embedding model under `models/`, and the stable plugin
copy under `plugin/`.

## CLI

```
eminiar search "query" [--timeline] [--code] [--source X]
eminiar graph impact src/foo.ts | deps | neighbors | path a b | hotspots | coupled | orphans
eminiar index docs/ | reindex [--scope code|git|docs|embeddings|all]
eminiar stats | recall "query" | serve --open | statusline
```

Add `"statusLine": {"type": "command", "command": "eminiar statusline"}` to `~/.claude/settings.json`
(or pass `--statusline` to `install`) for `eminiar · 12.3k saved · 1.1M lifetime · 87% efficient`.

## Troubleshooting

**"The eminiar plugin server did not connect this session (retries in about 15 minutes)"**,
typically in the Claude Code desktop app while the terminal works. Claude Code launches plugins
from a copy under `~/.claude/plugins/cache/eminiar/eminiar/<version>` that has `dist/` but no
`node_modules/`. The `bin/` shims handle this by running the stable copy pinned in
`~/.eminiar/root-path` whenever their own directory cannot resolve dependencies. If the pin is
missing (installs before 0.1.1) run:

```sh
npx eminiar install      # or: eminiar upgrade — re-pins and refreshes the cache copy
eminiar doctor --fix     # re-pins and clears Claude Code's cached launch failure
```

then restart Claude Code. `eminiar doctor` probes every cached copy with `bin/em-server --probe`
and reports the cached failure with the time it expires.

## Develop

```sh
npm install
npm run build          # tsup + vendor tree-sitter grammars + config schema
npm test               # vitest (EMINIAR_TEST_EMBED=1 also runs the model test)
claude --plugin-dir "$PWD"
```

Storage goes through `src/storage/adapter.ts`; `src/storage/sqlite/` is the only module with SQL,
so a Postgres/pgvector or libSQL adapter can back a team-shared knowledge base later.

## Credits

Clean-room reimplementation of the ideas in [context-mode](https://github.com/mksglu/context-mode)
(sandbox + FTS5 index + hook-driven session memory), extended with local embeddings and a code graph.
