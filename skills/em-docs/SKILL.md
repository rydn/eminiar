---
name: em-docs
description: Build and use the project's documentation knowledge base — discover local docs and the third-party libraries, services, infrastructure and APIs the code depends on, fetch their documentation into the local index (manifest .eminiar/docs.json, committed), and answer questions from it instead of the web.
user-invocable: true
argument-hint: [discover | add <url|path|provider|--pick recommended> | sync [name] | lookup <question> | list | remove <name>]
allowed-tools: mcp__plugin_eminiar_eminiar__em_docs, mcp__plugin_eminiar_eminiar__em_search
---

Act on `$ARGUMENTS` with `em_docs`; with no arguments, run `list` and, when it is empty, `discover`.

- **discover** → `em_docs {action: "discover"}`. Show the summary the tool returns and offer
  `{action: "add", pick: "recommended"}`; do not paste long candidate lists into the reply.
- **add** → a URL → `{action: "add", url}`; a project path → `{action: "add", path}`; a package,
  env prefix, image or API host → `{action: "add", provider: "npm:zod" | "env:SUMSUB" |
  "image:nats" | "api:api.example.com"}` (URLs are resolved through the catalogue, the package
  registry or by probing docs./developer./…/docs); `--pick <set>` → `{action: "add", pick}`.
  Sources are indexed immediately; a sync summary comes back.
- **sync** → `{action: "sync", names?}`; `--force` refetches and drops stale pages.
- **lookup / a question** → `{action: "lookup", query}` (several questions: `queries`); narrow to
  one source with `name`. Cite the `doc N` ids. Only when the answer is not in the index should
  you fall back to `em_fetch_and_index` for a specific page, then `{action: "add", url}` if it is
  worth keeping.
- **list** / **remove** → the matching action. `list` also shows sources *orphaned in the
  index* (pages indexed under `docs:<name>` with no manifest entry, e.g. the manifest lives on
  another branch); `remove` drops their pages, `add` with the same name re-registers them.

The manifest `.eminiar/docs.json` is meant to be committed; say so once when sources were added.
