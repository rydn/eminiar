import type { ComponentChildren, JSX } from "preact";
import { cls } from "../util.js";
import { GLYPH, roleColor, type StateWord, stateClass } from "./style.js";

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
