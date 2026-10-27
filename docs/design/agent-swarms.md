# Design: agent swarms (opt-in)

Status: accepted · branch `feature/agent-swarms` · target v0.11.0 · 2026-10-28

## Goal

Let a project define a **worker swarm** in `.eminiar/swarm.yaml`: named roles, their prompts,
models, tools, skills and hooks, plus how they coordinate. The main Claude Code session leads
the swarm; workers are ordinary Claude Code subagents generated from the YAML. Every worker
starts knowing what eminiar knows: memories, git history, code structure and insights. The
dashboard shows swarm activity live.

Inspired by ruvnet/ruflo (queen-led swarms, agent roles, shared memory, hooks, a swarm monitor),
but **not a replica**. Only the core needed for a functional worker swarm is built.

### Out of scope

- Consensus protocols (Raft, Byzantine, Gossip), federation, neural or self-learning layers.
- A catalogue of 100+ agents, daemons, background schedulers.
- Harnesses other than Claude Code.
- Spawning `claude -p` processes from eminiar. Claude Code itself runs every agent.

## Constraints from Claude Code

These shape the design and were checked against the Claude Code docs.

| Fact | Consequence |
|---|---|
| Subagents cannot spawn subagents. | The **main session is the coordinator** ("queen"). Workers are leaves. |
| Project agents live in `.claude/agents/<name>.md` with frontmatter `name, description, tools, disallowedTools, model, skills, hooks, isolation, maxTurns, effort`. | eminiar **generates** one agent file per swarm role from the YAML. |
| Frontmatter `hooks` are scoped to that subagent (PreToolUse, PostToolUse, Stop). Plugin agents ignore `hooks`. | Per-role hooks pass through to *project* agent files, which honour them. |
| Frontmatter `skills` preload the full SKILL.md into the subagent. | Per-role skills pass through. |
| `SubagentStart` gets `agent_id`, `agent_type` and may return `additionalContext`. It cannot block and does not see the prompt. | The worker brief is injected here. |
| PreToolUse / PostToolUse fired inside a subagent carry `agent_id` and `agent_type`. | Activity is attributed to a worker; the `em_swarm` call is stamped with its caller. |
| PreToolUse `updatedInput` replaces the whole input. | Stamping spreads the original input and adds fields. |
| PreToolUse on `Agent` sees `subagent_type`, `prompt`, `description`. | Capacity limits are enforced and the spawn is recorded before the worker starts. |
| `SubagentStop` gets `last_assistant_message`. | The worker's result is captured even if it never reported. |

## Opt-in

The feature is **off** unless `.eminiar/swarm.yaml` (or `.yml`) exists and `enabled` is not
`false`. With no file:

- every hook path returns before any I/O beyond one `agent_type` prefix test or one `existsSync`;
- `em_swarm` answers with how to opt in (`eminiar swarm init`);
- the dashboard Swarms tab shows an empty state with a "Create starter swarm.yaml" button.

## The swarm file

```yaml
# .eminiar/swarm.yaml
version: 1
enabled: true
sync: auto            # auto: SessionStart regenerates agent files when the YAML changed
defaults:
  model: sonnet       # inherit | sonnet | opus | haiku | fable | a full model id
  context:            # what each worker is told at start
    memories: 4
    docs: 2
    history: true     # bug-prone files and lessons for the role's scope
    structure: true   # project brief, hot files in scope
    insights: true    # hotspots, recent fixes
    max_chars: 4000
swarms:
  feature:
    description: Plan, build, test and review a change.
    topology: hierarchical          # hierarchical | mesh | pipeline
    max_agents: 4                   # concurrent workers in one run
    stages: [architect, coder, tester, reviewer]   # pipeline only
    instructions: |                 # extra playbook text for the coordinator
      Keep tasks small enough for one worker.
    agents:
      architect:
        description: Designs the change from the code graph and past decisions.
        model: opus
        tools: [Read, Grep, Glob]
        skills: [eminiar:em-graph]
        scope: ["src/**"]
        memory_tags: [decision, constraint]
        prompt: |
          Produce a short design and post it under the key "design".
      coder:
        description: Implements one task at a time.
        count: 2                    # at most two coders at once
        hooks:
          PostToolUse:
            - matcher: "Edit|Write"
              hooks:
                - type: command
                  command: "npx biome check --write --no-errors-on-unmatched ."
        prompt: Implement the claimed task. Keep the diff minimal.
      reviewer:
        description: Adversarial reviewer that tries to break the change.
        model: opus
        prompt: Find correctness bugs with a concrete failing input.
```

