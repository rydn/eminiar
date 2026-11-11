import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigSchema, loadConfig } from "../../src/config.js";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { addDocSources, pickCandidates, removeDocSource } from "../../src/docs/add.js";
import { catalogForProvider, catalogLookup } from "../../src/docs/catalog.js";
import { categoryInfo, docCategory } from "../../src/docs/category.js";
import { discoverDocs, rootDomain } from "../../src/docs/discover.js";
import {
  clearSyncState,
  type DocSource,
  docsTag,
  MANIFEST_MAX_BYTES,
  ManifestRefusedError,
  makeSource,
  manifestPath,
  probeManifestAt,
  readManifest,
  readManifestAt,
  removeSource,
  setSyncState,
  syncState,
  upsertSources,
} from "../../src/docs/manifest.js";
import { docGuesses, githubRepo, resolveProvider } from "../../src/docs/resolve.js";
import { looksLikeSpec, specToMarkdown } from "../../src/docs/specs.js";
import { extractLinks, scopeOf, syncSource, syncSources } from "../../src/docs/sync.js";
import { docsSourceFor, suggest } from "../../src/hooks/routing.js";
import { indexContent } from "../../src/index/indexer.js";
import { renderProjectBrief } from "../../src/session/brief.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emDocs, orphanedDocSources } from "../../src/tools/em_docs.js";
import { emReindex } from "../../src/tools/em_graph.js";
import { emSearch } from "../../src/tools/em_search.js";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;
let server: Server;
let base = "";

const textOf = (r: { content: Array<{ text: string }>; isError?: boolean }) =>
  r.content.map((c) => c.text).join("\n");

const OPENAPI = `openapi: 3.0.0
info:
  title: Pet Store
  version: 1.2.0
  description: Pets as a service.
servers:
  - url: https://api.pets.test/v1
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
  schemas:
    Pet:
      type: object
      required: [id, name]
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        tags: { type: array, items: { type: string } }
paths:
  /pets:
    get:
      summary: List pets
      operationId: listPets
      tags: [pets]
      parameters:
        - name: limit
          in: query
          required: false
          schema: { type: integer }
          description: Page size
      responses:
        '200':
          description: A page of pets
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Pet' } }
    post:
      summary: Create a pet
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
      responses:
        '201': { description: Created }
`;

const POSTMAN = JSON.stringify({
  info: {
    name: "Vendor API",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [{ key: "baseUrl", value: "https://api.vendor.test" }],
  item: [
    {
      name: "Items",
      item: [
        {
          name: "List items",
          request: {
            method: "GET",
            header: [{ key: "Authorization", value: "Bearer {{token}}" }],
            url: {
              raw: "{{baseUrl}}/items?page=1",
              host: ["{{baseUrl}}"],
              path: ["items"],
              query: [{ key: "page", value: "1" }],
            },
            description: "Lists the items.",
          },
          response: [{ name: "ok", code: 200, body: '{"items":[]}' }],
        },
      ],
    },
  ],
});

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

beforeAll(async () => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-docs-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      dependencies: {
        moleculer: "^0.14",
        zod: "^3",
        "@aws-sdk/client-s3": "^3",
        "some-unknown-lib": "^1",
        "@types/node": "*",
        shared: "workspace:*",
      },
      devDependencies: { vitest: "^2" },
    }),
  );
  writeFileSync(
    join(root, ".env.example"),
    "SUMSUB_APP_TOKEN=\nSUMSUB_SECRET_KEY=\nPAYGATE_API_KEY=\nPAYGATE_BASE_URL=https://api.paygate-pay.com/v1\nPORT=3000\n",
  );
  writeFileSync(
    join(root, "docker-compose.yml"),
    "services:\n  nats:\n    image: nats:2.10\n  db:\n    image: mongo:7\n  app:\n    image: 1234.dkr.ecr.af-south-1.amazonaws.com/own:1\n",
  );
  writeFileSync(join(root, "README.md"), "# Demo\n\nA demo project.\n");
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(
    join(root, "docs/guide.md"),
    "# Guide\n\nThe ledger posts journals for every transfer.\n",
  );
  writeFileSync(join(root, "docs/adr/0001-ledger.md"), "# ADR 1\n\nUse double entry.\n");
  writeFileSync(join(root, "openapi.yaml"), OPENAPI);
  writeFileSync(join(root, "vendor.postman_collection.json"), POSTMAN);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src/client.ts"),
    [
      'const r = await fetch("https://api.paygate-pay.com/v1/charges");',
      'axios.get("https://api.openai.com/v1/models");',
      "// see https://github.com/foo/bar for details",
      'const spec = "https://api.acme-pay.io/openapi.json";',
      'const img = "https://cdn.jsdelivr.net/npm/x";',
      'const DOCS = "https://docs.vendorx.io/reference/intro";',
      "// docs: https://docs.commented-out.io/guide",
      'const input = h("input", { placeholder: "https://docs.example-only.io/guide/" });',
    ].join("\n"),
  );
  // a table of vendor links (a docs catalogue, a link list) is not evidence of using each vendor
  writeFileSync(
    join(root, "src/links.ts"),
    `export const LINKS = [\n${Array.from(
      { length: 20 },
      (_, n) => `  "https://docs.listed${n}.io/guide",`,
    ).join("\n")}\n];\n`,
  );
  // test fixtures and hidden worktree copies must not count as integrations
  mkdirSync(join(root, "src/__tests__"));
  writeFileSync(
    join(root, "src/__tests__/client.test.ts"),
    'await fetch("https://api.testonly-pay.com/v1/x");\n',
  );
  mkdirSync(join(root, ".feature-worktrees/x/src"), { recursive: true });
  writeFileSync(
    join(root, ".feature-worktrees/x/src/a.ts"),
    'await fetch("https://api.hidden-pay.com/v1/x");\n',
  );
  writeFileSync(join(root, ".feature-worktrees/x/package.json"), '{"name":"hidden"}');
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github/copilot-instructions.md"), "# Rules\n\nUse tabs.\n");
  mkdirSync(join(root, "svc"));
  writeFileSync(
    join(root, "svc/package.json"),
    JSON.stringify({ name: "svc", dependencies: { express: "^4" } }),
  );
  writeFileSync(join(root, "svc/README.md"), "# svc\n");
  // a second checkout of the same package (a git worktree) is scanned once
  mkdirSync(join(root, "svc-copy"));
  writeFileSync(
    join(root, "svc-copy/package.json"),
    JSON.stringify({ name: "svc", dependencies: { koa: "^2" } }),
  );
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);

  server = createServer((req, res) => {
    const u = req.url ?? "/";
    const html = (t: string, b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(t, b));
    };
    if (u === "/docs/" || u === "/docs/index.html")
      html(
        "Docs Home",
        '<p>Welcome to the crawl.</p><a href="/docs/a.html">Chapter A</a> <a href="/other/b.html">Elsewhere</a> <a href="/docs/img.png">img</a> <a href="/docs/openapi.json">spec</a> <a href="/docs/a.html#frag">again</a>',
      );
    else if (u === "/docs/a.html")
      html("Chapter A", "<p>Chapter A explains rate limits in detail.</p>");
    else if (u === "/other/b.html") html("Other", "<p>Should not be crawled.</p>");
    else if (u === "/docs/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Remote API", version: "2" },
          paths: {
            "/widgets": {
              get: { summary: "List widgets", responses: { "200": { description: "ok" } } },
            },
          },
        }),
      );
    } else if (u === "/") html("Probe Home", "<p>home</p>");
    else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  closeAllStorage();
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

