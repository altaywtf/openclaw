import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  deliveryContextFromSession,
  normalizeSessionDeliveryState,
} from "../../utils/delivery-context.shared.js";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import { dispatchBackgroundTurn } from "./background-turn.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { REPLY_OPERATION_RUN_STATE, resolveBackgroundTurn } from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { initSessionState } from "./session.js";

const { dispatch, route } = vi.hoisted(() => ({ dispatch: vi.fn(), route: vi.fn() }));
vi.mock("../dispatch.js", () => ({ dispatchInboundMessageWithRoutedChannelDispatcher: dispatch }));
vi.mock("./route-reply.js", () => ({ routeReply: route }));
afterEach(() => vi.clearAllMocks());

it.each([false, true])("uses terminal-owned delivery cancellation, frozen=%s", async (frozen) => {
  const controller = new AbortController();
  const operation = createReplyOperation({
    sessionKey: "agent:main:background",
    sessionId: "background-session",
    resetTriggered: false,
    upstreamAbortSignal: controller.signal,
  });
  route.mockImplementation(async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
    ok: !abortSignal?.aborted,
    delivered: !abortSignal?.aborted,
  }));
  dispatch.mockImplementationOnce(
    async (params: Parameters<typeof dispatchInboundMessageWithRoutedChannelDispatcher>[0]) => {
      resolveBackgroundTurn(params.replyOptions)?.claim?.(operation);
      if (frozen) {
        operation.freezeAbort();
      }
      controller.abort();
      const state = params.replyOptions?.[REPLY_OPERATION_RUN_STATE];
      if (state) {
        state.agentTurn = frozen ? "ok" : "cancelled";
      }
      await params.dispatcherOptions.deliver({ text: "completed" }, { kind: "final" });
      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
    },
  );
  try {
    const result = await dispatchBackgroundTurn({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:background",
      prompt: "Continue the completed task.",
      source: { kind: "internal_system", sourceTool: "exec" },
      deliveryContext: { channel: "telegram", to: "original" },
      policy: { trigger: "background" },
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      status: "settled",
      execution: frozen ? "ok" : "cancelled",
    });
    expect(route.mock.calls[0]?.[0].abortSignal.aborted).toBe(!frozen);
    expect(dispatch).toHaveBeenCalledOnce();
  } finally {
    operation.complete();
  }
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawAgentDatabasesForTest);

it.each(
  [
    { name: "captured route", sessionKey: "agent:main:main", threadId: undefined, noRoute: false },
    {
      name: "captured thread",
      sessionKey: "agent:main:telegram:group:chat:topic:7",
      threadId: "7",
      noRoute: false,
    },
    { name: "no route", sessionKey: "agent:main:main", threadId: undefined, noRoute: true },
  ].flatMap((testCase) =>
    [false, true].map((rememberedThread) => ({
      name: testCase.name,
      sessionKey: testCase.sessionKey,
      threadId: testCase.threadId,
      noRoute: testCase.noRoute,
      rememberedThread,
    })),
  ),
)(
  "preserves remembered session routing and activity for $name, remembered thread=$rememberedThread",
  async ({ sessionKey, threadId, noRoute, rememberedThread }) => {
    const storePath = path.join(tempDirs.make("background-session-route-"), "sessions.json");
    const sessionId = "background-route-session";
    const lastInteractionAt = Date.now() - 30_000;
    const remembered = {
      channel: rememberedThread ? "slack" : "telegram",
      to: "newer-target",
      accountId: "newer-account",
      threadId: rememberedThread ? "501.000" : undefined,
    };
    replaceSessionEntrySync(
      { storePath, sessionKey },
      {
        sessionId,
        updatedAt: lastInteractionAt,
        lastInteractionAt,
        chatType: rememberedThread ? "group" : "direct",
        delivery: normalizeSessionDeliveryState({ context: remembered }),
      },
    );
    const actual = await vi.importActual<typeof import("../dispatch.js")>("../dispatch.js");
    dispatch.mockImplementationOnce(
      (params: Parameters<typeof dispatchInboundMessageWithRoutedChannelDispatcher>[0]) =>
        actual.dispatchInboundMessageWithRoutedChannelDispatcher({
          ...params,
          dispatchReplyFromConfig: async ({ ctx, cfg, dispatcher, replyOptions }) => {
            const input = {
              ctx: finalizeInboundContext(ctx),
              cfg,
              commandAuthorized: false,
              opts: replyOptions,
            };
            await initSessionState(input);
            dispatcher.sendFinalReply({ text: "completion handled" });
            return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
          },
        }),
    );
    route.mockResolvedValue({ ok: true, delivered: true });
    const captured = noRoute
      ? undefined
      : {
          channel: "telegram",
          to: "original-target",
          accountId: "original-account",
          threadId: threadId ? "3" : undefined,
        };
    await dispatchBackgroundTurn({
      cfg: { session: { store: storePath } },
      agentId: "main",
      sessionKey,
      expectedSessionId: sessionId,
      prompt: "Continue the completed command.",
      source: { kind: "internal_system", sourceTool: "exec" },
      deliveryContext: captured,
      policy: { trigger: "background" },
    });
    if (captured) {
      expect(route).toHaveBeenCalledWith(expect.objectContaining(captured));
    } else {
      expect(route).not.toHaveBeenCalled();
    }
    const stored = loadSessionEntry({ storePath, sessionKey });
    expect(deliveryContextFromSession(stored)).toEqual(remembered);
    expect(stored?.lastInteractionAt).toBe(lastInteractionAt);
  },
);
