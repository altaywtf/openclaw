import { describe, expect, it, vi } from "vitest";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";

async function flushAvailabilityResolution() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("assistant attachment availability", () => {
  it("scopes cached media tickets to the selected session", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.png`;
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const mainResolver = vi.fn(async () => ({
      available: true as const,
      mediaTicket: "ticket-main",
      mediaTicketExpiresAt: expiresAt,
    }));
    const researchResolver = vi.fn(async () => ({
      available: true as const,
      mediaTicket: "ticket-research",
      mediaTicketExpiresAt: expiresAt,
    }));

    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        mainResolver,
        1,
        "agent:main:main",
      ).status,
    ).toBe("checking");
    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        researchResolver,
        1,
        "agent:research:main",
      ).status,
    ).toBe("checking");

    await flushAvailabilityResolution();

    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        mainResolver,
        1,
        "agent:main:main",
      ),
    ).toMatchObject({ status: "available", mediaTicket: "ticket-main" });
    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        researchResolver,
        1,
        "agent:research:main",
      ),
    ).toMatchObject({ status: "available", mediaTicket: "ticket-research" });
    expect(mainResolver).toHaveBeenCalledTimes(1);
    expect(researchResolver).toHaveBeenCalledTimes(1);
  });
});
