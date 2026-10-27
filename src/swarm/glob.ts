/**
 * Minimal path globs for swarm role scopes: `**` (any depth), `*` and `?` (within a
 * segment), `{a,b}` alternatives. A pattern without glob characters matches the path
 * itself and everything under it (`src/ui` covers `src/ui/web/app.tsx`).
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  const g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  let re: string;
  if (!/[*?{]/.test(g)) {
    re = `^${escapeRe(g)}(?:/.*)?$`;
  } else {
    let out = "";
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!;
      if (c === "*") {
        if (g[i + 1] === "*") {
          const slash = g[i + 2] === "/";
          out += slash ? "(?:.*/)?" : ".*";
          i += slash ? 2 : 1;
        } else out += "[^/]*";
      } else if (c === "?") out += "[^/]";
      else if (c === "{") {
        const end = g.indexOf("}", i);
        if (end === -1) out += "\\{";
        else {
          out += `(?:${g
            .slice(i + 1, end)
            .split(",")
            .map(escapeRe)
            .join("|")})`;
          i = end;
        }
      } else out += escapeRe(c);
    }
    re = `^${out}$`;
  }
  const rx = new RegExp(re);
  if (cache.size > 256) cache.clear();
  cache.set(glob, rx);
  return rx;
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** True when `path` (project-relative) matches any glob; an empty glob list matches all. */
export function inScope(path: string, globs: string[]): boolean {
  if (!globs.length) return true;
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => globToRegExp(g).test(p));
}
