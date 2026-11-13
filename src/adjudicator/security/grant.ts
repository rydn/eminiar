/**
 * The tool grant of an agent, as provider-safe ids (docs/design/adjudicator-security.md, 4.1).
 * Built from a swarm role (the same lists its generated agent file has), an agent definition
 * (AgentPin.grant), the built-in table, or the inherit set. Pure: no I/O, never throws.
 *
 * Privacy (decision D4): an MCP tool becomes `mcp:<class>:<verb>`; the raw server name stays in
 * ToolGrant.local and never reaches a provider or the database. Tool names that are not a known
 * Claude Code tool, an eminiar tool or an MCP tool are dropped, so an arbitrary string in an
 * agent file cannot ride along in an id. An MCP tool under eminiar's server name that eminiar
 * does not register is not dropped but classed `mcp:unknown:<verb>`.
 */
import { EM_MCP_PREFIXES, roleToolGrant } from "../../swarm/agents.js";
import type { RoleSpec } from "../../swarm/types.js";
import type { AgentGrant, AgentPin } from "../agent-pin.js";
import { AUTONOMY_MULT } from "./taxonomy.js";
import type {
  Autonomy,
  GrantedTool,
  GrantSource,
  GrantStatus,
  McpClass,
  McpVerb,
  ToolGrant,
} from "./types.js";

/** Tools a subagent without a `tools` line inherits (the MCP tools of the session are not enumerated). */
export const INHERIT_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Skill",
  "TodoWrite",
  "ToolSearch",
];

/**
 * The built-in agent types and what they may use (code.claude.com/docs/en/sub-agents). `without`
 * lists tools removed from the inherit set. Not verified against the installed Claude Code
 * version: an unlisted built-in falls back to the inherit set.
 */
export const BUILTIN_GRANTS: Readonly<
  Record<string, { tools?: readonly string[]; without?: readonly string[] }>
> = {
  "general-purpose": {},
  Explore: { without: ["Edit", "Write", "NotebookEdit"] },
  Plan: { without: ["Edit", "Write", "NotebookEdit"] },
  "statusline-setup": { tools: ["Read", "Edit"] },
  "claude-code-guide": { tools: ["Glob", "Grep", "Read", "WebFetch", "WebSearch"] },
};

/** Claude Code's own tools, the only bare names that become ids. */
export const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  ...INHERIT_TOOLS,
  "Task",
  "MultiEdit",
  "BashOutput",
  "KillShell",
  "KillBash",
  "Monitor",
  "PowerShell",
  "LSP",
  "SlashCommand",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskStop",
  "TaskOutput",
  "SendMessage",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/**
 * Every em_* tool the server registers, a closed list: only these names become ids, so a name
 * such as `em_ghp_<token>` (an agent file, em_adjudicate's `tools`) cannot ride along to a
 * provider. tests/unit/adjudicator-security-jev.test.ts fails when src/tools registers a tool
 * missing here (or this lists one that is gone).
 */
export const EM_TOOL_NAMES: ReadonlySet<string> = new Set([
  "em_adjudicate",
  "em_architecture",
  "em_batch_execute",
  "em_docs",
  "em_doctor",
  "em_execute",
  "em_execute_file",
  "em_fetch_and_index",
  "em_graph_add",
  "em_graph_changes",
  "em_graph_impact",
  "em_graph_query",
  "em_history",
  "em_index",
  "em_index_status",
  "em_memory",
  "em_purge",
  "em_recall",
  "em_reindex",
  "em_remember",
  "em_search",
  "em_stats",
  "em_swarm",
  "em_symbols",
  "em_usage",
]);
const MAX_GRANT_TOOLS = 256;

// --- MCP classification ------------------------------------------------------------------------