describe("catalogue", () => {
  it("matches packages, scopes, env prefixes, images and api hosts", () => {
    expect(catalogLookup("npm", "moleculer")?.id).toBe("moleculer");
    expect(catalogLookup("npm", "@aws-sdk/client-s3")?.id).toBe("aws");
    expect(catalogLookup("env", "SUMSUB_APP_TOKEN")?.id).toBe("sumsub");
    expect(catalogLookup("env", "SUMSUBX")).toBeUndefined();
    expect(catalogLookup("image", "docker.io/library/mongo:7")?.id).toBe("mongodb");
    expect(catalogLookup("api", "test-api.sumsub.com")?.id).toBe("sumsub");
    expect(catalogLookup("api", "sumsub.com.evil.test")).toBeUndefined();
    expect(catalogForProvider("npm:zod")?.id).toBe("zod");
    expect(catalogForProvider("files:terraform")?.id).toBe("terraform");
  });
  it("derives root domains", () => {
    expect(rootDomain("api.eu.sumsub.com")).toBe("sumsub.com");
    expect(rootDomain("api.bank.co.za")).toBe("bank.co.za");
    expect(rootDomain("zod.dev")).toBe("zod.dev");
  });
});

describe("categories", () => {
  const cat = (s: Parameters<typeof docCategory>[0]) =>
    docCategory(s, s.provider ? catalogForProvider(s.provider) : undefined);
  it("classifies discovered local sources by their discovery title or name", () => {
    expect(
      cat({ kind: "path", name: "igor-readme", title: "project readme and top-level guides" }),
    ).toBe("readme");
    expect(cat({ kind: "path", name: "igor-docs", title: "docs/ directory" })).toBe("guides");
    expect(cat({ kind: "path", name: "adr", title: "architecture decision records" })).toBe("adr");
    expect(
      cat({
        kind: "path",
        name: "x-agent-instructions",
        title: "Copilot / Claude / Cursor instructions",
      }),
    ).toBe("agent-instructions");
    expect(
      cat({
        kind: "path",
        name: "x-api-specs",
        title: "OpenAPI / Postman / GraphQL / protobuf specs",
      }),
    ).toBe("api-specs");
    expect(
      cat({ kind: "path", name: "x-env-example", title: "environment variable reference" }),
    ).toBe("env-reference");
    expect(
      cat({
        kind: "path",
        name: "x-deploy-config",
        title: "Terraform, Kubernetes, Helm, Compose and CI workflow files",
      }),
    ).toBe("deploy-config");
    // name suffix alone, no title
    expect(cat({ kind: "path", name: "spendl-tenants-readme" })).toBe("readme");
    expect(cat({ kind: "path", name: "docs" })).toBe("guides");
  });
  it("classifies hand-registered paths by what they point to", () => {
    expect(cat({ kind: "path", name: "spec", path: "api", glob: ["openapi.yaml"] })).toBe(
      "api-specs",
    );
    expect(cat({ kind: "path", name: "handbook", path: "documentation" })).toBe("guides");
    expect(
      cat({ kind: "path", name: "infra", path: ".", glob: ["**/*.tf", "k8s/**/*.yaml"] }),
    ).toBe("deploy-config");
    expect(cat({ kind: "path", name: "notes", path: "notes", glob: ["*.org"] })).toBe("local");
  });
  it("classifies external sources by catalogue tier, then provider kind", () => {
    const awsTier = catalogForProvider("npm:@aws-sdk/client-s3")?.tier ?? "library";
    expect(cat({ kind: "url", name: "aws", provider: "npm:@aws-sdk/client-s3" })).toBe(awsTier);
    const ghTier = catalogForProvider("files:github-actions")?.tier ?? "library";
    expect(cat({ kind: "url", name: "github", provider: "files:github-actions" })).toBe(ghTier);
    expect(cat({ kind: "url", name: "tool", provider: "files:unknown-infra-tool" })).toBe("infra");
    expect(cat({ kind: "url", name: "img", provider: "image:unknown-image" })).toBe("infra");
    expect(cat({ kind: "url", name: "ott", provider: "api:test-payoutapi.ott-mobile.com" })).toBe(
      "api",
    );
    expect(cat({ kind: "url", name: "lib", provider: "pypi:some-unknown-package-xyz" })).toBe(
      "library",
    );
    expect(cat({ kind: "url", name: "svc", provider: "env:SOME_UNKNOWN_SERVICE_URL" })).toBe(
      "service",
    );
    expect(cat({ kind: "url", name: "minio", urls: ["https://min.io/docs"] })).toBe("web");
    expect(categoryInfo("service").group).toBe("external");
    expect(categoryInfo("readme").group).toBe("project");
    expect(categoryInfo("bogus").id).toBe("local");
  });
});

describe("discovery", () => {
  it("finds local docs, providers, registry packages, unknown prefixes and api hosts", () => {
    const d = discoverDocs(ctx);
    expect(d.projects).toEqual([".", "svc"]);
    const local = Object.fromEntries(d.local.map((c) => [c.name, c]));
    expect(Object.keys(local)).toEqual(
      expect.arrayContaining([
        "readme",
        "docs",
        "agent-instructions",
        "api-specs",
        "env-example",
        "deploy-config",
        "svc-readme",
      ]),
    );
    // docs/adr is already covered by the docs/ candidate, so it is not proposed twice
    expect(local.adr).toBeUndefined();
    expect(local.docs?.path).toBe("docs");
    expect(local.docs?.files).toBe(2);
    expect(local["api-specs"]?.glob).toEqual(
      expect.arrayContaining(["openapi.yaml", "vendor.postman_collection.json"]),
    );
    expect(local["svc-readme"]?.project).toBe("svc");

    const prov = Object.fromEntries(d.providers.map((p) => [p.name, p]));
    expect(prov.moleculer?.confidence).toBe("catalog");
    expect(prov.moleculer?.evidence).toContain("npm:moleculer");
    expect(prov.aws?.evidence).toContain("npm:@aws-sdk/client-s3");
    expect(prov.nats?.evidence).toContain("image:nats:2.10");
    expect(prov.mongodb?.confidence).toBe("catalog");
    expect(prov.sumsub?.evidence).toContain("env:SUMSUB_APP_TOKEN");
    expect(prov.openai?.evidence.some((e) => e.startsWith("api:api.openai.com"))).toBe(true);
    expect(prov.express?.usedBy).toEqual(["svc"]);
    expect(prov["some-unknown-lib"]?.confidence).toBe("registry");
    expect(prov.vitest).toBeUndefined();
    expect(prov.paygate?.confidence).toBe("unknown");
    expect(prov.paygate?.provider).toBe("env:PAYGATE");
    // api host without a catalogue entry → probed at add time
    expect(prov["paygate-pay"]?.confidence).toBe("probe");
    expect(prov["paygate-pay"]?.provider).toBe("api:api.paygate-pay.com");
    // external APIs are indexed in full; dependencies keep the catalogue's small crawl
    expect(prov["paygate-pay"]?.crawl).toEqual({ depth: 2, maxPages: 150 });
    expect(prov.openai?.crawl).toEqual({ depth: 2, maxPages: 150 });
    expect(prov.sumsub?.crawl).toEqual({ depth: 2, maxPages: 150 });
    expect(prov.vendorx?.crawl).toEqual({ depth: 2, maxPages: 150 });
    expect(prov.moleculer?.crawl).toEqual({ depth: 1, maxPages: 12 });
    expect(prov.nats?.crawl).toEqual({ depth: 1, maxPages: 12 });
    // a referenced spec url is a complete seed
    expect(prov["acme-pay"]?.urls).toEqual(["https://api.acme-pay.io/openapi.json"]);
    expect(prov["acme-pay"]?.confidence).toBe("catalog");
    // a documentation page linked from code is a ready seed, not an API call
    expect(prov.vendorx?.confidence).toBe("catalog");
    expect(prov.vendorx?.provider).toBe("link:docs.vendorx.io");
    expect(prov.vendorx?.urls).toEqual(["https://docs.vendorx.io/reference/intro"]);
    // comments, test fixtures, hidden worktrees and duplicate checkouts stay out
    expect(prov["commented-out"]).toBeUndefined();
    expect(prov["testonly-pay"]).toBeUndefined();
    expect(prov["hidden-pay"]).toBeUndefined();
    expect(d.providers.some((p) => p.provider.includes("docs.listed"))).toBe(false);
    expect(prov["example-only"]).toBeUndefined();
    expect(prov.koa).toBeUndefined();
    // excluded hosts never surface
    expect(
      d.providers.some((p) => p.provider.includes("github.com") || p.provider.includes("jsdelivr")),
    ).toBe(false);
    expect(d.providers.some((p) => p.name === "shared" || p.name === "types-node")).toBe(false);

    const dev = discoverDocs(ctx, { includeDev: true });
    expect(dev.providers.some((p) => p.name === "vitest")).toBe(true);
    const alone = discoverDocs(ctx, { subprojects: false });
    expect(alone.projects).toEqual(["."]);
    expect(alone.providers.some((p) => p.name === "express")).toBe(false);
  });

  it("picks recommended candidates without registry packages", () => {
    const d = discoverDocs(ctx);
    const rec = pickCandidates(d, "recommended");
    const names = rec.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["docs", "sumsub", "paygate-pay", "vendorx"]));
    // frameworks and infrastructure are opt-in: Claude knows them and their sites are large
    expect(names).not.toContain("moleculer");
    expect(names).not.toContain("nats");
    expect(pickCandidates(d, "catalog").map((r) => r.name)).toEqual(
      expect.arrayContaining(["moleculer", "nats", "sumsub"]),
    );
    expect(pickCandidates(d, "infra").map((r) => r.name)).toEqual(
      expect.arrayContaining(["nats", "mongodb"]),
    );
    expect(pickCandidates(d, "infra").map((r) => r.name)).not.toContain("moleculer");
    expect(names).not.toContain("some-unknown-lib");
    expect(names).not.toContain("paygate");
    expect(pickCandidates(d, "registry").map((r) => r.name)).toEqual(["some-unknown-lib"]);
    expect(pickCandidates(d, "local", ["docs"]).map((r) => r.name)).toEqual(["docs"]);
    // registered candidates are skipped unless a forced add asks to refresh them
    upsertSources(ctx, [
      {
        name: "sumsub",
        kind: "url",
        urls: ["https://docs.sumsub.com/"],
        provider: "env:SUMSUB_APP_TOKEN",
      },
    ]);
    const d2 = discoverDocs(ctx);
    expect(pickCandidates(d2, "service").map((r) => r.name)).not.toContain("sumsub");
    expect(
      pickCandidates(d2, "service", undefined, { includeRegistered: true }).map((r) => r.name),
    ).toContain("sumsub");
    removeSource(ctx, "sumsub");
  });
});

