import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PROJECT_RELATIVE_PATH_RE } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { exportSkill } from "../../src/playbooks/export.js";
import { gitIgnoredFor, gitTrackedIn } from "../../src/playbooks/git.js";
import { write } from "../../src/playbooks/store.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emPlaybook } from "../../src/tools/em_playbook.js";

/**
 * Round 3 security fixes around git and the skill export (tasks #288 and #289 of swarm run
 * 20261111-e068a8): pathspec magic in the path git is asked about (R3-1), a repo-local `git`
 * found through a relative PATH entry (R3-2), and a symlink swap redirecting the export's mkdir
 * and chmod outside the project (R3-3). Real temporary repositories; skipped without git.
 */

/** A hook the fs wrapper below calls before the wrapped call, to swap a path at the worst time. */
const race = vi.hoisted(() => ({
  before: undefined as undefined | ((op: string, path: unknown) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const wrap =
    <K extends "mkdirSync" | "chmodSync" | "fchmodSync" | "openSync">(name: K) =>
    (...args: unknown[]) => {
      race.before?.(name, args[0]);
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    };
  const fs = {
    ...real,
    mkdirSync: wrap("mkdirSync"),
    chmodSync: wrap("chmodSync"),
    fchmodSync: wrap("fchmodSync"),
    openSync: wrap("openSync"),
  };
  return { ...fs, default: fs };
});

const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
) as NodeJS.ProcessEnv;
const hasGit = spawnSync("git", ["--version"], { env: gitEnv }).status === 0;
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@e.st", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv,
  });

function project(files: Record<string, string> = {}): {
  root: string;
  ctx: ProjectContext;
  db: StorageAdapter;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "em-r3git-")));
  writeFileSync(join(root, "package.json"), "{}");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  resetContextCache();
  const ctx = getContext(root);
  expect(ctx.root).toBe(root);
  return { root, ctx, db: getStorage(ctx) };
}

const status = (root: string) =>
  git(root, "status", "--porcelain", "-uall").stdout.trim().split("\n").filter(Boolean);
