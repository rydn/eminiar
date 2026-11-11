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

describe("Read pattern forms resolve as Claude Code resolves them", () => {
  const root = "/work/proj";
  const m = (rule: string, path: string) => matchRead(parseRule(rule)!, path, root);
  const deny = (rule: string, path: string) =>
    !checkRead({ allow: [], deny: [parseRule(rule)!], ask: [], root }, [path]).allowed;
  const both = (rule: string, path: string) => {
    const a = m(rule, path);
    expect(deny(rule, path), `${rule} via checkRead on ${path}`).toBe(a);
    return a;
  };

  it("./x is the file under the project root, not one deeper or elsewhere", () => {
    expect(both("Read(./.env)", `${root}/.env`)).toBe(true);
    expect(both("Read(./.env)", `${root}/sub/.env`)).toBe(false);
    expect(both("Read(./.env)", "/other/.env")).toBe(false);
    expect(both("Read(./secrets/**)", `${root}/secrets/a/b.key`)).toBe(true);
  });

  it("a name without a slash matches at any depth under the root", () => {
    expect(both("Read(.env)", `${root}/.env`)).toBe(true);
    expect(both("Read(.env)", `${root}/a/b/.env`)).toBe(true);
    expect(both("Read(.env)", `${root}/.env.example`)).toBe(false);
    expect(both("Read(.env)", "/other/.env")).toBe(false);
    expect(both("Read(*.pem)", `${root}/k.pem`)).toBe(true);
    expect(both("Read(*.pem)", `${root}/certs/deep/k.pem`)).toBe(true);
    expect(both("Read(*.pem)", `${root}/k.pem.txt`)).toBe(false);
  });

  it("x/y (a slash inside) is anchored at the root", () => {
    expect(both("Read(src/*.ts)", `${root}/src/a.ts`)).toBe(true);
    expect(both("Read(src/*.ts)", `${root}/lib/src/a.ts`)).toBe(false);
    expect(both("Read(src/*.ts)", `${root}/src/deep/a.ts`)).toBe(false);
  });

  it("/x is project-root relative, and still matches the absolute path as before", () => {
    expect(both("Read(/secrets/**)", `${root}/secrets/k`)).toBe(true);
    expect(both("Read(/secrets/**)", "/secrets/k")).toBe(true);
    expect(both("Read(/secrets/**)", `${root}/other/k`)).toBe(false);
  });

  it("//x is absolute only", () => {
    expect(both("Read(//etc/hosts)", "/etc/hosts")).toBe(true);
    expect(both("Read(//etc/hosts)", `${root}/etc/hosts`)).toBe(false);
  });

  it("~/x is under the home folder", () => {
    const home = process.env.HOME;
    try {
      process.env.HOME = "/home/a";
      expect(both("Read(~/.aws/**)", "/home/a/.aws/credentials")).toBe(true);
      expect(both("Read(~/.aws/**)", `${root}/.aws/credentials`)).toBe(false);
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });

  it("a matched folder covers its files; a trailing slash names a folder; .. resolves", () => {
    expect(both("Read(./secrets)", `${root}/secrets/key`)).toBe(true);
    expect(both("Read(secrets/)", `${root}/secrets/key`)).toBe(true);
    expect(both("Read(../shared/**)", "/work/shared/x")).toBe(true);
    expect(both("Read(../shared/**)", `${root}/shared/x`)).toBe(false);
  });

  it("/**/ also matches no folder, and ? is one character", () => {
    expect(both("Read(//h/.aws/**/credentials)", "/h/.aws/credentials")).toBe(true);
    expect(both("Read(//h/.aws/**/credentials)", "/h/.aws/a/b/credentials")).toBe(true);
    expect(both("Read(//h/.aws/**/credentials)", "/h/.awsx/credentials")).toBe(false);
    expect(both("Read(key?.pem)", `${root}/key1.pem`)).toBe(true);
    expect(both("Read(key?.pem)", `${root}/key.pem`)).toBe(false);
    expect(both("Read(key?.pem)", `${root}/key/.pem`)).toBe(false);
  });

  it("**/x matches anywhere, as before", () => {
    expect(both("Read(**/.env)", `${root}/a/.env`)).toBe(true);
    expect(both("Read(**/.env)", "/elsewhere/.env")).toBe(true);
  });

  it("regex characters in the root are literal", () => {
    const odd = "/w/p+r (1)*";
    const r = parseRule("Read(./.env)")!;
    expect(matchRead(r, `${odd}/.env`, odd)).toBe(true);
    expect(matchRead(r, "/w/pr (1)x/.env", odd)).toBe(false);
  });

  it("names the first matching rule of a long list, and a list is not recompiled per path", () => {
    const list = Array.from({ length: 500 }, (_, i) => parseRule(`Read(**/secret${i}/**)`)!);
    list.push(parseRule("Read(./.env)")!);
    const rules = { allow: [], deny: list, ask: [], root };
    expect(checkRead(rules, [`${root}/a/secret42/x`])).toEqual({
      allowed: false,
      rule: "Read(**/secret42/**)",
      kind: "deny",
    });
    expect(checkRead(rules, [`${root}/.env`]).rule).toBe("Read(./.env)");
    const t = performance.now();
    for (let i = 0; i < 2000; i++) checkRead(rules, [`${root}/docs/d${i}/f.md`]);
    // 2000 paths x 501 rules: well under a second once compiled (was ~1 s per 2000 x 1000).
    expect(performance.now() - t).toBeLessThan(1000);
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
