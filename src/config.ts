import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { MODES, PROVIDER_IDS, TIERS } from "./adjudicator/types.js";
import { paths } from "./paths.js";

export const RoutingMode = z.enum(["off", "annotate", "enforce", "auto"]);
export type RoutingMode = z.infer<typeof RoutingMode>;

/**
 * A relative path that stays inside the folder it is joined to: not empty, no leading `/` or
 * `\`, no drive letter, no `..` segment (either separator), no control character (`\p{Cc}`: NUL, newline,
 * ...). Lexical only: symlinks are checked where the path is used (the docs manifest in
 * src/docs/manifest.ts, docs path sources by refuseOutside in src/index/indexer.ts, memory files
 * in reconcile in src/memory/store.ts). The `..` lookahead reads `[\s\S]` so a line break could
 * never hide a segment from it, and it also refuses `.. ` / `...` segments, which Windows trims
 * to `..` (trailing dots and spaces).
 */
export const PROJECT_RELATIVE_PATH_RE =
  /^(?![/\\])(?![A-Za-z]:)(?!(?:[\s\S]*[/\\])?\.\.[. ]*(?:[/\\]|$))[^\p{Cc}]+$/u;

/** Field names that look like they hold a credential; only `keyEnv` (an env var NAME) is allowed. */
const SECRET_FIELD = /(api_?key|token|secret|password)/i;

function findSecretFields(v: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(v)) return v.flatMap((x, i) => findSecretFields(x, [...path, i]));
  if (typeof v !== "object" || v === null) return [];
  const out: (string | number)[][] = [];
  for (const [k, x] of Object.entries(v)) {
    if (k !== "keyEnv" && SECRET_FIELD.test(k)) out.push([...path, k]);
    out.push(...findSecretFields(x, [...path, k]));
  }
  return out;
}

/**
 * The adjudicator section is built on first use, not at import: its ~70 zod nodes cost every
 * hook process ~1 ms to construct and ~1.5 ms to parse for the first time, and the adjudicator
 * is off by default. loadConfig skips it entirely while it is untouched (adjudicatorDefaults).
 */
