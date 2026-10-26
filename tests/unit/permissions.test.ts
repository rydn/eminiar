import { describe, expect, it } from "vitest";
import { matchBash, matchRead, parseRule } from "../../src/permissions/rules.js";
import { checkCommand, checkRead } from "../../src/permissions/settings.js";
import { normalize, splitCommand } from "../../src/permissions/split.js";
import { buildEnv } from "../../src/sandbox/env.js";

describe("splitCommand", () => {
  it("splits on operators outside quotes and recurses into subshells", () => {
    expect(splitCommand('git log --oneline | head -5 && echo "a | b"; ls')).toEqual([
      "git log --oneline",
      "head -5",
      'echo "a | b"',
      "ls",
    ]);
    expect(splitCommand("echo $(sudo cat /etc/shadow) > out")).toContain("sudo cat /etc/shadow");
    expect(splitCommand("(cd x && rm -rf y) || true")).toEqual(["cd x", "rm -rf y", "true"]);
    expect(splitCommand("FOO=1 env BAR=2 sudo ls")).toEqual(["sudo ls"]);
  });
  it("normalises wrappers", () => {
    expect(normalize("time nice -n 5 npm test")).toBe("npm test");
  });
});

describe("rules", () => {
  const sudo = parseRule("Bash(sudo *)")!;
  const gitLog = parseRule("Bash(git log:*)")!;
  const exact = parseRule("Bash(npm run build)")!;
  it("matches prefix, legacy prefix and exact forms", () => {
    expect(matchBash(sudo, "sudo rm -rf /")).toBe(true);
    expect(matchBash(sudo, "sudoku")).toBe(false);
    expect(matchBash(gitLog, "git log --oneline")).toBe(true);
    expect(matchBash(gitLog, "git logs")).toBe(false);
    expect(matchBash(exact, "npm run build")).toBe(true);
    expect(matchBash(exact, "npm run build --watch")).toBe(false);
    expect(matchBash(parseRule("Bash")!, "anything")).toBe(true);
  });
  it("matches Read globs", () => {
    expect(matchRead(parseRule("Read(/var/log/**)")!, "/var/log/sys/x.log")).toBe(true);
    expect(matchRead(parseRule("Read(/var/log/*.log)")!, "/var/log/sys/x.log")).toBe(false);
  });
  it("expands ~ with the current $HOME, even after a compiled rule is cached", () => {
    const home = process.env.HOME;
    const ssh = parseRule("Read(~/.ssh/**)")!;
    try {
      process.env.HOME = "/home/a";
      expect(matchRead(ssh, "/home/a/.ssh/id_ed25519")).toBe(true);
      process.env.HOME = "/home/b";
      expect(matchRead(ssh, "/home/b/.ssh/id_ed25519")).toBe(true);
      expect(matchRead(ssh, "/home/a/.ssh/id_ed25519")).toBe(false);
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });
  it("deny wins on any segment, ask counts as deny", () => {
    const rules = { allow: [], deny: [sudo], ask: [parseRule("Bash(rm -rf:*)")!] };
    expect(checkCommand(rules, "ls && sudo reboot")).toMatchObject({
      allowed: false,
      kind: "deny",
    });
    expect(checkCommand(rules, "rm -rf dist")).toMatchObject({ allowed: false, kind: "ask" });
    expect(checkCommand(rules, "git status").allowed).toBe(true);
  });
  it("checks Read paths: deny before ask, ask counts as deny, allow does not override", () => {
    const rules = {
      allow: [parseRule("Read(**)")!],
      deny: [parseRule("Read(**/.env)")!],
      ask: [parseRule("Read(**/secrets/**)")!, parseRule("Read(**/.env)")!],
    };
    expect(checkRead(rules, ["/p/.env"])).toEqual({
      allowed: false,
      rule: "Read(**/.env)",
      kind: "deny",
    });
    expect(checkRead(rules, ["/p/app.ts", "/p/secrets/key.pem"])).toEqual({
      allowed: false,
      rule: "Read(**/secrets/**)",
      kind: "ask",
    });
    expect(checkRead(rules, ["/p/app.ts"])).toEqual({ allowed: true });
  });
});

describe("buildEnv", () => {
  it("strips secrets and keeps the allowlist", () => {
    process.env.ANTHROPIC_API_KEY = "secret";
    process.env.CLAUDE_CODE_X = "1";
    process.env.MY_API_KEY = "k";
    process.env.AWS_PROFILE = "dev";
    const env = buildEnv(["MY_CUSTOM_*"]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_X).toBeUndefined();
    expect(env.MY_API_KEY).toBeUndefined();
    expect(env.AWS_PROFILE).toBe("dev");
    expect(env.PATH).toBeDefined();
  });
});
