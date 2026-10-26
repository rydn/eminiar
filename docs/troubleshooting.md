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
`~/.claude/plugins/cache/eminiar/eminiar/<version>`. That copy has `dist/` but no
`node_modules/`. The `bin/` shims handle this: when their own directory cannot load the
dependencies, they run the stable copy pinned in `~/.eminiar/root-path`. Installs before 0.1.1
did not write this pin.

**Fix:**

```sh
npx eminiar install      # or: eminiar upgrade (re-pins and refreshes the cache copy)
eminiar doctor --fix     # re-pins and clears Claude Code's cached launch failure
```

Then restart Claude Code. `eminiar doctor` tests every cached copy with `bin/em-server --probe`.
It also reports a cached failure and the time it expires.

## Claude keeps getting "Retry with em_execute"

This is `enforce` routing at work. A command that usually prints a lot was redirected to the
sandbox, which returns only the matching output. Claude should retry with `em_execute`.

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

## Start over for one project

```sh
eminiar purge all --yes
```

This deletes the project's database: index, sessions and graph. Memory files in your repository
stay, and the next memory call imports them again.