const buildAdjudicatorObject = () =>
  z.object({
    /** Off by default; EMINIAR_ADJUDICATOR=0 is the kill switch. */
    enabled: z.boolean().default(false),
    provider: z.enum(PROVIDER_IDS).default("heuristic"),
    /** advise = hints only; apply = may set the Agent `model` (best effort). */
    mode: z.enum(MODES).default("advise"),
    surfaces: z
      .object({
        prompt: z.boolean().default(true),
        agent: z.boolean().default(true),
        plan: z.boolean().default(true),
        tools: z.boolean().default(false),
      })
      .prefault({}),
    /** The provider's role on UserPromptSubmit. */
    promptMode: z.enum(["heuristic", "async", "blocking"]).default("async"),
    typesafe: z
      .object({
        model: z.string().default("jev-1.14.0"),
        baseUrl: z.string().url().default("https://api.typesafe.ai/v1"),
      })
      .prefault({}),
    openai: z
      .object({
        preset: z
          .enum(["groq", "cerebras", "ollama", "lmstudio", "llamacpp", "custom"])
          .default("groq"),
        /** Overrides the preset's URL; required for `custom`. */
        baseUrl: z.string().url().optional(),
        /** Overrides the preset's model; required for `custom`. */
        model: z.string().optional(),
        json: z.enum(["schema", "object", "auto"]).default("auto"),
        /** USD per million tokens; without it a preset with an unknown price reports no cost. */
        price: z
          .object({ inPerM: z.number().nonnegative(), outPerM: z.number().nonnegative() })
          .optional(),
      })
      .prefault({}),
    embedding: z
      .object({
        k: z.number().int().positive().default(5),
        minSimilarity: z.number().min(0).max(1).default(0.55),
      })
      .prefault({}),
    /** NAME of an env var holding the key, never the key itself. */
    keyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "keyEnv is the name of an environment variable")
      .optional(),
    /**
     * Consent to send redacted prompt text to a remote provider; granted only by
     * ~/.eminiar/config.json. EMINIAR_ADJUDICATOR_REMOTE=0 withdraws it; no env var grants it.
     */
    remoteConsent: z.boolean().default(false),
    /**
     * The origins (scheme://host[:port]) the user agreed to, written by the CLI's consent prompt;
     * read only from ~/.eminiar/config.json. Consent covers a remote provider only when its origin
     * is listed here (or, for a legacy `remoteConsent: true` without this list, a built-in preset
     * origin of a provider the env did not pick). See resolveAdjudicator().
     */
    remoteConsentOrigins: z.array(z.string().max(512)).max(64).optional(),
    timeouts: z
      .object({
        promptMs: z.number().int().positive().default(1200),
        agentMs: z.number().int().positive().default(800),
        planMs: z.number().int().positive().default(3000),
        localMs: z.number().int().positive().default(600),
        connectMs: z.number().int().positive().default(150),
      })
      .prefault({}),
    minPromptChars: z.number().int().min(0).default(12),
    /**
     * Ordered ladder, smallest first; "fable" may be inserted by the user. Personal config only
     * (a committed project file cannot set it). Every provider request carries the whole ladder,
     * so it is bounded: each tier at most once (task #56).
     */
    tiers: z
      .array(z.enum(TIERS))
      .min(1)
      .max(TIERS.length)
      .refine((t) => new Set(t).size === t.length, "adjudicator.tiers must not repeat a tier")
      .meta({ uniqueItems: true })
      .default(["haiku", "sonnet", "opus"]),
    weights: z
      .object({
        providerMax: z.number().min(0).max(1).default(0.7),
        embeddingMax: z.number().min(0).max(1).default(0.4),
        selfReportScale: z.number().min(0).max(1).default(0.6),
        lowConfidence: z.number().min(0).max(1).default(0.55),
        tierCenters: z
          .record(z.string().max(32), z.number())
          .refine((o) => Object.keys(o).length <= 16, "at most 16 tier centers")
          .meta({ maxProperties: 16 })
          .default({ haiku: 0.6, sonnet: 2.0, opus: 3.4 }),
        /** Per-feature weight overrides (§7.2), e.g. {"design": 2.0, "toolProvider": 0.2}. */
        features: z
          .record(z.string().max(64), z.number())
          .refine((o) => Object.keys(o).length <= 64, "at most 64 feature weights")
          .meta({ maxProperties: 64 })
          .default({}),
      })
      .prefault({}),
    apply: z
      .object({
        scope: z.enum(["swarm", "all"]).default("swarm"),
        minConfidence: z.number().min(0).max(1).default(0.7),
        floor: z.enum(TIERS).default("haiku"),
        ceiling: z.enum(TIERS).default("opus"),
        respectFrontmatter: z.boolean().default(true),
      })
      .prefault({}),
    advice: z
      .object({
        mainSession: z.enum(["off", "user", "context"]).default("user"),
        cooldownPrompts: z.number().int().min(0).default(8),
      })
      .prefault({}),
    learning: z
      .object({
        enabled: z.boolean().default(true),
        maxBias: z.number().min(0).max(1).default(0.3),
        minSamples: z.number().int().min(0).default(5),
        halfLife: z.number().positive().default(50),
        costWeight: z.number().min(0).default(0.05),
      })
      .prefault({}),
    cache: z
      .object({
        ttlHours: z.number().positive().default(24),
        maxEntries: z.number().int().positive().default(2000),
      })
      .prefault({}),
    breaker: z
      .object({
        failures: z.number().int().positive().default(2),
        cooldownSec: z.number().int().positive().default(120),
      })
      .prefault({}),
    budget: z
      .object({
        dailyUsd: z.number().nonnegative().default(0.5),
        /**
         * Calls per remote provider per UTC day; 0 = unlimited. Caps providers whose price is
         * unknown (cost null), which dailyUsd cannot limit.
         */
        dailyCalls: z.number().int().nonnegative().default(2000),
      })
      .prefault({}),
    privacy: z
      .object({
        maxChars: z.number().int().positive().default(2000),
        storeHead: z.boolean().default(true),
        /**
         * Keep the newest 100 requests sent to Jev and its answers (redacted prompt text
         * included). Personal ~/.eminiar/config.json only; eminiar.config.json cannot set it.
         * EMINIAR_ADJUDICATOR_CAPTURE=0 turns it off; no env var turns it on.
         */
        captureExchanges: z.boolean().default(false),
      })
      .prefault({}),
  });

/**
 * The adjudicator section (docs/design/adjudicator.md §5). The secret-field check runs on the
 * raw input, before zod strips unknown keys, so `{"openai": {"apiKey": "..."}}` is rejected
 * instead of silently dropped.
 */
const buildAdjudicatorSchema = () =>
  z
    .preprocess((v, ctx) => {
      for (const path of findSecretFields(v))
        ctx.issues.push({
          code: "custom",
          input: v,
          path,
          message:
            "adjudicator config must not hold keys or tokens: run `eminiar adjudicator key set`, or set keyEnv to the NAME of an env var",
        });
      return v;
    }, buildAdjudicatorObject())
    .prefault({});
let adjudicatorSchema: ReturnType<typeof buildAdjudicatorSchema> | undefined;
export const AdjudicatorConfigSchema = z.lazy(
  () => (adjudicatorSchema ??= buildAdjudicatorSchema()),
);
export type AdjudicatorConfig = z.infer<ReturnType<typeof buildAdjudicatorObject>>;

/**
 * What AdjudicatorConfigSchema.parse({}) returns, without building the schema. A unit test
 * (tests/unit/adjudicator-config.test.ts) pins the two equal: change both together.
 */