describe("specs", () => {
  it("renders an OpenAPI document one section per operation", () => {
    expect(looksLikeSpec("openapi.yaml", OPENAPI)).toBe(true);
    expect(looksLikeSpec("notes.md", "# hi")).toBe(false);
    const s = specToMarkdown(OPENAPI);
    expect(s?.kind).toBe("openapi");
    expect(s?.operations).toBe(2);
    expect(s?.title).toBe("Pet Store v1.2.0");
    expect(s?.markdown).toContain("## GET /pets — List pets");
    expect(s?.markdown).toContain("| limit | query | no | integer | Page size |");
    expect(s?.markdown).toContain("## POST /pets — Create a pet");
    expect(s?.markdown).toContain("### Pet");
    expect(s?.markdown).toContain("id: string(uuid)");
    expect(s?.markdown).toContain("**bearer**: http bearer");
  });
  it("renders a Postman collection", () => {
    const s = specToMarkdown(POSTMAN);
    expect(s?.kind).toBe("postman");
    expect(s?.operations).toBe(1);
    expect(s?.markdown).toContain("## Items");
    expect(s?.markdown).toContain("## GET {{baseUrl}}/items?page=1 — List items");
    expect(s?.markdown).toContain("Headers: Authorization: Bearer {{token}}");
    expect(s?.markdown).toContain("Example responses");
  });
  it("unwraps fenced json as the fetcher produces it", () => {
    const fenced = `\`\`\`json\n${JSON.stringify({ swagger: "2.0", info: { title: "Old" }, paths: { "/x": { get: { summary: "X", responses: {} } } } })}\n\`\`\``;
    expect(specToMarkdown(fenced)?.markdown).toContain("## GET /x — X");
    expect(specToMarkdown('{"not": "a spec"}')).toBeUndefined();
  });
});

