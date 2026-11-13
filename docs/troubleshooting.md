# Troubleshooting

[← Docs index](README.md)

Start with the doctor. It checks every part and tells you what to fix.

```sh
eminiar doctor          # or /em-doctor inside Claude Code
eminiar doctor --fix    # repairs pinned paths and clears cached launch failures
```

## "The eminiar plugin server did not connect this session"

**Symptom:** the message says *"retries in about 15 minutes"*. It happens most often in the
Claude Code desktop app, while the terminal works.

**Cause:** Claude Code starts plugins from a copy under
`~/.claude/plugins/cache/eminiar/eminiar/<version>` (under `CLAUDE_CONFIG_DIR` when that is
set). That copy has `dist/` but no `node_modules/`, or, when it came from the GitHub
marketplace, `node_modules/` but no `dist/`. The `bin/` shims handle this: when their own
directory has no built `dist/` or cannot load the dependencies, they run the stable copy pinned
in `~/.eminiar/root-path`. Installs before 0.1.1 did not write this pin.

**Fix:**

```sh
npx eminiar install      # or: eminiar upgrade (re-pins and refreshes the cache copy)
eminiar doctor --fix     # re-pins and clears Claude Code's cached launch failure
```

Then restart Claude Code. `eminiar doctor` tests every cached copy with `bin/em-server --probe`.
It also reports a cached failure and the time it expires.

**Installed with `--method settings` while `CLAUDE_CONFIG_DIR` was set?** Earlier versions wrote
the MCP server to `~/.claude.json`; it now registers in `$CLAUDE_CONFIG_DIR/.claude.json`, where
Claude Code reads it. Remove the stale `mcpServers.eminiar` from `~/.claude.json` by hand.

## Claude keeps getting "Retry with em_execute"

This is `enforce` routing at work. A command that usually prints a lot was redirected to the
sandbox, which returns only the matching output. Claude should retry with `em_execute`.

