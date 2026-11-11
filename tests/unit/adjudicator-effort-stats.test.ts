import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { formatStats } from "../../src/tools/em_adjudicate.js";

let db: SqliteAdapter;
const config = ConfigSchema.parse({});

beforeEach(() => {
  db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-effstats-")), "eminiar.db"), {
    vectors: false,
  });
});
afterEach(() => db.close());

/** An agent dispatch younger than the settle window, so formatStats' reconcile leaves it alone. */
function agent(scores: Record<string, unknown> | string) {
  db.adjudicator.insert({
    surface: "agent",
    inputHash: "h",
    ts: Date.now(),
    scores: typeof scores === "string" ? scores : JSON.stringify(scores),
  });
}

const effortLine = (out: string) => out.split("\n").find((l) => l.startsWith("effort followed"));

describe("em_adjudicate stats: effort follow line (#170)", () => {
  it("prints the rate and the counts, with set-but-not-run when some were", () => {
    agent({ effortFollow: "followed", passedEffort: "high", actualEffort: "high" });
    agent({ effortFollow: "followed", passedEffort: "max", actualEffort: "high" });
    agent({ effortFollow: "ignored", actualEffort: "medium" });
    const out = formatStats(db, config);
    expect(effortLine(out)).toBe(
      "effort followed 67% (2 followed, 1 ignored of 3) · set but not run 1",
    );
    // it sits right after the model-advice line
    const lines = out.split("\n");
    const at = lines.findIndex((l) => l.startsWith("advice followed"));
    expect(lines[at + 1]).toBe(effortLine(out));
  });

  it("omits the set-but-not-run suffix when nothing was set and not run", () => {
    agent({ effortFollow: "followed", passedEffort: "high", actualEffort: "high" });
    agent({ effortFollow: "followed", actualEffort: "low" });
    expect(effortLine(formatStats(db, config))).toBe(
      "effort followed 100% (2 followed, 0 ignored of 2)",
    );
  });

  it("prints no effort line without effort verdicts (old rows, garbage scores)", () => {
    agent({ passedEffort: "high" });
    agent("{not json");
    agent({ features: {} });
    const out = formatStats(db, config);
    expect(out).toContain("advice followed");
    expect(out).not.toContain("effort followed");
    expect(out).not.toContain("set but not run");
  });

  it("keeps the model-advice line unchanged next to the effort line", () => {
    agent({ effortFollow: "ignored", actualEffort: "low" });
    const out = formatStats(db, config);
    expect(out).toContain("advice followed – · applied – · respected –");
    expect(effortLine(out)).toBe("effort followed 0% (0 followed, 1 ignored of 1)");
  });
});
