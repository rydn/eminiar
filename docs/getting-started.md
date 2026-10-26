# Getting started

[← Docs index](README.md)

## Requirements

- Node.js **22.12 or later**
- Claude Code (terminal, desktop app or IDE extension), Cursor, or both
- macOS or Linux. The `bin/` shims are POSIX `sh`.

Optional: Python, Ruby, Go, PHP, Perl, R, Elixir, Rust or .NET. The sandbox finds them on your
`PATH` and enables each language it finds.

## Install

```sh
npx eminiar install
```

The installer does these steps in order:

| Step | What it does |
|---|---|
| **node** | Pins the Node.js binary, so Claude Code always starts eminiar with a supported version |
| **stable copy** | Installs eminiar under `~/.eminiar/plugin/`, so it does not depend on the `npx` cache |
| **native modules** | Checks `better-sqlite3`, FTS5 and `sqlite-vec` |
| **data directory** | Creates `~/.eminiar/` |
| **embedding model** | Downloads `bge-small-en-v1.5` (about 35 MB, one time). Skip with `--no-model` |
| **register** | Registers the plugin with Claude Code (`--method plugin`). If the `claude` CLI is not available, it writes your settings file instead (`--method settings`) |
| **doctor** | Runs every health check |

The installer asks before it changes your user-level Claude Code config. Add `--yes` to accept
without a prompt. Add `--statusline` to also install the [status line](#status-line).

The rest of the docs write commands as `eminiar <command>`. Run them as `npx eminiar <command>`,
or install the CLI globally once with `npm install -g eminiar`.

### Cursor

```sh
npx eminiar install --cursor
```

One flag adds Cursor. The same stable copy serves both clients, so the index, memories and graph
are shared. The **register** step then also writes:

| File | Contents |
|---|---|
| `~/.cursor/hooks.json` | eminiar's hook entries on nine events (other hooks are kept) |
| `~/.cursor/mcp.json` | the `eminiar` MCP server |
| `~/.cursor/skills/em-*` | the `em-*` skills |

If the `claude` CLI is not on your `PATH`, `--cursor` installs for Cursor only. With both present,
one run registers both. Restart Cursor (or **Developer: Reload Window**) afterwards; the agent
gets the routing guidance and project brief at the start of every conversation, and `em_*` tools
appear under **Settings → MCP**.

Cursor imports Claude Code hooks from `~/.claude/settings.json` by default (**Settings → Agents →
Third-Party Imports**). That only matters when Claude Code was registered with `--method settings`:
each event would fire twice. `eminiar doctor` warns about it; turn the setting off or reinstall
Claude Code with `--method plugin`.

What differs in Cursor is listed in [How it works](how-it-works.md#cursor).

### Verify

```sh
npx eminiar doctor
```

`doctor` checks Node.js, SQLite FTS5, `sqlite-vec`, the embedding model, the sandbox languages,
the routing mode, coexistence with context-mode and the project root. Add `--fix` to repair the
pinned paths. Inside Claude Code, `/em-doctor` runs the same checks.

Restart Claude Code after you install.

## First steps in a project

1. **Onboard the project.** In Claude Code, run:

   ```text
   /em-onboard
   ```

   Claude writes five onboarding memories (`overview`, `structure`, `commands`, `conventions`,
   `documentation`) under `.eminiar/memories/onboarding/`. It also builds the
   [documentation knowledge base](documentation-kb.md). Every later session starts with this
   knowledge.

2. **Work as usual.** The hooks route noisy commands to the sandbox and attach relevant memories,
   history and graph notes. You do not have to change how you prompt.

3. **Look at the results.**

   ```text
   /em-stats                 # tokens kept out of context
   ```

   ```sh
   eminiar ui                # the local dashboard
   ```

   ![The dashboard Overview: tokens saved per day and per tool](images/dashboard-overview-dark.webp)

## Team setup

eminiar stores shared knowledge in your repository, so a team gets the same memories and
documentation sources.

**One person, once:**

```sh
npx eminiar install --team
git add eminiar.config.json .eminiar/
git commit -m "Add eminiar team config"
```

`--team` writes `eminiar.config.json` with the team defaults. Add `--cursor` to also write
`.cursor/rules/eminiar.mdc`, a project rule that keeps Cursor's agent aware of the `em_*` tools.

To make Claude Code prompt teammates to install the plugin, add a marketplace:

```sh
npx eminiar install --team --marketplace github:org/repo
```

This also writes the marketplace and `enabledPlugins` entries to the project's
`.claude/settings.json`.

**Each teammate:**

```sh
npx eminiar install            # add --cursor for Cursor
```

The installer reads the committed `eminiar.config.json`.

### What to commit

| Path | Commit? | Contents |
|---|---|---|
| `eminiar.config.json` | Yes | Team configuration |
| `.eminiar/memories/` | Yes | Memory files (markdown) |
| `.eminiar/docs.json` | Yes | Documentation sources manifest |
| `.cursor/rules/eminiar.mdc` | Yes | Cursor project rule (written by `--team --cursor`) |
| `~/.eminiar/` | No | The local database, model and stable copy (outside the repo) |

## Status line

Add this to `~/.claude/settings.json`, or pass `--statusline` to `install`:

```json
{ "statusLine": { "type": "command", "command": "eminiar statusline" } }
```

It shows: `eminiar · 12.3k saved · 1.1M lifetime · 87% efficient`.

## Upgrade

```sh
eminiar upgrade
```

This installs the latest version, re-registers the plugin and refreshes Claude Code's cached copy.
A Cursor registration is repeated too, so its config files point at the new copy.

## Uninstall

```sh
eminiar uninstall               # keeps your data in ~/.eminiar
eminiar uninstall --purge-data  # also deletes ~/.eminiar
```

This removes only the entries eminiar wrote, in Claude Code and in Cursor. Memory files in your
repositories are not deleted.

## Migrate from context-mode

eminiar started as a clean-room reimplementation of the context-mode plugin. Both can be
installed at the same time. While context-mode is installed, eminiar only *annotates* tool calls,
so the two plugins never block each other (see [routing](how-it-works.md#routing)).

When you are satisfied with eminiar, remove context-mode:

```sh
eminiar replace-context-mode
```

This removes the context-mode plugin and its hooks. eminiar then switches to `enforce` routing.
It does not change a hosted gateway environment. That is a separate, explicit choice.
