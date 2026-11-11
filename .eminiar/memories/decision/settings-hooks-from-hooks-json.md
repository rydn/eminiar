---
name: decision/settings-hooks-from-hooks-json
kind: decision
status: accepted
tags: [install, hooks]
related: [file:src/install/register.ts, file:src/install/replace.ts, file:hooks/hooks.json, file:tests/unit/register.test.ts]
created: 2026-11-08T17:00:00.000Z
updated: 2026-11-08T17:00:00.000Z
---

The settings install method (`eminiar install --method settings`, also the fallback when `claude plugin install` fails) writes the plugin's own hook table, not a copy of it (branch fix/settings-hooks-from-hooks-json, 2026-11-08).

- `settingsHooks(stable)` in src/install/register.ts reads `<stable>/hooks/hooks.json` (materialize already requires that file in the stable copy) and fills `${CLAUDE_PLUGIN_ROOT}` in each command with the stable root. It uses a replacement function, so a `$&` or `$$` in the path stays literal. Any other `${CLAUDE_PLUGIN_…}` variable makes the install throw: the settings method cannot fill it, and a hook with a broken path would fail on every event. `registerSettings` writes the filled table; the event list it records is the table's keys.
- Why: the hand-kept copy had drifted. Its PreToolUse matcher lacked Edit, MultiEdit, Write and WebSearch, so settings installs never got the before-edit memory/history/fan-in notes or the WebSearch doc notes. It also gave six events a 10 s timeout where hooks.json has 5 s (UserPromptSubmit, PreToolUse, PostToolUseFailure, SubagentStop, Stop, SessionEnd). And it made PostToolUseFailure async where hooks.json runs it in line, which is how its answer (earlier occurrences of the error, `recall.onError`) reaches the same turn.
- Removal (`removeOurHooks`, used by both register and unregister): every event in settings.json, one hook at a time, the same way `eminiar replace` removes context-mode (src/install/replace.ts). A hook is ours only when its command is under the stable copy or `/.eminiar/plugin/` (`isOurs`) and runs `bin/em-hook`. So a user's hook that shares an entry with ours stays, and so does a user hook that runs another eminiar binary (e.g. `eminiar stats`). An entry goes only when no hooks are left in it. Sweeping every event means a re-install or upgrade replaces the old registration whole, including on an event hooks.json drops later.
- tests/unit/register.test.ts starts from an old-style registration and compares the result with the repo's hooks/hooks.json, including a stable path with `$&`/`$$`.

**How to apply:** change hooks in hooks/hooks.json only; the settings method follows. Cursor still has its own table (src/install/cursor.ts constants vs hooks/cursor.json); not covered here.
