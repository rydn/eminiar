import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const installMock = vi.fn(async (_o: unknown) => 0);
vi.mock("../../src/install/install.js", () => ({ install: (o: unknown) => installMock(o) }));

import { modelInstalled, upgrade } from "../../src/install/upgrade.js";
import { paths } from "../../src/paths.js";

const saved = process.env.EMINIAR_HOME;
beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
});
afterAll(() => {
  if (saved === undefined) delete process.env.EMINIAR_HOME;
  else process.env.EMINIAR_HOME = saved;
});
beforeEach(() => {
  installMock.mockClear();
  mkdirSync(paths().models, { recursive: true });
  writeFileSync(
    paths().installFile,
    JSON.stringify({
      version: "0.0.1",
      method: "settings",
      node: "/usr/bin/node",
      stableRoot: "/x",
      fromSpec: "eminiar@0.0.1",
      installedAt: "now",
      wrote: { statusline: true },
    }),
  );
});

describe("upgrade", () => {
  it("does not download the embedding model when none was installed (--no-model)", async () => {
    expect(modelInstalled()).toBe(false);
    await upgrade();
    expect(installMock.mock.calls[0]?.[0]).toMatchObject({ noModel: true, statusline: true });
  });

  it("keeps refreshing the model when one is cached", async () => {
    mkdirSync(join(paths().models, "Xenova"), { recursive: true });
    expect(modelInstalled()).toBe(true);
    await upgrade();
    expect(installMock.mock.calls[0]?.[0]).toMatchObject({
      noModel: false,
      spec: "eminiar@latest",
      method: "settings",
      cursor: false,
    });
  });
});
