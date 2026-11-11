import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The session running the tests may itself be an eminiar/Claude Code session. Its project
// variables must not leak into hooks and recall, which resolve the project root from them.
delete process.env.EMINIAR_PROJECT_ROOT;
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.EMINIAR_SESSION_ID;
// It may also run under another Claude Code account (CLAUDE_CONFIG_DIR) or plugins root; tests
// that point HOME at a temp dir must not read that account's settings, agents or plugins.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
delete process.env.EMINIAR_CLAUDE_DIR;
// Never fall back to the real ~/.eminiar: a test that forgets to point EMINIAR_HOME at a temp
// directory would otherwise read and write the developer's own database and config.
if (!process.env.EMINIAR_HOME) {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-test-home-"));
}
