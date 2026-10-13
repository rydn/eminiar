import { describe, expect, it } from "vitest";
import { matchesFile, matchesNamePath, parseNamePath } from "../../src/code/namepath.js";

describe("name paths", () => {
  it("parses the Serena-style forms", () => {
    expect(parseNamePath("run")).toEqual({ file: undefined, segments: ["run"], absolute: false });
    expect(parseNamePath("Service/run")).toMatchObject({ segments: ["Service", "run"] });
    expect(parseNamePath("Service.run")).toMatchObject({ segments: ["Service", "run"] });
    expect(parseNamePath("/Service/run")).toMatchObject({
      segments: ["Service", "run"],
      absolute: true,
    });
    expect(parseNamePath("./src/x.ts#Outer.inner")).toEqual({
      file: "src/x.ts",
      segments: ["Outer", "inner"],
      absolute: false,
    });
  });

  it("matches qualified names by suffix, exactly when absolute, loosely with substring", () => {
    const run = parseNamePath("run");
    expect(matchesNamePath("Service.run", run)).toBe(true);
    expect(matchesNamePath("run", run)).toBe(true);
    expect(matchesNamePath("Service.runner", run)).toBe(false);
    expect(matchesNamePath("Service.runner", run, true)).toBe(true);
    expect(matchesNamePath("Service.run", parseNamePath("/run"))).toBe(false);
    expect(matchesNamePath("Service.run", parseNamePath("/Service/run"))).toBe(true);
    expect(matchesNamePath("Outer.Service.run", parseNamePath("Service/run"))).toBe(true);
    expect(matchesNamePath("Other.run", parseNamePath("Service/run"))).toBe(false);
    expect(matchesNamePath("Service.inner", parseNamePath("Service/inn"), true)).toBe(true);
    expect(matchesNamePath("Base.inner", parseNamePath("Service/inn"), true)).toBe(false);
  });

  it("matches files exactly or by path suffix", () => {
    expect(matchesFile("src/x.ts", undefined)).toBe(true);
    expect(matchesFile("src/x.ts", "src/x.ts")).toBe(true);
    expect(matchesFile("src/x.ts", "x.ts")).toBe(true);
    expect(matchesFile("src/ax.ts", "x.ts")).toBe(false);
    expect(matchesFile(null, "x.ts")).toBe(false);
  });
});