const mode = (p: string) => statSync(p).mode & 0o777;
const tool = async (ctx: ProjectContext, args: Record<string, unknown>) => {
  const r = await emPlaybook.handler(args as never, ctx);
  return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
};

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-r3git-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
});
afterEach(() => {
  race.before = undefined;
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

describe.skipIf(!hasGit)("R3-1 pathspec magic never makes git answer for another path", () => {
  const magic = [":/dist", ":(top)dist", ":(glob)dist", ":(icase)DIST", ":!x", ":^x"];

  for (const m of magic) {
    it(`gitIgnoredFor treats ${JSON.stringify(m)} as a literal folder name`, () => {
      const { root } = project({ ".gitignore": "/dist/\n" });
      git(root, "init", "-q");
      expect(gitIgnoredFor(root, "dist/x.md")).toBe("ignored");
      expect(gitIgnoredFor(root, `${m}/x.md`)).not.toBe("ignored");
      expect(gitIgnoredFor(root, join(root, `${m}/x.md`))).not.toBe("ignored");
      // below an existing folder, so the magic is the first component git sees
      mkdirSync(join(root, "sub"));
      expect(gitIgnoredFor(root, `sub/${m}/x.md`)).not.toBe("ignored");
    });
  }

  it("a literal ':' folder that is ignored is still ignored", () => {
    const { root } = project({ ".gitignore": "/:/\n" });
    git(root, "init", "-q");
    expect(gitIgnoredFor(root, ":/dist/x.md")).toBe("ignored");
  });

  it("gitTrackedIn lists the files of the literal folder, not of the top-level one", () => {
    const { root } = project({ "a/t.md": "x" });
    git(root, "init", "-q");
    git(root, "add", "a/t.md");
    expect(gitTrackedIn(root, "a")).toEqual(["t.md"]);
    expect(gitTrackedIn(root, ":/a")).toEqual([]);
    expect(gitTrackedIn(root, ":(top)a")).toEqual([]);
    mkdirSync(join(root, ":(top)a"));
    expect(gitTrackedIn(root, ":(top)a")).toEqual([]);
  });

  for (const target of [":/dist", ":(top)dist", ":/dist/x"]) {
    it(`MCP export of a private playbook to ${JSON.stringify(target)} is refused`, async () => {
      const { root, ctx, db } = project({ ".gitignore": "/dist/\n.eminiar/playbooks-private/\n" });
      git(root, "init", "-q");
      write(ctx, db, { name: "mine", title: "Mine", prompt: "internal runbook", private: true });
      const r = await tool(ctx, { action: "export", name: "mine", format: "skill", target });
      expect(r.isError).toBe(true);
      expect(existsSync(join(root, target))).toBe(false);
      expect(existsSync(join(root, ":"))).toBe(false);
      expect(status(root).filter((l) => l.includes("SKILL.md"))).toEqual([]);
      expect(() => exportSkill(ctx, db, "mine", { targetDir: target })).toThrow();
      expect(existsSync(join(root, ":"))).toBe(false);
    });
  }

  it("the default and a plain ignored target still export", () => {
    const { root, ctx, db } = project({ ".gitignore": "/dist/\n.eminiar/playbooks-private/\n" });
    git(root, "init", "-q");
    write(ctx, db, { name: "mine", title: "Mine", prompt: "internal runbook", private: true });
    expect(exportSkill(ctx, db, "mine", { targetDir: "dist" }).path).toBe(
      join(root, "dist/mine/SKILL.md"),
    );
    expect(status(root).filter((l) => l.includes("SKILL.md"))).toEqual([]);
  });

  it("the config path rule refuses a leading ':'", () => {
    for (const p of [":/foo", ":(top)foo", "./:/foo", ":foo"])
      expect(PROJECT_RELATIVE_PATH_RE.test(p), p).toBe(false);
    for (const p of ["foo/:/bar", "ab:c", ".eminiar/playbooks-private"])
      expect(PROJECT_RELATIVE_PATH_RE.test(p), p).toBe(true);
  });

  it("a committed privateDir ':/foo' cannot put a private playbook where git commits it", () => {
    const { root } = project({
      "eminiar.config.json": JSON.stringify({ playbooks: { privateDir: ":/foo" } }),
      ".gitignore": "/foo/\n",
    });
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "hostile");
    resetContextCache();
    const ctx = getContext(root);
    expect(ctx.config.playbooks.privateDir).not.toBe(":/foo");
    const db = getStorage(ctx);
    try {
      write(ctx, db, { name: "mine", title: "Mine", prompt: "call Bob", private: true });
    } catch {
      /* refusing is fine too */
    }
    expect(existsSync(join(root, ":"))).toBe(false);
    expect(status(root).filter((l) => l.includes("mine"))).toEqual([]);
    git(root, "add", "-A");
    expect(git(root, "diff", "--cached", "--name-only").stdout).not.toContain("mine");
  });
});

describe.skipIf(!hasGit)("R3-2 a repo-local git is never run", () => {
  const realPath = process.env.PATH ?? "";
  afterEach(() => {
    process.env.PATH = realPath;
  });

  function planted() {
    const { root } = project();
    git(root, "init", "-q");
    const marker = join(root, "PWNED");
    const fake = `#!/bin/sh\necho "$@" > '${marker}'\nexit 0\n`;
    for (const d of [".eminiar", ".eminiar/bin", "bin"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "git"), fake);
      chmodSync(join(root, d, "git"), 0o755);
    }
    return { root, marker };
  }

  for (const lead of ["", ".", "bin", "./bin", "../bin"]) {
    it(`PATH starting with ${JSON.stringify(lead)} does not find the project's git`, () => {
      const { root, marker } = planted();
      process.env.PATH = `${lead}${delimiter}${realPath}`;
      // the fake exits 0 ("ignored"); the real git says the folder is not ignored
      expect(gitIgnoredFor(root, ".eminiar/playbooks-private/probe.md")).toBe("not-ignored");
      expect(gitIgnoredFor(root, ".eminiar/bin/x/probe.md")).toBe("not-ignored");
      expect(gitTrackedIn(root, ".eminiar")).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    });
  }

  it("with only relative PATH entries git cannot be found, so the answer is unknown", () => {
    const { root, marker } = planted();
    process.env.PATH = ["", ".", "bin"].join(delimiter);
    expect(gitIgnoredFor(root, ".eminiar/playbooks-private/probe.md")).toBe("unknown");
    expect(gitTrackedIn(root, ".eminiar")).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });
});

