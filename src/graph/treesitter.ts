import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import type { Language as TSLanguage, Node as TSNode, Parser as TSParser } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "../storage/types.js";
import { pluginRoot } from "../version.js";
import { fileId, pkgId, symId } from "./ids.js";
import { packageName, resolveImport } from "./resolve.js";

export type Grammar = "typescript" | "tsx" | "javascript";

export function grammarFor(path: string): Grammar | undefined {
  switch (extname(path).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return undefined;
  }
}

let parserMod: typeof import("web-tree-sitter") | undefined;
let parser: TSParser | undefined;
const languages = new Map<Grammar, TSLanguage>();

async function getParser(grammar: Grammar): Promise<TSParser> {
  if (!parserMod) {
    parserMod = await import("web-tree-sitter");
    await parserMod.Parser.init();
    parser = new parserMod.Parser();
  }
  let lang = languages.get(grammar);
  if (!lang) {
    const file = join(pluginRoot(), "vendor", "grammars", `${grammar}.wasm`);
    if (!existsSync(file)) throw new Error(`grammar missing: ${file}`);
    lang = await parserMod.Language.load(file);
    languages.set(grammar, lang);
  }
  parser!.setLanguage(lang);
  return parser!;
}

export interface ParsedFile {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Exported symbol names (for callers resolving imports). */
  exports: string[];
}

const DECL_TYPES: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  method_definition: "method",
  method_signature: "method",
  public_field_definition: "field",
  abstract_method_signature: "method",
};

/**
 * Walk a TS/JS syntax tree and emit graph nodes/edges for one file: file,
 * declarations (`sym:`), imports (resolved to files or `pkg:`), exports,
 * calls, extends/implements. Confidence reflects how sure the resolution is.
 */