export function adjudicatorDefaults(): AdjudicatorConfig {
  return {
    enabled: false,
    provider: "heuristic",
    mode: "advise",
    surfaces: { prompt: true, agent: true, plan: true, tools: false },
    promptMode: "async",
    typesafe: { model: "jev-1.14.0", baseUrl: "https://api.typesafe.ai/v1" },
    openai: { preset: "groq", json: "auto" },
    embedding: { k: 5, minSimilarity: 0.55 },
    remoteConsent: false,
    timeouts: { promptMs: 1200, agentMs: 800, planMs: 3000, localMs: 600, connectMs: 150 },
    minPromptChars: 12,
    tiers: ["haiku", "sonnet", "opus"],
    weights: {
      providerMax: 0.7,
      embeddingMax: 0.4,
      selfReportScale: 0.6,
      lowConfidence: 0.55,
      tierCenters: { haiku: 0.6, sonnet: 2.0, opus: 3.4 },
      features: {},
    },
    apply: {
      scope: "swarm",
      minConfidence: 0.7,
      floor: "haiku",
      ceiling: "opus",
      respectFrontmatter: true,
    },
    advice: { mainSession: "user", cooldownPrompts: 8 },
    learning: { enabled: true, maxBias: 0.3, minSamples: 5, halfLife: 50, costWeight: 0.05 },
    cache: { ttlHours: 24, maxEntries: 2000 },
    breaker: { failures: 2, cooldownSec: 120 },
    budget: { dailyUsd: 0.5, dailyCalls: 2000 },
    privacy: { maxChars: 2000, storeHead: true, captureExchanges: false },
  };
}

/** Everything but the adjudicator section; loadConfig parses this alone while it is untouched. */
/**
 * Why a graph include/exclude glob is refused, or undefined when it is fine. The patterns reach
 * micromatch, whose regexes backtrack exponentially in the number of `*` groups inside one path
 * segment (`**\/*a*a*a*a*a*a*a*a*b.ts` froze a server for a minute on a 40 character file name),
 * and a committed eminiar.config.json is untrusted. Bounds: 200 characters, 4 braces, 2 extglob
 * groups, 3 wildcard groups per segment and 8 per pattern; the defaults use at most 2.
 */
