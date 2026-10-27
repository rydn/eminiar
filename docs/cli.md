# CLI

[← Docs index](README.md)

The `eminiar` command manages the installation. It also gives you the same index, graph and
documentation that Claude uses, from your terminal. Run `eminiar help` for the full usage.

## Setup

| Command | What it does |
|---|---|
| `eminiar install` | Install into Claude Code. Options: `--no-model`, `--method plugin\|settings`, `--cursor`, `--team`, `--marketplace github:org/repo`, `--statusline`, `--yes`, `--force` |
| `eminiar install --cursor` | Also register with Cursor: hooks in `~/.cursor/hooks.json`, the MCP server in `~/.cursor/mcp.json`, skills in `~/.cursor/skills/`. Without the `claude` CLI this installs for Cursor only |
| `eminiar upgrade` | Update to the latest version and re-register with every client from the last install |
| `eminiar uninstall [--purge-data]` | Remove from Claude Code and Cursor. Data is kept unless you add `--purge-data` |
| `eminiar doctor [--json] [--fix]` | Check installation health. `--fix` re-pins Node.js and the root, and clears Claude Code's cached launch failure |
| `eminiar replace-context-mode [--yes]` | Remove the context-mode plugin after you are satisfied with eminiar |

## Search and recall

```sh
eminiar search "token refresh"                 # hybrid search
eminiar search "parseFile" --code              # code only
eminiar search "auth" --source memory          # one source
eminiar search "what happened" --timeline      # newest first
eminiar search "x" --lexical --limit 10 --json

eminiar recall "rate limiting"                 # memories and session history
eminiar index docs/ --source notes             # index files or a directory

eminiar recall --explain "why is the pool capped"   # why hook recall would (not) fire, per candidate
eminiar recall --explain "…" --session <id>         # counting what that session was already shown
eminiar recall --file src/storage/pool.ts            # what a Read/Edit of the file would attach
eminiar recall --replay [--limit 200] [--since 30d]  # re-run past prompts: hit rate, closest misses
```

## Graph

```sh
eminiar graph architecture                     # the project map
eminiar graph status                           # index freshness and skipped files
eminiar graph changes [ref]                    # what the working tree (or a ref) touches

eminiar graph impact src/auth.ts               # what breaks if this changes
eminiar graph deps src/auth.ts                 # what it depends on
eminiar graph dependents src/auth.ts
eminiar graph neighbors src/auth.ts --depth 2
eminiar graph path src/a.ts --to src/b.ts
eminiar graph find parseFile

eminiar graph hotspots | routes | dead_code | cycles | clusters | coupled | orphans | stats
eminiar graph pattern '{"from":{"kind":"route"},"edge":{"kinds":["handles"],"direction":"in"}}'
```

## Documentation

```sh
eminiar docs discover [--dev] [--no-subprojects]
eminiar docs add --pick recommended
eminiar docs add --url https://docs.example.com --name example
eminiar docs add --provider npm:zod
eminiar docs add --path specs/openapi.yaml
eminiar docs list
eminiar docs sync [name ...] [--force]
eminiar docs lookup "webhook signatures" [--name stripe]
eminiar docs resolve npm:zod
eminiar docs remove example
```

`--pick` accepts `recommended`, `local`, `service`, `infra`, `catalog`, `api`, `registry` or
`all`. See [Documentation knowledge base](documentation-kb.md).

## Maintenance

```sh
eminiar reindex                                # incremental, all scopes
eminiar reindex --scope code --full            # code | git | metrics | docs | memories | embeddings | all
eminiar stats [--lifetime]                     # context savings, routing interceptions, recall hit rate
eminiar purge <index|sessions|graph|memories|usage|all> --yes   # irreversible
```

## Usage insights

```sh
eminiar usage                                  # summary: cost today / 7d / 30d, cache, models, block, insights
eminiar usage session                          # the current session
eminiar usage daily | weekly | monthly         # one row per period, cost per model
eminiar usage models | sessions | blocks       # breakdowns; blocks = 5-hour windows and burn rate
eminiar usage turns --session <id>             # context timeline of one session with compactions
eminiar usage tools                            # which tools fill the context
eminiar usage insights | savings
eminiar usage daily --since 30d --json         # ISO date or 30d / 12h / 2w; --json for the aggregate
eminiar usage sessions --csv                   # daily, weekly, monthly, models, sessions, blocks
eminiar usage ingest                           # read every transcript of the project now
```

`--session <id>` narrows any view to one session and `--limit N` caps list views. See
[Usage insights](usage.md).

## Dashboard and status line

```sh
eminiar ui [--port 7331] [--no-open]           # local web dashboard (alias: serve)
eminiar statusline                             # Claude Code statusLine command
```

## Other

```sh
eminiar hook [--event E] [--client cursor]     # run the hook handler by hand (JSON on stdin)
eminiar version
eminiar help
```
