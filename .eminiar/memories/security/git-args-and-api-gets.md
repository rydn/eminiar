---
name: security/git-args-and-api-gets
kind: constraint
tags: [security, git, dashboard]
related: [file:src/graph/changes.ts, file:src/ui/server.ts, file:src/tools/em_graph_changes.ts, file:src/ui/web/views/Docs.tsx]
created: 2026-11-08T15:30:00.000Z
updated: 2026-11-08T15:30:00.000Z
---

Any value that reaches git from a caller (the model through an em_* tool, or a dashboard query string) must never be read as an option. `git diff --output=<file>` truncates <file> and writes the diff into it, inside or outside the repo, so a ref such as `--output=/Users/x/.zshrc` was an arbitrary file overwrite. `detectChanges` now refuses a ref that `isDiffRef` rejects (leading `-`, control characters, over 256 chars; spaces are fine, as in `main@{2 weeks ago}`, because the ref is one argument with no shell), passes it after `--end-of-options` (git 2.24+, defence in depth: git then refuses an option there instead of reading it) and adds `--no-textconv`, so a repo's diff drivers never run. Paths already go after `--`. History tools resolve a sha against the commit model before git sees it, so they need no guard.

Dashboard: every `/api/` request, GET included, must come from the dashboard itself. Some GETs do work (`?root=` opens a project database, `/api/changes` runs git), and any web page can send a GET with an `<img>` or a no-cors fetch. `originAllowed` refuses `Sec-Fetch-Site` other than `same-origin`/`none` and a foreign `Origin` on API calls of every method; pages themselves can still be opened from a link. `doctor --fix` moved from `GET /api/doctor?fix=1` to `POST /api/doctor {fix:true}`, so it needs the JSON content type even in a browser that sends no `Sec-Fetch-Site`. Seed URLs in the Docs tab come from `.eminiar/docs.json` or the catalog, so they go through `classifyHref` and only web and mailto links are clickable.

Open follow-up: browsers that send no `Sec-Fetch-Site` (Safari before 16.4) can still make no-cors GETs, and `?root=` accepts any folder (it opens or creates a database and, for `/api/changes`, runs git there). Accepting `?root=` only for folders `/api/projects` lists, or requiring a custom request header on every API call, would close that.

Framing headers (`X-Frame-Options`, CSP `frame-ancestors`) were left out on purpose: they would break opening the dashboard in an editor's embedded browser, and a loopback page has little to gain.
