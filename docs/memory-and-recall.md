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
- **a graph node** (`memory:<name>`). Its `mentions` edges make `em_graph_impact` list the
  memories to read before you change a file;
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
| **Every prompt** | Up to 3 memories and 2 doc pages that share distinctive terms with the prompt | `eminiar recall —` |
| **Before a file is read or edited** | Memories whose `related` list names the file or a symbol in it | `eminiar memory:` |
| **Before a file is edited** | Its fix record if it is bug-prone, and how many other files import or use it, if 5 or more | `eminiar history:` / `eminiar graph:` |
| **Before `git commit`** | The bug-prone and widely imported files in the commit | `eminiar history:` |
| **After a failed tool call** | Earlier occurrences of the same error, with how they were resolved, and memories that mention it | `eminiar recall —` |
| **Before `WebSearch` / `WebFetch`** | Indexed doc pages that already cover the query | `eminiar docs:` |
| **When a subagent starts** | The project brief plus the memories and doc pages for its task | (in the prompt) |
| **Session start** | Project brief: overview, accepted decisions, constraints, preferences, hot files | — |

### Rules that keep recall useful

- **Precision over volume.** A prompt must share at least two distinctive terms with a memory
  (three for long prompts). Superseded and deprecated memories are skipped.
- **Once per context window.** Each memory, page, file note or past error is shown once. After a
  `/compact` or a resume, the window restarts, so knowledge that was summarised away can come
  back when it is relevant again.
- **Fast.** Hooks never run `git log` and never load the embedding model. Recall is a few FTS
  queries. File history comes from a per-file risk table that is rebuilt when `HEAD` moves.
- **Every routing mode.** Recall works even with `routing.mode: off`.

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
    "maxDocs": 2
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
