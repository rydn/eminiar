import { existsSync, readdirSync } from "node:fs";
import { paths } from "../paths.js";
import { readInstallRecord } from "./claude-config.js";
import { install } from "./install.js";
import { log } from "./shell.js";

/**
 * Fallback for install records written before they stored `noModel`: does the model cache hold a
 * model? Dotfiles (.DS_Store) and the adjudicator's exemplar caches live there too and do not count.
 */
export function modelInstalled(): boolean {
  try {
    const dir = paths().models;
    return (
      existsSync(dir) &&
      readdirSync(dir).some((n) => !n.startsWith(".") && !n.startsWith("adjudicator-exemplars-"))
    );
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
    // The recorded choice wins; a failed first download (recorded noModel: false) is retried. A
    // record from before `noModel` was stored cannot say, so an empty model cache reads as no model.
    noModel: rec.noModel ?? !modelInstalled(),
    spec: fromCheckout ? undefined : "eminiar@latest",
    force: fromCheckout,
    node: rec.node,
    statusline: !!rec.wrote.statusline,
    cursor: !!rec.wrote.cursor,
  });
}
