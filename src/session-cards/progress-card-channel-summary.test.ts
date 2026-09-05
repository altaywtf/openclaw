import { describe, expect, it } from "vitest";
import { formatProgressCardChannelSummary } from "./progress-card-channel-summary.js";

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
});
