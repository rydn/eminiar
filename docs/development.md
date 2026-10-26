# Development

[← Docs index](README.md)

## Build and run

```sh
npm install
npm run build             # tsup (node + browser bundles), tree-sitter grammars, config schema
claude --plugin-dir "$PWD"   # run Claude Code with this checkout as the plugin
```

| Script | What it does |
|---|---|
| `npm run build` | Full build |
| `npm run dev` | Rebuild the node bundles on change |
| `npm run dev:ui` | Rebuild the dashboard on change. `eminiar ui` serves `dist/ui` as it is |
| `npm test` | Vitest. `EMINIAR_TEST_EMBED=1` also runs the model test |
| `npm run typecheck` | `tsc` for the node and web projects |
| `npm run lint` / `lint:fix` | Biome |
| `npm run validate` | `claude plugin validate .` |
| `npm run bench` | Hot-path benchmark (see below) |
| `npm run screenshots` | Regenerate the dashboard screenshots in `docs/images` (see below) |

## Project layout

| Path | Contents |
|---|---|
| `bin/` | POSIX `sh` shims: `eminiar`, `em-server`, `em-hook` |
| `hooks/hooks.json`, `hooks/cursor.json` | Hook registration for Claude Code and for Cursor (plugin form) |
| `.claude-plugin/`, `.cursor-plugin/` | Plugin manifests. Both carry the package version (`scripts/sync-plugin-version.mjs`) |
| `rules/` | Cursor project rule copied by `install --team --cursor` |
| `skills/` | The slash commands (`/em-*`) and the `eminiar` skill; also installed as Cursor agent skills |
| `src/server.ts` | MCP server entry |
| `src/hook.ts`, `src/hooks/` | Hook entry and handlers: routing, capture, session start, pre-compact. `dispatch.ts` picks the client dialect; `cursor.ts` translates Cursor's |
| `src/session/` | Session brief, guide and proactive recall |
| `src/tools/` | One file per `em_*` tool |
| `src/sandbox/`, `src/permissions/` | Code execution and permission checks |
| `src/search/`, `src/index/`, `src/chunker/`, `src/embeddings/` | Indexing and hybrid search |
| `src/graph/` | tree-sitter parsers (`languages/`), link pass, metrics, clusters, routes, changes |
| `src/history/` | Commit classification and fix-origin tracing |
| `src/memory/` | Memory files and their mirror in the index |
| `src/docs/` | Documentation discovery, catalogue, crawl and sync |
| `src/storage/` | `adapter.ts` interface. `sqlite/` is the only module with SQL |
| `src/ui/` | Dashboard server. `src/ui/web/` is the Preact app |
| `src/install/` | Installer, registration and doctor |
| `tests/unit/` | Vitest tests, one file per module |

## Conventions

- **Tests use real storage.** Tests build a temporary project and a fresh SQLite database. Do
  not mock storage.
- **SQL stays in `src/storage/sqlite/`.** Everything else goes through `StorageAdapter`, so a
  Postgres or libSQL adapter can be added later.
- **Shims are POSIX `sh`.** The sandbox runs shell under `zsh` on macOS, so quote globs.

## Benchmarks

`em_execute` and `em_batch_execute` are the hot paths. Keep them within about 1 ms of a raw
process spawn, and keep server start-up light.

```sh
npm run build && npm run bench    # drives dist/server.js over stdio, like Claude Code
```

- Run the benchmark **alone**, not at the same time as tests.
- Compare before and after: build `origin/main` and your branch, and run both.

## Releasing

The package is published to npm as [`eminiar`](https://www.npmjs.com/package/eminiar) by
`.github/workflows/publish.yml`. Every push to `main` (a merged PR) publishes the version in
`package.json` if npm does not have it yet, then tags it `v<version>` and creates a GitHub
release with generated notes. A merge without a version bump publishes nothing.

1. In the PR, bump the version:

   ```sh
   npm version patch --no-git-tag-version    # or minor / major
   ```

   The `version` script copies the new version into `.claude-plugin/plugin.json` and
   `.cursor-plugin/plugin.json`. Claude Code names its plugin cache directory after it, and CI
   fails if the manifests differ from `package.json`.
2. Merge the PR. The workflow builds, typechecks, lints, tests, runs
   `npm publish --provenance --access public`, and creates the tag and release.

**One-time setup:** create a granular npm access token with publish rights for `eminiar` (it must
bypass 2FA), and add it as the `NPM_TOKEN` repository secret (Settings → Secrets and variables →
Actions). Without the secret the workflow skips publishing and logs a warning.

To publish by hand instead: `npm login`, then `npm publish --access public` from a clean
checkout. `prepack` runs the build. Check the tarball first with `npm pack --dry-run`.

## Screenshots

The images in `docs/images` are captured from a live dashboard. Regenerate them after a UI
change:

```sh
npm run build
eminiar ui --port 7341 --no-open &              # this project, in another terminal
npm run screenshots                             # all of them
npm run screenshots -- galaxy history           # only some
```

- The script drives headless Chrome through the DevTools Protocol. It needs no extra
  dependencies. Set `CHROME=/path/to/chrome` if Chrome is not found.
- Home directories (`/Users/<name>`, `/home/<name>`) are replaced with `~` before each capture.
  **Check the images before you commit them.**
- Output is WebP at 1.5× scale (2160 px wide), about 100–250 KB per image.
- The views, routes and clicks are listed in `SHOTS` at the top of
  `scripts/capture-screenshots.mjs`.