export function graphGlobProblem(g: string): string | undefined {
  if (g.length > 200) return "longer than 200 characters";
  if ((g.match(/\{/g)?.length ?? 0) > 4) return "more than 4 braces";
  if ((g.match(/\(/g)?.length ?? 0) > 2) return "more than 2 extglob groups";
  let total = 0;
  for (const seg of g.split(/[\\/]/)) {
    const groups = seg.match(/\*+|\?/g)?.length ?? 0;
    if (groups > 3) return "more than 3 wildcards in one path segment";
    total += groups;
  }
  return total > 8 ? "more than 8 wildcards" : undefined;
}

const GraphGlob = z.string().superRefine((g, ctx) => {
  const why = graphGlobProblem(g);
  if (why)
    ctx.addIssue({
      code: "custom",
      message: `graph glob ${JSON.stringify(g.slice(0, 40))} is ${why}`,
    });
});

const BaseConfigSchema = z.object({
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
        .array(GraphGlob)
        .default([
          "**/*.ts",
          "**/*.tsx",
          "**/*.js",
          "**/*.jsx",
          "**/*.mjs",
          "**/*.cjs",
          "**/*.mts",
          "**/*.cts",
          "**/*.py",
          "**/*.pyi",
          "**/*.go",
          "**/*.php",
        ]),
      exclude: z
        .array(GraphGlob)
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
  memories: z
    .object({
      /**
       * Project-relative directory of markdown memory files (`<topic>/<name>.md`); commit it.
       * Absolute paths and `..` segments are refused: reconcile repairs the headers of files there.
       */
      dir: z
        .string()
        .regex(PROJECT_RELATIVE_PATH_RE, "must be a path inside the project (no leading / or ..)")
        .default(".eminiar/memories"),
    })
    .prefault({}),
  playbooks: z
    .object({
      /**
       * Project-relative directory of playbook files (`<name>.md`: a stored recurring task, kept
       * as markdown with a small header); commit it. Absolute paths and `..` segments are
       * refused: eminiar writes the files there.
       */
      dir: z
        .string()
        .regex(PROJECT_RELATIVE_PATH_RE, "must be a path inside the project (no leading / or ..)")
        .default(".eminiar/playbooks"),
      /**
       * Where private playbooks are kept: a folder git must ignore (eminiar adds it to the
       * project's .gitignore before it writes the first one). Same path rules as `dir`.
       */
      privateDir: z
        .string()
        .regex(PROJECT_RELATIVE_PATH_RE, "must be a path inside the project (no leading / or ..)")
        .default(".eminiar/playbooks-private"),
      /**
       * Playbooks at all (MCP tool, CLI, dashboard). Off refuses every playbook call, read or
       * write, and em_playbook is not listed.
       */
      viewing: z.boolean().default(true),
      /**
       * Every playbook write: add, edit and delete playbooks, record and report runs, save
       * suggestions (a scan that is not a dry run), accept or dismiss them. Off makes playbooks
       * read-only; `run` still returns the prompt but records nothing.
       */
      adding: z.boolean().default(true),
      extraction: z
        .object({
          /**
           * Suggest playbooks from recurring tasks seen in session history (`scan`); listing,
           * accepting and dismissing suggestions need it too. Off by default: nothing is read for
           * it and nothing is suggested until this is on.
           */
          enabled: z.boolean().default(false),
        })
        .prefault({}),
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
      /**
       * Project-relative manifest of documentation sources (`em_docs`); commit it. Absolute
       * paths and `..` segments are refused: em_docs rewrites this file.
       */
      manifest: z
        .string()
        .regex(PROJECT_RELATIVE_PATH_RE, "must be a path inside the project (no leading / or ..)")
        .default(".eminiar/docs.json"),
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

export const ConfigSchema = BaseConfigSchema.extend({ adjudicator: AdjudicatorConfigSchema });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Keys a config object never has and must never be copied (task #62): JSON.parse makes
 * `"__proto__"` an OWN key, and assigning it (`out[k] = v`, as a merge does) calls the prototype
 * setter, so a committed file could hand every later read inherited keys that no allowlist sees.
 * `constructor` and `prototype` are the other two steps of the usual pollution chain.
 */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * A plain copy of a JSON value: own enumerable keys only, without __proto__, constructor and
 * prototype at any depth, every object an ordinary one created here. Everything read from a
 * config file goes through it before it is merged, cut down or parsed.
 */
export function ownJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ownJson);
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = ownJson((v as Record<string, unknown>)[k]);
  }
  return out;
}

/** JSON.parse, then ownJson: no prototype keys survive at any depth. Throws like JSON.parse. */
export function parseJsonSafe(text: string): unknown {
  return ownJson(JSON.parse(text));
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const raw = parseJsonSafe(readFileSync(file, "utf8"));
    return isPlainObject(raw) ? raw : {};
  } catch (err) {
    process.stderr.write(`eminiar: ignoring malformed ${file}: ${(err as Error).message}\n`);
    return {};
  }
}

/** `b` over `a`, recursively for objects; own keys only, the UNSAFE_KEYS never copied. */
function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(a)) if (!UNSAFE_KEYS.has(k)) out[k] = a[k];
  for (const k of Object.keys(b)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const v = b[k];
    const cur = Object.hasOwn(out, k) ? out[k] : undefined;
    if (isPlainObject(cur) && isPlainObject(v)) out[k] = deepMerge(cur, v);
    else out[k] = v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Lists that add up across layers instead of replacing: the default, then each layer's entries
 * in order, without repeats. They only ever skip or refuse more, so a project file can add a
 * deny rule, a disabled language or an exclude, but cannot take back a personal one.
 * NEGATABLE_LISTS also take `"!<entry>"`, which removes that entry from the built-in defaults
 * only (e.g. `"!**\/vendor/**"` to index vendored code), never another entry a config file
 * listed; the security lists do not. A personal entry that merely repeats a built-in default
 * does not count as personal for this: older installs froze the whole default list into the
 * personal file, so a "!" still removes it.
 */
export const ADDITIVE_LISTS: readonly (readonly [string, string])[] = [
  ["permissions", "extraDeny"],
  ["sandbox", "disabledLanguages"],
  ["graph", "exclude"],
];
const NEGATABLE_LISTS: ReadonlySet<string> = new Set(["graph.exclude"]);

let listDefaults: Record<string, unknown> | undefined;

/** The schema default of an ADDITIVE_LISTS entry; parsed once, only when a layer sets one. */
function defaultList(section: string, key: string): unknown[] {
  listDefaults ??= BaseConfigSchema.parse({}) as Record<string, unknown>;
  const v = (listDefaults[section] as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(v) ? v : [];
}

/**
 * deepMerge of the layers in order, except that ADDITIVE_LISTS are combined. When a layer holds
 * something other than a list there, that value is what the merge keeps, even under a later
 * layer's list, so the schema refuses it and loadConfig drops that layer with a note; a later
 * list must not quietly replace the defaults. A section that is not an object is left as merged.
 */
function mergeLayers(layers: Record<string, unknown>[]): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (const l of layers) out = deepMerge(out, l);
  for (const [section, key] of ADDITIVE_LISTS) {
    const lists: unknown[] = [];
    for (const l of layers) {
      const s = l[section];
      if (isPlainObject(s) && Object.hasOwn(s, key)) lists.push(s[key]);
    }
    if (!lists.length || !isPlainObject(out[section])) continue;
    const bad = lists.findIndex((l) => !Array.isArray(l));
    if (bad >= 0) {
      out[section] = { ...out[section], [key]: lists[bad] };
      continue;
    }
    const negatable = NEGATABLE_LISTS.has(`${section}.${key}`);
    const defaults = defaultList(section, key);
    const acc: unknown[] = [...defaults];
    // A "!" removes only a built-in default, so a project file cannot undo a personal entry of
    // its own. A personal entry equal to a default is not protected: every older install wrote
    // the whole default list into ~/.eminiar/config.json (frozenDefaults), and those copies
    // cannot be told apart from a deliberate one.
    for (const list of lists as unknown[][])
      for (const e of list) {
        if (negatable && typeof e === "string" && e.startsWith("!")) {
          const target = e.slice(1);
          const i = acc.indexOf(target);
          if (i >= 0 && defaults.includes(target)) acc.splice(i, 1);
        } else if (!acc.includes(e)) acc.push(e);
      }
    out[section] = { ...(out[section] as Record<string, unknown>), [key]: acc };
  }
  return out;
}

function envOverrides(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const mode = process.env.EMINIAR_ROUTING_MODE;
  if (mode && RoutingMode.safeParse(mode).success) o.routing = { mode };
  if (process.env.EMINIAR_EMBEDDINGS === "0") o.embeddings = { enabled: false };
  const adj: Record<string, unknown> = {};
  const on = process.env.EMINIAR_ADJUDICATOR;
  if (on === "0" || on === "1") adj.enabled = on === "1";
  // A remote provider picked here runs only when remoteConsentOrigins in ~/.eminiar/config.json
  // lists its origin; otherwise resolveAdjudicator() degrades it with no_consent.
  const provider = process.env.EMINIAR_ADJUDICATOR_PROVIDER;
  if (provider && (PROVIDER_IDS as readonly string[]).includes(provider)) adj.provider = provider;
  const amode = process.env.EMINIAR_ADJUDICATOR_MODE;
  if (amode && (MODES as readonly string[]).includes(amode)) adj.mode = amode;
  // Env vars can only WITHDRAW remote consent (task #48): a cloned repo's .claude/settings.json
  // `env` block reaches the session and its hooks, so EMINIAR_ADJUDICATOR_REMOTE=1 grants
  // nothing. Consent comes only from ~/.eminiar/config.json (remoteConsentOrigins, written by the
  // CLI after an explicit yes). =0 revokes every consent.
  if (process.env.EMINIAR_ADJUDICATOR_REMOTE === "0") adj.remoteConsent = false;
  // The same rule for the Jev exchange log: =0 turns capture off, =1 grants nothing.
  if (process.env.EMINIAR_ADJUDICATOR_CAPTURE === "0") adj.privacy = { captureExchanges: false };
  if (Object.keys(adj).length) o.adjudicator = adj;
  return o;
}

/**
 * The adjudicator keys a committed <root>/eminiar.config.json may set (docs/design/adjudicator.md
 * §5 "Trust boundary"). A project file comes with any cloned repo, so it must never decide where
 * text or keys go, which key is sent, how much text leaves the machine, or how much is spent:
 * provider, typesafe, openai (preset, baseUrl, model, price), keyEnv, remoteConsent,
 * remoteConsentOrigins, privacy, budget, timeouts and breaker come only from ~/.eminiar/config.json
 * and EMINIAR_* env (which can withdraw remote consent but never grant it). What is
 * left only turns the adjudicator on and tunes how verdicts are scored and used locally.
 * privacy also holds captureExchanges (storing Jev requests with prompt text), one more reason
 * it stays out. mode, apply and tiers decide which model every subagent runs on (apply mode
 * could put each dispatch on haiku, or floor them at fable), so they are personal too: a project
 * file may only keep the adjudicator advise-only (projectKeeps).
 */
export const PROJECT_ADJUDICATOR_KEYS: readonly string[] = [
  "enabled",
  "surfaces",
  "promptMode",
  "minPromptChars",
  "weights",
  "advice",
  "embedding",
  "learning",
  "cache",
];

/**
 * Whether projectLayer keeps adjudicator.<k> of a project section: a PROJECT_ADJUDICATOR_KEYS
 * key, or `mode: "advise"`, which can only make the adjudicator more conservative.
 */
function projectKeeps(adj: Record<string, unknown>, k: string): boolean {
  return PROJECT_ADJUDICATOR_KEYS.includes(k) || (k === "mode" && adj.mode === "advise");
}

/** The adjudicator keys of a raw project file that projectLayer drops, sorted. */
export function droppedProjectAdjudicatorKeys(raw: Record<string, unknown>): string[] {
  const adj = raw.adjudicator;
  if (!isPlainObject(adj)) return [];
  return Object.keys(adj)
    .filter((k) => !projectKeeps(adj, k))
    .sort();
}

/**
 * One line for doctor/status/dashboard when adjudicator keys that only the personal config may
 * set are ignored: set by <root>/eminiar.config.json, or by a "personal" config.json that lives
 * inside the project (personalConfigTrusted). Undefined when nothing is ignored.
 */
export function projectAdjudicatorWarning(projectRoot: string): string | undefined {
  const lines: string[] = [];
  const personal = personalAdjudicatorWarning(projectRoot);
  if (personal) lines.push(personal);
  const raw = readJsonQuiet(join(projectRoot, "eminiar.config.json"));
  const dropped = raw ? droppedProjectAdjudicatorKeys(raw) : [];
  if (dropped.length)
    lines.push(
      `eminiar.config.json sets adjudicator.${dropped.join(", adjudicator.")}: ignored, only ~/.eminiar/config.json may set ${dropped.length === 1 ? "it" : "them"}`,
    );
  return lines.length ? lines.join(" · ") : undefined;
}

/**
 * The warning for an untrusted personal config (task #54); the keys come first, before any
 * ":", so the dashboard can read them out of the line.
 */
function personalAdjudicatorWarning(projectRoot: string): string | undefined {
  const file = paths().configFile;
  const raw = readJsonQuiet(file);
  const dropped = raw ? droppedProjectAdjudicatorKeys(raw) : [];
  if (!dropped.length) return undefined;
  const problem = personalConfigProblem(projectRoot, file);
  if (!problem) return undefined;
  return `adjudicator.${dropped.join(", adjudicator.")} ignored: ${file} ${problem}, and only a config at an absolute path outside the project may set ${dropped.length === 1 ? "it" : "them"}`;
}

/** A JSON object file, or undefined when it is missing, malformed or not an object. */
function readJsonQuiet(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw = parseJsonSafe(readFileSync(file, "utf8"));
    return isPlainObject(raw) ? raw : undefined;
  } catch {
    return undefined; // loadConfig already reports a malformed file
  }
}

// --- trust anchor for the personal config (task #54) ---------------------------------------

const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * realpath (canonical case where the OS gives it); for a path that does not exist yet, the real
 * path of its nearest existing ancestor plus the rest, so a file about to be written is placed too.
 */
function realPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realPath(parent), basename(abs));
  }
}

