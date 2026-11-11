import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as after from "../../src/adjudicator/redact.js";
import { restrictDbFiles } from "../../src/paths.js";
import * as before from "../fixtures/redact-before-cost-fixes.js";

// Snippets that exercise every rule that got a literal-presence skip (URL credentials, the
// tool-flag rule, .netrc, prose), the assignments rule and its name hint, plus near misses.
const SNIPPETS = [
  "https://user:hunter2pass@example.com/path?x=1",
  "postgres://:onlypass@db:5432/app",
  "http://host:8080/ok",
  "ftp://a:b@c@d.example",
  "docker login -u me -p s3cretpw registry.example.com",
  "echo s3cret | docker login --password-stdin",
  "mongosh --host x -p mongoPw1",
  "redis-cli -a r3disPass ping",
  "ldapsearch -x -w ldapPw1 -b dc=x",
  "unzip -P zipPw1 a.zip",
  "zipcloak -P zipPw2 a.zip",
  "mosquitto_pub -h x -P mqttPw1 -t a",
  "docker run -p 8080:80 img",
  "machine api.example.com login me password netrcPw1",
  "default login me password netrcPw2",
  "login me\npassword netrcPw3",
  "the password is Wint3rIsComing",
  "the signing secret was x9-y9z9",
  "THE TOKEN IS ab12cd34ef",
  "api key is k3y-v4lue",
  "Access Key: was x",
  "Authorization: Bearer abcdefghijklmnop",
  "Cookie: sid=abc123; Path=/",
  "curl -u bob:pw123 https://x",
  "curl --password hunter22 https://x",
  "mysql -u root -pRootPw1 db",
  "DB_PASS=Tr0ub4dor&3x",
  'config: {"password": "open sesame please"}',
  "export GITHUB_TOKEN=abc123def456",
  "CLIENT_SECRET = 'hello world 42'",
  "const apiKey = 'abcd1234efgh'",
  "PGPASSWORD=pgS3cret psql -h db",
  "x-api-key: q1w2e3r4t5",
  "keyEnv=foo apiKeyName=bar token_count=7 max_tokens=100 monkey=banana path: /a/b",
  "pat=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "sk_live_abcdefghij1234 sk-abcdefghijklmnopqrstuvwx AKIAABCDEFGHIJKLMNOP",
  "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
  "mail me at someone@example.com or 0123456789abcdef0123456789abcdef",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
  "PASS​WORD=zerowidth1 DB_PASS\u{E0041}WORD=tag1",
  "ＰＡＳＳＷＯＲＤ＝fullwidth1",
  "Kelvin KEY=notascii tokenſ=long-s",
  "plain build output: compiled 120 files in 3.2s, no secrets here",
  "ERROR: connection refused at 10.0.0.1:5432",
  "password:\n  - not a value",
  "",
  " ",
];
const SEPS = [" ", "\n", "\t", "; ", " && ", " | ", "\n\n", '"', "'", '\\"'];

/** Small deterministic PRNG, so a failure names a seed that replays. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function generated(n: number): string[] {
  const out: string[] = [];
  for (let seed = 1; seed <= n; seed++) {
    const rnd = lcg(seed);
    const parts: string[] = [];
    const k = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < k; i++) {
      const sn = SNIPPETS[Math.floor(rnd() * SNIPPETS.length)] as string;
      // sometimes cut a snippet mid way, so half-formed shapes are covered
      parts.push(rnd() < 0.2 ? sn.slice(0, Math.floor(rnd() * sn.length)) : sn);
      parts.push(SEPS[Math.floor(rnd() * SEPS.length)] as string);
    }
    out.push(parts.join(""));
  }
  return out;
}

describe("redact cost fixes keep the output byte-identical", () => {
  const inputs = [...SNIPPETS, SNIPPETS.join("\n"), ...generated(3000)];

  it("redactSecrets, redact and forRemote match the frozen pre-fix module", () => {
    let checked = 0;
    for (const text of inputs) {
      expect(after.redactSecrets(text), `redactSecrets ${JSON.stringify(text)}`).toBe(
        before.redactSecrets(text),
      );
      expect(after.redact(text), `redact ${JSON.stringify(text)}`).toBe(before.redact(text));
      expect(after.forRemote(text, 1e9), `forRemote ${JSON.stringify(text)}`).toBe(
        before.forRemote(text, 1e9),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it("matches on every secret-name shape, with and without a hint word", () => {
    const names = [
      "password",
      "PASSWORD",
      "db_pass",
      "pwd",
      "PW",
      "creds",
      "Credentials",
      "authorization",
      "apikey",
      "PGPASSWORD",
      "privateKey",
      "signing-key",
      "pat",
      "SECRETS",
      "keyEnv",
      "apiKeyName",
      "token_count",
      "monkey",
      "host",
      "name",
      "path",
      "a.b.c_token_v2",
      "secret_key_base",
    ];
    for (const n of names) {
      for (const sep of ["=", ": ", '": "', " := ", "=>", '\\":\\"']) {
        const text = `${n}${sep}Zq9hunter2pass and more`;
        expect(after.redactSecrets(text)).toBe(before.redactSecrets(text));
        expect(after.isSecretName(n)).toBe(before.isSecretName(n));
      }
    }
  });

  it("still masks (the golden outputs)", () => {
    expect(after.redactSecrets("export GITHUB_TOKEN=abc123def456")).not.toContain("abc123def456");
    expect(after.redactSecrets("https://u:hunter2pass@example.com")).not.toContain("hunter2pass");
    expect(after.redactSecrets("docker login -u me -p s3cretpw reg.io")).not.toContain("s3cretpw");
    expect(after.redactSecrets("the password is Wint3rIsComing")).not.toContain("Wint3rIsComing");
    expect(after.redactSecrets("machine h login me password netrcPw1")).not.toContain("netrcPw1");
    expect(after.redact("PASS​WORD=zerowidth1")).not.toContain("zerowidth1");
  });
});

describe("restrictDbFiles stat-first", () => {
  const mode = (p: string) => statSync(p).mode & 0o777;

  it("tightens a loose database and its -wal / -shm", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-rdb-"));
    try {
      const db = join(dir, "x.db");
      for (const f of [db, `${db}-wal`, `${db}-shm`]) {
        writeFileSync(f, "");
        chmodSync(f, 0o644);
      }
      restrictDbFiles(db);
      for (const f of [db, `${db}-wal`, `${db}-shm`]) expect(mode(f)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an owner-only database alone and tolerates a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-rdb-"));
    try {
      const db = join(dir, "y.db");
      writeFileSync(db, "");
      chmodSync(db, 0o600);
      restrictDbFiles(db);
      expect(mode(db)).toBe(0o600);
      expect(() => restrictDbFiles(join(dir, "missing.db"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
