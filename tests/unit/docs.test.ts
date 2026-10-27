import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { addDocSources, pickCandidates, removeDocSource } from "../../src/docs/add.js";
import { catalogForProvider, catalogLookup } from "../../src/docs/catalog.js";
import { categoryInfo, docCategory } from "../../src/docs/category.js";
import { discoverDocs, rootDomain } from "../../src/docs/discover.js";
import {
  docsTag,
  makeSource,
  readManifest,
  removeSource,
  upsertSources,
} from "../../src/docs/manifest.js";
import { docGuesses, githubRepo, resolveProvider } from "../../src/docs/resolve.js";
import { looksLikeSpec, specToMarkdown } from "../../src/docs/specs.js";
import { extractLinks, scopeOf, syncSource } from "../../src/docs/sync.js";
import { docsSourceFor, suggest } from "../../src/hooks/routing.js";
import { indexContent } from "../../src/index/indexer.js";
import { renderProjectBrief } from "../../src/session/brief.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emDocs, orphanedDocSources } from "../../src/tools/em_docs.js";
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