/** Server-name words per class (matched on whole words of the lower-cased name). */
const CLASS_WORDS: ReadonlyArray<readonly [McpClass, readonly string[]]> = [
  [
    "browser",
    [
      "claude-in-chrome",
      "chrome",
      "browser",
      "computer-use",
      "playwright",
      "puppeteer",
      "selenium",
      "browserbase",
    ],
  ],
  [
    "cloud",
    [
      "aws",
      "amazon",
      "cloudflare",
      "gcp",
      "gcloud",
      "azure",
      "k8s",
      "kubernetes",
      "terraform",
      "vercel",
      "netlify",
      "heroku",
      "digitalocean",
      "fly",
      "docker",
    ],
  ],
  [
    "saas",
    [
      "github",
      "gitlab",
      "bitbucket",
      "slack",
      "gmail",
      "google",
      "drive",
      "calendar",
      "linear",
      "notion",
      "atlassian",
      "jira",
      "confluence",
      "datadog",
      "sentry",
      "stripe",
      "hubspot",
      "salesforce",
      "asana",
      "figma",
      "discord",
      "zendesk",
      "intercom",
      "airtable",
      "dropbox",
      "box",
      "outlook",
      "teams",
      "pagerduty",
      "supabase",
    ],
  ],
];

/** `mcp__<server>__<tool>` → its two parts; undefined for anything else. */
function splitMcp(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice(5);
  const at = rest.indexOf("__");
  if (at <= 0) return undefined;
  const tool = rest.slice(at + 2);
  return tool ? { server: rest.slice(0, at), tool } : undefined;
}

function hasWord(server: string, words: readonly string[]): boolean {
  const padded = `-${server.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`;
  return words.some((w) => padded.includes(`-${w}-`));
}

/** The class of an MCP server by its name; `trusted` are security.trustedMcpServers. */
export function mcpClassOf(server: string, trusted: readonly string[] = []): McpClass {
  const lower = server.toLowerCase();
  if (lower === "eminiar" || /^plugin_eminiar_eminiar$/.test(lower)) return "first-party";
  if (trusted.some((t) => t.toLowerCase() === lower)) return "trusted";
  for (const [cls, words] of CLASS_WORDS) if (hasWord(server, words)) return cls;
  return "unknown";
}

const VERB_WORDS: ReadonlyArray<readonly [McpVerb, ReadonlySet<string>]> = [
  [
    "delete",
    new Set([
      "delete",
      "trash",
      "archive",
      "drop",
      "purge",
      "unlink",
      "remove",
      "revoke",
      "destroy",
    ]),
  ],
  ["exec", new Set(["execute", "run", "invoke", "exec", "eval"])],
  [
    "write",
    new Set([
      "create",
      "update",
      "send",
      "post",
      "publish",
      "push",
      "share",
      "upload",
      "comment",
      "merge",
      "write",
      "add",
      "set",
      "edit",
      "upsert",
      "append",
      "move",
      "copy",
      "reply",
      "submit",
      "put",
    ]),
  ],
  [
    "read",
    new Set([
      "get",
      "list",
      "read",
      "search",
      "query",
      "fetch",
      "describe",
      "find",
      "view",
      "show",
      "inspect",
      "analyze",
      "analyse",
      "lookup",
      "summarize",
      "explore",
    ]),
  ],
];

/**
 * The verb of an MCP tool from the words of its name. The most dangerous word wins
 * (delete > exec > write > read); a name with no known verb counts as a write.
 */