describe.skipIf(!hasGit)(
  "R3-3 a swapped folder never redirects the export's mkdir or chmod",
  () => {
    function setup(priv: boolean) {
      const { root, ctx, db } = project({ ".gitignore": "/t/\n.eminiar/playbooks-private/\n" });
      git(root, "init", "-q");
      write(ctx, db, { name: "pub", title: "Pub", prompt: "private steps", private: priv });
      const out = realpathSync(mkdtempSync(join(tmpdir(), "em-r3git-out-")));
      const t = join(root, "t");
      let swapped = false;
      const swap = () => {
        if (swapped) return;
        swapped = true;
        rmSync(t, { recursive: true, force: true });
        symlinkSync(out, t);
      };
      return { root, ctx, db, out, t, swap };
    }

    it("t swapped for a link just before the skill folder is made: nothing appears outside", () => {
      const { ctx, db, out, t, swap } = setup(false);
      race.before = (op, p) => {
        if (op === "mkdirSync" && typeof p === "string" && p.startsWith(`${t}/`)) swap();
      };
      expect(() => exportSkill(ctx, db, "pub", { targetDir: "t" })).toThrow(/outside/);
      race.before = undefined;
      expect(readdirSync(out)).toEqual([]);
    });

    it("t swapped for a link just before the private folder is tightened: the outside folder keeps its mode", () => {
      const { ctx, db, out, t, swap } = setup(true);
      mkdirSync(join(t, "pub"), { recursive: true });
      chmodSync(join(t, "pub"), 0o755);
      mkdirSync(join(out, "pub"));
      chmodSync(join(out, "pub"), 0o755);
      const dir = join(t, "pub");
      race.before = (op, p) => {
        if (op === "chmodSync" || op === "fchmodSync" || (op === "openSync" && p === dir)) swap();
      };
      expect(() => exportSkill(ctx, db, "pub", { targetDir: "t" })).toThrow(/outside/);
      race.before = undefined;
      expect(mode(join(out, "pub"))).toBe(0o755);
      expect(readdirSync(join(out, "pub"))).toEqual([]);
    });

    it("without a race a private export still makes a 0700 folder and a 0600 file", () => {
      const { root, ctx, db } = setup(true);
      mkdirSync(join(root, "t/pub"), { recursive: true });
      chmodSync(join(root, "t/pub"), 0o755);
      const r = exportSkill(ctx, db, "pub", { targetDir: "t" });
      expect(mode(join(root, "t/pub"))).toBe(0o700);
      expect(mode(r.path)).toBe(0o600);
      const fresh = exportSkill(ctx, db, "pub", { targetDir: "t/deeper/still" });
      expect(mode(join(root, "t/deeper/still/pub"))).toBe(0o700);
      expect(mode(fresh.path)).toBe(0o600);
    });

    it("a symlinked parent inside the project still works", () => {
      const { root, ctx, db } = setup(false);
      mkdirSync(join(root, "real/skills"), { recursive: true });
      symlinkSync(join(root, "real"), join(root, "link"));
      const r = exportSkill(ctx, db, "pub", { targetDir: "link/skills" });
      expect(existsSync(join(root, "real/skills/pub/SKILL.md"))).toBe(true);
      expect(r.path).toBe(join(root, "link/skills/pub/SKILL.md"));
    });
  },
);
