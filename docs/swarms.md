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
[Capacity](#capacity) · [Enforcement](#enforcement) · [Hooks](#hooks) · [The `em_swarm` tool](#the-em_swarm-tool) ·
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
   a prompt that names the task as `task #N`. The worker claims that task itself
   (`em_swarm {action:"claim", task:N}`) as its first step and gets the task brief back.
   Independent tasks run in parallel with `run_in_background: true`.
4. **Watch.** `em_swarm {action:"status"}` shows the next step, the task board, the workers and
   recent events. `eminiar swarm watch` prints one line per change for Claude Code's Monitor
   tool.
5. **Review.** The coordinator reads each result, reopens or adds tasks, and runs the reviewer
   role last on the full diff when the swarm has one.
6. **Finish.** `em_swarm {action:"finish", status:"done", summary, remember:true}` closes the run
   and writes its outcome to a memory named `swarm/run-<date>-<slug>`.

Workers report with `em_swarm {action:"update", task, status, result}` and share findings on a
blackboard with `post` and `read`. When a worker stops without reporting, eminiar closes its task
from the worker's final message and flags it as **auto-closed**, so the coordinator checks it.
When a worker stops with no final message, its task goes back to pending. When a worker goes
quiet for 15 minutes while it holds a task, `status` flags the task; the coordinator frees the
worker with `em_swarm {action:"release", agent}` (or every quiet worker with no `agent`), which
puts its task back to pending.

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
| `enforce` | `false` | `true` denies every subagent that is not a swarm worker. See [Enforcement](#enforcement) |
| `allowed_agents` | `[]` | With `enforce: true`, other agent types that may still run, such as `[statusline-setup]`. Ignored when `enforce` is off. `swarm-*` names are not accepted |
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
| `max_agents` | `4` | Workers of this swarm running at once, counted across all its runs, 1 to 16 |
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
| `count` | `1` | Workers of this role running at once, counted across the swarm's runs, 1 to 8 |
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
| `history` | `true` | Bug-prone files among the task's files (or in the role's scope), each with its fix count and last fix, plus the project's history lesson |
| `structure` | `true` | The project brief |
| `insights` | `true` | Hot files (fan-in × churn) among the task's files or in the role's scope |
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

**Workers are leaves.** Generated files list `Agent` in `disallowedTools` (merged with the role's
`disallowed_tools`), whether or not `enforce` is on, so a worker cannot start subagents: only the
coordinator, the main session, starts workers. The ledger cannot see nested spawns, so they would
not be tracked or capped. A role that lists `Agent` (or `Task`) in its own `tools` keeps it, and
`Agent` is not added to its `disallowedTools`; with `enforce: true` such a nested call is still
denied unless its type is in `allowed_agents`.

Edit the YAML, not the generated files: the next sync overwrites them. Claude Code reads agent
files when a session starts. If a new worker type is missing from the Agent tool, open
`/agents` or restart the session.

## Topologies

A topology is a rule about which worker may claim which task. In every topology a task can be
claimed only when all its `deps` are done, and the coordinator can claim or update any task.

| Topology | Who may claim a task |
|---|---|
| `hierarchical` | A worker of the task's role. A task with no role fits any worker. The coordinator plans the run and assigns roles |
| `mesh` | Any worker. A worker prefers tasks of its own role |
| `pipeline` | A worker of the task's role, and only when every task of the earlier stages is done |

In every topology the coordinator and any worker may `plan` tasks, so a reviewer can add a fix
task for the coder. A worker holds one task at a time. Only the worker that holds a task, or the
coordinator, can update it, and a worker can still report on its task after the run has
finished. Setting a task back to `pending` releases it for any eligible worker. Subagents that
are not swarm workers (Explore, for example) can only `list`, `status`, `read` and `post`.

## What workers know

eminiar briefs each worker when it starts (the `SubagentStart` hook) and again when it claims the
task its prompt names. The brief is built from what eminiar already keeps, so it costs
milliseconds:

- who the worker is, the run goal, and its task with the task's files;
- the blackboard keys other workers have posted and the task counts;
- memories that match the role, goal and task, plus memories tagged with the role's
  `memory_tags`;
- the history risk of the task's files (or the role's `scope`): bug-prone files with their last
  fix, and the project's history lesson;
- hot files in scope and the project brief;
- pointers to `em_recall`, `em_history`, `em_symbols` and `em_graph_impact` for anything else.

