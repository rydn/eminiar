import { describe, expect, it } from "vitest";
import {
  isSecretName,
  redact,
  redactSecrets,
  redactSecretsClean,
} from "../../src/adjudicator/redact.js";

/**
 * Round 2 security review of playbooks (swarm run 20261111-e068a8, task #264): secret names and
 * shapes that redactSecrets let through into stored prompts and carried-over header keys.
 */

const V = "Xq9vT2mLr8Kp4Wz7";

describe("isSecretName: one-word and compound secret names", () => {
  const secret = [
    "DBPASS",
    "SMTPPASS",
    "pgpass",
    "apipass",
    "rootpass",
    "mysqlpwd",
    "rootpw",
    "privkey",
    "sshkey",
    "gpgkey",
    "cookie",
    "Cookies",
    "auth_cookie",
    "sessionid",
    "session_id",
    "sessionId",
    "SESSION-ID",
    "authheader",
    "auth_header",
    "Authorization-Header",
    "otp",
    "TOTP",
    "otp_seed",
    "totp_seed",
    "bearer",
  ];
  for (const n of secret) it(`${n} is secret`, () => expect(isSecretName(n)).toBe(true));

  const plain = [
    // words that end in a secret word without being one
    "bypass",
    "compass",
    "encompass",
    "overpass",
    "underpass",
    "surpass",
    "trespass",
    "lowpass",
    "highpass",
    "bandpass",
    "multipass",
    "OLDPWD",
    "monkey",
    "whiskey",
    "turkey",
    "hockey",
    "donkey",
    "keyboard",
    // names that only mention one
    "login",
    "session",
    "session_count",
    "cookie_count",
    "cookies_enabled",
    "auth_header_name",
    "header",
    "otp_length",
    "key_id",
    "pass_through",
  ];
  for (const n of plain) it(`${n} is not secret`, () => expect(isSecretName(n)).toBe(false));
});

describe("redactSecrets masks the names the review found leaking", () => {
  const names = [
    "DBPASS",
    "SMTPPASS",
    "pgpass",
    "apipass",
    "mysqlpwd",
    "rootpw",
    "privkey",
    "sshkey",
    "cookie",
    "sessionid",
    "session_id",
    "authheader",
    "otp",
    "totp_seed",
    "bearer",
  ];
  for (const n of names)
    it(`${n}= and ${n}: lose the value`, () => {
      for (const line of [`${n}=${V}`, `${n}: ${V}`, `export ${n}="${V}"`, `"${n}": "${V}"`]) {
        const out = redactSecrets(line);
        expect(out, line).not.toContain(V);
        expect(redact(line), line).not.toContain(V);
      }
    });

  it("authheader: Basic … loses the credentials", () => {
    expect(redactSecrets("authheader: Basic YWxpY2U6VHIwdWI0ZG9y")).not.toContain("YWxpY2U6");
  });

  it("a login holding user:password keeps the user and masks the password", () => {
    expect(redactSecrets("login: alice:Tr0ub4dor")).toBe("login: alice:***");
    expect(redactSecrets('db_login="admin:hunter2x"')).toBe('db_login="admin:***"');
    expect(redactSecrets("LOGIN=root:s3cr3t-pw")).toBe("LOGIN=root:***");
  });

  it("a login that is only a user name, a time or a sentence stays", () => {
    for (const s of [
      "login: alice",
      "Last login: Tue Nov 11 10:30:00 on ttys000",
      "login: 10:30",
      "login: user@example.org",
      "the login: page",
    ])
      expect(redactSecrets(s), s).toBe(s);
  });

  it("a cookie value without pairs is masked; a Cookie header keeps its cookie names", () => {
    expect(redactSecrets(`cookie: ${V}`)).toBe("cookie: ***");
    expect(redactSecrets("cookie: sessionid=8f3a9c2e1b7d4f60a5c3e9b1d2f4a6c8")).toBe(
      "cookie: sessionid=***",
    );
    expect(redactSecrets("Cookie: sid=abc123; Path=/")).toBe("Cookie: sid=***; Path=/");
    expect(redactSecrets("Set-Cookie: a=b1; HttpOnly")).toBe("Set-Cookie: a=***; HttpOnly");
    // a short word is a name, not a cookie value
    expect(redactSecrets("Cookie: sid")).toBe("Cookie: sid");
  });

  it("mysql -p<password> is masked on either side of the command word", () => {
    expect(redactSecrets("mysql -pSECRET")).toBe("mysql -p***");
    expect(redactSecrets("mysql -u root -pS3cret db")).toBe("mysql -u root -p*** db");
    expect(redactSecrets("-pTr0ub4dor3 mysql")).toBe("-p*** mysql");
    expect(redactSecrets("use -pTr0ub4dor3 with mariadb -h db")).toBe(
      "use -p*** with mariadb -h db",
    );
    expect(redact("-pTr0ub4dor3 mysql")).toBe("-p*** mysql");
  });

  it("an attached -p elsewhere is left alone", () => {
    for (const s of [
      "mkdir -pv out; mysql -u root",
      "mkdir -pv out && mysql",
      "mkdir -pv /var/lib/mysql",
      "mkdir -p out\nmysql",
      "cp -pr a b mysql-data",
    ])
      expect(redactSecrets(s), s).toBe(s);
  });

  it("ordinary prose and filter names are not masked", () => {
    for (const s of [
      "the password reset flow sends a mail",
      "fix the session timeout and the cookie banner",
      "ffmpeg -af lowpass=f=3000,highpass=f=200 out.wav",
      "bypass: true",
      "OLDPWD=/home/me/src",
      "compass=north",
      "the otp field is six digits",
      "monkey=banana",
    ])
      expect(redactSecrets(s), s).toBe(s);
  });
});