function samePath(a: string, b: string): boolean {
  return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `child` is `parent` or below it (both real paths). */
function isInside(child: string, parent: string): boolean {
  const rel = relative(
    CASE_INSENSITIVE_FS ? parent.toLowerCase() : parent,
    CASE_INSENSITIVE_FS ? child.toLowerCase() : child,
  );
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The OS account's home directory from the user database (os.userInfo(), i.e. getpwuid on
 * POSIX), never $HOME: an env block cannot move it. Undefined when the lookup fails.
 */
function accountHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/** How many ancestors gitWorktrees climbs, and how many work trees it lists, at most. */
const MAX_GIT_DEPTH = 128;
const MAX_WORKTREES = 256;

/**
 * Every git work tree that encloses `start` or shares a repository with one: each ancestor
 * holding `.git` (not only the nearest, so the superproject of a submodule and a repo nested in
 * another are both found), the main and linked work trees of each (`git worktree`), and the
 * superproject that owns a submodule's git dir (`gitdir: <super>/.git/modules/<name>`), with the
 * same walk from there. Read from the files git keeps (`.git` file → gitdir → commondir →
 * worktrees/<name>/gitdir), so no git process is spawned.
 */
function gitWorktrees(start: string): string[] {
  const out = new Set<string>();
  const visited = new Set<string>();
  const modulesMark = `${sep}.git${sep}modules${sep}`;

  /** One directory holding `.git`: it, its repository's other work trees, its superproject. */
  const visit = (dir: string, isFile: boolean): void => {
    if (visited.has(dir) || out.size >= MAX_WORKTREES) return;
    visited.add(dir);
    out.add(dir);
    const dotGit = join(dir, ".git");
    try {
      let gitDir = dotGit;
      if (isFile) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m?.[1]) return;
        gitDir = resolve(dir, m[1].trim());
      }
      // A submodule's git dir lives in its superproject's .git/modules: anchor that work tree.
      const cmp = CASE_INSENSITIVE_FS ? gitDir.toLowerCase() : gitDir;
      const at = cmp.indexOf(modulesMark);
      if (at > 0) climb(gitDir.slice(0, at));
      let common = gitDir;
      try {
        common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
      } catch {
        // a main work tree's .git directory is its own common dir
      }
      if (basename(common) === ".git") out.add(dirname(common));
      const wt = join(common, "worktrees");
      let names: string[] = [];
      try {
        names = readdirSync(wt).slice(0, MAX_WORKTREES);
      } catch {
        // no linked work trees
      }
      for (const name of names) {
        try {
          const g = readFileSync(join(wt, name, "gitdir"), "utf8").trim();
          if (g) out.add(dirname(resolve(wt, name, g)));
        } catch {
          // a pruned or half-written entry
        }
      }
    } catch {
      // an unreadable .git: the enclosing work tree alone is still an anchor
    }
  };

  /** `from` and every ancestor of it that holds `.git`. */
  const climb = (from: string): void => {
    let dir = from;
    for (let i = 0; i < MAX_GIT_DEPTH; i++) {
      let isFile: boolean | undefined;
      try {
        isFile = statSync(join(dir, ".git")).isFile();
      } catch {
        isFile = undefined;
      }
      if (isFile !== undefined) visit(dir, isFile);
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
    }
  };

  climb(start);
  return [...out];
}