The coordinator brief from `start` covers the same ground for the whole swarm. When a run
finishes with `remember: true`, its goal, outcome and task results become a memory, so the next
session knows what the swarm did.

## Capacity

Capacity is per swarm, not per run. When the coordinator spawns a swarm worker, eminiar counts
the swarm's workers running in any of its runs plus the spawns that have not started yet. A
spawn over `max_agents`, or over the role's `count`, is denied with the reason, and Claude Code
shows it to the coordinator. A worker with no activity for 15 minutes counts as stale and no
longer uses a slot.

A worker that crashed without `SubagentStop` keeps its task until something frees it:
`em_swarm {action:"release", agent}` (or `eminiar swarm release`) does it at once; finishing the
run closes its running workers; and when the Claude Code session ends, eminiar closes that
session's workers and puts their tasks back to pending.

If a worker is spawned while no run is active, eminiar opens an ad-hoc run for it, so its
activity is still recorded. An ad-hoc run closes itself once its last worker stopped and no task
is open.

## Enforcement

By default Claude can still spawn any subagent. Set `enforce: true` to make swarms the only way:

```yaml
enforce: true
allowed_agents: [statusline-setup]   # optional
```

eminiar's PreToolUse hook on `Agent` then denies a subagent unless it is a swarm worker
(`swarm-<swarm>-<role>`) **and** a run of its swarm is active. The denial tells Claude which
swarms exist and how to start a run (`em_swarm {action:"start"}`), or to do the work itself.

**What is blocked.** Every dispatch through the `Agent` / `Task` tool: `Explore`, `Plan`,
`general-purpose`, forks, a call with no type, and other plugins' agents. That includes built-in
skills and agents that launch their own through that tool, such as `/statusline`
(`statusline-setup`) and `claude-code-guide`. Allow-list the ones you want in `allowed_agents`; a
listed type skips the swarm check. Swarm workers need no entry. Capacity limits still apply to them.

**What is not covered.** Enforcement hooks the `Agent` / `Task` tool and nothing else. Other
paths that start a subagent do not go through it and are **not** blocked: a skill with
`context: fork` (started through the `Skill` tool, which runs its `agent:` type directly), the
`Workflow` tool, and any other dispatch Claude Code adds outside `Agent` / `Task`. If you need those
closed, deny the tool or skill in your settings permissions.

