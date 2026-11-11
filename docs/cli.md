# CLI

[← Docs index](README.md)

The `eminiar` command manages the installation. It also gives you the same index, graph and
documentation that Claude uses, from your terminal. Run `eminiar help` for the full usage.

## Setup

| Command | What it does |
|---|---|
| `eminiar install` | Install into Claude Code. Options: `--no-model`, `--method plugin\|settings`, `--cursor`, `--team`, `--marketplace github:org/repo`, `--statusline`, `--yes`, `--force` |
| `eminiar install --adjudicator[=X] [--accept-remote]` | Also turn on the [adjudicator](adjudicator.md) with provider `X` (`heuristic`, `embedding`, `typesafe`, `groq`, `cerebras`, `ollama`, `lmstudio` or `llamacpp`; bare `--adjudicator` = `heuristic`). Without the flag, an interactive install asks *"Use the adjudicator for tool, model and agent selection?"* (default No); `--yes` skips the question. A remote provider needs consent, and without a terminal only `--accept-remote` gives it |
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
eminiar purge <index|sessions|graph|memories|usage|adjudicator|all> --yes   # irreversible
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

## Agent swarms

```sh
eminiar swarm init [--force]                   # starter .eminiar/swarm.yaml plus generated agents
eminiar swarm validate                         # path:line messages; exit 1 on problems
eminiar swarm sync [--dry-run] [--force]       # regenerate (or remove) .claude/agents/swarm-*.md
eminiar swarm list                             # swarms, roles, agent file state, active runs
eminiar swarm runs [--limit 20]                # past and active runs
eminiar swarm status [run]                     # one run in full: the active one, else the latest
eminiar swarm release [--run id] [--agent id] [--role r]   # free stuck workers; tasks back to pending
eminiar swarm watch [--run id] [--interval 2]  # one JSON line per change, for the Monitor tool
```

`--json` works for every swarm command except `watch`, which always prints JSON lines. `sync` and
`init` exit 1 when a hand-written or hand-edited agent file is left in place, in text and JSON
mode alike; `sync --force` overwrites generated files edited by hand, and `sync --json` names the
`reason` when there was nothing to do. `release` with neither `--agent` nor `--role` frees every
worker quiet for 15 minutes, and needs `--run` when several runs are active. `watch` starts with
a `swarm.snapshot` line (or `swarm.finished` for a closed run) and then prints a line only when
tasks, workers or run events change, never for a worker's tool calls. An option such as
`--interval` given without a value exits 2. See [Agent swarms](swarms.md).

## Adjudicator

Opt-in and off by default. `eminiar adjudicator help` prints this list.

```sh
eminiar adjudicator status [--json]            # on/off, configured vs effective provider, key, consent, health
eminiar adjudicator enable [--provider P] [--preset X] [--mode advise|apply] [--project] [--accept-remote]
eminiar adjudicator disable [--project]
eminiar adjudicator provider <heuristic|embedding|typesafe|openai-compatible> [--preset X] [--base-url U] [--model M]
eminiar adjudicator provider --detect          # look for Ollama / LM Studio / llama.cpp; changes nothing
eminiar adjudicator key set [provider] [--from-env NAME]   # hidden prompt or stdin, never argv
eminiar adjudicator key clear [provider]
eminiar adjudicator key status [--json]        # where each key comes from, masked
eminiar adjudicator test "<text>" [--provider P] [--json]   # probe + score one sample; not stored
eminiar adjudicator eval [--provider P ...] [--providers a,b] [--fixture f.json|.js|.mjs] [--replace] [--repeat N] [--save] [--json]
eminiar adjudicator stats [--since 7d] [--json] [--reset-learning]
eminiar adjudicator exchanges [status] [--json]   # Jev request capture: on/off, how many are kept here
eminiar adjudicator exchanges on [--yes]          # keep the newest 100 Jev requests (contain redacted prompt text)
eminiar adjudicator exchanges off                 # turn off and delete this project's captured requests
eminiar adjudicator exchanges purge [--yes]       # delete this project's captured requests
```

- `status` is the default subcommand. It shows which layer decides `enabled` (environment,
  project file, global file or default), the effective provider and why it differs from the
  configured one, the key source, consent, the provider's breaker state with today's calls and
  spend, the last 24 hours, and in apply mode how many applied dispatches ran the chosen model.
