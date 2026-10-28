---
name: em-swarm
description: Coordinate an eminiar agent swarm from the main session — start a run of a swarm defined in .eminiar/swarm.yaml, plan small tasks, fan out worker subagents (swarm-<swarm>-<role>) in parallel, watch the task board, review the results and finish the run with a memory. Use when the user asks to run a swarm, use the X swarm, fan out workers, or parallelise a review across roles.
user-invocable: true
argument-hint: <swarm> <goal>
allowed-tools: mcp__plugin_eminiar_eminiar__em_swarm, mcp__plugin_eminiar_eminiar__em_recall, mcp__plugin_eminiar_eminiar__em_history, mcp__plugin_eminiar_eminiar__em_graph_impact, mcp__plugin_eminiar_eminiar__em_architecture, mcp__plugin_eminiar_eminiar__em_symbols, mcp__plugin_eminiar_eminiar__em_remember, Agent
---

Arguments: $ARGUMENTS (first word: the swarm; the rest: the goal)

You are the **coordinator**. Subagents cannot spawn subagents, so only you plan, spawn and
review; workers are leaves that claim tasks and report back through `em_swarm`.

**Use a swarm when** the goal splits into 3 or more pieces of work that can run independently
(separate files or modules), or when you want several reviewers to look at the same change
from different angles at once.

**Skip it when** the change is a single-file edit, a quick fix, or tightly coupled sequential
work where each step needs the previous step's exact output. Do the work directly instead.

## 0. Check the swarm exists

Call `em_swarm {action:"list"}`. If it says swarms are opt-in or disabled, stop and tell the user
how to opt in: `eminiar swarm init` (starter `.eminiar/swarm.yaml` plus generated agents), the
"Create starter swarm.yaml" button on the dashboard's Swarms tab (`eminiar ui`), or writing the
file by hand (https://github.com/rydn/eminiar/blob/main/docs/swarms.md). Do not improvise a swarm with ad-hoc subagents. If the file has
validation errors, show them and stop. If it says the call was not stamped by eminiar's hook,
stop and tell the user to run `eminiar upgrade` (or `eminiar install`) and check `/hooks`:
without the stamp every change is refused. If no swarm was named, pick the one whose description
fits the goal and say which.

## 1. Start the run

`em_swarm {action:"start", swarm, goal}` returns your brief: the topology's rules, the roles with
their `subagent_type`, model and `count`, the capacity (`max_agents`), the swarm's own
instructions, and what eminiar knows (memories, bug-prone files, hot files, project brief).
Read it before planning. Check `em_recall` / `em_architecture` / `em_graph_impact` for anything
the brief leaves open.

If it warns that the swarm already has an active run in this session, either finish the old run
(`em_swarm {action:"finish", run, status:"cancelled"}`) or pass `run` on every later call: while
several runs are active, calls without `run` are refused with the list of runs.

## 2. Plan small tasks

`em_swarm {action:"plan", tasks:[{key, title, detail, role, deps, files}]}`

- One task = what one worker can finish in one go. Name the files it touches in `files`.
- Only those six keys; put anything else in `detail` (other keys are refused).
- `role` must be a role of the swarm. `deps` take task ids or the `key` of an earlier task in the
  same call. Avoid two parallel tasks editing the same file.
- Hierarchical: you assign every task to a role. Mesh: seed tasks; workers claim any.
  Pipeline: a stage opens only when every task of the earlier stages is done. In every topology
  workers may plan follow-up tasks (a reviewer adds fixes for the coder).

## 3. Spawn workers

For each claimable task (the plan reply lists them), call the **Agent** tool with
`subagent_type: "swarm-<swarm>-<role>"` and a prompt that names the task as **"task #N"** plus
anything the worker needs beyond the task text. The worker claims that task itself as its first
step; eminiar briefs it with the project knowledge when it starts and with the task when it
claims.

- Use `run_in_background: true` to run independent tasks in parallel.
- `max_agents` caps the swarm's running workers across all its runs, and `count` caps each role.
  eminiar denies spawns over capacity; if that happens, wait for a worker to finish or release a
  stuck one (step 4).
- Spawn a task only once its deps are done.

## 4. Watch

`em_swarm {action:"status"}` starts with the next step, then shows tasks by status, workers,
blackboard keys and recent events. For long runs, run `eminiar swarm watch` under the
**Monitor** tool. Its first line is `swarm.snapshot` (or `swarm.finished` if the run is already
closed); after that it prints one JSON line per change: `swarm.changed` while work is in flight,
`swarm.idle` when no worker is running and no task is active except ones held by quiet workers
(`stale_held`), which means it is your turn, and `swarm.finished` at the end. Workers' tool calls
never produce a line. Read shared findings with `em_swarm {action:"read"}`. Spawn the next
workers as deps complete.

A task line flagged **holder quiet Nm** belongs to a worker silent for 15 minutes or more,
usually one that crashed. Free it with `em_swarm {action:"release", agent}` (with no `agent`,
every quiet worker is released); the task goes back to pending, so spawn a new worker for it.

## 5. Review

- Read every result. A task flagged **auto-closed** was closed from the worker's last message
  because it never reported: check that the work is really done.
- Reopen unfinished work with `em_swarm {action:"update", task, status:"pending"}` or plan
  follow-up tasks; `blocked` tasks need an answer or a re-plan.
- If the swarm has a reviewer role, run it **last**, on the full diff, as an adversarial
  review. Turn each confirmed finding into a task and repeat until none are left.
- Run the tests yourself before you call the goal met.

## 6. Finish

`em_swarm {action:"finish", status:"done"|"failed"|"cancelled", summary, remember:true}` closes
the run and its running workers, and writes the outcome as a memory (`swarm/run-<date>-<slug>`). Record durable decisions
and constraints the run produced with `em_remember`. Then report to the user: what changed,
which files, what was verified, and anything left open.
