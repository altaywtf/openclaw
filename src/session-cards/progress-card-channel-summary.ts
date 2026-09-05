type ProgressCardStep = { status: "pending" | "in_progress" | "completed" };

const PLAN_PROGRESS_TOOL_NAMES = new Set(["progress_card", "update_plan"]);

export function isAgentPlanProgressToolName(name: string | undefined): boolean {
  return PLAN_PROGRESS_TOOL_NAMES.has(name?.trim().toLowerCase() ?? "");
}

/** Projects durable card state without interpreting renderer-owned Markdown or HTML. */
export function formatProgressCardChannelSummary(params: {
  hasMarkdown: boolean;
  steps: readonly ProgressCardStep[];
}): string | undefined {
  if (params.steps.length > 0) {
    const completed = params.steps.filter((step) => step.status === "completed").length;
    return `${completed}/${params.steps.length} complete`;
  }
  return params.hasMarkdown ? "Progress updated" : undefined;
}
