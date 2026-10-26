# Memory and recall

[← Docs index](README.md)

Claude forgets everything between sessions and after a `/compact`. eminiar keeps what matters
as **memory files** in your repository. It gives each memory back to Claude **when it is
relevant**, without Claude having to ask.

## Memory files

`em_remember` writes one markdown file per memory:

```text
.eminiar/memories/<topic>/<name>.md
```

```markdown
---
name: auth/session-tokens
kind: decision
status: accepted            # decisions: proposed | accepted | superseded | deprecated
supersedes: auth/long-lived-tokens
tags: [auth, security]
related: [file:src/auth.ts, sym:src/auth.ts#issueToken]
created: 2026-10-13T15:00:00Z
updated: 2026-10-13T15:04:11Z
---

Tokens rotate every 15 minutes because …
```

| Field | Meaning |
|---|---|
| `kind` | `decision`, `constraint`, `fact`, `preference`, `todo`, `note` or `onboarding` |
| `status` | For decisions only. ADR-style: `proposed`, `accepted`, `superseded`, `deprecated` |
| `supersedes` | The older decision this one replaces. eminiar marks the older one `superseded` |
| `related` | Files (`file:`) and symbols (`sym:`) the memory is about. Used for [file recall](#automatic-recall) |

**The files are the source of truth.** You can edit, move or delete them by hand. The next
memory call imports the changes again. To force it, run `em_reindex {scope: "memories"}`.

**Commit the directory.** Teammates then share the same decisions and constraints.

The dashboard **Memory** tab browses and edits the same files:

![A decision memory in the dashboard, rendered as markdown with its tags and linked files](images/dashboard-memory-dark.webp)

## How memories are used

Each memory file is:

- **indexed** for hybrid search (`em_recall`, `em_search {source: "memory"}`);
- **a graph node** (`memory:<name>`). Its `mentions` edges (one per `related:` entry, with
  `mem:x` resolved to `memory:x`, plus one at lower confidence for every project file the body
  names by path) make `em_graph_impact` list the memories to read before you change a file.
  `mem:<name>` references in the body become `links` edges between memories;
- **listed in the session brief**, if it is an accepted decision, a constraint or a preference.

## Onboarding memories

`/em-onboard` writes five memories under `onboarding/`:

| Memory | Contents |
|---|---|
| `overview` | What the project is and what it is for |
| `structure` | How the source is organised |
| `commands` | How to build, test, lint and run |
| `conventions` | Code style and project rules |
| `documentation` | The documentation sources and where they are |

Until these exist, every session start reminds Claude to write them.

## Automatic recall

Hooks bring the relevant knowledge to Claude at the right moment.

| When | What Claude gets | Prefix |
|---|---|---|
| **Every prompt** | Up to 3 memories and 2 doc pages that share distinctive terms with the prompt, or whose name or tags the prompt uses | `eminiar recall —` |
| **Before a file is read or edited** | Memories about the file: `related` names it or a symbol in it, the body names its path, or the body names one of its symbols (`` `parseFile` ``, `parseFile(`, `Class.method`). Its fix record if it is bug-prone | `eminiar memory:` / `eminiar history:` |
| **Before a file is edited** | Its fan-in if 5 or more files import it | `eminiar graph:` |
| **Before `git commit`** | The bug-prone and widely imported files in the commit | `eminiar history:` |
| **After a failed tool call** | Earlier occurrences of the same error, with how they were resolved, and memories that mention it | `eminiar recall —` |
| **Before `WebSearch` / `WebFetch`** | Indexed doc pages that already cover the query | `eminiar docs:` |
| **When a subagent starts** | The project brief plus the memories and doc pages for its task | (in the prompt) |
| **Session start** | Project brief: overview, accepted decisions, constraints, preferences, hot files | — |

### Rules that keep recall useful

- **Precision over volume.** A prompt must share at least two distinctive terms with a memory
  (three for long prompts). Terms match at word starts (`write` matches `writers`, not
  `capped` for `app`). One shared term is enough when it is a word of the memory's slug or one
  of its tags and the prompt is short enough for that term to be its topic; naming the memory
  (`decision/x`) always matches. Superseded and deprecated memories are skipped.
- **Once per context window, then again.** Each memory, page, file note or past error is shown
  once. After `recall.repeatAfter` prompts (default 10) it may come back when it matches again,
  so knowledge skimmed past early in a long session is not lost. After a `/compact` or a resume,
  the window restarts.
- **Fast.** Hooks never run `git log` and never load the embedding model. Recall is a few FTS
  queries. File history comes from a per-file risk table that is rebuilt when `HEAD` moves.
  Until the first build (the server warm-up or `em_history {action:"overview"}`) the session
  start says so.
- **Every routing mode.** Recall works even with `routing.mode: off`.
- **Measured.** Every decision is recorded, fired or quiet, with the reason each candidate stayed
  out. `em_stats` shows the hit rate per path. From the terminal:

  ```sh
  eminiar recall --explain "why is the pool capped"   # candidate by candidate
  eminiar recall --file src/storage/pool.ts            # what a Read/Edit would attach
  eminiar recall --replay --since 30d                  # re-run past prompts: hit rate, misses
  ```

### Knowledge tools are routed too

In `enforce` mode the same hook that redirects a noisy `Bash` call to `em_execute` redirects
history and symbol questions to the knowledge tools:

| Native call | Redirected to |
|---|---|
| `git log`, `git blame`, `git show <sha>`, `git shortlog` | `em_history` with the matching action (`file`, `commit`, `branch`, `search`, `symbol`, `timeline`, `overview`) |
| `Grep` for an identifier the graph defines | `em_symbols {name_path, mode:"references"}` / `em_search {source:"code"}`; a files-only grep is annotated, a content grep is denied |

See [How it works › Routing](how-it-works.md#routing).

### Tune it

Turn each path on or off in `eminiar.config.json`:

```json
{
  "recall": {
    "onPrompt": true,
    "onFile": true,
    "onAgent": true,
    "onCommit": true,
    "onError": true,
    "onWeb": true,
    "maxMemories": 3,
    "maxDocs": 2,
    "repeatAfter": 10
  }
}
```

## Good memories

A memory is worth writing when the next session would otherwise guess wrong.

| Write | Do not write |
|---|---|
| A decision and **why**, with the rejected option | Code structure the graph already shows |
| A constraint that is not visible in code | The git history of a fix |
| A gotcha and its fix | Notes that only matter in this conversation |

When a change overrides a memory, update the memory, or save a new decision with `supersedes`.
