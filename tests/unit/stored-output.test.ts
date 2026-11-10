import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/adjudicator/redact.js";
import { chunk, hashText } from "../../src/chunker/index.js";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { indexContent, remaskCapturedOutput } from "../../src/index/indexer.js";
import { processOutput } from "../../src/sandbox/output.js";
import { search } from "../../src/search/pipeline.js";
import { closeAllStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { emBatchExecute } from "../../src/tools/em_batch_execute.js";

// What em_execute, em_batch_execute and em_fetch_and_index store: the masked copy in the index.

let ctx: ProjectContext;
let db: SqliteAdapter;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_HOME = home;
  const root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  ctx = { root, id: "test", dbPath: join(home, "t.db"), config: ConfigSchema.parse({}) };
  db = new SqliteAdapter(ctx.dbPath);
});
afterAll(() => {
  db.close();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

describe("captured output in the index", () => {
  it("stores every output with its secrets masked and inlines it as printed", async () => {
    const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const r = await emBatchExecute.handler(
      { commands: [{ label: "env", command: `echo GH_TOKEN=${token}; echo PATH=/usr/bin` }] },
      ctx,
    );
    const out = textOf(r);
    expect(out).toContain(`GH_TOKEN=${token}`);
    const docId = Number(/· doc (\d+)/.exec(out)?.[1]);
    expect(db.chunksOfDocument(docId).map((c) => c.body)).toEqual([
      "GH_TOKEN=***\nPATH=/usr/bin\n",
    ]);
  }, 30_000);

  it("indexes large output with its secrets masked, so no search returns them", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N";
    const big = Array.from({ length: 400 }, (_, i) =>
      i === 3 ? `AWS_SECRET_ACCESS_KEY=${secret}` : `line ${i} routine output noise`,
    ).join("\n");
    const r = await processOutput(db, ctx, {
      stdout: big,
      title: `shell: curl -H "Authorization: Bearer ${bearer}" https://api.example.com`,
      source: "exec",
    });
    // The head/tail preview is as printed; only the stored copy is masked.
    expect(r.text).toContain(secret);
    const id = r.documentId as number;
    expect(db.getDocument(id)?.title).toBe(
      'shell: curl -H "Authorization: Bearer ***" https://api.example.com',
    );
    const stored = db
      .chunksOfDocument(id)
      .map((c) => `${c.title}\n${c.body}`)
      .join("\n");
    expect(stored).toContain("AWS_SECRET_ACCESS_KEY=***");
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(bearer);
    const find = async (q: string) =>
      (await search(db, q, { mode: "lexical", filters: { documentIds: [id] } })).hits.length;
    expect(await find("AWS_SECRET_ACCESS_KEY")).toBeGreaterThan(0);
    expect(await find("wJalrXUtnFEMI")).toBe(0);
    expect(await find("dozjgNryP4J3jVmNHl0w5N")).toBe(0);
  });

  it("returns intent sections from the masked copy", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const big = Array.from({ length: 400 }, (_, i) =>
      i === 3 ? `AWS_SECRET_ACCESS_KEY=${secret}` : `line ${i} routine output noise`,
    ).join("\n");
    const r = await processOutput(db, ctx, {
      stdout: big,
      title: "env",
      source: "exec",
      intent: "AWS_SECRET_ACCESS_KEY",
    });
    expect(r.text).toContain("AWS_SECRET_ACCESS_KEY=***");
    expect(r.text).not.toContain(secret);
  });

  it("masks fetched pages too, but never a project file or a memory", () => {
    const content = "# Setup\n\nexport API_TOKEN=tok-9f8e7d6c5b4a\n";
    const body = (source: string) => {
      const { documentId } = indexContent(db, {
        source,
        title: source,
        uri: `t:${source}`,
        content,
      });
      return db.chunksOfDocument(documentId)[0]?.body ?? "";
    };
    expect(body("url")).toContain("API_TOKEN=***");
    for (const source of ["file", "memory", "code"])
      expect(body(source)).toContain("tok-9f8e7d6c5b4a");
  });

  it("masks the intent and pre-cut chunks of captured output too", () => {
    const { documentId } = indexContent(db, {
      source: "exec",
      title: "t",
      content: "x",
      meta: { intent: "why does DB_PASSWORD=hunter2hunter2 fail" },
      chunks: [
        {
          title: "API_TOKEN=tok-9f8e7d6c5b4a",
          body: "export API_TOKEN=tok-9f8e7d6c5b4a",
          startLine: 1,
          endLine: 1,
        },
      ],
    });
    expect(db.getDocument(documentId)?.meta).toBe('{"intent":"why does DB_PASSWORD=*** fail"}');
    const [c] = db.chunksOfDocument(documentId);
    expect([c?.title, c?.body]).toEqual(["API_TOKEN=***", "export API_TOKEN=***"]);
  });

  const secret = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
  /** A document as an older version stored it: raw, with its chunk already embedded. */
  const legacy = (source: string, tag: string) => {
    const { id } = db.upsertDocument(
      {
        source,
        title: `echo ${secret}`,
        contentType: "prose",
        contentHash: `old-${source}-${tag}`,
        meta: { intent: `why is GH_TOKEN=${secret} rejected` },
      },
      [{ ord: 0, title: "", body: `GH_TOKEN=${secret}`, contentType: "prose", hash: "h" }],
    );
    db.markEmbedded(db.chunksOfDocument(id).map((c) => c.id));
    return id;
  };

  it("masks output stored before masking in place, and leaves other sources", async () => {
    const exec = legacy("exec", "a");
    const file = legacy("file", "a");
    db.metaDelete("captured_mask_upto");
    expect(await remaskCapturedOutput(db)).toBeGreaterThan(0);
    expect(db.getDocument(exec)?.title).toBe("echo ghp_***");
    expect(db.getDocument(exec)?.meta).toBe('{"intent":"why is GH_TOKEN=*** rejected"}');
    const [chunk] = db.chunksOfDocument(exec);
    expect(chunk?.body).toBe("GH_TOKEN=***");
    // the old vector was embedded from the raw text: the chunk is queued to be embedded again
    expect(db.unembeddedChunkIds(1000)).toContain(chunk?.id);
    expect(db.chunksOfDocument(file)[0]?.body).toBe(`GH_TOKEN=${secret}`);
    const hits = await search(db, "Z9y8X7w6V5u4T3s2", { mode: "lexical" });
    expect(hits.hits.map((h) => h.chunk.document.id)).toEqual([file]);
    // a later start goes over only what was stored since: here an older server's raw output
    const later = legacy("exec", "later");
    const from: number[] = [];
    const spy = Object.create(db) as SqliteAdapter;
    spy.remaskDocuments = (sources, mask, afterId, budget) => {
      from.push(afterId);
      return db.remaskDocuments(sources, mask, afterId, budget);
    };
    expect(await remaskCapturedOutput(spy)).toBeGreaterThan(0);
    // the first run ended on the last captured document, `exec` (`file` is not captured); the
    // slices after the first are the FTS merge
    expect(from[0]).toBe(exec);
    expect(from.slice(1).every((f) => f === later)).toBe(true);
    expect(db.chunksOfDocument(later)[0]?.body).toBe("GH_TOKEN=***");
    expect(db.metaGet("captured_mask_upto")).toBe(`1:${later}`);
    expect(await remaskCapturedOutput(db)).toBe(0);
  });

  it("works in slices that yield to the event loop, and resumes where it stopped", async () => {
    db.metaDelete("captured_mask_upto");
    const docs = [legacy("exec", "s1"), legacy("batch", "s2"), legacy("url", "s3")];
    // a run stopped after the first document resumes after it
    db.metaSet("captured_mask_upto", `1:${docs[0]}`);
    // one document per slice, as if each took the whole 20 ms
    const sliced = Object.create(db) as SqliteAdapter;
    const order: string[] = [];
    sliced.remaskDocuments = (sources, mask, afterId) => {
      order.push("slice");
      return db.remaskDocuments(sources, mask, afterId, 0);
    };
    setImmediate(() => order.push("tick"));
    await remaskCapturedOutput(sliced);
    expect(order).toEqual(["slice", "tick", "slice", "slice"]);
    expect(db.chunksOfDocument(docs[0] as number)[0]?.body).toBe(`GH_TOKEN=${secret}`);
    for (const id of docs.slice(1)) expect(db.chunksOfDocument(id)[0]?.body).toBe("GH_TOKEN=***");
    expect(db.metaGet("captured_mask_upto")).toBe(`1:${docs[2]}`);
  });

  it("a server stopped part-way resumes after the last slice it finished", async () => {
    const docs = [legacy("exec", "c1"), legacy("batch", "c2"), legacy("url", "c3")];
    const before = (docs[0] as number) - 1;
    db.metaSet("captured_mask_upto", `1:${before}`);
    let slices = 0;
    const dying = Object.create(db) as SqliteAdapter;
    dying.remaskDocuments = (sources, mask, afterId) => {
      if (++slices === 2) throw new Error("server stopped");
      return db.remaskDocuments(sources, mask, afterId, 0);
    };
    await expect(remaskCapturedOutput(dying)).rejects.toThrow("server stopped");
    expect(db.metaGet("captured_mask_upto")).toBe(`1:${docs[0]}`);
    expect(db.chunksOfDocument(docs[1] as number)[0]?.body).toBe(`GH_TOKEN=${secret}`);
    const from: number[] = [];
    const next = Object.create(db) as SqliteAdapter;
    next.remaskDocuments = (sources, mask, afterId, budget) => {
      from.push(afterId);
      return db.remaskDocuments(sources, mask, afterId, budget);
    };
    expect(await remaskCapturedOutput(next)).toBeGreaterThan(0);
    expect(from[0]).toBe(docs[0]);
    for (const id of docs) expect(db.chunksOfDocument(id)[0]?.body).toBe("GH_TOKEN=***");
    expect(db.metaGet("captured_mask_upto")).toBe(`1:${docs[2]}`);
  });

  it("goes over every document again when the pointer is from older rules", async () => {
    const docs = [legacy("exec", "v1"), legacy("url", "v2")];
    db.metaSet("captured_mask_upto", `0:${docs[1]}`);
    expect(await remaskCapturedOutput(db)).toBeGreaterThan(0);
    for (const id of docs) expect(db.chunksOfDocument(id)[0]?.body).toBe("GH_TOKEN=***");
    expect(db.metaGet("captured_mask_upto")).toBe(`1:${docs[1]}`);
  });
});

