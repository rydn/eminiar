import { createServer } from "node:net";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const doctorPayload = vi.fn(async (fix?: boolean) => ({ fix: !!fix }));
vi.mock("../../src/ui/api.js", async (orig) => ({
  ...(await orig<typeof import("../../src/ui/api.js")>()),
  doctorPayload: (fix?: boolean) => doctorPayload(fix),
}));

let port = 0;

beforeAll(async () => {
  port = await new Promise<number>((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
  const { serve } = await import("../../src/ui/server.js");
  void serve({ port, open: false }); // never resolves; run detached
  await new Promise((r) => setTimeout(r, 200));
});
beforeEach(() => doctorPayload.mockClear());

const call = (init?: RequestInit) => fetch(`http://127.0.0.1:${port}/api/doctor`, init);
const jsonPost = (body: unknown, headers: Record<string, string> = {}) =>
  call({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("/api/doctor --fix", () => {
  it("never fixes on a GET, whatever the query says", async () => {
    for (const q of ["?fix=1", "?fix=true", ""]) {
      const r = await fetch(`http://127.0.0.1:${port}/api/doctor${q}`);
      expect(r.status).toBe(200);
    }
    expect(doctorPayload.mock.calls.map((c) => c[0])).toEqual([false, false, false]);
  });

  it("fixes on a same-origin JSON POST with fix:true only", async () => {
    const origin = `http://127.0.0.1:${port}`;
    expect(
      (await jsonPost({ fix: true }, { origin, "sec-fetch-site": "same-origin" })).status,
    ).toBe(200);
    expect(doctorPayload).toHaveBeenLastCalledWith(true);
    await jsonPost({ fix: "yes" });
    expect(doctorPayload).toHaveBeenLastCalledWith(false);
    await jsonPost({});
    expect(doctorPayload).toHaveBeenLastCalledWith(false);
  });

  it("refuses a POST without a JSON content type, and a cross-site one", async () => {
    const plain = await call({
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"fix":true}',
    });
    expect(plain.status).toBe(403);
    const none = await call({ method: "POST", body: '{"fix":true}', headers: {} });
    expect(none.status).toBe(403);
    const cross = await jsonPost({ fix: true }, { origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    const site = await jsonPost({ fix: true }, { "sec-fetch-site": "cross-site" });
    expect(site.status).toBe(403);
    expect(doctorPayload).not.toHaveBeenCalled();
  });

  it("refuses a cross-site or foreign-origin GET on any /api/ path", async () => {
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { origin: "http://evil.example" }]) {
      expect((await call({ headers })).status).toBe(403);
    }
    expect(doctorPayload).not.toHaveBeenCalled();
  });
});
