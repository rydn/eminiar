import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * bin/_resolve.sh: the shims run their own dist/ when it is built and dependencies resolve
 * next to them, and otherwise fall back to the stable copy pinned in $EMINIAR_HOME/root-path
 * (Claude Code's plugin cache has dist/ but no node_modules/, or, copied from a git
 * marketplace, node_modules/ but no dist/).
 */
const binSrc = join(process.cwd(), "bin");

function pkg(tag: string, opts: { deps: boolean; dist: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), `em-shim-${tag}-`));
  cpSync(binSrc, join(dir, "bin"), { recursive: true });
  if (opts.deps) {
    mkdirSync(join(dir, "node_modules", "better-sqlite3"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "better-sqlite3", "package.json"), "{}");
  }
  if (opts.dist) {
    mkdirSync(join(dir, "dist"));
    for (const entry of ["server", "hook", "cli"]) {
      writeFileSync(
        join(dir, "dist", `${entry}.js`),
        `process.stdout.write("${tag} ${entry} " + (process.env.EMINIAR_PLUGIN_ROOT ?? "-") + " " + (process.env.EMINIAR_LAUNCH_ROOT ?? "-") + " " + process.argv.slice(2).join(",") + "\\n");`,
      );
    }
  }
  return dir;
}

function home(pins: { node?: boolean; root?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "em-shim-home-"));
  if (pins.node !== false) writeFileSync(join(dir, "node-path"), process.execPath);
  if (pins.root) writeFileSync(join(dir, "root-path"), pins.root);
  return dir;
}

function sh(dir: string, shim: string, emHome: string, args: string[] = []) {
  const r = spawnSync("sh", [join(dir, "bin", shim), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: emHome, EMINIAR_HOME: emHome },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("bin shims", () => {
  it("fall back to the pinned stable root when their own directory has no node_modules", () => {
    const stable = pkg("STABLE", { deps: true, dist: true });
    const cache = pkg("CACHE", { deps: false, dist: true });
    const h = home({ root: stable });
    for (const [shim, entry] of [
      ["em-server", "server"],
      ["em-hook", "hook"],
      ["eminiar", "cli"],
    ] as const) {
      const r = sh(cache, shim, h, ["--probe"]);
      expect(r.status, r.stderr).toBe(0);
      const [tag, ran, pluginRoot, launchRoot, argv] = r.stdout.trim().split(" ");
      expect(tag).toBe("STABLE");
      expect(ran).toBe(entry);
      expect(basename(pluginRoot!)).toBe(basename(stable));
      expect(basename(launchRoot!)).toBe(basename(cache));
      expect(argv).toBe("--probe");
    }
  });

  it("run their own dist/ when dependencies resolve beside them, without exporting roots", () => {
    const stable = pkg("STABLE", { deps: true, dist: true });
    const self = pkg("SELF", { deps: true, dist: true });
    const r = sh(self, "em-server", home({ root: stable }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("SELF server - -");
  });

  it("fall back when dependencies are installed but dist/ is not (a git marketplace copy)", () => {
    // Claude Code installs the dependencies of a copy cloned from GitHub; dist/ is gitignored.
    const stable = pkg("STABLE", { deps: true, dist: true });
    const cache = pkg("CACHE", { deps: true, dist: false });
    const h = home({ root: stable });
    for (const [shim, entry] of [
      ["em-server", "server"],
      ["em-hook", "hook"],
      ["eminiar", "cli"],
    ] as const) {
      const r = sh(cache, shim, h);
      expect(r.status, r.stderr).toBe(0);
      const [tag, ran, pluginRoot, launchRoot] = r.stdout.trim().split(" ");
      expect([tag, ran]).toEqual(["STABLE", entry]);
      expect(basename(pluginRoot!)).toBe(basename(stable));
      expect(basename(launchRoot!)).toBe(basename(cache));
    }
  });

  it("treat a sibling node_modules (the stable copy layout) as runnable", () => {
    // ~/.eminiar/plugin/node_modules/eminiar has its deps in the parent directory.
    const nm = mkdtempSync(join(tmpdir(), "em-shim-nm-"));
    mkdirSync(join(nm, "better-sqlite3"), { recursive: true });
    writeFileSync(join(nm, "better-sqlite3", "package.json"), "{}");
    const dir = join(nm, "eminiar");
    mkdirSync(join(dir, "dist"), { recursive: true });
    cpSync(binSrc, join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "dist", "hook.js"), 'process.stdout.write("SIBLING\\n")');
    const r = sh(dir, "em-hook", home({}));
    expect(r.stdout.trim()).toBe("SIBLING");
  });

  it("follow the node_modules/.bin symlink npx and npm -g create for the eminiar CLI", () => {
    // npx cache layout: node_modules/.bin/eminiar -> ../eminiar/bin/eminiar, deps beside it.
    const nm = join(mkdtempSync(join(tmpdir(), "em-shim-npx-")), "node_modules");
    mkdirSync(join(nm, "better-sqlite3"), { recursive: true });
    writeFileSync(join(nm, "better-sqlite3", "package.json"), "{}");
    const dir = join(nm, "eminiar");
    mkdirSync(join(dir, "dist"), { recursive: true });
    cpSync(binSrc, join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "dist", "cli.js"), 'process.stdout.write("NPX\\n")');
    mkdirSync(join(nm, ".bin"));
    symlinkSync("../eminiar/bin/eminiar", join(nm, ".bin", "eminiar"));
    const r = spawnSync("sh", [join(nm, ".bin", "eminiar")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", EMINIAR_HOME: home({}) },
    });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("NPX");
  });

  it("never block Claude when nothing can run: em-hook prints {} and em-server exits 1", () => {
    const cache = pkg("CACHE", { deps: false, dist: true });
    const h = home({});
    const hook = sh(cache, "em-hook", h);
    expect(hook.status).toBe(0);
    expect(hook.stdout.trim()).toBe("{}");
    expect(hook.stderr).toContain("npx eminiar install");
    const server = sh(cache, "em-server", h);
    expect(server.status).toBe(1);
    expect(server.stdout).toBe("");
    expect(server.stderr).toContain("root-path");
    expect(server.stderr).toContain("npx eminiar install");
  });

  it("ignore a pinned root that is not runnable", () => {
    const cache = pkg("CACHE", { deps: false, dist: true });
    for (const broken of [
      pkg("BROKEN", { deps: false, dist: true }),
      pkg("BROKEN", { deps: true, dist: false }),
    ]) {
      const r = sh(cache, "em-server", home({ root: broken }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("npx eminiar install");
    }
  });
});
