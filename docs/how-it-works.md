# How it works

[← Docs index](README.md)

eminiar has three parts: **hooks**, an **MCP server** and **local storage**. The client (Claude
Code, or Cursor with `install --cursor`) starts all of them. Nothing runs in the cloud.

```mermaid
flowchart TB
    subgraph CC ["Claude Code"]
        P["Prompt"]
        T["Native tools<br/>Bash · Read · Edit · Grep · WebFetch"]
        E["em_* tools"]
    end
    subgraph H ["Hooks (bin/em-hook)"]
        R["Routing"]
        RC["Recall"]
        C["Capture"]
    end
    subgraph S ["MCP server (bin/em-server)"]
        SB["Sandbox"]
        IX["Indexer"]
        G["Graph builder"]
    end
    DB[("~/.eminiar/projects/{id}/eminiar.db")]
    MF[".eminiar/memories/*.md"]

    P --> RC
    T --> R
    T --> C
    R -->|annotate or deny + redirect| T
    RC -->|memories · docs · history · graph| P
    E --> S
    SB --> IX --> DB
    G --> DB
    C --> DB
    RC --> DB
    MF <--> DB
```

## Hooks

The hooks are one small program, `bin/em-hook`. Claude Code runs it on these events (Cursor's
equivalents are [below](#cursor)):

| Event | What eminiar does |
|---|---|
| `SessionStart` | Adds the project brief: overview, accepted decisions, constraints, hot files, index freshness. After a resume, replays the Session Guide |
| `UserPromptSubmit` | Attaches memories and doc pages that match the prompt |
| `PreToolUse` | Routes noisy calls to `em_*` tools and history or symbol questions to `em_history` / `em_symbols`. Attaches memories and fix history for a file before a read or edit, fan-in before an edit. Lists risky files before `git commit` |
| `PostToolUse` | Captures session events (async, never blocks) |
| `PostToolUseFailure` | Attaches earlier occurrences of the same error and how they were resolved |
| `SubagentStart` | Swarm workers only: registers the worker and injects its brief; the worker then claims the `task #N` its prompt names |
| `SubagentStop` | Records the subagent's findings, so `em_recall` can find them later. Closes a swarm worker |
| `PreCompact` | Writes a ≤2 KB Session Guide snapshot |
| `Stop` | Classifies Claude's last reply (decisions, summaries) |
| `SessionEnd` | Marks the session as ended and flushes lifetime statistics |

Hooks are fast by design. They never run `git log` and never load the embedding model. Recall
is a few FTS queries against the project database.

### Agent swarms

Swarms are opt-in: without `.eminiar/swarm.yaml` every swarm path below returns after one
`agent_type` prefix test (`swarm-`) or one file-exists check. A swarm problem is logged to
`~/.eminiar/hook.log` and never blocks Claude. Spec: [design/agent-swarms.md](design/agent-swarms.md).

| Event | Swarm work |
|---|---|
| `SessionStart` | With `sync: auto`, regenerates `.claude/agents/swarm-<swarm>-<role>.md` from the YAML. Adds one line naming the swarms and any active run, or a warning naming the first problem in an invalid file |
| `PreToolUse` `Agent` / `Task` | For a `swarm-*` agent: checks `max_agents` and the role's `count`, and reserves the slot. Over capacity, the spawn is denied with the reason. Routing still adds its prompt prefix, but not the prompt brief: `SubagentStart` briefs the worker instead |
| `PreToolUse` `em_swarm` | Drops any `caller_*` fields the model passed and stamps the call with the real caller from the hook payload: main session or subagent, `agent_id`, `agent_type` and `session_id`, signed with a per-machine key (`~/.eminiar/swarm.key`). The tool trusts only stamps that verify, so nobody can pose as the coordinator or another worker; an unstamped call can only `list`, `status` and `read`. Never routed or annotated |
| `SubagentStart` | Registers the worker in its run and injects the worker brief: goal, blackboard, memories, history and hot files for its scope. The worker claims the `task #N` its spawn prompt names itself, because parallel spawns of one role cannot be told apart here |
| `PostToolUse` / `PostToolUseFailure` | Counts the worker's tool calls and errors, and adds them to the run's activity feed |
| `SubagentStop` | Marks the worker done and stores its last message. A task it still holds is closed as done (`auto_closed`), or released back to pending when there is no final message |
| `SessionEnd` | Closes the session's workers that never got `SubagentStop` and releases their tasks back to pending |

Settings installs made by an eminiar older than 0.12 lack the `em_swarm` PreToolUse matcher;
`eminiar upgrade` (or `eminiar install`) rewrites the hook entries. The plugin's hooks update
with the plugin.

A role with `isolation: worktree` runs in a git worktree. Its hooks map the worktree back to the
main checkout (the `.git` file's `gitdir:` points into `<main>/.git/worktrees/`), so the swarm
ledger stays in the main project's database.

### Cursor

The same `bin/em-hook` serves Cursor. Cursor speaks a different hook dialect (camelCase events,
flat output, `conversation_id` and `workspace_roots`, `Shell` instead of `Bash`, a JSON string for
the tool result). `src/hooks/cursor.ts` translates both directions, so the handlers above run
unchanged. The client is taken from `--client cursor` in `~/.cursor/hooks.json`, or detected from
the payload when Cursor runs a Claude Code hook through its third-party import.

| Cursor event | Runs as | Note |
|---|---|---|
| `sessionStart` | `SessionStart` | Context goes into `additional_context`; the session id and project root are exported as `env` for the later hooks |
| `beforeSubmitPrompt` | `UserPromptSubmit` | Cursor accepts only `continue` here, so the recalled memories are **parked** and delivered with the next tool result |
| `preToolUse` | `PreToolUse` | Permission only. A deny becomes `permission: "deny"` with the reason as `agent_message`. Memories, fix history and fan-in for the file are parked for the next tool result |
| `postToolUse`, `postToolUseFailure` | `PostToolUse`, `PostToolUseFailure` | Delivers the parked context plus its own in `additional_context` |
| `afterAgentResponse` | `Stop` | Cursor's `stop` carries no text; this one carries the reply that `Stop` classifies |
| `subagentStop`, `preCompact`, `sessionEnd` | same | Observational |

Parked context is kept per session for ten minutes and delivered once. Two safety rules carry
over: a hook never exits non-zero, and `enforce` routing denies a call only when Cursor has the
eminiar MCP server in `~/.cursor/mcp.json` and a server runs for the project. Otherwise the call
is allowed and the hint is parked.

What Cursor does not have: a status line, `/em-*` slash commands (the skills are available as
agent skills instead), and a session resume. Cursor also applies hooks to its Tab completions
and cloud agents only through its own events, which eminiar does not subscribe to.

## Routing

Routing decides what happens when Claude calls a native tool that an `em_*` tool does better.

| Native call | Suggested tool | Trigger |
|---|---|---|
| `Bash` | `em_history` | `git log`, `git blame`, `git show <sha>`, `git shortlog`, mapped to the matching action (`-- path` → `file`, `A..B` → `branch`, `--grep` → `search`, `-L :fn:file` → `symbol`). A one-commit `git log -1 --format=…` and `git show REF:path` are left alone |
| `Bash` | `em_execute` | A simple command that usually prints a lot (`npm test`, `git diff`, `find`, `grep -r`, `curl` …) or streams an unknown output through `grep`, `sort`, `jq` … |
| `Read` | `em_execute_file` | Files over 200 KB, or data files (`.log`, `.json`, `.csv`, `.xml`, `.sql`, `.har` …) over 20 KB |
| `Grep` | `em_symbols` / `em_search` | The pattern's identifier is a symbol the graph defines. Files-only grep: annotated with the matching symbols. Content-mode grep: denied |
| `Grep` | `em_execute` | Content-mode grep without a `head_limit` for anything else |
| `WebFetch` | `em_fetch_and_index` / `em_docs` | Always. Names the docs source if the site is already indexed |
| `WebSearch` | `em_docs` | When documentation sources exist (annotation only) |
| `Agent`, `Task` | — | Adds eminiar guidance to the subagent prompt and brief (swarm workers get the guidance only; their brief comes from `SubagentStart`) |

Set the mode with `routing.mode` in `eminiar.config.json`:

| Mode | Behaviour |
|---|---|
| `auto` (default) | `annotate` while the context-mode plugin is installed, otherwise `enforce` |
| `enforce` | Denies the native call and tells Claude which `em_*` tool to use |
| `annotate` | Allows the call and adds a hint |
| `off` | No routing hints |

**Bash is judged one simple command at a time.** A line is split at `;`, `&&`, `||` and
newlines (heredoc bodies and quoted text are skipped), and each part is classified on its own, so
`cd src && npm test` is heavy because of `npm test`, and the denial names that part. Output that
is bounded by construction stays native:

- a trailing `| head -40`, `| tail -5` or `| wc -l` (up to 400 lines);
- `head` / `tail` of a file, a `sed -n 'A,Bp'` range, `du -s`, `grep -l` / `-c`, `git log -1`;
- `cat` or `grep` over named files small enough for the native `Read` (200 KB in total, 20 KB
  for data files): the same read through Bash;
- a command that changes something (`git commit`, `git checkout`, `npm install`, `rm`, `mv`,
  `sed -i`, a `>` redirection into a file …): its output is secondary, and the native tool is
  where Claude Code's permission prompts live.

Every routing decision is recorded as a `routing` session event: `em_stats` reports how many
native calls were denied or annotated per tool, which `em_*` tool they were sent to and which
rule did it, and `~/.eminiar/hook.log` has one line per denial.

**Safety rule:** `enforce` denies a call only while an eminiar MCP server runs for the project.
The server writes a pid marker under `~/.eminiar/projects/<id>/servers/`. With no server, the
hook annotates instead. Claude is never told to retry with a tool that it cannot reach. For
the same reason, a big `Read` that a `Read` deny or `ask` rule matches is not redirected:
`em_execute_file` would refuse it, so the native `Read` goes ahead under Claude Code's own
permission check.

**Project knowledge is not routing.** Memories, fix history, fan-in and doc notes are attached
in every mode, including `off`. Every such decision is recorded, fired or quiet; `em_stats` and
`eminiar recall --explain` show the hit rate and the reasons (see
[Memory and recall](memory-and-recall.md#rules-that-keep-recall-useful)).

## Sandbox

`em_execute`, `em_batch_execute` and `em_execute_file` run code in a child process in the project
root.

- **Languages:** shell and JavaScript/TypeScript always. Python, Ruby, Go, PHP, Perl, R,
  Elixir, Rust and C# when their tools are installed. JavaScript and TypeScript snippets run
  as ES modules; a snippet that calls `require(...)` gets one that resolves packages and
  relative paths from the project root, as a script of the project would.
- **Output:** output over `sandbox.indexThreshold` (5 KB) is indexed. Claude gets back only the
  sections that match its `intent`, plus a list of searchable terms.
- **Permissions:** shell snippets are checked against Claude Code's `permissions.deny` and `ask`
  Bash rules, one chained segment at a time. An `ask` rule counts as deny.
- **Files:** the `path` given to `em_execute_file` must be inside the project root, or outside it
  with a `Read(<path>)` allow rule. A matching `Read` deny or `ask` rule refuses the path, inside
  the root or out, even when an allow rule matches. The path as written, its symlink target and
  (on macOS) its on-disk letter case are all checked. This guards the `path` only: the code you
  pass is checked against Bash rules like any snippet, and can still open other files.
- **Read rule forms:** a `Read` pattern is matched as a `*` / `**` glob against the absolute
  path, after a leading `~` becomes your home folder, so `Read(**/.env)` and `Read(~/.ssh/**)`
  match. These do not match yet: Claude Code's relative forms (`./.env`, `.env`, `/path` from the
  settings file, `//path`), `?` and `[...]`, and a `/**/` that should match no folder
  (`~/.aws/**/credentials` does not cover `~/.aws/credentials`).
- **Environment:** the process gets a stripped environment. Credentials for `gh`, `aws`,
  `gcloud`, `kubectl` and `docker` pass through. Add more names with `sandbox.envAllow`.
- **Speed:** these are the hot paths. They are designed to add about 1 ms over a raw process
  spawn. `npm run bench` measures them (see [Development](development.md#benchmarks)).

## Search

Every indexed item is split into chunks. Code is cut at declarations and each chunk is titled
with its symbol name.

- **Lexical:** SQLite FTS5 with porter and trigram tokenizers, BM25 ranking and typo correction.
- **Semantic:** local ONNX embeddings (`Xenova/bge-small-en-v1.5`, 384 dimensions) in
  `sqlite-vec`.
- **Hybrid:** both rankings are fused. If the model is not ready yet, search uses lexical
  results and does not wait.

Each chunk has a `source`, for example `memory`, `git`, `docs:<name>` or a sandbox label. Use
`em_search {source}` to filter.

## Session continuity

The capture hooks sort session events into 27 categories with four priority levels:

| Priority | Categories |
|---|---|
| P1 | files, tasks, plans, rules, user prompt |
| P2 | decisions, git, errors and their resolutions, constraints, blockers, rejected approaches, environment, agent findings, iteration loops, assistant summaries |
| P3 | latency, MCP tools, subagents, skills, external references, role |
| P4 | intent, data, tool calls, session start, recall decisions |

Before `/compact`, eminiar writes a **Session Guide** of 2 KB or less: P1 always, then P2, P3 and
P4 as space allows. When the session resumes, the guide is replayed. `em_search {sort:
"timeline"}` finds the full history.

## Storage

Storage goes through one interface, `src/storage/adapter.ts`. The SQLite adapter
(`better-sqlite3`) is the only module with SQL. A Postgres or libSQL adapter can be added later
for a shared team knowledge base.

## Privacy and data

**All data is local.**

| Location | Contents |
|---|---|
| `~/.eminiar/projects/<id>/eminiar.db` | Index, vectors, graph, history and sessions for one project |
| `~/.eminiar/` (global DB) | Lifetime statistics and the fetch cache |
| `~/.eminiar/models/` | The embedding model |
| `~/.eminiar/plugin/` | The stable plugin copy |
| `<project>/.eminiar/memories/` | Memory files (commit them) |
| `<project>/.eminiar/docs.json` | Documentation sources manifest (commit it) |

eminiar uses the network only to download the embedding model, to fetch pages and documentation
that you ask it to index, and to read package metadata from the npm, PyPI and Go registries. The
dashboard accepts loopback connections only.
