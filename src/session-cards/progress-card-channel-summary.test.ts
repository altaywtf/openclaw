import { describe, expect, it } from "vitest";
import {
  formatProgressCardChannelSummary,
  projectProgressCardChannelUpdate,
} from "./progress-card-channel-summary.js";

describe("formatProgressCardChannelSummary", () => {
  it("projects structured completion facts without reading card markup", () => {
    expect(
      formatProgressCardChannelSummary({
        hasMarkdown: true,
        steps: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }],
      }),
    ).toBe("1/3 complete");
  });

  it("uses a neutral state for markdown-only cards", () => {
    expect(formatProgressCardChannelSummary({ hasMarkdown: true, steps: [] })).toBe(
      "Progress updated",
    );
  });

  it("omits a summary when the card is cleared", () => {
    expect(formatProgressCardChannelSummary({ hasMarkdown: false, steps: [] })).toBeUndefined();
  });

  it.each([
    {
      name: "checklist",
      input: { plan: [{ step: "Ship", status: "completed" }] },
      expected: {
        steps: [{ step: "Ship", status: "completed" }],
        explanation: "1/1 complete",
      },
    },
    {
      name: "markdown-only",
      input: { markdown: "Working" },
      expected: { steps: [], explanation: "Progress updated" },
    },
    { name: "clear", input: {}, expected: { steps: [] } },
  ])("projects normalized $name input for every runtime producer", ({ input, expected }) => {
    expect(projectProgressCardChannelUpdate(input)).toEqual(expected);
  });
});