describe("manifest and sync", () => {
  it("validates and writes sources", () => {
    expect(makeSource({ name: "Bad Name!", kind: "path", path: "docs" }).name).toBe("bad-name");
    expect(() => makeSource({ name: "x", kind: "url", urls: ["ftp://nope"] })).toThrow(/http/);
    expect(() => makeSource({ name: "x", kind: "path", path: "../outside" })).toThrow(/inside/);
    const r = upsertSources(ctx, [{ name: "docs", kind: "path", path: "docs", glob: ["**/*.md"] }]);
    expect(r.added).toEqual(["docs"]);
    expect(existsSync(join(root, ".eminiar/docs.json"))).toBe(true);
    const m = JSON.parse(readFileSync(join(root, ".eminiar/docs.json"), "utf8")) as {
      version: number;
      sources: Array<{ name: string }>;
    };
    expect(m.version).toBe(1);
    expect(m.sources[0]?.name).toBe("docs");
    expect(upsertSources(ctx, [{ name: "docs", kind: "path", path: "docs" }]).updated).toEqual([
      "docs",
    ]);
  });

  it("indexes a path source and answers lookups", async () => {
    const src = readManifest(ctx).sources.find((s) => s.name === "docs")!;
    const r = await syncSource(ctx, db, src);
    expect(r.pages).toBe(2);
    expect(r.indexed).toBe(2);
    expect(db.countDocuments(docsTag("docs"))).toBe(2);
    const again = await syncSource(ctx, db, src);
    expect(again.unchanged).toBe(2);
    // docs are lexical-only by default: no embedding work is queued for them
    for (const doc of db.documentsBySource(docsTag("docs")))
      expect(db.chunksOfDocument(doc.id).every((c) => c.embedded > 0)).toBe(true);
    const out = textOf(
      await emDocs.handler({ action: "lookup", query: "ledger journals transfer" }, ctx),
    );
    expect(out).toContain("docs/guide.md");
    expect(out).toContain("docs:docs");
    const prefixed = textOf(
      await emSearch.handler({ queries: ["double entry"], source: "docs:*", mode: "lexical" }, ctx),
    );
    expect(prefixed).toContain("0001-ledger.md");
    const only = textOf(
      await emSearch.handler({ queries: ["double entry"], source: "file", mode: "lexical" }, ctx),
    );
    expect(only).toContain("no matches");
  });

  it("renders local API specs per operation when syncing", async () => {
    const o = await addDocSources(ctx, db, [
      { name: "api-specs", path: ".", glob: ["openapi.yaml", "vendor.postman_collection.json"] },
    ]);
    expect(o.added).toEqual(["api-specs"]);
    expect(o.sync[0]?.specs).toBe(2);
    const out = textOf(
      await emDocs.handler({ action: "lookup", query: "list pets limit", name: "api-specs" }, ctx),
    );
    expect(out).toContain("GET /pets");
    expect(out).toContain("Pet Store");
  });

  it("crawls a url source within scope, uses the cache, renders fetched specs", async () => {
    expect(scopeOf(new URL("https://x.test/docs/api.html"))).toBe("/docs/");
    expect(scopeOf(new URL("https://x.test/reference/react"))).toBe("/reference/react");
    expect(
      extractLinks(
        "[a](/x) ![i](/i.png) <https://y.test/z> [b](https://x.test/q?x=1#f)",
        "https://x.test/d/",
      ),
    ).toEqual(["https://x.test/x", "https://x.test/i.png", "https://x.test/q", "https://y.test/z"]);
    const o = await addDocSources(ctx, db, [
      { name: "remote", urls: [`${base}/docs/`], crawl: { depth: 1, maxPages: 10 } },
    ]);
    expect(o.added).toEqual(["remote"]);
    const s = o.sync[0]!;
    expect(s.pages).toBe(3); // index, chapter a, openapi.json — not /other, not the png, no duplicate for #frag
    expect(s.specs).toBe(1);
    expect(s.errors).toEqual([]);
    expect(db.countDocuments(docsTag("remote"))).toBe(3);
    const titles = db.documentsBySource(docsTag("remote")).map((d) => d.title);
    expect(titles.some((t) => t.startsWith("Remote API v2"))).toBe(true);
    const src = readManifest(ctx).sources.find((x) => x.name === "remote")!;
    const cached = await syncSource(ctx, db, src);
    expect(cached.cached).toBe(3);
    expect(cached.unchanged).toBe(3);
    const forced = await syncSource(ctx, db, src, { force: true });
    expect(forced.cached).toBe(0);
    expect(forced.indexed).toBe(3);
    const out = textOf(await emDocs.handler({ action: "lookup", query: "rate limits" }, ctx));
    expect(out).toContain("Chapter A");
    const stats = db.documentSourceStats("docs:");
    expect(stats.map((x) => x.source).sort()).toEqual([
      "docs:api-specs",
      "docs:docs",
      "docs:remote",
    ]);
  });

  it("lists, briefs, hints and removes", async () => {
    const list = textOf(await emDocs.handler({ action: "list" }, ctx));
    expect(list).toContain("- remote [url]");
    expect(list).toContain("3 doc(s)");
    expect(renderProjectBrief(ctx, db, 2000)).toContain("Docs indexed");
    expect(docsSourceFor(`${base}/docs/anything`, root)).toBe("remote");
    expect(suggest("WebFetch", { url: `${base}/docs/x` }, root)?.reason).toContain(
      'documentation source "remote"',
    );
    expect(suggest("WebFetch", { url: "https://elsewhere.test/" }, root)?.tool).toBe(
      "em_fetch_and_index",
    );
    const ws = suggest("WebSearch", { query: "how do I" }, root);
    expect(ws?.annotateOnly).toBe(true);
    expect(ws?.reason).toContain("remote");
    expect(
      suggest("WebSearch", { query: "x" }, mkdtempSync(join(tmpdir(), "em-empty-"))),
    ).toBeUndefined();

    const r = removeDocSource(ctx, db, "remote");
    expect(r).toEqual({ removed: true, documents: 3 });
    expect(readManifest(ctx).sources.some((s) => s.name === "remote")).toBe(false);
    expect(textOf(await emDocs.handler({ action: "remove", name: "remote" }, ctx))).toContain(
      "not registered",
    );
  });

  it("drives discover and add through the tool", async () => {
    const out = textOf(await emDocs.handler({ action: "discover" }, ctx));
    expect(out).toContain("Local docs (");
    expect(out).toContain("- moleculer ← npm:moleculer");
    expect(out).toContain("(registered)");
    expect(out).toContain('pick:"recommended"');
    const add = textOf(
      await emDocs.handler({ action: "add", pick: "local", names: ["readme"], sync: true }, ctx),
    );
    expect(add).toContain("added: readme");
    expect(db.countDocuments(docsTag("readme"))).toBe(1);
    expect(textOf(await emDocs.handler({ action: "discover" }, ctx))).toContain(
      "- readme · . [README.md] · 1 file(s)",
    );
    const bad = await emDocs.handler({ action: "add" }, ctx);
    expect(bad.isError).toBe(true);
  });

  it("reports, flags and removes orphaned docs:* sources that have no manifest entry", async () => {
    // Pages indexed under docs:ghost with no manifest entry: the manifest was deleted or
    // lives on another branch. The tool must say so instead of claiming nothing is registered.
    indexContent(db, {
      source: docsTag("ghost"),
      title: "Ghost API",
      content:
        "# Ghost API\n\nThe spectral endpoint returns ectoplasm quotas per haunted tenant.\n",
      uri: "https://ghost.test/docs/spectral",
    });
    expect(readManifest(ctx).sources.some((s) => s.name === "ghost")).toBe(false);
    expect(
      orphanedDocSources(
        db,
        readManifest(ctx).sources.map((s) => s.name),
      ),
    ).toEqual([expect.objectContaining({ name: "ghost", documents: 1 })]);

    const list = textOf(await emDocs.handler({ action: "list" }, ctx));
    expect(list).toContain("# Orphaned in the index (1");
    expect(list).toContain("- ghost · 1 doc(s)");
    expect(list).toContain('em_docs {action:"remove", names:["ghost"]}');
    expect(list).toMatch(/source\(s\) \+ 1 orphaned/);

    const lookup = textOf(
      await emDocs.handler({ action: "lookup", query: "spectral ectoplasm quotas" }, ctx),
    );
    expect(lookup).toContain("Ghost API");
    expect(lookup).toContain(
      'note: ghost is not in the manifest (orphaned pages); em_docs {action:"list"} explains',
    );
    // registered sources alone carry no note
    expect(
      textOf(await emDocs.handler({ action: "lookup", query: "ledger journals transfer" }, ctx)),
    ).not.toContain("orphaned pages");

    expect(textOf(await emDocs.handler({ action: "remove", name: "ghost" }, ctx))).toBe(
      "removed ghost (orphaned; 1 document(s) dropped)",
    );
    expect(db.countDocuments(docsTag("ghost"))).toBe(0);
    expect(textOf(await emDocs.handler({ action: "list" }, ctx))).not.toContain("Orphaned");

    const unknown = await emDocs.handler({ action: "remove", name: "nobody" }, ctx);
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("nobody: not registered and not in the index");
  });
});

describe("resolution", () => {
  const fake = (routes: Record<string, { status?: number; type?: string; body: string }>) =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      const hit = routes[url];
      if (!hit) return new Response("nope", { status: 404 });
      return new Response(hit.body, {
        status: hit.status ?? 200,
        headers: { "content-type": hit.type ?? "text/html" },
      });
    }) as typeof fetch;

  it("uses the catalogue offline", async () => {
    const r = await resolveProvider("npm:zod");
    expect(r.via).toBe("catalog");
    expect(r.urls[0]).toContain("zod.dev");
    expect(githubRepo("git+ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(githubRepo("https://gitlab.com/o/r")).toBeUndefined();
  });

  it("resolves npm and pypi packages through the registries", async () => {
    const npm = await resolveProvider("npm:some-unknown-lib", {
      fetchImpl: fake({
        "https://registry.npmjs.org/some-unknown-lib/latest": {
          type: "application/json",
          body: JSON.stringify({
            homepage: "https://unknown.dev/docs",
            repository: { url: "git+https://github.com/o/unknown.git" },
            description: "Does things",
          }),
        },
      }),
    });
    expect(npm.via).toBe("npm");
    expect(npm.urls).toEqual([
      "https://unknown.dev/docs",
      "https://raw.githubusercontent.com/o/unknown/HEAD/README.md",
      "https://github.com/o/unknown",
    ]);
    expect(npm.title).toBe("some-unknown-lib — Does things");
    const py = await resolveProvider("pypi:thing", {
      fetchImpl: fake({
        "https://pypi.org/pypi/thing/json": {
          type: "application/json",
          body: JSON.stringify({
            info: {
              summary: "A thing",
              project_urls: {
                Documentation: "https://thing.rtfd.io/",
                Source: "https://github.com/p/thing",
              },
            },
          }),
        },
      }),
    });
    expect(py.urls[0]).toBe("https://thing.rtfd.io/");
    expect(py.urls).toContain("https://raw.githubusercontent.com/p/thing/HEAD/README.md");
    const none = await resolveProvider("npm:missing", { fetchImpl: fake({}) });
    expect(none.via).toBe("none");
    expect((await resolveProvider("go:github.com/gin-gonic/gin")).via).toBe("catalog");
    expect((await resolveProvider("go:example.org/mod/x")).urls[0]).toBe(
      "https://pkg.go.dev/example.org/mod/x",
    );
  });

  it("probes documentation locations for an unknown api host", async () => {
    expect(docGuesses("api.paygate-pay.com")[0]).toBe("https://docs.paygate-pay.com/");
    const r = await resolveProvider("api:api.paygate-pay.com", {
      fetchImpl: fake({
        "https://developer.paygate-pay.com/": { body: "<html><title>Dev</title></html>" },
        "https://api.paygate-pay.com/openapi.json": { type: "application/json", body: "{}" },
      }),
    });
    expect(r.via).toBe("probe");
    expect(r.crawl).toEqual({ depth: 2, maxPages: 150 });
    expect(r.urls).toEqual([
      "https://developer.paygate-pay.com/",
      "https://api.paygate-pay.com/openapi.json",
    ]);
    const miss = await resolveProvider("api:api.nowhere-pay.com", { fetchImpl: fake({}) });
    expect(miss.via).toBe("none");
    expect(miss.notes).toContain("pass urls");
    expect((await resolveProvider("env:PAYGATE")).via).toBe("none");
  });
});