**Nested calls.** While enforcing, an `Agent` / `Task` call made from inside a subagent is denied
unless its type is listed in `allowed_agents`. Workers cannot start subagents in the first place
(see [Generated agent files](#generated-agent-files)). The no-Node shim cannot read
`allowed_agents`, so there a nested call gets the same denial as a main-session one.

**The run requirement.** A swarm worker is allowed only while a run of its swarm is active. With
no run it is denied and nothing is recorded. Any active run of that swarm counts, including one
from another session, so finish or cancel stale runs.

**Turn it off.** Remove `enforce` or set `enforce: false`. `enabled: false` also turns
enforcement off. `allowed_agents` without `enforce: true` is ignored, so turning enforcement off
never makes the file invalid.

**Scope.** Cursor is not covered. Enforcement, and the SessionStart sentence that announces it,
come only from the session's project directory and its main checkout. That directory is
`CLAUDE_PROJECT_DIR` (Claude Code sets it for every hook command), then `EMINIAR_PROJECT_ROOT`,
then the current directory; `CLAUDE_PROJECT_DIR` comes first because `EMINIAR_PROJECT_ROOT` can be
inherited from an outer session and would otherwise point a nested `claude` session at another
project's file. A repo Claude `cd`s into never turns enforcement on or off. Run tracking is
different: it follows a coordinator that `cd`s into a nested repo by looking at the session root
first, so those spawns are still recorded. A session **started** inside a sub-repo of a workspace
does not see the workspace's file; enforcement does not reach that session. In a
`claude --worktree` session the main checkout's file is used when the worktree has none.

**One ledger.** `em_swarm` calls that name no project are stamped with the session's project
root, so the MCP server and the hooks use the same ledger even in a `claude` started from another
session's shell. An enforcing project can therefore always start the run its denial asks for.

What counts as `enforce: true` when the file cannot be parsed (and in the no-Node shim) is a
line-based reading: a top-level `enforce` key (plain, `"quoted"` or `'quoted'`, spaces before the
colon allowed) with the value `true`, `True` or `TRUE`, optionally followed by a `# comment`, a
BOM or CRLF line ends; `enabled: false` (any of its spellings) switches it off. A quoted
`"true"`, `trueish` or `yes` is not a boolean and does not count. A flow-style or indented whole
document that does not parse is not recognised; one that parses is decided by its parsed value.

### When the check fails

Enforcement fails closed where the hook can see the failure, and only when the file asks for
it. Projects without `enforce: true` are never affected.

| Situation | Result |
|---|---|
| No swarm file, `enforce` off, or `enabled: false` | Not enforced |
| Valid file with `enforce: true` | Enforced |
| Invalid file that sets `enforce: true` (including YAML that does not parse) | Every subagent is denied until the file is fixed |
| Swarm file unreadable | Not enforced (no evidence of opt-in); session start warns |
| Loading the config throws | Denied if the raw file says `enforce: true`, otherwise allowed |
| Database error while checking a swarm worker | Denied (a busy database gets a retry message) |
| The hook throws elsewhere | Denied if the raw file says `enforce: true` |
| No Node.js or no installed copy (`bin/em-hook` shim) | Denied if the raw file says `enforce: true` |
| Hook timeout (5 s) or a crash while loading | **Not covered: the spawn goes ahead** |

The last row is an open gap. Claude Code treats a hook that times out or cannot start as a
non-blocking error. For a hard guarantee, add your own entry to the project's
`.claude/settings.json` (Claude Code 2.1.295 or later). It runs `em-hook --gate`, a decide-only
mode: it applies the same rule as the plugin hook and prints the same denial, but reserves
nothing and writes nothing (the run requirement and capacity stay with the plugin hook, so there
is no double count). Any error in gate mode, including no Node.js or no installed copy, exits 1,
and `"onFailure": "block"` turns that into a blocked call:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(Agent|Task)$",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME/.eminiar/plugin/node_modules/eminiar/bin/em-hook\" --gate",
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

`eminiar install` keeps its runnable copy at `~/.eminiar/plugin/node_modules/eminiar` (under
`$EMINIAR_HOME` when you set it) and `eminiar upgrade` refreshes it in place, so the path
survives upgrades; `eminiar doctor` shows the exact location. eminiar does not ship this entry
in the plugin because a plugin entry applies to every user, including projects that never opted in.

### Claude can edit the file

Claude can edit `.eminiar/swarm.yaml` and set `enforce: false`. The denial texts tell it to ask
you first, but that is a request, not a lock. To stop it, add a permission rule that denies
`Edit(.eminiar/swarm.yaml)` (and `Write` for the same path) in your settings.

## Hooks

Swarms use eminiar's existing hook entries, plus `SubagentStart` and a PreToolUse matcher for
`em_swarm`. With no swarm file, each of these returns after one cheap check. The plugin's hooks
update with the plugin; if you installed eminiar into Claude Code settings with a version older
than 0.12, run `eminiar upgrade` (or `eminiar install`) to get the new entries.

| Event | Swarm work |
|---|---|
| SessionStart | With `sync: auto`, regenerate changed agent files. Add one line naming the swarms and any active run, and a sentence when enforcement is on |
| PreToolUse on `Agent` / `Task` | Check capacity and record the spawn before the worker starts. With `enforce: true`, also deny anything that is not a swarm worker of an active run (see [Enforcement](#enforcement)) |
| PreToolUse on `em_swarm` | Stamp the call with who is calling, signed (see [Who is calling](#who-is-calling)) |
| SubagentStart | Register the worker in its run and inject the worker brief. The worker then claims the task its prompt names |
| PostToolUse / PostToolUseFailure | Record the worker's tool activity for the status board and dashboard |
| SubagentStop | Close the worker, auto-close or release its task, store its final message |
| SessionEnd | Close the session's workers that never got `SubagentStop` and put their tasks back to pending |

## The `em_swarm` tool

| Action | Who | Does |
|---|---|---|
| `list` | anyone | Swarms, roles, agent file state, active runs |
| `start {swarm, goal}` | coordinator | Opens a run and returns the coordinator brief. Syncs missing or outdated agent files first, and warns when the swarm already has an active run in this session |
| `plan {tasks}` | coordinator, workers | Adds tasks: `{key?, title, detail?, role?, deps?, files?}`. `deps` take task ids or keys from the same call. Any other key is an error |
| `claim {task?}` | workers, coordinator | Claims the named task, or the next eligible one, and returns its brief |
| `update {task, status, result?}` | the task's holder, coordinator | `done`, `failed`, `blocked`, or `pending` to reopen |
| `post {key, value}` | coordinator, workers, other subagents | Writes a note to the run's shared blackboard |
| `read {key?}` | anyone | One note, or every key followed by the values |
| `status {run?}` | anyone | The next step, tasks by status, workers, blackboard keys, recent events |
| `finish {status, summary, remember?}` | coordinator | Closes the run as `done`, `failed` or `cancelled` and its running workers; `remember: true` writes the memory |
| `release {agent?, role?}` | coordinator | Frees stuck workers: one by agent id (a prefix is enough), every running worker of a role, or with neither every worker quiet for 15 minutes. Their tasks go back to pending |
| `sync {force?}` | coordinator | Regenerates the agent files. With no file, or `enabled: false`, it removes them. `force: true` also overwrites generated files edited by hand |

A worker can `read` and `status` only runs of its own swarm. Mistakes such as an unknown role or
a task held by another worker come back as a short `em_swarm: …` message, so Claude can correct
the call.

**Which run.** A call that names `run` acts on that run, and a worker's calls go to the run it
joined. `claim` and `update` with a `task` find the run from the task id (ids are unique across
runs). Otherwise the coordinator's changes (`plan`, `claim`, `post`, `finish`, `release`) go to
the one active run started in this Claude Code session. When several are active, or only
another session's, the tool lists them (id, swarm, goal) and asks for `run`. `status` and `read`
show this session's newest active run, else the newest of any session, and name the other
active runs.

### Who is calling

The MCP server cannot see which agent made a call, but eminiar's PreToolUse hook can. It stamps
every `em_swarm` call with the caller (main session or subagent, its agent id and type, and the
session id) and signs the stamp with a per-machine key in `~/.eminiar/swarm.key`. The tool only
trusts stamps that verify, so a model cannot pose as the coordinator or as another worker by
filling in the `caller_*` fields itself. A call without a valid stamp can only `list`, `status`
and `read`. That happens when hooks are disabled, when the hook timed out, or with settings
installed by an eminiar older than 0.12: run `eminiar upgrade` (or `eminiar install`) and check
`/hooks`.

## CLI

```sh
eminiar swarm init [--force]         # write the starter swarm.yaml and generate the agents
eminiar swarm validate               # path:line messages; exit 1 on problems
eminiar swarm sync [--dry-run] [--force]   # regenerate (or remove) .claude/agents/swarm-*.md
eminiar swarm list                   # swarms, roles, agent file state, active runs
eminiar swarm runs [--limit 20]      # past and active runs
eminiar swarm status [run]           # one run in full: the active one, else the latest
eminiar swarm release [--run id] [--agent id] [--role r]   # free stuck workers
eminiar swarm watch [--run id] [--interval 2]
```

`list`, `runs`, `status`, `release`, `validate`, `sync` and `init` accept `--json`. `sync` and
`init` exit 1 when sync leaves a conflict (a hand-written or hand-edited agent file) in place,
in both text and JSON mode. `sync --json` carries a `reason` when there was nothing to sync (no
file, swarms disabled, or an invalid file). `status` prints every task and worker; the
`em_swarm` tool caps the same view for the context window. `release` with neither `--agent` nor
`--role` frees every worker quiet for 15 minutes; with several active runs it needs `--run`.

`watch` polls the run and prints one JSON line only when something changed, then exits when the
run finishes. It is meant for Claude Code's Monitor tool:

```json
{"type":"swarm.changed","run":"20261028-3bb8d8","swarm":"feature","status":"active","tasks":{"pending":2,"active":1,"done":2,"failed":0,"blocked":0},"workers":{"running":2,"done":1,"stale":0},"auto_closed":0,"stale_held":0,"last_event":{"id":41,"kind":"update","who":"coder@c0d3r111","task":2,"text":"done: added the limiter"}}
```

The first line is `swarm.snapshot` with the current state, or `swarm.finished` when the run is
already closed. After that, `swarm.changed` means something moved while work is in flight,
`swarm.idle` means a change left no worker running and no task active except ones held by quiet
workers (`stale_held`), so it is the coordinator's turn, and `swarm.finished` comes once at the
end. A change is a new task or worker count or a new run event (claim, update, post, plan,
worker start or stop, auto-close, denied spawn, finish); workers' tool calls never produce a
line. `last_event` is the newest such event.

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
