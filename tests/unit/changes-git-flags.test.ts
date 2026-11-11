import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectChanges, isDiffRef } from "../../src/graph/changes.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";

// Only the git half of detectChanges runs here: the repo holds one file the index never saw.
const db = {
  fileIndexGet: () => undefined,
  graphGetNode: () => undefined,
  graphGetNodes: () => [],
  graphEdgesFrom: () => [],
  graphEdgesTo: () => [],
  metricsGet: () => [],
} as unknown as StorageAdapter;

describe("diff ref length", () => {
  it("accepts 256 characters and refuses 257", () => {
    expect(isDiffRef("a".repeat(256))).toBe(true);
    expect(isDiffRef("a".repeat(257))).toBe(false);
  });
  it("detectChanges refuses an over-long ref before running git", () => {
    expect(() => detectChanges(db, tmpdir(), { ref: "a".repeat(257) })).toThrow(/not a ref/);
  });
});

describe("detectChanges git flags", () => {
  it("never runs a textconv driver from the repo's own config", () => {
    const root = mkdtempSync(join(tmpdir(), "em-textconv-"));
    const marker = join(root, "..", `${root.split("/").pop()}-ran`);
    const sh = (c: string) => execSync(c, { cwd: root, stdio: "pipe" });
    sh("git init -q && git config user.email a@b.c && git config user.name t");
    writeFileSync(join(root, ".gitattributes"), "*.dat diff=marker\n");
    const driver = join(mkdtempSync(join(tmpdir(), "em-driver-")), "conv.sh");
    writeFileSync(driver, `#!/bin/sh\ntouch '${marker}'\ncat "$1"\n`, { mode: 0o755 });
    sh(`git config diff.marker.textconv '${driver}'`);
    writeFileSync(join(root, "a.dat"), "one\n");
    sh("git add . && git -c commit.gpgsign=false commit -qm one");
    writeFileSync(join(root, "a.dat"), "two\n");
    // sanity: plain git does run the driver, so the marker below proves the flag
    sh("git diff >/dev/null");
    expect(existsSync(marker)).toBe(true);
    execSync(`rm -f '${marker}'`);
    const c = detectChanges(db, root);
    expect(c.files.map((f) => f.path)).toContain("a.dat");
    expect(existsSync(marker)).toBe(false);
  });
});
