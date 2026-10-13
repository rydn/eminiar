import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  addMemory,
  ctxFor,
  deleteMemory,
  doctorPayload,
  eventsPayload,
  graphPayload,
  listProjects,
  memoriesPayload,
  memoryBody,
  searchPayload,
  statsPayload,
} from "./api.js";
import { PAGE } from "./page.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Local dashboard: binds 127.0.0.1 only, no auth needed because only this user
 * can reach it. Read-only except for memories.
 */
export async function serve(opts: { port: number; open: boolean; root?: string }): Promise<void> {
  const defaultRoot = opts.root;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const root = url.searchParams.get("root") ?? defaultRoot ?? undefined;
      const ctx = () => ctxFor(root);
      const num = (k: string, d: number) => Number(url.searchParams.get(k) ?? d) || d;
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (url.pathname === "/api/projects")
        return json(res, 200, { current: ctx().root, projects: listProjects() });
      if (url.pathname === "/api/stats") return json(res, 200, statsPayload(ctx()));
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return json(res, 400, { error: "q required" });
        const mode =
          (url.searchParams.get("mode") as "hybrid" | "lexical" | "semantic" | "regex" | null) ??
          "hybrid";
        return json(res, 200, await searchPayload(ctx(), q, mode, num("limit", 10)));
      }
      if (url.pathname === "/api/memories") {
        const name = url.searchParams.get("name")?.trim();
        if (req.method === "POST") {
          const body = JSON.parse(await readBody(req)) as {
            kind?: string;
            content?: string;
            name?: string;
          };
          if (!body.content?.trim()) return json(res, 400, { error: "content required" });
          try {
            return json(
              res,
              200,
              addMemory(ctx(), body.kind ?? "fact", body.content.trim(), body.name?.trim()),
            );
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
        }
        if (req.method === "DELETE") {
          deleteMemory(ctx(), name || num("id", 0));
          return json(res, 200, { ok: true });
        }
        if (name) {
          const m = memoryBody(ctx(), name);
          return m ? json(res, 200, m) : json(res, 404, { error: "not found" });
        }
        return json(res, 200, memoriesPayload(ctx()));
      }
      if (url.pathname === "/api/graph") {
        return json(
          res,
          200,
          graphPayload(
            ctx(),
            url.searchParams.get("node") ?? "",
            url.searchParams.get("mode") ?? "impact",
            num("limit", 25),
          ),
        );
      }
      if (url.pathname === "/api/events")
        return json(res, 200, eventsPayload(ctx(), num("limit", 100)));
      if (url.pathname === "/api/doctor") return json(res, 200, await doctorPayload());
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${opts.port}/`;
  console.log(`eminiar dashboard at ${url} (Ctrl-C to stop)`);
  if (opts.open) {
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  }
  await new Promise(() => undefined);
}
