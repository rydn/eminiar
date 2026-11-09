# Tools reference

[← Docs index](README.md)

eminiar adds 24 MCP tools, plus `em_adjudicate` while the opt-in adjudicator is on. In Claude
Code their full names are `mcp__plugin_eminiar_eminiar__em_*`. This page uses the short names.

You do not normally call these tools yourself. Claude calls them, and the hooks remind Claude to
use them. This page helps you understand what Claude does and what to ask for.

**Contents:** [Run code](#run-code) · [Search and fetch](#search-and-fetch) ·
[Memory](#memory) · [Documentation](#documentation) · [Code graph](#code-graph) ·
[History](#history) · [Agent swarms](#agent-swarms) · [Adjudicator](#adjudicator) ·
[Housekeeping](#housekeeping) · [Slash commands](#slash-commands)

## Run code

Use these instead of `Bash` or `Read` when the output can be large.

| Tool | Parameters | Use for |
|---|---|---|
| `em_execute` | `language`, `code`, `intent`, `queries`, `timeout_ms`, `max_tokens` | git log/diff, test runs, dependency trees, logs, API calls |
| `em_batch_execute` | `commands[{label, command, language}]`, `queries`, `intent`, `concurrency` | Several commands in parallel, with questions answered in one round trip |
| `em_execute_file` | `path`, `code`, `intent` | Processing a large file. Your code gets the path in `$EM_FILE` and only what it prints returns |

**How `intent` works.** Output under 5 KB returns in full. Larger output is indexed and only the
sections that match `intent` come back, with a list of searchable terms. Use `em_search` to dig
further. `em_batch_execute` follows the same 5 KB rule per output when it has no `queries` or
`intent` (within `max_tokens` overall); with them only outputs under 1 KB are inlined and the query
hits carry the rest. Every output is indexed, and an elided one names its document id so
`em_search {document_ids: [N]}` fetches it.

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

## Agent swarms

| Tool | Parameters | Use for |
|---|---|---|
| `em_swarm` | `action`, `swarm`, `goal`, `run`, `tasks`, `task`, `status`, `result`, `key`, `value`, `summary`, `remember`, `agent`, `role`, `force` | Coordinate an opt-in agent swarm: runs, a task board, workers and a shared blackboard |

| Action | Who | Does |
|---|---|---|
| `list` | anyone | Swarms, roles, agent file state, active runs |
| `start` | coordinator | Opens a run of `swarm` for `goal` and returns the coordinator brief |
| `plan` | coordinator, workers | Adds `tasks: [{key, title, detail, role, deps, files}]`; any other key is an error |
| `claim` | workers, coordinator | Claims `task` (or the next eligible one) and returns its brief |
| `update` | the task's holder, coordinator | Sets a task to `done`, `failed`, `blocked`, or `pending` to reopen |
| `post` | coordinator, workers, other subagents | Writes a note to the run's shared blackboard |
| `read` | anyone | One note by `key`, or every key followed by the values |
| `status` | anyone | The next step, tasks by status, workers, blackboard keys, recent events |
| `finish` | coordinator | Closes the run and its running workers; `remember: true` writes the outcome as a memory |
| `release` | coordinator | Frees stuck workers (`agent` id or prefix, every worker of a `role`, or with neither every worker quiet for 15 minutes); their tasks go back to pending |
| `sync` | coordinator | Regenerates `.claude/agents/swarm-*.md` from `.eminiar/swarm.yaml`; `force: true` overwrites generated files edited by hand |

Without `.eminiar/swarm.yaml` the tool only explains how to opt in. Calls without `run` go to
the one active run of this session (a worker's: its own run; `claim`/`update` with `task`: that
task's run); when several are active the tool lists them and asks for `run`. The `caller_*`
fields are a signed stamp that eminiar's PreToolUse hook adds to tell the coordinator from
workers; Claude leaves them empty, and a call without a valid stamp can only `list`, `status`
and `read` (settings installed by an eminiar older than 0.12 need `eminiar upgrade`). Subagents
that are not swarm workers can only `list`, `status`, `read` and `post`. See
[Agent swarms](swarms.md).

With the adjudicator on and `adjudicator.surfaces.plan` set, `plan` also appends a suggested
agent, model and effort for each new task. See [Adjudicator](adjudicator.md#swarm-plans).

## Adjudicator

| Tool | Parameters | Use for |
|---|---|---|
| `em_adjudicate` | `action`, `text`, `tasks`, `id`, `outcome`, `note`, `since` | Score how complex a request or task is, and which tool, Claude model size and swarm role fit it |

The tool is registered only while `adjudicator.enabled` is on; after `eminiar adjudicator enable`
run `/mcp reconnect`. See [Adjudicator](adjudicator.md).

| Action | Parameters | Does |
|---|---|---|
| `score` | `text` (≤ 8000 chars) or `tasks: [{key (≤ 40), title (≤ 400), detail? (≤ 4000), role? (≤ 60)}]` (≤ 20) | One line per item: complexity, tier and effort, tool, role, confidence, the top reasons, the source and latency, and a decision id. Uses the provider within `timeouts.planMs`. Refused while the adjudicator is off |
| `explain` | `id` | One stored decision in full: the input head, the tier, role and tool tables with reasons, the complexity terms, blend weights and bias, the features, provider status, latency, tokens and cost, and the outcome with actual model and savings |
| `stats` | `since` (ISO date or `7d`, `12h`) | Decisions by surface and source, provider status, latency, follow / apply / respect rates, outcomes, spend, realised and net savings, and potential savings |
| `feedback` | `id`, `outcome`: `good`, `too_small` or `too_big`, `note?` (≤ 4000; stored redacted and cut to 500) | Closes the decision with that outcome and updates the learned bias. Refused while the adjudicator is off |

```text
em_adjudicate {action: "score", text: "rename parseDate in src/utils/date.ts"}
em_adjudicate {action: "feedback", id: 42, outcome: "too_small", note: "needed opus"}
```

## Housekeeping

| Tool | Use for |
|---|---|
| `em_stats` | Estimated tokens kept out of context (4 characters per token, shown with `≈`), by `session`, `project` or `lifetime`, ending with today's and the session's cost. Savings are split by kind: measured savings are output that `em_execute`, `em_execute_file`, `em_batch_execute` and `em_fetch_and_index` produced and kept out of context; counterfactual savings are what a native `Read`, `Grep` or `git` call might have returned for a search, docs, graph, symbol or history answer (every file a graph answer touches, every whole chunk a search hit), so they can overstate |
| `em_usage` | Tokens, cache, cost and insights per model call from the local transcripts. `view`: `summary`, `daily`, `weekly`, `monthly`, `models`, `sessions`, `blocks`, `turns`, `tools`, `insights`, `savings`; `scope`: `project` or `session`; `since`: `30d` or an ISO date; `json`. See [Usage insights](usage.md) |
| `em_doctor` | Installation health |
| `em_reindex` | Rebuild part of the index: `code`, `git`, `metrics`, `docs`, `memories`, `embeddings` or `all`. Incremental unless `full: true` |
| `em_purge` | Permanently delete project data: `index`, `sessions`, `graph`, `memories` (the database mirror only), `usage` (API calls, tool uses, context events, transcript offsets, statusline snapshots), `adjudicator` (decisions, verdict cache, provider breaker state, learned bias, captured Jev requests) or `all`. Needs `confirm: true` |

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
| `/em-swarm <swarm> <goal>` | Coordinate a run of an agent swarm: plan, spawn workers, review, finish |
| `/em-doctor` | Diagnose the installation |
| `/em-purge` | Delete project data |
