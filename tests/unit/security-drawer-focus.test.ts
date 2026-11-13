import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tabTarget } from "../../src/ui/web/focus-trap.js";

describe("the security drawer keeps Tab inside the dialog", () => {
  it("wraps from the last element to the first, and from the first back with Shift", () => {
    expect(tabTarget(3, 2, false)).toBe(0);
    expect(tabTarget(3, 0, true)).toBe(2);
  });

  it("leaves Tab between two inner elements to the browser", () => {
    expect(tabTarget(3, 0, false)).toBeNull();
    expect(tabTarget(3, 1, false)).toBeNull();
    expect(tabTarget(3, 1, true)).toBeNull();
    expect(tabTarget(3, 2, true)).toBeNull();
    // from the dialog itself, Tab goes to the first element in DOM order anyway
    expect(tabTarget(3, "dialog", false)).toBeNull();
  });

  it("pulls focus back in from the page behind, and Shift+Tab from the dialog itself", () => {
    expect(tabTarget(2, "outside", false)).toBe(0);
    expect(tabTarget(2, "outside", true)).toBe(1);
    expect(tabTarget(2, "dialog", true)).toBe(1);
    // one element: both directions stay on it
    expect(tabTarget(1, 0, false)).toBe(0);
    expect(tabTarget(1, 0, true)).toBe(0);
  });

  it("keeps focus on the dialog while it has nothing focusable (loading)", () => {
    expect(tabTarget(0, "outside", false)).toBe("dialog");
    expect(tabTarget(0, "dialog", true)).toBe("dialog");
  });

  it("the assessment drawer is a modal dialog that traps Tab and still closes on Escape", () => {
    const src = readFileSync("src/ui/web/views/SecurityPanel.tsx", "utf8");
    const drawer = src.slice(src.indexOf("function AssessmentDrawer"));
    expect(drawer).toContain('aria-modal="true"');
    expect(drawer).toMatch(/e\.key === "Escape"\) onClose\(\)/);
    expect(drawer).toMatch(/e\.key === "Tab"\) trapTab\(e, panel\.current\)/);
    expect(drawer).toContain("prev?.focus?.()");
    expect(src).toMatch(/tabTarget\(items\.length, at, e\.shiftKey\)/);
  });
});
