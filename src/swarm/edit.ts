import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Document, Pair, Scalar, YAMLMap, YAMLSeq } from "yaml";
import {
  enforceIntent,
  parseSwarmYaml,
  STARTER_YAML,
  SWARM_FILES,
  type SwarmFileRaw,
  swarmFile,
} from "./config.js";
import type {
  SwarmDoc,
  SwarmDocActiveRun,
  SwarmDocRename,
  SwarmDocWarning,
  SwarmLineDiff,
} from "./doc-types.js";
import type { ConfigIssue, LoadResult } from "./types.js";

/**
 * The edit core behind the dashboard's swarm studio: read `.eminiar/swarm.yaml` as a structured
 * draft, and render an edited draft back onto the file's own YAML document so comments, block
 * styles and key order survive. config.ts's parseSwarmYaml stays the one validator: a rendered
 * text is only good when it parses.
 *
 * Nothing here is imported by config.ts or any hook, so hook processes never load it. `yaml` is
 * loaded on first use, like config.ts does.
 */

let yamlLib: typeof import("yaml") | undefined;
function yaml(): typeof import("yaml") {
  yamlLib ??= createRequire(import.meta.url)("yaml") as typeof import("yaml");
  return yamlLib;
}

/** The draft type must cover everything the schema accepts: a new schema field fails to compile here. */
type Assert<T extends true> = T;
export type SwarmDocMirrorsSchema = Assert<SwarmFileRaw extends SwarmDoc ? true : false>;

/** Mirrors config.ts MAX_FILE_CHARS (not exported there, and config.ts only gains a type). */
export const SWARM_FILE_MAX_CHARS = 256_000;
const DEFAULT_MAX_AGENTS = 4;
const PROMPT_MAX = 20_000;

// --- small helpers ----------------------------------------------------------------------

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** sha256 (hex) of the text's UTF-8 bytes: the `baseHash` the studio sends back when saving. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Structural equality of two JSON-like values; key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (
    a === b ||
    (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b))
  )
    return true;
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlain(a) && isPlain(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}

