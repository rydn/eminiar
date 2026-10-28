import { Component, type ComponentChildren, type FunctionComponent, h, type JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { cls } from "../util.js";
import { GLYPH, roleColor, type StateWord, stateClass } from "./style.js";

/**
 * Server-clock now (client clock + `skew`) at every render, re-rendering the caller every
 * `step` ms while `live` and the tab is visible. Each panel ticks at the rate it needs, so
 * a big task board is not redrawn every second for the elapsed counter.
 */
export function useNow(step: number, live: boolean, skew: number): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, step);
    return () => clearInterval(t);
  }, [step, live]);
  return Date.now() + skew;
}

/** `C`, re-rendered only when one of its props changes (shallow), like compat's `memo`. */
export function pure<P extends object>(C: FunctionComponent<P>): FunctionComponent<P> {
  class Pure extends Component<P> {
    override shouldComponentUpdate(next: P): boolean {
      const a = this.props as Record<string, unknown>;
      const b = next as Record<string, unknown>;
      for (const k in b) if (a[k] !== b[k]) return true;
      for (const k in a) if (!(k in b)) return true;
      return false;
    }
    override render(props: P) {
      return h(C, props);
    }
  }
  return Pure as unknown as FunctionComponent<P>;
}

/** Enter / Space on the element itself (not on a control inside it) runs `fn`. */
export const onActivate =
  (fn: () => void) =>
  (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };

/** A state as glyph + word (colour is a third cue, never the only one). */
export function State({
  s,
  word,
  title,
}: {
  s: StateWord;
  word?: string;
  title?: string;
}): JSX.Element {
  return (
    <span class={cls("sw-state", stateClass(s))} title={title}>
      <span class="g" aria-hidden="true">
        {GLYPH[s]}
      </span>
      {word ?? s}
    </span>
  );
}

export function RoleChip({
  role,
  roles,
  title,
  label,
  children,
}: {
  role: string | null | undefined;
  roles: string[];
  title?: string | undefined;
  /** Text to show instead of the role name (an author like `coder@a1b2c3`). */
  label?: string | undefined;
  children?: ComponentChildren;
}): JSX.Element {
  return (
    <span class="sw-chip" style={`--rc:${roleColor(role, roles)}`} title={title}>
      {label ?? role ?? "any role"}
      {children}
    </span>
  );
}

/** `Title ──────── meta` section header, drawn in mono like a terminal panel. */
export function Head({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ComponentChildren;
  children?: ComponentChildren;
}): JSX.Element {
  return (
    <div class="sw-head">
      <span class="t">{title}</span>
      <span class="rule" aria-hidden="true" />
      {meta !== undefined && meta !== null && meta !== "" ? <span class="m">{meta}</span> : null}
      {children}
    </div>
  );
}