/**
 * Whether `file` (default: paths().configFile; also the key file) is the user's own and may set
 * the adjudicator keys that decide where text and keys go (tasks #54, #63). A trusted project's
 * .claude/settings.json `env` block reaches the hooks, so it could point EMINIAR_HOME (or HOME,
 * which os.homedir() reads) at a config.json the repo ships. The rules:
 * - a relative path (a relative EMINIAR_HOME or HOME) is never trusted: it resolves against
 *   whatever directory the process starts in, which the repo decides;
 * - the anchor the repo cannot move is the account's own home from the user database: a file
 *   directly in <account home>/.eminiar is always trusted;
 * - any other location is trusted only when its real path is neither inside nor an ancestor of
 *   (its folder is not at or above) the project root, the current directory, or any git work
 *   tree enclosing either, including the superproject of a submodule and linked work trees. A
 *   cloned repo cannot write outside its own checkout without running code.
 * The file need not exist yet.
 */
export function personalConfigTrusted(
  projectRoot: string,
  file: string = paths().configFile,
): boolean {
  return personalConfigProblem(projectRoot, file) === undefined;
}

/**
 * Why personalConfigTrusted refuses `file`, as a phrase that follows the path ("<file> is …"),
 * or undefined when it is trusted.
 */
export function personalConfigProblem(
  projectRoot: string,
  file: string = paths().configFile,
): string | undefined {
  if (!isAbsolute(file))
    return "is a relative path (EMINIAR_HOME or HOME is relative, so the directory a session starts in decides where it points)";
  const real = realPath(file);
  const home = accountHome();
  if (home && samePath(dirname(real), realPath(join(home, ".eminiar")))) return undefined;
  const anchors = new Set<string>();
  for (const start of [projectRoot, process.cwd()]) {
    if (!start) continue;
    const r = realPath(start);
    anchors.add(r);
    for (const w of gitWorktrees(r)) anchors.add(realPath(w));
  }
  const folder = dirname(real);
  for (const a of anchors)
    if (isInside(real, a) || isInside(a, folder))
      return "is inside this project or a folder above it (EMINIAR_HOME or HOME points there)";
  return undefined;
}

