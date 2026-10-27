# Agent swarms

[← Docs index](README.md)

An agent swarm splits one goal across several Claude Code subagents that work in parallel. You
declare the swarm in `.eminiar/swarm.yaml`: its roles, their prompts, models, tools, skills and
hooks, and how they coordinate. eminiar turns each role into a Claude Code agent file. The main
Claude Code session leads the run, and every worker starts with what eminiar knows about the
project: memories, git history, code structure and hotspots.

Swarms are **off** unless you opt in.

**Contents:** [Opt in](#opt-in) · [Run a swarm](#run-a-swarm) · [The swarm file](#the-swarm-file)
· [Topologies](#topologies) · [What workers know](#what-workers-know) ·
[Capacity](#capacity) · [Hooks](#hooks) · [The `em_swarm` tool](#the-em_swarm-tool) ·
[CLI](#cli) · [Worktree isolation](#worktree-isolation) · [Security](#security)

## Opt in

Swarms are enabled when `.eminiar/swarm.yaml` (or `.eminiar/swarm.yml`) exists and does not set
`enabled: false`. Without the file, eminiar's swarm hooks return immediately and `em_swarm` only
explains how to opt in.

You can opt in three ways:

- run `eminiar swarm init`. It writes a starter file with two swarms (`feature` and `review`)
  and generates their agent files;
- click "Create starter swarm.yaml" on the Swarms tab of the dashboard (`eminiar ui`);
- write the file yourself, using the reference below.

Commit `.eminiar/swarm.yaml` so your team shares the swarms. The generated agent files in
`.claude/agents/` are rebuilt from it, so committing them is optional.

To switch swarms off again, set `enabled: false` (or delete the file) and run
`eminiar swarm sync`. Sync removes the generated agent files.

## Run a swarm

In Claude Code:

```text
/eminiar:em-swarm feature add rate limiting to the public API
```

The `em-swarm` skill makes the main session the coordinator. Claude Code subagents cannot spawn
subagents, so the main session plans, spawns and reviews, and the workers do the tasks.

1. **Start.** `em_swarm {action:"start", swarm, goal}` opens a run and returns the coordinator
   brief: the topology's rules, the roles and their `subagent_type`, the capacity, and the
   project knowledge that matches the goal.
2. **Plan.** `em_swarm {action:"plan", tasks}` adds small tasks. Each task names a role, the
   files it touches and the tasks it depends on.
3. **Spawn.** The coordinator calls the Agent tool with `subagent_type: swarm-<swarm>-<role>` and
   a prompt that names `task #N`. When the match is unambiguous, eminiar claims that task for
   the new worker; otherwise the worker's brief tells it to claim the task its prompt names.
   Independent tasks run in parallel with `run_in_background: true`.
4. **Watch.** `em_swarm {action:"status"}` shows the task board, the workers and recent events.
   `eminiar swarm watch` prints one line per change for Claude Code's Monitor tool.
5. **Review.** The coordinator reads each result, reopens or adds tasks, and runs the reviewer
   role last on the full diff when the swarm has one.
6. **Finish.** `em_swarm {action:"finish", status:"done", summary, remember:true}` closes the run
   and writes its outcome to a memory named `swarm/run-<date>-<slug>`.

Workers report with `em_swarm {action:"update", task, status, result}` and share findings on a
blackboard with `post` and `read`. When a worker stops without reporting, eminiar closes its task
from the worker's final message and flags it as **auto-closed**, so the coordinator checks it.
When a worker stops with no final message, its task goes back to pending.

## The swarm file

```yaml
# .eminiar/swarm.yaml
version: 1
enabled: true
sync: auto
defaults:
  model: sonnet
  context:
    memories: 4
    max_chars: 4000
swarms:
  feature:
    description: Plan, build, test and review a change.
    topology: hierarchical
    max_agents: 4
    instructions: |
      Keep tasks small enough for one worker.
    agents:
      architect:
        description: Designs the change from the code graph and past decisions.
        model: opus
        disallowed_tools: [Edit, Write, NotebookEdit]
        memory_tags: [decision, constraint]
        prompt: Post the design under the blackboard key "design".
      coder:
        description: Implements one task at a time.
        count: 2
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
        prompt: Find correctness bugs, each with a concrete failing input.
```

Unknown keys are errors, so a typo is reported instead of ignored. Each error names its YAML
path and line, for example `.eminiar/swarm.yaml:23 swarms.feature.agents.coder.count`. Check the
file with `eminiar swarm validate`. While the file is invalid, swarms stay off and sync changes
nothing.

### Top level

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | File format version. Only `1` is accepted |
| `enabled` | `true` | `false` switches swarms off without deleting the file |
| `sync` | `auto` | `auto`: session start regenerates the agent files when they differ from the YAML. `manual`: only `eminiar swarm sync`, `em_swarm {action:"sync"}`, the dashboard and `em_swarm start` write them |
| `defaults.model` | unset | Model for every role that does not set one |
| `defaults.skills` | `[]` | Skills preloaded into every role, before the role's own |
| `defaults.context` | see [context](#context) | What every worker is told at start |
| `swarms` | required | One or more swarms, keyed by name |

Swarm and role names use 1 to 32 characters: lowercase letters, digits and hyphens, starting
with a letter. The agent name `swarm-<swarm>-<role>` must be 64 characters or fewer and unique
across all swarms.

### A swarm

| Key | Default | Meaning |
|---|---|---|
| `description` | required | What the swarm is for (up to 500 characters) |
| `topology` | `hierarchical` | `hierarchical`, `mesh` or `pipeline`. See [Topologies](#topologies) |
| `max_agents` | `4` | Workers running at once in one run, 1 to 16 |
| `stages` | `[]` | Pipeline order of role names; each role at most once. A pipeline without `stages` runs its roles in the order they are declared. Other topologies ignore it |
| `instructions` | `""` | Extra text for the coordinator brief |
| `context` | from `defaults` | Overrides `defaults.context` for this swarm's roles |
| `agents` | required | One or more roles, keyed by role name |

### A role

| Key | Default | Meaning |
|---|---|---|
| `description` | required | What the role does (up to 500 characters). It also goes into the agent file's description |
| `prompt` | `""` | The role's instructions, written into the agent file body |
| `model` | `defaults.model` | `inherit`, `sonnet`, `opus`, `haiku`, `fable` or a full model id. When nothing sets a model, the agent file has no `model` line and Claude Code uses its default for subagents |
| `tools` | unset | Tool allowlist. When set, eminiar adds its own `em_*` tools under both MCP name forms so routing never leaves the worker without them. Unset: the worker gets every tool |
| `disallowed_tools` | unset | Tools the worker cannot use, such as `[Edit, Write, NotebookEdit]` for a read-only reviewer |
| `skills` | `[]` | Skills preloaded into the worker, after `defaults.skills` |
| `hooks` | unset | Hooks scoped to this worker. See [Role hooks](#role-hooks) |
| `scope` | `[]` | Project-relative path globs the role works on (`src/**`, `docs/*.md`). Briefs focus history and hot files on them. No absolute paths or `..` |
| `memory_tags` | `[]` | Memory tags, kinds or topics this role always sees, such as `[decision, constraint]` |
| `count` | `1` | Workers of this role at once, 1 to 8 |
| `isolation` | unset | `worktree` runs the worker in its own git worktree. See [Worktree isolation](#worktree-isolation) |
| `max_turns` | unset | Turn limit for the worker, 1 to 500 |
| `effort` | unset | `low`, `medium`, `high`, `xhigh` or `max` |
| `color` | unset | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan` |
| `context` | from the swarm | Overrides the swarm's context for this role |

### Context

`context` controls the brief a worker gets when it starts. It can be set under `defaults`, a
swarm or a role; the most specific value wins.

| Key | Default | Meaning |
|---|---|---|
| `memories` | `4` | Memories that match the role, goal and task (0 to 10) |
| `docs` | `2` | Documentation sections that match the task (0 to 10) |
| `history` | `true` | Bug-prone files, recent fixes and the project's history lesson, for the task's files or the role's scope |
| `structure` | `true` | The project brief |
| `insights` | `true` | Hot files (fan-in × churn) in the task's files or the role's scope |
| `max_chars` | `4000` | Size budget of the brief, 500 to 20000 characters |

### Role hooks

`hooks` accepts the events `PreToolUse`, `PostToolUse` and `Stop`. Each event takes up to 10
matchers, and each matcher up to 10 commands:

```yaml
hooks:
  PostToolUse:
    - matcher: "Edit|Write"          # optional; omitted matches every tool
      hooks:
        - type: command
          command: "npm run lint --silent"
          timeout: 60                 # optional, seconds, 1 to 600
```

They are copied into the role's agent file. Claude Code runs them only while that worker is
active. Read [Security](#security) before you add one.

### Generated agent files

Sync writes `.claude/agents/swarm-<swarm>-<role>.md` for every role. Each file starts with an
`eminiar:swarm` marker comment. Sync only rewrites or deletes files that carry the marker. If a
hand-written agent file already has the same name, sync reports a conflict and leaves the file
alone; rename the role or the file. A generated file that someone edited by hand is also
reported as a conflict and kept; `eminiar swarm sync --force` overwrites it.

Edit the YAML, not the generated files: the next sync overwrites them. Claude Code reads agent
files when a session starts. If a new worker type is missing from the Agent tool, open
`/agents` or restart the session.

## Topologies

A topology is a rule about which worker may claim which task. In every topology a task can be
claimed only when all its `deps` are done, and the coordinator can claim or update any task.

| Topology | Who may claim a task |
|---|---|
| `hierarchical` | A worker of the task's role. A task with no role fits any worker. The coordinator plans and assigns everything |
| `mesh` | Any worker. A worker prefers tasks of its own role, and workers may add follow-up tasks |
| `pipeline` | A worker of the task's role, and only when every task of the earlier stages is done |

A worker holds one task at a time. Only the worker that holds a task, or the coordinator, can
update it, and a worker can still report on its task after the run has finished. Setting a task
back to `pending` releases it for any eligible worker. Subagents that are not swarm workers
(Explore, for example) can only `list`, `status`, `read` and `post`.

## What workers know

eminiar briefs each worker when it starts (the `SubagentStart` hook) and again when it claims a
task. The brief is built from what eminiar already keeps, so it costs milliseconds:

- who the worker is, the run goal, and its task with the task's files;
- the blackboard keys other workers have posted and the task counts;
- memories that match the role, goal and task, plus memories tagged with the role's
  `memory_tags`;
- the history risk of the task's files (or the role's `scope`): bug-prone files and recent fixes;
- hot files in scope and the project brief;
- pointers to `em_recall`, `em_history`, `em_symbols` and `em_graph_impact` for anything else.

The coordinator brief from `start` covers the same ground for the whole swarm. When a run
finishes with `remember: true`, its goal, outcome and task results become a memory, so the next
session knows what the swarm did.

## Capacity

When the coordinator spawns a swarm worker, eminiar counts the workers already running in the
run plus the spawns that have not started yet. A spawn over `max_agents`, or over the role's
`count`, is denied with the reason, and Claude Code shows it to the coordinator. A worker with no
activity for 30 minutes counts as stale and no longer uses a slot.

If a worker is spawned while no run is active, eminiar opens an ad-hoc run for it, so its
activity is still recorded.

## Hooks

Swarms use eminiar's existing hook entries, plus `SubagentStart`. With no swarm file, each of
these returns after one cheap check.

| Event | Swarm work |
|---|---|
| SessionStart | With `sync: auto`, regenerate changed agent files. Add one line naming the swarms and any active run |
| PreToolUse on `Agent` | Check capacity and record the spawn before the worker starts |
| PreToolUse on `em_swarm` | Tell the tool which worker is calling (the `caller_agent_*` fields) |
| SubagentStart | Register the worker, hand over `task #N`, inject the worker brief |
| PostToolUse / PostToolUseFailure | Record the worker's tool activity for the status board and dashboard |
| SubagentStop | Close the worker, auto-close or release its task, store its final message |

## The `em_swarm` tool

| Action | Who | Does |
|---|---|---|
| `list` | anyone | Swarms, roles, agent file state, active runs |
| `start {swarm, goal}` | coordinator | Opens a run and returns the coordinator brief. Syncs missing or outdated agent files first |
| `plan {tasks}` | anyone | Adds tasks: `{key?, title, detail?, role?, deps?, files?}`. `deps` take task ids or keys from the same call |
| `claim {task?}` | worker | Claims the named task, or the next eligible one, and returns its brief |
| `update {task, status, result?}` | worker or coordinator | `done`, `failed`, `blocked`, or `pending` to reopen |
| `post {key, value}` / `read {key?}` | anyone | The run's shared blackboard |
| `status {run?}` | anyone | Tasks by status, workers, blackboard keys, recent events |
| `finish {status, summary, remember?}` | coordinator | Closes the run as `done`, `failed` or `cancelled`; `remember: true` writes the memory |
| `sync {force?}` | anyone | Regenerates the agent files. With no file, or `enabled: false`, it removes them. `force: true` also overwrites generated files edited by hand |

Calls use the newest active run unless they name `run`; a registered worker resolves to the run
it was spawned for. Mistakes such as an unknown role or a task held by another worker come back as
a short `em_swarm: …` message, so Claude can correct the call.

## CLI

```sh
eminiar swarm init [--force]         # write the starter swarm.yaml and generate the agents
eminiar swarm validate               # path:line messages; exit 1 on problems
eminiar swarm sync [--dry-run] [--force]   # regenerate (or remove) .claude/agents/swarm-*.md
eminiar swarm list                   # swarms, roles, agent file state, active runs
eminiar swarm runs [--limit 20]      # past and active runs
eminiar swarm status [run]           # one run: the active one, else the latest
eminiar swarm watch [--run id] [--interval 2]
```

`list`, `runs`, `status`, `validate`, `sync` and `init` accept `--json`. `sync` and `init` exit 1
when sync leaves a conflict (a hand-written or hand-edited agent file) in place.

`watch` polls the run and prints one JSON line only when something changed, then exits when the
run finishes. It is meant for Claude Code's Monitor tool:

```json
{"type":"swarm.changed","run":"20261028-3bb8d8","swarm":"feature","status":"active","tasks":{"pending":2,"active":1,"done":2,"failed":0,"blocked":0},"workers":{"running":2,"done":1,"stale":0},"auto_closed":0,"last_event":{"id":41,"kind":"update","who":"coder@c0d3r111","task":2,"text":"done: added the limiter"}}
```

`type` is `swarm.snapshot` for the first line, `swarm.changed` while work is in flight,
`swarm.idle` when a change leaves no worker running and no task active (the coordinator's
turn), and `swarm.finished` at the end.

The dashboard's Swarms tab shows the same runs live; see [Dashboard](dashboard.md).

## Worktree isolation

`isolation: worktree` makes Claude Code run the worker in a separate git worktree. Its edits do
not touch your working tree until they are merged, which lets two workers change the same file
without overwriting each other. The coordinator has to review and merge that work. Task `files`
stay project-relative, so briefs and history still apply. The run, the swarm file and the
generated agents belong to the main checkout: eminiar's hooks, `em_swarm` and `eminiar swarm`
map a worktree back to it, so every worker writes to the same task board. Use it for roles that edit code in
parallel; read-only roles such as reviewers do not need it.

## Security

Role `hooks` in `swarm.yaml` become shell commands in the generated agent files. They run with
your permissions, exactly like hooks in a committed `.claude/settings.json`. Review changes to
`swarm.yaml` the way you review changes to `.claude/settings.json`, especially in pull requests
from outside your team. Claude Code ignores frontmatter hooks in folders you have not trusted.

The swarm ledger (runs, tasks, events, blackboard) lives in the project's local SQLite database
under `~/.eminiar/`, like the rest of eminiar's data. Nothing leaves your machine.
