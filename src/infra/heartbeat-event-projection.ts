import type { BackgroundTurnResult } from "../auto-reply/reply/background-turn.types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  emitHeartbeatEvent,
  resolveIndicatorType,
  type HeartbeatEventPayload,
} from "./heartbeat-events.js";

/** Projects ordinary background outcomes into the shipped heartbeat event contract. */
export function emitBackgroundTurnHeartbeatEvent(
  result: BackgroundTurnResult,
  deliveryContext?: DeliveryContext,
): void {
  let status: HeartbeatEventPayload["status"];
  let reason: string | undefined;
  if (result.status === "skipped") {
    status = "skipped";
    reason = result.reason;
  } else {
    const deliveryFailed =
      result.delivery &&
      Object.values(result.delivery.counts).some(
        (counts) => counts.failedBeforeSend > 0 || counts.failedAfterSend > 0,
      );
    reason =
      result.error ??
      (deliveryFailed
        ? "delivery-failed"
        : result.execution !== "ok"
          ? result.execution
          : undefined);
    status =
      result.error || deliveryFailed || result.execution === "failed"
        ? "failed"
        : result.delivery?.anyVisibleDelivered
          ? "sent"
          : result.execution === "ok"
            ? "ok-empty"
            : "skipped";
  }
  emitHeartbeatEvent({
    status,
    reason,
    durationMs: result.durationMs,
    channel: deliveryContext?.channel,
    to: deliveryContext?.to,
    accountId: deliveryContext?.accountId,
    indicatorType: resolveIndicatorType(status),
  });
}
