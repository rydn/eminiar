---
name: decision/exec-output-includes-stderr
kind: decision
status: accepted
tags: [sandbox, em_execute, search]
related: [file:src/sandbox/output.ts, file:src/sandbox/run.ts, file:src/sandbox/execute.ts, file:src/tools/em_execute.ts, file:src/tools/em_execute_file.ts, file:src/tools/em_batch_execute.ts, file:tests/unit/exec-output.test.ts, file:tests/unit/sandbox.test.ts, file:docs/tools.md]
created: 2026-11-08T17:00:00.000Z
updated: 2026-11-08T17:00:00.000Z
---

em_execute, em_execute_file and em_batch_execute return and index stderr, not only stdout (branch fix/exec-output-stderr, 2026-11-08; docs/tools.md "What comes back").

- `processOutput` (src/sandbox/output.ts) takes an optional `stderr`. What the model sees is `joinOutput(stdout, stderr)`: stdout, a `--- stderr ---` line, then stderr. The 5 KB threshold and the head/tail preview use that joined text. Indexing makes one document per stream: stdout under the title, stderr under `<title> (stderr)`. Both go through `indexContent` with the tool's source (exec / batch), so index-time redaction in `indexContent` (the privacy PR, not on main when this was written) covers both. Intent and query search, the searchable terms and the `[indexed as docs …]` hint cover both ids. `Processed.documentIds` lists them; batch shows `docs N, M`.
- Why separate documents: `sniffKind` picks json only when the whole content parses, so stdout with any stderr appended (curl's meter, `npm WARN`) went from json chunks (`$[0..14]`) to prose line windows. And precomputed `chunks` would skip `indexContent`'s content redaction.
- `cleanStderr` drops progress frames: text up to a `\r` that is followed by more text on the same line (curl, npm spinners; CRLF kept). Each tool calls it once per run and passes the result to processOutput (`ProcessInput.stderr` is already clean), `describeRun` (so the header's stderr size is what comes back) and its failure tail. The regex is anchored, `/^[^\n]*\r(?=[^\n])/gm` (`^` with `m` also matches after a `\r`): unanchored it was quadratic on a long line with no `\r` (60 KB single-line stderr: 8.9 s em_execute on the server's event loop). tests/unit/exec-output.test.ts keeps it linear on 100 KB (the adjudicator/redact-rules bound). Known loss: a tool that separates lines with a bare `\r` (classic Mac line endings, some device tools) keeps only the last of each run of such lines.
- The marker is not a markdown heading on purpose: a `#` line would make sniffKind chunk the output as markdown.
- `describeRun` adds `N KB stderr` (after cleaning) to the header when stderr is not empty.
- runProcess decodes stderr with `setEncoding("utf8")`, so a character split across pipe chunks is not turned into U+FFFD. It keeps the last `sandbox.maxOutputBytes` characters (was a fixed 8 KB), trimmed only past twice the cap so a chatty stderr stays linear.
- Failure tails: em_execute (2 KB) and em_execute_file add `stderr (tail)` only when the output was indexed AND a search (intent/queries) picked what came back. Without a search the preview's 1 KB tail already ends with stderr. With one, the tail may overlap a search hit. em_batch_execute adds its 800-char tail only when the output is not inlined; an elided batch output has no preview. em_execute's `isError` stays "failed and printed nothing to stdout".
- Why: Jest and many other tools report on stderr. Before, `npm test` with an `intent` searched nothing (stderr was never indexed), a passing run showed no summary (stderr was dropped on exit 0), and a failing run showed only the last 2 KB.
- Exposure: stderr is now stored in the project database and found by em_search and the dashboard, like stdout. `curl -v` headers and `set -x` traces end up there, so this should land after the privacy PR's index-time redaction; until then stderr is stored unredacted, as stdout already was. A small output returned whole and the failure tail are not redacted, the same as stdout and native Bash.
