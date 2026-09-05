import { normalizeProgressCardInput, ProgressCardInputError } from "./progress-card-input.js";

type ProgressCardStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

const PLAN_PROGRESS_TOOL_NAMES = new Set(["progress_card", "update_plan"]);

export function isAgentPlanProgressToolName(name: string | undefined): boolean {
  return PLAN_PROGRESS_TOOL_NAMES.has(name?.trim().toLowerCase() ?? "");
}

/** Projects durable card state without interpreting renderer-owned Markdown or HTML. */
function formatProgressCardChannelSummary(params: {
  hasMarkdown: boolean;
  steps: readonly ProgressCardStep[];
}): string | undefined {
  if (params.steps.length > 0) {
    const completed = params.steps.filter((step) => step.status === "completed").length;
    return `${completed}/${params.steps.length} complete`;
  }
  return params.hasMarkdown ? "Progress updated" : undefined;
}

export function projectProgressCardChannelUpdate(
  input: unknown,
): { steps: ProgressCardStep[]; explanation?: string } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  // SAFETY: object/array guards above establish the record shape; fields remain unknown.
  const record = input as { markdown?: unknown; plan?: unknown };
  try {
    const normalized = normalizeProgressCardInput({
      markdown: record.markdown,
      plan: record.plan,
    });
    const steps = normalized.steps ?? [];
    const explanation = formatProgressCardChannelSummary({
      hasMarkdown: normalized.markdown !== undefined,
      steps,
    });
    return { steps, ...(explanation ? { explanation } : {}) };
  } catch (error) {
    if (error instanceof ProgressCardInputError) {
      return undefined;
    }
    throw error;
  }
}
