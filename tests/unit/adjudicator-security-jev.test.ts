import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAdjudicator } from "../../src/adjudicator/config.js";
import { adjudicate, cacheKeyFor, verdictColumns } from "../../src/adjudicator/engine.js";
import { buildItems } from "../../src/adjudicator/prompt.js";
import type { FetchLike } from "../../src/adjudicator/providers/http.js";
import { resetProviders } from "../../src/adjudicator/providers/index.js";
import { createTypesafeProvider, JEV_PINNED } from "../../src/adjudicator/providers/typesafe.js";
import { resetSecrets } from "../../src/adjudicator/secrets.js";
import {
  BUILTIN_TOOLS,
  EM_TOOL_NAMES,
  normalizeTool,
} from "../../src/adjudicator/security/grant.js";
import {
  isSafeToolId,
  sanitizeSecurityHint,
  securityQuestions,
} from "../../src/adjudicator/security/prompt.js";
import type { SecurityHint } from "../../src/adjudicator/security/types.js";
import type {
  AdjudicationRequest,
  AdjudicatorProvider,
  Verdict,
} from "../../src/adjudicator/types.js";
import { type AdjudicatorConfig, ConfigSchema } from "../../src/config.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { tools as registeredTools } from "../../src/tools/index.js";

const KEY = "sk-SENTINEL-1234567890abcdefXYZ";

beforeEach(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-adj-secjev-"));
  resetSecrets();
  resetProviders();
});
afterEach(() => {
  delete process.env.EMINIAR_HOME;
  resetSecrets();
  resetProviders();
});

const cfgOf = (security: Record<string, unknown> = {}): AdjudicatorConfig =>
  ConfigSchema.parse({
    adjudicator: { enabled: true, remoteConsent: true, provider: "typesafe", security },
  }).adjudicator;

const HINT: SecurityHint = { tools: ["WebFetch", "Read", "mcp:saas:write"], caps: ["egress"] };

const reqs = (n: number, hint?: SecurityHint): AdjudicationRequest[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `k${i}`,
    surface: "plan" as const,
    text: `task ${i}: summarize the vendor docs`,
    ...(hint ? { hints: { security: hint } } : {}),
  }));

interface Q {
  type: string;
  criteria?: string[];
}

interface Call {
  body: { state: { items: Array<Record<string, unknown>> }; questions: Record<string, Q> };
  raw: string;
}

