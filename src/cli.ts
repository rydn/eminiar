import { parseArgs } from "node:util";
import { getContext } from "./context.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { version } from "./version.js";

const USAGE = `eminiar v${version()} — local-first context, memory & knowledge graph for Claude Code

Usage: eminiar <command> [options]

Setup
  install [--no-model] [--method plugin|settings] [--cursor] [--team] [--yes] [--force]
          [--marketplace github:org/repo] [--statusline] [--node PATH]
          [--adjudicator[=heuristic|embedding|typesafe|groq|cerebras|ollama|lmstudio|llamacpp]]
          [--accept-remote]    Install into Claude Code; --cursor also registers with Cursor
                               (hooks, MCP server, skills under ~/.cursor). An interactive
                               install asks whether to turn on the adjudicator (default no)
  upgrade                      Update to the latest version and re-register
  uninstall [--purge-data] [--yes]   Remove from Claude Code and Cursor (data kept unless --purge-data)
  doctor [--json] [--fix]      Check installation health; --fix re-pins node/root and clears
                               Claude Code's cached launch failure
  replace-context-mode [--yes] [--revert-gateway]   Remove the context-mode plugin after parity
                               sign-off; --revert-gateway restores the gateway it replaced

Use
  index <path> [--source X] [--glob G ...]     Index files or a directory
  search "<q>" [--source X] [--code] [--timeline] [--lexical] [--limit N] [--json]
  graph <impact|deps|dependents|neighbors|path> <node> [--to node] [--depth N] [--limit N]
  graph <architecture|status|changes [ref]|find <q>|pattern '<json>'> [--limit N]
  graph <hotspots|routes|dead_code|cycles|clusters|coupled|orphans|stats> [--limit N]
  reindex [--scope code|git|metrics|docs|memories|embeddings|all] [--full]
  docs discover [--dev] [--no-subprojects]       Find local docs and the libraries, services and APIs the project uses
  docs add [--pick recommended|local|service|infra|catalog|api|registry|all] [--name N] [--url U ...] [--path P]
           [--glob G ...] [--provider npm:x|pypi:x|go:x|env:X|image:x|api:host] [--depth N] [--max N] [--no-sync]
  docs list | sync [name ...] [--force] | remove <name> | lookup "<q>" [--name N] [--limit N] | resolve <provider>
  stats [--lifetime]           Context savings, routing interceptions, how often recall fired
  usage [summary|daily|weekly|monthly|models|session|sessions|blocks|turns|tools|insights|savings]
        [--since 30d] [--session ID] [--limit N] [--json] [--csv]   Tokens, cache, cost and insights
  usage ingest                 Read every transcript of the project into the usage tables
  recall ["<q>"]               Memories and session history
  recall --explain "<prompt>" [--session ID]   Why hook recall would (not) fire for a prompt
  recall --file <path>         What a Read/Edit of the file would attach (memories, history)
  recall --replay [--limit N] [--since 30d]    Re-run recall over past prompts: hit rate, misses
  purge <index|sessions|graph|memories|usage|adjudicator|all> --yes
  ui [--port 7331] [--no-open] Web dashboard: stats, memories, graph, search, sessions, actions
                               (opens the browser; "serve" is the same server and opens it only with --open)
  statusline                   Claude Code statusLine command (reads JSON on stdin)
  hook [--event E] [--client claude|cursor]   Run the hook handler manually (reads JSON on stdin)
  version | -v | help

Adjudicator (opt-in: scores each request, suggests the tool, Claude model size and agent role)
  adjudicator status [--json]  On/off, configured vs effective provider, key, consent, health
  adjudicator enable [--provider P] [--preset X] [--mode advise|apply] [--project] [--accept-remote]
  adjudicator disable [--project] | provider <id> [--preset X] [--base-url U] [--model M] | provider --detect
  adjudicator key set [provider] [--from-env NAME] | key clear [provider] | key status
                               Keys come from a hidden prompt or stdin, never argv (0600 key file)
  adjudicator test "<text>" [--provider P] [--json] | eval [--provider P ...] [--fixture F] [--json]
  adjudicator stats [--since 7d] [--json] [--reset-learning]   ("eminiar adjudicator help" for more)

Agent swarms (opt-in: .eminiar/swarm.yaml)
  swarm init [--force]         Write a starter swarm.yaml and generate the worker agents
  swarm validate               Check swarm.yaml; exit 1 with file:line messages on problems
  swarm sync [--dry-run] [--force]   Regenerate .claude/agents/swarm-*.md from swarm.yaml;
                               --force also overwrites generated files edited by hand
  swarm list | runs [--limit N] | status [run]   Swarms and roles, past runs, one run (in full)
  swarm release [--run id] [--agent id] [--role r]   Free stuck workers (default: every worker
                               quiet for 15 min); their tasks go back to pending
  swarm watch [--run id] [--interval 2]          One NDJSON line per change (for the Monitor
                               tool); exits when the run finishes. --json on the others

Playbooks (stored recurring tasks; eminiar never runs or schedules them)
  playbook list [--tag t] | show <name> | rm <name>
  playbook add <name> --title T (--prompt P | --file F | stdin) [--param n[=default]]
                               [--schedule S] [--tag t] [--private] [--replace]
  playbook edit <name> [--title T] [--prompt P] [--param ...] [--schedule S] [--tag t]
  playbook run <name> [--set k=v] [--note N]   Print the filled prompt and record a run
  playbook runs [name] [--limit N]             Past runs. --json on all
`;

