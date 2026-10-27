#!/usr/bin/env node
// Capture the dashboard screenshots in docs/images through the Chrome DevTools Protocol.
// No dependencies: Chrome runs headless and Node's built-in WebSocket drives it.
//
//   eminiar ui --port 7341 --no-open &          # serve the project to capture
//   node scripts/capture-screenshots.mjs [name ...] [--port 7341] [--out docs/images]
//
// Home directories in the page (/Users/<name>, /home/<name>) are replaced with ~ before each
// capture. Images are WebP at 1.5x (2160 px wide), named dashboard-<name>-<scheme>.webp.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const PORT = opt("port", "7341");
const OUT = opt("out", "docs/images");
const CHROME =
  process.env.CHROME ??
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));
const only = args;

const click = (label) => `(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (b) b.click();
})()`;

/** name, hash route, color schemes, actions run after load. */
const SHOTS = [
  { name: "overview", hash: "#/overview", schemes: ["dark"] },
  { name: "usage", hash: "#/usage?range=30d", schemes: ["dark"] },
  { name: "explore", hash: "#/explore?file=src/session/recall.ts", schemes: ["dark", "light"] },
  {
    name: "galaxy",
    hash: "#/galaxy?node=file:src/session/recall.ts",
    schemes: ["dark"],
    actions: [click("+1"), click("fit view")],
  },
  { name: "hotspots", hash: "#/architecture?tab=hotspots", schemes: ["dark"] },
  { name: "history", hash: "#/history?tab=timeline", schemes: ["dark"] },
  { name: "history-risk", hash: "#/history?tab=risk", schemes: ["dark"] },
  { name: "history-graph", hash: "#/history?tab=graph", schemes: ["dark"] },
  {
    name: "memory",
    hash: "#/memory?name=decision/proactive-recall-in-hooks",
    schemes: ["dark"],
  },
  {
    name: "docs",
    hash: "#/docs?tab=discover",
    schemes: ["dark"],
    actions: [click("Scan project")],
  },
  { name: "memory-graph", hash: "#/memory?tab=graph", schemes: ["dark", "light"] },
  { name: "docs-graph", hash: "#/docs?tab=graph", schemes: ["dark"] },
  { name: "coverage", hash: "#/coverage", schemes: ["dark"] },
].filter((s) => !only.length || only.includes(s.name));

const REDACT = `(() => {
  const re = /\\/(Users|home)\\/[^/\\s]+/g;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (re.test(n.data)) n.data = n.data.replace(re, "~");
  for (const el of document.querySelectorAll("input")) if (re.test(el.value)) el.value = el.value.replace(re, "~");
})()`;

if (!CHROME) {
  console.error("Chrome not found; set CHROME=/path/to/chrome");
  process.exit(1);
}
try {
  await fetch(`http://127.0.0.1:${PORT}/`);
} catch {
  console.error(`no dashboard on port ${PORT}; start it with: eminiar ui --port ${PORT} --no-open`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "em-shots-"));
const debugPort = 9333;
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting
    }
    if (!wsUrl) await sleep(200);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  for (const s of SHOTS) {
    for (const scheme of s.schemes) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
      await send("Page.navigate", { url: "about:blank" });
      await sleep(200);
      await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/${s.hash}` });
      await sleep(3500);
      for (const action of s.actions ?? []) {
        await evaluate(action);
        await sleep(2500);
      }
      await evaluate(REDACT);
      const { data } = await send("Page.captureScreenshot", { format: "webp", quality: 85 });
      const file = join(OUT, `dashboard-${s.name}-${scheme}.webp`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`${file}  ${Math.round(Buffer.byteLength(data, "base64") / 1024)} KB`);
    }
  }
  ws.close();
} finally {
  // Chrome keeps writing its profile while it shuts down: wait for exit before removing it.
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // a leftover temp profile is harmless
  }
}
