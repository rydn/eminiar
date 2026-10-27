import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getContext } from "../context.js";
import { DOCS_PREFIX, readManifest } from "../docs/manifest.js";
import { memoriesDir } from "../memory/store.js";
import { renderProjectBrief } from "../session/brief.js";
import { setCurrentSession } from "../session/current.js";
import { renderGuide } from "../session/guide.js";
import { getStorage } from "../storage/index.js";
import { usageBrief } from "../usage/brief.js";
import { ingestUsage } from "./capture.js";
import { effectiveRoutingMode } from "./coexist.js";
import { hookLog } from "./log.js";
import type { HookHandler } from "./types.js";

const MAX_INJECT = 8000;

/** How to use memories and docs; first, so it is not lost under the tool list. */
export const KNOWLEDGE_GUIDANCE = [
  "Project knowledge (check before deciding, not after):",
  '- Before starting a task or changing a design: em_recall {query} for past decisions, constraints, rejected approaches and fixed errors on that topic; em_memory {action:"read", name} shows a whole memory.',
  '- For any library, framework, service or API the project uses: em_docs {action:"lookup", query} first; WebFetch/WebSearch only when the indexed docs do not answer it.',
  '- eminiar also attaches this knowledge on its own; act on it rather than skimming past it: matching memories and doc pages on each prompt ("eminiar recall"), memories linked to a file you read or edit ("eminiar memory"), a file\'s fix record and importers before you edit it ("eminiar history" / "eminiar graph"), bug-prone files before a git commit, earlier occurrences of an error and how they were resolved after a failed call, and indexed doc pages before WebSearch/WebFetch ("eminiar docs"). Update a memory when your change overrides it.',
  "- When you settle something durable (a decision and why, a constraint, a gotcha): em_remember {content, kind, name?} so the next session starts knowing it.",
].join("\n");

export function routingGuidance(mode: string): string {
  return [
    KNOWLEDGE_GUIDANCE,
    "",
    `eminiar is active (routing: ${mode}). Keep raw tool output out of the context window:`,
    "- em_execute {language, code, intent}: run shell/JS/TS/python/… in the project; outputs over 5 KB are indexed and only sections matching `intent` come back, plus searchable terms.",
    "- em_batch_execute {commands:[{label, command}], queries}: several commands in parallel, answers in one round trip.",
    "- em_execute_file {path, code}: process a large file; your code gets $EM_FILE and only what it prints returns.",
    "- em_fetch_and_index {url, queries}: docs and web pages, indexed with a 24h cache.",
    '- em_docs: the documentation knowledge base (local docs plus the libraries, services and APIs the project uses); {action:"discover"} / {action:"add", pick:"recommended"} build it, {action:"sync"} refreshes it.',
    '- em_search {queries, sort:"timeline"}: everything indexed plus session memory.',
    "- em_remember {content, kind, name?, status?}: memories are markdown under .eminiar/memories (survive compaction, shareable via git); em_memory {action: list|read|edit|rename|delete|status} manages them.",
    '- em_architecture {aspects?}: the project map (folders, entry points, routes, hotspots, decisions) in one call; em_symbols {name_path | mode:"overview", file} for a symbol or a file outline; em_graph_impact {node} before a refactor; em_graph_changes for what the current diff reaches; em_graph_query {pattern | preset} to walk the graph; em_index_status for coverage. em_stats shows savings; em_usage {view} shows model calls, cost, cache and insights.',
    "- em_history {action: overview | file {path} | risk | commit {sha} | branch {name} | symbol {name_path} | search {query}}: the git history classified (feat/fix/refactor…), branches vs base, and each fix traced back to the commit that caused it — ask it before editing a file or committing instead of running git log/blame/show (those are routed to it); commit messages are searchable via em_search (source git).",
    '- A Grep for an identifier the graph knows is routed to em_symbols {name_path, mode:"references"} / em_search {queries, source:"code"}: symbol-level answers instead of raw matches.',
    "Plain Bash/Read/Grep remain right for short fixed output and files you are about to edit.",
  ].join("\n");
}

