/**
 * A minimal focus trap for a modal dialog (aria-modal). The decision is pure (tabTarget, no DOM
 * types, so the unit tests load it without the web bundle); the dialog's keydown handler does the
 * querying and the focus() call.
 */

/** What can take focus inside the dialog. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Where focus is when Tab is pressed: the index of a focusable element, the dialog itself, or outside it. */
export type FocusAt = number | "dialog" | "outside";

/**
 * Where Tab (or Shift+Tab) must move focus so it never leaves the dialog: an element index,
 * "dialog" to keep it on the dialog (nothing focusable yet, such as while loading), or null to
 * let the browser move it (between two inner elements).
 */
export function tabTarget(count: number, at: FocusAt, shift: boolean): number | "dialog" | null {
  if (count <= 0) return "dialog";
  const last = count - 1;
  if (shift) return at === "outside" || at === "dialog" || at === 0 ? last : null;
  return at === "outside" || at === last ? 0 : null;
}