describe("re-masking a document cut into chunks before it was masked", () => {
  const TOKEN = "ghp_Zq7Xk2VwRt9Lm4Np8Bs3Hd6Jc1Fy5Gu0Ea2W";
  const pem = generateKeyPairSync("rsa", { modulusLength: 4096 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const keyLines = pem.split("\n").filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l));
  const logs = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `2026-11-09T10:00:${from + i} deploy step ${from + i} ok`);

  /** Store `content` the way an older version did: chunked raw, as one captured document. */
  function storeRaw(adapter: SqliteAdapter, content: string, kind?: "code"): number {
    const cut = chunk(content, "shell: deploy", kind, undefined);
    return adapter.upsertDocument(
      {
        source: "exec",
        title: "shell: deploy",
        contentType: cut.chunks[0]?.contentType ?? "prose",
        contentHash: hashText(content),
      },
      cut.chunks,
    ).id;
  }

  const bodies = (adapter: SqliteAdapter, id: number) =>
    adapter.chunksOfDocument(id).map((c) => c.body);

  it.each([
    ["prose", undefined],
    ["code (overlapping windows)", "code" as const],
  ])("masks a private key that spans chunks (%s)", async (_, kind) => {
    const content = [
      ...logs(0, 30),
      "$ cat deploy/id_rsa",
      pem.trimEnd(),
      `export GH=${TOKEN}`,
      ...logs(30, 30),
    ].join("\n");
    const id = storeRaw(db, content, kind);
    expect(db.chunksOfDocument(id).length).toBeGreaterThan(2);
    // masking each chunk on its own leaves the base64 lines of the chunks after the BEGIN line
    const alone = bodies(db, id).map(redactSecrets).join("\n");
    expect(keyLines.filter((l) => alone.includes(l)).length).toBeGreaterThan(10);
    db.metaSet("captured_mask_upto", `1:${id - 1}`);
    expect(await remaskCapturedOutput(db)).toBeGreaterThan(0);
    const text = bodies(db, id).join("\n");
    expect(keyLines.filter((l) => text.includes(l))).toEqual([]);
    expect(text).not.toContain("-----END PRIVATE KEY-----");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[private key]");
    expect(text).toContain("export GH=");
    // the log lines around the key stay, each once, in order
    const kept = text.split("\n").filter((l) => l.includes("deploy step"));
    const all = [...logs(0, 30), ...logs(30, 30)];
    expect(kind === "code" ? [...new Set(kept)] : kept).toEqual(all);
    expect(bodies(db, id).every((b) => b.trim() !== "")).toBe(true);
  });

  it("masks a YAML secret block that spans chunks", async () => {
    const block = Array.from({ length: 80 }, (_, i) => `    line-${i}-${"s3cr3tV4lue".repeat(3)}`);
    const content = [...logs(0, 30), "db:", "  password: |", ...block, "  host: db.local"].join(
      "\n",
    );
    const id = storeRaw(db, content);
    expect(db.chunksOfDocument(id).length).toBeGreaterThan(2);
    db.metaSet("captured_mask_upto", `1:${id - 1}`);
    await remaskCapturedOutput(db);
    const text = bodies(db, id).join("\n");
    expect(text).not.toContain("s3cr3tV4lue");
    expect(text).toContain("  password: |\n    ***");
    expect(text).toContain("host: db.local");
  });

  it("masks a key block whose END line is past the 64 KB the rule looks ahead", async () => {
    const lines = Array.from({ length: 1200 }, () => randomBytes(48).toString("base64"));
    const content = [
      ...logs(0, 30),
      "-----BEGIN RSA PRIVATE KEY-----",
      ...lines,
      "-----END RSA PRIVATE KEY-----",
      ...logs(30, 30),
    ].join("\n");
    expect(content.length).toBeGreaterThan(70_000);
    const id = storeRaw(db, content);
    expect(db.chunksOfDocument(id).length).toBeGreaterThan(10);
    db.metaSet("captured_mask_upto", `1:${id - 1}`);
    await remaskCapturedOutput(db);
    const text = bodies(db, id).join("\n");
    expect(lines.filter((l) => text.includes(l))).toEqual([]);
    expect(text).toContain("[private key]");
    expect(text).toContain("deploy step 59 ok");
  });

  it("leaves no fragment of a re-masked token in the FTS index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "em-remask-"));
    const path = join(dir, "t.db");
    const trigrams = (s: string) =>
      Array.from({ length: s.length - 2 }, (_, i) => s.slice(i, i + 3).toLowerCase());
    const fresh = new SqliteAdapter(path, { vectors: false });
    fresh.close();
    const baseline = readFileSync(path).toString("latin1");
    const adapter = new SqliteAdapter(path, { vectors: false });
    storeRaw(adapter, `$ cat .env\nGH=${TOKEN}\n`);
    adapter.db.pragma("wal_checkpoint(TRUNCATE)");
    expect(await remaskCapturedOutput(adapter)).toBeGreaterThan(0);
    expect(adapter.metaGet("remask_fts_optimize")).toBeUndefined();
    // no VACUUM: the merged segments and the zeroed pages are what the remask itself leaves
    adapter.close();
    const raw = readFileSync(path).toString("latin1");
    rmSync(dir, { recursive: true, force: true });
    const probes = trigrams(TOKEN.slice(4)).filter((t) => !baseline.includes(t));
    expect(probes.length).toBeGreaterThan(20);
    expect(probes.filter((t) => raw.includes(t))).toEqual([]);
  });
});

