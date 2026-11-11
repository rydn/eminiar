import { describe, expect, it } from "vitest";
import { PLAYBOOK_TABS, parseHash, playbookTab, routeHash } from "../../src/ui/web/route.js";

describe("Playbooks sections are linkable", () => {
  it("reads the section from the hash, so reload, Back and Forward keep it", () => {
    for (const t of PLAYBOOK_TABS) {
      const r = parseHash(`#${routeHash("playbooks", { tab: t })}`);
      expect(r.view).toBe("playbooks");
      expect(playbookTab(r.params.tab)).toBe(t);
    }
    expect(parseHash("#/playbooks?tab=history").params).toEqual({ tab: "history" });
  });
  it("falls back to the first section for no tab or an unknown one", () => {
    expect(playbookTab(undefined)).toBe("playbooks");
    expect(playbookTab("")).toBe("playbooks");
    expect(playbookTab("nope")).toBe("playbooks");
    expect(playbookTab("__proto__")).toBe("playbooks");
    expect(playbookTab(parseHash("#/playbooks").params.tab)).toBe("playbooks");
  });
  it("keeps the view, and an unknown sub-path does not become one", () => {
    const r = parseHash("#/playbooks/other?tab=suggested");
    expect(r).toMatchObject({ view: "playbooks", sub: null, params: { tab: "suggested" } });
  });
});