export function mcpVerbOf(tool: string): McpVerb {
  const words = new Set(
    tool
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  for (const [verb, set] of VERB_WORDS) for (const w of words) if (set.has(w)) return verb;
  return "write";
}

/**
 * One tool name as an agent file or settings spell it. undefined: not something that may be
 * named to a provider (an unknown bare name, a malformed MCP name).
 */
export function normalizeTool(
  raw: string,
  trusted: readonly string[] = [],
): { tool: GrantedTool; server?: string } | undefined {
  let name = raw.trim();
  const paren = name.indexOf("(");
  if (paren > 0) name = name.slice(0, paren).trim();
  if (!name || name.length > 200) return undefined;
  for (const prefix of EM_MCP_PREFIXES) {
    if (name.startsWith(prefix)) {
      const bare = name.slice(prefix.length);
      if (EM_TOOL_NAMES.has(bare)) return { tool: { id: bare, kind: "em" } };
      break; // not one of eminiar's tools: classed below as an unknown server's (re-review F3)
    }
  }
  if (name.startsWith("mcp__")) {
    const m = splitMcp(name);
    if (!m) {
      // `mcp__server` (a whole server) as an allow entry: class by server, verb unknown.
      const server = name.slice(5);
      if (!server || server.includes("__")) return undefined;
      const cls = mcpClassOf(server, trusted);
      return { tool: { id: `mcp:${cls}:write`, kind: "mcp", mcp: { cls, verb: "write" } }, server };
    }
    let cls = mcpClassOf(m.server, trusted);
    // eminiar registers only EM_TOOL_NAMES. Any other tool under an eminiar-looking server name
    // (any case) is another server's that borrowed the name: dropping it would hide what it can
    // do, so it counts as an unknown server's tool, its verb read from its name as for any other.
    // The id stays mcp:<class>:<verb>, so the raw tool name never rides along.
    if (cls === "first-party" && !EM_TOOL_NAMES.has(m.tool)) cls = "unknown";
    const verb = mcpVerbOf(m.tool);
    return {
      tool: { id: `mcp:${cls}:${verb}`, kind: "mcp", mcp: { cls, verb } },
      server: m.server,
    };
  }
  if (EM_TOOL_NAMES.has(name)) return { tool: { id: name, kind: "em" } };
  if (name === "Task") name = "Agent";
  return BUILTIN_TOOLS.has(name) ? { tool: { id: name, kind: "builtin" } } : undefined;
}

// --- building a grant --------------------------------------------------------------------------

interface Built {
  tools: GrantedTool[];
  servers: string[];
}

function build(names: readonly string[], trusted: readonly string[]): Built {
  const seen = new Set<string>();
  const tools: GrantedTool[] = [];
  const servers = new Set<string>();
  for (const n of names.slice(0, MAX_GRANT_TOOLS)) {
    const t = normalizeTool(n, trusted);
    if (!t) continue;
    if (t.server) servers.add(t.server);
    if (seen.has(t.tool.id)) continue;
    seen.add(t.tool.id);
    tools.push(t.tool);
  }
  return { tools, servers: [...servers] };
}

/** Does `deny` remove `name`? A deny entry names a tool, or a whole MCP server (`mcp__server`). */
function denied(name: string, deny: ReadonlySet<string>): boolean {
  const bare = name.includes("(") ? name.slice(0, name.indexOf("(")) : name;
  if (
    deny.has(bare) ||
    (bare === "Task" && deny.has("Agent")) ||
    (bare === "Agent" && deny.has("Task"))
  )
    return true;
  const m = splitMcp(bare);
  return !!m && deny.has(`mcp__${m.server}`);
}

function denySet(deny: readonly string[] | undefined): Set<string> {
  return new Set((deny ?? []).map((d) => (d.includes("(") ? d.slice(0, d.indexOf("(")) : d)));
}

function make(
  built: Built,
  status: GrantStatus,
  source: GrantSource,
  extra: {
    permissionMode?: string | undefined;
    mcpServers?: boolean | undefined;
    description?: string | undefined;
  } = {},
): ToolGrant {
  const g: ToolGrant = { tools: built.tools, status, source };
  if (extra.permissionMode) g.permissionMode = extra.permissionMode;
  if (extra.mcpServers) g.mcpServers = true;
  if (extra.description) g.description = extra.description;
  if (built.servers.length) g.local = { servers: built.servers };
  return g;
}

/** What a subagent with no `tools` line gets: the inherit set minus `deny`. */
function inheritTools(deny: ReadonlySet<string>, trusted: readonly string[]): Built {
  return build(
    INHERIT_TOOLS.filter((t) => !denied(t, deny)),
    trusted,
  );
}

/** The inherit grant: the session's tools, MCP servers not enumerated. */
export function inheritGrant(
  source: GrantSource = "session",
  status: GrantStatus = "inherit",
): ToolGrant {
  return make(inheritTools(new Set(), []), status, source);
}

/**
 * A swarm worker's grant, exactly what its generated agent file carries (roleToolGrant is what
 * the file is rendered from). `tools` unset: the worker inherits everything not disallowed.
 */
export function grantFromRole(
  role: Pick<RoleSpec, "tools" | "disallowedTools" | "description"> &
    Partial<Pick<RoleSpec, "toolsProfile">>,
  trusted: readonly string[] = [],
): ToolGrant {
  const { allow, deny } = roleToolGrant(role);
  const d = denySet(deny);
  const extra = { description: role.description };
  if (!allow) return make(inheritTools(d, trusted), "inherit", "role", extra);
  return make(
    build(
      allow.filter((t) => !denied(t, d)),
      trusted,
    ),
    "known",
    "role",
    extra,
  );
}

/** An agent definition's grant (AgentPin.grant): its `tools` list, or the inherit set. */
function grantFromDefinition(g: AgentGrant, trusted: readonly string[]): ToolGrant {
  const extra = {
    permissionMode: g.permissionMode,
    mcpServers: g.mcpServers,
    description: g.description,
  };
  if (g.conflict) return make(inheritTools(new Set(), trusted), "unknown", "agent-file", extra);
  const d = denySet(g.disallowedTools);
  if (!g.tools) return make(inheritTools(d, trusted), "inherit", "agent-file", extra);
  return make(
    build(
      g.tools.filter((t) => !denied(t, d)),
      trusted,
    ),
    "known",
    "agent-file",
    extra,
  );
}

/**
 * The grant of the agent a dispatch names. Order: the definition's own lines (any location),
 * then the built-in table, a fork (inherits the session), else an unreadable or unknown agent,
 * which gets the inherit set with status "unknown".
 */
export function grantForAgent(
  agentType: string | undefined,
  pin: AgentPin | undefined,
  trusted: readonly string[] = [],
): ToolGrant {
  if (pin?.grant) return grantFromDefinition(pin.grant, trusted);
  if (agentType === "fork") return make(inheritTools(new Set(), trusted), "inherit", "fork");
  if (agentType && Object.hasOwn(BUILTIN_GRANTS, agentType) && pin?.source !== "project") {
    const b = BUILTIN_GRANTS[agentType]!;
    if (b.tools) return make(build(b.tools, trusted), "known", "builtin");
    return make(inheritTools(new Set(b.without ?? []), trusted), "inherit", "builtin");
  }
  return make(inheritTools(new Set(), trusted), "unknown", "agent-file");
}

/** A caller-supplied `tools` list (em_adjudicate, the CLI). Empty or unusable: the inherit set. */
export function grantFromCaller(
  tools: readonly string[] | undefined,
  trusted: readonly string[] = [],
): ToolGrant {
  if (!tools?.length) return make(inheritTools(new Set(), trusted), "inherit", "caller");
  const built = build(tools, trusted);
  return built.tools.length
    ? make(built, "known", "caller")
    : make(inheritTools(new Set(), trusted), "inherit", "caller");
}

/** The main session (the prompt surface). */
export function grantForSession(): ToolGrant {
  return inheritGrant("session", "inherit");
}

// --- autonomy ----------------------------------------------------------------------------------

/** Permission modes under which nobody confirms a tool call (design 4.4). */
const AUTONOMOUS_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "dontAsk", "auto"]);

/**
 * The multiplier of each level, applied to the score (design 5.4). It is taxonomy.ts's table
 * under its older name, not a second copy: the numbers live in one place.
 */
export const AUTONOMY_FACTOR: Readonly<Record<Autonomy, number>> = AUTONOMY_MULT;

function levelOfMode(mode: string | undefined): Autonomy {
  if (!mode) return "default";
  if (AUTONOMOUS_MODES.has(mode)) return "autonomous";
  if (mode === "default" || mode === "plan") return "manual";
  return "default";
}

/**
 * How autonomously a dispatch runs. `session` is the hook input's permission_mode (the parent),
 * `agent` the agent file's permissionMode. A parent in bypassPermissions/dontAsk/auto wins, and
 * acceptEdits overrides the agent's own mode; otherwise the agent's mode counts, then the parent's.
 * Missing or unknown: default.
 */
export function autonomyOf(session: string | undefined, agent?: string | undefined): Autonomy {
  if (session && AUTONOMOUS_MODES.has(session)) return "autonomous";
  if (session === "acceptEdits") return "default";
  return levelOfMode(agent ?? session);
}