function setup(cfg: AdjudicatorConfig, answer: (id: string, q: Q) => unknown) {
  const calls: Call[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const raw = String(init.body);
    const body = JSON.parse(raw);
    calls.push({ body, raw });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<Q>(body.questions)) answers[id] = answer(id, q);
    return new Response(JSON.stringify({ model: JEV_PINNED, answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  const r = resolveAdjudicator(cfg, { context: "server", env: { TYPESAFE_API_KEY: KEY } });
  const p = createTypesafeProvider(r, cfg, { fetch, env: { TYPESAFE_API_KEY: KEY } });
  return { p, calls, r };
}

const run = (p: ReturnType<typeof setup>["p"], rs: AdjudicationRequest[]) =>
  p.adjudicate(rs, { signal: new AbortController().signal, deadlineMs: 2000 });

/** Answers the routing questions and (when asked) the security ones with fixed values. */
function answers(sev = 3.2, noul = 0.8) {
  return (id: string, q: Q) => {
    if (q.type === "score") {
      const legend = Object.fromEntries(
        (q.criteria ?? []).map((c: string, i: number) => [String(i), c]),
      );
      return {
        type: "score",
        score: id.endsWith("sec_severity") ? sev : 2,
        confidence: 0.7,
        legend,
      };
    }
    if (q.type === "noul") return { type: "noul", noul: id.endsWith("sec_exfil") ? noul : 0.1 };
    const opts = Object.keys(q.criteria ?? {});
    return { type: "choice", choice: opts[0], confidence: 0.6 };
  };
}

describe("security questions in the Jev request", () => {
  it("asks one severity score and six nouls only for items with hints.security", async () => {
    const { p, calls } = setup(cfgOf({ enabled: true, model: "provider" }), answers());
    const batch = [...reqs(1, HINT), ...reqs(1)];
    batch[1] = { ...batch[1]!, key: "k1" };
    await run(p, batch);
    const qs = calls[0]!.body.questions;
    const sec = Object.keys(qs).filter((k) => k.includes(".sec_"));
    expect(sec.sort()).toEqual(
      [
        "sec_severity",
        "sec_exfil",
        "sec_malicious_code",
        "sec_destructive",
        "sec_credentials",
        "sec_injection",
        "sec_untrusted",
      ]
        .map((n) => `i0.${n}`)
        .sort(),
    );
    expect(qs["i0.sec_severity"]?.type).toBe("score");
    expect(qs["i0.sec_severity"]?.criteria).toHaveLength(5);
    expect(qs["i0.sec_exfil"]?.type).toBe("noul");
    // No Choice question among the security ones.
    expect(sec.every((k) => qs[k]?.type !== "choice")).toBe(true);
    const items = calls[0]!.body.state.items;
    expect(items[0]).toMatchObject({
      tools: ["Read", "WebFetch", "mcp:saas:write"],
      capabilities: ["egress"],
    });
    expect(items[1]).not.toHaveProperty("tools");
    expect(items[1]).not.toHaveProperty("capabilities");
  });

  it("the body is byte-identical with security off, and with no hint", async () => {
    const plain = setup(cfgOf(), answers());
    await run(plain.p, reqs(2));
    // A hint is ignored while security.model is off.
    const off = setup(cfgOf({ enabled: true, model: "off" }), answers());
    await run(off.p, reqs(2, HINT));
    // security on, but the requests carry no hint.
    const nohint = setup(cfgOf({ enabled: true, model: "provider" }), answers());
    await run(nohint.p, reqs(2));
    expect(off.calls[0]!.raw).toBe(plain.calls[0]!.raw);
    expect(nohint.calls[0]!.raw).toBe(plain.calls[0]!.raw);
    expect(plain.calls[0]!.raw).not.toContain("sec_");
  });

  it("sends no paths, arguments, server names or history, only safe ids and tags", async () => {
    const dirty = {
      tools: [
        "Read",
        "mcp__github__create_issue",
        "mcp:saas:write",
        "/Users/me/.ssh/id_rsa",
        "Bash(rm -rf /)",
        "WebFetch https://evil.example",
      ],
      caps: ["egress", "secret-sauce", "/etc/passwd"],
    } as unknown as SecurityHint;
    const { p, calls } = setup(cfgOf({ enabled: true, model: "provider" }), answers());
    await run(p, reqs(1, dirty));
    const raw = calls[0]!.raw;
    for (const bad of ["github", "id_rsa", "rm -rf", "evil.example", "/etc/passwd", "secret-sauce"])
      expect(raw).not.toContain(bad);
    expect(calls[0]!.body.state.items[0]).toMatchObject({
      tools: ["Read", "mcp:saas:write"],
      capabilities: ["egress"],
    });
    // The state carries nothing but id, text, tools and capabilities for this item.
    expect(Object.keys(calls[0]!.body.state.items[0]!).sort()).toEqual([
      "capabilities",
      "id",
      "text",
      "tools",
    ]);
  });

  it("an em_* name that is not a registered tool never reaches the body, bare or prefixed", async () => {
    const TOKEN = "ghp_0123456789abcdef0123456789abcdef";
    const dirty = {
      tools: [
        "em_execute",
        `em_${TOKEN}`,
        `mcp__plugin_eminiar_eminiar__em_${TOKEN}`,
        `mcp__eminiar__em_${TOKEN}`,
        "mcp__plugin_eminiar_eminiar__em_sk_live_secret_value_1234567890",
        "em_sk_live_secret_value_1234567890",
        "em_notatool",
        `Bash_${TOKEN}`,
        "mcp:ghp-0123:read",
        "mcp:saas:sk-live",
      ],
      caps: [],
    } as unknown as SecurityHint;
    const { p, calls } = setup(cfgOf({ enabled: true, model: "provider" }), answers());
    await run(p, reqs(1, dirty));
    const raw = calls[0]!.raw;
    for (const bad of ["ghp_", "0123456789abcdef", "sk_live", "sk-live", "notatool", "ghp-"])
      expect(raw).not.toContain(bad);
    expect(calls[0]!.body.state.items[0]).toMatchObject({ tools: ["em_execute"] });
    // the same token in the item text is still redacted, as before
    const withText = reqs(1, dirty).map((r) => ({ ...r, text: `use ${TOKEN} to push` }));
    const again = setup(cfgOf({ enabled: true, model: "provider" }), answers());
    await run(again.p, withText);
    expect(again.calls[0]!.raw).not.toContain(TOKEN);
  });

  it("parses severity onto 0..4 and the threats into ProviderAnswer.security", async () => {
    const { p } = setup(cfgOf({ enabled: true, model: "provider" }), answers(3.6, 0.9));
    const res = await run(p, reqs(1, HINT));
    const s = res.answers[0]?.security;
    expect(s?.severity?.value).toBeCloseTo(3.6);
    expect(s?.severity?.confidence).toBe(0.7);
    expect(s?.threats.exfiltration).toBe(0.9);
    expect(s?.threats.credential_access).toBe(0.1);
    expect(Object.keys(s?.threats ?? {})).toHaveLength(6);
  });

  it("skips a malformed severity and keeps the threats", async () => {
    const f = answers();
    const { p } = setup(cfgOf({ enabled: true, model: "provider" }), (id, q) =>
      id.endsWith("sec_severity")
        ? { type: "score", score: 9, legend: { "0": "a", "4": "b" } }
        : f(id, q),
    );
    const res = await run(p, reqs(1, HINT));
    expect(res.answers[0]?.security?.severity).toBeUndefined();
    expect(res.answers[0]?.security?.threats.exfiltration).toBe(0.8);
  });

  it("no security answer for a request without a hint", async () => {
    const { p } = setup(cfgOf({ enabled: true, model: "provider" }), answers());
    const res = await run(p, reqs(1));
    expect(res.answers[0]?.security).toBeUndefined();
  });
});

describe("hint sanitising", () => {
  it("accepts known tool names and mcp:<class>:<verb> only", () => {
    expect(isSafeToolId("WebFetch")).toBe(true);
    expect(isSafeToolId("em_execute")).toBe(true);
    expect(isSafeToolId("mcp:cloud:delete")).toBe(true);
    expect(isSafeToolId("mcp__github__push")).toBe(false);
    expect(isSafeToolId("mcp:GitHub:push")).toBe(false);
    expect(isSafeToolId("a/b")).toBe(false);
    expect(isSafeToolId("")).toBe(false);
    expect(isSafeToolId(7)).toBe(false);
    // well-shaped but unknown: a bare name, an em_ name, an MCP class or verb
    expect(isSafeToolId("Foo")).toBe(false);
    expect(isSafeToolId("em_ghp_0123456789abcdef0123456789abcdef")).toBe(false);
    expect(isSafeToolId("em_notatool")).toBe(false);
    expect(isSafeToolId("mcp:myserver:read")).toBe(false);
    expect(isSafeToolId("mcp:saas:frobnicate")).toBe(false);
  });

  it("normalizeTool admits only registered em_* names, bare or under either MCP prefix", () => {
    const TOKEN = "ghp_0123456789abcdef0123456789abcdef";
    expect(normalizeTool("em_search")?.tool.id).toBe("em_search");
    expect(normalizeTool("mcp__plugin_eminiar_eminiar__em_search")?.tool.id).toBe("em_search");
    expect(normalizeTool("mcp__eminiar__em_search")?.tool.id).toBe("em_search");
    for (const bad of [
      `em_${TOKEN}`,
      `mcp__plugin_eminiar_eminiar__em_${TOKEN}`,
      `mcp__eminiar__em_${TOKEN}`,
      "mcp__plugin_eminiar_eminiar__em_sk_live_secret_value_1234567890",
      "em_notatool",
    ])
      expect(normalizeTool(bad)).toBeUndefined();
  });

  it("the closed em_* list is exactly the tool registry", () => {
    // Fails when a tool is registered without being added to EM_TOOL_NAMES, or one is removed.
    expect([...EM_TOOL_NAMES].sort()).toEqual(registeredTools.map((t) => t.name).sort());
  });

  it("every known id passes the shape and redaction checks", () => {
    for (const id of [...BUILTIN_TOOLS, ...EM_TOOL_NAMES]) expect(isSafeToolId(id)).toBe(true);
  });

  it("dedupes, sorts and caps the tools at 40", () => {
    const tools = [...BUILTIN_TOOLS, ...EM_TOOL_NAMES];
    expect(tools.length).toBeGreaterThan(40);
    const s = sanitizeSecurityHint({ tools: [...tools, ...tools], caps: [] });
    expect(s?.tools).toHaveLength(40);
    expect(s?.tools).toEqual([...(s?.tools ?? [])].sort());
    expect(sanitizeSecurityHint(undefined)).toBeUndefined();
  });

  it("securityQuestions skips an item without tools", () => {
    expect(securityQuestions([{ id: "i0" }])).toEqual({});
    expect(Object.keys(securityQuestions([{ id: "i0", tools: [] }]))).toHaveLength(7);
  });

  it("buildItems adds nothing without the security option", () => {
    const withHint = buildItems(reqs(1, HINT), 2000);
    expect(withHint).toEqual(buildItems(reqs(1), 2000));
  });
});

describe("cache key and verdict", () => {
  const r = { configured: "typesafe", model: JEV_PINNED } as const;
  const base = { surface: "plan" as const, text: "summarize the docs" };

  it("is unchanged without a hint, and differs with one", () => {
    const k0 = cacheKeyFor(base, r);
    expect(cacheKeyFor({ ...base, hints: {} }, r)).toBe(k0);
    const k1 = cacheKeyFor({ ...base, hints: { security: HINT } }, r);
    expect(k1).not.toBe(k0);
    // Order does not matter; a different grant does.
    const rev = { tools: [...HINT.tools].reverse(), caps: HINT.caps };
    expect(cacheKeyFor({ ...base, hints: { security: rev } }, r)).toBe(k1);
    expect(cacheKeyFor({ ...base, hints: { security: { ...HINT, tools: ["Read"] } } }, r)).not.toBe(
      k1,
    );
  });

  it("verdictColumns stores the model's answer in the scores JSON, and nothing when absent", () => {
    const v = {
      complexity: 1,
      complexityReasons: [],
      tool: { choice: "none", confidence: 0, probs: {} },
      tier: { choice: "sonnet", confidence: 0.5, probs: {} },
      role: { choice: "none", confidence: 0, probs: {} },
      effort: "medium",
      source: "blend",
      provider: "typesafe",
      providerStatus: "ok",
      latencyMs: 1,
      version: "x",
    } as unknown as Verdict;
    const without = JSON.parse(verdictColumns(v).scores as string);
    expect(without).not.toHaveProperty("securityModel");
    const ans = { severity: { value: 3, confidence: 0.5 }, threats: { exfiltration: 0.9 } };
    const withSec = JSON.parse(verdictColumns({ ...v, security: ans }).scores as string);
    expect(withSec.securityModel).toEqual(ans);
  });
});

describe("engine", () => {
  it("copies the model's security answer onto the verdict, stores it and caches it with the hint", async () => {
    const cfg = cfgOf({ enabled: true, model: "provider" });
    const env = { TYPESAFE_API_KEY: KEY } as NodeJS.ProcessEnv;
    const resolved = resolveAdjudicator(cfg, { env });
    const sec = { severity: { value: 3.4, confidence: 0.6 }, threats: { exfiltration: 0.9 } };
    let calls = 0;
    const provider: AdjudicatorProvider = {
      id: "typesafe",
      remote: true,
      dims: ["complexity", "tier", "role"],
      async adjudicate(rs) {
        calls++;
        return {
          answers: rs.map((r) => ({
            key: r.key,
            complexity: { value: 2, confidence: 0.9 },
            ...(r.hints?.security ? { security: sec } : {}),
          })),
          usage: { inTok: 10, outTok: 1, costUsd: 0 },
          latencyMs: 5,
          model: JEV_PINNED,
        };
      },
      async probe() {
        return { ok: true, latencyMs: 1, detail: "fake" };
      },
    };
    const a = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-adj-secjev-db-")), "e.db"), {
      vectors: false,
    });
    try {
      const store = a.adjudicator;
      const opts = { config: cfg, resolved, env, store, provider };
      const withHint = reqs(1, HINT);
      const [x] = await adjudicate(withHint, opts);
      expect(x?.verdict.security).toEqual(sec);
      const row = store.get(x?.rowId as number);
      expect(JSON.parse(row?.scores ?? "{}").securityModel).toEqual(sec);

      // The same request again is a cache hit and still carries the answer.
      const [y] = await adjudicate(withHint, opts);
      expect(y?.verdict.source).toBe("cache");
      expect(y?.verdict.security).toEqual(sec);
      expect(calls).toBe(1);

      // Without the hint: another cache key, no security on the verdict.
      const [z] = await adjudicate(reqs(1), opts);
      expect(z?.verdict.source).not.toBe("cache");
      expect(z?.verdict.security).toBeUndefined();
      expect(calls).toBe(2);
    } finally {
      a.close();
    }
  });
});