type Command = (args: string[]) => Promise<number>;

/** A positive whole number from a flag value, undefined for anything else. */
function positiveInt(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 ? n : undefined;
}

function text(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

const commands: Record<string, Command> = {
  async doctor(args) {
    const { values } = parseArgs({
      args,
      options: { json: { type: "boolean" }, fix: { type: "boolean" } },
      strict: false,
    });
    const { fullDoctor } = await import("./install/doctor.js");
    const checks = await fullDoctor({ fix: !!values.fix });
    if (values.json) console.log(JSON.stringify(checks, null, 2));
    else console.log(formatDoctor(checks));
    return checks.every((c) => c.ok) ? 0 : 1;
  },

  async install(args) {
    // `--adjudicator` takes a value only in the `=` form, so a bare flag never eats the next arg.
    let adjudicator: string | true | undefined;
    const rest = args.filter((a) => {
      if (a === "--adjudicator") adjudicator = true;
      else if (a.startsWith("--adjudicator="))
        adjudicator = a.slice("--adjudicator=".length) || true;
      else return true;
      return false;
    });
    const { values } = parseArgs({
      args: rest,
      options: {
        "no-model": { type: "boolean" },
        method: { type: "string" },
        team: { type: "boolean" },
        marketplace: { type: "string" },
        node: { type: "string" },
        yes: { type: "boolean" },
        statusline: { type: "boolean" },
        cursor: { type: "boolean" },
        force: { type: "boolean" },
        "accept-remote": { type: "boolean" },
      },
      strict: false,
    });
    const { install } = await import("./install/install.js");
    return install({
      adjudicator,
      acceptRemote: !!values["accept-remote"],
      force: !!values.force,
      cursor: !!values.cursor,
      noModel: !!values["no-model"],
      method:
        values.method === "settings"
          ? "settings"
          : values.method === "plugin"
            ? "plugin"
            : undefined,
      team: !!values.team,
      marketplace: typeof values.marketplace === "string" ? values.marketplace : undefined,
      node: typeof values.node === "string" ? values.node : undefined,
      yes: !!values.yes,
      // undefined keeps the `--yes` default; an explicit flag always opts in
      statusline: values.statusline === true ? true : undefined,
    });
  },

  async upgrade() {
    const { upgrade } = await import("./install/upgrade.js");
    return upgrade();
  },

  async uninstall(args) {
    const { values } = parseArgs({
      args,
      options: { "purge-data": { type: "boolean" }, yes: { type: "boolean" } },
      strict: false,
    });
    const { uninstall } = await import("./install/uninstall.js");
    return uninstall({ purgeData: !!values["purge-data"], yes: !!values.yes });
  },

  async "replace-context-mode"(args) {
    const { values } = parseArgs({
      args,
      options: { yes: { type: "boolean" }, "revert-gateway": { type: "boolean" } },
      strict: false,
    });
    const { replaceContextMode } = await import("./install/replace.js");
    return replaceContextMode({ yes: !!values.yes, revertGateway: !!values["revert-gateway"] });
  },

  async index(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { source: { type: "string" }, glob: { type: "string", multiple: true } },
      allowPositionals: true,
      strict: false,
    });
    const target = positionals[0] ?? ".";
    const { emIndex } = await import("./tools/em_index.js");
    const r = await emIndex.handler(
      {
        path: target,
        source: typeof values.source === "string" ? values.source : undefined,
        glob: values.glob as string[] | undefined,
      },
      getContext(),
    );
    console.log(text(r));
    return r.isError ? 1 : 0;
  },

  async search(args) {
    const { values, positionals } = parseArgs({
      args,
      options: {
        source: { type: "string" },
        code: { type: "boolean" },
        timeline: { type: "boolean" },
        limit: { type: "string" },
        json: { type: "boolean" },
        lexical: { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    });
    if (!positionals.length) {
      console.error('usage: eminiar search "<query>"');
      return 2;
    }
    let limit: number | undefined;
    if (values.limit !== undefined) {
      limit = positiveInt(values.limit);
      if (limit === undefined) {
        console.error("usage: --limit takes a positive whole number");
        return 2;
      }
    }
    const ctx = getContext();
    const { getStorage } = await import("./storage/index.js");
    const { search } = await import("./search/pipeline.js");
    const { formatResults } = await import("./search/format.js");
    const { vectorRanker } = await import("./embeddings/queue.js");
    const db = getStorage(ctx);
    const vectorSearch = values.lexical ? undefined : await vectorRanker(ctx, db);
    const r = await search(db, positionals.join(" "), {
      limit: limit ?? ctx.config.search.defaultLimit,
      sort: values.timeline ? "timeline" : "relevance",
      mode: values.lexical ? "lexical" : "hybrid",
      vectorSearch,
      filters: {
        source: typeof values.source === "string" ? values.source : undefined,
        contentType: values.code ? "code" : undefined,
      },
    });
    if (values.json)
      console.log(
        JSON.stringify(
          r.hits.map((h) => ({
            title: h.chunk.title,
            source: h.chunk.document.source,
            doc: h.chunk.document_id,
            score: h.score,
            snippet: h.snippet,
          })),
          null,
          2,
        ),
      );
    else console.log(formatResults([r], ctx.config.search.defaultMaxTokens));
    return 0;
  },

  async graph(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { to: { type: "string" }, depth: { type: "string" }, limit: { type: "string" } },
      allowPositionals: true,
      strict: false,
    });
    const [sub = "stats", node] = positionals;
    if (
      (values.limit !== undefined && positiveInt(values.limit) === undefined) ||
      (values.depth !== undefined && positiveInt(values.depth) === undefined)
    ) {
      console.error("usage: --limit and --depth take a positive whole number");
      return 2;
    }
    const { emGraphImpact, emGraphQuery } = await import("./tools/em_graph.js");
    const ctx = getContext();
    const limit = values.limit ? Number(values.limit) : undefined;
    const depth = values.depth ? Number(values.depth) : undefined;
    let r: { content: Array<{ text: string }>; isError?: boolean };
    const presets = [
      "hotspots",
      "coupled",
      "orphans",
      "dead_code",
      "routes",
      "cycles",
      "clusters",
      "stats",
    ];
    if (presets.includes(sub)) {
      r = await emGraphQuery.handler({ preset: sub as "hotspots", limit }, ctx);
    } else if (sub === "find") {
      if (!node) {
        console.error('usage: eminiar graph find "<query>"');
        return 2;
      }
      r = await emGraphQuery.handler({ query: node, limit }, ctx);
    } else if (sub === "pattern") {
      if (!node) {
        console.error(
          'usage: eminiar graph pattern \'{"from":{"kind":"route"},"edge":{"kinds":["handles"],"direction":"in"}}\'',
        );
        return 2;
      }
      let pattern: unknown;
      try {
        pattern = JSON.parse(node);
      } catch (err) {
        console.error(`graph pattern: the pattern is not valid JSON (${(err as Error).message})`);
        return 2;
      }
      r = await emGraphQuery.handler({ pattern: pattern as never, limit }, ctx);
    } else if (sub === "changes") {
      const { emGraphChanges } = await import("./tools/em_graph_changes.js");
      r = await emGraphChanges.handler({ ref: node, limit }, ctx);
    } else if (sub === "architecture") {
      const { emArchitecture } = await import("./tools/em_architecture.js");
      r = await emArchitecture.handler({}, ctx);
    } else if (sub === "status") {
      const { emIndexStatus } = await import("./tools/em_index_status.js");
      r = await emIndexStatus.handler({}, ctx);
    } else {
      if (!node) {
        console.error(
          "usage: eminiar graph <impact|deps|dependents|neighbors|path|find|pattern|changes|architecture|status|hotspots|coupled|orphans|dead_code|routes|cycles|clusters|stats> [node]",
        );
        return 2;
      }
      const mode =
        sub === "deps" ? "dependencies" : (sub as "impact" | "dependents" | "neighbors" | "path");
      r = await emGraphImpact.handler(
        { node, mode, to: typeof values.to === "string" ? values.to : undefined, depth, limit },
        ctx,
      );
    }
    console.log(text(r));
    return r.isError ? 1 : 0;
  },

  async reindex(args) {
    const { values } = parseArgs({
      args,
      options: { scope: { type: "string" }, full: { type: "boolean" } },
      strict: false,
    });
    const scopes = ["code", "git", "metrics", "docs", "memories", "embeddings", "all"];
    if (values.scope !== undefined && !scopes.includes(String(values.scope))) {
      console.error(`usage: eminiar reindex [--scope ${scopes.join("|")}] [--full]`);
      return 2;
    }
    const { emReindex } = await import("./tools/em_graph.js");
    const r = await emReindex.handler(
      { scope: (values.scope as "all") ?? "all", full: !!values.full },
      getContext(),
    );
    console.log(text(r));
    return 0;
  },

  async docs(args) {
    const { values, positionals } = parseArgs({
      args,
      options: {
        dev: { type: "boolean" },
        "no-subprojects": { type: "boolean" },
        pick: { type: "string" },
        name: { type: "string" },
        url: { type: "string", multiple: true },
        path: { type: "string" },
        glob: { type: "string", multiple: true },
        provider: { type: "string" },
        depth: { type: "string" },
        max: { type: "string" },
        "no-sync": { type: "boolean" },
        force: { type: "boolean" },
        limit: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    });
    const [sub = "list", ...rest] = positionals;
    const actions = ["discover", "add", "remove", "list", "sync", "lookup", "resolve"] as const;
    type Action = (typeof actions)[number];
    if (!actions.includes(sub as Action)) {
      console.error(`usage: eminiar docs <${actions.join("|")}> …`);
      return 2;
    }
    const { emDocs } = await import("./tools/em_docs.js");
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const num = (v: unknown) => (typeof v === "string" && v !== "" ? Number(v) : undefined);
    const r = await emDocs.handler(
      {
        action: sub as Action,
        include_dev: !!values.dev,
        subprojects: values["no-subprojects"] ? false : undefined,
        pick: str(values.pick) as "recommended" | undefined,
        name: str(values.name) ?? (sub === "remove" || sub === "resolve" ? undefined : undefined),
        names: sub === "sync" || sub === "remove" ? rest : undefined,
        urls: values.url as string[] | undefined,
        path: str(values.path),
        glob: values.glob as string[] | undefined,
        provider: str(values.provider) ?? (sub === "resolve" ? rest[0] : undefined),
        crawl_depth: num(values.depth),
        max_pages: num(values.max),
        sync: values["no-sync"] ? false : undefined,
        force: !!values.force,
        query: sub === "lookup" ? rest.join(" ") || undefined : undefined,
        limit: num(values.limit),
      },
      getContext(),
    );
    console.log(text(r));
    return r.isError ? 1 : 0;
  },

  async stats(args) {
    const { values } = parseArgs({
      args,
      options: { lifetime: { type: "boolean" } },
      strict: false,
    });
    const { emStats } = await import("./tools/em_stats.js");
    const r = await emStats.handler({ scope: values.lifetime ? "lifetime" : "all" }, getContext());
    console.log(text(r));
    return 0;
  },

  async usage(args) {
    const { values, positionals } = parseArgs({
      args,
      options: {
        since: { type: "string" },
        session: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
        csv: { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
    });
    const [sub = "summary"] = positionals;
    const ctx = getContext();
    if (sub === "ingest") {
      if (!ctx.config.usage.enabled) {
        console.error("usage tracking is off (usage.enabled is false); nothing was read");
        return 0;
      }
      const { getStorage } = await import("./storage/index.js");
      const { ingestProject } = await import("./usage/ingest.js");
      const r = ingestProject(getStorage(ctx), ctx.root, { overrides: ctx.config.usage.pricing });
      console.log(
        `usage ingest: ${r.files} file(s) read, ${r.calls} new API call(s), ${r.toolUses} tool use(s), ${r.contextEvents} context event(s)`,
      );
      return 0;
    }
    const {
      CSV_VIEWS,
      emUsage,
      LIMIT_MAX,
      USAGE_VIEWS,
      usageCsv,
      usageView,
      loadUsage,
      parseLimit,
      parseSince,
    } = await import("./tools/em_usage.js");
    type View = (typeof USAGE_VIEWS)[number];
    // `session` is the current session's summary; `--session ID` narrows any view to one session.
    const view: View = sub === "session" ? "summary" : (sub as View);
    if (!USAGE_VIEWS.includes(view)) {
      console.error(`usage: eminiar usage <${[...USAGE_VIEWS, "session", "ingest"].join("|")}> …`);
      return 2;
    }
    const session =
      typeof values.session === "string" && values.session ? values.session : undefined;
    const scope = sub === "session" || session ? "session" : "project";
    // Bad --since / --limit values are usage errors (exit 2 with the reason), not failures.
    const sinceArg = typeof values.since === "string" ? values.since : undefined;
    let since: number | undefined;
    try {
      since = parseSince(sinceArg);
    } catch (err) {
      console.error((err as Error).message);
      return 2;
    }
    const limit = parseLimit(values.limit === undefined ? undefined : String(values.limit));
    if (typeof limit === "string") {
      console.error(`--${limit}`);
      return 2;
    }
    if (values.csv) {
      if (!CSV_VIEWS.has(view)) {
        console.error(`--csv works for ${[...CSV_VIEWS].join(", ")}`);
        return 2;
      }
      const data = loadUsage(ctx, { scope, sessionId: session, since });
      console.log(usageCsv(view, usageView(ctx, view, data, limit ?? LIMIT_MAX)));
      return 0;
    }
    if (session) process.env.EMINIAR_SESSION_ID = session;
    const r = await emUsage.handler(
      { scope, view, since: sinceArg, limit, json: !!values.json },
      ctx,
    );
    console.log(text(r));
    return r.isError ? 1 : 0;
  },

  async recall(args) {
    const { values, positionals } = parseArgs({
      args,
      options: {
        explain: { type: "boolean" },
        file: { type: "string" },
        replay: { type: "boolean" },
        session: { type: "string" },
        limit: { type: "string" },
        since: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    });
    const ctx = getContext();
    if (values.explain || values.file || values.replay) {
      const { explainFile, explainPrompt, replayPrompts } = await import(
        "./session/recall-explain.js"
      );
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      if (values.replay) {
        console.log(
          await replayPrompts(ctx, {
            limit: values.limit ? Number(values.limit) : undefined,
            since: str(values.since),
          }),
        );
        return 0;
      }
      const file = str(values.file);
      if (file) {
        console.log(explainFile(ctx, file, { sessionId: str(values.session) }));
        return 0;
      }
      const prompt = positionals.join(" ");
      if (!prompt) {
        console.error('usage: eminiar recall --explain "<prompt>" [--session ID]');
        return 2;
      }
      console.log(await explainPrompt(ctx, prompt, { sessionId: str(values.session) }));
      return 0;
    }
    const { emRecall } = await import("./tools/em_recall.js");
    const r = await emRecall.handler({ query: positionals.join(" ") || undefined }, ctx);
    console.log(text(r));
    return 0;
  },

  async purge(args) {
    const { values, positionals } = parseArgs({
      args,
      options: { yes: { type: "boolean" } },
      allowPositionals: true,
      strict: false,
    });
    const scopes = [
      "index",
      "sessions",
      "graph",
      "memories",
      "usage",
      "adjudicator",
      "all",
    ] as const;
    const scope = positionals[0] as (typeof scopes)[number] | undefined;
    if (!scope || !scopes.includes(scope) || !values.yes) {
      console.error(`usage: eminiar purge <${scopes.join("|")}> --yes   (irreversible)`);
      return 2;
    }
    const { emPurge } = await import("./tools/em_purge.js");
    console.log(text(await emPurge.handler({ scope, confirm: true }, getContext())));
    return 0;
  },

  /** `eminiar ui` opens the browser by default; `serve` (the older name) does not. */
  async ui(args) {
    const { values } = parseArgs({
      args,
      options: {
        port: { type: "string" },
        "no-open": { type: "boolean" },
      },
      strict: false,
    });
    const { serve } = await import("./ui/server.js");
    await serve({
      port: values.port ? Number(values.port) : 7331,
      open: !values["no-open"],
      root: getContext().root,
    });
    return 0;
  },

  async serve(args) {
    const { values } = parseArgs({
      args,
      options: { port: { type: "string" }, open: { type: "boolean" } },
      strict: false,
    });
    const { serve } = await import("./ui/server.js");
    await serve({
      port: values.port ? Number(values.port) : 7331,
      open: !!values.open,
      root: getContext().root,
    });
    return 0;
  },

  async adjudicator(args) {
    const { adjudicatorCommand } = await import("./adjudicator/cli.js");
    return adjudicatorCommand(args, getContext());
  },

  async swarm(args) {
    const { swarmCommand } = await import("./swarm/cli.js");
    return swarmCommand(args, getContext());
  },

  async playbook(args) {
    const { playbookCommand } = await import("./playbooks/cli.js");
    return playbookCommand(args, getContext());
  },

  async statusline() {
    const { renderStatusline } = await import("./stats/statusline.js");
    const chunks: Buffer[] = [];
    if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c as Buffer);
    process.stdout.write(renderStatusline(Buffer.concat(chunks).toString("utf8")));
    return 0;
  },

  async hook(args) {
    const { pluginRoot } = await import("./version.js");
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [`${pluginRoot()}/dist/hook.js`, ...args], {
      stdio: "inherit",
    });
    return r.status ?? 1;
  },

  async version() {
    console.log(version());
    return 0;
  },

  async help() {
    console.log(USAGE);
    return 0;
  },
};

/**
 * Resolves once everything written to `stream` so far has been handed to the OS. A pipe is
 * written asynchronously, so exiting right after console.log would drop whatever the pipe has
 * not taken yet (piped output stopped at 64 KiB). An empty write queues behind the earlier
 * chunks, so its callback fires after they are flushed. A stream that errors (EPIPE: the reader
 * went away) or is already closed has nothing left to flush; the listener also stops that
 * error from surfacing as an uncaught exception.
 */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) return resolve();
    stream.on("error", () => resolve());
    stream.write("", () => resolve());
  });
}