export const sessionStart: HookHandler = (input) => {
  const ctx = getContext(input.cwd);
  const sessionId = input.session_id || "unknown";
  setCurrentSession(ctx, sessionId);
  const db = getStorage(ctx, { vectors: false });
  db.sessionUpsert({
    id: sessionId,
    project_root: ctx.root,
    source: input.source,
    transcript_path: input.transcript_path,
  });
  db.eventInsert({
    sessionId,
    category: "session_start",
    priority: 4,
    payload: { source: input.source },
  });

  if (process.env.CLAUDE_ENV_FILE) {
    try {
      appendFileSync(
        process.env.CLAUDE_ENV_FILE,
        `export EMINIAR_SESSION_ID=${JSON.stringify(sessionId)}\nexport EMINIAR_PROJECT_ROOT=${JSON.stringify(ctx.root)}\n`,
      );
    } catch {
      // env file is optional
    }
  }

  // A resumed or compacted session already has a transcript: catch the usage tables up.
  if (input.source === "compact" || input.source === "resume") ingestUsage(db, input, sessionId);

  const parts: string[] = [];
  if (input.source === "compact" || input.source === "resume") {
    const snap = db.snapshotLatestUnconsumed(sessionId);
    if (snap) {
      parts.push(`## Session Guide (eminiar)\n${snap.body}`);
      db.snapshotMarkConsumed(snap.id);
    } else {
      // No PreCompact snapshot (e.g. resume after a crash): build one from recent events.
      const prev = input.source === "resume" ? db.sessionLatest() : undefined;
      const guide = renderGuide(db, prev && prev.id !== sessionId ? prev.id : sessionId, 2048);
      if (guide) parts.push(`## Session Guide (eminiar)\n${guide}`);
    }
  }
  parts.push(routingGuidance(effectiveRoutingMode(ctx.config)));
  // A fresh context gets the project brief; after a compaction the Session Guide has the
  // room, so only the one-line index state is added.
  try {
    const brief = renderProjectBrief(ctx, db, 1500, {
      freshnessOnly: input.source === "compact" || input.source === "resume",
    });
    if (brief) parts.push(brief);
  } catch {
    // the brief is optional
  }
  // Where the money went: today's spend, this session's (after a resume/compact) and the
  // top insight. Reads the tables the Stop hooks fill; empty when nothing is recorded yet.
  try {
    if (ctx.config.usage.enabled) {
      const { line } = usageBrief(db, ctx, { sessionId });
      if (line) parts.push(`eminiar usage — ${line}`);
    }
  } catch {
    // usage is optional
  }
  try {
    const onboarding = join(memoriesDir(ctx), "onboarding");
    const onboarded =
      existsSync(onboarding) && readdirSync(onboarding).some((f) => f.endsWith(".md"));
    if (!onboarded)
      parts.push(
        "No onboarding memories yet: run /eminiar:em-onboard once so future sessions start with the project's structure, build and test commands.",
      );
    else if (!readManifest(ctx).sources.length) {
      // Pages may still be indexed under docs:* from a manifest that was deleted or lives on
      // another branch; lookup keeps serving them, so say so rather than "nothing registered".
      const orphaned = db.documentSourceStats(DOCS_PREFIX).length;
      parts.push(
        orphaned
          ? `No documentation sources registered (${orphaned} orphaned docs:* source(s) still in the index; em_docs {action:"list"} shows them, {action:"remove"} drops them, {action:"add", pick:"recommended"} re-registers).`
          : 'No documentation sources registered yet: em_docs {action:"discover"} maps this project\'s libraries, services and APIs to their documentation, and {action:"add", pick:"recommended"} indexes it for em_docs lookup.',
      );
    }
  } catch {
    // the nudge is optional
  }
  try {
    // Fix history reaches the hooks through a persisted table the server warm-up rebuilds;
    // until the first build nothing is flagged, so say so rather than stay silently quiet.
    if (existsSync(join(ctx.root, ".git")) && !db.metaGet("history_files"))
      parts.push(
        'Git history is not classified yet: em_history {action:"overview"} builds it (the server also does this in the background shortly after start); bug-prone files are flagged before you read or edit them once it exists.',
      );
  } catch {
    // the nudge is optional
  }
  const docs = db.countDocuments();
  const latest = db.sessionLatest();
  parts.push(
    `eminiar index: ${docs} documents${latest && latest.id !== sessionId && latest.started_at ? `; previous session ${new Date(latest.started_at).toISOString().slice(0, 16)}` : ""}. Use em_search {sort:"timeline"} or em_recall to pick up where you left off.`,
  );
  // One line per start in ~/.eminiar/hook.log: which root and database this hook saw, so a
  // session that starts with "0 documents" while the server has thousands can be traced.
  hookLog(
    "info",
    `session_start source=${input.source ?? "?"} session=${sessionId.slice(0, 8)} root=${ctx.root} db=${ctx.dbPath} documents=${docs} memories=${db.memoryCount()} history=${db.metaGet("history_files") ? "yes" : "no"}`,
  );
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: parts.join("\n\n").slice(0, MAX_INJECT),
    },
  };
};