- `enable` writes `~/.eminiar/config.json`. `--provider` and `--preset` take `heuristic`,
  `embedding`, `typesafe` or `jev`, `openai-compatible`, or a preset name (`groq`, `cerebras`,
  `ollama`, `lmstudio`, `llamacpp`, `custom`). With `--project` only `adjudicator.enabled: true`
  goes into the committed `eminiar.config.json`; the rest stays in your global file. For a remote
  provider it prints what will be sent and asks y/N; `--accept-remote` agrees without a
  terminal, and `--yes` never does. A missing key is asked for at a hidden prompt.
- `disable` keeps keys and consent. Run `/mcp reconnect` after `enable` or `disable` so the
  `em_adjudicate` tool appears or disappears.
- `key set` stores the key in `~/.eminiar/adjudicator.key` (mode 0600). The provider defaults to
  the one configured; `typesafe` (or `jev`) and the preset names are accepted. A key passed as an
  argument exits 2. `--from-env NAME` stores only the variable's name as `adjudicator.keyEnv`.
- `test` makes one provider call, shows the heuristic and the provider side by side, and exits 1
  when the provider fails. Nothing is stored.
- `eval` runs the built-in labelled set through the heuristic and each provider given (default:
  the configured one). `--fixture` adds labelled items, `--replace` uses them alone, `--repeat N`
  repeats for latency percentiles, `--save` keeps the report for the dashboard.
- `stats` summarises decisions, follow rate, spend and savings with their assumptions.
  `--reset-learning` clears the learned bias.
- `exchanges` (default `status`) manages [Jev request capture](adjudicator.md#jev-request-capture).
  `status` shows whether capture is on (and whether `EMINIAR_ADJUDICATOR_CAPTURE=0` is forcing it
  off) and how many requests are stored in this project. `exchanges on` writes
  `privacy.captureExchanges` to `~/.eminiar/config.json` only; `--project` is refused (exit 2).
  It prints what will be kept and asks y/N; without a terminal it needs `--yes`, or it changes
  nothing and exits 1. It warns when Jev is not the provider yet, since nothing is captured until
  it is. `exchanges off` turns capture off and deletes this project's captured requests, with no
  prompt; other projects keep theirs until you run `exchanges purge` in each. `exchanges purge`
  asks y/N (or needs `--yes` without a terminal), deletes this project's captured requests and
  leaves the setting as it is. Both erase the text from the database file and the write-ahead log
  (secure delete plus a checkpoint, best effort for the log while another process holds the
  database); `eminiar purge adjudicator|all` does the same.

Exit codes: 2 for a usage error (unknown provider, preset or mode, a key on the command line),
1 when consent is declined or a key or provider call fails. See [Adjudicator](adjudicator.md).

## Playbooks

```sh
eminiar playbook list [--tag t] [--limit N]    # stored recurring tasks
eminiar playbook show <name>                   # one playbook with its prompt
eminiar playbook add <name> --title T (--prompt P | --file F | stdin) [--param n[=default]] [--schedule S] [--tag t] [--private] [--replace]
eminiar playbook edit <name> [--title T] [--prompt P | --file F] [--param n[=default]] [--schedule S] [--tag t]
eminiar playbook rm <name>
eminiar playbook run <name> [--set k=v] [--note N]   # print the filled prompt and record a run
eminiar playbook runs [name] [--limit N]       # recorded runs
eminiar playbook export <name> [--skill [--target DIR] [--model-invocable]] [--schedule] [--set k=v]
eminiar playbook scan [--dry-run]              # opt-in: suggest playbooks from recurring tasks
```

`--json` works for every subcommand. `run` only prints the prompt (and warns about parameters
left unfilled): eminiar never runs a playbook; you paste the prompt into Claude. `export` prints
the markdown file; `--skill` writes `<target>/<name>/SKILL.md` (default `.claude/skills`) with
`disable-model-invocation` unless you pass `--model-invocable`; `--schedule` prints text for a
scheduled task. `scan` exits 1 until `playbooks.extraction.enabled` is true, and only saves
suggestions, which you accept or dismiss in the dashboard or with `em_playbook`. See
[Tools](tools.md#playbooks).

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
