import { existsSync, readdirSync } from "node:fs";
import { paths } from "../paths.js";
import { readInstallRecord } from "./claude-config.js";
import { install } from "./install.js";
import { log } from "./shell.js";

/**
 * The model cache is empty after `install --no-model`, so an empty one means that choice (or a
 * failed download, which is retried lazily on first hybrid search) and upgrade leaves it alone.
 */
export function modelInstalled(): boolean {
  try {
    const dir = paths().models;
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Re-run the installer against the latest package. Dev installs (packed from a
 * checkout) are re-packed from that checkout even when the version number has not
 * changed; registry installs pull `latest`. Previous choices (statusline, Cursor, no embedding model) are kept.
 */
export async function upgrade(): Promise<number> {
  const rec = readInstallRecord();
  if (!rec) {
    log.warn("no previous install found; running a fresh install");
    return install({ yes: true });
  }
  const fromCheckout = rec.fromSpec.startsWith("pack:") || rec.fromSpec === "self";
  return install({
    yes: true,
    // "none" means Cursor-only last time; let install() decide again from what is present.
    method: rec.method === "none" ? undefined : rec.method,
    noModel: !modelInstalled(),
    spec: fromCheckout ? undefined : "eminiar@latest",
    force: fromCheckout,
    node: rec.node,
    statusline: !!rec.wrote.statusline,
    cursor: !!rec.wrote.cursor,
  });
}
