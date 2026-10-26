import { parseArgs } from "node:util";
import { getContext } from "./context.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { version } from "./version.js";

const USAGE = `eminiar v${version()} — local-first context, memory & knowledge graph for Claude Code

Usage: eminiar <command> [options]

Setup
  install [--no-model] [--method plugin|settings] [--cursor] [--team] [--yes] [--force]
                               Install into Claude Code; --cursor also registers with Cursor
                               (hooks, MCP server, skills under ~/.cursor)
  upgrade                      Update to the latest version and re-register
  uninstall [--purge-data]     Remove from Claude Code and Cursor (data kept unless --purge-data)
  doctor [--json] [--fix]      Check installation health; --fix re-pins node/root and clears
                               Claude Code's cached launch failure
  replace-context-mode [--yes] Remove the context-mode plugin after parity sign-off

Use
  index <path> [--source X] [--glob G ...]     Index files or a directory
  search "<q>" [--source X] [--code] [--timeline] [--lexical] [--limit N] [--json]
  graph <impact|deps|dependents|neighbors|path> <node> [--to node] [--depth N]
  graph <architecture|status|changes [ref]|find <q>|pattern '<json>'>
  graph <hotspots|routes|dead_code|cycles|clusters|coupled|orphans|stats>
  reindex [--scope code|git|metrics|docs|memories|embeddings|all] [--full]
  docs discover [--dev] [--no-subprojects]       Find local docs and the libraries, services and APIs the project uses
  docs add [--pick recommended|local|service|infra|catalog|api|registry|all] [--name N] [--url U ...] [--path P]
           [--glob G ...] [--provider npm:x|pypi:x|go:x|env:X|image:x|api:host] [--depth N] [--max N] [--no-sync]
  docs list | sync [name ...] [--force] | remove <name> | lookup "<q>" [--name N] | resolve <provider>
  stats [--lifetime]           Context savings
  recall ["<q>"]               Memories and session history
  purge <index|sessions|graph|memories|all> --yes
  ui [--port 7331] [--no-open] Web dashboard: stats, memories, graph, search, sessions, actions
                               (alias: serve)
  statusline                   Claude Code statusLine command (reads JSON on stdin)
  hook [--event E] [--client claude|cursor]   Run the hook handler manually (reads JSON on stdin)
  version | help
`;

type Command = (args: string[]) => Promise<number>;

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
    const { values } = parseArgs({
      args,
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
      },
      strict: false,
    });
    const { install } = await import("./install/install.js");
    return install({
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
    const ctx = getContext();
    const { getStorage } = await import("./storage/index.js");
    const { search } = await import("./search/pipeline.js");
    const { formatResults } = await import("./search/format.js");
    const { vectorRanker } = await import("./embeddings/queue.js");
    const db = getStorage(ctx);
    const vectorSearch = values.lexical ? undefined : await vectorRanker(ctx, db);
    const r = await search(db, positionals.join(" "), {
      limit: values.limit ? Number(values.limit) : 5,
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
    else console.log(formatResults([r], 4000));
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
      r = await emGraphQuery.handler({ query: node, limit }, ctx);
    } else if (sub === "pattern") {
      if (!node) {
        console.error(
          'usage: eminiar graph pattern \'{"from":{"kind":"route"},"edge":{"kinds":["handles"],"direction":"in"}}\'',
        );
        return 2;
      }
      r = await emGraphQuery.handler({ pattern: JSON.parse(node), limit }, ctx);
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

  async recall(args) {
    const { positionals } = parseArgs({ args, allowPositionals: true, strict: false });
    const { emRecall } = await import("./tools/em_recall.js");
    const r = await emRecall.handler({ query: positionals.join(" ") || undefined }, getContext());
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
    const scope = positionals[0] as "index" | "sessions" | "graph" | "memories" | "all" | undefined;
    if (!scope || !values.yes) {
      console.error(
        "usage: eminiar purge <index|sessions|graph|memories|all> --yes   (irreversible)",
      );
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
        open: { type: "boolean" },
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

const [cmd = "help", ...rest] = process.argv.slice(2);
// Commands parse with strict: false, so `--help` would otherwise be ignored and
// `npx eminiar install --help` would start installing.
if (cmd === "--help" || cmd === "-h" || rest.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const run = commands[cmd] ?? (cmd === "--version" || cmd === "-v" ? commands.version : undefined);
if (!run) {
  console.error(`unknown command: ${cmd}\n`);
  console.log(USAGE);
  process.exit(2);
}
try {
  process.exit(await run(rest));
} catch (err) {
  console.error(`eminiar ${cmd} failed: ${(err as Error).message}`);
  if (process.env.EMINIAR_DEBUG) console.error((err as Error).stack);
  // doctor is still useful when the main command fails
  if (cmd !== "doctor") console.error(formatDoctor(runDoctor()));
  process.exit(1);
}
