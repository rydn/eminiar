# Configuration

[← Docs index](README.md)

## Where settings come from

eminiar merges four layers. A later layer overrides an earlier one.

| Order | Source | Use for |
|---|---|---|
| 1 | Built-in defaults | — |
| 2 | `~/.eminiar/config.json` | Your personal settings |
| 3 | `<project>/eminiar.config.json` | Team settings. **Commit this file** |
| 4 | `EMINIAR_*` environment variables | One-off overrides |

`eminiar.config.schema.json` is the JSON Schema for every key. The file written by
`eminiar install --team` already points to it, so your editor completes and checks the keys:

```json
{ "$schema": "https://raw.githubusercontent.com/rydn/eminiar/main/eminiar.config.schema.json" }
```

## Example

```json
{
  "routing": { "mode": "enforce" },
  "sandbox": { "timeoutMs": 120000, "envAllow": ["MY_API_TOKEN"] },
  "graph": { "exclude": ["**/generated/**"] },
  "recall": { "maxMemories": 5 },
  "docs": { "crawl": { "maxPages": 20 } }
}
```

## All keys

### `routing`

| Key | Default | Description |
|---|---|---|
| `mode` | `"auto"` | `auto`, `enforce`, `annotate` or `off`. See [Routing](how-it-works.md#routing) |
| `deferToContextMode` | `true` | In `auto`, only annotate while the context-mode plugin is installed |

### `sandbox`

| Key | Default | Description |
|---|---|---|
| `timeoutMs` | `60000` | Time limit for one run |
| `maxOutputBytes` | `2097152` (2 MB) | Output cap per run |
| `indexThreshold` | `5120` (5 KB) | Output larger than this is indexed, and only matching sections return |
| `envAllow` | `[]` | Extra environment variable names to pass to the sandbox |
| `disabledLanguages` | `[]` | Languages to turn off, for example `["php"]` |

### `search`

| Key | Default | Description |
|---|---|---|
| `defaultLimit` | `5` | Results per query |
| `defaultMaxTokens` | `2000` | Size limit of a search answer |

### `embeddings`

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Use semantic search. `false` keeps search lexical only |
| `model` | `"Xenova/bge-small-en-v1.5"` | ONNX embedding model |
| `dims` | `384` | Vector dimensions of the model |

### `graph`

| Key | Default | Description |
|---|---|---|
| `include` | `**/*.{ts,tsx,js,jsx,mjs,cjs,py,go}` | Files to parse |
| `exclude` | `node_modules`, `dist`, `build`, `.git`, `coverage`, `*.d.ts`, virtualenvs, `__pycache__`, `site-packages`, `vendor`, `*.min.js` | Files to skip |

### `git`

| Key | Default | Description |
|---|---|---|
| `maxCommits` | `3000` | How many commits the history and co-change analysis read |

### `index`

| Key | Default | Description |
|---|---|---|
| `docs` | `["**/*.md", "**/*.mdx"]` | Project markdown to index for search |

### `permissions`

| Key | Default | Description |
|---|---|---|
| `extraDeny` | `[]` | Extra Bash deny rules for the sandbox, in addition to Claude Code's `permissions.deny` |

### `code`

| Key | Default | Description |
|---|---|---|
| `backend` | `"tree-sitter"` | Code parser backend |

### `memories`

| Key | Default | Description |
|---|---|---|
| `dir` | `".eminiar/memories"` | Where memory files live, relative to the project root |

### `recall`

| Key | Default | Description |
|---|---|---|
| `onPrompt` | `true` | Attach matching memories and docs to each prompt |
| `onFile` | `true` | Attach memories, fix history and dependent-file count before a file read or edit |
| `onAgent` | `true` | Add the brief and matching knowledge to subagent prompts |
| `onCommit` | `true` | List risky files before `git commit` |
| `onError` | `true` | Attach earlier occurrences of a failed call's error |
| `onWeb` | `true` | Attach indexed doc pages before `WebSearch` / `WebFetch` |
| `maxMemories` | `3` | Memories per prompt |
| `maxDocs` | `2` | Doc pages per prompt |

### `docs`

| Key | Default | Description |
|---|---|---|
| `manifest` | `".eminiar/docs.json"` | The documentation sources manifest |
| `ttlHours` | `168` (7 days) | Page cache lifetime |
| `crawl.depth` | `1` | Link depth for dependency docs |
| `crawl.maxPages` | `8` | Pages per dependency source |
| `crawl.maxPageBytes` | `122880` (120 KB) | Page size cap |
| `crawl.api.depth` | `2` | Link depth for external API docs |
| `crawl.api.maxPages` | `150` | Pages per external API source |
| `embed` | `false` | Also embed documentation for semantic search |
| `discover.includeDev` | `false` | Include dev dependencies in discovery |
| `discover.subprojects` | `true` | Scan one level of sub-projects |
| `catalog` | `[]` | Extra catalogue entries, each with a `tier`: `service`, `infra` or `library` |

## Environment variables

| Variable | Effect |
|---|---|
| `EMINIAR_ROUTING_MODE` | Overrides `routing.mode` |
| `EMINIAR_EMBEDDINGS=0` | Turns off embeddings |
| `EMINIAR_HOME` | Moves the data directory (default `~/.eminiar`) |
| `EMINIAR_PROJECT_ROOT` | Sets the project root. Otherwise `CLAUDE_PROJECT_DIR`, then the current directory |
| `EMINIAR_DEBUG` | Prints stack traces from the CLI |
