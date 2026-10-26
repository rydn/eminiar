# Tools reference

[← Docs index](README.md)

eminiar adds 23 MCP tools. In Claude Code their full names are
`mcp__plugin_eminiar_eminiar__em_*`. This page uses the short names.

You do not normally call these tools yourself. Claude calls them, and the hooks remind Claude to
use them. This page helps you understand what Claude does and what to ask for.

**Contents:** [Run code](#run-code) · [Search and fetch](#search-and-fetch) ·
[Memory](#memory) · [Documentation](#documentation) · [Code graph](#code-graph) ·
[History](#history) · [Housekeeping](#housekeeping) · [Slash commands](#slash-commands)

## Run code

Use these instead of `Bash` or `Read` when the output can be large.

| Tool | Parameters | Use for |
|---|---|---|
| `em_execute` | `language`, `code`, `intent`, `queries`, `timeout_ms`, `max_tokens` | git log/diff, test runs, dependency trees, logs, API calls |
| `em_batch_execute` | `commands[{label, command, language}]`, `queries`, `intent`, `concurrency` | Several commands in parallel, with questions answered in one round trip |
| `em_execute_file` | `path`, `code`, `intent` | Processing a large file. Your code gets the path in `$EM_FILE` and only what it prints returns |

**How `intent` works.** Output under 5 KB returns in full. Larger output is indexed and only the
sections that match `intent` come back, with a list of searchable terms. Use `em_search` to dig
further.

```text
em_execute {language: "shell", code: "npm test", intent: "failing tests and their errors"}
```

## Search and fetch

| Tool | Parameters | Use for |
|---|---|---|
| `em_search` | `queries`, `source`, `content_type`, `sort`, `mode`, `since`, `limit` | Anything indexed: command output, files, pages, docs, memories, git messages, sessions |
| `em_fetch_and_index` | `url` or `urls`, `queries`, `ttl_hours`, `force` | Fetch web pages, index them, return only the relevant sections. Cached for 24 hours |
| `em_index` | `path` or `content`, `title`, `source`, `content_type`, `recursive`, `glob` | Add files, a directory or pasted text to the index |

`em_search` options:

| Option | Values |
|---|---|
| `mode` | `hybrid` (default), `lexical`, `semantic`, `regex` (grep with context) |
| `sort` | `relevance` (default), `timeline` (use after a resume) |
| `source` | For example `memory`, `git`, `docs:*`, `docs:stripe`, a sandbox label |
| `content_type` | `code`, `prose`, `json` |

## Memory

| Tool | Parameters | Use for |
|---|---|---|
| `em_remember` | `content`, `kind`, `name`, `status`, `supersedes`, `tags`, `related_files`, `related_nodes` | Save a decision, constraint, fact or fix |
| `em_recall` | `query`, `kind`, `topic`, `limit` | Find past decisions, constraints, errors and fixes |
| `em_memory` | `action`: `list`, `read`, `edit`, `rename`, `delete`, `status` | Manage the memory files |

Memory kinds: `decision`, `constraint`, `fact`, `preference`, `todo`, `note`, `onboarding`.

See [Memory and recall](memory-and-recall.md).

## Documentation

| Tool | Parameters | Use for |
|---|---|---|
| `em_docs` | `action`: `discover`, `add`, `sync`, `lookup`, `list`, `remove`, `resolve` | The documentation knowledge base. Ask it before `WebFetch` or `WebSearch` |

```text
em_docs {action: "discover"}                      # what docs could be indexed
em_docs {action: "add", pick: "recommended"}      # index the recommended set
em_docs {action: "lookup", query: "rate limits"}  # answer from the index
```

See [Documentation knowledge base](documentation-kb.md).

## Code graph

| Tool | Parameters | Use for |
|---|---|---|
| `em_architecture` | `aspects` | The project map: languages, folders, entry points, routes, hotspots, clusters, cycles, decisions |
| `em_symbols` | `mode`: `overview`, `find`, `references`; `file`, `name_path`, `include_body` | Navigate code by symbol instead of reading whole files |
| `em_graph_impact` | `node`, `mode`, `to`, `depth`, `edge_kinds` | What breaks if a file or symbol changes, and why |
| `em_graph_changes` | `ref` | The symbols a diff touches, their exposure, and the files it can reach |
| `em_graph_query` | `query`, `kind`, `preset`, `pattern` | Find nodes, run a preset, or walk typed edges |
| `em_graph_add` | `nodes`, `edges` | Add curated concepts and links to the graph |
| `em_index_status` | — | Is the graph fresh? Which files were skipped and why? |

`em_graph_impact` modes: `impact` (default), `dependents`, `dependencies`, `neighbors`, `path`.

`em_graph_query` presets:

| Preset | Answers |
|---|---|
| `hotspots` | Where is change risky? (fan-in, recent churn and complexity) |
| `routes` | Which HTTP routes exist, and which functions handle them? |
| `dead_code` | Which symbols does nothing use? |
| `cycles` | Which imports form a cycle? |
| `clusters` | Which modules belong together? |
| `coupled` | Which files change together in git? |
| `orphans` | Which files does nothing import? |
| `stats` | Node and edge counts |

See [Knowledge graph and history](knowledge-graph.md).

## History

| Tool | Parameters | Use for |
|---|---|---|
| `em_history` | `action`, `path`, `sha`, `name`, `name_path`, `query`, `kinds`, `author`, `since`, `until`, `risky` | The classified git history |

| Action | Answers |
|---|---|
| `overview` | Orientation: the shape of the history and its branches |
| `file` | A file's fixes, what broke after past changes, and who knows it. Use before you edit it |
| `risk` | The risk of the files in the working tree, or of given `paths`. Use before you commit |
| `commit` | One change |
| `branch` | A branch against the base: ahead, behind, merge state |
| `symbol` | The line history of one function |
| `timeline`, `search` | When and why something happened |

## Housekeeping

| Tool | Use for |
|---|---|
| `em_stats` | Tokens kept out of context, by `session`, `project` or `lifetime`, ending with today's and the session's cost |
| `em_usage` | Tokens, cache, cost and insights per model call from the local transcripts. `view`: `summary`, `daily`, `weekly`, `monthly`, `models`, `sessions`, `blocks`, `turns`, `tools`, `insights`, `savings`; `scope`: `project` or `session`; `since`: `30d` or an ISO date; `json`. See [Usage insights](usage.md) |
| `em_doctor` | Installation health |
| `em_reindex` | Rebuild part of the index: `code`, `git`, `metrics`, `docs`, `memories`, `embeddings` or `all`. Incremental unless `full: true` |
| `em_purge` | Permanently delete project data: `index`, `sessions`, `graph`, `memories` (the database mirror only), `usage` (API calls, tool uses, context events, transcript offsets, statusline snapshots) or `all`. Needs `confirm: true` |

## Slash commands

| Command | What it does |
|---|---|
| `/em-onboard` | Writes the onboarding memories and builds the docs knowledge base |
| `/em-docs` | Discover, add, sync and look up documentation |
| `/em-graph` | Architecture, impact, hotspots, routes, dead code, cycles, what a diff touches |
| `/em-history` | What changed, why, and which changes later needed fixing |
| `/em-search` | Search everything indexed |
| `/em-index` | Index files, a directory or pasted content |
| `/em-stats` | Context savings and index size |
| `/em-usage` | Tokens, cache, cost, billing blocks, insights and savings |
| `/em-doctor` | Diagnose the installation |
| `/em-purge` | Delete project data |
