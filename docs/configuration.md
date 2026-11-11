# Configuration

[← Docs index](README.md)

## Where settings come from

eminiar merges four layers. A later layer overrides an earlier one, except for the lists
described under [How layers merge](#how-layers-merge).

| Order | Source | Use for |
|---|---|---|
| 1 | Built-in defaults | — |
| 2 | `~/.eminiar/config.json` | Your personal settings |
| 3 | `<project>/eminiar.config.json` | Team settings. **Commit this file** |
| 4 | `EMINIAR_*` environment variables | One-off overrides |

`eminiar.config.schema.json` is the JSON Schema for every key. The file written by
`eminiar install --team` already points to it, so your editor completes the keys and checks
their values:

```json
{ "$schema": "https://raw.githubusercontent.com/rydn/eminiar/main/eminiar.config.schema.json" }
```

## Example

A project `eminiar.config.json` (`~/.eminiar/config.json` takes the same keys):

```json
{
  "routing": { "mode": "enforce" },
  "sandbox": { "timeoutMs": 120000 },
  "recall": { "maxMemories": 5 },
  "docs": { "crawl": { "maxPages": 20 } }
}
```

## How layers merge

Objects merge key by key. Any other value replaces the one from the earlier layer, and so do
most lists: a `graph.include` or `index.docs` you set replaces the built-in list, and one in
the project file also replaces your personal one.

Three lists add up instead: `graph.exclude`, `permissions.extraDeny` and
`sandbox.disabledLanguages`. The result is the built-in list, then the entries of your personal
config, then those of the project file, each entry once. They only make eminiar skip or refuse
more, so a project file can add a deny rule, but cannot remove one of yours (`"extraDeny": []`
changes nothing). To skip one more folder, list only that folder:

```json
{ "graph": { "exclude": ["**/generated/**"] } }
```

In `graph.exclude` only, an entry that starts with `!` removes that exact entry from the
built-in list, for example `"!**/vendor/**"` to parse vendored code. It never removes any other
entry a config file lists, so a project file cannot take back one of your own excludes. A
personal entry that only repeats a built-in entry does not count as yours here: earlier
versions of `eminiar install` copied the whole built-in list into `~/.eminiar/config.json`, so
a `!` in the project file still removes it. The `!` entry itself is not kept. In the other two
lists `!` has no special meaning.

Earlier versions replaced `graph.exclude` too. If your personal config sets a short list so that
some built-in folders get parsed, for example `["**/node_modules/**"]` to parse `build/` and
`vendor/`, eminiar now adds the built-in list back and skips those folders again. Remove each
built-in entry you want parsed with `!`:

```json
{ "graph": { "exclude": ["!**/build/**", "!**/vendor/**"] } }
```

A value the schema refuses (a wrong type, or a number above its limit) makes only the file that
holds it invalid. eminiar ignores that whole file, prints a note on stderr naming it, and uses
the other layers. A bad `recall.maxMemories` in your personal config therefore leaves the team's
`routing.mode` in force. A file can also be valid on its own but not on top of the earlier ones,
for example when the project file's `adjudicator.weights.features` and yours together hold more
than 64 keys. Then eminiar ignores only the fields the schema names in the later file (here the
project file's `adjudicator.weights.features`), or that whole file when that is not enough, and
names the file and the fields on stderr. A later file never costs an earlier one its settings.
`eminiar doctor` names the invalid values of `eminiar.config.json`.

Keys the schema does not know, such as a typo like `recall.maxMemory`, are ignored when the
config loads and never make a file invalid, so a config written for a newer eminiar still
loads. Your editor flags only invalid values of known keys, so check the key names against the
tables below.

## All keys

### `routing`

| Key | Default | Description |
|---|---|---|
| `mode` | `"auto"` | `auto`, `enforce`, `annotate` or `off`. See [Routing](how-it-works.md#routing) |
| `deferToContextMode` | `true` | While the context-mode plugin is installed, in every mode except `off`, eminiar gives no routing suggestion for `Bash`, `Read`, `Grep` and `WebFetch` and keeps only its own hints (symbols, coverage, file memos). `auto` also annotates instead of enforcing |

### `sandbox`

| Key | Default | Description |
|---|---|---|
| `timeoutMs` | `60000` | Time limit for one run |
| `maxOutputBytes` | `2097152` (2 MB) | Output cap per stream in one run: stdout stops at this many bytes, stderr keeps its last this many characters |
| `indexThreshold` | `5120` (5 KB) | Output larger than this is indexed, and only matching sections return |
| `envAllow` | `[]` | Extra environment variable names to pass to the sandbox. `*` matches any characters (`"MY_*"`). A name the sandbox always withholds (`ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `*_API_KEY`) passes only when listed exactly, never through a glob. Only your personal config (`~/.eminiar/config.json`, or `$EMINIAR_HOME/config.json` when that is outside the project) can set it. In an `eminiar.config.json` in the project, or in a personal config the repo places inside the project, the whole key is ignored with a note on stderr, so a cloned repo cannot choose which of your variables its scripts see |
| `disabledLanguages` | `[]` | Languages to turn off, for example `["php"]`. Adds to the earlier layers |

### `search`

| Key | Default | Description |
|---|---|---|
| `defaultLimit` | `5` | Results per query |
| `defaultMaxTokens` | `2000` | Size limit of a search answer |

### `embeddings`

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Use semantic search. `false` keeps search lexical only |
| `model` | `"Xenova/bge-small-en-v1.5"` | ONNX embedding model |
| `dims` | `384` | Vector dimensions of the model |

### `graph`

| Key | Default | Description |
|---|---|---|
| `include` | `**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,php}` | Files to parse |
| `exclude` | `node_modules`, `dist`, `build`, `.git`, `coverage`, `*.d.ts`, virtualenvs, `__pycache__`, `site-packages`, `vendor`, `*.min.js`, `*.blade.php` | Files to skip. Adds to this list and the earlier layers; `"!<glob>"` removes a built-in one (see [How layers merge](#how-layers-merge)) |

### `git`

| Key | Default | Description |
|---|---|---|
| `maxCommits` | `3000` | How many commits the history and co-change analysis read |

### `index`

| Key | Default | Description |
|---|---|---|
| `docs` | `["**/*.md", "**/*.mdx"]` | Project markdown to index for search |

### `permissions`

| Key | Default | Description |
|---|---|---|
| `extraDeny` | `[]` | Extra Bash deny rules for the sandbox, in addition to Claude Code's `permissions.deny`. Adds to the earlier layers; a project file cannot remove a personal rule |

### `memories`

| Key | Default | Description |
|---|---|---|
| `dir` | `".eminiar/memories"` | Where memory files live, relative to the project root |

`memories.dir` must be a path inside the project, by the same rule as `docs.manifest` below: an
absolute path, a drive letter, a `..` segment or a control character is refused, and a config
file that sets one is ignored for that key only, with a stderr note. Sessions repair missing or stale
headers of the memory files there, so a cloned repo must not aim it at your other files.

### `recall`

| Key | Default | Description |
|---|---|---|
| `onPrompt` | `true` | Attach matching memories and docs to each prompt |
| `onFile` | `true` | Attach memories and fix history before a file read or edit, fan-in before an edit |
| `onAgent` | `true` | Add the brief and matching knowledge to subagent prompts |
| `onCommit` | `true` | List risky files before `git commit` |
| `onError` | `true` | Attach earlier occurrences of a failed call's error |
| `onWeb` | `true` | Attach indexed doc pages before `WebSearch` / `WebFetch` |
| `maxMemories` | `3` | Memories per prompt, `0` to `10` |
| `maxDocs` | `2` | Doc pages per prompt, `0` to `10` |
| `repeatAfter` | `10` | Prompts after which an item already shown in this context window may be attached again (`0` = once per window), at most `1000` |

### `docs`

| Key | Default | Description |
|---|---|---|
| `manifest` | `".eminiar/docs.json"` | The documentation sources manifest, relative to the project root (see below) |
| `ttlHours` | `168` (7 days) | Page cache lifetime |
| `crawl.depth` | `1` | Link depth for dependency docs, `0` to `3` |
| `crawl.maxPages` | `8` | Pages per dependency source, `1` to `200` |
| `crawl.maxPageBytes` | `122880` (120 KB) | Page size cap |
| `crawl.api.depth` | `2` | Link depth for external API docs, `0` to `3` |
| `crawl.api.maxPages` | `150` | Pages per external API source, `1` to `200` |
| `embed` | `false` | Also embed documentation for semantic search |
| `discover.includeDev` | `false` | Include dev dependencies in discovery |
| `discover.subprojects` | `true` | Scan one level of sub-projects |
| `catalog` | `[]` | Extra catalogue entries. Required: `id`, `title`, `urls`. Optional lists of strings: `npm`, `pypi`, `go`, `env`, `image`, `files`, `hosts`, `tags`. Optional: `tier` (`service`, `infra` or `library`) and `crawl` (`depth` `0` to `3`, `maxPages` `1` to `200`) |

`docs.manifest` must be a path inside the project: an absolute path, a drive letter, a `..`
segment or a control character (a newline, NUL) is refused by the schema, and a project
`eminiar.config.json` or a personal config that sets one is ignored for that key only (a stderr
note says so; the next layer's or the default value applies, and the rest of both files stays). Because
`em_docs add` / `remove` rewrite this file, a write is also refused when:

- the path, or the folder it is in, resolves outside the project through a symlink;
- the manifest itself is a symlink, even to a file inside the project (writes replace only a
  regular file; reads still follow a symlink that stays inside the project);
- it is not a manifest this version can rewrite without losing data: `version` other than `1`,
  top-level keys other than `version` and `sources`, a `sources` that is not an array, or an
  entry that is not valid (bad name, duplicate, unknown kind, a `path` outside the project; a
  stderr note names a source dropped for its path, and `em_docs remove` of that name still
  works because the write loses nothing else);
- it could not be read (too large, not a regular file, not JSON, a merge conflict).

The refusal names the file and the reason; fix or move the file, then retry. Hooks and other
readers never fail on it: an unreadable or outside manifest reads as empty. Writes go to a temp
file in the same folder that is renamed over the manifest, keeping its file mode.

### `usage`

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Ingest Claude Code transcripts (tokens, cache, cost per model call) and record statusline snapshots |
| `budgets.sessionUsd` | unset | Session cost above which the next prompt gets a one-line warning (once per session). Never blocks |
| `budgets.dailyUsd` | unset | The same for the calendar day |
| `budgets.turnUsd` | `1.00` | A single API call above this is flagged as an expensive turn |
| `pricing` | `{}` | Price overrides, USD per million tokens, keyed by a substring of the model id (first match wins): `input`, `output`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`. Missing fields fall back to the bundled table |
| `statusline` | `true` | Append `$<cost> · ctx <pct>% · 5h <pct>%` to `eminiar statusline` |

See [Usage insights](usage.md) for the sources, the privacy notes and the savings model.

### `adjudicator`

Optional and off by default. See [Adjudicator](adjudicator.md). Two rules apply to this section
only:

- It must not hold a key. A field named like `apiKey`, `token`, `secret` or `password` makes the
  config invalid. Keys go in `~/.eminiar/adjudicator.key` (`eminiar adjudicator key set`) or an
  environment variable named by `keyEnv`.
- Only `enabled`, `surfaces`, `promptMode`, `minPromptChars`, `weights`, `advice`, `embedding`,
  `learning` and `cache` may be set in the committed `eminiar.config.json`, plus `mode: "advise"`
  (a project can keep the adjudicator advise-only). Everything that decides where text and keys
  go or how much is spent, plus apply mode, its settings and the tier ladder (`provider`,
  `typesafe`, `openai`, `keyEnv`, `remoteConsent`, `remoteConsentOrigins`, `privacy`, `budget`,
  `timeouts`, `breaker`, `mode: "apply"`, `apply`, `tiers`) comes from `~/.eminiar/config.json`
  only, and from there only while that file is outside the project (see `EMINIAR_HOME` below).

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Turn the adjudicator on. `EMINIAR_ADJUDICATOR=0` is the kill switch |
| `provider` | `"heuristic"` | `heuristic`, `embedding`, `typesafe` (Jev) or `openai-compatible` |
| `mode` | `"advise"` | `advise` only suggests; `apply` sets the Agent `model` and `effort` on the dispatches `apply.scope` covers (the effort also when the model is kept; never for a fork or while `CLAUDE_CODE_EFFORT_LEVEL` is set). See [Advise and apply](adjudicator.md#advise-and-apply) |
| `surfaces.prompt` | `true` | Score prompts (UserPromptSubmit) |
| `surfaces.agent` | `true` | Score subagent dispatches (PreToolUse on `Agent`) |
| `surfaces.plan` | `true` | Add suggestions to `em_swarm plan` |
| `surfaces.tools` | `false` | Hint when a raw tool call contradicts the prompt's advised `em_*` tool |
| `promptMode` | `"async"` | How the provider runs on a prompt: `async` (detached; the heuristic answers now), `blocking` (inline within `timeouts.promptMs`) or `heuristic` (never) |
| `typesafe.model` | `"jev-1.14.0"` | Jev model. `jev-latest` and `jev-preview` are replaced by the pinned version |
| `typesafe.baseUrl` | `"https://api.typesafe.ai/v1"` | Jev endpoint |
| `openai.preset` | `"groq"` | `groq`, `cerebras`, `ollama`, `lmstudio`, `llamacpp` or `custom` |
| `openai.baseUrl` | unset (the preset's) | Overrides the preset's URL; required for `custom`. A non-loopback URL makes any preset remote |
| `openai.model` | unset (the preset's) | Overrides the preset's model; required for `custom` |
| `openai.json` | `"auto"` | `schema` (strict JSON schema), `object` (JSON mode) or `auto` (schema, falling back to JSON mode when the server rejects it) |
| `openai.price.inPerM` | unset (the preset's) | USD per million input tokens. Without a price, a preset with an unknown price reports no cost. Set it together with `outPerM`: one without the other makes the config invalid |
| `openai.price.outPerM` | unset (the preset's) | USD per million output tokens. Set it together with `inPerM` |
| `embedding.k` | `5` | Nearest examples that vote |
| `embedding.minSimilarity` | `0.55` | Cosine similarity below which an example does not count; with none, the heuristic answers |
| `keyEnv` | unset | The NAME of an environment variable holding the key, never the key |
| `remoteConsent` | `false` | Consent to send redacted text to a remote provider. Set by `enable`/`provider` after you agree |
| `remoteConsentOrigins` | unset | The origins (`scheme://host[:port]`, at most 64) you agreed to send text to, written by the consent prompt of `enable`/`provider`. A remote provider runs only when its origin is listed. Read from `~/.eminiar/config.json` only |
| `timeouts.promptMs` | `1200` | Provider deadline on prompts (remote providers) |
| `timeouts.agentMs` | `800` | Provider deadline on dispatches and tool hints (remote providers) |
| `timeouts.planMs` | `3000` | Deadline for a plan batch, `em_adjudicate score` and each eval chunk |
| `timeouts.localMs` | `600` | Provider deadline on prompts and dispatches for local providers |
| `timeouts.connectMs` | `150` | Port probe timeout for `provider --detect` |
| `minPromptChars` | `12` | Shorter prompts are not scored |
| `tiers` | `["haiku", "sonnet", "opus"]` | The model ladder, smallest first. Add `"fable"` to allow it. Each tier at most once (at most 4 entries), since every provider request carries the whole ladder |
| `weights.providerMax` | `0.7` | Largest weight a Jev or OpenAI-compatible answer gets in the blend |
| `weights.embeddingMax` | `0.4` | Largest weight an embedding answer gets |
| `weights.selfReportScale` | `0.6` | Multiplier on a model's self-reported confidence (Jev's calibrated confidence is used as is) |
| `weights.lowConfidence` | `0.55` | A tier choice below this confidence moves one tier up |
| `weights.tierCenters` | `{"haiku": 0.6, "sonnet": 2.0, "opus": 3.4}` | The complexity each tier fits best (at most 16 entries) |
| `weights.features` | `{}` | Per-feature weight overrides, for example `{"design": 2.0}`. `asymmetry` (default 2) sets how strongly the tier leans up; `toolProvider` above 0 lets a provider vote on the tool. At most 64 entries |
| `apply.scope` | `"swarm"` | In apply mode, set the model and the effort on swarm worker dispatches only (`swarm`) or on every dispatch (`all`) |
| `apply.minConfidence` | `0.7` | Apply a model only at or above this tier confidence (the effort is set whatever the confidence) |
| `apply.floor` | `"haiku"` | Smallest tier apply mode sets |
| `apply.ceiling` | `"opus"` | Largest tier apply mode sets |
| `apply.respectFrontmatter` | `true` | Leave a dispatch's model alone when its agent file pins a `model` (`inherit` is not a pin; the effort is still set). A swarm role with a `model_range` still moves inside its range ([Model ranges](swarms.md#model-ranges)). `false` ignores pins and ranges alike: a pinned or ranged agent is advised and set like one with no `model` line, between `apply.floor` and `apply.ceiling` |
| `advice.mainSession` | `"user"` | Main-session `/model` note: `user` (shown to you), `context` (to Claude) or `off` |
| `advice.cooldownPrompts` | `8` | At most one main-session note per this many prompts |
| `learning.enabled` | `true` | Learn a bias from outcomes and feedback |
| `learning.maxBias` | `0.3` | Bound on the learned bias |
| `learning.minSamples` | `5` | Outcomes a bucket needs before its bias applies |
| `learning.halfLife` | `50` | Outcomes after which an old outcome counts half |
| `learning.costWeight` | `0.05` | How much a bucket's cost pulls its bias down |
| `cache.ttlHours` | `24` | Lifetime of a cached blended verdict |
| `cache.maxEntries` | `2000` | Verdict cache size |
| `breaker.failures` | `2` | Consecutive failures that open the circuit breaker |
| `breaker.cooldownSec` | `120` | How long an open breaker or the slow guard skips the provider |
| `budget.dailyUsd` | `0.5` | Spend cap per remote provider per UTC day |
| `budget.dailyCalls` | `2000` | Call cap per remote provider per UTC day (`0` = unlimited). Limits providers whose price is unknown |
| `privacy.maxChars` | `2000` | Characters of redacted text a remote provider receives per item |
| `privacy.storeHead` | `true` | Keep the first 80 redacted characters of each input in the database |
| `privacy.captureExchanges` | `false` | Keep the newest 100 requests sent to TypeSafe Jev and its answers, with timing, for the dashboard. They contain redacted prompt text, at most 65,536 characters per request or answer. Personal `~/.eminiar/config.json` only: `eminiar.config.json` cannot set it. See [Jev request capture](adjudicator.md#jev-request-capture) |

## Environment variables

| Variable | Effect |
|---|---|
| `EMINIAR_ROUTING_MODE` | Overrides `routing.mode` |
| `EMINIAR_EMBEDDINGS=0` | Turns off embeddings |
| `EMINIAR_HOME` | Moves the data directory (default `~/.eminiar`). A `config.json` there that lies inside or above the project (or any git work tree around it, a submodule's superproject included), or a relative `EMINIAR_HOME`, cannot set the adjudicator's provider, consent, endpoints, `keyEnv`, privacy, budget, timeouts, apply mode, `apply` or `tiers`, since a repo's `.claude/settings.json` could set this variable. The same applies when `HOME` is moved into the project |
| `CURSOR_CONFIG_DIR` | Where `install --cursor` writes Cursor's `hooks.json`, `mcp.json` and `skills/` (default `~/.cursor`) |
| `EMINIAR_PROJECT_ROOT` | Sets the project root of the MCP server and the CLI. Otherwise `CLAUDE_PROJECT_DIR`, then the current directory. Under Claude Code and Cursor the hooks always use `CLAUDE_PROJECT_DIR`, so setting this for a session puts the hooks and the server in different projects. `SessionStart` exports it to Bash commands through `CLAUDE_ENV_FILE`, so `eminiar` run from Bash uses the session's project; a `claude` started from Bash inherits it too, and its server then uses the outer session's project |
| `EMINIAR_DEBUG` | Prints stack traces from the CLI |
| `CLAUDE_CONFIG_DIR` | Claude Code's own variable for its config directory (default `~/.claude`). eminiar follows it for settings, permission rules, agents, plugins, transcripts and `.claude.json`, which then lives inside that directory instead of at `~/.claude.json` |
| `CLAUDE_CODE_PLUGIN_CACHE_DIR` | Claude Code's own variable for its plugins root (default `plugins/` in the config directory). eminiar follows it for `installed_plugins.json`, the plugin cache and plugin agents |
| `EMINIAR_CLAUDE_DIR` | Where Claude Code keeps its transcripts (default: `CLAUDE_CONFIG_DIR`, else `~/.claude`) |
| `EMINIAR_ADJUDICATOR=0` / `=1` | Turns the adjudicator off (the kill switch) or on, over every config file |
| `EMINIAR_ADJUDICATOR_PROVIDER` | Overrides `adjudicator.provider`. A remote provider runs only when `remoteConsentOrigins` in `~/.eminiar/config.json` lists its origin |
| `EMINIAR_ADJUDICATOR_MODE` | Overrides `adjudicator.mode` (`advise` or `apply`) |
| `EMINIAR_ADJUDICATOR_REMOTE=0` | Withdraws remote consent. `=1` does nothing: no environment variable can grant consent, because a project's `.claude/settings.json` can set them |
| `EMINIAR_ADJUDICATOR_CAPTURE=0` | Turns Jev request capture off (`=1` does nothing) |
| `EMINIAR_ADJUDICATOR_KEY` | Adjudicator provider key, checked after `keyEnv` and the provider's own variable (`TYPESAFE_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`) and before `~/.eminiar/adjudicator.key` |
