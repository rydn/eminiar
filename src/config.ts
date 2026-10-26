import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.js";

export const RoutingMode = z.enum(["off", "annotate", "enforce", "auto"]);
export type RoutingMode = z.infer<typeof RoutingMode>;

export const ConfigSchema = z.object({
  routing: z
    .object({
      /** auto = annotate while context-mode is installed, enforce once it is gone. */
      mode: RoutingMode.default("auto"),
      deferToContextMode: z.boolean().default(true),
    })
    .prefault({}),
  sandbox: z
    .object({
      timeoutMs: z.number().int().positive().default(60_000),
      maxOutputBytes: z
        .number()
        .int()
        .positive()
        .default(2 * 1024 * 1024),
      /** Outputs larger than this are indexed and only matching sections are returned. */
      indexThreshold: z
        .number()
        .int()
        .positive()
        .default(5 * 1024),
      /** Extra env var names/globs passed through to sandboxed processes. */
      envAllow: z.array(z.string()).default([]),
      /** Disable specific languages per project (e.g. "javascript" when Bash rules must be enforced). */
      disabledLanguages: z.array(z.string()).default([]),
    })
    .prefault({}),
  search: z
    .object({
      defaultLimit: z.number().int().positive().default(5),
      defaultMaxTokens: z.number().int().positive().default(2000),
    })
    .prefault({}),
  embeddings: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().default("Xenova/bge-small-en-v1.5"),
      dims: z.number().int().positive().default(384),
    })
    .prefault({}),
  graph: z
    .object({
      include: z
        .array(z.string())
        .default([
          "**/*.ts",
          "**/*.tsx",
          "**/*.js",
          "**/*.jsx",
          "**/*.mjs",
          "**/*.cjs",
          "**/*.py",
          "**/*.go",
          "**/*.php",
        ]),
      exclude: z
        .array(z.string())
        .default([
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/.git/**",
          "**/coverage/**",
          "**/*.d.ts",
          "**/.venv/**",
          "**/venv/**",
          "**/__pycache__/**",
          "**/site-packages/**",
          "**/vendor/**",
          "**/*.min.js",
          "**/*.blade.php",
        ]),
    })
    .prefault({}),
  git: z
    .object({
      maxCommits: z.number().int().positive().default(3000),
    })
    .prefault({}),
  index: z
    .object({
      /** Doc globs indexed by `em_reindex docs` / `eminiar index`. */
      docs: z.array(z.string()).default(["**/*.md", "**/*.mdx"]),
    })
    .prefault({}),
  permissions: z
    .object({
      /** Extra deny rules in Claude Code syntax, e.g. "Bash(rm -rf *)". */
      extraDeny: z.array(z.string()).default([]),
    })
    .prefault({}),
  code: z
    .object({
      /** Symbol backend for parsing and references; tree-sitter ships in the box. */
      backend: z.enum(["tree-sitter"]).default("tree-sitter"),
    })
    .prefault({}),
  memories: z
    .object({
      /** Project-relative directory of markdown memory files (`<topic>/<name>.md`); commit it. */
      dir: z.string().default(".eminiar/memories"),
    })
    .prefault({}),
  recall: z
    .object({
      /** Inject the memories and doc pages that match each prompt (UserPromptSubmit). */
      onPrompt: z.boolean().default(true),
      /**
       * Before a file is read or edited: the memories linked to it; before an edit, also its
       * fix history (bug-prone files) and fan-in (widely imported files).
       */
      onFile: z.boolean().default(true),
      /** Brief subagents with the memories and doc pages that match their task. */
      onAgent: z.boolean().default(true),
      /** Before `git commit`: the bug-prone and widely imported files it includes. */
      onCommit: z.boolean().default(true),
      /** After a failed tool call: earlier occurrences of the error and their resolutions. */
      onError: z.boolean().default(true),
      /** Before WebSearch / WebFetch: the indexed doc pages that already answer it. */
      onWeb: z.boolean().default(true),
      maxMemories: z.number().int().min(0).max(10).default(3),
      maxDocs: z.number().int().min(0).max(10).default(2),
      /**
       * Prompts after which an item already shown in this context window may be injected
       * again when it matches (0 = once per context window only).
       */
      repeatAfter: z.number().int().min(0).max(1000).default(10),
    })
    .prefault({}),
  docs: z
    .object({
      /** Project-relative manifest of documentation sources (`em_docs`); commit it. */
      manifest: z.string().default(".eminiar/docs.json"),
      /** How long fetched documentation pages stay cached before a sync refetches them. */
      ttlHours: z
        .number()
        .positive()
        .default(24 * 7),
      crawl: z
        .object({
          /** Link depth followed from each seed URL (same origin, under the seed's path). */
          depth: z.number().int().min(0).max(3).default(1),
          /** Pages per source per sync; catalogue entries and `add {max_pages}` can raise it. */
          maxPages: z.number().int().positive().max(200).default(8),
          /** A page larger than this is truncated before indexing (reference pages can be megabytes). */
          maxPageBytes: z
            .number()
            .int()
            .positive()
            .default(120 * 1024),
          /**
           * Budget for external APIs — hosts called from code, documentation linked from code,
           * probed docs sites and service-tier catalogue entries. These are indexed in full;
           * `depth`/`maxPages` above only cap dependencies (libraries, infrastructure).
           */
          api: z
            .object({
              depth: z.number().int().min(0).max(3).default(2),
              maxPages: z.number().int().positive().max(200).default(150),
            })
            .prefault({}),
        })
        .prefault({}),
      /**
       * Embed documentation chunks for semantic search. Off by default: lexical search covers
       * documentation well and a crawl should never queue hours of model work.
       */
      embed: z.boolean().default(false),
      discover: z
        .object({
          /** Also propose documentation for devDependencies. */
          includeDev: z.boolean().default(false),
          /** Scan one level of sub-projects (multi-repo workspaces, monorepos). */
          subprojects: z.boolean().default(true),
        })
        .prefault({}),
      /** Extra catalogue entries: {id, title, urls, npm?, pypi?, go?, env?, image?, files?, crawl?}. */
      catalog: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            urls: z.array(z.string()),
            npm: z.array(z.string()).optional(),
            pypi: z.array(z.string()).optional(),
            go: z.array(z.string()).optional(),
            env: z.array(z.string()).optional(),
            image: z.array(z.string()).optional(),
            files: z.array(z.string()).optional(),
            hosts: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
            tier: z.enum(["service", "infra", "library"]).optional(),
            crawl: z
              .object({
                depth: z.number().int().min(0).max(3).optional(),
                maxPages: z.number().int().positive().max(200).optional(),
              })
              .optional(),
          }),
        )
        .default([]),
    })
    .prefault({}),
  usage: z
    .object({
      /** Ingest Claude Code transcripts (tokens, cache, cost per model call) and record statusline snapshots. */
      enabled: z.boolean().default(true),
      /** Soft budgets; crossing one adds a one-line warning to the next prompt (never blocks). */
      budgets: z
        .object({
          sessionUsd: z.number().positive().optional(),
          dailyUsd: z.number().positive().optional(),
          /** A single API call above this is flagged as an expensive turn. */
          turnUsd: z.number().positive().optional(),
        })
        .prefault({}),
      /**
       * Price overrides per model, USD per million tokens, matched by substring of the model id
       * (first match wins). Missing fields fall back to the bundled table.
       */
      pricing: z
        .record(
          z.string(),
          z.object({
            input: z.number().nonnegative().optional(),
            output: z.number().nonnegative().optional(),
            cacheWrite5m: z.number().nonnegative().optional(),
            cacheWrite1h: z.number().nonnegative().optional(),
            cacheRead: z.number().nonnegative().optional(),
          }),
        )
        .default({}),
      /** Show cost, context and plan usage segments in `eminiar statusline`. */
      statusline: z.boolean().default(true),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`eminiar: ignoring malformed ${file}: ${(err as Error).message}\n`);
    return {};
  }
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) out[k] = deepMerge(cur, v);
    else out[k] = v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function envOverrides(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const mode = process.env.EMINIAR_ROUTING_MODE;
  if (mode && RoutingMode.safeParse(mode).success) o.routing = { mode };
  if (process.env.EMINIAR_EMBEDDINGS === "0") o.embeddings = { enabled: false };
  return o;
}

/**
 * Precedence: defaults < ~/.eminiar/config.json < <root>/eminiar.config.json < EMINIAR_* env.
 * The project file is the one teams commit.
 */
export function loadConfig(projectRoot: string): Config {
  const merged = deepMerge(
    deepMerge(readJson(paths().configFile), readJson(join(projectRoot, "eminiar.config.json"))),
    envOverrides(),
  );
  const parsed = ConfigSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  process.stderr.write(`eminiar: invalid config, using defaults: ${parsed.error.message}\n`);
  return ConfigSchema.parse({});
}
