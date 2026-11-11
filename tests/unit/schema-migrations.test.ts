import { describe, expect, it } from "vitest";
import { migrations } from "../../src/storage/sqlite/schema.js";

/**
 * The runner applies every migration whose version is above meta.schema_version, in list
 * order. Two entries with one number, or a number lower than the one before it, would be
 * skipped on databases that already ran the higher one. Branches that pick the same number
 * (playbooks and feature/jev-integrations both took v10) must fail here when merged.
 */
describe("schema migrations", () => {
  it("versions are unique and strictly increasing, starting at 1", () => {
    const versions = migrations.map((m) => m.version);
    expect(versions[0]).toBe(1);
    const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(dupes, "duplicate migration versions").toEqual([]);
    for (let i = 1; i < versions.length; i++)
      expect(versions[i], `migration after v${versions[i - 1]}`).toBeGreaterThan(versions[i - 1]!);
  });

  it("every migration has sql or an up step", () => {
    for (const m of migrations) expect(Boolean(m.sql || m.up), `v${m.version}`).toBe(true);
  });
});
