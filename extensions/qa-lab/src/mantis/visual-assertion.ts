export type VisionAssertion = {
  evidence?: string;
  expectedText: string;
  matched: boolean;
  reason?: string;
  visible?: boolean;
};

export function parseImageDescribeText(stdout: string) {
  const parsed = parseJsonObjectFromText(
    stdout,
    (value): value is { outputs?: Array<{ text?: unknown }> } =>
      Boolean(
        value && typeof value === "object" && "outputs" in value && Array.isArray(value.outputs),
      ),
  );
  if (!parsed) {
    throw new Error("Image describe did not return a JSON envelope with outputs.");
  }
  const text = parsed.outputs?.find((output) => typeof output.text === "string")?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Image describe did not return output text.");
  }
  return text;
}

function parseJsonObjectFromText<T>(text: string, accepts: (value: unknown) => value is T) {
  const starts = [...text.matchAll(/\{/gu)]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  const ends = [...text.matchAll(/\}/gu)]
    .map((match) => match.index)
    .filter((index) => index !== undefined);
  for (const start of starts) {
    for (const end of ends.toReversed()) {
      if (end < start) {
        continue;
      }
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (accepts(parsed)) {
          return parsed;
        }
      } catch {
        // Keep scanning: command wrappers can echo prompt schemas before the real JSON.
      }
    }
  }
  return undefined;
}

function parseVisionAssertion(text: string, expectText: string): VisionAssertion {
  const parsed = parseJsonObjectFromText(text, (value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && "visible" in value),
  );
  if (!parsed) {
    return {
      expectedText: expectText,
      matched: false,
      reason: "Image describe did not return a structured visual assertion.",
    };
  }
  const record = parsed;
  const visible = record.visible;
  const evidence = typeof record.evidence === "string" ? record.evidence.trim() : undefined;
  const reason = typeof record.reason === "string" ? record.reason.trim() : undefined;
  if (typeof visible !== "boolean") {
    return {
      evidence,
      expectedText: expectText,
      matched: false,
      reason: reason ?? "Image describe visual assertion is missing boolean visible.",
    };
  }
  const normalizedExpected = expectText.toLowerCase();
  const positiveEvidence = [evidence, reason]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(normalizedExpected));
  return {
    evidence,
    expectedText: expectText,
    matched: visible && Boolean(evidence) && positiveEvidence,
    reason: positiveEvidence
      ? reason
      : (reason ?? `Visual assertion did not cite the expected text "${expectText}".`),
    visible,
  };
}

export function evaluateVisualExpectation(
  text: string | undefined,
  expectText: string | undefined,
) {
  if (!expectText) {
    return { matched: true };
  }
  if (!text) {
    return {
      assertion: {
        expectedText: expectText,
        matched: false,
        reason: "Image describe did not return text.",
      },
      matched: false,
    };
  }
  const assertion = parseVisionAssertion(text, expectText);
  return { assertion, matched: assertion.matched };
}