Validation (zod) rejects unknown topology, bad names (`^[a-z][a-z0-9-]{0,31}$`), stages that
name missing roles, malformed hooks (events limited to `PreToolUse`, `PostToolUse`, `Stop`;
each hook `{type:"command", command, timeout?}`), and agent names longer than 64 characters.
Errors carry the YAML path (`swarms.feature.agents.coder.count`).

## Generated agents

`eminiar swarm sync` (also `em_swarm {action:"sync"}`, the dashboard, and SessionStart when
`sync: auto`) writes `.claude/agents/swarm-<swarm>-<role>.md`:

```markdown
---
name: swarm-feature-coder
description: "eminiar swarm \"feature\" · coder: Implements one task at a time. Spawned by the em-swarm skill."
model: sonnet
tools: Read, Edit, Write, Bash, mcp__plugin_eminiar_eminiar__em_swarm, …   # only when the YAML lists tools
skills: [...]
hooks: {...}
---
<!-- eminiar:swarm swarm=feature role=coder hash=<sha1 of the role spec>. Generated from .eminiar/swarm.yaml; edit the YAML, not this file. -->

You are the **coder** worker in the eminiar swarm "feature" …role prompt…
## Swarm protocol …claim, report, share, eminiar knowledge…
```

- Frontmatter is emitted with the `yaml` library, never by string concatenation.
- When the YAML gives a `tools` allowlist, the eminiar tools (`em_swarm`, `em_recall`,
  `em_search`, `em_symbols`, `em_history`, `em_execute`, …) are appended under both MCP name
  forms (`mcp__plugin_eminiar_eminiar__*` for plugin installs, `mcp__eminiar__*` for settings
  installs). Without em_* tools a worker would be stranded by enforce-mode routing.
- Sync only rewrites or deletes files carrying the `eminiar:swarm` marker. A hand-written file
  with the same name is reported as a conflict and left alone.

## Runtime: runs, tasks, agents, blackboard

Tables (migration 7, project database):

- `swarm_runs(id, swarm, goal, status active|done|failed|cancelled, topology, session_id, created_at, updated_at, ended_at, summary)`
- `swarm_tasks(id, run_id, title, detail, role, status pending|active|done|failed|blocked, agent_id, deps JSON, files JSON, result, auto_closed, created_by, created_at, updated_at)`
- `swarm_agents(run_id, agent_id, agent_type, role, status running|done|stale, task_id, prompt, spawned_at, last_ts, ended_at, tool_calls, last_tool, summary)`
- `swarm_events(id, run_id, ts, agent_id, role, kind, task_id, text, payload JSON)`
- `swarm_notes(run_id, key, value, author, ts, version)`: the shared blackboard
- `swarm_spawns(id, run_id, session_id, agent_type, prompt, task_id, ts, consumed)`: spawn reservations

Rules:

