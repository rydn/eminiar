import { createHash } from "node:crypto";

/**
 * Text hygiene for the adjudicator (docs/design/adjudicator.md §6, §12): the cache key, the
 * 80-char head kept in the DB, and the text sent to a remote provider all pass through here.
 * The index uses redactSecrets() to mask captured command and page output before storing it
 * (src/index/indexer.ts), which is why this module stays pure (adjudicator-hooks-off.test.ts).
 */

/** Unicode NFKC, CRLF → LF, trailing spaces and runs of blank lines collapsed, trimmed. */
export function normalize(text: string): string {
  return (
    text
      .normalize("NFKC")
      .replace(/\r\n?/g, "\n")
      // (only from the start of a run: tried at every space of a long run, the match is quadratic)
      .replace(/(?<![ \t])[ \t]+$/gm, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** sha256 hex of the normalised text: the same request always hashes the same. */
export function inputHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Secret-looking names. A name is split into words (on _ . - and camelCase) and is secret when
// its last word is a secret word, optionally followed only by harmless qualifiers (`_v2`,
// `_base`, `_hash`). So JWT_SIGNING_KEY, DB_PASS, _authToken, x-api-key and secret_key_base
// are secret, while keyEnv, apiKeyName, token_count and max_tokens are not.
// ---------------------------------------------------------------------------------------------

const SECRET_WORDS = new Set([
  "key",
  "token",
  "secret",
  "secrets",
  "pass",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "pw",
  "credential",
  "credentials",
  "creds",
  "auth",
  "authorization",
  "pat",
]);
/** A single lowercase word that ends in one of these is secret too (PGPASSWORD, APIKEY). */
const SECRET_WORD_SUFFIX =
  /(?:password|passwd|passphrase|secret|token|apikey|accesskey|secretkey|privatekey|authkey|signingkey|masterkey)$/;
const SECRET_QUALIFIERS = new Set([
  "base",
  "hash",
  "value",
  "val",
  "b64",
  "base64",
  "enc",
  "encrypted",
  "raw",
  "plain",
  "str",
  "string",
  "live",
  "prod",
  "test",
  "data",
]);

/** Exported for tests: is this identifier the name of a secret? */
export function isSecretName(name: string): boolean {
  const words = name
    .split(/[_.-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i] as string;
    if (SECRET_WORDS.has(w) || SECRET_WORD_SUFFIX.test(w)) return true;
    if (!SECRET_QUALIFIERS.has(w) && !/^v?\d+$/.test(w)) return false;
  }
  return false;
}

/** Values that name or reference a secret rather than being one: left as they are. */
const NOT_A_SECRET_VALUE =
  /^(?:true|false|null|nil|none|undefined|yes|no|on|off|\*+|\[[a-z ]+\]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z_][A-Za-z0-9_]*|<[^>]*>|\d{1,4})$/i;

// name = value, name: value, "name": "value", 'name' => 'value', name := value, --name=value.
// Two steps keep it linear: ASSIGN_NAME finds `name<sep>` (a name starts only at an identifier
// boundary, and whether it is secret is decided in code: an alternation of secret words inside
// the regex backtracks badly on long identifier runs), and only for a secret name does the
// sticky ASSIGN_VALUES (readValue()) read the value. A non-secret name never consumes the text after it, so
// `.env: FOO_KEY=x` and `https://…?token=x` are still found.
// The separator may follow an escaped quote: JSON inside a JSON string (`{\"password\":\"x\"}`,
// kubectl's last-applied-configuration) escapes its quotes once or more.
const ASSIGN_NAME =
  /(?<![A-Za-z0-9_.-])(?=([A-Za-z0-9_.-]+))\1(\\{0,8}["'`]?[ \t]*(?::=|=>|[:=])[ \t]*)/g;
// The value is read by the first of these sticky patterns that matches at its start; each one
// stops at a quote or whitespace it cannot cross, so a failed attempt stays cheap. (Each names
// the opening quote, with any backslashes before it, `open`, and the value `value`.)
// - a value in escaped quotes (`\"x\"`), up to the same escaped quote;
// - a quoted value on one line, with spaces and escapes, up to 4096 chars;
// - a quoted value over several lines with no whitespace in them (an .env value, a key), whose
//   closing quote ends the line or the item;
// - a quote that is not closed within 4096 chars, or not before the end of the text (a value
//   cut off by a clip): masked to the end of its line, so no part of it is left;
// - a bare value: it runs to whitespace or a quote, or to a `&` / `;` / `,` that ends the value
//   (the end of the text, or the next `name=` pair); it never starts with `=`, `<`, a bracket, a
//   YAML block indicator or an escaped quote.
const NOT_A_SCHEME_STUB = /(?!(?:Basic|Bearer|Token|Digest|Negotiate|NTLM)[ \t]+\*\*\*)/.source;
const ASSIGN_VALUES: Array<{ re: RegExp; closed: boolean }> = [
  {
    re: /(?<open>\\{1,8}(?<q>["']))(?<value>(?:(?!\k<q>)[^\\\n]|\\+(?![\\"'])){0,4096})\k<open>/y,
    closed: true,
  },
  {
    re: /(?<open>["'`])(?<value>(?:(?!\k<open>)[^\\\n]|\\.){0,4096})\k<open>/y,
    closed: true,
  },
  {
    re: /(?<open>["'`])(?<value>[^\s"'`\\]{0,512}(?:\r?\n[^\s"'`\\]{0,512}){1,64})\k<open>(?=[ \t]*(?:[,;)}\]#\r\n]|$))/y,
    closed: true,
  },
  {
    re: /(?<open>["'`])(?<value>(?:(?!\k<open>)[^\\\n]|\\.){4096}[^\n]*|(?![\s)\]};,])(?:(?!\k<open>)[^\\\n]|\\.)+$)/y,
    closed: false,
  },
  {
    re: new RegExp(
      `${NOT_A_SCHEME_STUB}(?<open>)(?<value>(?!\\\\+["'\`])[^\\s"'\`&;,=<\\[{(|>](?:[^\\s"'\`&;,]|[&;,](?=[^\\s"'\`&;,])(?![A-Za-z0-9_.\\- ]*=))*)`,
      "y",
    ),
    closed: false,
  },
];

/** The value at `start` of a secret name: its length, its raw text and the masked form. */
function readValue(
  text: string,
  start: number,
): { length: number; raw: string; masked: string } | undefined {
  for (const { re, closed } of ASSIGN_VALUES) {
    re.lastIndex = start;
    const v = re.exec(text);
    if (!v?.groups) continue;
    const open = v.groups.open ?? "";
    const raw = v.groups.value ?? "";
    // an escaped opening quote closes with the same backslashes: `\"` … `\"`
    const close = closed ? open : "";
    return { length: v[0].length, raw, masked: `${open}***${close}` };
  }
  return undefined;
}

/** A secret name's value that a caller wants left as it is (see keepInOutput). */
type KeepValue = (name: string, value: string) => boolean;

const SECRET_HINT = /key|token|secret|pass|pw|cred|auth|pat/i;

function maskAssignments(text: string, keep?: KeepValue): string {
  ASSIGN_NAME.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = ASSIGN_NAME.exec(text); m; m = ASSIGN_NAME.exec(text)) {
    if (!SECRET_HINT.test(m[1] as string) || !isSecretName(m[1] as string)) continue;
    const start = m.index + m[0].length;
    const v = readValue(text, start);
    if (!v) continue;
    const { raw } = v;
    if (!raw || NOT_A_SECRET_VALUE.test(raw) || keep?.(m[1] as string, raw)) continue;
    out += text.slice(last, start) + v.masked;
    last = start + v.length;
    ASSIGN_NAME.lastIndex = last;
  }
  return out + text.slice(last);
}

/**
 * YAML block scalars under a secret key (`db_password: >` / `key: |-` followed by indented
 * lines): every following line indented deeper than the key is masked. Line-based, linear.
 */
function maskYamlBlocks(text: string): string {
  if (!/:[ \t]*[|>]/.test(text)) return text;
  const lines = text.split("\n");
  const header =
    /^([ \t]*)(?:-[ \t]+)?["']?([A-Za-z0-9_.-]+)["']?[ \t]*:[ \t]*[|>][+-]?[1-9]?[ \t\r]*$/;
  // Built as a new array: splicing each block out of `lines` shifts the rest every time, which
  // is quadratic in the number of blocks.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i] as string);
    const h = header.exec(lines[i] as string);
    if (!h || !isSecretName(h[2] as string)) continue;
    const indent = (h[1] as string).length;
    let last = i; // the last line of the block (blank lines after it are kept)
    let pad = ""; // the block's own indentation
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.trim() === "") continue;
      const n = (/^[ \t]*/.exec(line) as RegExpExecArray)[0].length;
      if (n <= indent) break;
      if (last === i) pad = line.slice(0, n);
      last = j;
    }
    if (last === i) continue;
    out.push(`${pad}***`);
    i = last;
  }
  return out.join("\n");
}

/** Set-Cookie attributes: their values are not secrets and stay readable. */
const COOKIE_ATTRIBUTES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
  "priority",
  "partitioned",
  "version",
  "comment",
]);

/** `a=1; b=2; Path=/` → `a=***; b=***; Path=/`. */
function maskCookiePairs(pairs: string): string {
  return pairs.replace(
    /(^|;[ \t]*)([^=;]+)=([^;]*)/g,
    (m, sep: string, name: string, value: string) =>
      !value || value === "***" || COOKIE_ATTRIBUTES.has(name.trim().toLowerCase())
        ? m
        : `${sep}${name}=***`,
  );
}

/**
 * Default-ignorable code points (Unicode Default_Ignorable_Code_Point): zero-width and joiner
 * characters, soft hyphen, bidi controls, the combining grapheme joiner, variation selectors,
 * Hangul fillers, tag characters and the BOM. They render as nothing, so `PASS\u200BWORD=` or
 * `DB_PASS\u{E0041}WORD=` would otherwise split the name and the rules would miss it.
 */
let IGNORABLE_RE: RegExp | undefined;
const ignorable = (): RegExp => (IGNORABLE_RE ??= /\p{Default_Ignorable_Code_Point}/gu);

/**
 * Strip the default-ignorable characters and apply NFKC (fullwidth `＝` / `：` become `=` / `:`,
 * ligatures unfold). Stripped again after NFKC, which maps U+3164 / U+FFA0 to the ignorable
 * U+1160. Leaves spaces, tabs and newlines alone, so YAML indentation survives. Idempotent.
 */
function clean(text: string): string {
  return text.replace(ignorable(), "").normalize("NFKC").replace(ignorable(), "");
}

type Rule =
  | [RegExp, string | ((...m: string[]) => string)]
  | ["assignments", typeof maskAssignments];

// One BEGIN and END for both private-key rules (redact()'s below, redactSecrets' bounded one).
const PRIVATE_KEY_BEGIN = "-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----";
const PRIVATE_KEY_END = "-----END [A-Z0-9 ]{0,60}-----";
const PRIVATE_KEY_TO_END = new RegExp(
  `${PRIVATE_KEY_BEGIN}[\\s\\S]*?(?:${PRIVATE_KEY_END}|$)`,
  "g",
);

/** Ordered: the specific shapes first, the generic runs last. */
const RULES: Rule[] = [
  // PEM / OpenSSH / PGP private key blocks, whole (to the END line, or the end of the text).
  [PRIVATE_KEY_TO_END, "[private key]"],
  // Credentials inside URLs: scheme://user:pass@host, scheme://:pass@host. The password may hold
  // a `/` (not a port's `:8080/`) or an `@` (masked to the last `@` before the host, but not past
  // a `/` `?` `#` after the first: `?email=a@b` in the path is not the host).
  [
    /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]*:(?!\d{1,5}(?:[/?#\s]|$))[^\s@]{1,256}@(?:[^\s@/?#]{1,256}@){0,3}/gi,
    "$1***@",
  ],
  // Authorization / Proxy-Authorization headers: the scheme stays, the credentials go.
  [
    /\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?)(?!(?:(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key)[ \t]+)?\*\*\*)(?:(Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key)[ \t]+)?[^\s"'`]+/gi,
    (_m: string, pre = "", scheme = "") => `${pre}${scheme ? `${scheme} ` : ""}***`,
  ],
  [/\bBearer[ \t]+(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  // curl -u / --user user:pass (the user stays). The `=` and the spaces around it are one group
  // (`[ \t]*=?[ \t]*` splits a run of spaces every way it can: quadratic).
  [
    /(?<!\S)(-u|--user)([ \t]*(?:=[ \t]*)?)(["']?)([^\s:"'@]+):(?!\*\*\*)[^\s"']+\3/g,
    "$1$2$3$4:***$3",
  ],
  // --password x, --token x, --api-key x, --client-secret x … (the `=` form is an assignment)
  [
    /(?<!\S)(--(?:[a-z0-9]+-){0,4}(?:password|passwd|pass|passphrase|token|secret|api-?key|access-key|secret-key|auth-token|credentials?))([ \t]+)(?!-|\*\*\*)(?:(["'])[^\n]{0,256}?\3|[^\s"']+)/gi,
    "$1$2$3***$3",
  ],
  // mysql / mariadb -p<password> (attached; `-p` alone prompts)
  [
    /\b((?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]{0,300}?(?<!\S)-p)(?![\s*])(?:(["'])[^\n]{0,256}?\2|[^\s"']+)/g,
    "$1$2***$2",
  ],
  // Tools whose short password flag takes the next word, only on that tool's own command (the
  // context stops at ; & | so `docker login … && docker run -p 8080:80` keeps the port):
  // registry logins -p, mongo* -p, redis-cli -a, ldap* -w, zip/unzip -P, mosquitto_* -P.
  [
    /\b((?:(?:(?:docker|podman|nerdctl|buildah|skopeo|oras|finch)(?:[ \t]+registry)?|helm[ \t]+registry|crane[ \t]+auth)[ \t]+login\b[^\n;&|]{0,300}?(?<!\S)-p|mongo(?:sh|dump|restore|import|export|stat|top|files)?\b[^\n;&|]{0,300}?(?<!\S)-p|redis-cli\b[^\n;&|]{0,300}?(?<!\S)-a|ldap(?:search|add|modify|delete|whoami|passwd|compare|modrdn|exop)\b[^\n;&|]{0,300}?(?<!\S)-w|(?:zip|unzip|zipcloak)\b[^\n;&|]{0,300}?(?<!\S)-P|mosquitto_(?:pub|sub|rr)\b[^\n;&|]{0,300}?(?<!\S)-P)[ \t]+)(?!-|\*\*\*)(?:(["'])[^\n]{0,256}?\2|[^\s"']+)/g,
    "$1$2***$2",
  ],
  // 7z -p<password> (attached, like mysql)
  [
    /\b(7z[az]?\b[^\n;&|]{0,300}?(?<!\S)-p)(?![\s*])(?:(["'])[^\n]{0,256}?\2|[^\s"']+)/g,
    "$1$2***$2",
  ],
  // sshpass -p <password> / -p<password>: only sshpass's own options may come before it, so
  // `sshpass -f file ssh -p 22 host` keeps ssh's port.
  [
    /\b(sshpass(?:[ \t]+(?:-[fdP][ \t]*[^\s-]\S*|-[a-oq-zA-Z]\S*)){0,3}[ \t]+-p[ \t]*)(?!-|\*\*\*)(?:(["'])[^\n]{0,256}?\2|[^\s"']+)/g,
    "$1$2***$2",
  ],
  // htpasswd -b[n] [file] user password: the last word is the password.
  [
    /\b(htpasswd((?:[ \t]+-[A-Za-z]+){1,4})[ \t]+)([^\s-]\S*)[ \t]+([^\s-]\S*)(?:[ \t]+([^\s-]\S*))?/g,
    (m: string, pre = "", flags = "", a = "", b = "", c?: string) => {
      if (!/b/.test(flags)) return m;
      if (/n/.test(flags))
        return b === "***" ? m : `${pre}${a} ***${c === undefined ? "" : ` ${c}`}`;
      return c === undefined || c === "***" ? m : `${pre}${a} ${b} ***`;
    },
  ],
  // echo <password> | docker login --password-stdin, and … --password-stdin <<< <password>
  [
    /(?<!\S)((?:echo(?:[ \t]+-[neE]+)?|printf(?:[ \t]+(["'])%s(?:\\n)?\2)?)[ \t]+)(["']?)(?!\$|\*\*\*)[^\s"'|]{1,256}\3(?=[ \t]*\|[^\n]{0,200}?--password-stdin\b)/g,
    "$1$3***$3",
  ],
  [/(--password-stdin\b[^\n]{0,200}?<<<[ \t]*)(["']?)(?!\$|\*\*\*)[^\s"']{1,256}\2/g, "$1$2***$2"],
  // openssl -pass/-passin/-passout pass:<password> (env:/file:/fd: name a source, kept)
  [/(?<!\S)(-pass(?:in|out)?[ \t]+pass:)(?!\*\*\*)[^\s"']+/g, "$1***"],
  // keytool -storepass x / -keypass x (… -storepass:env VAR names a source, kept)
  [
    /(?<!\S)(-(?:store|key|srcstore|deststore|srckey|destkey)pass[ \t]+)(?!-|\*\*\*)(?:(["'])[^\n]{0,256}?\2|[^\s"']+)/g,
    "$1$2***$2",
  ],
  // smbclient / rpcclient -U user%password (the user stays)
  [/(?<!\S)(-U[ \t]*)(["']?)([^\s%"']+)%(?!\*\*\*)[^\s"']+\2/g, "$1$2$3%***$2"],
  // .netrc: `machine host login me password x` on one line or across lines, `default …`, and a
  // bare `login me` / `password x` pair of lines.
  [
    /((?:\bmachine[ \t]+[^\s]+|^[ \t]*default\b)(?:\s+(?:login|account)[ \t]+[^\s]+){0,2}\s+password[ \t]+|^[ \t]*login[ \t]+[^\s]+[ \t]*\n[ \t]*password[ \t]+)(?!\*\*\*)("[^"\n]{0,256}"|[^\s"]+)/gm,
    (_m: string, pre = "", v = "") => `${pre}${v.startsWith('"') ? '"***"' : "***"}`,
  ],
  // Cookie / Set-Cookie headers (and curl --cookie / -b): every cookie value goes, the names and
  // the Set-Cookie attributes (Path, Expires, …) stay.
  [
    /(\b(?:Set-)?Cookie["']?[ \t]*:[ \t]*["']?|(?:\bcurl\b[^\n;&|]{0,300}?(?<!\S)-b|(?<!\S)--cookie)(?:[ \t]+|=)["']?)([^\s=;,"'`]+=[^\s;,"'`]*(?:;[ \t]*[^\s=;,"'`]+(?:=[^\s;,"'`]*)?)*)/gi,
    (_m: string, pre = "", pairs = "") => pre + maskCookiePairs(pairs),
  ],
  // Prose: "the password is Wint3rIsComing", "the signing secret was x9-y" (only when the word
  // looks like a secret: it has a digit or a symbol). `(?:[ \t]*:)?[ \t]+`, not `[ \t]*:?[ \t]+`,
  // which tries every split of a long run of spaces.
  [
    /\b((?:pass(?:word|phrase|wd)|secret|token|api[ -]?key|access[ -]key)[ \t]+(?:is|was)(?:[ \t]*:)?[ \t]+)(["']?)(?=[^\s"']{0,128}[\d!@#$%^&*])(?!\*\*\*)[^\s"']{4,128}\2/gi,
    "$1$2***$2",
  ],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, "$1_$2_***"],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, "whsec_***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "$1_***"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "glpat-***"],
  [/\bnpm_[A-Za-z0-9]{36,}/g, "npm_***"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "hf_***"],
  [/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, "xox*-***"],
  [/\b(hooks\.slack\.com\/services\/)[A-Za-z0-9/]{10,}/g, "$1***"],
  // Azure shared access signatures: the `sig=` of a SAS URL or connection string
  [/([?&;]sig=)(?!\*\*\*)[A-Za-z0-9%+/=_-]{16,}/gi, "$1***"],
  // Twilio API key and account SIDs (the account SID is half of the basic-auth pair)
  [/\b(SK|AC)[0-9a-f]{32}\b/g, "$1***"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "AIza***"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "SG.***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  ["assignments", maskAssignments],
  // (the local part starts at the start of its run, not at every \b inside it: `--a-a-a…`)
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\b[0-9a-fA-F]{24,}\b/g, "[hex]"],
  // base64 / base64url runs of 32+ chars mixing upper, lower and digits (not a word or a path)
  [
    /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    "[b64]",
  ],
];

/** Literals one of which every match of the rule contains (lower case, tested on the lower-cased text, for an i rule). */
const NEEDLES = new Map<RegExp, string[] | RegExp>();
function needles(rule: Rule, ...words: string[]): void {
  if (rule[0] !== "assignments")
    NEEDLES.set(
      rule[0],
      rule[0].flags.includes("i")
        ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")
        : words,
    );
}
needles(RULES[1] as Rule, "://");
needles(RULES[7] as Rule, "login", "mongo", "redis-cli", "ldap", "zip", "mosquitto_");
needles(RULES[16] as Rule, "password");
needles(RULES[18] as Rule, "pass", "secret", "token", "api", "access");

// Private key blocks in stored output, where "to the end of the text" would wipe the rest of a
// 9 MB `git log -p` after one cut-off key in a test fixture. The END line must come within 64 KB
// and before the next BEGIN (which also keeps the scan linear). A BEGIN without one masks the rest
// of its line and the base64 lines under it, indented or behind a diff or quote marker.
const PRIVATE_KEY_BLOCK: Rule = [
  new RegExp(
    `${PRIVATE_KEY_BEGIN}(?:(?:(?!-----BEGIN )[\\s\\S]){0,65536}?${PRIVATE_KEY_END}|[^\\n]*(?:\\n[ \\t]*(?:[+>-][ \\t]*)?[A-Za-z0-9+/=]{16,}[ \\t\\r]*(?=\\n|$))*)`,
    "g",
  ),
  "[private key]",
];

// Tokens a CLI prints on a line of their own (`gcloud auth print-access-token`, `vault print
// token`, `aws ecr get-login-password`), which redact() catches only as a base64 run.
const TOKEN_SHAPES: Rule[] = [
  // age secret keys (bech32, always upper case)
  [/\bAGE-SECRET-KEY-1[A-Z0-9]{20,}/g, "AGE-SECRET-KEY-***"],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, "ya29.***"],
  [/\b(hv[sbr])\.[A-Za-z0-9_-]{20,}/g, "$1.***"],
  [/\b(do[por])_v1_[a-f0-9]{64}\b/g, "$1_v1_***"],
  [/\b(shp(?:at|ca|pa|ss))_[a-fA-F0-9]{32}\b/g, "$1_***"],
  [/\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g, "pypi-***"],
  // base64 of `{"payload":"`, the ECR login password
  [/\beyJwYXlsb2FkIjoi[A-Za-z0-9+/=]{64,}/g, "[ecr password]"],
  // A base64 value under any name (a Kubernetes Secret's `data:`, `.dockerconfigjson: eyJ…`,
  // `DATABASE_URL: cG9zdGdyZXM6Ly8…`) whose decoded text holds a credential. (Found from the `:`,
  // not from every identifier that might be a name: a third of the cost on ordinary output.)
  [
    /(:[ \t]*["']?)([A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g,
    (m: string, pre = "", b64 = "") => (encodesSecret(b64) ? `${pre}***` : m),
  ],
];

/** Decoded text that is, or holds, a credential: URL credentials, docker auths, a private key. */
const DECODED_SECRET =
  /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]*:[^\s@]+@|"auths?"[ \t]*:|PRIVATE KEY-----|(?:password|passwd|secret|token|api_?key)["']?[ \t]*[:=]/i;

function encodesSecret(b64: string): boolean {
  // a hex digest (a git SHA, a checksum) decodes to bytes that hold no text
  if (/^[0-9a-f]+$/i.test(b64)) return false;
  const text = Buffer.from(b64, "base64").toString("latin1");
  return DECODED_SECRET.test(text);
}

/**
 * redactSecrets' rules: RULES up to the assignments (the generic runs after them are for remote
 * text only), with the bounded private-key rule in place of redact()'s and the token shapes added.
 */
const ASSIGNMENTS_AT = RULES.findIndex((r) => r[0] === "assignments");
if (ASSIGNMENTS_AT < 0) throw new Error("redact: RULES has no assignments entry to cut at");
const STORED_RULES: Rule[] = [
  ...RULES.slice(0, ASSIGNMENTS_AT).map(
    (r): Rule => (r[0] === PRIVATE_KEY_TO_END ? PRIVATE_KEY_BLOCK : r),
  ),
  ...TOKEN_SHAPES,
  ["assignments", maskAssignments],
];

/**
 * In command output a lone `key` usually names an identifier, not a secret: S3 and DynamoDB
 * `"Key": "photos/2024/beach.jpg"`, `key: string` in a diff, i18n `key: "greeting.hello"`.
 * Masking those would hide the very text a search of the output looks for. So its value is kept
 * when it reads as a name, a path or an id: under 20 characters, no digit or no letter, a dot or
 * a space, a UUID, an `algo:hex` digest, or short parts between `/ _ - :` with a plain word among
 * them (`user_123456_avatar`, `logs/2024/11/08/app-1`; a long hex part may follow a `:`, as in
 * `session:9f3a…`). A long opaque part (`live_<token>`, `prod-<token>`) is masked as under any
 * secret name.
 */
function keepInOutput(name: string, value: string): boolean {
  if (name.toLowerCase() !== "key") return false;
  if (value.length < 20 || !/\d/.test(value) || !/[A-Za-z]/.test(value) || /[.\s]/.test(value))
    return true;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return true;
  if (/^(?:sha(?:1|224|256|384|512)|md5):[0-9a-f]+$/i.test(value)) return true;
  const parts = value
    .split(/[/_-]/)
    .flatMap((part) => part.split(":").map((text, i) => ({ text, afterColon: i > 0 })));
  return (
    parts.length > 1 &&
    parts.some((p) => /^[a-z]{3,}$/.test(p.text)) &&
    parts.every((p) => p.text.length < 20 || (p.afterColon && /^[0-9a-f]+$/i.test(p.text)))
  );
}

function applyRules(text: string, rules: Rule[], keep?: KeepValue): string {
  let out = text;
  for (const rule of rules) {
    const need = rule[0] === "assignments" ? undefined : NEEDLES.get(rule[0]);
    if (need && !(need instanceof RegExp ? need.test(out) : need.some((w) => out.includes(w))))
      continue;
    if (rule[0] === "assignments") out = rule[1](out, keep);
    else if (typeof rule[1] === "string") out = out.replace(rule[0], rule[1]);
    else out = out.replace(rule[0], rule[1]);
  }
  return out;
}

/**
 * Mask secrets, emails and long hex/base64 runs. Idempotent; linear in the input. The text is
 * cleaned first (default-ignorable characters stripped, NFKC applied), so neither an invisible
 * character nor a fullwidth form can hide a secret's name from the rules.
 */
export function redact(text: string): string {
  return applyRules(maskYamlBlocks(clean(text)), RULES);
}

/**
 * Mask the secrets in command and page output before it is stored: the same shapes and secret
 * names as redact(), plus a few bare token shapes. Idempotent; linear in the input. Emails, git
 * SHAs, checksums and base64 stay, and the text is not cleaned, so the stored copy keeps every
 * other character as printed (nobody hides a name with invisible characters in their own output).
 */
export function redactSecrets(text: string): string {
  return applyRules(maskYamlBlocks(text), STORED_RULES, keepInOutput);
}

/** The redacted head kept in the DB: at most n chars (code points), with "…" when cut. */
export function head(text: string, n = 80): string {
  // clean() before the YAML pass so a block's key is found while its indentation is intact.
  const chars = Array.from(redact(normalize(maskYamlBlocks(clean(text)))).replace(/\s+/g, " "));
  if (chars.length <= n) return chars.join("");
  return `${chars.slice(0, Math.max(0, n - 1)).join("")}…`;
}

/** The only text a remote provider receives: normalised, redacted, cut to maxChars. */
export function forRemote(text: string, maxChars: number): string {
  // YAML blocks first: normalize() collapses the indentation that delimits them. clean() goes
  // before them, so a key hiding a zero-width char or a fullwidth colon is still recognised.
  return Array.from(redact(normalize(maskYamlBlocks(clean(text)))))
    .slice(0, maxChars)
    .join("");
}