Bounded commands are not redirected: a pipe ending in `head`, `tail` or `wc`, `cat` or `grep`
over named files small enough for `Read`, and anything that commits, installs or writes a file.
If a call like that is still denied, `em_stats` shows how often routing intercepts each native
tool and which rule did it, and `~/.eminiar/hook.log` has one line per denial with the command,
so the rule can be reported or tuned. See [Routing](how-it-works.md#routing).

To relax it, set `routing.mode` to `annotate` in `eminiar.config.json`. Routing denies a call
only while the eminiar server runs. If the server is down, the hook only annotates.

## Cursor does not show the em_* tools or run the hooks

Run `eminiar doctor`. The **Cursor** line says whether the hooks and the MCP server are present in
`~/.cursor/`. If either is missing:

```sh
npx eminiar install --cursor
```

Then reload Cursor (**Developer: Reload Window**). The **Hooks** tab under **Customize** lists the
loaded hooks, and the Hooks output channel shows every call and its error, if any.

**Each hook fires twice in Cursor.** Claude Code was registered with `--method settings`, and
Cursor's **Settings → Agents → Third-Party Imports** also runs the hooks from
`~/.claude/settings.json`. Turn that setting off, or reinstall Claude Code with
`npx eminiar install --method plugin`.

**A denied call says to retry with em_execute, but Cursor has no such tool.** The MCP server is
missing from `~/.cursor/mcp.json`. eminiar allows the call when it cannot see the server there, so
this points at a hand-edited file. `npx eminiar install --cursor` restores the entry.

## Search returns only keyword matches

The embedding model is missing or still downloading. Search does not wait for it. Check with
`eminiar doctor`. Run `npx eminiar install` again to download the model, or set
`embeddings.enabled: false` to stay lexical on purpose.

## The graph misses a file or a caller

```text
em_index_status {}
```

This lists skipped and partly parsed files with the reason. Check `graph.include` and
`graph.exclude` in your config, then rebuild:

```sh
eminiar reindex --scope code --full
```

## I edited a memory file by hand

The next memory call imports the change. To force it:

```sh
eminiar reindex --scope memories
```

## `eminiar usage ingest` fails, or the usage figures stop moving

The hooks ingest transcripts best-effort and never block Claude, so a broken ingest shows up
only as stale numbers in `em_usage` / `em_stats`. The first failure of a session is written to
`~/.eminiar/hook.log`, `em_stats` prints a `usage: ingest failed: …` line, and
`eminiar usage ingest` reports the same error on the command line. A message like
`table transcript_files has no column named head_hash` means the project database is behind the
schema the code expects; opening it with a current version migrates it in place. If the error
persists, `eminiar purge usage --yes` followed by `eminiar usage ingest` rebuilds the usage tables
from the transcripts.

## "UserPromptSubmit hook timed out after 5s — output discarded"

Claude Code stops a hook at its `timeout` and drops what it wrote. In 0.13.4 to 0.14.x the
usual cause was prompt recall on a large project database. Its FTS queries scanned the whole
chunk index, captured command output and code included, and with a cold page cache they took
4 to 14 s. The soft deadline could not interrupt them, so `hook.log` stayed empty. Since this
fix, recall reads a small recall index of memories, docs and past errors (see
[Hooks](how-it-works.md#hooks)). On a database from an older version the index starts empty:
opening it, in a hook or anywhere else, only creates the index. The eminiar MCP server then
fills it in the background after it starts, in short slices that leave the database free for
hooks between them, and `eminiar reindex` fills it too. The hooks nobody waits on (`Stop`,
`SessionEnd`, `PreCompact` and `SubagentStop`, never the prompt or tool hooks) also add a few
slices each time they run, at most 300 ms of them. This is a one-time warm-up. Until it
finishes, prompt, brief and error recall show nothing, and they never fall back to the slow
query. A fill stopped part-way picks up where it left off.

If recall stays quiet after an upgrade, `eminiar recall --explain "<prompt>"` and
`eminiar doctor` say `recall index still filling (after document N)` while the fill is pending.
Two setups leave the fill to the hooks alone, so it takes several turns:

- An in-place `eminiar upgrade` while sessions run. The next hook runs the new code and
  upgrades the database, but each running session's MCP server is still the old build, which
  does not fill the index. Run `/mcp` and reconnect eminiar (or start a new session) to get the
  new server, or run `eminiar reindex` to fill it at once.
- No eminiar MCP server at all: hooks-only or CLI use, or Cursor without `em-server` in
  `~/.cursor/mcp.json`. Run `eminiar reindex` once.

The prompt hook also runs as
`bin/em-hook --deadline 4`, which stops node at 4 s. The prompt then goes on without eminiar
context, and `~/.eminiar/hook.log` gets a line
`<time> error UserPromptSubmit: em-hook stopped node at the 4 s deadline; the prompt went on without eminiar context`.
The plugin's `hooks/hooks.json` carries the flag. If you installed with the settings method
(hooks in `~/.claude/settings.json`), run `eminiar install` again: it replaces the old
`UserPromptSubmit` entry with the `--deadline 4` one instead of adding a second. Going back to
an older eminiar with the settings method does not recognise the `--deadline 4` entry: it keeps
it and adds its own, so the prompt hook runs twice until you delete one of them from
`~/.claude/settings.json`.

The message can also appear when many
processes write to one project database at once, for example while an agent swarm runs: each
SQLite statement used to wait up to 2 s for the write lock, and a handler runs several of them.
Hooks now wait a limited time per statement (250 ms for the prompt hook and other read-only
hooks, 1500 to 2000 ms for hooks whose job is a write; Cursor's hooks wait as the Claude Code
event they map to) and answer within a time budget (see [Hooks](how-it-works.md#hooks)). A
busy database costs the prompt, `SessionStart` and `PostToolUseFailure` hooks their
bookkeeping, not their answer. A write-job hook such as `PostToolUse` or `SubagentStop` that
cannot get the lock in time answers without its write, and `SubagentStart` gives the worker a
short fallback brief. If the message still appears,
`~/.eminiar/hook.log` has a line
`<event>: hook budget of <n> ms exceeded; answered without it` for each run that gave up, and
`database is locked` lines point at the processes holding the lock. A long `eminiar index` or
`eminiar usage ingest` running at the same time is the usual one.

## Start over for one project

```sh
eminiar purge all --yes
```

This deletes the project's database: index, sessions and graph. Memory files in your repository
stay, and the next memory call imports them again.
