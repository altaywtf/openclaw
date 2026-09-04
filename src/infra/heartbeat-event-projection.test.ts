import { afterEach, describe, expect, it } from "vitest";
import type { BackgroundTurnResult } from "../auto-reply/reply/background-turn.types.js";
import { createReplyDispatchSettledCounts } from "../auto-reply/reply/reply-dispatch-outcome.js";
import type { ReplyDispatchReceipt } from "../auto-reply/reply/reply-dispatcher.types.js";
import { emitBackgroundTurnHeartbeatEvent } from "./heartbeat-event-projection.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";

afterEach(resetHeartbeatEventsForTest);

function receipt(
  final: Partial<ReplyDispatchReceipt["counts"]["final"]>,
  anyVisibleDelivered: boolean,
): ReplyDispatchReceipt {
  return {
    counts: {
      tool: createReplyDispatchSettledCounts(),
      block: createReplyDispatchSettledCounts(),
      final: { ...createReplyDispatchSettledCounts(), ...final },
    },
    anyVisibleDelivered,
  };
}

describe("background outcome heartbeat projection", () => {
  it.each([
    { delivery: receipt({ delivered: 1 }, true), expectedStatus: "sent" },
    { delivery: receipt({ deliveredNotVisible: 1 }, false), expectedStatus: "ok-empty" },
    { delivery: receipt({ failedBeforeSend: 1 }, false), expectedStatus: "failed" },
    { delivery: receipt({ failedAfterSend: 1 }, true), expectedStatus: "failed" },
  ])("projects settled delivery as $expectedStatus", ({ delivery, expectedStatus }) => {
    emitBackgroundTurnHeartbeatEvent(
      {
        status: "settled",
        execution: "ok",
        executionStarted: true,
        durationMs: 12,
        outputText: "The model produced text; this alone does not prove delivery.",
        delivery,
      },
      { channel: "slack", to: "channel:C1", accountId: "work", threadId: "123.4" },
    );

    expect(getLastHeartbeatEvent()).toMatchObject({
      status: expectedStatus,
      durationMs: 12,
      channel: "slack",
      to: "channel:C1",
      accountId: "work",
    });
    expect(getLastHeartbeatEvent()).not.toHaveProperty("preview");
  });

  it.each([
    { status: "skipped", reason: "lifecycle-invalidated", executionStarted: false, durationMs: 0 },
    { status: "settled", execution: "cancelled", executionStarted: true, durationMs: 12 },
    { status: "settled", execution: "superseded", executionStarted: true, durationMs: 12 },
  ] satisfies BackgroundTurnResult[])("preserves a terminal non-outcome", (result) => {
    emitBackgroundTurnHeartbeatEvent(result);
    expect(getLastHeartbeatEvent()).toMatchObject({
      status: "skipped",
      reason: result.status === "skipped" ? result.reason : result.execution,
    });
  });

  it("does not report success when execution fails after a visible delivery", () => {
    emitBackgroundTurnHeartbeatEvent({
      status: "settled",
      execution: "failed",
      executionStarted: true,
      durationMs: 12,
      delivery: receipt({ delivered: 1 }, true),
      error: "model failed",
    });
    expect(getLastHeartbeatEvent()).toMatchObject({ status: "failed", reason: "model failed" });
  });
});
