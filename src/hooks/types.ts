/** Subset of the Claude Code hook stdin payload that eminiar reads. */
export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  // SessionStart
  source?: "startup" | "resume" | "clear" | "compact" | "fork";
  // UserPromptSubmit
  prompt?: string;
  // PreToolUse / PostToolUse / PostToolUseFailure
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  duration_ms?: number;
  error?: string;
  // Stop / SubagentStop
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  // SubagentStart / SubagentStop, and tool events fired inside a subagent
  agent_id?: string;
  agent_type?: string;
  // SubagentStop
  agent_transcript_path?: string;
  // PreCompact
  trigger?: "manual" | "auto";
  custom_instructions?: string;
  // SessionEnd
  reason?: string;
}

export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export type HookHandler = (
  input: HookInput,
) => Promise<HookOutput | undefined> | HookOutput | undefined;
