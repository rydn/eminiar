/**
 * Serena-style name paths: `method`, `Class/method`, `Class.method`, `/Class/method`
 * (absolute: must match the whole qualified name) and `src/x.ts#Class.method`
 * (restricted to one file). Graph names are `Outer.inner`.
 */
export interface NamePath {
  file?: string | undefined;
  segments: string[];
  absolute: boolean;
}

export function parseNamePath(input: string): NamePath {
  let s = input.trim();
  let file: string | undefined;
  const hash = s.indexOf("#");
  if (hash !== -1) {
    file = s.slice(0, hash).replace(/^\.\//, "") || undefined;
    s = s.slice(hash + 1);
  }
  const absolute = s.startsWith("/");
  const segments = s
    .replace(/^\/+/, "")
    .split(/[/.]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return { file, segments, absolute };
}

/** Does a qualified graph name satisfy the name path? */
export function matchesNamePath(name: string, np: NamePath, substring = false): boolean {
  if (!np.segments.length) return false;
  const joined = np.segments.join(".");
  if (np.absolute) return name === joined;
  if (!substring) return name === joined || name.endsWith(`.${joined}`);
  const parts = name.split(".");
  const tail = parts[parts.length - 1]!.toLowerCase();
  const head = parts.slice(0, -1).join(".");
  const want = np.segments[np.segments.length - 1]!.toLowerCase();
  const prefix = np.segments.slice(0, -1).join(".");
  return tail.includes(want) && (!prefix || head === prefix || head.endsWith(`.${prefix}`));
}

/** Does a node's path satisfy the file part of a name path (exact or suffix match)? */
export function matchesFile(path: string | null, file: string | undefined): boolean {
  if (!file) return true;
  if (!path) return false;
  return path === file || path.endsWith(`/${file}`);
}