describe("re-masking beside other processes", () => {
  const TOKEN = "ghp_Zq7Xk2VwRt9Lm4Np8Bs3Hd6Jc1Fy5Gu0Ea2W";
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const fresh = (vectors = false) => {
    const dir = mkdtempSync(join(tmpdir(), "em-remask-"));
    dirs.push(dir);
    const path = join(dir, "t.db");
    return { path, a: new SqliteAdapter(path, { vectors }) };
  };
  /** One raw captured document of one chunk per body. */
  const raw = (a: SqliteAdapter, bodies: string[], title = "env", chunkTitle = "") =>
    a.upsertDocument(
      { source: "exec", title, contentType: "prose", contentHash: hashText(title + bodies.join()) },
      bodies.map((body, ord) => ({
        ord,
        title: chunkTitle,
        body,
        contentType: "prose",
        hash: `h${ord}`,
      })),
    ).id;
  const trigrams = (s: string) =>
    Array.from({ length: s.length - 2 }, (_, i) => s.slice(i, i + 3).toLowerCase());

  it("finishes when another process commits while a document is being masked", async () => {
    const { a, path } = fresh();
    const hook = new SqliteAdapter(path, { vectors: false, busyTimeoutMs: 0 });
    const id = raw(a, [`GH=${TOKEN}`]);
    let wrote = false;
    const racing = Object.create(a) as SqliteAdapter;
    racing.remaskDocuments = (sources, _mask, afterId, budget) =>
      a.remaskDocuments(
        sources,
        (t) => {
          if (!wrote && t.includes(TOKEN)) {
            wrote = true; // a hook commits between the remask's read and its write
            hook.metaSet("hook_write", "1");
          }
          return redactSecrets(t);
        },
        afterId,
        budget,
      );
    await remaskCapturedOutput(racing);
    expect(wrote).toBe(true);
    expect(a.chunksOfDocument(id)[0]?.body).toBe("GH=ghp_***");
    hook.close();
    a.close();
  });

  it("waits out a lock another process holds, without stalling the event loop on it", async () => {
    const { a, path } = fresh();
    const id = raw(a, [`GH=${TOKEN}`]);
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("INSERT INTO meta (key, value) VALUES ('held', '1')");
    const started = performance.now();
    setTimeout(() => holder.exec("COMMIT"), 300);
    await remaskCapturedOutput(a);
    expect(performance.now() - started).toBeGreaterThan(250);
    expect(a.chunksOfDocument(id)[0]?.body).toBe("GH=ghp_***");
    holder.close();
    a.close();
  });

  it("two servers starting on one database together both finish", async () => {
    const { a, path } = fresh();
    const ids = Array.from({ length: 30 }, (_, i) =>
      raw(a, [`GH=${TOKEN}`, `line ${i}`], `env ${i}`),
    );
    const b = new SqliteAdapter(path, { vectors: false });
    const [x, y] = await Promise.all([remaskCapturedOutput(a), remaskCapturedOutput(b)]);
    expect(x + y).toBeGreaterThanOrEqual(ids.length);
    for (const id of ids) expect(a.chunksOfDocument(id)[0]?.body).toBe("GH=ghp_***");
    expect(a.metaGet("remask_fts_optimize")).toBeUndefined();
    b.close();
    a.close();
  });

  it("masks chunk titles", async () => {
    const { a } = fresh();
    const id = raw(a, ["ok"], "t", `GH_TOKEN=${TOKEN}`);
    await remaskCapturedOutput(a);
    expect(a.chunksOfDocument(id)[0]?.title).toBe("GH_TOKEN=***");
    a.close();
  });

  it("drops the vectors of rewritten chunks and keeps the others", async () => {
    const { a } = fresh(true);
    const id = raw(a, ["plain line", `GH=${TOKEN}`]);
    const [keep, change] = a.chunksOfDocument(id);
    if (!keep || !change) throw new Error("two chunks");
    for (const c of [keep, change]) a.vecUpsert(c.id, new Float32Array(384).fill(0.1));
    a.markEmbedded([keep.id, change.id]);
    await remaskCapturedOutput(a);
    const vecs = (
      a.db.prepare("SELECT chunk_id FROM chunk_vec").all() as Array<{ chunk_id: number }>
    ).map((r) => Number(r.chunk_id));
    expect(vecs).toEqual([keep.id]);
    expect(a.unembeddedChunkIds(10)).toEqual([change.id]);
    a.close();
  });

  it("rewrites an older-rules pointer even when no document is left to mask", async () => {
    const { a } = fresh();
    a.metaSet("captured_mask_upto", "0:999");
    expect(await remaskCapturedOutput(a)).toBe(0);
    expect(a.metaGet("captured_mask_upto")).toBe("1:0");
    a.close();
  });

  it("a run stopped before the FTS merge leaves its mark, and the next run merges", async () => {
    const { a, path } = fresh();
    a.db.pragma("wal_checkpoint(TRUNCATE)");
    const baseline = readFileSync(path).toString("latin1");
    raw(a, [`$ cat .env\nGH=${TOKEN}\n`]);
    a.db.pragma("wal_checkpoint(TRUNCATE)");
    let wrote = false;
    const dying = Object.create(a) as SqliteAdapter;
    dying.remaskDocuments = (sources, mask, afterId, budget) => {
      if (wrote) throw new Error("server stopped");
      const slice = a.remaskDocuments(sources, mask, afterId, budget);
      wrote = slice.changed > 0;
      return slice;
    };
    await expect(remaskCapturedOutput(dying)).rejects.toThrow("server stopped");
    expect(a.metaGet("remask_fts_optimize")).toBe("1");
    expect(await remaskCapturedOutput(a)).toBe(0);
    expect(a.metaGet("remask_fts_optimize")).toBeUndefined();
    a.close();
    const after = readFileSync(path).toString("latin1");
    const probes = trigrams(TOKEN.slice(4)).filter((t) => !baseline.includes(t));
    expect(probes.length).toBeGreaterThan(20);
    expect(probes.filter((t) => after.includes(t))).toEqual([]);
  });

  it("writes a large document in short transactions, last chunks first, and resumes one stopped part-way", async () => {
    const { a, path } = fresh();
    const n = 4000;
    const id = raw(
      a,
      Array.from({ length: n }, (_, i) => `step ${i}\nAPI_TOKEN=tok-${i}abcdef0123456789`),
      "big",
    );
    let slices = 0;
    const dying = Object.create(a) as SqliteAdapter;
    dying.remaskDocuments = (sources, mask, afterId, budget) => {
      if (++slices === 2) throw new Error("server stopped");
      return a.remaskDocuments(sources, mask, afterId, budget);
    };
    await expect(remaskCapturedOutput(dying)).rejects.toThrow("server stopped");
    const masked = a.chunksOfDocument(id).map((c) => c.body.endsWith("API_TOKEN=***"));
    const first = masked.indexOf(true);
    // one transaction wrote part of it, from the end
    expect(first).toBeGreaterThan(0);
    expect(masked.slice(first).every(Boolean)).toBe(true);
    // the document is not done, so the pointer stays before it
    expect(a.metaGet("captured_mask_upto")).toBe(`1:${id - 1}`);
    a.close();
    // a new process picks it up again
    const b = new SqliteAdapter(path, { vectors: false });
    await remaskCapturedOutput(b);
    expect(b.chunksOfDocument(id).every((c) => c.body.endsWith("API_TOKEN=***"))).toBe(true);
    expect(b.metaGet("captured_mask_upto")).toBe(`1:${id}`);
    b.close();
  });

  it("is run by the server's warm-up on every start, in its own try, before embedding", () => {
    const src = readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
    const warm = src.slice(src.indexOf("const warm = setTimeout("));
    expect(warm).toMatch(
      /try \{\s*(?:\/\/[^\n]*\n\s*)*await remaskCapturedOutput\(db\);\s*\} catch \(err\) \{\s*process\.stderr\.write/,
    );
    const at = (s: string) => warm.indexOf(s);
    expect(at("await remaskCapturedOutput(db)")).toBeGreaterThan(at("await reindexCode(ctx, db)"));
    expect(at("await remaskCapturedOutput(db)")).toBeLessThan(at("kickEmbedding(ctx, db"));
  });
});
