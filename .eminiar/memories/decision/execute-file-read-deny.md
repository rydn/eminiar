---
name: decision/execute-file-read-deny
kind: decision
tags: [security, permissions, sandbox, routing]
related: [file:src/permissions/settings.ts, file:src/permissions/rules.ts, file:src/sandbox/file.ts, file:src/hooks/routing.ts, file:src/tools/em_execute_file.ts, file:tests/unit/sandbox.test.ts, file:tests/unit/permissions.test.ts, file:tests/unit/hooks.test.ts]
created: 2026-10-24T19:40:00.000Z
updated: 2026-10-24T20:40:00.000Z
---

em_execute_file honours Claude Code's `Read` deny and ask rules for its `path`, not only the project-root boundary (2026-10-24, branch fix/execute-file-read-deny).

- `checkRead` in src/permissions/settings.ts sits next to `checkCommand`: deny first, then ask; ask counts as deny because the sandbox cannot prompt; allow never overrides, as in Claude Code.
- `checkReadPath` checks an existing file as given, its `realpathSync` target and its `realpathSync.native` path. The native one carries the on-disk letter case: `realpathSync` keeps the requested case, so `.ENV` missed `Read(**/.env)` on macOS. Linux casefold folders are not canonicalised by realpath(3).
- `confinePath` checks the path as written before any stat (that spelling of a denied name is refused whether or not it exists), then `checkReadPath`. Containment and the returned path still use `realpathSync`, matching `resolveProjectRoot`.
- Routing uses the same `checkReadPath`: a big `Read` that a Read deny or ask rule matches is not redirected to em_execute_file, which would refuse it. The native Read goes ahead under Claude Code's own permission check.
- `matchRead` caches compiled globs like `bashRegex`, keyed by the `~`-expanded pattern. With 25 rules, em_execute_file's path check costs tens of microseconds per call.
- Not covered:
  - the code passed to em_execute_file or em_execute is checked against Bash rules only and can open other files (`cat .env`);
  - hard links are not detected;
  - `matchRead` does not yet understand Claude Code's relative forms (`./.env`, `.env`, `/x` from the settings file, `//abs`), `?`, `[...]`, or a `/**/` that matches no folder;
  - em_index takes any path with no root or Read check;
  - routing still redirects big Reads outside the root, which em_execute_file refuses;
  - only user, project and local settings are read (no managed settings or `CLAUDE_CONFIG_DIR`).
