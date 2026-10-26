import { useEffect, useState } from "preact/hooks";

export const VIEWS = [
  "overview",
  "usage",
  "explore",
  "galaxy",
  "architecture",
  "history",
  "memory",
  "docs",
  "coverage",
  "sessions",
  "system",
] as const;
export type View = (typeof VIEWS)[number];

export interface Route {
  view: View;
  params: Record<string, string>;
}

/** `#/explore?file=src/x.ts` → { view: "explore", params: { file } }. */
function parse(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [v = "", qs = ""] = h.split("?");
  const view = (VIEWS as readonly string[]).includes(v) ? (v as View) : "overview";
  const params: Record<string, string> = {};
  for (const [k, val] of new URLSearchParams(qs)) params[k] = val;
  return { view, params };
}

export function navigate(view: View, params: Record<string, string | undefined> = {}): void {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  location.hash = `/${view}${s ? `?${s}` : ""}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
