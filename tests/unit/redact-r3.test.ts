import { describe, expect, it } from "vitest";
import { redact, redactSecrets, redactSecretsClean } from "../../src/adjudicator/redact.js";

/**
 * Round 3 security review of playbooks (swarm run 20261111-e068a8, task #290): R3-4 the cleaned
 * pass of redactSecretsClean must never mask less than the plain pass; R3-5 the `-p<password>
 * mysql` and `login: user:password` rules must leave ports, flag clusters and URLs alone; R3-6
 * the `-p … mysql` rule must stay as cheap as the rest.
 */

describe("R3-4 redactSecretsClean masks at least what redactSecrets masks", () => {
  // NFKC turns these into ASCII quotes that would end the value early in the cleaned pass
  const LOOKALIKES = ["＂", "＇", "｀"];

  it("a fullwidth quote inside a value does not unmask its tail", () => {
    for (const q of LOOKALIKES) {
      for (const s of [
        `password=hunter2${q}S3cretTail`,
        `password="hunter2${q}S3cretTail"`,
        `DB_PASSWORD=Tr0ub4dor${q}and-the-rest-of-it`,
        `api_key: sk9f8e7d6c5b4a${q}leakedpart`,
      ]) {
        const out = redactSecretsClean(s);
        expect(out, JSON.stringify(s)).not.toMatch(/S3cretTail|and-the-rest|leakedpart|hunter2/);
        expect(redactSecrets(s), JSON.stringify(s)).not.toMatch(/S3cretTail|and-the-rest/);
      }
    }
  });

  it("other NFKC separators (small and fullwidth ; , &) do not unmask a tail", () => {
    for (const sep of ["；", "，", "＆", "﹔", "﹐", "﹠"]) {
      const s = `token=abcDEF123${sep}S3cretTail`;
      expect(redactSecretsClean(s), JSON.stringify(s)).not.toContain("S3cretTail");
    }
  });

  it("still finds what only the cleaned pass sees, and stays idempotent", () => {
    const s = "token=abc＂def ghp_​abcdefghijklmnopqrstuvwxyz0123";
    const once = redactSecretsClean(s);
    expect(once).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(once).not.toContain("def");
    expect(redactSecretsClean(once)).toBe(once);
    for (const q of LOOKALIKES) {
      const t = `password=hunter2${q}S3cretTail and café`;
      const o = redactSecretsClean(t);
      expect(redactSecretsClean(o), JSON.stringify(t)).toBe(o);
    }
  });

  it("text that hides nothing keeps every character as written", () => {
    for (const s of ["café ＡＢＣ＂quoted＂", "naïve ①②③ text"])
      expect(redactSecretsClean(s), JSON.stringify(s)).toBe(s);
  });
});

describe("R3-5 -p before the mysql client word: only a password on that command", () => {
  it("ports, pids, flag clusters and other commands' -p stay", () => {
    for (const s of [
      "Start a local db: docker run -d -p3306:3306 mysql",
      "docker run --rm -d -p3306:3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes mysql",
      "podman run -p3307:3306 mariadb",
      "docker run -p127.0.0.1:3306:3306/tcp mysql",
      "docker run -p$PORT:3306 mysql",
      "ssh -p2222 bastion.example.com mysql",
      "cp -pr conf mysql",
      "mkdir -pm 750 mysql",
      "tar -pxzf backup.tgz mysql",
      "lsof -p1234 mysql",
      "rsync -pa ./data mysql",
      "rsync -pavz ./data mysql",
      "ssh -pS3cretPort22 host mysql",
      "-p$MYSQL_PWD mysql",
      "-p$" + "{MYSQL_PWD} mysql",
    ])
      expect(redactSecrets(s), s).toBe(s);
  });

  it("a password-like -p before the client word is still masked", () => {
    expect(redactSecrets("-pTr0ub4dor3 mysql")).toBe("-p*** mysql");
    expect(redactSecrets("use -pTr0ub4dor3 with mariadb -h db")).toBe(
      "use -p*** with mariadb -h db",
    );
    expect(redactSecrets("-p'Tr0ub4dor3' mysqldump db")).toBe("-p'***' mysqldump db");
    expect(redactSecrets('-p"S3cret!" mysqladmin status')).toBe('-p"***" mysqladmin status');
    expect(redactSecrets("-pHunter22 mysqlsh")).toBe("-p*** mysqlsh");
    expect(redactSecrets("-pcorrecthorsebattery mariadb")).toBe("-p*** mariadb");
    expect(redact("-pTr0ub4dor3 mysql")).toBe("-p*** mysql");
  });

  it("a -p on another command of the line stays, the mysql one goes", () => {
    expect(redactSecrets("docker run -d -p3306:3306 mysql; -pS3cretPw2 mysql")).toBe(
      "docker run -d -p3306:3306 mysql; -p*** mysql",
    );
  });
});

describe("R3-5 login: a URL or host:port is not user:password", () => {
  it("URLs, host:port and times stay", () => {
    for (const s of [
      "Open the app. login: https://app.example.com/login with the test account",
      "login: http://localhost:8080",
      "login: localhost:3000",
      "login: localhost:3000/admin",
      "login: ssh://deploy@host",
      "login: 10:30",
      "Login: Tue Nov 11 10:30:00",
    ])
      expect(redactSecretsClean(s), s).toBe(s);
  });

  it("user:password still loses the password", () => {
    expect(redactSecrets("login: user:pass")).toBe("login: user:***");
    expect(redactSecrets("login: alice:Tr0ub4dor")).toBe("login: alice:***");
    expect(redactSecrets("login: deploy:8080secret")).toBe("login: deploy:***");
  });
});

describe("R3-6 the reworked rules stay as cheap as the rest", () => {
  const time = (f: () => void): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  const MB = 1_000_000;
  const fill = (unit: string, n = MB) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  redactSecrets("warm -pX mysql login: a:b".repeat(10));

  it("1 MB of long -p runs before mysql, and long login runs, take well under 150 ms", () => {
    for (const s of [
      `${fill(` -p${"a".repeat(256)}`)} mysql`,
      `${fill(` -p${"a".repeat(256)} ${"b".repeat(299)}`)} mysql`,
      `${fill(` -pA1${"a".repeat(254)}`)} mysql`,
      fill("login=a"),
      fill("mysql;"),
    ]) {
      const best = Math.min(
        time(() => redactSecrets(s)),
        time(() => redactSecrets(s)),
      );
      // main takes 10-75 ms on these; the regressed rule took ~470 ms
      expect(best, JSON.stringify(s.slice(0, 30))).toBeLessThan(150);
    }
  });
});