describe("manifest read bound (review #109 F5)", () => {
  const source = { name: "zod", kind: "url", urls: ["https://zod.dev/"], addedAt: "2026-01-01" };
  const valid = JSON.stringify({ version: 1, sources: [source] });
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eminiar-manifest-bound-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a regular manifest, also through a symlink to one", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, valid);
    expect(readManifestAt(file).sources.map((s) => s.name)).toEqual(["zod"]);
    const link = join(dir, "ok-link.json");
    symlinkSync(file, link);
    expect(readManifestAt(link).sources.map((s) => s.name)).toEqual(["zod"]);
  });

  it("reads a missing manifest as empty", () => {
    expect(readManifestAt(join(dir, "absent.json"))).toEqual({ version: 1, sources: [] });
  });

  it("reads a manifest over MANIFEST_MAX_BYTES as empty, and one at the bound normally", () => {
    // Valid JSON either way: only the size decides.
    const pad = (n: number) =>
      `{"version":1,"sources":[${JSON.stringify(source)}],"pad":"${"x".repeat(n)}"}`;
    const at = pad(0);
    const fill = MANIFEST_MAX_BYTES - Buffer.byteLength(at);
    const atBound = join(dir, "at-bound.json");
    writeFileSync(atBound, pad(fill));
    expect(readFileSync(atBound).length).toBe(MANIFEST_MAX_BYTES);
    expect(readManifestAt(atBound).sources).toHaveLength(1);
    const over = join(dir, "over.json");
    writeFileSync(over, pad(fill + 1));
    expect(readManifestAt(over).sources).toEqual([]);
    const overLink = join(dir, "over-link.json");
    symlinkSync(over, overLink);
    expect(readManifestAt(overLink).sources).toEqual([]);
  });

  it("reads a directory, or a symlink to one, as empty", () => {
    const sub = join(dir, "a-dir");
    mkdirSync(sub);
    expect(readManifestAt(sub).sources).toEqual([]);
    const link = join(dir, "dir-link.json");
    symlinkSync(sub, link);
    expect(readManifestAt(link).sources).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "reads a device or a FIFO as empty without blocking",
    () => {
      const dev = join(dir, "zero-link.json");
      symlinkSync("/dev/zero", dev);
      expect(readManifestAt(dev).sources).toEqual([]);
      const fifo = join(dir, "pipe.json");
      execFileSync("mkfifo", [fifo]);
      // Opening a FIFO with no writer for reading would block the hook forever.
      expect(readManifestAt(fifo).sources).toEqual([]);
    },
  );

  it("bounds the PreToolUse docs lookup in routing.ts too", () => {
    const proj = join(dir, "proj");
    mkdirSync(join(proj, ".eminiar"), { recursive: true });
    const file = join(proj, ".eminiar", "docs.json");
    writeFileSync(file, valid);
    expect(docsSourceFor("https://zod.dev/api", proj)).toBe("zod");
    writeFileSync(file, `${valid}${" ".repeat(MANIFEST_MAX_BYTES)}`);
    expect(docsSourceFor("https://zod.dev/api", proj)).toBeUndefined();
  });

  it("docsSourceFor reads the manifest with the project root: a docs.json outside it is not read (#157)", () => {
    const outside = join(dir, "outside-manifest.json");
    writeFileSync(outside, valid);
    const proj = join(dir, "proj-linked");
    mkdirSync(join(proj, ".eminiar"), { recursive: true });
    const link = join(proj, ".eminiar", "docs.json");
    symlinkSync(outside, link);
    // The same file reads fine without a root, so only the root explains the refusal.
    expect(readManifestAt(link).sources.map((s) => s.name)).toEqual(["zod"]);
    expect(readManifestAt(link, proj).sources).toEqual([]);
    expect(docsSourceFor("https://zod.dev/api", proj)).toBeUndefined();
    // A regular manifest inside the project still answers.
    const inside = join(dir, "proj-plain");
    mkdirSync(join(inside, ".eminiar"), { recursive: true });
    writeFileSync(join(inside, ".eminiar", "docs.json"), valid);
    expect(docsSourceFor("https://zod.dev/api", inside)).toBe("zod");
  });
});

describe("manifest writes refuse a manifest they could not read (task #134)", () => {
  const source = { name: "zod", kind: "url", urls: ["https://zod.dev/"], addedAt: "2026-01-01" };
  const valid = JSON.stringify({ version: 1, sources: [source] });
  const add = { name: "vitest", kind: "url" as const, urls: ["https://vitest.dev/"] };
  let proj: string;
  let pctx: ProjectContext;
  let file: string;
  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), "eminiar-manifest-refuse-"));
    mkdirSync(join(proj, ".eminiar"), { recursive: true });
    pctx = getContext(proj);
    // The context resolves the root (macOS tmpdir is a symlink to /private/var).
    file = manifestPath(pctx);
  });
  afterAll(() => {
    rmSync(proj, { recursive: true, force: true });
  });
  const reset = () => rmSync(file, { recursive: true, force: true });
  const refusal = (fn: () => unknown): ManifestRefusedError => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestRefusedError);
      return err as ManifestRefusedError;
    }
    throw new Error("expected a ManifestRefusedError");
  };

  it("creates a missing manifest and edits a readable one", () => {
    reset();
    expect(probeManifestAt(file)).toEqual({ state: "missing" });
    expect(upsertSources(pctx, [add]).added).toEqual(["vitest"]);
    writeFileSync(file, valid);
    expect(upsertSources(pctx, [add]).added).toEqual(["vitest"]);
    expect(readManifest(pctx).sources.map((s) => s.name)).toEqual(["vitest", "zod"]);
    expect(removeSource(pctx, "zod")).toBe(true);
    expect(readManifest(pctx).sources.map((s) => s.name)).toEqual(["vitest"]);
  });

  it("refuses add and remove on an oversized manifest, naming the path and the limit", () => {
    reset();
    const big = `${valid}${" ".repeat(MANIFEST_MAX_BYTES)}`;
    writeFileSync(file, big);
    // Readers still fail open.
    expect(readManifest(pctx).sources).toEqual([]);
    expect(probeManifestAt(file).state).toBe("refused");
    const e = refusal(() => upsertSources(pctx, [add]));
    expect(e.file).toBe(file);
    expect(e.message).toContain(file);
    expect(e.message).toContain(`${MANIFEST_MAX_BYTES}-byte limit`);
    refusal(() => removeSource(pctx, "zod"));
    expect(readFileSync(file, "utf8")).toBe(big);
  });

  it("refuses a manifest that is not valid JSON or not an object (a merge conflict)", () => {
    reset();
    const conflict = `<<<<<<< HEAD\n${valid}\n=======\n{}\n>>>>>>> other\n`;
    writeFileSync(file, conflict);
    expect(refusal(() => upsertSources(pctx, [add])).reason).toBe("it is not valid JSON");
    expect(readFileSync(file, "utf8")).toBe(conflict);
    writeFileSync(file, "[]");
    expect(refusal(() => removeSource(pctx, "zod")).reason).toBe("it is not a JSON object");
    expect(readFileSync(file, "utf8")).toBe("[]");
  });

  it("refuses a directory and a dangling symlink without creating anything", () => {
    reset();
    mkdirSync(file);
    expect(refusal(() => upsertSources(pctx, [add])).reason).toBe("it is not a regular file");
    reset();
    const target = join(pctx.root, "elsewhere.json");
    symlinkSync(target, file);
    expect(refusal(() => upsertSources(pctx, [add])).reason).toBe(
      "it is a symlink to a missing file",
    );
    expect(existsSync(target)).toBe(false);
    reset();
  });

  it("surfaces the refusal through addDocSources, removeDocSource and em_docs", async () => {
    reset();
    const big = `${valid}${" ".repeat(MANIFEST_MAX_BYTES)}`;
    writeFileSync(file, big);
    const pdb = getStorage(pctx);
    await expect(addDocSources(pctx, pdb, [add], { sync: false })).rejects.toBeInstanceOf(
      ManifestRefusedError,
    );
    expect(() => removeDocSource(pctx, pdb, "zod")).toThrow(ManifestRefusedError);
    const r = await emDocs.handler(
      { action: "add", name: "vitest", url: "https://vitest.dev/", sync: false },
      pctx,
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(file);
    const rm = await emDocs.handler({ action: "remove", name: "zod" }, pctx);
    expect(rm.isError).toBe(true);
    expect(textOf(rm)).toContain("refusing to write the docs manifest");
    expect(readFileSync(file, "utf8")).toBe(big);
  });
});

