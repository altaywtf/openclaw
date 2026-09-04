import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type * as sessionEntryAccessor from "../../config/sessions/session-accessor.sqlite-entry.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  replyRunRegistry,
  installThreadingTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawAgentDatabasesForTest);

describe("background turn admission", () => {
  beforeEach(() => {
    sessionStoreMocks.databaseEntryLoader = undefined;
    return describe0BeforeEach0();
  });

  const sessionKey = "agent:main:completion";
  const sessionId = "completion-session";
  const ctx = () =>
    buildTestCtx({
      SessionKey: sessionKey,
      Body: "A background command completed.",
      BodyForCommands: "",
      InternalTurnSource: "exec",
      CommandAuthorized: false,
    });

  it("claims the occurrence before hooks or execution and retires a rejected claim", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation((name) => name === "message_received");
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const replyResolver = vi.fn(async () => ({ text: "must not run" }));
    const claim = vi.fn(() => {
      throw new Error("completion already acknowledged");
    });
    await expect(
      dispatchReplyFromConfig({
        ctx: ctx(),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver,
        replyOptions: {
          [REPLY_OPERATION_RUN_STATE]: { backgroundTurn: { trigger: "background", claim } },
        },
      }),
    ).rejects.toThrow("completion already acknowledged");
    expect(claim).toHaveBeenCalledOnce();
    expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(replyRunRegistry.get(sessionKey)).toBeUndefined());
  });

  it.each(["complete", "cancel", "compact"] as const)(
    "waits without superseding an active reply, then handles %s",
    async (settlement) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
      const storePath = path.join(tempDirs.make("background-admission-"), "sessions.json");
      sessionStoreMocks.resolveSessionStorePathCore.mockReturnValue(storePath);
      replaceSessionEntrySync({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
      const actualAccessor = await vi.importActual<typeof sessionEntryAccessor>(
        "../../config/sessions/session-accessor.sqlite-entry.js",
      );
      sessionStoreMocks.databaseEntryLoader = actualAccessor.loadSessionEntryWithDatabase;
      const admitted = await admitReplyTurn({
        sessionKey,
        sessionId,
        storePath: sessionStoreMocks.resolveSessionStorePathCore(),
        resetTriggered: false,
        kind: "visible",
      });
      if (admitted.status !== "owned") {
        throw new Error("expected the parent reply to own admission");
      }
      const active = admitted.operation;
      const claim = vi.fn(() => {
        expect(active.result?.kind).toBe("completed");
        expect(active.abortSignal.aborted).toBe(false);
      });
      const replyResolver = vi.fn(async (_ctx, opts?: InternalGetReplyOptions) => {
        expect(opts?.expectedExistingSessionId).toBe(active.sessionId);
        return { text: "completion handled" };
      });
      const runState: ReplyOperationRunState = { backgroundTurn: { trigger: "background", claim } };
      const controller = new AbortController();
      const waitForIdle = vi.spyOn(replyRunRegistry, "waitForIdle");
      const dispatch = dispatchReplyFromConfig({
        ctx: ctx(),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver,
        replyOptions: {
          [REPLY_OPERATION_RUN_STATE]: runState,
          expectedExistingSessionId: sessionId,
          pinExpectedExistingSession: true,
          abortSignal: controller.signal,
        },
      });
      try {
        expect(admitted.databaseClaim).toBeDefined();
        await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalled());
        expect(active.abortSignal.aborted).toBe(false);
        expect(claim).not.toHaveBeenCalled();
        if (settlement === "cancel") {
          controller.abort();
        } else {
          if (settlement === "compact") {
            active.updateSessionId("compacted-session");
            replaceSessionEntrySync(
              { storePath, sessionKey },
              {
                sessionId: "compacted-session",
                updatedAt: 1,
              },
            );
            sessionStoreMocks.currentEntry = {
              sessionId: "compacted-session",
              updatedAt: Date.now(),
            };
          }
          active.complete();
        }
        await dispatch;
        expect(runState.admission).toEqual({
          status: settlement === "cancel" ? "skipped" : "owned",
          ...(settlement === "cancel" ? { reason: "aborted" } : {}),
        });
        expect(claim).toHaveBeenCalledTimes(settlement !== "cancel" ? 1 : 0);
        expect(replyResolver).toHaveBeenCalledTimes(settlement !== "cancel" ? 1 : 0);
      } finally {
        active.complete();
        await dispatch;
        waitForIdle.mockRestore();
        sessionStoreMocks.databaseEntryLoader = undefined;
      }
    },
  );

  it("does not transfer a pinned completion to a replacement session", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { sessionId: "replacement", updatedAt: Date.now() };
    const replyResolver = vi.fn(async () => ({ text: "must not run" }));
    const claim = vi.fn();
    await dispatchReplyFromConfig({
      ctx: ctx(),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
      replyOptions: {
        [REPLY_OPERATION_RUN_STATE]: { backgroundTurn: { trigger: "background", claim } },
        expectedExistingSessionId: sessionId,
        pinExpectedExistingSession: true,
      },
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageReceived).not.toHaveBeenCalled();
  });

  it("keeps an absent original thread out of plugin completion routing", async () => {
    setNoAbort();
    installThreadingTestPlugin({ id: "telegram" });
    hookMocks.runner.hasHooks.mockImplementation((name) => name === "before_dispatch");
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const threadSessionKey = "agent:main:telegram:group:original:topic:17";
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        SessionKey: threadSessionKey,
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "original",
        MessageThreadId: undefined,
        TransportThreadId: undefined,
        AccountId: undefined,
        CommandAuthorized: false,
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: vi.fn(async () => undefined),
      replyOptions: { [REPLY_OPERATION_RUN_STATE]: { backgroundTurn: { trigger: "background" } } },
    });
    expect(hookMocks.runner.runBeforeDispatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        sessionKey: threadSessionKey,
        origin: { channel: "telegram", to: "original", accountId: "default" },
      },
    );
  });
});
