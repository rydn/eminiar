/**
 * Sandboxed processes get a minimal environment: enough to run tools and reach
 * credentials for gh/aws/gcloud/kubectl/docker, but none of Claude Code's own
 * variables or API keys. Names are matched case-sensitively; `*` is a glob.
 */
const BASE_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_*",
  "TERM",
  "TMPDIR",
  "TZ",
  "CI",
  "XDG_*",
  // credential passthrough
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_HOST",
  "AWS_*",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_*",
  "KUBECONFIG",
  "DOCKER_*",
  "SSH_AUTH_SOCK",
  "NPM_TOKEN",
  "NPM_CONFIG_*",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "GIT_*",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "NVM_DIR",
];

const DENY_ALWAYS = [/^ANTHROPIC_/, /^CLAUDE_/, /^OPENAI_/, /_API_KEY$/, /^EMINIAR_PLUGIN/];

/** Does the sandbox withhold this variable unless a config lists its exact name? */
export const isAlwaysWithheld = (name: string): boolean => DENY_ALWAYS.some((d) => d.test(name));

function globToRegex(g: string): RegExp {
  return new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

// Compiled allowlists keyed by the extra names; the base list never changes.
const patternCache = new Map<string, RegExp[]>();
function allowPatterns(extraAllow: string[]): RegExp[] {
  const key = extraAllow.join("\0");
  let patterns = patternCache.get(key);
  if (!patterns) {
    if (patternCache.size >= 16) patternCache.clear();
    patterns = [...BASE_ALLOW, ...extraAllow].map(globToRegex);
    patternCache.set(key, patterns);
  }
  return patterns;
}

export function buildEnv(
  extraAllow: string[],
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const patterns = allowPatterns(extraAllow);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (isAlwaysWithheld(k) && !extraAllow.includes(k)) continue;
    if (patterns.some((p) => p.test(k))) out[k] = v;
  }
  return { ...out, ...overrides };
}
