import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import type { BackgroundTurnParams, BackgroundTurnResult } from "./background-turn.types.js";
import type { ReplyDispatchReceipt } from "./reply-dispatcher.types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { routeReply } from "./route-reply.js";

export type { BackgroundTurnParams, BackgroundTurnResult } from "./background-turn.types.js";

/** A prepared background turn shares normal admission, execution, and durable delivery. */
export async function dispatchBackgroundTurn(
  params: BackgroundTurnParams,
): Promise<BackgroundTurnResult> {
  const startedAt = Date.now();
  const route = params.deliveryContext;
  const channel = route?.channel ?? INTERNAL_MESSAGE_CHANNEL;
  const deliverToUser = Boolean(route?.channel && route.to);
  let deliverySignal = params.signal;
  const runState: ReplyOperationRunState = {
    backgroundTurn: {
      ...params.policy,
      claim: (operation, storePath, databaseClaim) => {
        deliverySignal = operation.abortSignal;
        params.claim?.(operation, storePath, databaseClaim);
      },
    },
  };
  let executionStarted = false;
  let delivery: ReplyDispatchReceipt | undefined;
  let error: string | undefined;
  let outputText: string | undefined;
  try {
    const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
      cfg: params.cfg,
      ctx: {
        Body: params.prompt,
        BodyForAgent: params.prompt,
        BodyForCommands: "",
        CommandBody: "",
        AgentId: params.agentId,
        SessionKey: params.sessionKey,
        Provider: channel,
        Surface: channel,
        OriginatingChannel: channel,
        OriginatingTo: route?.to,
        AccountId: route?.accountId,
        MessageThreadId: route?.threadId,
        InputProvenance: params.source,
        CommandAuthorized: false,
      },
      toolsAllow: params.policy.toolsAllow,
      suppressOutboundHooks: deliverToUser ? undefined : true,
      replyOptions: {
        abortSignal: params.signal,
        expectedExistingSessionId: params.expectedSessionId,
        pinExpectedExistingSession: params.expectedSessionId !== undefined,
        timeoutOverrideSeconds: params.policy.timeoutSeconds,
        thinkingLevelOverride: params.policy.thinking,
        bootstrapContextMode: params.policy.lightContext ? "lightweight" : undefined,
        [REPLY_OPERATION_RUN_STATE]: runState,
        onAgentRunStart: (runId) => {
          executionStarted = true;
          params.onStarted?.(runId);
        },
      },
      dispatcherOptions: {
        deliver: async (payload, info) => {
          if (info.kind === "final" && payload.text) {
            outputText = truncateUtf16Safe(payload.text, 8_000);
          }
          if (!deliverToUser || !route?.to) {
            return { visibleReplySent: false };
          }
          const sent = await routeReply({
            cfg: params.cfg,
            payload,
            channel,
            to: route.to,
            accountId: route.accountId,
            threadId: route.threadId,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            replyKind: info.kind,
            mirror: false,
            abortSignal: deliverySignal,
          });
          if (!sent.ok) {
            if (!sent.delivered || sent.ambiguous) {
              throw new Error(sent.error, { cause: sent.cause });
            }
            error ??= sent.error;
          }
          return {
            visibleReplySent: sent.delivered,
            ...(sent.ambiguous ? { ambiguous: true } : {}),
            ...(sent.suppressed ? { suppression: { reason: sent.reason } } : {}),
          };
        },
      },
    });
    delivery = result.settledReceipt;
  } catch (cause) {
    error = formatErrorMessage(cause);
  }
  const durationMs = Date.now() - startedAt;
  if (runState.admission?.status === "skipped") {
    return {
      status: "skipped",
      reason: runState.admission.reason,
      executionStarted: false,
      durationMs,
    };
  }
  // Delivery cannot reopen a claimed turn. Its receipt is independent of the agent outcome.
  const execution = resolveReplyOperationAgentTurn(runState) ?? (error ? "failed" : "not-run");
  return {
    status: "settled",
    executionStarted,
    execution,
    delivery,
    outputText,
    error,
    durationMs,
  };
}
