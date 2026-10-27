# Usage insights

[← Docs index](README.md)

eminiar reads the transcripts Claude Code writes on your machine and keeps, per API call, the
tokens, cache traffic, model and estimated cost. From that it answers *what did today cost*,
*which model and which session*, *is the prompt cache working*, *what fills my context*, and
*what did eminiar's own tools save*. Everything stays on your machine; nothing is sent anywhere.

```text
/em-usage                       # summary in Claude Code
eminiar usage                   # the same from the terminal
eminiar ui  →  Usage tab        # charts, tables, insights
```

## Where the numbers come from

| Source | What it gives | How |
|---|---|---|
| Transcripts `~/.claude/projects/<slug>/*.jsonl` | One row per API request: model, input / output tokens, cache writes (5 min and 1 h), cache reads, thinking tokens, web searches, speed, effort, branch, subagent id. Tool results with their size. Compactions and clears | Ingested incrementally by byte offset, on session start, after tool calls and whenever `em_usage` runs |
| `eminiar statusline` | Cost, context window use and plan limits (5-hour and 7-day windows, subscribers only) as Claude Code reports them | A snapshot is stored whenever one of those figures changes |
| eminiar's own `stats` table | Characters each `em_*` tool looked at versus what it returned | Recorded by every `em_*` tool call |

Subagent transcripts are rolled up into their parent session. Claude Code deletes transcripts
after about 30 days; eminiar's tables are the durable copy, so your history outlives them.

## What is stored, and where

Five tables in the project database (`~/.eminiar/projects/<id>/eminiar.db`):

- `api_calls`: one row per request, keyed by request and message id, with `cost_usd` filled from
  the price table at ingest time and `priced = 0` when the model is unknown.
- `tool_uses`: tool name, input and result size, error flag.
- `context_events`: compactions and clears, with the token count before and after when the
  transcript carries it.
- `transcript_files`: the byte offset read so far per file.
- `statusline_snapshots`: the statusline figures when they changed.

No prompt text, tool input or tool output is stored by this feature: only sizes, ids and
counters. `eminiar purge usage --yes` (or `em_purge {scope:"usage"}`) empties the five tables.

## Cost is an estimate

- Prices are Anthropic's list prices per million tokens, bundled in `src/usage/pricing.ts` with
  the date they were checked. Bedrock and Vertex differ.
- Subscription users (Pro, Max) are not billed per token; the figures show the **API-equivalent**
  cost of the same calls, which is useful for comparing sessions and models, not for an invoice.
- A model without a bundled price is counted and shown as **unpriced**, never hidden. Add a price
  override to price it (below).

### Pricing overrides

`usage.pricing` in `eminiar.config.json` (or `~/.eminiar/config.json`) is a map from a model-id
substring to prices in USD per million tokens. The first matching key wins; missing fields fall
back to the bundled price, or to the standard multipliers (5-minute cache write = 1.25 × input,
1-hour write = 2 × input, cache read = 0.1 × input) for an unknown model.

```json
{
  "usage": {
    "pricing": {
      "claude-unknown-9": { "input": 3, "output": 15 },
      "opus-5-5": { "cacheRead": 0.25 }
    }
  }
}
```

Prices apply to calls ingested after the change; run `eminiar purge usage --yes` and
`eminiar usage ingest` to re-price everything that is still in the transcripts.

### Budgets

`usage.budgets` sets soft limits that never block anything:

| Key | Effect |
|---|---|
| `sessionUsd` | When a session passes it, the next prompt gets a one-line warning (once per session) |
| `dailyUsd` | The same for the calendar day (once per day) |
| `turnUsd` | A single API call above it is flagged as an *expensive turn* insight (default `1.00`) |

## Statusline segments

With `usage.statusline: true` (the default) `eminiar statusline` appends
`$<session cost> · ctx <pct>% · 5h <pct>%` to its line: the session's cost as Claude Code
reports it, how full the context window is, and the 5-hour plan window for subscribers.

## The savings model

`em_stats` counts the tokens eminiar kept out of the context window. `em_usage view:"savings"`
prices them:

- **Direct**: saved tokens × the 5-minute cache-write price of the session's dominant model. A
  tool result enters the context once and is written to the cache on that turn.
- **Compounding**: saved tokens × the cache-read price × the number of later API calls in the
  session. Every byte in the context is re-read on every later turn; the stat rows carry no
  timestamp, so half of the session's calls are taken as the expected number of later calls.

