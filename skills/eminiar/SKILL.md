---
name: eminiar
description: Use eminiar's em_* tools to keep large outputs out of the context window — run commands and scripts in the sandbox (em_execute, em_batch_execute, em_execute_file), search indexed knowledge and session memory (em_search, em_recall), and query the project graph (em_graph_impact). Triggers on any task that would read logs, test output, git history, dependency trees, API responses, large files, or documentation.
user-invocable: false
---

# eminiar routing guide

Every byte a tool returns stays in the conversation. Prefer doing the work in the sandbox and
surfacing only the answer.

- **Run, don't read.** `em_execute` with `intent` runs a shell/JS/TS snippet; output over 5 KB is
  indexed and only sections matching `intent` return, with a vocabulary of searchable terms.
- **Batch research.** `em_batch_execute` runs labelled commands in parallel and answers `queries`
  against all outputs in one round trip.
- **Large files.** `em_execute_file` processes a file in the sandbox; only what you print returns.
- **Web pages.** `em_fetch_and_index` fetches and indexes a URL; follow with `em_search`.
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
- **Before refactors.** `em_graph_impact` on a file or symbol lists dependents, co-changing files,
  memories that mention it, and the reasons.

Plain `Bash`, `Read` and `Grep` stay right for short, fixed outputs and for files you will edit.