describe("redactSecretsClean: invisible and fullwidth characters cannot hide a token", () => {
  const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789";

  it("fullwidth and zero-width forms of ghp_ are masked", () => {
    for (const s of [
      `ＧＨＰ＿${TOKEN}`,
      `ｇｈｐ＿${TOKEN}`,
      `ghp\u200b_${TOKEN}`,
      `g\u200dhp_${TOKEN}`,
      `token ghp\u2060_${TOKEN} here`,
    ]) {
      const out = redactSecretsClean(s);
      expect(out, JSON.stringify(s)).not.toContain(TOKEN);
      // as forRemote does
      expect(redact(s), JSON.stringify(s)).not.toContain(TOKEN);
    }
  });

  it("fullwidth and zero-width secret names are masked", () => {
    for (const s of [`ＰＡＳＳＷＯＲＤ＝${V}`, `PASS\u200bWORD=${V}`, `DB\u200bPASS: ${V}`])
      expect(redactSecretsClean(s), JSON.stringify(s)).not.toContain(V);
  });

  it("text that hides nothing keeps every character as written", () => {
    for (const s of [
      "café ﬁle ①②③ ｶﾀｶﾅ — résumé",
      "zero\u200bwidth joiner kept",
      "naïve ＡＢＣ text with no secret",
    ])
      expect(redactSecretsClean(s), JSON.stringify(s)).toBe(s);
  });

  it("is idempotent", () => {
    for (const s of [
      `ＧＨＰ＿${TOKEN} and café`,
      `PASS\u200bWORD=${V} ①`,
      "café ﬁle",
      `login: alice:${V}`,
    ]) {
      const once = redactSecretsClean(s);
      expect(redactSecretsClean(once)).toBe(once);
    }
  });

  it("without the option stored output keeps its characters (the indexer's behaviour)", () => {
    const s = `PASS\u200bWORD=${V}`;
    expect(redactSecrets(s)).toBe(s);
  });
});

describe("the new rules stay linear", () => {
  const time = (f: () => void): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  redactSecretsClean("warm DBPASS=x login: a:b -pX mysql cookie: y".repeat(10));

  it("has no catastrophic backtracking on the new shapes", () => {
    const n = 100_000;
    const inputs = [
      "-pa ".repeat(n / 4).concat("mysql"),
      "-p".repeat(n / 2),
      "-pX mysql ".repeat(n / 10),
      "login: a:".repeat(n / 9),
      "login=".repeat(n / 6),
      "a:".repeat(n / 2),
      "cookie: ".repeat(n / 8),
      "xpass".repeat(n / 5),
      "pass=".repeat(n / 5),
      "session_id_".repeat(n / 11),
      "ＧＨＰ＿".repeat(n / 4),
      "\u200b".repeat(n),
      "GHP_".concat("a1".repeat(n / 2)),
    ];
    for (const s of inputs) {
      const best = Math.min(
        time(() => redactSecretsClean(s)),
        time(() => redactSecretsClean(s)),
      );
      expect(best, JSON.stringify(s.slice(0, 30))).toBeLessThan(250);
      expect(
        time(() => redact(s)),
        JSON.stringify(s.slice(0, 30)),
      ).toBeLessThan(500);
    }
  });
});
