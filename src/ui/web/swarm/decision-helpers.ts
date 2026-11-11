import type { SwarmDecision } from "../../../adjudicator/swarm-decisions.js";

/** Effort as shown: a level, "env override" (level unknown), "session" (fork) or "default" (agent file). */
export function effortLabel(d: SwarmDecision): string | undefined {
  if (!d.ran) return undefined;
  if (d.ran.effortEffective) return d.ran.effortEffective;
  if (d.ran.effortSource === "env") return "env override";
  if (d.ran.effortSource === "fork") return "session";
  return "default";
}

/** The tier that ran (or "n/a" until dispatched). */
export function ranModel(d: SwarmDecision): string | undefined {
  // Under FORCE or a fork the call's model did not run: show only the resolved tier.
  if (d.follow === "forced" || d.follow === "fork") return d.ran?.tier;
  if (d.follow === "pinned")
    return d.ran?.tier ?? d.ran?.finalModel ?? d.advice?.pinnedModel ?? d.ran?.baselineModel;
  return d.ran?.tier ?? d.ran?.finalModel ?? d.ran?.requestedModel;
}

/** The advice did not decide the model (pin kept, FORCE or fork): it is what it would have picked. */
export function adviceKept(d: SwarmDecision): boolean {
  return d.follow === "pinned" || d.follow === "forced" || d.follow === "fork";
}

/** "suggested" for advice that could act, "would pick" and why not when the dispatch kept the model. */
export function adviceVerb(d: SwarmDecision): string {
  switch (d.follow) {
    case "pinned":
      return "would pick (pin kept)";
    case "forced":
      return "would pick (forced)";
    case "fork":
      return "would pick (fork)";
    default:
      return "suggested";
  }
}

const claimed = (d: SwarmDecision): boolean => !!d.agentId || d.status !== "pending";

/** Short label for a task with no dispatch row: a claimed task has a worker but no recorded spawn. */
export function notDispatchedLabel(d: SwarmDecision): string {
  return claimed(d) ? "no dispatch recorded" : "not dispatched";
}

function notDispatchedText(d: SwarmDecision): string {
  return claimed(d)
    ? "No dispatch recorded: the task was claimed directly by its agent, so no spawn decision was made for it."
    : "Not dispatched yet.";
}

/** One sentence on how the dispatch related to the advice. */
export function followText(d: SwarmDecision): string {
  const a = d.advice?.model;
  switch (d.follow) {
    case "followed":
      return `Ran on the tier the adjudicator advised${a ? ` (${a})` : ""}.`;
    case "overrode":
      if (!a)
        return `The call passed ${d.ran?.requestedModel ?? "a model"}; the adjudicator named no model.`;
      return `The spawn call named a different model than advised (${a}), so the advice was overridden.`;
    case "pinned":
      return `The role pins its model and no model was passed, so the pin stayed${a ? ` (advice would have picked ${a})` : ""}.`;
    case "forced":
      return "The model was forced (FORCE), skipping the adjudicator's choice.";
    case "fork":
      return "Ran on the main session's model (fork).";
    default:
      if (d.ran?.requestedModel)
        return `The call passed ${d.ran.requestedModel}; the adjudicator named no model.`;
      return d.ran
        ? "No model was passed or applied, so the agent file's model ran."
        : notDispatchedText(d);
  }
}

/** The decisions of the tasks a worker held, newest task first. */
export function workerDecisions(
  decisions: Record<number, SwarmDecision> | undefined,
  agentId: string,
  taskId: number | null,
): SwarmDecision[] {
  if (!decisions) return [];
  const out = Object.values(decisions).filter(
    (d) =>
      d.agentId === agentId ||
      d.ran?.agentId === agentId ||
      (taskId !== null && d.taskId === taskId && !d.agentId),
  );
  return out.sort((a, b) => b.taskId - a.taskId);
}