/**
 * The project layer with its adjudicator section cut down to what projectKeeps allows. A section
 * holding a key-like field stays whole instead, so the schema's secret check still refuses it
 * (loadConfig ignores the whole project file, with a stderr note) rather than dropping it quietly.
 */
function projectLayer(raw: Record<string, unknown>): Record<string, unknown> {
  const adj = raw.adjudicator;
  if (!isPlainObject(adj)) return raw;
  if (findSecretFields(adj).length) return raw;
  const kept: Record<string, unknown> = {};
  for (const k of Object.keys(adj)) if (projectKeeps(adj, k)) kept[k] = adj[k];
  return { ...(ownJson(raw) as Record<string, unknown>), adjudicator: kept };
}

/** Paths joined to the project root and written through, as [section, key]. */
const PROJECT_PATH_KEYS = [
  ["docs", "manifest"],
  ["memories", "dir"],
  ["playbooks", "dir"],
  ["playbooks", "privateDir"],
] as const;

/**
 * A config layer without a PROJECT_PATH_KEYS value that could leave the project (absolute, `..`,
 * not a string): em_docs rewrites the docs manifest and reconcile repairs memory file headers,
 * so a cloned repo must not aim them at ../settings.json or ~, and a bad personal value must not
 * cost the rest of the personal config. Only that key is dropped, so the next layer's or the
 * default value applies and everything else stays. `source` names the file in the stderr note.
 * The real guard for the manifest stays at write time (src/docs/manifest.ts).
 */
function withoutUnsafePaths(raw: Record<string, unknown>, source: string): Record<string, unknown> {
  let out = raw;
  for (const [section, key] of PROJECT_PATH_KEYS) {
    const sec = out[section];
    if (!isPlainObject(sec) || !Object.hasOwn(sec, key)) continue;
    const v = sec[key];
    if (typeof v === "string" && PROJECT_RELATIVE_PATH_RE.test(v)) continue;
    process.stderr.write(
      `eminiar: ignoring ${section}.${key} ${JSON.stringify(v)} in ${source}: it must be a path inside the project\n`,
    );
    const { [key]: _dropped, ...rest } = ownJson(sec) as Record<string, unknown>;
    out = { ...(ownJson(out) as Record<string, unknown>), [section]: rest };
  }
  return out;
}

/**
 * The personal layer: paths().configFile as it is, unless it sets adjudicator keys the project
 * layer drops (droppedProjectAdjudicatorKeys) from a location the project could have put there
 * (personalConfigTrusted, task #54); then it gets the project layer's cut.
 */