- **Run resolution.** Calls name a run or use the newest active run (of the swarm, preferring
  the caller's session). A worker spawned with no active run gets an ad-hoc run so its
  activity is never lost.
- **Claiming** is atomic (`UPDATE … WHERE status='pending'` inside an immediate transaction).
  A task is eligible when its deps are done and the topology allows it:
  - *hierarchical*: the task's role must be the claimer's role (a task with no role fits anyone);
  - *mesh*: any worker may claim any task; its own role is preferred;
  - *pipeline*: the role's stage must be the earliest stage with unfinished tasks.
- **Capacity.** PreToolUse on `Agent` for a swarm agent counts running workers plus unconsumed
  spawn reservations (younger than 2 minutes) in one immediate transaction. Over `max_agents`
  or the role's `count`, the spawn is denied with the reason. Workers with no activity for 30
  minutes are treated as stale and stop counting.
- **Task hand-off.** If the spawn prompt names `task #N`, SubagentStart claims it for the new
  worker and puts the task in its brief.
- **Stop.** SubagentStop marks the worker done and stores its last message. A task it still
  holds is closed as done with `auto_closed=1` and the message as result; the dashboard and
  `status` flag it so the coordinator can reopen it.
- **Finish.** `finish` closes the run; with `remember: true` it writes an eminiar memory
  `swarm/run-<date>-<slug>` (kind `note`) with the goal, outcome and task results, so the
  knowledge outlives the run and is committed with the code.

## Knowledge awareness

`src/swarm/brief.ts` builds two budgeted briefs from existing eminiar pieces:

- **Coordinator brief** (`em_swarm start`): playbook for the topology, the role table
  (subagent_type, model, count, description), memories matching the goal
  (`recallForText`), history lessons and bug-prone files (`readBriefSummary`,
  `readFileRisk`), the project brief (`renderProjectBrief`) and hot files.
- **Worker brief** (SubagentStart, `claim`): who it is, the run goal, its task (or the open
  tasks for its role), blackboard keys, memories matching role + goal + task plus memories
  tagged with the role's `memory_tags`, history risk of the task's files or the role's scope,
  hot files in scope, and pointers to `em_recall`, `em_history`, `em_symbols`,
  `em_graph_impact`.

## `em_swarm` tool

One tool, actions in the style of `em_memory`:

| action | who | does |
|---|---|---|
| `list` | anyone | swarms, roles, agent names, validation errors, active runs |
| `start {swarm, goal}` | coordinator | opens a run, returns the coordinator brief |
| `plan {tasks:[{key?, title, detail?, role?, deps?, files?}]}` | anyone | adds tasks; `deps` are task ids or keys from the same call |
| `claim {task?}` | worker | claims a task (or the next eligible one) and returns its brief |
| `update {task, status, result?}` | worker or coordinator | reports done, failed, blocked, or reopens (pending) |
| `post {key, value}` / `read {key?}` | anyone | shared blackboard |
| `status {run?}` | anyone | tasks by status, workers, recent events, blackboard keys |
| `finish {status, summary, remember?}` | coordinator | closes the run |
| `sync` | anyone | regenerates agent files |

The PreToolUse hook stamps `caller_agent_id` / `caller_agent_type` into `em_swarm` calls made
by a subagent; without them the caller is the coordinator.

## Hooks

| Event | Swarm work |
|---|---|
| SessionStart | when opted in: auto-sync agent files, one context line naming the swarms and any active run |
| PreToolUse `Agent` | capacity check and spawn reservation for swarm agents (then normal routing) |
| PreToolUse `em_swarm` | stamp the caller's `agent_id` / `agent_type` |
| SubagentStart (new) | register the worker, hand off `task #N`, inject the worker brief |
| PostToolUse / Failure | record the worker's tool activity (async hook) |
| SubagentStop | close the worker, auto-close its task, record the result |

`hooks/hooks.json` gains a `SubagentStart` entry and `mcp__.*__em_swarm` in the PreToolUse
matcher. Hook paths stay non-blocking and never throw.

## Skill

`skills/em-swarm/SKILL.md` (`/eminiar:em-swarm <swarm> <goal>`) is the coordinator playbook:
start the run, read the brief, plan tasks, spawn workers with `subagent_type:
swarm-<swarm>-<role>` (background for parallel work, naming `task #N` in each prompt), watch
`status`, review results (run the reviewer role adversarially when configured), reopen or
add tasks, then `finish` with `remember: true` and record durable decisions with
`em_remember`.

## Dashboard: Swarms tab

Layout inspired by ruflo's swarm monitor, drawn in eminiar's existing grey/blue tokens:

- **Left rail**: configured swarms (topology glyph, role chips, sync state, validation errors)
  and runs (status dot, goal, age).
- **Header strip**: stat tiles for workers running, tasks done/total, tool calls, elapsed time.
- **Topology canvas** (SVG): the coordinator hub with workers by role, laid out per topology
  (star for hierarchical, ring with peer links for mesh, left-to-right lanes for pipeline).
  Running workers pulse; edges light up for recent claims, posts and reports.
- **Task board**: pending, active, done, failed/blocked columns.
- **Activity feed**: monospace event log with role colour chips, newest first.
- **Blackboard**: shared keys and values.
- **Not opted in**: explanation, starter YAML preview and a create button.

API: `GET /api/swarm`, `GET /api/swarm/run?id=`, `GET /api/swarm/events?id=&after=`,
`POST /api/swarm/init`, `POST /api/swarm/sync`, `POST /api/swarm/finish`. Writes go through the
existing loopback-origin and JSON content-type checks. The view polls every 2 s while a run
is active and the tab is visible.

## CLI

`eminiar swarm init [--force] | validate | sync | list | status [run] | runs`.

## Work plan

1. Foundation (lead): types, YAML schema and loader, agent generation, migration and store,
   runtime rules, briefs, unit tests.
2. In parallel (subagents, disjoint files): (a) hooks, `hooks.json`, SessionStart, skill;
   (b) `em_swarm` tool, CLI, docs; (c) dashboard API and view.
3. Adversarial review per feature area: config and generation; runtime and tool; hooks;
   dashboard. Fix every confirmed finding.
4. Build, typecheck, lint, tests, run the dashboard, version bump to 0.11.0, memories, PR.