/**
 * Exits with `code` once stdout and stderr are flushed. The hard exit stays (rather than only
 * setting process.exitCode) so a command that leaves a database, timer or server handle open
 * still ends promptly; it just no longer cuts piped output short.
 */
async function exitFlushed(code: number): Promise<never> {
  process.exitCode = code;
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}

const [cmd = "help", ...rest] = process.argv.slice(2);
const run = commands[cmd] ?? (cmd === "--version" || cmd === "-v" ? commands.version : undefined);
let code: number;
// Commands parse with strict: false, so `--help` would otherwise be ignored and
// `npx eminiar install --help` would start installing.
if (rest.includes("--help") && (cmd === "adjudicator" || cmd === "swarm")) {
  // These two have their own subcommand help.
  if (cmd === "swarm") console.log((await import("./swarm/cli.js")).SWARM_USAGE);
  else console.log((await import("./adjudicator/cli.js")).ADJUDICATOR_USAGE);
  code = 0;
} else if (cmd === "--help" || cmd === "-h" || rest.includes("--help")) {
  console.log(USAGE);
  code = 0;
} else if (!run) {
  console.error(`unknown command: ${cmd}\n`);
  console.log(USAGE);
  code = 2;
} else {
  try {
    code = await run(rest);
  } catch (err) {
    console.error(`eminiar ${cmd} failed: ${(err as Error).message}`);
    if (process.env.EMINIAR_DEBUG) console.error((err as Error).stack);
    // doctor is still useful when the main command fails; a usage error is about the
    // transcripts or the usage tables, not the installation, so a hint is enough there.
    if (cmd === "usage") console.error("run `eminiar doctor` to check the installation");
    else if (cmd !== "doctor") console.error(formatDoctor(runDoctor()));
    code = 1;
  }
}
await exitFlushed(code);
