# Design: adjudicator (opt-in)

Status: proposed · swarm run `20261104-483f39` · branch `feature/adjudicator` · target v0.13.0 · 2026-11-04

See also [adjudicator-security.md](adjudicator-security.md): the opt-in security-aware advice built
on this adjudicator (v0.15.0).

## Constraints from Claude Code

The coordinator checked these against the Claude Code docs (sub-agents "Choose a model", hooks
PreToolUse/UserPromptSubmit, model-config). The design depends on them.

| Fact | Consequence |
|---|---|
| Subagent model precedence: the Agent call's `model` param, then the subagent frontmatter `model` (`inherit` means the main model), then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` overrides all of them. Claude Code substitutes a model when the requested one is outside the org's `availableModels`. | When FORCE is set, the adjudicator never tries to change the model. |
| The Agent call's `model` accepts only `sonnet`, `opus`, `haiku` or `fable`: no `inherit` and no full ids. Frontmatter accepts aliases, full ids and `inherit`. | Tiers are limited to those four aliases. |
| From Claude Code 2.1.292 the Agent call takes an `effort` parameter for a non-fork subagent; it overrides the agent file's `effort` and lasts across resumes, and `CLAUDE_CODE_EFFORT_LEVEL` outranks both (sub-agents "Choose an effort level"). Levels are `low`, `medium`, `high`, `xhigh`, `max`; a level the model lacks falls back to the highest one below it (model-config "Adjust effort level"). | In advise mode, effort per dispatch is advice for the coordinator to pass as `effort` on the Agent call (informational while `CLAUDE_CODE_EFFORT_LEVEL` is set). In apply mode the hook sets the advised `effort` in the same `updatedInput` as `model`, on every dispatch in `apply.scope` except a fork, a denied or asked call, and while `CLAUDE_CODE_EFFORT_LEVEL` is set. A probe on Claude Code 2.1.311 (`claude -p`, swarm run `20261111-14ebfc` task #222, 22 runs; memory `adjudicator/hook-effort-probe`) showed the hook's `effort` winning over the call's and the agent file's, `CLAUDE_CODE_EFFORT_LEVEL` winning over the hook's, a fork dropping it, and a value outside the five levels failing the whole Agent call. Reconcile checks afterwards which level ran, from the transcript's per-call `effort` (§11). |
| PreToolUse `updatedInput` replaces the whole input, so every unchanged field must be included. Rules are re-evaluated, and in auto mode a changed call without `permissionDecision` may be denied. A model set this way takes effect: a live probe on Claude Code 2.1.309 (`claude -p`, swarm run `20261104-672098` task #99, n=1 per case) ran the subagent on the hook's model, ahead of the agent file's pin and of a `model` passed on the call. A plugin mod's `agent.spawn` hook outranks the call's `model`. | The optional `apply` mode is opt-in and deterministic for the dispatches it may change; a test checks that the merge keeps every field. Advice to the coordinator stays the default: `em_swarm plan` shows a suggested model and effort per task and the coordinator passes `model` and `effort` on the Agent call, which works only as well as the coordinator follows the line. Both respect a model pin in the agent's definition: the advice names the pin, never a different `model` to pass, and apply leaves it. A swarm role opts in to model choice with `model_range` (§16). Reconcile still checks that the applied model ran (§11). |
| UserPromptSubmit cannot change the main session's model. It can only add context or block. | Main-session model choice is advice text only. |

**Product decision** (coordinator, from the user's request): choosing model size for dispatched
work is in scope. It does not violate `decision/usage-insights-no-proxy`, because nothing
intercepts API traffic. The adjudicator only gives advice and uses Claude Code's own Agent
`model` parameter. This is recorded as a decision memory at the end of the run.

## 1. What it is and why

The adjudicator is an optional subsystem and is off by default. It scores each piece of work for
complexity on a 0-4 scale: a user prompt, a subagent dispatch or a swarm task. For each one it
recommends:

- (a) the eminiar tool to start with,
- (b) the Claude model tier (haiku/sonnet/opus, plus an effort level),
- (c) the swarm role.

The point is to send small work to small models and to the right `em_*` tool, so sessions run
faster and cost less. Every recommendation comes with its reasons.

How it decides: a deterministic, feature-based heuristic always runs and is always the fallback.
It can be blended with one provider:

- TypeSafe Jev (typed choice/score/noul answers)
- any OpenAI-compatible endpoint (presets: Groq gpt-oss-20b, Cerebras, Ollama, LM Studio,
  llama.cpp, custom)
- local nearest-neighbour search over shipped exemplars, using the bge-small model eminiar
  already ships

### Non-goals

- Intercepting API traffic. `decision/usage-insights-no-proxy` still holds. We use only Claude
  Code's own Agent `model` parameter and hook text. Coordinator ruling: choosing a model this way
  is not "model routing".
- Changing the main session's model. Hooks cannot do it, so this is advice only.
- Denying or blocking any tool call.
- Generating free text.
- Cursor. Every surface returns early when `input.client === "cursor"`.

## 2. Principles

**P1 Off costs nothing.**

- Hooks test `ctx.config.adjudicator.enabled` (config is already loaded) before calling any
  adjudicator code.
- Adjudicator modules have no top-level side effects. The hook build is split (since 3001537):
  the hooks reach the adjudicator only through dynamic `import()`, so it lands in `hook-*`
  chunks next to `dist/hook.js` that are loaded only when it is enabled. The server and CLI stay
  single files (`splitting: false`); there the adjudicator is bundled in but inert until called,
  and `scripts/check-bundle.mjs` fails the build on a dynamic `import()` of an internal module
  that the server reaches.
- When off: the `em_adjudicate` tool is not registered, and nothing is written to the DB or the
  network.
- Kill switch: `EMINIAR_ADJUDICATOR=0`.

**P2 Advice first.**

- The default path is advice: `em_swarm plan` lists a suggested role, model and effort for each
  task, and the coordinator passes `model` and `effort` on the Agent call.
- `apply` mode is opt-in: it rewrites the Agent input through PreToolUse `updatedInput`, setting
  the model and the effort. Claude Code takes a hook-set model (verified on 2.1.309) and a
  hook-set effort (verified on 2.1.311; see Constraints), and we still measure
  whether it ran: FORCE, an organisation's `availableModels`, a mod's `agent.spawn` hook or a
  dispatch linked to the wrong calls can change or hide the outcome (§11).

**P3 Fail open and fast.**

- Every path has a hard deadline (AbortController) and falls back to the heuristic.
- Providers sit behind a circuit breaker persisted in SQLite, a p95 latency guard and a daily
  spend cap.

**P4 Private by default.**

- The heuristic, embedding and localhost providers keep all data on the machine.
- Remote providers need explicit consent, bound to the origin the notice named. `--yes` never
  implies it; a committed project file cannot grant it, nor choose the provider, its URL, the key
  or the caps (§5 "Trust boundary"); and no environment variable grants it (§5 "Remote
  consent").
- Remote providers also need a key, which lives only in `~/.eminiar/adjudicator.key` or an env
  var.
- We store hashes, scores and an 80-char redacted head of the input. We never store keys.
  Redacted prompt text and raw Jev responses are stored only with the opt-in, personal-only Jev
  request capture (newest 100).

**P5 Explainable.**

- Every score-table entry carries reasons, e.g. `+1.6 verb 'refactor'`.
- Every decision can be inspected (`em_adjudicate explain`, the dashboard detail drawer, CLI
  `test`).

**P6 Measured.**

- Decisions are linked to outcomes (swarm task status, explicit feedback) and to the tokens
  actually spent (`api_calls`).
- Savings are reported net of the adjudicator's own spend, and the method is shown with every
  figure.

## 3. Module layout (new directory `src/adjudicator/`)

- `types.ts`: shared types and constants (`SCORER_VERSION`, `TIERS`, `TOOL_IDS`,
  `DEFAULT_ROLES`, `SURFACES`, `INTENTS`).
- `config.ts`: `resolveAdjudicator(config, env)` returns a `Resolved` object: the effective
  provider after consent, key and locality checks, plus a `degraded` reason. Also holds the
  `PRESETS` table and `isLoopback(url)`.
- `secrets.ts`: reads and writes the key file (0600, temp file + rename). Resolution order,
  `mask()`, permissions check, `resetSecrets()` test seam.
- `redact.ts`: `normalize()`, `inputHash()`, `redact()`, `head(n)`.
- `features.ts`: `extractFeatures(text, hints)` returns `Features`. Pure, under 1 ms.
- `heuristic.ts`: `scoreHeuristic(features, weights, catalogue)` returns a `ScoreSet` with
  reasons.
- `units.ts`: `scoreUnits(text, hints)` scores a plan or agent brief per statement and takes the
  hardest one (§7.9); `briefUnitsOf(scores)` reads a row's `units` back.
- `agent-pin.ts`: `resolveAgentPin(agentType, lookup)` finds an agent's model pin (`pinned`,
  `ranged`, `unpinned` or `unknown`) in Claude Code's lookup order (§11).
- `blend.ts`: `blend(heuristic, answer | undefined, bias, weights)` returns a `Verdict`.
  `formatAdvice(v)` builds the one-line hint.
- `prompt.ts`: the rubric and catalogue text, the Jev question builder, the OpenAI strict
  JSON-schema builder.
- `providers/http.ts`: `postJson`/`getJson` using fetch + AbortController, a deadline, error
  classes, and stripping of the key and headers from errors.
- `providers/typesafe.ts`, `providers/openai.ts`, `providers/index.ts`:
  `createProvider(resolved)` plus `registerProvider(id, factory)`, so the server and CLI can
  register `embedding` without the hook bundle ever referencing it.
- `providers/embedding.ts`: MCP server and CLI only. Registered at server start; never imported
  from hook code.
- `breaker.ts`: the breaker, the latency guard and the daily spend cap, all over
  `db.adjudicator`.
- `engine.ts`: `adjudicate(reqs, opts)` runs cache, then heuristic, then the provider gate, then
  the provider, then blend, then persist.
- `async.ts`: `spawnAsyncJob(job)` starts a detached child of the hook process; `runAsyncJob()`
  is the child entry (`em-hook --adjudicate`).
- `hooks.ts`: `onPrompt`, `onPreAgent`, `onPreTool`, `onSessionStart`, `onSessionEnd`. These are
  the only functions `src/hooks/*` call.
- `swarm.ts`: `adjudicatePlan(ctx, runId, tasks)` and `planLines(...)` for `em_swarm`.
- `learn.ts`: `reconcile(db, {limit})` (links outcomes, tokens and savings) and the learned
  per-bucket biases.
- `savings.ts`: baseline resolution, repricing through `src/usage/pricing.ts`, summaries.
- `eval.ts`: the eval harness. `cli.ts`: `eminiar adjudicator ...`.
- `data/evalset.ts`: the 40 labelled items from blackboard `research-local-3`.
- `data/exemplars.ts`: exemplar texts with labels, 15-30 per tier, disjoint from the eval set.

New files elsewhere: `src/storage/sqlite/adjudicator.ts`, `src/tools/em_adjudicate.ts`,
`src/ui/adjudicator-api.ts`, `src/ui/web/views/Adjudicator.tsx`, `docs/adjudicator.md`.

Hot files get thin call-outs only, never logic: `routing.ts` (risk 0.56), `capture.ts`,
`session-start.ts`, `sqlite/adapter.ts`, `adapter.ts`, `cli.ts`, `app.tsx`.

## 4. Public types (`src/adjudicator/types.ts`)

```ts
export const SCORER_VERSION = "1";
export type Surface = "prompt" | "agent" | "plan" | "tool" | "mcp" | "test";
export type Tier = "haiku" | "sonnet" | "opus" | "fable";          // the only Agent `model` values
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";    // `effort` on the Agent call (CC ≥ 2.1.292): passed by the coordinator (advise) or set by the hook (apply)
export type ProviderId = "heuristic" | "typesafe" | "openai-compatible" | "embedding";
export type Source = "heuristic" | "blend" | "cache" | "fallback";
export type ProviderStatus = "ok" | "timeout" | "http_error" | "rate_limited" | "invalid"
  | "breaker_open" | "slow_guard" | "over_budget" | "no_key" | "no_consent" | "skipped" | "n/a";
export type Intent = "lookup" | "impact" | "history" | "run" | "bigfile" | "docs" | "recall" | "plan"
  | "edit_small" | "implement" | "refactor" | "design" | "review" | "debug" | "research" | "test" | "git" | "ui" | "chat";
export interface Reason { feature: string; weight: number; note: string }
export interface ScoreEntry { option: string; score: number /* 0..1; one table sums to 1 */; reasons: Reason[] }
export interface ScoreTable { dimension: "tool" | "tier" | "role"; entries: ScoreEntry[] /* desc */; choice: string; confidence: number }
export interface Features {
  words: number; chars: number; lines: number; paths: number; symbols: number;
  codeBlock: boolean; stackTrace: boolean; intents: Partial<Record<Intent, number>>;
  scope: number /*0..1*/; risk: number /*0..1*/; chat: boolean; slash: boolean; classify?: string;
  task?: { role?: string; files: number; deps: number };
}
export interface ScoreSet {
  complexity: number /* 0..4 continuous */; complexityReasons: Reason[];
  tool: ScoreTable; tier: ScoreTable; role: ScoreTable; effort: Effort;
}
export interface AdjudicationRequest {
  key: string; surface: Surface; text: string;
  hints?: { role?: string; roles?: Array<{ name: string; description?: string }>; files?: number; deps?: number };
}
export interface Dist { probs: Record<string, number>; confidence: number; calibrated: boolean }
export interface ProviderAnswer {
  key: string; complexity?: { value: number; confidence: number };
  tier?: Dist; role?: Dist; tool?: Dist; risky?: number; needsPlan?: number;
}
export interface ProviderResult { answers: ProviderAnswer[]; usage: { inTok: number; outTok: number; costUsd: number }; latencyMs: number; model: string }
export interface AdjudicatorProvider {
  id: ProviderId; remote: boolean; dims: Array<"complexity" | "tier" | "role" | "tool">;
  adjudicate(reqs: AdjudicationRequest[], o: { signal: AbortSignal; deadlineMs: number }): Promise<ProviderResult>;
  probe(o: { signal: AbortSignal }): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
}
export interface Verdict extends ScoreSet {
  id?: number; key: string; source: Source; provider: ProviderId; providerStatus: ProviderStatus;
  alpha: Partial<Record<"complexity" | "tier" | "role" | "tool", number>>; bias: Record<string, number>;
  latencyMs: number; providerLatencyMs?: number; usage?: ProviderResult["usage"]; version: string;
}
export interface AdjudicationRow { /* mirrors the adjudications table in §12, camelCase */ }
```

Every surface consumes a `Verdict`. `formatAdvice(v, surface)` renders a hint of at most 220
chars.

## 5. Config schema (`src/config.ts`, key `adjudicator`, every object `.prefault({})`)

```
adjudicator: {
  enabled: false,
  provider: "heuristic",          // heuristic | typesafe | openai-compatible | embedding
  mode: "advise",                 // advise | apply (apply may set the Agent `model`)
  surfaces: { prompt: true, agent: true, plan: true, tools: false },
  promptMode: "async",            // heuristic | async | blocking: the provider's role on UserPromptSubmit
  typesafe: { model: "jev-1.14.0", baseUrl: "https://api.typesafe.ai/v1" },
  openai: { preset: "groq", baseUrl?: url, model?: string, json: "auto" /* schema|object|auto */,
            price?: { inPerM: number, outPerM: number } },
  embedding: { k: 5, minSimilarity: 0.55 },
  keyEnv?: string,                // NAME of an env var, never a key
  remoteConsent: false,           // granted ONLY by ~/.eminiar/config.json; env can only withdraw it
  remoteConsentOrigins?: string[], // origins the user agreed to; written by the CLI, personal file only
  timeouts: { promptMs: 1200, agentMs: 800, planMs: 3000, localMs: 600, connectMs: 150 },
  minPromptChars: 12,
  tiers: ["haiku", "sonnet", "opus"],   // ordered ladder; "fable" may be inserted by the user
  weights: { providerMax: 0.7, embeddingMax: 0.4, selfReportScale: 0.6, lowConfidence: 0.55,
             tierCenters: { haiku: 0.6, sonnet: 2.0, opus: 3.4 }, features: {} /* per-feature overrides */ },
  apply: { scope: "swarm" /* swarm|all */, minConfidence: 0.7, floor: "haiku", ceiling: "opus", respectFrontmatter: true },
  advice: { mainSession: "user" /* off|user|context */, cooldownPrompts: 8 },
  learning: { enabled: true, maxBias: 0.3, minSamples: 5, halfLife: 50, costWeight: 0.05 },
  cache: { ttlHours: 24, maxEntries: 2000 },
  breaker: { failures: 2, cooldownSec: 120 },
  budget: { dailyUsd: 0.5 },
  privacy: { maxChars: 2000, storeHead: true }
}
```

Rules:

- **(a)** `envOverrides()` adds:
  - `EMINIAR_ADJUDICATOR=0|1` → `enabled`
  - `EMINIAR_ADJUDICATOR_PROVIDER` → `provider` (a remote one runs only if the personal config
    already consents to its origin)
  - `EMINIAR_ADJUDICATOR_MODE`
  - `EMINIAR_ADJUDICATOR_REMOTE=0` → `remoteConsent: false` (withdraws). `=1` does nothing.
- **(b)** `loadConfig` cuts the project layer's adjudicator section down to an allowlist before
  merging (see "Trust boundary" below). Teams commit that file, and consent is personal.
- **(c)** A `superRefine` rejects any key inside `adjudicator` that matches
  `/(api_?key|token|secret|password)/i`, except `keyEnv`. The error tells the user to run
  `eminiar adjudicator key set`.
- **(d)** `install.ts` freezes `ConfigSchema.parse({})` into `~/.eminiar/config.json`, so every
  default above has to be safe to freeze. Optional fields stay undefined.
- **(e)** Run `scripts/gen-schema.ts` and commit the regenerated `eminiar.config.schema.json`.

### Trust boundary: what the project file may set

`<root>/eminiar.config.json` comes with any cloned repo, so it is untrusted input. It must never
decide where adjudicator text or keys go, which key is sent, how much text leaves the machine or
how much is spent. Security review #31 showed the old rule (strip only `remoteConsent`) let a
project file set `openai.baseUrl` and send the user's Groq key and prompts to any host, or name
`keyEnv: "AWS_SECRET_ACCESS_KEY"` and send that.

- `PROJECT_ADJUDICATOR_KEYS` in `src/config.ts` is the allowlist: `enabled`, `surfaces`,
  `promptMode`, `minPromptChars`, `weights`, `advice`, `embedding`, `learning`, `cache`, plus
  `mode` when it is `"advise"` (`projectKeeps`). These turn the feature on and tune how verdicts
  are scored and used. `mode: "apply"`, `apply` and `tiers` decide which model every subagent
  runs on (review #109: a clone could put every dispatch on haiku, or floor them at fable), so
  they are personal like the egress keys. None of the allowed keys changes the host, the key or
  the caps: `surfaces.tools` only adds a local hint, and `promptMode` only changes when the
  consented provider is called.
- Everything else (`provider`, `typesafe`, `openai` with its preset, baseUrl, model and price,
  `keyEnv`, `remoteConsent`, `privacy`, `budget`, `timeouts`, `breaker`) comes only from
  `~/.eminiar/config.json` and `EMINIAR_*` env. `projectLayer()` drops it before the merge.
- `projectAdjudicatorWarning(root)` returns one line naming the dropped keys, for doctor and
  `adjudicator status`.
- A project section holding a key-like field stays whole, so the secret check (c) still rejects
  the config instead of dropping the key quietly.
- A cloned repo can therefore turn the adjudicator on, but with no personal config only the
  heuristic runs.
- Prototype keys are dropped from every config layer (task #62). `JSON.parse` makes
  `"__proto__"` an own key, and a merge that assigns it calls the prototype setter, so the
  merged object inherited keys no allowlist saw and zod read them: security review #61 sent the
  prompt and `$GITHUB_TOKEN` to an attacker's host from a committed file alone. `readJson` and
  `readJsonQuiet` parse with `parseJsonSafe()` (= `ownJson(JSON.parse(text))`), which copies own
  enumerable keys only and drops `__proto__`, `constructor` and `prototype` at every depth;
  `deepMerge` skips the same keys and reads own keys only (`Object.hasOwn`); `projectLayer`
  keeps an allowlisted key only when it is an own key; and `loadConfig` hands zod an `ownJson`
  copy, never the merged object. The CLI's `readRaw` (which rewrites the config files) and the
  memory frontmatter parser drop the same keys.

### Trust anchor: which personal config may set the egress keys

A trusted project's `.claude/settings.json` `env` block reaches the hooks, so it can move
`EMINIAR_HOME` (or `HOME`, which `os.homedir()` reads) to a `config.json` the repo ships.
`personalConfigTrusted(root, file)` (with `personalConfigProblem` giving the reason) decides
whether that file may set the keys outside `PROJECT_ADJUDICATOR_KEYS`; an untrusted file gets
the project layer's cut, and the CLI refuses to write consent or keys there.

- A relative path is never trusted (task #63): a relative `EMINIAR_HOME` or `HOME` resolves
  against the directory the session starts in, which the repo decides.
- A file directly in `<account home>/.eminiar`, the home from the user database
  (`os.userInfo()`, not `$HOME`), is always trusted (task #54).
- Any other file is trusted only when its real path (symlinks resolved, case-insensitive on
  macOS and Windows) is neither inside nor above (its folder at or above) any anchor: the project
  root, `process.cwd()`, and every git work tree around either. `gitWorktrees()` climbs every
  ancestor holding `.git` (not only the nearest), lists each repository's main and linked work
  trees from `commondir` and `worktrees/*/gitdir`, and follows a submodule's
  `gitdir: <super>/.git/modules/<name>` to the superproject's work tree (task #63; security
  review #61 showed a submodule pointing `EMINIAR_HOME` at `../.em` in its superproject). No git
  process is spawned.
- An absolute `EMINIAR_HOME` in an unrelated place (CI and test temp directories) stays trusted.
  The residual gap: a tree with no git at all (an unpacked archive) whose settings name an
  absolute path to a sibling folder of the project; nothing on disk marks where such a tree
  starts.

### Remote consent: bound to an origin, granted only by the personal config

Consent is not a boolean. It is a list of origins (scheme, host and non-default port) the user
agreed to: `remoteConsentOrigins` in `~/.eminiar/config.json`, next to the master flag
`remoteConsent`. The CLI writes both only after it printed the notice naming that origin and the
user answered y or passed `--accept-remote` (tasks #33, #48).

`consentFor(a, origin, env)` in `src/adjudicator/config.ts` decides, for every remote path (engine
gate, hooks, eval candidates, CLI test and probe, dashboard try-it):

| situation | consent |
|---|---|
| `remoteConsent` false, or `EMINIAR_ADJUDICATOR_REMOTE=0` | none, for every origin |
| `origin` listed in `remoteConsentOrigins` | `"config"` |
| `remoteConsent: true` with no list (written before origins were recorded), built-in origin, provider not picked by `EMINIAR_ADJUDICATOR_PROVIDER` | `"legacy"`; the next `enable`/`provider` records the origin |
| anything else, including `EMINIAR_ADJUDICATOR_REMOTE=1` | none: the provider degrades with `no_consent` |

Environment variables can only withdraw consent. Claude Code applies a trusted project's
`.claude/settings.json` `env` block to the session and its hooks, so a cloned repo can set any
`EMINIAR_*` variable. If `EMINIAR_ADJUDICATOR=1`, `EMINIAR_ADJUDICATOR_PROVIDER=typesafe` and
`EMINIAR_ADJUDICATOR_REMOTE=1` could grant consent, the repo could start sending the user's prompts
to a remote host with the user's own stored key. So:

- `EMINIAR_ADJUDICATOR=1` may turn the feature on (heuristic or local providers);
- `EMINIAR_ADJUDICATOR_PROVIDER` may pick a remote provider, which runs only when
  `remoteConsentOrigins` already lists its origin;
- `EMINIAR_ADJUDICATOR_REMOTE=1` grants nothing; `=0` and `EMINIAR_ADJUDICATOR=0` still withdraw
  and kill.

A legacy consent was given for the provider the personal config named, so it never follows a
provider the env swapped in. Regression test: `tests/unit/adjudicator-hooks.test.ts` "a project
.claude/settings.json env block cannot grant remote consent (#48)" (stored keys, no consent,
every fetch caught by a local stub server, nothing sent).

### PRESETS (`config.ts`)

| preset | baseUrl | default model | key env | price $/Mtok in/out | locality |
|---|---|---|---|---|---|
| groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b` | `GROQ_API_KEY` | 0.075 / 0.30 | remote |
| cerebras | `https://api.cerebras.ai/v1` | `gpt-oss-120b` | `CEREBRAS_API_KEY` | unknown (cost null unless `openai.price` is set) | remote |
| ollama | `http://localhost:11434/v1` | `qwen2.5:1.5b-instruct` | none | 0 | local |
| lmstudio | `http://localhost:1234/v1` | (from `/v1/models`) | none | 0 | local |
| llamacpp | `http://localhost:8080/v1` | (loaded model) | none | 0 | local |
| custom | `openai.baseUrl` (required) | `openai.model` (required) | `keyEnv` | `openai.price` | local only if host is loopback |

The ollama preset adds `keep_alive: "30m"` and options `{temperature: 0, num_predict: 256}`.
Local presets use `timeouts.localMs` in hooks.

typesafe is always remote; its key comes from `TYPESAFE_API_KEY`.

`resolveAdjudicator` picks the effective provider:

- the configured provider, when (remote ⇒ consent && key present) and (embedding ⇒ running in
  the server or CLI);
- otherwise `"heuristic"`, with `degraded` set to `no_key`, `no_consent` or `hook_context`.

## 6. Secrets

File `~/.eminiar/adjudicator.key`: JSON
`{"typesafe": "...", "openai:groq": "...", "openai:cerebras": "...", "openai:custom": "..."}`.

- Written by `eminiar adjudicator key set` only: a temp file created with mode 0600, then
  renamed.
- Cached per process, with a `resetSecrets()` test seam (same pattern as
  `src/swarm/identity.ts`).
- Add `adjudicatorKey` to `paths()` so `EMINIAR_HOME` isolates tests.

Resolution order:

1. the env var named by `keyEnv`
2. the provider's own env var (`TYPESAFE_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`)
3. `EMINIAR_ADJUDICATOR_KEY`
4. the key file

A local (loopback) target skips steps 1 to 3: it gets only a key stored in the key file for its
own id (`openai:llamacpp`, ...), never an env var. Otherwise any process listening on a local
port could collect `$GITHUB_TOKEN` through `keyEnv`, or the generic key. `keyFor(r)` in
`config.ts` is the one place providers and the auth-lockout fingerprint get the key from.
`keyEnv` is read only from the personal config (the project layer drops it).

If the file's mode has any `0o077` bits set, we refuse to read it, and doctor fails with a
`chmod 600` hint.

Keys never appear in:

- project config (blocked by the refine)
- argv: the CLI reads hidden TTY input or stdin; `--from-env NAME` stores `keyEnv` instead of a
  key
- `hook.log` or error text: `http.ts` drops the Authorization header and replaces any substring
  equal to the key with `***`
- the DB, the cache, memories, async job JSON (the child process resolves the key itself), or
  dashboard and CLI payloads. These show only `keySource` env|file|none and the last 4 chars,
  masked.

What leaves the machine (remote providers only):

- the normalised input text, cut to `privacy.maxChars` (2000) and passed through `redact()`
- the static tool, tier and role catalogue

Never sent: file contents, code, memories, or the project's paths beyond what the user typed.

## 7. Scoring model

### 7.1 Features (`features.ts`, pure, under 1 ms)

- words, chars and lines
- paths: `/[\w./-]+\.(ts|tsx|js|py|go|rs|md|json|ya?ml|sql|php)\b/`
- symbols: camelCase, PascalCase or snake_case identifiers, and backticked spans
- `codeBlock` and `stackTrace` (`at x (file:line)`, Traceback)
- intents come from an ordered lexicon: multiword phrases first, then stem match; the score is
  0..1 per intent:
  - lookup: what / where / which / show / list / explain
  - impact: what would break / depends / affect / who imports
  - history: blame / history / why was / when did
  - run: run / test suite / lint / typecheck / npm audit
  - bigfile: read the N-line / whole file
  - docs: docs / latest version / fetch
  - recall: should we / is it safe / did we decide
  - plan: split / plan / tasks / assign / rollout
  - edit_small: rename / typo / tidy / format / bump
  - implement: add / implement / write / create
  - refactor: refactor / migrate / rewrite / port
  - design: design / architect / subsystem
  - review: review / audit / security review
  - debug: why / debug / fails / slow / crash / race
  - research: compare / research / providers
  - test: unit tests / regression / verify
  - git: commit / push / rebase / branch
  - ui: dashboard / css / component / view
  - chat: hi / thanks / ok / yes, with no other intent
- scope, 0..1: whole / entire / all / across / every / system / framework / codebase
- risk, 0..1: security / race / migration / data loss / concurrency / production / auth
- the `slash` flag, and the `classifyPrompt()` label from `src/capture/classify.ts`
- task hints for the plan and agent surfaces: role, number of files, number of deps

### 7.2 Complexity

c = clamp(base + Σ wᵢ·fᵢ, 0, 4). Default weights, each overridable in `weights.features`:

- base 0.6; chat −2.0; edit_small −0.6; lookup, history and docs −0.3
- implement +0.9; debug +1.0; review +1.2; plan +1.4; refactor +1.6; design +2.4; research +0.6;
  test +0.6
- scope ×1.2; risk ×0.8; 0.3·log2(1+paths)
- words > 40: +0.3; words > 120: +0.6
- stackTrace +0.4; task.files > 3: +0.4; task.deps > 1: +0.2

`complexityBucket = round(c)`. Every non-zero term becomes a `Reason`.

### 7.3 Tier table

For each tier t in `config.tiers`:

- raw s_t = −|c − center_t|
- risk adds +0.4·risk to tiers ≥ sonnet; chat adds +1 to the lowest tier
- softmax with τ = 0.5, so the scores sum to 1. Reasons cite c and the adjustments.

Effort from c: < 1.5 low, < 2.5 medium, < 3.5 high, < 3.75 xhigh, otherwise max (`max` only at
the very top of the scale, so defaults stay conservative). In advise mode the coordinator passes
it as `effort` on the Agent call (Claude Code ≥ 2.1.292); in apply mode the hook sets it (§11). A
saturated brief's effort is informational in advise mode, and set but not counted in apply mode
(§7.9, §11).

### 7.4 Tool table

Rule weights map intent to tool:

- lookup → em_symbols 0.6 / em_search 0.4
- impact → em_graph_impact; history → em_history
- run and test → em_execute; bigfile → em_execute_file
- docs → em_docs, then em_fetch_and_index; recall → em_recall
- plan → em_swarm; edit_small and implement → Edit; git → Bash; chat → none
- design or refactor with c ≥ 3.5 → Agent
- symbols or paths present add to em_symbols and em_graph_impact

Options are `TOOL_IDS` ∩ registered tools. The heuristic owns this table: provider weight for
tools is 0 unless `weights.features.toolProvider > 0`, and the embedding provider never scores
tools.

### 7.5 Role table

Intent maps to role:

- lookup and impact → explorer; docs and research → researcher
- implement, edit and refactor → coder; test and run → tester
- review → reviewer; design and plan → architect; ui → ui; chat → none

The table adds a token-overlap score against the active swarm's role descriptions
(`swarm.yaml`), so custom roles can score. When a swarm run is active, options are limited to
that swarm's roles.

A role note (the plan's "role suggested: …", the Agent note's "role X") needs a role-table
confidence of at least `ROLE_NOTE_MIN` = 0.7 (`swarm.ts`). On a stored plan row it is read from
`scores.role.confidence`, then `units.roleConfidence`; otherwise from the live verdict. Measured
before the gate, no planned-vs-scored role mismatch on this repo's swarm plans reached 0.6, so
plans show none; a plain dispatch with no role hint still gets one when its text is clear.

### 7.6 Blend (`blend.ts`)

- For each dimension d, the provider weight is α_d = min(cap_p, conf_p). The cap is
  `weights.providerMax` for typesafe and openai, and `weights.embeddingMax` for embedding (tier
  and complexity only).
- conf_p is Jev's calibrated confidence, or a self-reported confidence × `selfReportScale`.
- Tables: final = (1−α)·heuristic + α·provider. Add the learned bias, clamp at 0, renormalise.
- Complexity: c = (1−α)·c_h + α·c_p.
- Confidence of a table = 0.5 + (top − second)/2.
- If tier confidence < `weights.lowConfidence`, move up one tier (the safer choice) and add the
  reason "low confidence → rounded up".
- Jev noul answers: risky > 0.7 adds +0.3 to tiers ≥ sonnet; needsPlan > 0.7 adds weight to the
  em_swarm tool and the architect role. Both carry reasons.

### 7.7 Learning (`learn.ts`, bounded and cheap)

Buckets:

- tier: (complexityBucket, tier)
- role: (top intent, role)

Each bucket keeps decayed counts n, s (successes) and f (failures), plus `cost_median`, the
median actual cost per success. On each update, counts are multiplied by 2^(−1/halfLife).

Posterior success ŝ = (s+2)/(n+4), a Beta(2,2) prior.

bias = clamp(1.0·(ŝ − 0.8) − costWeight·log2(cost_t / median cost of the bucket), −maxBias,
+maxBias). It applies only when n ≥ minSamples.

Signals:

- swarm task done = success; failed or blocked = failure. Credit goes to the tier that actually
  ran, taken from `api_calls`.
- explicit feedback: good = success; too_small = failure for that tier; too_big = success, plus
  one success credited to the next-lower tier.
- main-session prompts never teach, because they have no outcome.

`learning.enabled=false` means an empty bias. `eminiar adjudicator stats --reset-learning`
clears the bias table only.

### 7.8 Acceptance bar

With the default weights, heuristic-only must:

- beat the majority class on exact tier and exact complexity accuracy over the 40-item eval set
- reach ≥ 0.8 complexity accuracy within ±1

Document the weights next to the code.

### 7.9 Briefs: scored per statement (`units.ts`)

Swarm run `20261104-672098` (task #102) found that §7.2 sums intents, scope, risk and paths over
the whole text, so a long brief hits the 4.0 clamp: 67% of this repo's 101 plan tasks were
clamped, 91% scored opus and 72% effort max. Plan and agent text are now scored per statement;
prompt, tool and mcp text still score as one text (`EngineOptions.units: false` scores every
surface that way).

1. Statements: the first line (task title or dispatch description) first, then each sentence or
   line of the first 4000 characters (`UNIT_CHARS`). List markers are stripped; pasted output (a
   fenced block, a run of trace or log lines) joins the statement before it.
2. Boilerplate is dropped per clause (split on "; " and ", then"): routine checks (run
   typecheck, lint, tests or the build; "keep … green"; bare check lists) and hand-in protocol
   (report, claim, close the task, post to the blackboard, return formats, attribution lines).
   The first statement always stays, a clause that opens on a `code identifier` is never a
   protocol verb, and review work ("check that X has a test") is kept. A check step followed by
   real work (", and" / "by" / "after" + fix, redesign, migrate, implement …) is kept; routine
   follow-ups ("fix any failures") are still dropped.
3. Repeated statements count once. The first `UNIT_MAX` − 1 = 39 statements are units of their
   own; the 40th unit holds every statement from the 40th on (`tail`), and those are still scored
   one by one (past 40 of them, in up to 40 joined runs), so work at the end of a long brief is
   never lost and joining never re-creates whole-text saturation. Every statement is scored with
   the unchanged §7.1–7.3 scorer and the request's hints; at most 79 scorings per brief.
4. Complexity, its reasons, the tier table and the effort come from the hardest statement (ties:
   higher risk, then the earlier statement). Role and tool are raw votes summed over the
   statements and normalised once; the plan's role hint is in every vote, so the planned role
   stands unless the text says otherwise throughout.
5. A one-statement text with nothing dropped returns exactly the whole-text `ScoreSet`.

Outputs: `Adjudication.units` (`BriefUnits`: `scored` (scorings), `dropped`, `skipped`
(statements past the cap, scored inside the last unit), `winner`, `sum`, `saturated`,
`roleConfidence`), stored as `scores.units` and read back by `briefUnitsOf`. `sum`
is the complexity of the kept statements (boilerplate left out) before the clamp, and `saturated` means `sum` > 4
(`SATURATED_AT`): the brief names more work than its hardest statement scores, so its effort is
informational on every surface (§11). `Adjudication.features` are the features of the kept
statements (the units joined), not the boilerplate, so a brief's top intents, the learned bias
bucket and `sum`/`saturated` count work only; a one-statement text with nothing dropped keeps the
whole text's features, and rows written before `UNITS_VERSION` 4 keep their whole-text features.
`ROUTINE_OBJECT` accepts only a closed set of routine phrasings, so a specific object at the end
of a clause stays work. After a check label (`Verification:`, `Done when`) the rest is boilerplate
only when it is routine checks item by item (a whole command such as `npx vitest run`, or generic
tests and build), and "are green" is routine only when every item is: a named suite ("the
migration tests") stays work. Plan and agent cache keys gain `UNITS_VERSION` (now 4);
`SCORER_VERSION` is unchanged.

Measured on the same 101 tasks: clamped 67% → 17%, opus 91% → 63%, effort max 72% → 22%, role
different from the plan 23 → 1; on 1044 real dispatch prompts, clamped 70% → 7% and opus
89.5% → 47%. Appended boilerplate or a repeated detail changes nothing, and so does reordering
statements. Of the 35 real dispatch prompts past the cap, none is under-tiered (task #130,
`UNITS_VERSION` 2). p95 is 1.5–2.4 ms per brief.

## 8. Providers

Shared rules (`providers/http.ts`):

- plain fetch + AbortController; no SDKs and no new npm dependencies
- deadline = min(surface budget, time remaining)
- error classes: `timeout`, `http_error` (4xx/5xx), `rate_limited` (429/529), `invalid`
- at most 1 retry, only for 429/529, and only if ≥ 300 ms remain
- every answer is validated with zod; an invalid answer falls back to the heuristic

### typesafe (Jev)

Request: `POST {baseUrl}/systemone` with `Authorization: Bearer <key>` and model pinned to
`"jev-1.14.0"` (never `jev-latest`).

- ONE request per batch of up to 10 items. A plan with more than 10 tasks is split into at most
  2 parallel requests.
- `state = {catalogue: {tiers, roles: [{name, description}], tools}, items: [{id, text}]}`.
- Questions for item i (ids namespaced `"i3.complexity"` and so on; each instruction names the
  item):
  - complexity: score, with criteria [trivial chat or lookup, small single-file change,
    multi-step change in one area, cross-cutting change, architectural or multi-subsystem]
  - tier: choice over `config.tiers`, with one-line criteria
  - role: choice over roles
  - risky: noul
  - needs_plan: noul
  - tool: choice; asked only when `weights.features.toolProvider > 0`

Mapping:

- complexity = score × 4; its confidence comes from the answer
- probabilities become a `Dist` with `calibrated = true`
- cost = input_tokens × 0.042/1M (output tokens are free)

### openai-compatible

Request: `POST {baseUrl}/chat/completions` with temperature 0, `max_tokens = 64 + 48 × items`,
the rubric (`prompt.ts`) as the system message and the items as JSON in the user message.

`response_format = json_schema`, `strict: true`, schema:

- `{items: [{id, complexity: integer 0..4, tier: enum, role: enum, tool: enum, risky: boolean, confidence: number}]}`
- every field required, `additionalProperties` false, schema text ≤ 5000 chars (Cerebras limit)

`json: "auto"` handling: on a 400 that mentions `response_format` or `json_schema`, retry once
with `{type: "json_object"}` plus the schema text in the prompt, then parse with zod.

Answers become one-hot Dists × confidence, with `calibrated = false` (§7.6 applies the
`selfReportScale` discount).

Cost = `usage.prompt_tokens`/`completion_tokens` × the preset price, or null when the price is
unknown; 0 for local presets.

### embedding (registered by `src/server.ts` and the CLI; never by the hook bundle)

- Uses Xenova/bge-small through `src/embeddings`; the model is already warm in the MCP server.
- Exemplars from `data/exemplars.ts` are embedded once and cached at
  `~/.eminiar/models/adjudicator-exemplars-<sha of texts + model id>.json`.
- Classification: k-NN with k = config `k`, cosine similarity, similarity-weighted votes,
  ignoring neighbours below `minSimilarity`.
- Output: a tier `Dist` plus the weighted mean complexity, with confidence = top vote share.
  `dims = ["tier", "complexity"]`.
- In hooks the effective provider is the heuristic. The hooks still pick up cached verdicts the
  server wrote for the same input hash.

## 9. Cache, breaker and guards (`breaker.ts`, `engine.ts` over `db.adjudicator`)

**Cache**

- key = sha256(SCORER_VERSION | provider | provider model | surface | normalize(text)[:2000]);
  `normalize` lowercases and collapses whitespace
- value = the `Verdict` JSON only, never the text
- expires after `ttlHours`; every 100 inserts, prune to `maxEntries` by LRU
- a `pending` marker (verdict null, 30 s TTL) dedupes async jobs for the same key

**Breaker** (one per provider, persisted because every hook is a new process)

- closed → open after `failures` consecutive timeouts, 5xx or 429 errors
- open lasts `cooldownSec`; half-open lets one call through
- localhost ECONNREFUSED (about 1 ms) counts as a failure, so a stopped Ollama costs about 1 ms
  per call until the breaker opens

**Latency guard**: if the p95 of the last 50 provider latencies exceeds the surface budget, state
becomes "slow" and the provider is skipped for `cooldownSec`.

**Daily spend**: `spend_usd` accumulates per UTC day. At `budget.dailyUsd` or above, the status
is `over_budget` and the provider is skipped.

Probe and detect results are cached for 60 s and never run in PreToolUse.

## 10. Hook integration and latency budgets

| Point | Cost when disabled | Work when enabled | Added p95 budget |
|---|---|---|---|
| SessionStart: `src/hooks/session-start.ts`, next to the swarm line | 1 bool check | one line (≤ 200 chars) only when enabled but degraded (no_key, no_consent, breaker open, apply ineffective); ollama preset: an async keep-alive warm-up job | ≤ 5 ms, no network inline |
| UserPromptSubmit: `src/hooks/capture.ts`, after recall (L117-133), before `budgetWarnings` | 1 bool check | skip harness envelopes (`hooks.ts` `isHarnessEnvelope`: the text starts, after whitespace, with `<agent-message`, `<task-notification`, `<ci-monitor-event` or `<system-reminder` followed by `>` or whitespace; leading closed `<system-reminder>…</system-reminder>` blocks are stripped first (`stripLeadingReminders`), and the turn is an envelope only when nothing is left or another envelope (or an unclosed reminder) follows; no row, no advice, no cooldown tick, no `closeToolHint`), then score the stripped text: below `minPromptChars`, slash commands and chat-only input are skipped on it; cache → heuristic → insert row (surface prompt) → one advice line. `promptMode` async spawns the provider job; blocking calls the provider with a deadline of `promptMs` (`localMs` for local presets) | ≤ 150 ms inline including the process (heuristic < 5 ms); blocking ≤ 1.2 s |
| PreToolUse, non-Agent tools: `src/hooks/routing.ts` | nothing | only when `surfaces.tools` is on: one indexed SELECT of the session's latest prompt verdict; a hint at most once per prompt, when the raw tool contradicts the advised em_* tool and routing produced no hint | ≤ 2 ms |
| PreToolUse Agent/Task: `routing.ts`, right after `swarmPreAgent` (L710) | nothing | `onPreAgent(ctx, input, spawn)` returns `{model?, effort?, note?}`: plan row (run, task) → cache → heuristic. On a miss in apply mode, when the verdict will be applied (§11, provider call), call the provider with a deadline of `agentMs`. The result is merged into the ONE `updatedInput` routing returns (§11) | ≤ 10 ms advise; ≤ 800 ms on an apply-mode miss |
| SessionEnd: `capture.ts` `sessionEnd` | nothing | `reconcile(db, {limit: 200})` | ≤ 20 ms |
| `em_swarm plan` (MCP server, long-lived) | nothing | `adjudicatePlan`: one batched provider call | ≤ `planMs` (3 s) |
| `em_adjudicate` (MCP) | not registered | score / explain / stats / feedback | ≤ `planMs` |

PostToolUse, Stop and SubagentStop get nothing new: transcript ingestion already runs there and
feeds `reconcile`.

### Async job (`promptMode` async; also the ollama warm-up)

- The hook spawns `process.execPath` with the hook script and `--adjudicate`, using
  `{detached: true, stdio: ["pipe", "ignore", "ignore"]}`.
- It writes the job JSON to stdin and unrefs:
  `{request, rowId, cacheKey, resolved config without the key}`. Spawning costs about 3-5 ms.
- The child (`runAsyncJob`, about 50 ms to boot) resolves the key, calls the provider with a
  deadline of 2 × `promptMs`, writes the cache entry and updates the row (source blend, provider
  fields).
- If the job lands in time, the same turn's PreToolUse(Agent) uses it.
- The prompt text exists only in the pipe and in the provider request; it is never written to
  disk.
- `src/hook.ts` gets an argv switch next to the existing `--gate` check.

### Advice text

- UserPromptSubmit `additionalContext` gets one line of at most 220 chars, for example:
  "eminiar adjudicator: complexity 1/4 (lookup) · start with em_symbols → em_search · if you
  delegate: haiku, role explorer".
- Main-session advice (`advice.mainSession` "user") goes to the user as a `systemMessage`. It
  fires only when the session model (the latest main-thread `api_calls` row) is at least 2 tiers
  above the advice, and at most once per `cooldownPrompts` prompts. Example: "this prompt looks
  small (complexity 0); /model sonnet would be cheaper". With "context", the line goes to Claude
  instead; with "off", nothing is shown.

## 11. Agent dispatch: advise vs apply (`onPreAgent`)

Input text:

- For a swarm worker (`spawn.kind === "worker"`) linked to its task: the swarm task's title +
  detail from `db.swarm`. The run and task come only from the spawn decision
  (`src/swarm/runtime.ts` `reserveSpawn`), which reads the `task #N` refs in the Agent prompt
  (`task:N` and a bare `#N` do not count). One distinct ref links that task only when it is for
  the dispatched role or for no role; its state is not checked, so a re-spawn for a reopened
  task still links. Several refs (coordinator prompts often name other tasks for context) link
  the sole candidate that is in an active run of this swarm, for this role or no role, and still
  open; when several are open the claimable ones (deps done) win, and exactly one must be left.
  Swarm run `20261104-672098` tasks #100 and #121.
- Otherwise: `tool_input.description + "\n" + prompt`. Without a linked task the row has no run,
  task or plan parent, and the dispatch text is scored afresh.

Each dispatch inserts an `agent` row with:

- `parent_id` = the plan row for (run, task), if there is one
- `model_requested` = `tool_input.model`
- `baseline_model` (§13)
- `action`

Apply happens only when ALL of these hold:

1. `mode` is `"apply"`.
2. `apply.scope` allows it: `"swarm"` means swarm workers only; `"all"` means any
   `subagent_type`.
3. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is off, by Claude Code's on/off rule
   (src/adjudicator/env.ts `subagentModelForced`): `1`/`true`/`yes`/`on` in any casing are on,
   everything else is off. The hook, the plan advice and the CLI's status/doctor all read it there.
4. `tool_input.model` is absent. An explicit choice always wins, and the row's action becomes
   `"respected"`.
5. With `respectFrontmatter`: the agent's frontmatter model is absent or `"inherit"`, or the
   agent is ranged and its pick moves the model (below). src/adjudicator/agent-pin.ts
   `resolveAgentPin` finds the definition in Claude Code's order: managed > project
   `.claude/agents` (cwd up to the repo root, closest first) > user `~/.claude/agents` > plugin
   agents (`installed_plugins.json` + `CLAUDE_CODE_PLUGIN_DIRS`, scoped name) > built-ins.
   Folders are scanned recursively and matched on the frontmatter `name`. An unknown pin
   (nothing found, unreadable, conflicting copies, scan limits, a session-only `--agents` agent)
   is never overridden: the action is `advised` and the row's `scores.pin` says why.
6. tier confidence ≥ `apply.minConfidence`.
7. The tier, clamped to [floor, ceiling] (for a ranged agent also to its range), is one of
   sonnet/opus/haiku/fable; for a ranged agent it is not its fallback's tier.

Ranged agents (swarm run `20261104-672098` tasks #103 and #104; docs/swarms.md "Model ranges"):
a swarm role with `model_range: {floor, ceiling}` keeps `model` as its fallback pin in the agent
file's frontmatter, and `eminiar swarm sync` writes `range=<floor>..<ceiling>` into the file's
marker, covered by its hash. `resolveAgentPin` returns status `ranged` (`model` = the fallback,
plus `range`) only when the file is generated and its hash verifies (`agentFileRange`), the range
spans two tiers or more and the fallback's tier lies inside it; anything else, a hand edit
included, is the plain pin of the frontmatter `model`. The pick is `rangedTier`: the tier
clamped to the range ∩ [floor, ceiling]. When the pick is the fallback's tier, or the two do not
meet, no `model` is passed and the agent keeps its fallback (KeptModel `pin`), so a pinned id or
`[1m]` variant is never swapped for the bare alias. With `respectFrontmatter` off the range is
ignored like any pin.

Then:

- `updatedInput = {...tool_input, model: tier, effort}`, with `permissionDecision` `"allow"`, the
  same way routing's enforce path already returns it. `model` and `effort` are each present only
  when apply sets them; one `updatedInput` carries both.
- Routing has three return paths, and the model must survive all of them:
  - enforce + `prefixPrompt`: merge the model into routing's `updatedInput`, which already holds
    the full input plus the prompt prefix. Two `updatedInput`s cannot coexist.
  - the early `return undefined` at L750, when the prompt is already prefixed: return
    `{...tool_input, model}` instead.
  - annotate, mode "off", or no suggestion: return an `updatedInput` with the model and keep
    `additionalContext`.
- Implementation: one helper `withModel(output, input, model, effort?)` in
  `src/adjudicator/hooks.ts`, applied at routing's return points. It merges into routing's own
  `updatedInput` when there is one, else the full original input, returns a deny or ask
  unchanged, and sends `effort` only when it is one of `EFFORTS` (`effortLevel`). `routing.ts`
  gets only call-outs.
- Apply mode sets `effort`. Within `apply.scope`, `onPreAgent` returns the advised level as
  `effort` (`effortApply`) whatever the model branch decided: a pin, a ranged fallback, an
  explicit `model`, FORCE, a confidence below `minConfidence` and an unknown pin all still get
  the effort. It also overrides an `effort` the call passes and the agent file's `effort`. The
  probe on Claude Code 2.1.311 (Constraints; memory `adjudicator/hook-effort-probe`) set the
  rules:
  - the hook's `effort` wins over the call's and the agent file's, so in apply mode it is always
    what runs, unless `CLAUDE_CODE_EFFORT_LEVEL` is set, which outranks it and drops it silently:
    then no effort is sent (the hook process inherits the env, `effortForced`)
  - a fork drops it silently and runs at the parent's effort: no effort is sent for a fork
  - a value outside `low|medium|high|xhigh|max` fails the whole Agent call schema validation, so
    only a member of `EFFORTS` is ever sent; free text is dropped, never passed through
  - no per-model clamp: haiku 5.5 and sonnet 5.5 take `xhigh` and `max`; a model without effort
    support (claude-haiku-4-5) is accepted and sends no effort, so its `actualEffort` is unknown
    and the row is not counted
  - a denied or asked call is never rewritten (`blocked`), so it gets no effort either
  - no version gate: the hook input carries no Claude Code version (only the transcript records
    do, and the hot path does not read them). 2.1.311 strips an unknown `updatedInput` key
    rather than rejecting it, so a CLI older than 2.1.292 probably drops `effort`; untested
- Notes. Effort and role are one `additionalContext` line. Apply mode: "adjudicator: model haiku
  applied (complexity 1, conf 0.82); effort low applied, role explorer" (also after a pin or
  FORCE part: "…; effort low applied"), "effort low not applied: CLAUDE_CODE_EFFORT_LEVEL is set
  and outranks it", and for a fork "adjudicator: fork runs on the main session's model; no
  `model` to pass, effort not applied (a fork takes none; …)". A saturated brief gets the effort
  applied too ("effort max applied"). Advise mode (and apply mode outside `apply.scope` or on a
  blocked call): "adjudicator: pass effort:'high' (Claude Code 2.1.292+), role reviewer"
  ("suggested effort high" when the call already passes `effort` or `CLAUDE_CODE_EFFORT_LEVEL` is
  set; "effort high: informational (brief saturated)" for a saturated brief, §7.9). The role is
  named only from `ROLE_NOTE_MIN` (§7.5).
- The agent file's frontmatter `effort` (agent-pin.ts `agentEffort`: read only when every
  definition found agrees on one known level; never for a fork) changes the advise-mode effort
  part of the note: "effort low: the agent file already sets it" when it equals the advice; "pass
  effort:'low' (Claude Code 2.1.292+) over the agent file's high" when it differs; "effort max:
  informational (brief saturated); the agent file runs high" for a saturated brief whose call
  passes no `effort`. "suggested effort X" is unchanged. In apply mode the note is "effort X
  applied" whatever the file says. The hook only reads the file. The row's scores JSON records
  `agentEffort`, `passedEffort` (the call's `effort`, a known level only), `effortApplied` (the
  level the hook set, a known level only) and `effortEnv` (`CLAUDE_CODE_EFFORT_LEVEL`, `other`
  for a non-level value) for the effort check below.
- Provider call (`opts.call` in `onPreAgent`): inline only when apply mode is on, the dispatch is in
  scope, there is no plan row, and the verdict will be applied: `mayApply` (the model may move: no
  explicit `model`, and a `pass` or `ranged` rule before the verdict) or `willApplyEffort` (not
  blocked, not a fork, `CLAUDE_CODE_EFFORT_LEVEL` unset). Otherwise `never`. So a pinned agent, an
  explicit `model` or FORCE is asked for its effort alone, while a denied or asked call is asked only
  when its model may move, and the call is then not rewritten. The cache is read first, so a hit
  makes no call; the call has a deadline of `agentMs`.
- In advise mode, `onPreAgent` never calls the network. It records the row and, when the
  coordinator passed no model and the advice differs from the baseline, adds one note:
  "adjudicator: model haiku would do (complexity 1, conf 0.8): pass model:'haiku'".
- Advise mode respects pins like apply mode (with `apply.respectFrontmatter`): for a pinned
  agent, or one whose pin is unknown, the note names the pin instead, e.g. "adjudicator: pinned
  opus (adjudicator would pick haiku; remove the model pin in <file> to let it choose)", and the
  row's scores JSON gets `pinDeferred: true`, so reconcile detects no follow and credits no
  savings for it.
- A ranged agent's note names the range and the fallback: "adjudicator: model haiku would do
  (range haiku–opus, fallback sonnet; complexity 1, conf 0.82): pass model:'haiku'; …", in apply
  mode "adjudicator: model haiku applied (range haiku–opus, fallback sonnet; …)", and for a kept
  fallback "adjudicator: fallback sonnet (range haiku–opus; matches the adjudicator's pick); …"
  (or "…; no pick inside apply.floor..ceiling)"). Its rows (agent and plan) get `ranged: true`
  and `fallbackPin`, plus `pinDeferred` when the fallback is kept; the baseline is the fallback.
- One rule table decides what every surface tells the coordinator to pass (`swarm.ts`
  `dispatchRule`, shared by plan advice, the plan's "Next:" line and `onPreAgent`; checked
  against sub-agents.md):

  | Dispatch | `model` | `effort` | Row flag (scores JSON) |
  |---|---|---|---|
  | fork (`subagent_type: "fork"`) | none: runs on the main session's model | none: per-call effort is for non-fork subagents | `fork: true` |
  | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on | informational (call `model` and pins ignored) | effort rule | `forced: true` |
  | ranged, and the pick moves the model | pass the pick (`rangedTier`) | effort rule | `ranged: true`, `fallbackPin` |
  | pin respected (pinned or unknown), or ranged with the fallback kept | none: the pin is kept | effort rule | `pinDeferred: true` (ranged: also `ranged`, `fallbackPin`) |
  | otherwise | pass | effort rule | none |

  Effort rule (`DispatchRule.effort`): with `effortApply` (apply mode in scope, a known advised
  level, the call not blocked) it is `applied`, the hook sets it and nothing is passed, unless
  `CLAUDE_CODE_EFFORT_LEVEL` is set (`informational`; only the env counts as `effortSet` here,
  since the hook's level wins over the call's). A saturated brief does not change `applied`.
  Without `effortApply`: pass `effort` unless `CLAUDE_CODE_EFFORT_LEVEL` is set, the call
  already passes one, or the brief is saturated (§7.9); then it is informational. Without the
  ranged, saturated and `effortApply` facts the table gives the same result as before them (an
  exhaustive test checks it). The first matching row wins. A fork gets only an
  informational note ("adjudicator: fork runs on the main session's model; no `model` or
  `effort` to pass (…)"; in apply mode "no `model` to pass, effort not applied (a fork takes
  none; …)") and is never applied (`respected` in apply mode); `resolveAgentPin`
  treats `fork` as a built-in with no pin. Under FORCE the note is "adjudicator:
  CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets the model (adjudicator would pick X; …); pass effort:…"
  (in apply mode "…; effort X applied"), and the baseline is `CLAUDE_CODE_SUBAGENT_MODEL` (else the session model), not the pin.
- A flagged row (savings.ts `keptModel`: pin, force or fork) gets no follow detection and no
  credit; the follow rate leaves advised flagged rows out of its denominator
  (`summary().keptModel`), and `savingsReport` counts them apart from the suggested-tier ×
  actual-model matrix (`keptModel`: a pin row only when no `model` was passed and it ran on the
  pinned tier; otherwise it stays in the matrix). Plan rows carry the same flag, so a plan row no
  agent row tracks is counted the same way.

Effectiveness check: `reconcile` compares `model_final` with the model that `api_calls` show for
the agent. Each mismatch counts as `apply_ineffective`; `status` reports "apply: k of n applied
dispatches ran the chosen model" and doctor "apply effective k of n". Since Claude Code takes the
hook's model (Constraints), a mismatch points elsewhere: FORCE, an organisation's
`availableModels` substitution, a mod's `agent.spawn` hook, another plugin's `updatedInput`
(their merge order is undocumented), or a link gap (the dispatch tied to another subagent's
calls, such as a fork that runs on the main session's model, or calls not ingested yet). The
transcript keeps the pre-hook input, without the `model`, so only `api_calls` show the applied
model.

Effort check (#170): reconcile verifies the effort after the fact, whether the coordinator passed
it (advise) or the hook set it (apply, `effortApplied`). `learn.ts` `effortPatch` runs on every
non-final row with calls and writes, into the scores JSON (no schema change; keys and helpers in
`src/adjudicator/effort.ts`):

- `actualEffort` (agent and plan rows): `dominantEffort` of the subagent's `api_calls.effort`,
  the mode of the known levels, ties to the level seen last. `api_calls.effort` is the per-call
  `effort` of the subagent's transcript. The subagent's `meta.json` `effort` only echoes the
  Agent call's argument, so it cannot show a level fallback or the env override, and is not read.
- `effortFollow` (agent rows only), from `effortFollowOf`: not counted (key absent) when the
  advised level (`row.effort`) is not a known level, the ran level is unknown, the row is a fork
  (`keptModel` "fork"), `effortEnv` is set, or the brief was saturated (the plan row's
  `briefUnits` when there is one, else the row's own; in apply mode such a row still had its
  effort applied). Otherwise:
  - with `effortApplied` (apply): `followed` iff ran = advised, else `ignored`. The hook's level
    overrides the call and the agent file, and a model without effort support records no level
    (ran unknown, not counted), so the verdict is exact.
  - without it (advise): `followed` when ran = advised or the effort set for the call = advised:
    `passedEffort`, or `agentEffort` when nothing was passed (the hook says "the agent file
    already sets it", so the coordinator passes nothing; `passedEffort` wins when both exist). A
    model that lacks the level runs the next one down, so setting it is following. Else
    `ignored`.

`summary()` reads the keys through `scoresEffort` (sqlite/adjudicator.ts, a copy of `rowEffort`
for these keys, since nothing from `src/adjudicator` may load at boot while the adjudicator is
off) over dispatch rows. Its `set` is the effort set for the call: `effortApplied`, else
`passedEffort`. `effortFollowed`, `effortIgnored`, `rates.effortFollow` = followed ÷ (followed +
ignored), `effortChecked` (rows with both a `set` level and `actualEffort`) and
`effortIneffective` (of those, set ≠ actual). `stats` adds "effort followed P (f followed, i
ignored of f+i) · set but not run k" when f + i > 0 (k = `effortIneffective`, shown when
non-zero); the Adjudicator tab shows "effort P" ("—", n/a, when nothing was counted) and, when
k > 0, "effort set but not run k of `effortChecked`".
The swarm view (swarm-decisions.ts) gives each dispatch an `effortSource`, the first that
holds of `env` (`effortEnv` set), `applied` (`effortApplied`), `call` (`passedEffort`), `fork`,
`agent-file` (`agentEffort`) and `agent-default` (a session or model default whose level is
unknown), and the effective level in that order. `effortLabel` (decision-helpers.ts) shows
`actualEffort`, else the effective level, with " (ignored)" when `effortFollow` is `ignored`,
else " (applied)" when the source is `applied`; with no level it reads "applied", "env
override", "session" (fork) or "default".

Effort backfill (#227): reconcile skips final rows, so rows that were final before #170 would
never get these keys and the rate would stay n/a. `Reconciler.backfillEffort` repairs them at the
end of every `reconcile()` pass, and on a pass with no pending rows too. Newest first, it scans at
most `EFFORT_BACKFILL_SCAN` (1000) agent rows and repairs at most `EFFORT_BACKFILL_LIMIT` (200):
final rows with an `agentId` and a session whose scores lack `actualEffort` and whose `api_calls`
for that agent (from 5 s before the row) have an effort. It reuses `effortPatch` and writes only
`scores`, so nothing else on the row changes. Each scan page loads a session's `api_calls` once, from
the oldest candidate row of that session less 5 s, so an older row of the session is not starved by
a newer row that cannot be repaired (#251). A row that recorded none of `effortApplied`,
`agentEffort`, `passedEffort` or `effortEnv` (a legacy row, `effortFactsRecorded` false) gets
`actualEffort` only and no `effortFollow`, since its advice cannot be checked (#252). It is
idempotent (a repaired row has the key and drops out), best-effort per row, and skipped when
`learning.enabled` is false.

In apply mode, `status` and doctor also say when every role of an opted-in swarm resolves to a
plain pin (cli.ts `pinnedSwarms`, the same rule as the plan's `ALL_PINNED_NOTE`, §16; skipped
under FORCE, which has its own warning, and with `respectFrontmatter` off): apply respects those
pins, so it cannot change any of their workers. `status` prints a `warning:` line and lists the
swarms as `pinnedSwarms` in `--json` (null outside apply mode); doctor adds the check "adjudicator
swarm pins" as information (ok), since the pins are respected by design.

## 12. Persistence

Migration v8 in `src/storage/sqlite/schema.ts`. Never edit a shipped migration.

Store: `src/storage/sqlite/adjudicator.ts`, `SqliteAdjudicatorStore`, following the
`SqliteSwarmStore` pattern.

- `StorageAdapter` gets `readonly adjudicator: AdjudicatorStore`.
- `SqliteAdapter` constructs it.
- `purge(scope)` gains `"adjudicator"`, which is also included in `"all"`. `em_purge`'s enum gets
  `"adjudicator"`.

```sql
CREATE TABLE IF NOT EXISTS adjudications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, surface TEXT NOT NULL,
  session_id TEXT, agent_id TEXT, tool_use_id TEXT, run_id TEXT, task_id INTEGER, parent_id INTEGER,
  input_hash TEXT NOT NULL, input_head TEXT, input_chars INTEGER,
  complexity REAL, tier TEXT, effort TEXT, tool TEXT, role TEXT, confidence REAL,
  scores TEXT,                  -- JSON: ScoreSet + features + alpha + bias
  source TEXT, provider TEXT, provider_model TEXT, provider_status TEXT,
  latency_ms INTEGER, provider_latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  action TEXT,                  -- advised|applied|followed|respected|ignored|none
  model_requested TEXT, model_final TEXT, baseline_model TEXT,
  actual_model TEXT, actual_tokens INTEGER, actual_cost_usd REAL, baseline_cost_usd REAL, savings_usd REAL,
  outcome TEXT NOT NULL DEFAULT 'pending',   -- pending|success|failure|abandoned|n/a
  outcome_source TEXT, outcome_ts INTEGER, final INTEGER NOT NULL DEFAULT 0, version TEXT);
CREATE INDEX IF NOT EXISTS adjudications_session ON adjudications(session_id, ts);
CREATE INDEX IF NOT EXISTS adjudications_task ON adjudications(run_id, task_id);
CREATE INDEX IF NOT EXISTS adjudications_hash ON adjudications(input_hash);
CREATE INDEX IF NOT EXISTS adjudications_ts ON adjudications(ts);
CREATE INDEX IF NOT EXISTS adjudications_final ON adjudications(final, ts);
CREATE TABLE IF NOT EXISTS adjudicator_cache (key TEXT PRIMARY KEY, verdict TEXT, provider TEXT,
  created_at INTEGER NOT NULL, last_hit_at INTEGER, hits INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS adjudicator_provider_state (provider TEXT PRIMARY KEY, state TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_ok_at INTEGER, last_error_at INTEGER,
  last_error_class TEXT, latencies TEXT /* JSON ring of ≤ 50 */, spend_day TEXT, spend_usd REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS adjudicator_bias (dimension TEXT NOT NULL, bucket TEXT NOT NULL, option TEXT NOT NULL,
  n REAL NOT NULL DEFAULT 0, s REAL NOT NULL DEFAULT 0, f REAL NOT NULL DEFAULT 0, cost_median REAL,
  bias REAL NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (dimension, bucket, option));
```

Store API (synchronous, better-sqlite3):

- `insert(row)` → id; `update(id, patch)`; `get(id)`
- `list({since, surface, provider, outcome, limit, offset})` → `{rows, total}`
- `latestForSession(sessionId, surface)`; `forTask(runId, taskId)`; `nonFinal(limit)`
- `cacheGet(key, now)`; `cachePut(key, verdict|null, provider)`; `cachePrune(maxEntries, ttlMs)`
- `providerState(p)`; `saveProviderState(p, s)`
- `biasAll()`; `biasUpsert(row)`; `biasReset()`
- `summary(since)`: counts by surface, source and provider_status; p50/p95 of `latency_ms` and
  `provider_latency_ms`; follow, apply and respect rates; Σ`cost_usd`, Σ`savings_usd`;
  `apply_ineffective` count
- `purge()`

Hook writes are single statements (< 1 ms), so they need no deferral.

Meta key `adjudicator:eval:last` holds the last eval report.

Never stored: keys or request headers. Text beyond `input_head`, and raw provider responses,
exist only in `adjudicator_exchanges` (migration v9), written only when
`privacy.captureExchanges` is on in the personal config, pruned to `EXCHANGE_KEEP = 100`.
`input_head` (`privacy.storeHead`) is at most 80 chars of `redact()`ed text. `redact()` masks:

- `sk-`, `ghp_`/`gho_`, `xox*`, `AKIA…` tokens and Bearer tokens
- secret-looking `key=value` or `key: value` pairs
- emails
- base64/hex runs of 32+ chars

### Exchange capture (`adjudicator_exchanges`, migration v9)

The Jev request log. Memory `adjudicator/jev-exchange-log-design` holds the full design.

- **Gate.** The engine builds a capture sink only when `privacy.captureExchanges === true`, the
  provider is `typesafe`, there is a store, and the decisions the call serves have rows to link
  to (`persist`, or `linkRowIds` for the async child). Cache hits, gate fallbacks, `call:
  "never"` and `persist: false` callers (`adjudicator test`, `adjudicator eval`, the dashboard
  try-it) write nothing. `probe()` is never captured.
- **Setting.** `privacy` is not in `PROJECT_ADJUDICATOR_KEYS`, so a committed
  `eminiar.config.json` cannot turn capture on, and neither can an untrusted personal file.
  `EMINIAR_ADJUDICATOR_CAPTURE=0` forces it off; `=1` does nothing.
- **What a row holds.** One row per HTTP request (at most `JEV_BATCH` = 10 items): the target
  (host and path, no query), model, surface, the decision row ids it served, the outcome, HTTP
  status, whether it timed out, attempts, and the timings (wait before sending, job wait for
  async prompts, time to first byte, duration, retry wait, deadline, engine budget), tokens and
  cost, and the request and response bodies.
- **Bodies.** A JSON body is scrubbed field by field (every string and key through the same
  scrub as `http.ts`; the key is replaced before and after `redact()`, so a zero-width or
  fullwidth echo of it is caught too; a string under a secret-named field, or a `cookie`,
  `set-cookie` or `proxy-authorization` field, is masked), then stringified, so the stored text is
  valid JSON; any other text is scrubbed whole. A raw response longer than `SCRUB_WINDOW` = 131 072
  characters is not parsed: only its head is scrubbed, and it is stored as text, truncated. The
  cap, `EXCHANGE_BODY_MAX` = 65 536 characters (UTF-16 code units, not bytes), applies after
  scrubbing, with a `truncated` flag and `bytes`, which is the length in characters before the
  cap (the field name is historical). Worst case per project: 100 rows x 2 bodies x 65 536
  characters = 13.1 million characters, up to three times that in UTF-8 bytes for CJK text. No
  header is ever passed to the capture code.
- **Retention.** `exchangeInsert` keeps the newest `EXCHANGE_KEEP` = 100 rows, `exchangePurge`
  deletes this project's rows, and `purge()` (`eminiar purge adjudicator`) deletes them with the
  rest. The prune, `exchangePurge` and `purge()` run under `PRAGMA secure_delete = ON` and
  `exchangePurge` and `purge()` end with a best-effort `wal_checkpoint(TRUNCATE)` (zero lock wait),
  so the text leaves the file and the log unless another process holds the database. The async
  child re-reads the setting (`captureStillOn`) before it writes. A capture failure never changes the verdict: the write takes no lock wait and fails open
  with one log line.
- **Surfaces.** `GET /api/adjudicator/jev/exchanges` (summaries, no bodies) and
  `/jev/exchange?id=` (one row with bodies) are gated before any database read: inactive when
  the adjudicator is off or the provider is not Jev, `{capture:false}` when capture is off. The
  dashboard's Jev requests table and drawer use them. `eminiar adjudicator exchanges
  [status|on|off|purge]` manages the setting and the rows. No file permissions are changed.

## 13. Outcomes, tokens and savings (`learn.ts`, `savings.ts`)

`reconcile(db, {limit})` runs:

- in SessionEnd (limit 200)
- in `em_adjudicate stats` and CLI `stats`
- before the dashboard GETs (limit 500)

It is idempotent: rows with `final=1` are skipped. It looks at non-final rows older than 2 min:

| Row kind | Outcome | Agent and tokens |
|---|---|---|
| plan / agent with run_id+task_id | `swarm_tasks.status`: done → success; failed or blocked → failure; run finished in any other state → abandoned; pending or active → wait | `agent_id` from `swarm_tasks.agent_id` / `swarm_agents` |
| agent without a swarm task | n/a, unless feedback arrives | `agent_id` linked best-effort: the first sidechain agent in `api_calls` for the same session whose first call starts within 60 s after ts (`outcome_source` "link") |
| prompt | n/a | tokens = the session's main-thread `api_calls` between this prompt row and the next one |

- `actual_model`, `actual_tokens` and `actual_cost_usd` come from `api_calls`. Usage ingestion
  must be on; otherwise these stay null and the UI says so.
- The same calls give `scores.actualEffort` and, for agent rows, `scores.effortFollow` (§11,
  effort check). Final agent rows without `actualEffort` get them from the bounded effort
  backfill at the end of each pass (§11, effort backfill).
- A row becomes final once its outcome is known, or after 24 h.
- When a row turns final, its bias buckets are updated (§7.7).

Baseline: what would have run without the adjudicator, resolved in this order (savings.ts
`resolveBaseline`; `Baseline.source` in brackets):

1. a ranged agent's fallback, the frontmatter `model` its role pins (`ranged`)
2. the role or agent frontmatter model, if it is pinned (not inherit) (`pinned`)
3. for an agent with no `model` line, `CLAUDE_CODE_SUBAGENT_MODEL` when it is set (`env`). It is
   opt-in: `onPreAgent` passes only that variable, and passes nothing for a fork, under FORCE
   or for `model: inherit`, which outranks it
4. otherwise the main-session model at ts: the latest main-thread `api_calls` row before ts
   (`session`)
5. otherwise usage's fallback model (`FALLBACK_MODEL` in `src/usage/savings.ts`) (`fallback`)

Under FORCE the baseline is `CLAUDE_CODE_SUBAGENT_MODEL` (else the session model), and for a
fork the session model (§11).

`baseline_cost_usd` = the same token vector (input, output, cache read, cache write 5m/1h)
repriced at the baseline model with `resolvePrice`/`costOfCall` from `src/usage/pricing.ts`,
which honours `config.usage.pricing` overrides.

`savings_usd` = baseline_cost − actual_cost. It is credited only when action is applied, or
followed. "Followed" means the Agent's `input.model` equals our advice and differs from the
baseline.

A failed attempt that is redone (a later row for the same run and task) gets
savings = −actual_cost: the retry is charged to the adjudicator.

Net savings = Σ credited savings − Σ `cost_usd` of the adjudicator's own calls, across all
persisted surfaces (prompt, agent, plan, tool, mcp); test calls are not persisted.

Main-session advice yields "potential" savings only: Σ over prompts where the advised tier was
below the tier that actually ran of (actual cost − the same tokens repriced at the advised tier).
It is never added to net, because we cannot observe the counterfactual.

Every savings figure is shown with its assumptions:

1. The token counts would have been the same on the baseline model. Smaller models can need more
   turns, so the dashboard shows tokens per successful task by tier next to it.
2. List prices, with cache pricing unchanged.
3. Credit only for dispatches that were followed or applied, and none for a dispatch whose advice
   named no model: it kept the agent's model pin (`pinDeferred` in the row's scores: pinned,
   unknown, or a ranged agent's fallback), `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` was on (`forced`),
   or it was a fork (`fork`). A ranged dispatch that moved the model earns credit like any
   followed advice, against its fallback.
4. The adjudicator's own spend is subtracted.
5. No credit for tool advice: eminiar's `em_stats` already counts context kept out by `em_*`
   tools, so crediting it here would double-count. We report only the tool-advice follow rate.

## 14. Failure modes

| Failure | Behaviour |
|---|---|
| provider timeout, 5xx, 429 or 529 | the heuristic verdict stands, `providerStatus` is set, the breaker counts one failure |
| invalid output, or json_schema rejected | one json_object retry if the budget allows; otherwise fallback with status invalid |
| no key or no consent | effective provider is the heuristic; doctor fails; one SessionStart line per session |
| key file permissions too open | not read; doctor fails with a `chmod 600` hint |
| breaker open, slow p95, or over the daily budget | provider skipped; status recorded |
| DB busy or locked, or v8 not migrated | the verdict is still returned but not persisted. `hooks.ts` wraps each surface in try/catch and never throws into the dispatcher |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on (`1`/`true`/`yes`/`on`) | no apply; action respected; the advice calls the model informational and names no pin; the row gets `forced` (no credit); status and doctor warn when mode is apply |
| a fork (`subagent_type: "fork"`) | no apply, no `model` or `effort` advice; the row gets `fork` (no credit) |
| explicit Agent model, or pinned frontmatter | no apply; action respected |
| ranged agent whose pick is its fallback's tier, or outside apply.floor..ceiling | no apply; action respected; the agent runs on its fallback; the row gets `pinDeferred` (no credit) |
| apply mode while every role of a swarm pins a model without a range | apply changes none of its workers; the plan block names it (`ALL_PINNED_NOTE`), `status` warns and doctor notes it (§11) |
| a hand-edited ranged agent file | its hash fails, so the range is not read: a plain pin of the frontmatter `model` |
| model outside the org's `availableModels` | Claude Code substitutes another; reconcile records `actual_model` and the mismatch |
| the applied model did not run (a mod's `agent.spawn` hook, another plugin's `updatedInput`, a link gap; §11) | detected as `apply_ineffective`; status and doctor show "k of n" |
| async child dies or hangs | its own deadline kills it; the pending marker expires after 30 s; the heuristic stands |
| embedding model not cached or not warm | embedding provider unavailable; heuristic; doctor shows "model not downloaded" |
| prompt injection in the scored text | outputs are enums and numbers only; apply is clamped by floor, ceiling and minConfidence; nothing is ever denied |
| Jev alias moves | the version is pinned; re-run eval before bumping `typesafe.model` |
| Cursor client | skipped on every surface |
| many prompts in parallel sessions | the cache plus the pending marker dedupe; the breaker is shared through SQLite |
| a team's config turns the feature on | it can set `enabled` and the behaviour knobs only; the provider, URL, key, consent and caps come from the user's own config, so without one only the heuristic runs |
| a cloned repo's config names a host or `keyEnv` | dropped by the project allowlist; doctor/status name the ignored keys |
| a cloned repo's `.claude/settings.json` env sets `EMINIAR_ADJUDICATOR_REMOTE=1` and a remote provider | env cannot grant consent; without the origin in the personal `remoteConsentOrigins` the provider degrades with `no_consent` |

## 15. MCP surface: a new tool `em_adjudicate`, registered only when enabled

Why a new tool and not an action on an existing one:

- `em_swarm` is the coordinator and worker protocol, with caller stamping and enforcement.
  Adjudication is not swarm-only: it serves plain prompts and plain Agent calls.
- `em_usage` is read-only transcript analytics. Adjudication needs on-demand scoring and a write
  path (feedback).
- A separate tool can be left out of the tool list when the feature is off, so its schema costs
  nothing in sessions that don't use it.

How: `ToolDef` (`src/tools/types.ts`) gets an optional `available?: (config: Config) => boolean`.
`src/server.ts` filters the tools against the config loaded at start.
`eminiar adjudicator enable` tells the user to run `/mcp` reconnect.

Schema:

```
{ action: "score" | "explain" | "stats" | "feedback",
  text?: string (≤ 8000),
  tasks?: [{ key, title, detail?, role? }] (≤ 20),
  id?: int,
  outcome?: "good" | "too_small" | "too_big",
  note?: string (≤ 200),
  since?: string }
```

Actions:

- **score**: one compact line per item with complexity, tier + effort, tool, role, confidence,
  the top 3 reasons, source/provider and latency. The row is recorded with surface `mcp`. Uses
  the plan budget.
- **explain** `{id}`: the full score tables with reasons, features, α and bias, provider status,
  latency, tokens and cost, outcome, actual model and tokens, savings.
- **stats** `{since}`: the same summary as the CLI, run after reconcile.
- **feedback** `{id, outcome, note}`: sets the outcome (`outcome_source` feedback, final) and
  updates the bias.

Output stays under 1 KB, except explain.

The server also calls `registerProvider("embedding", ...)` at start when the effective provider
is embedding.

## 16. Swarm integration (advice is the primary path)

- `em_swarm plan` (`src/tools/em_swarm.ts`, the handler that calls `planned()`, L274-306): when
  enabled and `surfaces.plan` is on, call `adjudicatePlan(ctx, runId, addedTasks)` after
  `addTasks`.
  - One batched provider call within `planMs`; the heuristic on any failure.
  - Insert plan rows (run_id, task_id).
  - For each task, append e.g.
    "#5 → swarm-feature-coder · model haiku · effort low (complexity 1, conf 0.82)", or, when
    the role's agent pins a model (resolveAgentPin; respected unless
    `apply.respectFrontmatter` is off), "#5 → swarm-feature-coder · pinned opus (adjudicator
    would pick haiku; remove the pin in swarm.yaml to let it choose) · effort low (…)"; an
    unreadable definition shows "model pin is unknown (…)". Under FORCE no pin is named and the
    model reads "model haiku (informational)".
  - A ranged role (§11) reads "#5 → swarm-feature-coder · model haiku (range haiku–opus,
    fallback sonnet) · effort low (…)" when its pick moves the model, and "fallback sonnet
    (range haiku–opus; matches the adjudicator's pick)" (or "…; no pick inside
    apply.floor..ceiling)") when it keeps the fallback. `PlanAdvice.model` is then the pick, and
    the plan row stores `ranged`, `fallbackPin`, `pin {status: "ranged", …}` and
    `baselineModel` = the fallback.
  - A saturated brief (§7.9) reads "effort max: informational (brief saturated; complexity 4,
    …)". The head adds "; a saturated brief's effort is informational: pass no `effort`" when
    others are not saturated, and says "every brief is saturated, naming more work than its
    hardest statement scores" when all are.
  - Apply mode (`PlanAdvice.effortApplied`, unless `CLAUDE_CODE_EFFORT_LEVEL` is set): the
    effort reads "effort low (applied by the hook)", a saturated brief's included, and the head
    and "Next:" tell the coordinator to pass no `effort` ("the hook sets `effort` on the Agent
    call in apply mode, so pass no `effort`"; "Next:" adds "; the hook sets `effort` (apply
    mode): pass no `effort`").
  - Add "role suggested: tester (planned: coder)" when the role differs and the role table's
    confidence is at least `ROLE_NOTE_MIN` (§7.5).
  - When every role of the swarm resolves to a plain pin (pins respected, FORCE off), the
    block's second line is `ALL_PINNED_NOTE`: "every role pins a model: the adjudicator cannot
    change any worker (add model_range in swarm.yaml)". The simulation of swarm run
    `20261104-90e129` expected model switching where every role was pinned, which is what this
    line, and the matching `status`/doctor warning in apply mode (§11), now say.
  - The advice step fails open: the tasks are already stored, so an error there logs to
    stderr (em_swarm passes `log` and `onError` to adjudicatePlan, which never throws) and the
    plan returns its normal text plus "Adjudicator advice unavailable for this plan (the tasks
    are planned)." (a reported failure would make the coordinator plan twice).
- The "Next:" text comes from the same rule as the advice head (`planPassing` /
  `planNextHint`): it names `model` only when some task has a model to pass (FORCE off, agent
  not pinned, or ranged with a moving pick), `effort` only when it is not informational, and
  adds "leave `model` unset for pinned agents" (a ranged agent that keeps its fallback counts as
  pinned) or "… (CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets it)" as needed.
- No `PlanTask` schema change, no new `TaskRow` columns, no new `EVENT_KINDS`. The swarm ledger
  stays stable, and the suggestions live in `adjudications`. `swarm.yaml` gained one key, the
  opt-in per-role `model_range` (and `defaults.model_range`; docs/swarms.md "Model ranges",
  task #103): without it, config, agent files and hashes are byte-identical to before.
- `coordinatorBrief` (`src/swarm/brief.ts`, steps block) gets one line when enabled: "Adjudicator
  on: em_swarm plan shows a suggestion per task and says exactly what to pass on the Agent call
  (`model` and/or `effort`; pinned agents, CLAUDE_CODE_SUBAGENT_MODEL_FORCE and
  CLAUDE_CODE_EFFORT_LEVEL change what it asks for). Follow each line as written." When a role
  has a range (the worker list shows "sonnet, range haiku..opus"), the line adds: "Roles listed
  with a range run on their fallback model unless their line says `model X (range …)`: then pass
  model X."
- In apply mode, `onPreAgent` finds the plan row by (run, task) through
  `spawn.kind === "worker"`, so it needs no extra provider call.

## 17. CLI (`src/adjudicator/cli.ts`, loaded lazily from `src/cli.ts` as the `adjudicator` command, plus help text)

- `status [--json]`: enabled; configured vs effective provider and why; mode; surfaces; key
  source (env, file or none, masked); consent; breaker and health; last-24 h summary; apply
  effectiveness; in apply mode, a warning for FORCE and one for swarms whose every role pins a
  model (`pinnedSwarms`, §11).
- `enable [--provider P] [--preset X] [--mode advise|apply] [--project] [--accept-remote]`:
  - writes `~/.eminiar/config.json`; `--project` writes only `adjudicator.enabled: true` into
    `eminiar.config.json`
  - for a remote provider it prints exactly what leaves the machine: "The text of your prompts
    and subagent tasks (redacted, at most 2000 chars) is sent to <host> to score them." Then it
    asks y/N on a TTY. Without a TTY, `--accept-remote` is required. `--yes` never implies
    consent.
  - prints a reminder to `/mcp` reconnect
- `disable [--project]`.
- `provider <heuristic|typesafe|openai-compatible|embedding> [--preset] [--base-url] [--model]`,
  and `provider --detect`, which probes ports 11434, 1234 and 8080 within `connectMs` and
  suggests a provider but never enables one.
- `key set [provider]` (hidden TTY input or stdin; `--from-env NAME` stores `keyEnv` instead),
  `key clear [provider]`, `key show` (source and masked tail).
- `test "<text>" [--provider P] [--json]`: the heuristic, the provider-raw result and the
  blended verdict side by side, with latency, tokens and cost. Not persisted.
- `eval [--providers heuristic,typesafe,...] [--fixture file.json] [--repeat N] [--json]`: see
  §19.
- `stats [--since 7d] [--json] [--reset-learning]`: the summary plus savings with their
  assumptions.

## 18. Install, onboarding, doctor

Install (`src/install/install.ts`):

- new flag `--adjudicator[=heuristic|typesafe|groq|cerebras|ollama|lmstudio|llamacpp]`
- an interactive TTY install asks "Enable the adjudicator? It is off by default, and the
  heuristic runs only on this machine. [y/N]" through a separate `askNo()`. Under `--yes` it is
  skipped and the answer is No, because `confirm()` returns true for `--yes`.
- remote choices go through the same consent text, then point to `eminiar adjudicator key set`
- `writeTeamFiles` never writes the provider, keys or consent

Onboarding: `skills/em-onboard/SKILL.md` gets an optional closing step that explains the
adjudicator, the privacy difference between local and remote providers, and
`eminiar adjudicator enable`. It never auto-enables.

Doctor, cheap checks with no network (`src/doctor.ts` `runDoctor`; also shown in `em_doctor` and
the dashboard System tab via `/api/doctor`):

- config valid
- when enabled: effective provider equals the configured one, or the reason it doesn't
- key present, and the key file is 0600
- consent given for a remote provider
- breaker state
- 24 h fallback rate, and p95 against the budget
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set while mode is apply
- apply effectiveness
- every role of an opted-in swarm pinned without a range while mode is apply (information, check
  "adjudicator swarm pins": apply cannot change those workers; fix with `model_range`)
- embedding model cached

`fullDoctor` (`src/install/doctor.ts`) adds a live probe with a 2 s timeout: typesafe
`GET /v1/models`, openai `GET {baseUrl}/models`, and local port detection.
`skills/em-doctor/SKILL.md` mentions these checks.

## 19. Eval harness (`src/adjudicator/eval.ts`; `eminiar adjudicator eval`)

Fixture: `src/adjudicator/data/evalset.ts` holds the 40 items from `research-local-3`, each
`{text, tool, tier, role, complexity}`. A test asserts it is disjoint from `data/exemplars.ts`.
`--fixture file.json` adds items or replaces the set (same shape).

Rows always reported:

- majority-class reference
- heuristic-only
- one row per candidate provider, both provider-raw and blended (as shipped)

Providers run batched like a plan (chunks of 10), with the plan budget per chunk. `--repeat N`
gives latency percentiles.

Metrics, per field (tier, complexity, role, tool):

- exact accuracy; for complexity also within-±1 and MAE
- JSON/answer validity rate; timeout and fallback rate
- p50/p95 latencyMs; tokens and $ per 1k items
- calibration: accuracy at confidence ≥ 0.8 vs < 0.8

The run ends with one verdict line: "<provider> beats heuristic-only on tier+complexity: yes/no
(Δ tier +x pp, Δ complexity ±1 +y pp)".

- The report goes to meta `adjudicator:eval:last`, without any item text.
- Remote providers need consent and a key, as everywhere else.
- Offline (heuristic and embedding) runs must work in CI.

Guidance in the docs: grow the set past 100 items from real prompts (store hashes and labels, not
text) and hold out 30% before tuning weights. Several labels are debatable, so agreement between
labellers is part of the test.

## 20. Dashboard

API: `src/ui/adjudicator-api.ts` exports `adjudicatorRoute(ctx, {path, method, query, body})`,
mounted in `src/ui/server.ts` the same way as `swarmRoute`. The loopback-origin guard covers the
POST.

- `GET /api/adjudicator`: sanitised config, enabled, configured vs effective provider with the
  degraded reason, `keySource` (env, file or none; never the key), consent, health per provider
  (breaker state, `last_error_class`, p50/p95, daily spend vs cap), apply effectiveness, and
  `summary(since)`.
- `GET /api/adjudicator/decisions?since&surface&provider&outcome&limit&offset` returns
  `{rows, total}`. Rows carry no scores JSON, only `input_head`.
- `GET /api/adjudicator/decision?id`: the full row, including the parsed scores (features,
  tables, reasons, α, bias).
- `GET /api/adjudicator/savings?since`: realised, potential, adjudicator spend, net,
  `assumptions[]`, tokens per successful task by tier, the suggested-tier × actual-model
  matrix, and `keptModel` (dispatches left out of the matrix: kept pin, FORCE, fork).
- `GET /api/adjudicator/eval`: the last eval report, or null.
- `POST /api/adjudicator/test {text, useProvider?: boolean}`: uses the heuristic, plus the
  provider only if enabled, consented and keyed. Never persisted.
- The GETs call `reconcile(limit 500)` first. Every input is validated: since, limit ≤ 500,
  enums. Payloads never contain keys or text beyond `input_head`.

Tab "Adjudicator" (`src/ui/web/views/Adjudicator.tsx`; add `"adjudicator"` to `VIEWS` in
`router.ts` and to `TABS` in `app.tsx`; client types appended to `src/ui/web/api.ts`; pure
helpers in `views/adjudicator-helpers.ts`):

0. When disabled: an empty state that explains the feature, its privacy model and
   `eminiar adjudicator enable`, plus the try-it box running the heuristic only.
1. KPI row: decisions; follow and apply rate; fallback rate; provider p50/p95; adjudicator spend;
   net savings, with a "how is this computed" popover listing the assumptions.
2. Provider health card: configured and effective provider, breaker state and retry time, last
   error class, daily spend vs cap, apply effectiveness (n of m), key source.
3. Charts, following the dataviz rules, the existing palette approach (`usage-helpers.ts`) and
   light/dark tokens:
   - decisions per day, stacked by source (heuristic, blend, cache, fallback)
   - complexity histogram (0-4)
   - suggested tier × actual model matrix (heatmap)
4. Call log table with filters (surface, provider, outcome, time) and paging. Clicking a row opens
   a detail drawer: features, the three score tables as bars with their reasons, the complexity
   terms, α and bias, provider status, latency and tokens, outcome, actual model and tokens,
   savings.
5. Savings panel: realised vs potential vs spend vs net, the assumptions list, and tokens per
   successful task by tier.
6. Try-it box (POST test) and the last eval report table.

It must work at phone width with no horizontal page scroll; the call log table may scroll inside
its own container.

## 21. Docs

- `docs/design/adjudicator.md`: this document.
- `docs/adjudicator.md`, the user guide:
  - what it does and what it doesn't
  - privacy: a table per provider of what leaves the machine
  - setup for each preset (Jev key, Groq, Cerebras, Ollama with
    `ollama pull qwen2.5:1.5b-instruct`, LM Studio, llama.cpp)
  - advise vs apply, with the Claude Code precedence facts (Agent model > frontmatter >
    `CLAUDE_CODE_SUBAGENT_MODEL`; FORCE overrides everything; `effort` on the Agent call from
    Claude Code 2.1.292, outranked by `CLAUDE_CODE_EFFORT_LEVEL`)
  - latency budgets, breaker and budgets
  - learning, the savings method, eval, troubleshooting
- `docs/configuration.md`: an `adjudicator` table covering every key.
- `docs/cli.md`: the `eminiar adjudicator` subcommands.
- `docs/tools.md`: `em_adjudicate`.
- `docs/dashboard.md`: the Adjudicator tab.
- `docs/README.md` index; a `README.md` feature bullet.
- Version bump to 0.13.0 per the release/pr-version-bump rule.
- At finish, record two decision memories:
  - the scope ruling: model choice through the Agent `model` parameter is in scope and is not
    "routing"
  - the architecture summary

## 22. Task split

17 tasks: T0-T16. Tasks that can run at the same time never share a file.

Order:

1. T0 and T1 start immediately.
2. After T1: T2, T3, T4 and T5 run in parallel; T7 starts once T2 is done.
3. After T2+T3+T4: T6.
4. Then T8, T9, T10 and T12 in parallel; T11 after T10; T13 after T12.
5. T14 and T15 after the integrations; T16 last.

Every task must keep `npm run typecheck`, `npm run lint` and `npm test` green.

Critical path: T1 → T2 → T6 → T8/T9 → T14/T15 → T16. Most parallel work happens after T1
(T2-T5, T7) and after T6 (T8, T9, T10, T12).

### T0 · coder · Write the design doc

Files: `docs/design/adjudicator.md`
Deps: none

Accept: transcribes blackboard design … design-10 faithfully (including the erratum in
design-8), with headings §1-§22.

### T1 · coder · Foundations: shared types, config schema, secrets, redaction

Files: `src/adjudicator/types.ts`, `src/adjudicator/config.ts`, `src/adjudicator/secrets.ts`,
`src/adjudicator/redact.ts`, `src/config.ts`, `src/paths.ts`, `eminiar.config.schema.json`,
`tests/unit/adjudicator-config.test.ts`
Deps: none

Accept:

- the types from §4 and the schema and defaults from §5 (enabled false); `parse({})` round-trips
- env overrides work; the project layer cannot set `remoteConsent` (later: anything outside
  `PROJECT_ADJUDICATOR_KEYS`, #32); the refine rejects key-like
  fields
- `PRESETS` and `isLoopback`; `resolveAdjudicator` returns the effective provider plus a degraded
  reason for no_key, no_consent and hook_context
- secrets: written 0600 via temp file + rename; a 0644 file is refused; resolution order as in
  §6; `mask()`; `resetSecrets()`
- `redact()` cases: `sk-`, `ghp_`, `AKIA`, Bearer tokens, key=value pairs, emails, long hex
- schema regenerated

### T2 · coder · Storage: migration v8, AdjudicatorStore, purge

Files: `src/storage/sqlite/schema.ts`, `src/storage/adapter.ts`, `src/storage/sqlite/adapter.ts`,
`src/storage/sqlite/adjudicator.ts`, `src/tools/em_purge.ts`,
`tests/unit/adjudicator-store.test.ts`
Deps: T1

Accept:

- the v8 tables and indexes from §12, applied on top of a v7 DB; shipped migrations untouched
- the full store API from §12
- `purge("adjudicator")` and `purge("all")` clear the 4 tables; `em_purge` accepts
  `"adjudicator"`
- `summary()` verified on fixture rows (rates, p50/p95, spend, savings)
- edits to `adapter.ts` and `sqlite/adapter.ts` stay at about 5 lines each

### T3 · coder · Heuristic scorer, blend, eval fixture

Files: `src/adjudicator/features.ts`, `src/adjudicator/heuristic.ts`, `src/adjudicator/blend.ts`,
`src/adjudicator/data/evalset.ts`, `tests/unit/adjudicator-heuristic.test.ts`
Deps: T1

Accept:

- §7.1-7.6, §7.8; pure functions; every non-zero term yields a Reason; each table sums to 1
- p95 under 2 ms per item over the 40 items
- on the eval set, heuristic-only exact accuracy beats the majority class on tier (0.475) and
  complexity (0.30), and complexity within ±1 is ≥ 0.8
- blend tests: α caps per provider, the `selfReportScale` discount, low-confidence round-up, bias
  renormalisation, Jev noul adjustments
- `formatAdvice()` is ≤ 220 chars

### T4 · coder · HTTP layer, Jev and OpenAI-compatible providers, prompt builders

Files: `src/adjudicator/providers/http.ts`, `src/adjudicator/providers/typesafe.ts`,
`src/adjudicator/providers/openai.ts`, `src/adjudicator/providers/index.ts`,
`src/adjudicator/prompt.ts`, `tests/unit/adjudicator-providers.test.ts`
Deps: T1

Accept (all with mocked fetch):

- Jev request: pinned model, one request per ≤ 10 items, namespaced questions; response mapped to
  `ProviderAnswer` with calibrated Dists; cost from input_tokens
- OpenAI: strict schema ≤ 5000 chars; json_object retry on a 400; presets applied (ollama
  keep_alive/options)
- 429/529 retried at most once and only when ≥ 300 ms remain; the deadline aborts the request;
  error classes correct
- the key never appears in thrown errors or log lines (test with a sentinel key)
- `createProvider`/`registerProvider`; `providers/index.ts` has no static or dynamic import of
  `embedding.ts`

### T5 · coder · Embedding provider and exemplars

Files: `src/adjudicator/providers/embedding.ts`, `src/adjudicator/data/exemplars.ts`,
`tests/unit/adjudicator-embedding.test.ts`
Deps: T1

Accept:

- ≥ 15 exemplars per tier, labelled with tier and complexity; disjoint from the eval set (test,
  once T3 has landed; otherwise compared against the `research-local-3` list)
- the vector cache file is keyed by a sha of the texts + model id and written under
  `paths().models`
- k-NN with an injected stub embedder: similarity-weighted votes, `minSimilarity` respected
- exports a factory for `registerProvider`; imported only by `src/server.ts` and
  `src/adjudicator/cli.ts`/`eval.ts`

### T6 · coder · Engine, breaker, async job

Files: `src/adjudicator/engine.ts`, `src/adjudicator/breaker.ts`, `src/adjudicator/async.ts`,
`src/hook.ts`, `tests/unit/adjudicator-engine.test.ts`
Deps: T2, T3, T4

Accept:

- pipeline: cache → heuristic → gate (consent, key, breaker, slow, budget) → provider → blend →
  persist (§9)
- breaker closed → open → half-open persisted across "processes" (fresh store instances); slow
  guard; daily cap; pending-marker dedupe
- `adjudicate()` never throws, and returns the heuristic within budget + 20 ms when the provider
  hangs
- async: `spawnAsyncJob` writes the job to the child's stdin (spawn mocked); `runAsyncJob`
  updates the row and the cache
- `src/hook.ts` `--adjudicate` branch; the key is not in the job JSON

### T7 · coder · Reconcile, learning, savings

Files: `src/adjudicator/learn.ts`, `src/adjudicator/savings.ts`,
`tests/unit/adjudicator-learn.test.ts`
Deps: T2

Accept:

- §13 on fixture `swarm_tasks`/`api_calls` rows: outcome mapping, agent_id linking (swarm and
  best-effort), prompt token windows, finalisation after 24 h
- baseline resolution order; repricing with `src/usage/pricing.ts`
- credit only for followed/applied; the redo penalty; net = credited savings − spend; potential
  savings kept separate
- bias: Beta(2,2), decay, minSamples, clamp to maxBias, cost term, the feedback mapping;
  `learning.enabled=false` gives an empty bias; idempotent re-runs

### T8 · coder · Hook integration

Bug-prone files: thin call-outs only; read `em_history` for `routing.ts` and `capture.ts` first.

Files: `src/adjudicator/hooks.ts`, `src/hooks/capture.ts`, `src/hooks/routing.ts`,
`src/hooks/session-start.ts`, `tests/unit/adjudicator-hooks.test.ts`
Deps: T6, T7

Accept:

- disabled: no adjudicator function runs and no adjudications/cache rows are written (spy test)
- UserPromptSubmit advice line; skip rules; async vs blocking `promptMode`; main-session
  `systemMessage` with cooldown
- PreToolUse Agent, apply mode: `updatedInput` contains EVERY original field + model on all of
  routing's paths: the enforce prefix, the already-prefixed early return, annotate, mode off
- FORCE env, an explicit model and a frontmatter pin are respected; nothing is ever denied
- apply mode puts the advised `effort` in the same `updatedInput` as `model`, also when the model
  is kept (pin, ranged fallback, explicit model, FORCE) and over the call's or the agent file's
  effort; never for a fork, under `CLAUDE_CODE_EFFORT_LEVEL`, on a denied or asked call, or as a
  value outside `EFFORTS`; advise mode never sets it
- advise mode makes no network call in `onPreAgent`
- non-Agent PreToolUse: at most one SELECT when `surfaces.tools` is on, none when off
- the Cursor client is skipped; SessionEnd calls reconcile
- the existing hooks, routing and swarm-hooks suites pass unchanged

### T9 · coder · em_adjudicate tool and swarm plan advice

Files: `src/adjudicator/swarm.ts`, `src/tools/em_adjudicate.ts`, `src/tools/index.ts`,
`src/tools/types.ts`, `src/server.ts`, `src/tools/em_swarm.ts`, `src/swarm/brief.ts`,
`tests/unit/adjudicator-swarm.test.ts`
Deps: T5, T6, T7

Accept:

- `ToolDef.available`; `em_adjudicate` is absent from the tool list when disabled and present
  when enabled
- the score, explain, stats and feedback actions (§15)
- `em_swarm plan` makes one batched provider call per plan and prints the per-task lines and
  role-differs notes (§16); plan rows are stored by (run, task)
- one `coordinatorBrief` line when enabled; swarm-tool, swarm-review and swarm-hooks suites pass
  unchanged
- the server registers the embedding provider when it is effective

### T10 · coder · Eval harness

Files: `src/adjudicator/eval.ts`, `tests/unit/adjudicator-eval.test.ts`
Deps: T5, T6

Accept:

- §19: reference rows (majority, heuristic), raw and blended rows per provider, all listed
  metrics including calibration, the verdict line, `--fixture` merge/replace
- the meta report contains no item text
- runs offline with the heuristic and a stubbed embedding provider; a mocked remote provider is
  exercised

### T11 · coder · CLI, install flag, doctor, onboarding

Files: `src/adjudicator/cli.ts`, `src/cli.ts`, `src/install/install.ts`,
`src/install/doctor.ts`, `src/doctor.ts`, `skills/em-onboard/SKILL.md`,
`skills/em-doctor/SKILL.md`, `tests/unit/adjudicator-cli.test.ts`
Deps: T5, T6, T7, T10

Accept:

- every subcommand in §17, with `--json` where listed
- consent flow: y/N on a TTY; without a TTY, `--accept-remote` is required; `--yes` never grants
  it
- the key is never accepted on argv; the key file is 0600; `--project` writes only `enabled`
- `install --adjudicator[=preset]`; the interactive question defaults to No and is skipped under
  `--yes`; `writeTeamFiles` is unchanged
- the doctor checks from §18; existing install, doctor and cli tests pass

### T12 · coder · Dashboard API

Files: `src/ui/adjudicator-api.ts`, `src/ui/server.ts`, `tests/unit/adjudicator-api.test.ts`
Deps: T6, T7

Accept:

- the endpoints in §20, with validation (bad since or limit → 400) and reconcile before the GETs
- a sentinel key and the raw prompt text never appear in any payload
- the POST is behind the loopback guard; test does not persist

### T13 · ui · Dashboard Adjudicator tab

Files: `src/ui/web/views/Adjudicator.tsx`, `src/ui/web/views/adjudicator-helpers.ts`,
`src/ui/web/router.ts`, `src/ui/web/app.tsx`, `src/ui/web/api.ts`,
`tests/unit/adjudicator-view.test.ts`
Deps: T12

Accept:

- the §20 layout (the disabled empty state, KPIs, health card, 3 charts, the call log with its
  detail drawer, the savings panel with assumptions, try-it, the last eval)
- light and dark themes; phone width with no page-level horizontal scroll
- pure helpers unit-tested (formatting, matrix building)
- `npm run build:ui` passes; a screenshot via `scripts/capture-screenshots.mjs` if practical
- append-only edits to `api.ts`

### T14 · coder · User docs and version

Files: `docs/adjudicator.md`, `docs/configuration.md`, `docs/cli.md`, `docs/tools.md`,
`docs/dashboard.md`, `docs/README.md`, `README.md`, `package.json`, `package-lock.json`,
`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`
Deps: T8, T9, T11, T13

Accept:

- every config key documented with its default
- a privacy table per provider
- commands match `eminiar adjudicator --help`; the `em_adjudicate` schema matches
- the savings method and its assumptions; Claude Code model precedence facts
- version 0.13.0 via `npm version` (`scripts/sync-plugin-version.mjs`)

### T15 · tester · End-to-end, latency and privacy verification

Files: `tests/integration/adjudicator.test.ts`, `scripts/bench-hotpath.mjs`
Deps: T8, T9, T11, T12

Accept:

- the bench gains hook cases with the feature disabled and enabled; disabled adds ≤ 1 ms p50 over
  the baseline; enabled heuristic UserPromptSubmit stays ≤ 150 ms p95, real process included
- the apply-mode `updatedInput` merge keeps every field, through the real `dispatch()` with
  routing in enforce mode and in annotate mode
- a sentinel key never appears in `hook.log`, a DB dump, dashboard payloads, CLI output or the
  async job stdin
- against a dead localhost port, the breaker opens after 2 failures and later calls add ≤ 5 ms
- `eminiar adjudicator eval --providers heuristic` runs offline and prints the reference rows
- with `EMINIAR_ADJUDICATOR=0` everything is off

### T16 · tester · Final regression sweep and review

Files: none of its own. It reports defects to the coordinator as new tasks and does not edit
files other tasks own.
Deps: T0, T14, T15

Accept:

- typecheck, lint, the full test suite, `npm run build` (the hook bundle does not contain the
  exemplar texts or `embedding.ts` code; grep `dist/hook.js` for a marker string) and `build:ui`
  all pass
- the Cursor client is skipped
- the swarm and routing suites pass
- docs agree with the code
- an adversarial review of apply mode and the privacy paths, with findings listed