Each answer lists its assumptions. The direct figure is conservative; the compounding figure is
the one that grows with long sessions. Without `since` the savings are all-time; with it, the
stat rows (which carry no timestamp) are limited to the sessions that made an API call inside
the window, and the assumptions say so.

## `em_usage` views

`em_usage {scope?, view?, since?, limit?, json?}`. `scope` is `project` (default) or `session`
(the current one). `since` is an ISO date (`2026-10-01`, optionally with a time) or a relative
value (`30d`, `12h`, `2w`); anything else, or a date before 2000 or after tomorrow, is rejected
with a message. `limit` caps list views at a whole number from 1 to 1000 (default 20). `json:
true` returns the aggregate object instead of text.

Times: `daily`, `weekly` and `monthly` group by your **local** calendar day, and so does the
dashboard's cost-per-day chart; the clock times in the `sessions`, `blocks` and `turns` tables
and the billing-block ids are **UTC** (their headers say so), because the 5-hour blocks are
anchored to UTC hours. The dashboard's context timeline shows local times.

| View | Shows |
|---|---|
| `summary` | Totals, cost today / 7 days / 30 days, cache hit rate, models, the active 5-hour block with its burn rate, plan use from the latest statusline snapshot, the top three insights, and the savings line |
| `daily`, `weekly`, `monthly` | One row per local day / ISO week (Monday) / month: calls, cost, tokens, cache hit rate, cost per model |
| `models` | Per model: calls, cost, share of cost, tokens; then effort levels, fast mode and subagent share when present |
| `sessions` | Per session: last call, branch, calls, cost, tokens, cache hits, last prompt |
| `blocks` | 5-hour billing blocks (UTC, the active one starred), gap since the previous block (`<1h` or `h:mm`), and the burn rate: USD per hour, tokens per minute and the projected cost of the block, shown as `n/a` until the active block has at least 2 calls over at least 5 minutes |
| `turns` | The session's context timeline: per call the time, model, context tokens (input + cache), output tokens and cost, with a marker on the first call after a compaction; the header says `last N of M calls` when `limit` cut it |
| `tools` | Which tools put the most characters into the context (calls, chars, estimated tokens, average size, errors) |
| `insights` | Every detection with severity, the numbers that triggered it and a recommendation, then four scores (0–100) with their reasons: context health, cost efficiency, cache efficiency, delegation |
| `savings` | Direct and compounding savings with the assumptions |

Insights are detected from the same rows: cache thrash, cold cache, context bloat from raw
`Read` / `Bash` / `Grep` / `WebFetch` results, compaction churn, Opus-class models for trivial
turns, fast-mode and thinking share, subagent cost, expensive turns, error loops, budgets,
unpriced models and a context window near its limit.

Two details keep the detectors honest. Tool results that are permission or hook denials (for
example eminiar's own "this command is likely to print a lot" routing refusal) are not counted
as failures, so an error loop means real failures. An expensive turn names what drove its cost
(context reads, output, or cache writes) and the recommendation follows that driver: compact for
context, lower effort for output, keep the prompt prefix stable for cache writes. Image and
document tool results count as a fixed 1,600 tokens rather than their base64 size.

## CLI

```sh
eminiar usage                                   # summary for the project
eminiar usage session                           # the current session
eminiar usage daily --since 30d                 # one row per day
eminiar usage models --since 2026-10-01
eminiar usage blocks                            # 5-hour windows and burn rate
eminiar usage turns --session <id>              # context timeline of one session
eminiar usage insights --json
eminiar usage sessions --csv > sessions.csv     # daily, weekly, monthly, models, sessions, blocks
eminiar usage ingest                            # read every transcript of the project now
```

`--session <id>` narrows any view to one session. `--limit N` caps list views.

## Dashboard

The **Usage** tab in `eminiar ui` shows the same data: tiles for today, the last 7 days, the
selected session, cache hit rate, burn rate and plan use; cost per day stacked by model; the context
timeline of a session with compaction markers; the models, tool and billing-block tables; the
insights with their severity and the four scores; and the savings panel. Deep link:
`#/usage?session=<id>&range=7d|30d|90d`. See [Dashboard](dashboard.md#usage).

## Turning it off

`"usage": { "enabled": false }` stops the ingest and the snapshots. `em_usage` then reports that
it is off. Already stored rows stay until you purge them.
