import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enforceIntent } from "../../src/swarm/config.js";
import { ENFORCE_FORMS } from "./swarm-enforce-forms.js";

const shim = join(__dirname, "..", "..", "bin", "em-hook");

// A PATH holding only the tools the shim needs, so `node` cannot be found anywhere.
const tools = mkdtempSync(join(tmpdir(), "em-shim-tools-"));
for (const t of ["cat", "dirname", "grep", "sh", "env"])
  for (const d of ["/usr/bin", "/bin"])
    if (existsSync(join(d, t)) && !existsSync(join(tools, t)))
      symlinkSync(join(d, t), join(tools, t));

const tmp = (n: string) => realpathSync(mkdtempSync(join(tmpdir(), `em-shim-${n}-`)));

function project(name: string, yaml?: string): string {
  const root = tmp(name);
  if (yaml !== undefined) {
    mkdirSync(join(root, ".eminiar"), { recursive: true });
    writeFileSync(join(root, ".eminiar", "swarm.yaml"), yaml);
  }
  return root;
}

const payload = (cwd: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "s1",
    cwd,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "Explore", prompt: "go" },
    ...over,
  });

function run(cwd: string, stdin: string, env: Record<string, string> = {}) {
  const r = spawnSync("/bin/sh", [shim], {
    input: stdin,
    encoding: "utf8",
    cwd,
    env: { PATH: tools, HOME: tools, EMINIAR_HOME: tmp("home"), ...env },
  });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
}
const denied = (out: ReturnType<typeof run>) =>
  out.hookSpecificOutput?.permissionDecision === "deny";

describe("the no-node shim", () => {
  describe("reads enforce like enforceIntent", () => {
    for (const c of ENFORCE_FORMS)
      it(c.name, () => {
        const ws = project("form", c.text);
        expect(enforceIntent(c.text)).toBe(c.intent);
        expect(denied(run(ws, payload(ws), { CLAUDE_PROJECT_DIR: ws }))).toBe(c.intent);
      });
  });

  it("denies nested (agent_id) calls too while enforcing", () => {
    const ws = project("nested", "version: 1\nenforce: true\n");
    expect(denied(run(ws, payload(ws, { agent_id: "a1" }), { CLAUDE_PROJECT_DIR: ws }))).toBe(true);
  });

  it("prefers CLAUDE_PROJECT_DIR over an inherited EMINIAR_PROJECT_ROOT", () => {
    const on = project("on", "version: 1\nenforce: true\n");
    const off = project("off");
    expect(
      denied(run(off, payload(off), { CLAUDE_PROJECT_DIR: off, EMINIAR_PROJECT_ROOT: on })),
    ).toBe(false);
    expect(
      denied(run(on, payload(on), { CLAUDE_PROJECT_DIR: on, EMINIAR_PROJECT_ROOT: off })),
    ).toBe(true);
  });

  it("follows a linked worktree to the main checkout's swarm file", () => {
    const main = project("main", "version: 1\nenforce: true\n");
    const wt = tmp("wt");
    const gd = join(main, ".git", "worktrees", "w");
    mkdirSync(gd, { recursive: true });
    writeFileSync(join(gd, "commondir"), "../..\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    expect(denied(run(wt, payload(wt), { CLAUDE_PROJECT_DIR: wt }))).toBe(true);
    // a worktree's own swarm file wins over the main checkout's
    mkdirSync(join(wt, ".eminiar"));
    writeFileSync(join(wt, ".eminiar", "swarm.yaml"), "version: 1\nenforce: false\n");
    expect(denied(run(wt, payload(wt), { CLAUDE_PROJECT_DIR: wt }))).toBe(false);
  });

  it("allows a worktree whose main checkout has no swarm file, and a broken .git file", () => {
    const main = project("main2");
    const wt = tmp("wt2");
    const gd = join(main, ".git", "worktrees", "w");
    mkdirSync(gd, { recursive: true });
    writeFileSync(join(gd, "commondir"), "../..\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    expect(denied(run(wt, payload(wt), { CLAUDE_PROJECT_DIR: wt }))).toBe(false);
    const bad = tmp("bad");
    writeFileSync(join(bad, ".git"), "garbage\n");
    expect(denied(run(bad, payload(bad), { CLAUDE_PROJECT_DIR: bad }))).toBe(false);
  });

  it("does not read the parent's swarm file for a .git file without a gitdir line", () => {
    const par = project("par", "version: 1\nenforce: true\n");
    const bad = join(par, "child");
    mkdirSync(bad);
    writeFileSync(join(bad, ".git"), "garbage\n");
    expect(denied(run(bad, payload(bad), { CLAUDE_PROJECT_DIR: bad }))).toBe(false);
    // a gitdir with no commondir (a submodule) is not followed either
    const sub = join(par, "sub");
    mkdirSync(sub);
    mkdirSync(join(par, "modules", "sub"), { recursive: true });
    writeFileSync(join(sub, ".git"), `gitdir: ${join(par, "modules", "sub")}\n`);
    expect(denied(run(sub, payload(sub), { CLAUDE_PROJECT_DIR: sub }))).toBe(false);
  });

  it("walks up from a subdirectory to the first project marker, like resolveProjectRoot", () => {
    const ws = project("walk", "version: 1\nenforce: true\n");
    writeFileSync(join(ws, "package.json"), "{}");
    const deep = join(ws, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(denied(run(deep, payload(deep), { CLAUDE_PROJECT_DIR: deep }))).toBe(true);
    // the first marker wins: a nested package does not see the outer file
    writeFileSync(join(ws, "a", "package.json"), "{}");
    expect(denied(run(deep, payload(deep), { CLAUDE_PROJECT_DIR: deep }))).toBe(false);
    // no marker anywhere: stay on the start dir
    const bare = project("bare", "version: 1\nenforce: true\n");
    expect(denied(run(bare, payload(bare), { CLAUDE_PROJECT_DIR: bare }))).toBe(true);
  });

  it("strips CR from the .git and commondir lines", () => {
    const main = project("main3", "version: 1\nenforce: true\n");
    const wt = tmp("wt3");
    const gd = join(main, ".git", "worktrees", "w");
    mkdirSync(gd, { recursive: true });
    writeFileSync(join(gd, "commondir"), "../..\r\n");
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\r\n`);
    expect(denied(run(wt, payload(wt), { CLAUDE_PROJECT_DIR: wt }))).toBe(true);
  });

  it("works in a path with a space", () => {
    const ws = join(project("sp ace-"), "x y");
    mkdirSync(join(ws, ".eminiar"), { recursive: true });
    writeFileSync(join(ws, ".eminiar", "swarm.yaml"), "enforce: true\n");
    expect(denied(run(ws, payload(ws), { CLAUDE_PROJECT_DIR: ws }))).toBe(true);
  });
});