describe("manifest writes stay inside the project and never reduce a manifest (pre-PR review F1 + F5)", () => {
  const source = { name: "zod", kind: "url", urls: ["https://zod.dev/"], addedAt: "2026-01-01" };
  const valid = JSON.stringify({ version: 1, sources: [source] });
  const add = { name: "vitest", kind: "url" as const, urls: ["https://vitest.dev/"] };
  let base: string;
  let n = 0;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "eminiar-manifest-escape-"));
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });
  /** A fresh project under `base` (its own folder, so a sibling file is "outside"). */
  const project = (files: Record<string, string> = {}) => {
    const proj = join(base, `p${n++}`);
    mkdirSync(join(proj, ".git"), { recursive: true });
    writeFileSync(join(proj, "package.json"), "{}");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(proj, rel, ".."), { recursive: true });
      writeFileSync(join(proj, rel), text);
    }
    return getContext(proj);
  };
  const withManifest = (c: ProjectContext, manifest: string): ProjectContext => ({
    ...c,
    config: { ...c.config, docs: { ...c.config.docs, manifest } },
  });
  const refusal = (fn: () => unknown): ManifestRefusedError => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestRefusedError);
      return err as ManifestRefusedError;
    }
    throw new Error("expected a ManifestRefusedError");
  };

  it("the config schema refuses a docs.manifest that is absolute or climbs out", () => {
    const ok = (m: string) => ConfigSchema.safeParse({ docs: { manifest: m } }).success;
    for (const m of [".eminiar/docs.json", "docs/sources.json", "docs/..hidden/x.json", "a..b"])
      expect(ok(m), m).toBe(true);
    for (const m of [
      "",
      "/etc/x.json",
      "\\\\srv\\x",
      "C:\\x.json",
      "c:x",
      "..",
      "../settings.json",
    ])
      expect(ok(m), m).toBe(false);
    for (const m of ["a/../../b.json", "a\\..\\..\\b", "x/..", "./../y", "nul\0.json"])
      expect(ok(m), m).toBe(false);
    // A line break must not hide a `..` segment from the check (#153).
    for (const m of ["a\n/../../x.json", "a\n../x", "a\r\n..\\x", "a\nb.json"])
      expect(ok(m), JSON.stringify(m)).toBe(false);
  });

  it("ignores a project-set docs.manifest outside the project, keeping the rest (repro p-cfg)", () => {
    const victim = join(base, "settings.json");
    const before = JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] }, hooks: { x: 1 } });
    writeFileSync(victim, before);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const c = project({
        "eminiar.config.json": JSON.stringify({
          docs: { manifest: "../settings.json", ttlHours: 5 },
        }),
      });
      expect(c.config.docs.manifest).toBe(".eminiar/docs.json");
      expect(c.config.docs.ttlHours).toBe(5);
      expect(manifestPath(c)).toBe(join(c.root, ".eminiar", "docs.json"));
      upsertSources(c, [add]);
      expect(readFileSync(victim, "utf8")).toBe(before);
      const abs = project({
        "eminiar.config.json": JSON.stringify({ docs: { manifest: victim } }),
      });
      expect(loadConfig(abs.root).docs.manifest).toBe(".eminiar/docs.json");
      const custom = project({
        "eminiar.config.json": JSON.stringify({ docs: { manifest: "docs/sources.json" } }),
      });
      expect(custom.config.docs.manifest).toBe("docs/sources.json");
      expect(err.mock.calls.map((a) => String(a[0])).join("")).toContain("ignoring docs.manifest");
    } finally {
      err.mockRestore();
    }
  });

  it("refuses a manifest path outside the root even when the config was not checked", () => {
    const victim = join(base, "victim2.json");
    const before = JSON.stringify({ permissions: { allow: ["Bash(*)"] }, env: { X: "1" } });
    writeFileSync(victim, before);
    const c = withManifest(project(), "../victim2.json");
    expect(refusal(() => upsertSources(c, [add])).reason).toBe("it is outside the project");
    expect(refusal(() => removeSource(c, "zod")).reason).toBe("it is outside the project");
    // Readers fail open.
    expect(readManifest(c).sources).toEqual([]);
    expect(readFileSync(victim, "utf8")).toBe(before);
  });

  it("refuses a committed symlink to a file outside the project (repro p-manifest 1)", () => {
    const victim = join(base, "victim-package.json");
    const before = JSON.stringify({ name: "victim", scripts: { test: "x" } });
    writeFileSync(victim, before);
    const c = project();
    mkdirSync(join(c.root, ".eminiar"), { recursive: true });
    symlinkSync(join("..", "..", "victim-package.json"), manifestPath(c));
    expect(readManifest(c).sources).toEqual([]);
    expect(refusal(() => upsertSources(c, [add])).reason).toContain("symlink");
    expect(readFileSync(victim, "utf8")).toBe(before);
    // Even a symlink to a manifest-shaped file outside reads as empty.
    writeFileSync(victim, valid);
    expect(readManifest(c).sources).toEqual([]);
  });

  it("reads a symlink to a manifest inside the project but refuses to write through it", () => {
    // Decision: writes refuse every symlink. A rename would replace the committed link with a
    // regular file, and writing through it would edit a file the config does not name.
    const c = project({ "docs/real.json": valid });
    mkdirSync(join(c.root, ".eminiar"), { recursive: true });
    symlinkSync(join("..", "docs", "real.json"), manifestPath(c));
    expect(readManifest(c).sources.map((s) => s.name)).toEqual(["zod"]);
    expect(refusal(() => upsertSources(c, [add])).reason).toBe(
      "it is a symlink, and writes replace only a regular file",
    );
    expect(readFileSync(join(c.root, "docs", "real.json"), "utf8")).toBe(valid);
  });

  it("refuses a manifest folder that is a symlink out of the project", () => {
    const outside = join(base, `outside-${n}`);
    mkdirSync(outside);
    const c = project();
    symlinkSync(outside, join(c.root, ".eminiar"));
    expect(readManifest(c).sources).toEqual([]);
    expect(refusal(() => upsertSources(c, [add])).reason).toBe(
      "its folder resolves outside the project (a symlink)",
    );
    expect(readdirSync(outside)).toEqual([]);
    // A missing folder below it is refused as well, rather than created out there.
    const deep = withManifest(c, ".eminiar/sub/docs.json");
    refusal(() => upsertSources(deep, [add]));
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a manifest a write would reduce: other version, unknown keys, bad sources (F5)", () => {
    const c = project();
    const file = manifestPath(c);
    mkdirSync(join(c.root, ".eminiar"), { recursive: true });
    const bad = { name: "Bad Name", kind: "url", urls: ["https://x/"] };
    const cases: Array<[unknown, string]> = [
      [
        { version: 2, sources: [source] },
        "it has version 2, and this eminiar only writes version 1",
      ],
      [{ sources: [source] }, "it has no version (this eminiar writes version 1)"],
      [
        { version: 1, sources: [source], extra: { keep: true } },
        "it has keys this eminiar does not know (extra)",
      ],
      [{ version: 1, sources: { zod: source } }, "its sources is not an array"],
      [{ version: 1, sources: [source, bad] }, "1 of its sources is not valid entries"],
      [
        { version: 1, sources: [source, { name: "pkg", kind: "git" }, source] },
        "2 of its sources are not valid entries",
      ],
    ];
    for (const [json, reason] of cases) {
      const text = JSON.stringify(json);
      writeFileSync(file, text);
      expect(probeManifestAt(file, { root: c.root, write: true })).toEqual({
        state: "refused",
        reason,
      });
      expect(refusal(() => upsertSources(c, [add])).reason).toBe(reason);
      expect(refusal(() => removeSource(c, "zod")).reason).toBe(reason);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
    // Readers still take the entries they understand.
    writeFileSync(
      file,
      JSON.stringify({ version: 2, sources: [source, { name: "pkg", kind: "git" }] }),
    );
    expect(readManifest(c).sources.map((s) => s.name)).toEqual(["zod"]);
    // A plain v1 manifest without sources is fine to extend.
    writeFileSync(file, JSON.stringify({ version: 1 }));
    expect(upsertSources(c, [add]).added).toEqual(["vitest"]);
  });

  it("writes through a temp file renamed into place, keeping the file mode", () => {
    const c = project({ ".eminiar/docs.json": valid });
    const file = manifestPath(c);
    chmodSync(file, 0o600);
    expect(upsertSources(c, [add]).added).toEqual(["vitest"]);
    expect(readManifest(c).sources.map((s) => s.name)).toEqual(["vitest", "zod"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(c.root, ".eminiar"))).toEqual(["docs.json"]);
    // A new manifest in a folder that does not exist yet.
    const fresh = withManifest(project(), "docs/sources.json");
    upsertSources(fresh, [add]);
    expect(readManifest(fresh).sources.map((s) => s.name)).toEqual(["vitest"]);
  });
});

