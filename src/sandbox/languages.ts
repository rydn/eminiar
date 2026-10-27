import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { paths } from "../paths.js";

const require = createRequire(import.meta.url);

/** Find an executable on PATH (no shell). */
export function findOnPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

export interface Language {
  id: string;
  aliases: string[];
  ext: string;
  /** Resolves the interpreter; undefined when not installed. */
  detect: () => string | undefined;
  /** argv to run `file` (code already written to it). `bin` is the detect() result. */
  argv: (bin: string, file: string) => string[];
  /** Text to prepend to the snippet before it is written, or undefined to write it as is. */
  preamble?: ((code: string) => string | undefined) | undefined;
}

/**
 * Snippets run as ES modules (the scratch file is `.mjs`; tsx follows the nearest
 * package.json), where `require` does not exist. Claude writes `require('fs')` all the
 * time, so give it one unless the snippet declares its own. The preamble is exactly ONE
 * line (no trailing newline inside it) so stack-trace line numbers are off by one at most.
 *
 * The scratch file lives under ~/.eminiar/tmp, so a `require` anchored on it would look for
 * packages there and resolve `./x` against it. The sandbox exports the project root as
 * EMINIAR_PROJECT_ROOT, so anchor on a (not necessarily existing) file in the root instead:
 * bare names come from the project's node_modules and relative paths resolve against the
 * cwd, as they do in a script of the project.
 */
export const REQUIRE_PREAMBLE =
  'import { createRequire } from "node:module"; const require = createRequire(process.env.EMINIAR_PROJECT_ROOT ? process.env.EMINIAR_PROJECT_ROOT + "/package.json" : import.meta.url);';

export function requirePreamble(code: string): string | undefined {
  if (!/\brequire\s*\(/.test(code)) return undefined;
  if (/\b(?:const|let|var|function)\s+require\b/.test(code) || /\bcreateRequire\b/.test(code)) {
    return undefined;
  }
  return `${REQUIRE_PREAMBLE}\n`;
}

/** The code as it will be written to the scratch file: the language's preamble, then the snippet. */
export function prepareCode(lang: Language, code: string): string {
  const pre = lang.preamble?.(code);
  if (!pre) return code;
  // A hashbang only counts on the very first line: keep it there, preamble second.
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    return nl === -1 ? `${code}\n${pre}` : code.slice(0, nl + 1) + pre + code.slice(nl + 1);
  }
  return pre + code;
}

function preferredShell(): string {
  const sh = process.env.SHELL ?? "";
  if (/\/(zsh|bash)$/.test(sh) && existsSync(sh)) return sh;
  return findOnPath("bash") ?? findOnPath("zsh") ?? "/bin/sh";
}

let tsxPath: string | undefined;
function tsxCli(): string {
  tsxPath ??= require.resolve("tsx/cli");
  return tsxPath;
}

const detectCache = new Map<string, { bin: string | undefined; at: number }>();
const MISS_TTL_MS = 10_000;

/**
 * `detect()` memoised for the life of the process. Finding an interpreter walks every
 * PATH entry with a stat each; a found binary is remembered for good (a vanished one
 * surfaces as a spawn error), a missing one is re-checked after a short while so an
 * install during the session is picked up.
 */
export function detectInterpreter(lang: Language): string | undefined {
  const hit = detectCache.get(lang.id);
  if (hit && (hit.bin !== undefined || Date.now() - hit.at < MISS_TTL_MS)) return hit.bin;
  const bin = lang.detect();
  detectCache.set(lang.id, { bin, at: Date.now() });
  return bin;
}

export const LANGUAGES: Language[] = [
  {
    id: "shell",
    aliases: ["sh", "bash", "zsh"],
    ext: ".sh",
    detect: preferredShell,
    argv: (bin, file) => [bin, file],
  },
  {
    id: "javascript",
    aliases: ["js", "node", "mjs"],
    ext: ".mjs",
    detect: () => process.execPath,
    argv: (bin, file) => [bin, "--no-warnings", file],
    preamble: requirePreamble,
  },
  {
    id: "typescript",
    aliases: ["ts"],
    ext: ".ts",
    detect: () => process.execPath,
    argv: (bin, file) => [bin, "--no-warnings", tsxCli(), file],
    preamble: requirePreamble,
  },
  {
    id: "python",
    aliases: ["py", "python3"],
    ext: ".py",
    detect: () => findOnPath("python3") ?? findOnPath("python"),
    argv: (bin, file) => [bin, file],
  },
  {
    id: "ruby",
    aliases: ["rb"],
    ext: ".rb",
    detect: () => findOnPath("ruby"),
    argv: (b, f) => [b, f],
  },
  {
    id: "go",
    aliases: ["golang"],
    ext: ".go",
    detect: () => findOnPath("go"),
    argv: (b, f) => [b, "run", f],
  },
  { id: "php", aliases: [], ext: ".php", detect: () => findOnPath("php"), argv: (b, f) => [b, f] },
  {
    id: "perl",
    aliases: ["pl"],
    ext: ".pl",
    detect: () => findOnPath("perl"),
    argv: (b, f) => [b, f],
  },
  {
    id: "r",
    aliases: ["rscript"],
    ext: ".R",
    detect: () => findOnPath("Rscript"),
    argv: (b, f) => [b, f],
  },
  {
    id: "elixir",
    aliases: ["exs"],
    ext: ".exs",
    detect: () => findOnPath("elixir"),
    argv: (b, f) => [b, f],
  },
  {
    id: "rust",
    aliases: ["rs"],
    ext: ".rs",
    detect: () => (findOnPath("cargo") && findOnPath("rustc") ? findOnPath("rustc") : undefined),
    // compile-and-run via a tiny shell wrapper; the binary lands next to the source
    argv: (bin, file) => [
      preferredShell(),
      "-c",
      `"${bin}" -o "${file}.bin" "${file}" && "${file}.bin"`,
    ],
  },
  {
    id: "csharp",
    aliases: ["cs", "dotnet-script"],
    ext: ".csx",
    detect: () => findOnPath("dotnet-script"),
    argv: (b, f) => [b, f],
  },
];

export function resolveLanguage(name: string): Language | undefined {
  const n = name.toLowerCase();
  return LANGUAGES.find((l) => l.id === n || l.aliases.includes(n));
}

export function availableLanguages(): Array<{ id: string; bin: string | undefined }> {
  return LANGUAGES.map((l) => {
    let bin: string | undefined;
    try {
      bin = l.detect();
    } catch {
      bin = undefined;
    }
    return { id: l.id, bin };
  });
}

let scratchDir: string | undefined;

/** Write code to a scratch file under ~/.eminiar/tmp and return its path. */
export function writeScratch(code: string, ext: string): string {
  const dir = paths().tmp;
  if (scratchDir !== dir) {
    mkdirSync(dir, { recursive: true });
    scratchDir = dir;
  }
  const file = join(dir, `em-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  try {
    writeFileSync(file, code, { mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The directory was removed under us (tmp cleaners); recreate once and retry.
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, code, { mode: 0o600 });
  }
  return file;
}