/** A JSON copy without `undefined`s. Own properties only, so a `__proto__` key stays plain data. */
function clean(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("the draft is nested too deeply");
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      Object.defineProperty(out, k, {
        value: clean(v, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("not a finite number");
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
    throw new Error(`a ${typeof value} cannot be written to YAML`);
  return value;
}

const keyText = (pair: Pair): string => {
  const k = pair.key as { value?: unknown } | null;
  return k && typeof k === "object" && "value" in k ? String(k.value) : String(pair.key);
};

const isMergePair = (pair: Pair): boolean => {
  const v = (pair.key as { value?: unknown } | null)?.value;
  return v === "<<" || (typeof v === "symbol" && v.description === "<<");
};

// --- the swarm file as a structured draft -------------------------------------------------

export interface SwarmDocRead {
  state: "absent" | "ok" | "invalid";
  file: string;
  rel: string;
  /** The file's text; null when there is no file. */
  text: string | null;
  /** sha256 of the file's bytes; null when there is no file. */
  hash: string | null;
  /** The file as a draft; null when there is no file or its YAML does not parse. */
  doc: SwarmDoc | null;
  issues: ConfigIssue[];
  /** Dotted paths the draft form must not edit (aliases, anchors, merge keys, x-* keys, hooks). */
  locked: string[];
}

/** The starter file as a draft (what the studio offers when no swarm file exists). */
export function starterDoc(): SwarmDoc {
  const doc = yaml().parseDocument(STARTER_YAML, { uniqueKeys: true, merge: true });
  return doc.toJS({ maxAliasCount: 200 }) as SwarmDoc;
}

export function readSwarmDoc(root: string): SwarmDocRead {
  const { file, rel, exists } = swarmFile(root);
  const base = { file, rel };
  if (!exists)
    return { ...base, state: "absent", text: null, hash: null, doc: null, issues: [], locked: [] };
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    return {
      ...base,
      state: "invalid",
      text: null,
      hash: null,
      doc: null,
      issues: [{ path: "", message: `cannot read ${rel}: ${(err as Error).message}` }],
      locked: [],
    };
  }
  const text = bytes.toString("utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const result = parseSwarmYaml(text, file, rel);
  const issues = result.state === "invalid" ? result.issues : [];
  const state = result.state === "ok" ? "ok" : "invalid";
  if (text.length > SWARM_FILE_MAX_CHARS)
    return { ...base, state, text, hash, doc: null, issues, locked: [] };

  const Y = yaml();
  const parsed = Y.parseDocument(text, { uniqueKeys: true, merge: true });
  let doc: SwarmDoc | null = null;
  let locked: string[] = [];
  if (!parsed.errors.length) {
    try {
      const js = parsed.toJS({ maxAliasCount: 200 }) as unknown;
      if (isPlain(js)) {
        doc = js as unknown as SwarmDoc;
        locked = collectLocked(Y, parsed).map((p) => p.join("."));
      }
    } catch {
      // an alias expansion over the limit: raw mode only
    }
  }
  return { ...base, state, text, hash, doc, issues, locked };
}

/** Parse `text` with the real validator, and check the `enforce:` line the shell hook greps agrees. */
export function checkSwarmText(
  text: string,
  opts: { file?: string; rel?: string } = {},
): { result: LoadResult; enforceOk: boolean } {
  const rel = opts.rel ?? SWARM_FILES[0];
  const result = parseSwarmYaml(text, opts.file ?? rel, rel);
  const parsed =
    result.state === "ok"
      ? result.config.enforce && result.config.enabled
      : result.state === "invalid"
        ? result.enforce
        : undefined;
  // bin/em-hook greps for `enforce: true`; if the parse says otherwise, the hooks would disagree.
  return { result, enforceOk: parsed === undefined || parsed === enforceIntent(text) };
}

// --- locked paths -----------------------------------------------------------------------

function mergedKeys(Y: typeof import("yaml"), doc: Document, value: unknown): string[] {
  const sources = Y.isSeq(value) ? value.items : [value];
  const keys: string[] = [];
  for (const src of sources) {
    const m = Y.isAlias(src) ? src.resolve(doc) : src;
    if (Y.isMap(m)) for (const p of m.items) if (!isMergePair(p)) keys.push(keyText(p));
  }
  return keys;
}

/**
 * Paths the structured form must leave alone, because writing them would break a link in the
 * file: an alias, an anchored node (aliases may point at it), a key a merge (`<<`) supplies, an
 * `x-*` top-level key, and every role's `hooks`. Raw YAML mode can still change them.
 */
function collectLocked(Y: typeof import("yaml"), doc: Document): string[][] {
  const out: string[][] = [];
  const walk = (node: unknown, path: string[]): void => {
    if (Y.isAlias(node)) {
      out.push(path);
      return;
    }
    if (!Y.isNode(node)) return;
    if ((node as { anchor?: string }).anchor) out.push(path);
    if (Y.isMap(node)) {
      const explicit = new Set(node.items.filter((p) => !isMergePair(p)).map(keyText));
      for (const p of node.items) {
        if (isMergePair(p)) {
          out.push([...path, "<<"]);
          for (const k of mergedKeys(Y, doc, p.value)) if (!explicit.has(k)) out.push([...path, k]);
          continue;
        }
        const k = keyText(p);
        const child = [...path, k];
        const hooks = path.length === 4 && path[0] === "swarms" && path[2] === "agents";
        if ((path.length === 0 && k.startsWith("x-")) || (hooks && k === "hooks")) {
          out.push(child);
          continue;
        }
        walk(p.value, child);
      }
    } else if (Y.isSeq(node)) {
      node.items.forEach((it, i) => {
        walk(it, [...path, String(i)]);
      });
    }
  };
  walk(doc.contents, []);
  return out;
}

// --- rendering --------------------------------------------------------------------------

export type RenderCode = "yaml" | "locked" | "rename" | "mismatch" | "enforce";

export type RenderResult =
  | {
      ok: true;
      text: string;
      /** The real validator's verdict on `text`. */
      result: LoadResult;
      /** `text` differs from the base text (always true when the file is being created). */
      changed: boolean;
    }
  | {
      ok: false;
      code: RenderCode;
      error: string;
      /** For `locked`: the locked paths, to show which fields are read-only. */
      locked?: string[];
    };

class RenderFail extends Error {
  constructor(
    readonly code: RenderCode,
    message: string,
    readonly locked?: string[],
  ) {
    super(message);
  }
}

const TOP_ORDER = ["version", "enabled", "sync", "enforce", "allowed_agents", "defaults", "swarms"];
const DEFAULTS_ORDER = ["model", "model_range", "skills", "context"];
const SWARM_ORDER = [
  "description",
  "topology",
  "max_agents",
  "stages",
  "instructions",
  "context",
  "agents",
];
const ROLE_ORDER = [
  "description",
  "model",
  "model_range",
  "effort",
  "color",
  "count",
  "max_turns",
  "isolation",
  "tools_profile",
  "tools",
  "disallowed_tools",
  "skills",
  "scope",
  "memory_tags",
  "context",
  "hooks",
  "prompt",
];
const CONTEXT_ORDER = ["memories", "docs", "history", "structure", "insights", "max_chars"];
const RANGE_ORDER = ["floor", "ceiling"];

/** The conventional key order of the map at `path`, so new keys land where a person would put them. */
function orderOf(path: readonly string[]): readonly string[] | undefined {
  const last = path[path.length - 1];
  if (path.length === 0) return TOP_ORDER;
  if (last === "context") return CONTEXT_ORDER;
  if (last === "model_range") return RANGE_ORDER;
  if (path.length === 1 && path[0] === "defaults") return DEFAULTS_ORDER;
  if (path.length === 2 && path[0] === "swarms") return SWARM_ORDER;
  if (path.length === 4 && path[0] === "swarms" && path[2] === "agents") return ROLE_ORDER;
  return undefined;
}

/** A list of up to 6 short scalars reads best on one line. */
function prefersFlow(items: readonly unknown[]): boolean {
  return (
    items.length <= 6 &&
    items.every(
      (v) =>
        typeof v === "number" ||
        typeof v === "boolean" ||
        (typeof v === "string" && v.length <= 40 && !v.includes("\n")),
    )
  );
}

const isScalarValue = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function renderText(
  baseText: string | null,
  draft: SwarmDoc,
  renames: readonly SwarmDocRename[],
): { text: string; changed: boolean } {
  const Y = yaml();
  const base = baseText ?? STARTER_YAML;
  const bom = base.startsWith("﻿");
  const body = bom ? base.slice(1) : base;
  // The dominant line ending, used only when the document is re-serialised.
  const crlfCount = (body.match(/\r\n/g) ?? []).length;
  const crlf = crlfCount > 0 && crlfCount * 2 >= (body.match(/\n/g) ?? []).length;

  const doc = Y.parseDocument(body, { uniqueKeys: true, merge: true });
  if (doc.errors.length)
    throw new RenderFail(
      "yaml",
      `the file is not valid YAML (${doc.errors[0]?.message.split("\n")[0] ?? "parse error"}); edit it in raw mode`,
    );
  if (!Y.isMap(doc.contents))
    throw new RenderFail("yaml", "the file is not a mapping; edit it in raw mode");

  let target: unknown;
  try {
    target = clean(draft);
  } catch (err) {
    throw new RenderFail("mismatch", (err as Error).message);
  }
  if (!isPlain(target)) throw new RenderFail("mismatch", "the draft is not a mapping");

  for (const r of renames) applyRename(Y, doc, r);

  let before: unknown;
  try {
    before = doc.toJS({ maxAliasCount: 200 });
  } catch (err) {
    throw new RenderFail("yaml", `the file cannot be read: ${(err as Error).message}`);
  }
  // JSON cannot carry .inf / .nan, so the client sends null for them; they are not the form's to
  // change, so keep the file's value instead of reading the null as an edit.
  restoreNonFinite(before, target);
  // Nothing to change: hand back the file as it is, byte for byte.
  if (!renames.length && deepEqual(before, target))
    return { text: base, changed: baseText === null };

  const locked = collectLocked(Y, doc);
  const ctx: Ctx = { Y, doc, locked };
  // A pure scalar edit is spliced into the original text, so every other line stays byte for byte.
  let text = renames.length ? null : spliceScalars(ctx, body, before, target);
  if (text === null) {
    applyDiff(ctx, [], before, target);
    text = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
    if (!text.endsWith("\n")) text += "\n";
    if (crlf) text = text.replace(/\r?\n/g, "\r\n");
  }
  if (bom) text = `﻿${text}`;

  // The rendered text must mean exactly what the draft says; anything else is a bug or a link
  // (alias, merge) the edit could not honour, and is never written.
  const again = Y.parseDocument(bom ? text.slice(1) : text, { uniqueKeys: true, merge: true });
  let after: unknown;
  try {
    after = again.errors.length ? undefined : again.toJS({ maxAliasCount: 200 });
  } catch {
    after = undefined;
  }
  if (!deepEqual(after, target))
    throw new RenderFail(
      "mismatch",
      "the edit could not be written without changing something else (an alias or merge key in the file?); edit it in raw mode",
      locked.map((p) => p.join(".")),
    );
  return { text, changed: text !== baseText };
}

/**
 * Render `draft` onto `baseText` (the file as it is on disk; null creates the file from the
 * starter, which keeps its header comments). Untouched nodes keep their comments and style, an
 * edited scalar keeps its line comment and block-literal style, and `renames` (applied in order,
 * before the diff) change the key itself, so a renamed role keeps its comments and its entry in
 * `stages` follows. The result is validated by parseSwarmYaml; the caller decides what to do with
 * its issues (the studio shows them, and refuses to save while any remain).
 */
export function renderSwarmDoc(
  baseText: string | null,
  draft: SwarmDoc,
  renames: readonly SwarmDocRename[] = [],
  opts: { file?: string; rel?: string } = {},
): RenderResult {
  let rendered: { text: string; changed: boolean };
  try {
    rendered = renderText(baseText, draft, renames);
  } catch (err) {
    if (err instanceof RenderFail)
      return {
        ok: false,
        code: err.code,
        error: err.message,
        ...(err.locked ? { locked: err.locked } : {}),
      };
    throw err;
  }
  const { result, enforceOk } = checkSwarmText(rendered.text, opts);
  if (!enforceOk)
    return {
      ok: false,
      code: "enforce",
      error:
        "the enforce setting is not on a plain top-level `enforce:` line, so the shell hook would read it differently; edit it in raw mode",
    };
  return { ok: true, text: rendered.text, result, changed: rendered.changed };
}

interface Ctx {
  Y: typeof import("yaml");
  doc: Document;
  locked: string[][];
}

/**
 * When every difference between `oldV` and `newV` is an existing single-line scalar getting a new
 * single-line scalar value, return `body` with just those scalars' source ranges replaced (the
 * node's quoting style is kept, comments live outside the range). Anything structural, locked,
 * block-styled or empty returns null and the caller re-serialises the document instead.
 */
function spliceScalars(ctx: Ctx, body: string, oldV: unknown, newV: unknown): string | null {
  const { Y, doc } = ctx;
  const edits: { start: number; end: number; text: string }[] = [];
  const walk = (path: string[], a: unknown, b: unknown): boolean => {
    if (deepEqual(a, b)) return true;
    if (isPlain(a) && isPlain(b)) {
      const ka = Object.keys(a);
      if (ka.length !== Object.keys(b).length) return false;
      return ka.every((k) => Object.hasOwn(b, k) && walk([...path, k], a[k], b[k]));
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      // A slot may be rewritten in place only when it is a true replacement: the old value is
      // nowhere in the new list and the new value nowhere in the old one. Otherwise items moved
      // (a reorder, a remove plus an add), and rewriting by index would leave every comment on
      // the wrong item, so let applyDiff's pool matching carry each item with its comment.
      return a.every((x, i) => {
        const y = b[i];
        if (!deepEqual(x, y) && isScalarValue(x) && isScalarValue(y)) {
          if (b.some((v) => deepEqual(v, x)) || a.some((v) => deepEqual(v, y))) return false;
        }
        return walk([...path, String(i)], x, y);
      });
    }
    if (!isScalarValue(a) || !isScalarValue(b) || a === null || b === null) return false;
    if (lockedAt(ctx, path)) return false;
    const node = nodeAt(Y, doc, path);
    if (!Y.isScalar(node) || !node.range || node.anchor) return false;
    if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") return false;
    if (typeof b === "string" && (b.includes("\n") || b.includes("\r"))) return false;
    // Inside a flow collection a plain string with these characters would need quoting context.
    if (typeof b === "string" && node.type === "PLAIN" && /[,[\]{}]/.test(b)) return false;
    const [start, end] = node.range;
    if (end <= start) return false;
    const fresh = new Y.Scalar(b);
    if (typeof b === "string" && node.type && node.type !== "PLAIN") fresh.type = node.type;
    const text = new Y.Document(fresh).toString({ lineWidth: 0 }).replace(/\r?\n$/, "");
    if (text.includes("\n")) return false;
    edits.push({ start, end, text });
    return true;
  };
  if (!walk([], oldV, newV) || !edits.length) return null;
  let out = body;
  for (const e of edits.sort((x, y) => y.start - x.start))
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const startsWithPath = (p: readonly string[], prefix: readonly string[]) =>
  prefix.every((k, i) => p[i] === k);
/** `path` is locked, or inside a locked node. */
const lockedAt = (ctx: Ctx, path: readonly string[]) =>
  ctx.locked.some((l) => l.length <= path.length && startsWithPath(path, l));
/** Something strictly inside `path` is locked (replacing or deleting `path` would lose it). */
const lockedBelow = (ctx: Ctx, path: readonly string[]) =>
  ctx.locked.some((l) => l.length > path.length && startsWithPath(l, path));

function lockedFail(ctx: Ctx, path: readonly string[]): RenderFail {
  return new RenderFail(
    "locked",
    `${path.join(".") || "the file"} is read-only here (an alias, anchor, merge key, x-* key or hooks); edit it in raw mode`,
    ctx.locked.map((p) => p.join(".")),
  );
}

/**
 * The pair whose key reads as `name`. A map can hold `true:` and `"true":` together, and toJS keeps
 * the last of those, so take the last match here too: the draft's value is that pair's.
 */
function findPair(Y: typeof import("yaml"), map: YAMLMap, name: string): Pair | undefined {
  for (let i = map.items.length - 1; i >= 0; i--) {
    const p = map.items[i] as Pair;
    if (Y.isScalar(p.key) && String(p.key.value) === name) return p;
  }
  return undefined;
}

/**
 * Resolve `path` the way the draft names it. A key like an unquoted `true:` is a boolean in the
 * document but the string "true" in the draft, so maps are searched by `String(key.value)` (as
 * findPair does) instead of through doc.getIn, which compares the key's type too.
 */
function nodeAt(Y: typeof import("yaml"), doc: Document, path: readonly string[]): unknown {
  let node: unknown = doc.contents;
  for (const seg of path) {
    if (Y.isMap(node)) {
      const pair = findPair(Y, node, seg);
      if (!pair) return undefined;
      node = pair.value;
    } else if (Y.isSeq(node)) {
      node = node.items[Number(seg)];
    } else return undefined;
  }
  return node;
}

function deleteAt(ctx: Ctx, path: readonly string[]): void {
  const { Y, doc } = ctx;
  const parent = nodeAt(Y, doc, path.slice(0, -1));
  const last = path[path.length - 1] as string;
  if (Y.isMap(parent)) {
    const pair = findPair(Y, parent, last);
    if (pair) parent.items.splice(parent.items.indexOf(pair), 1);
  } else if (Y.isSeq(parent)) parent.items.splice(Number(last), 1);
}

function setAt(ctx: Ctx, path: readonly string[], value: unknown): void {
  const { Y, doc } = ctx;
  const parent = nodeAt(Y, doc, path.slice(0, -1));
  const last = path[path.length - 1] as string;
  if (Y.isMap(parent)) {
    const pair = findPair(Y, parent, last);
    if (pair) pair.value = value as never;
    else parent.items.push(new Y.Pair(new Y.Scalar(last), value) as never);
  } else if (Y.isSeq(parent)) parent.items[Number(last)] = value as never;
  else throw new RenderFail("mismatch", `${path.join(".")} is not inside a mapping or list`);
}

/** Where the file holds a non-finite number and the draft holds null (JSON's stand-in), restore it. */
function restoreNonFinite(before: unknown, target: unknown): void {
  if (Array.isArray(before) && Array.isArray(target)) {
    before.forEach((b, i) => {
      if (typeof b === "number" && !Number.isFinite(b) && target[i] === null) target[i] = b;
      else restoreNonFinite(b, target[i]);
    });
  } else if (isPlain(before) && isPlain(target)) {
    for (const [k, b] of Object.entries(before)) {
      if (!Object.hasOwn(target, k)) continue;
      if (typeof b === "number" && !Number.isFinite(b) && target[k] === null) target[k] = b;
      else restoreNonFinite(b, target[k]);
    }
  }
}

function applyRename(Y: typeof import("yaml"), doc: Document, r: SwarmDocRename): void {
  const fail = (msg: string) => new RenderFail("rename", msg);
  const swarms = doc.get("swarms", true);
  if (!Y.isMap(swarms)) throw fail("the file has no swarms to rename");
  const rename = (map: YAMLMap, from: string, to: string, what: string) => {
    if (!to) throw fail(`the new ${what} name is empty`);
    const pair = findPair(Y, map, from);
    if (!pair || !Y.isScalar(pair.key)) throw fail(`there is no ${what} "${from}" to rename`);
    if (from === to) return;
    if (findPair(Y, map, to)) throw fail(`a ${what} named "${to}" already exists`);
    pair.key.value = to;
  };
  if (r.role === undefined) {
    rename(swarms, r.swarm, r.to, "swarm");
    return;
  }
  const swarm = findPair(Y, swarms, r.swarm)?.value;
  const agents = Y.isMap(swarm) ? findPair(Y, swarm, "agents")?.value : undefined;
  if (!Y.isMap(swarm) || !Y.isMap(agents)) throw fail(`there is no swarm "${r.swarm}" with agents`);
  rename(agents, r.role, r.to, "agent");
  const stages = findPair(Y, swarm, "stages")?.value;
  if (Y.isSeq(stages))
    for (const it of stages.items)
      if (Y.isScalar(it) && it.value === r.role) (it as Scalar).value = r.to;
}

/** Build a YAML node for a new value, with keys in conventional order and tidy styles. */
function build(ctx: Ctx, value: unknown, path: readonly string[]): unknown {
  const { Y } = ctx;
  if (Array.isArray(value)) {
    const seq = new Y.YAMLSeq();
    seq.items = value.map((v, i) => build(ctx, v, [...path, String(i)])) as YAMLSeq["items"];
    if (prefersFlow(value)) seq.flow = true;
    return seq;
  }
  if (isPlain(value)) {
    const map = new Y.YAMLMap();
    const order = orderOf(path) ?? [];
    const keys = Object.keys(value);
    const rank = (k: string) => {
      const i = order.indexOf(k);
      return i < 0 ? order.length : i;
    };
    // Array.sort is stable, so keys outside the convention keep the draft's order.
    keys.sort((a, b) => rank(a) - rank(b));
    for (const k of keys)
      map.items.push(new Y.Pair(new Y.Scalar(k), build(ctx, value[k], [...path, k])) as never);
    return map;
  }
  const s = new Y.Scalar(value);
  if (typeof value === "string" && value.includes("\n")) s.type = "BLOCK_LITERAL";
  return s;
}

type Commented = { comment?: unknown; commentBefore?: unknown; spaceBefore?: unknown };

/** Carry an old node's comments over to the node that replaces it. */
function inherit(from: unknown, to: unknown): void {
  if (!from || !to || typeof from !== "object" || typeof to !== "object") return;
  const f = from as Commented;
  const t = to as Commented;
  if (f.comment !== undefined) t.comment = f.comment;
  if (f.commentBefore !== undefined) t.commentBefore = f.commentBefore;
  if (f.spaceBefore !== undefined) t.spaceBefore = f.spaceBefore;
}

/** Insert `pair` into `map` where its key belongs by convention (else at the end). */
function insertPair(ctx: Ctx, map: YAMLMap, path: readonly string[], pair: Pair): void {
  const order = orderOf(path);
  const rank = (k: string) => order?.indexOf(k) ?? -1;
  const at = rank(keyText(pair));
  let index = map.items.length;
  if (order && at >= 0) {
    const i = map.items.findIndex((p) => !isMergePair(p) && rank(keyText(p)) > at);
    if (i >= 0) index = i;
  }
  // A blank line between swarms, like the starter file has.
  if (path.length === 1 && path[0] === "swarms" && map.items.length)
    (pair.key as Commented).spaceBefore = true;
  map.items.splice(index, 0, pair as never);
  void ctx;
}

function applyDiff(ctx: Ctx, path: string[], oldV: unknown, newV: unknown): void {
  const { Y, doc } = ctx;
  if (deepEqual(oldV, newV)) return;
  if (lockedAt(ctx, path)) throw lockedFail(ctx, path);

  if (isPlain(oldV) && isPlain(newV)) {
    const node = path.length ? nodeAt(Y, doc, path) : doc.contents;
    if (!Y.isMap(node))
      throw new RenderFail("mismatch", `${path.join(".") || "the file"} is not a plain mapping`);
    for (const k of Object.keys(oldV)) {
      if (Object.hasOwn(newV, k)) continue;
      const child = [...path, k];
      if (lockedAt(ctx, child) || lockedBelow(ctx, child)) throw lockedFail(ctx, child);
      deleteAt(ctx, child);
    }
    for (const k of Object.keys(newV)) {
      const child = [...path, k];
      if (Object.hasOwn(oldV, k)) {
        applyDiff(ctx, child, oldV[k], newV[k]);
        continue;
      }
      if (k === "<<" || (path.length === 0 && k.startsWith("x-"))) throw lockedFail(ctx, child);
      if (!node.items.length && node.flow && !["context", "model_range"].includes(k))
        node.flow = false;
      const pair = new Y.Pair(new Y.Scalar(k), build(ctx, newV[k], child));
      insertPair(ctx, node, path, pair as never);
    }
    return;
  }

  // Everything else replaces the whole value at `path`.
  if (lockedBelow(ctx, path)) throw lockedFail(ctx, path);
  const old = nodeAt(Y, doc, path);

  if (Array.isArray(newV)) {
    const oldSeq = Y.isSeq(old) ? old : undefined;
    const pool = oldSeq ? [...oldSeq.items] : [];
    const seq = new Y.YAMLSeq();
    seq.items = newV.map((v, i) => {
      if (isScalarValue(v)) {
        // Keep an item that is still there as it was written, so its comment and quoting stay.
        const j = pool.findIndex((it) => Y.isScalar(it) && it.value === v);
        if (j >= 0) return pool.splice(j, 1)[0];
      }
      return build(ctx, v, [...path, String(i)]);
    }) as YAMLSeq["items"];
    // YAMLSeq.flow is undefined (not false) for a block list, so only an explicit true is flow.
    seq.flow = oldSeq ? oldSeq.flow === true : prefersFlow(newV);
    inherit(oldSeq, seq);
    setAt(ctx, path, seq);
    return;
  }

  if (isScalarValue(newV) && Y.isScalar(old)) {
    // Setting the value on the existing node keeps its line comment and style.
    const node = old as Scalar;
    node.value = newV;
    if (typeof newV !== "string") delete node.type;
    else if (newV.includes("\n") && node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED")
      node.type = "BLOCK_LITERAL";
    return;
  }

  const node = build(ctx, newV, path);
  inherit(old, node);
  setAt(ctx, path, node);
}

// --- warnings ---------------------------------------------------------------------------

/**
 * Non-blocking notes about a draft. `prev` is the draft on disk (null: no file yet, undefined:
 * unknown); with it, the warnings can tell what a change takes away from an active run.
 */
export function docWarnings(
  doc: SwarmDoc,
  activeRuns: readonly SwarmDocActiveRun[] = [],
  prev?: SwarmDoc | null,
): SwarmDocWarning[] {
  const out: SwarmDocWarning[] = [];
  const swarms = isPlain(doc.swarms) ? doc.swarms : {};
  for (const [name, s] of Object.entries(swarms)) {
    if (!isPlain(s)) continue;
    const agents = isPlain(s.agents) ? s.agents : {};
    const roles = Object.entries(agents).filter(([, r]) => isPlain(r));
    const max = typeof s.max_agents === "number" ? s.max_agents : DEFAULT_MAX_AGENTS;
    const total = roles.reduce((n, [, r]) => n + (typeof r.count === "number" ? r.count : 1), 0);
    if (total > max)
      out.push({
        path: `swarms.${name}.max_agents`,
        kind: "capacity",
        message: `${total} workers are configured (the counts add up) but max_agents is ${max}, so at most ${max} run at once`,
      });
    const stages = Array.isArray(s.stages) ? s.stages : [];
    if (s.topology === "pipeline" && stages.length) {
      const missing = roles.map(([r]) => r).filter((r) => !stages.includes(r));
      if (missing.length)
        out.push({
          path: `swarms.${name}.stages`,
          kind: "stages",
          message: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not listed in stages`,
        });
    }
    for (const [role, r] of roles) {
      const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
      if (!prompt)
        out.push({
          path: `swarms.${name}.agents.${role}.prompt`,
          kind: "prompt",
          message: "has no prompt; add one to tell the worker how to work",
        });
      else if (prompt.length > PROMPT_MAX * 0.8)
        out.push({
          path: `swarms.${name}.agents.${role}.prompt`,
          kind: "prompt",
          message: `is ${prompt.length} characters, close to the ${PROMPT_MAX.toLocaleString("en-US")} limit`,
        });
    }
  }

  const prevSwarms = prev && isPlain(prev.swarms) ? prev.swarms : {};
  for (const run of activeRuns) {
    const now = swarms[run.swarm];
    if (!isPlain(now)) {
      out.push({
        path: `swarms.${run.swarm}`,
        kind: "active-run",
        message: `run ${run.id} is using the swarm "${run.swarm}", which this draft removes or renames`,
      });
      continue;
    }
    const before = prevSwarms[run.swarm];
    const was = isPlain(before) && isPlain(before.agents) ? Object.keys(before.agents) : [];
    const has = isPlain(now.agents) ? now.agents : {};
    for (const role of was)
      if (!Object.hasOwn(has, role))
        out.push({
          path: `swarms.${run.swarm}.agents.${role}`,
          kind: "active-run",
          message: `run ${run.id} uses the role "${role}", which this draft removes or renames`,
        });
  }

  const enforcedBefore = !!prev && prev.enforce === true && prev.enabled !== false;
  if (doc.enforce === true && doc.enabled !== false && !enforcedBefore)
    out.push({
      path: "enforce",
      kind: "enforce",
      message:
        "with enforce on, only this file's swarm workers may run as subagents, and only during a run of their swarm (allowed_agents lists the exceptions)",
    });
  if (doc.enabled === false && prev !== null && !(prev && prev.enabled === false))
    out.push({
      path: "enabled",
      kind: "disable",
      message: "disabling swarms removes the generated agent files on the next sync",
    });
  return out;
}

// --- line diff --------------------------------------------------------------------------

const DIFF_MAX_LINES = 3000;
const DIFF_MAX_CELLS = 4_000_000;

/**
 * Which lines of `next` differ from `prev`, for marking them in a preview. The common head and
 * tail are skipped, and the middle is matched by longest common subsequence; above 3000 lines (or
 * a table over 4M cells) the whole middle counts as changed.
 */
export function lineDiff(prev: string, next: string): SwarmLineDiff {
  const a = prev.split(/\r?\n/);
  const b = next.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let ea = a.length;
  let eb = b.length;
  while (ea > head && eb > head && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - head;
  const m = eb - head;
  const range = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => from + i + 1);
  if (!n && !m) return { changed: [], removed: 0 };
  if (!n || !m || a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES || n * m > DIFF_MAX_CELLS)
    return { changed: range(head, eb), removed: n };

  // lcs[i][j]: longest common subsequence of a[head+i..] and b[head+j..]
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        a[head + i] === b[head + j]
          ? (lcs[(i + 1) * w + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
  const kept = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      kept.add(j);
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) i++;
    else j++;
  }
  const changed: number[] = [];
  for (let k = 0; k < m; k++) if (!kept.has(k)) changed.push(head + k + 1);
  return { changed, removed: n - kept.size };
}
