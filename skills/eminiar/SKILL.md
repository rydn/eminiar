---
name: eminiar
description: Use eminiar's em_* tools to check the project's memories and documentation before deciding, and to keep large outputs out of the context window — recall past decisions, constraints and fixes (em_recall, em_memory), answer library/service/API questions from the indexed docs (em_docs lookup), run commands and scripts in the sandbox (em_execute, em_batch_execute, em_execute_file), search everything indexed (em_search), query the project graph (em_graph_impact) and the classified git history (em_history). Triggers on starting a task, changing a design, choosing an approach, using a library or API, or any task that would read logs, test output, git history, dependency trees, API responses, large files, or documentation.
user-invocable: false
---

# eminiar routing guide

## Knowledge first

The project remembers things so you do not have to rediscover or re-decide them.

- **Before starting a task or changing a design**, `em_recall {query}` for the decisions,
  constraints, rejected approaches and fixed errors on that topic. Respect what it returns, or
  supersede it explicitly (`em_remember {kind: "decision", supersedes}`).
- **Before WebFetch/WebSearch** for a library, framework, service or API the project uses,
  `em_docs {action: "lookup", query}`. Go to the web only when the indexed docs do not answer.
- **Recall arrives on its own too.** Treat these hook notes as project rules, not noise:
  - `eminiar recall — …` on a prompt: memories and doc pages matching the request.
  - `eminiar memory: …` before reading or editing a file: the memories linked to it. Read the
    full memory with `em_memory {action: "read", name}` when the gist is not enough, and update
    it when your change overrides it.
  - `eminiar history: … is bug-prone` before an edit: read the fixes with
    `em_history {action: "file", path}` and keep the behaviour they restored under test.
  - `eminiar graph: N other files import or use …` before an edit: `em_graph_impact` before
    changing an exported signature.
  - Before `git commit`: the bug-prone and widely imported files in the commit.
  - After a failed call: `this error has been seen before` with what resolved it last time. Try
    that first.
  - `eminiar docs: …` before WebSearch/WebFetch: indexed pages that already answer it.
- **When something durable is settled** (a decision and why, a constraint, a gotcha, a preference),
  `em_remember` it, with `related_files: ["<path>"]` when it is about specific files, so it is
  surfaced the next time those files are read or edited.

## Keep output out of context

Every byte a tool returns stays in the conversation. Prefer doing the work in the sandbox and
surfacing only the answer.

- **Run, don't read.** `em_execute` with `intent` runs a shell/JS/TS snippet; output over 5 KB is
  indexed and only sections matching `intent` return, with a vocabulary of searchable terms.
- **Batch research.** `em_batch_execute` runs labelled commands in parallel and answers `queries`
  against all outputs in one round trip.
- **Large files.** `em_execute_file` processes a file in the sandbox; only what you print returns.
  Images and PDFs are the exception: `Read` shows them, so read those directly.
- **Library, service and API docs.** `em_docs {action: "lookup", query}` answers from the
  project's documentation knowledge base (local docs plus the third-party libraries, services,
  infrastructure and APIs it uses, registered in `.eminiar/docs.json`). Ask it before
  `WebFetch`/`WebSearch`; `{action: "discover"}` finds what to index, `{action: "add", pick:
  "recommended"}` or `{action: "add", url | path | provider}` indexes it, `{action: "sync"}`
  refreshes. `/em-docs` is the slash command.
- **Web pages.** `em_fetch_and_index` fetches and indexes a URL; follow with `em_search`. Keep a
  page you will need again with `em_docs {action: "add", url}`.
- **Ask what's known.** `em_search` (multiple queries, `sort: "timeline"` after a resume) and
  `em_recall` for decisions, constraints and errors captured from earlier sessions.
- **Record decisions.** `em_remember {content, kind, name?}` with kind
  `decision|constraint|fact|preference|todo|note|onboarding` writes a markdown memory under
  `.eminiar/memories/<topic>/<name>.md` (human-editable, committed with the repo).
  `em_memory {action: list|read|edit|rename|delete}` manages them; `/em-onboard` writes the
  onboarding set.
- **Navigate by symbol, not by file.** `em_symbols {mode: "overview", file}` lists a file's
  symbols with line ranges; `{name_path: "Class/method", include_body: true}` returns one
  definition; `{mode: "references", name_path}` lists callers and other uses. Search hits on code
  are titled by symbol (`src/x.ts > Class.method`). `em_search {mode: "regex"}` greps indexed
  content with context.
- **Start from the map.** `em_architecture` gives languages, folders, entry points, routes, hotspots
  and accepted decisions in one call; ask for `aspects` to keep it short. Use it before listing
  directories or reading files to orient.
- **Before refactors.** `em_graph_impact` on a file or symbol lists dependents, co-changing files,
  memories that mention it, and the reasons. `em_graph_changes` does the same for the whole working
  tree diff (or against a ref) and rates each touched symbol's exposure.
- **Ask the graph.** `em_graph_query { pattern }` walks typed edges (`calls`, `imports`, `handles`,
  `extends` …) from a filter to a filter; presets cover `hotspots`, `routes`, `dead_code`, `cycles`,
  `clusters`, `coupled`, `orphans`.
- **Learn from the history.** `em_history` reads git for you: `{action:"file", path}` before editing
  a file tells you its fixes, the changes to it that later needed fixing and who knows it;
  `{action:"risk"}` rates the files in the working tree before a commit; `{action:"commit", sha}`,
  `{action:"branch", name}`, `{action:"symbol", name_path}` and `{action:"search", query}` answer
  "what changed, why, and what broke afterwards" without `git log`. Treat a `⚠ later fixes` flag or
  a file risk ≥ 0.3 as a reason to read those fixes and add a test for the behaviour they restored.
  Commit messages are indexed (source `git`) for `em_search`. `/em-history` is the slash command.
- **Trust, but check coverage.** `em_index_status` says whether the graph is behind HEAD or the
  working tree and which files were skipped. A clean result means no recorded gap, not proof of
  completeness; verify negative claims ("nothing calls X") against it.
- **Decisions have a lifecycle.** `em_remember {kind: "decision", status, supersedes}` records ADR-style
  decisions; `em_memory {action: "status"}` changes one. `em_architecture` lists the accepted ones.

Plain `Bash`, `Read` and `Grep` stay right for short, fixed outputs and for files you will edit.
