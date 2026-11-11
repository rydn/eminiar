import { beforeEach, describe, expect, it, vi } from "vitest";

const listProjects = vi.fn(
  (): Array<{ id: string; root: string | null }> => [{ id: "a", root: "/work/listed" }],
);
vi.mock("../../src/ui/api.js", async (orig) => ({
  ...(await orig<typeof import("../../src/ui/api.js")>()),
  listProjects: () => listProjects(),
}));

const { requestRoot, resetProjectListCache } = await import("../../src/ui/server.js");

beforeEach(() => {
  resetProjectListCache();
  listProjects.mockClear();
});

describe("requestRoot", () => {
  it("accepts listed projects and the default root", () => {
    expect(requestRoot("/work/listed", "/work/home")).toBe("/work/listed");
    expect(requestRoot("/work/home", "/work/home")).toBe("/work/home");
  });
  it("ignores an unlisted root and falls back to the default", () => {
    expect(requestRoot("/etc", "/work/home")).toBe("/work/home");
    expect(requestRoot("/etc")).toBeUndefined();
  });
  it("uses the default when no root is asked for", () => {
    expect(requestRoot(null, "/work/home")).toBe("/work/home");
  });
  it("normalizes a trailing slash and dot segments", () => {
    expect(requestRoot("/work/listed/", "/work/home")).toBe("/work/listed");
    expect(requestRoot("/work/x/../listed", "/work/home")).toBe("/work/listed");
    expect(requestRoot("/work/home/", "/work/home")).toBe("/work/home");
  });
  it("falls back to the default when the project list throws, and does not cache the failure", () => {
    listProjects.mockImplementationOnce(() => {
      throw new Error("unreadable");
    });
    expect(requestRoot("/work/listed", "/work/home")).toBe("/work/home");
    expect(requestRoot("/work/listed", "/work/home")).toBe("/work/listed");
  });
  it("lists the projects once for many requests, not once per request", () => {
    for (let i = 0; i < 50; i++) requestRoot("/work/listed", "/work/home");
    expect(listProjects).toHaveBeenCalledTimes(1);
  });
});