function personalLayer(projectRoot: string): Record<string, unknown> {
  const file = paths().configFile;
  const raw = readJson(file);
  const layer =
    !droppedProjectAdjudicatorKeys(raw).length || personalConfigTrusted(projectRoot, file)
      ? raw
      : projectLayer(raw);
  return withoutUnsafePaths(layer, file);
}

/**
 * Precedence: defaults < ~/.eminiar/config.json < <root>/eminiar.config.json < EMINIAR_* env.
 * The project file is the one teams commit. ADDITIVE_LISTS add up instead (mergeLayers).
 * Keys the schema does not know are dropped by the parse, so they never make a layer invalid.
 */
export function loadConfig(projectRoot: string): Config {
  const layers = [
    personalLayer(projectRoot),
    withoutUnsafePaths(
      projectLayer(readJson(join(projectRoot, "eminiar.config.json"))),
      "eminiar.config.json",
    ),
    envOverrides(),
  ];
  const parsed = parseLayers(layers);
  if (parsed.success) return parsed.data;
  // A value the schema refuses costs only the layer that holds it: a bad recall.maxMemories in
  // one file must not reset the other file's routing.mode. Each layer is checked on its own
  // (over the defaults) and the invalid ones are left out. The rest are then merged in order;
  // a layer that is valid alone but not on top of the earlier ones (e.g. more than 64
  // adjudicator.weights.features once its keys join the personal ones) loses only the fields the
  // schema names, or the whole layer when that is not enough. An earlier layer is never blamed.
  const sources = [paths().configFile, "eminiar.config.json", "EMINIAR_* environment"];
  const acc: Record<string, unknown>[] = [];
  layers.forEach((layer, i) => {
    const alone = parseLayers([layer]);
    if (!alone.success) {
      process.stderr.write(
        `eminiar: invalid config in ${sources[i]}, ignoring it: ${alone.error.message}\n`,
      );
      return;
    }
    const merged = parseLayers([...acc, layer]);
    if (merged.success) {
      acc.push(layer);
      return;
    }
    const issuePaths = merged.error.issues.map((is) => is.path.map(String));
    const trimmed = withoutPaths(layer, issuePaths);
    if (trimmed && parseLayers([...acc, trimmed.layer]).success) {
      acc.push(trimmed.layer);
      process.stderr.write(
        `eminiar: ignoring ${trimmed.removed.join(", ")} in ${sources[i]}: invalid together with the earlier config: ${merged.error.message}\n`,
      );
      return;
    }
    process.stderr.write(
      `eminiar: invalid config in ${sources[i]} together with the earlier config, ignoring it: ${merged.error.message}\n`,
    );
  });
  const retry = parseLayers(acc);
  if (retry.success) return retry.data;
  process.stderr.write(`eminiar: invalid config, using defaults: ${parsed.error.message}\n`);
  return { ...BaseConfigSchema.parse({}), adjudicator: adjudicatorDefaults() };
}

/**
 * `layer` without the deepest key it holds on each issue path (dotted names in `removed`), or
 * undefined when it holds none of them, so the caller drops the whole layer instead.
 */
function withoutPaths(
  layer: Record<string, unknown>,
  issuePaths: string[][],
): { layer: Record<string, unknown>; removed: string[] } | undefined {
  const out = ownJson(layer) as Record<string, unknown>;
  const removed: string[] = [];
  for (const p of issuePaths) {
    let node: Record<string, unknown> = out;
    let depth = 0;
    for (; depth < p.length - 1; depth++) {
      const next = node[p[depth] as string];
      if (!Object.hasOwn(node, p[depth] as string) || !isPlainObject(next)) break;
      node = next;
    }
    const key = p[depth];
    if (key === undefined || !Object.hasOwn(node, key)) return undefined;
    delete node[key];
    const name = p.slice(0, depth + 1).join(".");
    if (!removed.includes(name)) removed.push(name);
  }
  return removed.length ? { layer: out, removed } : undefined;
}

/** parseConfig of the merged layers. */
function parseLayers(layers: Record<string, unknown>[]) {
  // zod reads inherited properties: hand it a plain own-key copy, never the merged object.
  return parseConfig(ownJson(mergeLayers(layers)) as Record<string, unknown>);
}

/**
 * ConfigSchema.safeParse, except that an untouched adjudicator section (absent, or only
 * `enabled: false`, e.g. the EMINIAR_ADJUDICATOR=0 kill switch) takes its defaults without
 * building or parsing the adjudicator schema. Anything else in it, including keys the secret
 * check must refuse, goes through the full schema.
 */
function parseConfig(merged: Record<string, unknown>) {
  const { adjudicator: adj, ...rest } = merged;
  const untouched =
    adj === undefined ||
    (isPlainObject(adj) &&
      Object.keys(adj).every((k) => k === "enabled") &&
      (adj.enabled === undefined || adj.enabled === false));
  if (!untouched) return ConfigSchema.safeParse(merged);
  const base = BaseConfigSchema.safeParse(rest);
  if (!base.success) return base;
  return { success: true as const, data: { ...base.data, adjudicator: adjudicatorDefaults() } };
}
