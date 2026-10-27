// Copies package.json's version into .claude-plugin/plugin.json. Runs from the npm
// `version` lifecycle script, so `npm version <bump>` keeps both in step (Claude Code
// names its plugin cache directory after the plugin.json version).
// `--check` only compares and exits 1 on a mismatch (used by the publish workflow).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Both plugin manifests (Claude Code and Cursor) must carry the package version.
let failed = false;
for (const rel of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
  const pluginFile = join(root, rel);
  const plugin = JSON.parse(readFileSync(pluginFile, "utf8"));
  if (plugin.version === version) {
    console.log(`${rel} already at ${version}`);
  } else if (process.argv.includes("--check")) {
    console.error(`${rel} is ${plugin.version}, package.json is ${version}`);
    failed = true;
  } else {
    plugin.version = version;
    writeFileSync(pluginFile, `${JSON.stringify(plugin, null, 2)}\n`);
    console.log(`${rel} -> ${version}`);
  }
}
if (failed) process.exit(1);