describe("path sources stay inside the project", () => {
  let proj: string;
  let outside: string;
  let pctx: ProjectContext;
  let pdb: StorageAdapter;
  const src = (name: string, path: string): DocSource => ({
    name,
    kind: "path",
    path,
    glob: ["**/*.md"],
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  beforeAll(() => {
    proj = mkdtempSync(join(tmpdir(), "eminiar-path-sources-"));
    outside = mkdtempSync(join(tmpdir(), "eminiar-path-outside-"));
    writeFileSync(join(outside, "private.md"), "# Private\n\nNot part of the project.\n");
    mkdirSync(join(proj, "docs"), { recursive: true });
    mkdirSync(join(proj, ".eminiar"));
    writeFileSync(join(proj, "package.json"), "{}");
    writeFileSync(join(proj, "docs", "own.md"), "# Own\n\nThe project's guide.\n");
    // Committed symlinks: one inside the source folder, one registered as a source itself.
    symlinkSync(outside, join(proj, "docs", "home"));
    symlinkSync(outside, join(proj, "elsewhere"));
    pctx = getContext(proj);
    pdb = getStorage(pctx);
  });
  afterAll(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("add refuses a path that climbs out after a folder, or names a drive", () => {
    for (const path of ["docs/../../..", "docs/..", "C:\\Users", "\\\\host\\share"])
      expect(() => makeSource({ name: "x", kind: "path", path }), path).toThrow(/inside/);
    expect(makeSource({ name: "x", kind: "path", path: "docs/..hidden" }).path).toBe(
      "docs/..hidden",
    );
  });

  it("a committed manifest's path outside the project is dropped on read, and blocks writes", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeFileSync(
        manifestPath(pctx),
        JSON.stringify({ version: 1, sources: [src("up", "docs/../../.."), src("abs", "/etc")] }),
      );
      expect(readManifest(pctx).sources).toEqual([]);
      expect(err.mock.calls.map((a) => String(a[0])).join("")).toContain(
        'ignoring docs source "up": its path "docs/../../.." must be inside the project',
      );
      expect(() => upsertSources(pctx, [{ name: "docs", kind: "path", path: "docs" }])).toThrow(
        "2 of its sources are not valid entries (up, abs: path outside the project)",
      );
    } finally {
      err.mockRestore();
      rmSync(manifestPath(pctx));
    }
  });

  it("a dropped entry's old pages go on sync, and em_docs remove clears it from the file", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const keep = { ...src("keep", "docs"), glob: ["own.md"] };
      writeFileSync(
        manifestPath(pctx),
        JSON.stringify({ version: 1, sources: [src("up", "docs/../.."), keep] }),
      );
      // Pages an earlier version indexed for the entry.
      indexContent(pdb, {
        source: docsTag("up"),
        title: "up/secret.md",
        uri: "file:///elsewhere/secret.md",
        content: "# Secret\n\nOutside the project.\n",
        kind: "markdown",
      });
      const results = await syncSources(pctx, pdb);
      expect(results.find((r) => r.name === "up")?.errors).toEqual([
        "ignored: its path is outside the project; 1 earlier page(s) removed",
      ]);
      expect(pdb.countDocuments(docsTag("up"))).toBe(0);
      expect(results.find((r) => r.name === "keep")?.indexed).toBe(1);
      // The only lossy entry is the one being removed, so the write is allowed.
      expect(removeDocSource(pctx, pdb, "up").removed).toBe(true);
      const raw = JSON.parse(readFileSync(manifestPath(pctx), "utf8")) as {
        sources: Array<{ name: string }>;
      };
      expect(raw.sources.map((x) => x.name)).toEqual(["keep"]);
      // Another bad entry still blocks it: that write would lose it.
      writeFileSync(
        manifestPath(pctx),
        JSON.stringify({ version: 1, sources: [src("up", "/a"), src("down", "/b"), keep] }),
      );
      expect(() => removeDocSource(pctx, pdb, "up")).toThrow(
        "1 of its sources is not valid entries (down: path outside the project)",
      );
    } finally {
      err.mockRestore();
      rmSync(manifestPath(pctx), { force: true });
      pdb.deleteDocumentsBySource(docsTag("keep"));
    }
  });

  describe("entries dropped for a path outside the project", () => {
    const state = { hash: "h", syncedAt: "2026-01-01T00:00:00.000Z" } as unknown as Parameters<
      typeof setSyncState
    >[2];
    const seed = () => {
      writeFileSync(
        manifestPath(pctx),
        JSON.stringify({
          version: 1,
          sources: [src("up", "docs/../.."), src("down", "/abs"), src("keep", "docs")],
        }),
      );
      for (const name of ["up", "down"]) {
        indexContent(pdb, {
          source: docsTag(name),
          title: `${name}/old.md`,
          uri: `file:///gone/${name}.md`,
          content: `# Old ${name}\n\nEarlier page.\n`,
          kind: "markdown",
        });
        setSyncState(pdb, name, state);
      }
    };
    const cleanup = () => {
      rmSync(manifestPath(pctx), { force: true });
      for (const n of ["up", "down", "keep"]) {
        pdb.deleteDocumentsBySource(docsTag(n));
        clearSyncState(pdb, n);
      }
    };

    it("clears the stale sync state along with the pages", async () => {
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        seed();
        expect(syncState(pdb, "up")).toBeDefined();
        await syncSources(pctx, pdb);
        expect(pdb.countDocuments(docsTag("up"))).toBe(0);
        expect(syncState(pdb, "up")).toBeUndefined();
        expect(syncState(pdb, "down")).toBeUndefined();
      } finally {
        err.mockRestore();
        cleanup();
      }
    });

    it("syncing one source leaves an unrequested dropped entry untouched", async () => {
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        seed();
        const results = await syncSources(pctx, pdb, ["keep"]);
        expect(results.map((r) => r.name)).toEqual(["keep"]);
        expect(pdb.countDocuments(docsTag("up"))).toBe(1);
        expect(pdb.countDocuments(docsTag("down"))).toBe(1);
        expect(syncState(pdb, "up")).toBeDefined();
      } finally {
        err.mockRestore();
        cleanup();
      }
    });

    it("syncing a dropped entry by name gives one result, not also 'not registered'", async () => {
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        seed();
        const results = await syncSources(pctx, pdb, ["up"]);
        expect(results.map((r) => r.name)).toEqual(["up"]);
        expect(results[0]?.errors).toEqual([
          "ignored: its path is outside the project; 1 earlier page(s) removed",
        ]);
        expect(pdb.countDocuments(docsTag("down"))).toBe(1);
      } finally {
        err.mockRestore();
        cleanup();
      }
    });
  });

  it("sync refuses a source that resolves outside the project through a symlink", async () => {
    // A page an earlier version indexed through the link: a refused sync removes it.
    indexContent(pdb, {
      source: docsTag("elsewhere"),
      title: "elsewhere/private.md",
      uri: `file://${join(pctx.root, "elsewhere", "private.md")}`,
      content: "# Private\n\nNot part of the project.\n",
      kind: "markdown",
    });
    expect(pdb.countDocuments(docsTag("elsewhere"))).toBe(1);
    const r = await syncSource(pctx, pdb, src("elsewhere", "elsewhere"));
    expect([r.pages, r.indexed, r.skipped]).toEqual([0, 0, 1]);
    expect(r.errors).toEqual(["elsewhere: refused, it resolves outside the project"]);
    expect(pdb.countDocuments(docsTag("elsewhere"))).toBe(0);
    // Refused, not synced: no state is recorded for it, and an earlier one is cleared.
    expect(syncState(pdb, "elsewhere")).toBeUndefined();
  });

  it("a Read-denied file is never indexed by a path source sync or em_reindex docs", async () => {
    const settings = join(pctx.root, ".claude", "settings.json");
    mkdirSync(join(pctx.root, ".claude"), { recursive: true });
    mkdirSync(join(pctx.root, "guides"), { recursive: true });
    writeFileSync(join(pctx.root, "guides", "open.md"), "# Open\n\nPublic guide.\n");
    writeFileSync(join(pctx.root, "guides", "secret.md"), "# Secret\n\nhunter2 token.\n");
    writeFileSync(
      settings,
      JSON.stringify({ permissions: { deny: ["Read(**/guides/secret.md)"] } }),
    );
    const secret = `file://${join(pctx.root, "guides", "secret.md")}`;
    try {
      const r = await syncSource(pctx, pdb, src("guides", "guides"));
      expect([r.pages, r.indexed, r.skipped]).toEqual([2, 1, 1]);
      expect(r.errors[0]).toContain("guides/secret.md: refused by permission rule");
      expect(pdb.documentsBySource(docsTag("guides")).map((d) => d.title)).toEqual([
        "guides/open.md",
      ]);
      // A denied source folder is refused whole.
      writeFileSync(
        settings,
        JSON.stringify({ permissions: { deny: ["Read(**/guides)", "Read(**/guides/**)"] } }),
      );
      const whole = await syncSource(pctx, pdb, src("guides", "guides"));
      expect(whole.errors[0]).toContain("guides: refused by permission rule");
      expect(pdb.countDocuments(docsTag("guides"))).toBe(0);
      expect(syncState(pdb, "guides")).toBeUndefined();
      // em_reindex docs applies the same rules to the default globs.
      writeFileSync(
        settings,
        JSON.stringify({ permissions: { deny: ["Read(**/guides/secret.md)"] } }),
      );
      await emReindex.handler({ scope: "docs" }, pctx);
      expect(pdb.findDocumentByUri(secret)).toBeUndefined();
      expect(pdb.findDocumentByUri(`file://${join(pctx.root, "guides", "open.md")}`)).toBeDefined();
    } finally {
      rmSync(settings, { force: true });
      rmSync(join(pctx.root, "guides"), { recursive: true, force: true });
      pdb.deleteDocumentsBySource(docsTag("guides"));
      pdb.deleteDocumentsBySource("file");
    }
  });

  it("sync skips files a folder source reaches through a symlink out of the project", async () => {
    const r = await syncSource(pctx, pdb, src("docs", "docs"));
    expect([r.pages, r.indexed, r.skipped]).toEqual([2, 1, 1]);
    expect(r.errors).toEqual(["docs/home/private.md: refused, it resolves outside the project"]);
    expect(pdb.documentsBySource(docsTag("docs")).map((d) => d.title)).toEqual(["docs/own.md"]);
  });

  it("em_reindex docs skips files that resolve outside the project", async () => {
    const out = textOf(await emReindex.handler({ scope: "docs" }, pctx));
    expect(out).toMatch(/docs: \d+ files, \d+ indexed, \d+ unchanged, 2 skipped/);
    for (const rel of ["docs/home/private.md", "elsewhere/private.md"])
      expect(pdb.findDocumentByUri(`file://${join(pctx.root, rel)}`), rel).toBeUndefined();
  });

  it("a project-relative Read(./.env) deny keeps .env out of a `**/.env` docs source (review repro)", async () => {
    const settings = join(pctx.root, ".claude", "settings.json");
    mkdirSync(join(pctx.root, ".claude"), { recursive: true });
    writeFileSync(join(pctx.root, ".env"), "API_TOKEN=zq9xv7secretvalue\n");
    writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }));
    const tag = docsTag("envs");
    try {
      const r = await syncSource(pctx, pdb, { ...src("envs", "."), glob: ["**/.env"] });
      expect(r.indexed).toBe(0);
      expect(r.errors.join("\n")).toContain(".env: refused by permission rule Read(./.env) (deny)");
      expect(pdb.countDocuments(tag)).toBe(0);
      expect(pdb.findDocumentByUri(`file://${join(pctx.root, ".env")}`)).toBeUndefined();
      expect(pdb.termExists("zq9xv7secretvalue")).toBe(false);
      expect(pdb.ftsSearch("trigram", '"zq9xv7secret"', 5)).toEqual([]);
    } finally {
      rmSync(settings, { force: true });
      rmSync(join(pctx.root, ".env"), { force: true });
      pdb.deleteDocumentsBySource(tag);
    }
  });

  it("a file indexed before a Read rule denied it, or before it was deleted, leaves the index", async () => {
    const settings = join(pctx.root, ".claude", "settings.json");
    mkdirSync(join(pctx.root, ".claude"), { recursive: true });
    mkdirSync(join(pctx.root, "notes"), { recursive: true });
    const keep = join(pctx.root, "notes", "keep.md");
    const later = join(pctx.root, "notes", "later.md");
    const gone = join(pctx.root, "notes", "gone.md");
    writeFileSync(keep, "# Keep\n\nStays.\n");
    writeFileSync(later, "# Later\n\nDenied later.\n");
    writeFileSync(gone, "# Gone\n\nDeleted later.\n");
    const tag = docsTag("notes");
    const uris = () =>
      pdb
        .documentsBySource(tag)
        .map((d) => d.uri)
        .sort();
    try {
      await syncSource(pctx, pdb, src("notes", "notes"));
      expect(uris()).toEqual([`file://${gone}`, `file://${keep}`, `file://${later}`]);
      // Denied by a form that resolves against the project root, and deleted from disk.
      writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Read(notes/later.md)"] } }));
      rmSync(gone);
      const r = await syncSource(pctx, pdb, src("notes", "notes"));
      expect(r.skipped).toBe(1);
      expect(uris()).toEqual([`file://${keep}`]);
      // The same for em_reindex docs (source `file`): the denied file goes, the open one stays.
      await emReindex.handler({ scope: "docs" }, pctx);
      expect(pdb.findDocumentByUri(`file://${later}`)).toBeUndefined();
      expect(pdb.findDocumentByUri(`file://${keep}`)).toBeDefined();
    } finally {
      rmSync(settings, { force: true });
      rmSync(join(pctx.root, "notes"), { recursive: true, force: true });
      pdb.deleteDocumentsBySource(tag);
      pdb.deleteDocumentsBySource("file");
    }
  });
});
