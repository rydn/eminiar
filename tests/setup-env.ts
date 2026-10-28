// The session running the tests may itself be an eminiar/Claude Code session. Its project
// variables must not leak into hooks and recall, which resolve the project root from them.
delete process.env.EMINIAR_PROJECT_ROOT;
delete process.env.CLAUDE_PROJECT_DIR;
