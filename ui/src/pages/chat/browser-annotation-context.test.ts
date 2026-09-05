// @vitest-environment node
import { describe, expect, it } from "vitest";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import { createBrowserAnnotationAttachment } from "./chat-host.test-support.ts";

describe("composeBrowserAnnotationContext", () => {
  it("materializes an annotation-only message", async () => {
    const attachment = createBrowserAnnotationAttachment("only", "Inspect the marked region.");

    expect(composeBrowserAnnotationContext("", [attachment])).toBe("Inspect the marked region.");
  });

  it("prepends annotation context to the user's draft", async () => {
    const attachment = createBrowserAnnotationAttachment("mixed", "Browser context");

    expect(composeBrowserAnnotationContext("Please fix this", [attachment])).toBe(
      "Browser context\n\nPlease fix this",
    );
  });

  it("preserves attachment order across two annotations", async () => {
    const first = createBrowserAnnotationAttachment("first", "First context");
    const second = createBrowserAnnotationAttachment("second", "Second context");

    expect(composeBrowserAnnotationContext("Compare them", [first, second])).toBe(
      "First context\n\nSecond context\n\nCompare them",
    );
  });

  it("omits context for an annotation removed before submit", async () => {
    const removed = createBrowserAnnotationAttachment("removed", "Removed context");
    const remaining = createBrowserAnnotationAttachment("remaining", "Remaining context");
    const attachments = [removed, remaining];
    attachments.splice(0, 1);

    expect(composeBrowserAnnotationContext("Continue", attachments)).toBe(
      "Remaining context\n\nContinue",
    );
  });
});