export async function parseFile(root: string, rel: string, code: string): Promise<ParsedFile> {
  const grammar = grammarFor(rel);
  if (!grammar) return { nodes: [], edges: [], exports: [] };
  const p = await getParser(grammar);
  const tree = p.parse(code);
  if (!tree) return { nodes: [], edges: [], exports: [] };

  const fid = fileId(rel);
  const nodes: GraphNode[] = [
    { id: fid, kind: "file", name: rel, path: rel, source: "tree-sitter" },
  ];
  const edges: GraphEdge[] = [];
  const exportsList: string[] = [];
  /** local name → node id it refers to (imports and local declarations). */
  const scope = new Map<string, { id: string; confidence: number }>();
  const localSyms = new Map<string, string>();
  /** calls/references collected in pass 2, keyed (src, dst, kind) so repeats aggregate. */
  const refs = new Map<string, Ref>();

  const pushEdge = (e: GraphEdge) => edges.push({ confidence: 1, weight: 1, ...e });

  // Pass 1: imports and top-level declarations populate the scope.
  for (const stmt of tree.rootNode.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "import_statement") handleImport(stmt);
    else collectDecls(stmt, undefined, stmt.type === "export_statement");
  }
  // Pass 2: calls and identifier references inside declarations (heritage was pass 1).
  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt && stmt.type !== "import_statement") walkRefs(stmt);
  }
  flushRefs();
  return { nodes, edges, exports: exportsList };

  function handleImport(stmt: TSNode): void {
    const src =
      stmt.childForFieldName("source")?.namedChildren[0]?.text ??
      stmt.descendantsOfType("string_fragment")[0]?.text;
    if (!src) return;
    const names: string[] = [];
    for (const spec of stmt.descendantsOfType("import_specifier")) {
      const name = spec.childForFieldName("name")?.text;
      const alias = spec.childForFieldName("alias")?.text ?? name;
      if (name && alias) names.push(alias === name ? name : `${name} as ${alias}`);
      if (name && alias) registerImport(alias, name, src);
    }
    const clause = stmt.namedChildren.find((c) => c?.type === "import_clause");
    for (const c of clause?.namedChildren ?? []) {
      if (c?.type === "identifier") {
        names.push(`default as ${c.text}`);
        registerImport(c.text, "default", src);
      }
      if (c?.type === "namespace_import") {
        const alias = c.descendantsOfType("identifier")[0]?.text;
        if (alias) {
          names.push(`* as ${alias}`);
          registerImport(alias, "*", src);
        }
      }
    }
    const resolved = resolveImport(root, rel, src);
    const target = resolved ? fileId(resolved) : pkgId(packageName(src));
    if (!resolved)
      nodes.push({ id: target, kind: "package", name: packageName(src), source: "tree-sitter" });
    pushEdge({
      src: fid,
      dst: target,
      kind: "imports",
      source: "tree-sitter",
      confidence: resolved ? 0.95 : 1,
      meta: { names, spec: src },
    });
  }

  function registerImport(local: string, exported: string, spec: string): void {
    const resolved = resolveImport(root, rel, spec);
    if (resolved)
      scope.set(local, {
        id: symId(resolved, exported === "default" ? "default" : exported),
        confidence: 0.8,
      });
    else scope.set(local, { id: pkgId(packageName(spec)), confidence: 0.6 });
  }

  function declName(n: TSNode): string | undefined {
    return n.childForFieldName("name")?.text;
  }

  function collectDecls(n: TSNode, parentName: string | undefined, exported: boolean): void {
    if (n.type === "export_statement") {
      const decl =
        n.childForFieldName("declaration") ?? n.namedChildren.find((c) => c && DECL_TYPES[c.type]);
      if (decl) collectDecls(decl, parentName, true);
      else if (
        n.childForFieldName("value") ||
        n.namedChildren.some(
          (c) => c?.type === "lexical_declaration" || c?.type === "variable_declaration",
        )
      ) {
        for (const c of n.namedChildren) if (c) collectDecls(c, parentName, true);
      }
      for (const spec of n.descendantsOfType("export_specifier")) {
        const name = spec.childForFieldName("alias")?.text ?? spec.childForFieldName("name")?.text;
        if (name) exportsList.push(name);
      }
      return;
    }
    const kind = DECL_TYPES[n.type];
    if (kind) {
      const name = declName(n);
      if (!name) return;
      const qualified = parentName ? `${parentName}.${name}` : name;
      addSym(qualified, kind, n, exported && !parentName);
      if (kind === "class" || kind === "interface") {
        const body = n.childForFieldName("body");
        for (const m of body?.namedChildren ?? []) if (m) collectDecls(m, qualified, false);
        for (const h of n.descendantsOfType([
          "extends_clause",
          "implements_clause",
          "class_heritage",
        ])) {
          for (const idn of h.descendantsOfType([
            "identifier",
            "type_identifier",
            "member_expression",
          ])) {
            if (idn.parent?.type === "member_expression" && idn.type !== "member_expression")
              continue;
            const ref =
              scope.get(idn.text) ??
              (localSyms.has(idn.text)
                ? { id: localSyms.get(idn.text)!, confidence: 0.9 }
                : undefined);
            pushEdge({
              src: symId(rel, qualified),
              dst: ref?.id ?? symId(rel, idn.text),
              kind: h.type === "implements_clause" ? "implements" : "extends",
              source: "tree-sitter",
              confidence: ref?.confidence ?? 0.5,
            });
          }
        }
      }
      return;
    }
    if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
      for (const d of n.namedChildren) {
        if (d?.type !== "variable_declarator") continue;
        const name = declName(d);
        const value = d.childForFieldName("value");
        if (!name) continue;
        const k = value && /function|arrow_function/.test(value.type) ? "function" : "variable";
        addSym(parentName ? `${parentName}.${name}` : name, k, d, exported && !parentName);
      }
    }
  }

  function addSym(qualified: string, kind: string, n: TSNode, exported: boolean): void {
    const id = symId(rel, qualified);
    nodes.push({
      id,
      kind,
      name: qualified,
      path: rel,
      startLine: n.startPosition.row + 1,
      endLine: n.endPosition.row + 1,
      source: "tree-sitter",
      meta: exported ? { exported: true } : undefined,
    });
    pushEdge({ src: fid, dst: id, kind: "defines", source: "tree-sitter" });
    if (exported) {
      exportsList.push(qualified);
      pushEdge({ src: fid, dst: id, kind: "exports", source: "tree-sitter" });
    }
    if (!qualified.includes(".")) {
      localSyms.set(qualified, id);
      scope.set(qualified, { id, confidence: 0.9 });
    } else {
      localSyms.set(qualified, id);
    }
  }

  /**
   * The symbol a node sits in. Nested arrow functions and inner `const`s are not
   * symbols themselves, so the longest prefix of the declaration chain that is a
   * known symbol wins (a reference inside `run`'s inner callback belongs to `run`).
   */
  function enclosing(n: TSNode): string | undefined {
    const parts: string[] = [];
    let cur: TSNode | null = n.parent;
    while (cur) {
      if (DECL_TYPES[cur.type] || cur.type === "variable_declarator") {
        const name = declName(cur);
        if (name) parts.unshift(name);
      }
      cur = cur.parent;
    }
    for (let i = parts.length; i > 0; i--) {
      const q = parts.slice(0, i).join(".");
      if (localSyms.has(q)) return q;
    }
    return undefined;
  }

  /** Edges are keyed (src, dst, kind); repeated uses aggregate into count + first lines. */
  function pushRef(src: string, dst: string, kind: string, confidence: number, line: number): void {
    if (dst === src) return;
    const key = `${src}\u0000${dst}\u0000${kind}`;
    const cur = refs.get(key);
    if (cur) {
      cur.count++;
      cur.confidence = Math.max(cur.confidence, confidence);
      if (cur.lines.length < 5) cur.lines.push(line);
    } else refs.set(key, { src, dst, kind, confidence, count: 1, lines: [line] });
  }

  function flushRefs(): void {
    for (const r of refs.values()) {
      pushEdge({
        src: r.src,
        dst: r.dst,
        kind: r.kind,
        source: "tree-sitter",
        confidence: r.confidence,
        meta: { count: r.count, lines: r.lines },
      });
    }
  }

  /** `calls`: the callee of a call/new expression resolved through imports and locals. */
  function callTarget(
    fn: TSNode,
    caller: string | undefined,
  ): { id: string; confidence: number } | undefined {
    if (fn.type === "identifier" || fn.type === "type_identifier") return scope.get(fn.text);
    if (fn.type !== "member_expression") return undefined;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property")?.text;
    if (obj?.type === "this" && prop && caller) {
      return { id: symId(rel, `${caller.split(".")[0]!}.${prop}`), confidence: 0.9 };
    }
    if (obj?.type === "identifier" && prop) {
      const base = scope.get(obj.text);
      if (base?.id.startsWith("sym:"))
        return { id: `${base.id.replace(/#.*$/, "")}#${prop}`, confidence: 0.5 };
      if (base?.id.startsWith("pkg:")) return { id: base.id, confidence: 0.6 };
    }
    return undefined;
  }

  function walkRefs(n: TSNode): void {
    for (const call of n.descendantsOfType(["call_expression", "new_expression"])) {
      const fn = call.childForFieldName("function") ?? call.childForFieldName("constructor");
      if (!fn) continue;
      const caller = enclosing(call);
      const target = callTarget(fn, caller);
      if (!target) continue;
      pushRef(
        caller ? symId(rel, caller) : fid,
        target.id,
        "calls",
        target.confidence,
        call.startPosition.row + 1,
      );
    }
    // `references`: every other use of an imported or top-level name (values and types),
    // discounted so they never outrank calls/imports in impact scoring.
    for (const idn of n.descendantsOfType(["identifier", "type_identifier"])) {
      const p = idn.parent;
      if (!p || REF_SKIP_PARENT.has(p.type)) continue;
      if (p.childForFieldName("name")?.id === idn.id) continue; // the thing being declared
      const fn = p.childForFieldName("function") ?? p.childForFieldName("constructor");
      if (fn?.id === idn.id) continue; // callee: counted as a call
      if (p.type === "member_expression" && p.childForFieldName("object")?.id !== idn.id) continue;
      const target = scope.get(idn.text);
      if (!target) continue;
      const caller = enclosing(idn);
      pushRef(
        caller ? symId(rel, caller) : fid,
        target.id,
        "references",
        target.confidence * 0.9,
        idn.startPosition.row + 1,
      );
    }
    // `this.member` reads (not calls) inside a class.
    for (const me of n.descendantsOfType("member_expression")) {
      const prop = me.childForFieldName("property")?.text;
      if (me.childForFieldName("object")?.type !== "this" || !prop) continue;
      const p = me.parent;
      const callee = p
        ? (p.childForFieldName("function") ?? p.childForFieldName("constructor"))
        : null;
      if (callee?.id === me.id) continue;
      const caller = enclosing(me);
      if (!caller) continue;
      const member = `${caller.split(".")[0]!}.${prop}`;
      if (!localSyms.has(member)) continue;
      pushRef(symId(rel, caller), symId(rel, member), "references", 0.81, me.startPosition.row + 1);
    }
  }
}

type Ref = {
  src: string;
  dst: string;
  kind: string;
  confidence: number;
  count: number;
  lines: number[];
};

/** Parents under which an identifier is a declaration, a binding or already an edge of another kind. */
const REF_SKIP_PARENT = new Set([
  "import_specifier",
  "namespace_import",
  "import_clause",
  "export_specifier",
  "required_parameter",
  "optional_parameter",
  "rest_pattern",
  "array_pattern",
  "object_pattern",
  "pair_pattern",
  "catch_clause",
  "extends_clause",
  "implements_clause",
  "class_heritage",
  "extends_type_clause",
  "property_signature",
  "method_signature",
  "labeled_statement",
]);
