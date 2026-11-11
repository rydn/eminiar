import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Options } from "tsup";

// Native and heavy deps stay external so they resolve from node_modules at runtime
// (better-sqlite3 has a .node binary; transformers/tree-sitter are large and optional).
const shared: Options = {
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  dts: false,
  shims: true,
  // Bundled CommonJS packages (fast-glob) call require() for Node builtins; give the
  // ESM output a real `require` so esbuild's shim does not throw at load time.
  banner: {
    js: 'import { createRequire as __emCreateRequire } from "node:module"; const require = __emCreateRequire(import.meta.url);',
  },
  // tsup externalises every package.json dependency by default, so zod, the MCP SDK
  // and fast-glob were resolved file by file from node_modules at start-up (~500
  // module loads, two thirds of the server's boot time). Bundling the pure-JS ones
  // leaves a handful of files to read; turndown stays external and is required lazily.
  noExternal: ["zod", "@modelcontextprotocol/sdk", "fast-glob", "ignore", "micromatch"],
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "@huggingface/transformers",
    "onnxruntime-node",
    "web-tree-sitter",
    "tsx",
  ],
};

/** Everything the hook build writes: dist/hook.js(.map) and its dist/hook-*.js(.map) chunks. */
const HOOK_OUTPUT = ["hook.js", "hook.js.map", "hook-*"];

export default defineConfig([
  {
    ...shared,
    entry: { server: "src/server.ts", cli: "src/cli.ts" },
    // One self-contained file per entry, no chunks. The MCP server and `eminiar ui` /
    // `eminiar upgrade` are long-lived processes run from the stable copy that `eminiar
    // upgrade` reinstalls in place: a chunk they had not loaded yet would vanish under them
    // (ERR_MODULE_NOT_FOUND until /mcp reconnect). Without splitting esbuild turns each
    // dynamic import() of an internal module into a lazy __esm wrapper, and wrappers spread
    // to everything that module imports: once that reached zod while the MCP SDK imported zod
    // eagerly, the SDK's top-level z.custom() ran before zod initialised and dist/server.js
    // crashed at start ("Class2 is not a constructor"). So everything the server reaches
    // imports internal modules statically (dynamic import() only for external packages), and
    // scripts/check-bundle.mjs, run by `npm run build`, fails the build if dist/server.js has
    // a lazy wrapper, either file references a chunk, or zod is wrapped while something loads
    // it eagerly. The CLI keeps its per-command dynamic imports (lazy, so `eminiar --version`
    // does not initialise everything); there zod is wrapped but only ever initialised by
    // other wrapped modules, and the SDK is not bundled, which the guard also checks.
    splitting: false,
    // Cleans dist except the hook build's output, which runs in parallel and cleans its own.
    clean: HOOK_OUTPUT.map((p) => `!${p}`),
  },
  {
    ...shared,
    entry: { hook: "src/hook.ts" },
    // The hook runs once per tool call, so it is split: the adjudicator (off by default) is
    // reached only through dynamic import() and lands in its own chunks, loaded when it is
    // enabled. Without splitting esbuild inlines those imports and every hook process pays
    // to parse them (~3 ms p50). Chunks sit next to hook.js, not in a subfolder, so
    // import.meta.url-relative paths (src/version.ts pluginRoot) resolve the same.
    splitting: true,
    clean: false,
    esbuildOptions(options) {
      options.chunkNames = "hook-[name]-[hash]";
    },
    esbuildPlugins: [
      {
        name: "clean-hook-output",
        setup(build) {
          // Chunk names carry a content hash, so drop the previous build's before writing.
          build.onStart(() => {
            if (!existsSync("dist")) return;
            for (const f of readdirSync("dist")) {
              if (f === "hook.js" || f === "hook.js.map" || f.startsWith("hook-")) {
                rmSync(join("dist", f), { force: true });
              }
            }
          });
        },
      },
    ],
  },
]);
