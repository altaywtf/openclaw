// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatGoalDraftMode, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  openControlUiDatabase,
  transactionComplete,
} from "../../lib/chat/control-ui-database.runtime.ts";
import {
  hydrateChatOutboxMetadata,
  migrateLegacyChatOutboxMetadata,
  persistPendingChatOutboxAdmission,
  protectPendingChatOutboxAdmission,
  retirePendingChatOutboxAdmission,
} from "../../lib/chat/outbox-metadata-store.runtime.ts";
import { outboxPayloadTab } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { readChatOutboxRecovery } from "../../lib/chat/outbox-recovery.ts";
import {
  captureChatOutboxAdmission,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import {
  createStorageMock,
  installSafeLocalStorageForTesting,
} from "../../test-helpers/storage.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  listStoredChatOutboxes,
  loadChatComposerDraftRevision,
  loadChatComposerSnapshot,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  restoreChatComposerState,
  updateStoredChatComposerQueueItem,
} from "./composer-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

type ComposerState = Parameters<typeof persistChatComposerState>[0] & {
  selectedChatSessionIncognito: boolean;
};

const LEGACY_STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v4:";
let journalStorage: Storage;

function gatewayOwner(gatewayUrl: string | null | undefined): string {
  return gatewayUrl?.trim() || "default";
}

function legacyStorageKeyForGateway(gatewayUrl: string | null | undefined): string {
  return `${LEGACY_STORAGE_KEY_PREFIX}${encodeURIComponent(gatewayOwner(gatewayUrl)).slice(0, 240)}`;
}

function storageKeyForGateway(gatewayUrl: string | null | undefined): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(gatewayOwner(gatewayUrl))}`;
}

function createState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    selectedChatSessionIncognito: false,
    ...overrides,
  };
}

function reconnectItem(id: string, createdAt: number): ChatQueueItem {
  return {
    id,
    text: `message ${id}`,
    createdAt,
    sendRunId: `run-${id}`,
    sendState: "waiting-reconnect",
  };
}

beforeEach(() => {
  installOutboxBrowserStorage();
  journalStorage = installSafeLocalStorageForTesting();
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat composer persistence", () => {
  it("retires a journaled admission after its in-memory registration settles", async () => {
    vi.stubGlobal("document", {});
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    const state = createState();
    const item = reconnectItem("journaled-removal", 1);
    const admission = captureChatOutboxAdmission(state, state.sessionKey);
    await outboxPayloadTab();
    expect(protectPendingChatOutboxAdmission(state, admission.scope, item)).toBeTypeOf("function");
    expect(persistPendingChatOutboxAdmission(item)).toBe(true);

    expect(retirePendingChatOutboxAdmission(item.id)).toBe(true);

    const journals = Array.from({ length: journalStorage.length }, (_, index) =>
      journalStorage.key(index),
    )
      .filter((key): key is string => key?.startsWith("openclaw.control.chatPending.v1:") === true)
      .map(
        (key) =>
          JSON.parse(journalStorage.getItem(key) ?? "{}") as {
            retired?: string[];
            sessions?: Record<string, { queue?: ChatQueueItem[] }>;
          },
      );
    expect(
      journals.flatMap((journal) =>
        Object.values(journal.sessions ?? {}).flatMap((session) => session.queue ?? []),
      ),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: item.id })]));
    expect(journals.flatMap((journal) => journal.retired ?? [])).toContain(item.id);
  });

  it("restores selected recipients and gives same-text recipient changes their own revision", async () => {
    const first = [{ profileId: "alex-one", start: 0, end: 5 }];
    const second = [{ profileId: "alex-two", start: 0, end: 5 }];
    const state = createState({ chatMessage: "@Alex", chatMentions: first });
    expect(persistChatComposerState(state, state.sessionKey, { draftRevision: 10 })).toBe(true);
    const queued = reconnectItem("keep-draft-mentions", 1);
    expect(
      await admitStoredChatComposerQueueItem(
        state,
        captureChatOutboxAdmission(state, state.sessionKey),
        queued,
      ),
    ).toBe(true);
    expect(await removeStoredChatComposerQueueItem(state, state.sessionKey, queued.id)).toBe(true);
    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);
    expect(restored.chatMentions).toEqual(first);
    expect(
      persistChatComposerState(state, state.sessionKey, { draftRevision: 10, mentions: second }),
    ).toBe(false);

    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMentions = second;
    persistence.schedule();
    persistence.persistNow();
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.mentions).toEqual(second);
    expect(loadChatComposerDraftRevision(state, state.sessionKey)).toBeGreaterThan(10);
    state.chatMentions = [];
    persistence.schedule();
    persistence.stop();
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "@Alex",
      queue: [],
    });
  });

  it.each<ChatGoalDraftMode>([
    { action: "start", sessionId: "session-a" },
    {
      action: "edit",
      sessionId: "session-a",
      goalId: "goal-a",
      previousDraft: "Prior conversation draft",
    },
  ])("restores $action mode with its literal draft and exact target", async (goalMode) => {
    const state = createState({
      chatMessage: "  /goal clear\n  literal objective ",
      chatGoalDraftMode: goalMode,
    });
    expect(persistChatComposerState(state)).toBe(true);
    const restored = createState();
    expect(restoreChatComposerState(restored)).toBe(true);
    expect(restored.chatMessage).toBe(state.chatMessage);
    expect(restored.chatGoalDraftMode).toEqual(goalMode);
    expect(loadChatComposerSnapshot(state, "agent:lily:other")).toBeNull();

    const queued = reconnectItem("other-message", 1);
    const queuedAdmission = captureChatOutboxAdmission(state, state.sessionKey, queued.agentId);
    expect(await admitStoredChatComposerQueueItem(state, queuedAdmission, queued)).toBe(true);
    expect(await removeStoredChatComposerQueueItem(state, state.sessionKey, queued.id)).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toEqual(goalMode);
  });

  it("persists empty Goal mode and gives cancellation a new draft revision", async () => {
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatGoalDraftMode = { action: "start", sessionId: "session-a" };
    persistence.schedule();
    persistence.persistNow();
    const revision = loadChatComposerDraftRevision(state, state.sessionKey);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toEqual(
      state.chatGoalDraftMode,
    );
    state.chatGoalDraftMode = null;
    persistence.schedule();
    persistence.persistNow();
    expect(loadChatComposerDraftRevision(state, state.sessionKey)).toBeGreaterThan(revision);
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
    persistence.stop();
  });

  it("fences a same-revision retry that changes objective interpretation", async () => {
    const state = createState({
      chatMessage: "/goal clear",
      chatGoalDraftMode: { action: "start" },
    });
    expect(persistChatComposerState(state, state.sessionKey, { draftRevision: 10 })).toBe(true);
    expect(
      persistChatComposerState(state, state.sessionKey, { draftRevision: 10, goalMode: null }),
    ).toBe(false);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.goalMode).toEqual({
      action: "start",
    });
  });

  it("does not persist whitespace-only drafts", async () => {
    const state = createState({ chatMessage: "  \n  " });

    expect(persistChatComposerState(state)).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
  });

  it("normalizes an existing whitespace-only stored draft during restore", async () => {
    const state = createState();
    const gatewayUrl = state.settings?.gatewayUrl;
    sessionStorage.setItem(
      storageKeyForGateway(gatewayUrl),
      JSON.stringify({
        version: 4,
        recovery: {},
        gatewayOwner: gatewayUrl,
        sessions: {
          [`${state.sessionKey}\u0000agent:lily`]: {
            draft: "  \n  ",
            draftRevision: 1,
            updatedAt: 1,
          },
        },
      }),
    );

    expect(restoreChatComposerState(state)).toBe(false);
    expect(state.chatMessage).toBe("");
  });

  it("quarantines an unattributed legacy steer row for explicit recovery", async () => {
    const state = createState();
    const gatewayUrl = state.settings?.gatewayUrl;
    const storageKey = storageKeyForGateway(gatewayUrl);
    sessionStorage.setItem(
      storageKey.replace(".v4:", ".v2:"),
      JSON.stringify({
        version: 2,
        recovery: {},
        gatewayOwner: gatewayUrl,
        sessions: {
          [`${state.sessionKey}\u0000agent:lily`]: {
            queue: [
              {
                id: "steer-reload",
                text: "keep the target",
                createdAt: 1,
                kind: "steered",
                sendRunId: "steer-request",
                sendState: "steering",
                steerTargetRunId: "active-run",
              },
            ],
            updatedAt: 1,
          },
        },
      }),
    );

    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    const restored = readChatOutboxRecovery(state).entries[0]?.session.queue?.[0];
    expect(restored).toMatchObject({
      id: "steer-reload",
      queueMode: "steer",
      sendRunId: "steer-request",
      sendState: "unconfirmed",
    });
    expect(restored).not.toHaveProperty("kind");
    expect(restored).not.toHaveProperty("steerTargetRunId");

    const written = sessionStorage.getItem(storageKey) ?? "";
    expect(written).toContain('"queueMode":"steer"');
    expect(written).not.toContain('"kind":"steered"');
    expect(written).not.toContain("steerTargetRunId");
    expect(written).not.toContain('"sendState":"steering"');
  });

  it("keeps a pending draft and its route handoff on the identity captured before defaults change", async () => {
    const state = createState({
      sessionKey: "agent:main:main",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "draft for the original main";
    persistence.schedule();
    state.agentsList = { defaultId: "main", mainKey: "workspace", scope: "per-sender" };
    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    persistence.persistNow();
    const stored = JSON.parse(
      sessionStorage.getItem(storageKeyForGateway(state.settings?.gatewayUrl))!,
    );
    expect(stored.sessions["agent:main:main\u0000agent:main"].draft).toBe(
      "draft for the original main",
    );
    expect(stored.sessions["agent:main:workspace\u0000agent:main"]).toBeUndefined();
    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    persistence.stop();
  });

  it("notifies stored outbox subscribers on draft presence transitions and queue writes", async () => {
    const state = createState();
    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    const original = reconnectItem("notify", 1);
    const updated = { ...original, text: "updated message" };
    const listener = vi.fn();
    const unsubscribe = subscribeStoredChatOutboxChanges(listener);

    try {
      expect(persistChatComposerState({ ...state, chatMessage: "draft only" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      // Content-only re-persists stay silent so projection subscribers cannot
      // react by re-persisting a stale pane over the newer draft.
      expect(persistChatComposerState({ ...state, chatMessage: "draft only, edited" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(persistChatComposerState({ ...state, chatMessage: "" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
      const originalAdmission = captureChatOutboxAdmission(
        state,
        state.sessionKey,
        original.agentId,
      );
      expect(await admitStoredChatComposerQueueItem(state, originalAdmission, original)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(
        await updateStoredChatComposerQueueItem(
          state,
          state.sessionKey,
          original,
          updated,
          original.agentId,
        ),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
    }

    expect(
      await removeStoredChatComposerQueueItem(
        state,
        state.sessionKey,
        updated.id,
        updated,
        updated.agentId,
      ),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("flushes a debounced draft before its owner releases state", async () => {
    vi.useFakeTimers();
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "persist during disconnect";
    persistence.schedule();

    persistence.stop();

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "persist during disconnect",
      queue: [],
    });
  });

  it("keeps debounced draft writes out of durable queue ownership", async () => {
    const state = createState({
      chatQueue: [reconnectItem("memory-only", 1)],
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatQueue = [reconnectItem("new-memory-only", 2)];

    persistence.persistChangedState();

    expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
  });

  it("does not erase another split pane draft when its own draft is unchanged", async () => {
    const untouchedPane = createState();
    const untouchedPersistence = new ChatComposerPersistence(() => untouchedPane);
    untouchedPersistence.start();

    const editedPane = createState({ chatMessage: "draft from the other pane" });
    expect(persistChatComposerState(editedPane)).toBe(true);

    expect(untouchedPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(loadChatComposerSnapshot(editedPane, editedPane.sessionKey)?.draft).toBe(
      "draft from the other pane",
    );
  });

  it("does not let an older pane timer overwrite a newer split-pane draft", async () => {
    vi.useFakeTimers();
    const olderPane = createState();
    const olderPersistence = new ChatComposerPersistence(() => olderPane);
    olderPersistence.start();
    const newerPane = createState();
    const newerPersistence = new ChatComposerPersistence(() => newerPane);
    newerPersistence.start();

    olderPane.chatMessage = "older draft";
    olderPersistence.schedule();
    newerPane.chatMessage = "newer draft";
    newerPersistence.schedule();
    expect(newerPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(newerPane, newerPane.sessionKey)?.draft).toBe("newer draft");
    expect(olderPersistence.persistForRouteSwitchResult().status).toBe("conflict");

    olderPane.chatMessage = "newest draft after conflict";
    olderPersistence.schedule();
    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(olderPane, olderPane.sessionKey)?.draft).toBe(
      "newest draft after conflict",
    );
  });

  it("keeps the later edit when split pane timers flush in natural order", async () => {
    vi.useFakeTimers();
    const firstPane = createState();
    const firstPersistence = new ChatComposerPersistence(() => firstPane);
    firstPersistence.start();
    const secondPane = createState();
    const secondPersistence = new ChatComposerPersistence(() => secondPane);
    secondPersistence.start();

    firstPane.chatMessage = "first draft";
    firstPersistence.schedule();
    vi.advanceTimersByTime(10);
    secondPane.chatMessage = "later draft";
    secondPersistence.schedule();

    vi.advanceTimersByTime(190);
    expect(loadChatComposerSnapshot(firstPane, firstPane.sessionKey)?.draft).toBe("first draft");

    vi.advanceTimersByTime(10);
    expect(loadChatComposerSnapshot(secondPane, secondPane.sessionKey)?.draft).toBe("later draft");
  });

  it("does not let an older pane timer resurrect a draft after a newer clear", async () => {
    vi.useFakeTimers();
    const initial = createState({ chatMessage: "saved draft" });
    expect(persistChatComposerState(initial)).toBe(true);
    const olderPane = createState({ chatMessage: "saved draft" });
    const olderPersistence = new ChatComposerPersistence(() => olderPane);
    olderPersistence.start();
    const clearingPane = createState({ chatMessage: "saved draft" });
    const clearingPersistence = new ChatComposerPersistence(() => clearingPane);
    clearingPersistence.start();

    olderPane.chatMessage = "stale replacement";
    olderPersistence.schedule();
    clearingPane.chatMessage = "";
    clearingPersistence.schedule();
    expect(clearingPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

    vi.advanceTimersByTime(200);

    expect(loadChatComposerSnapshot(initial, initial.sessionKey)).toBeNull();
  });

  it("persists a delayed global draft to the agent scope captured when typed", async () => {
    const state = createState({
      assistantAgentId: "alpha",
      chatMessage: "",
      sessionKey: "global",
    });
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "alpha draft";
    persistence.schedule();

    const beta = createState({
      assistantAgentId: "beta",
      chatMessage: "beta draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(beta)).toBe(true);
    state.assistantAgentId = "beta";

    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "global",
      agentId: "alpha",
    });
    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(persistence.scopeForRouteSwitch()).toEqual({
      sessionKey: "global",
      agentId: "alpha",
    });
    expect(loadChatComposerSnapshot({ ...state, assistantAgentId: "alpha" }, "global")?.draft).toBe(
      "alpha draft",
    );
    expect(loadChatComposerSnapshot(beta, "global")?.draft).toBe("beta draft");
  });

  it("flushes a route-provided draft applied after persistence starts", async () => {
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "draft from route input";
    persistence.schedule();

    expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("draft from route input");
  });

  it("keeps draft storage independent from durable outbox capacity", async () => {
    const state = createState();
    for (let index = 0; index < 20; index += 1) {
      const sessionKey = `agent:worker-${index}:thread`;
      expect(
        await admitStoredChatComposerQueueItem(
          state,
          captureChatOutboxAdmission(state, sessionKey),
          reconnectItem(`scope-${index}`, index),
        ),
      ).toBe(true);
    }

    const draft = createState({
      sessionKey: "agent:draft-owner:thread",
      chatMessage: "keep this in memory when storage is full",
    });
    expect(persistChatComposerState(draft)).toBe(true);
    expect(loadChatComposerSnapshot(draft, draft.sessionKey)).toEqual({
      draft: "keep this in memory when storage is full",
      queue: [],
    });
  });

  it("preserves a newer outbox attempt when a stale pane saves its draft", async () => {
    const admitted = reconnectItem("shared", 1);
    const stalePane = createState({ chatQueue: [admitted] });
    const admittedAdmission = captureChatOutboxAdmission(
      stalePane,
      stalePane.sessionKey,
      admitted.agentId,
    );
    expect(await admitStoredChatComposerQueueItem(stalePane, admittedAdmission, admitted)).toBe(
      true,
    );
    const attempted = { ...admitted, sendAttempts: 1 };
    expect(
      await updateStoredChatComposerQueueItem(stalePane, stalePane.sessionKey, admitted, attempted),
    ).toBe(true);

    stalePane.chatMessage = "stale pane draft";
    expect(persistChatComposerState(stalePane)).toBe(true);

    expect(loadChatComposerSnapshot(stalePane, stalePane.sessionKey)).toEqual({
      draft: "stale pane draft",
      queue: [
        {
          ...attempted,
          sessionKey: "agent:lily:main",
          agentId: "lily",
        },
      ],
    });
  });

  it("admits distinct same-scope items without whole-queue overwrite", async () => {
    const first = reconnectItem("first-pane", 1);
    const second = reconnectItem("second-pane", 2);

    expect(
      await admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", first.agentId),
        first,
      ),
    ).toBe(true);
    expect(
      await admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", second.agentId),
        second,
      ),
    ).toBe(true);

    expect(
      loadChatComposerSnapshot(createState(), "agent:lily:main")?.queue.map((item) => item.id),
    ).toEqual(["first-pane", "second-pane"]);
  });

  it("rejects conflicting admission of an existing item id", async () => {
    const item = reconnectItem("same-id", 1);
    expect(
      await admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", item.agentId),
        item,
      ),
    ).toBe(true);

    expect(
      await admitStoredChatComposerQueueItem(
        createState(),
        captureChatOutboxAdmission(createState(), "agent:lily:main", item.agentId),
        {
          ...item,
          text: "different payload",
        },
      ),
    ).toBe(false);
  });

  it.each(["send-attempt", "payload-reference"])(
    "uses item versions to reject stale updates and deletes after a %s change",
    async (change) => {
      const state = createState({
        chatMessage: "keep this draft",
        client: { recoveryScope: "versioned-owner", recoveryScopeReady: true },
      });
      persistChatComposerState(state);
      const reference = {
        key: "original-payload",
        recoveryScope: "versioned-owner",
        tabId: "versioned-tab",
      };
      const original: ChatQueueItem = {
        ...reconnectItem("versioned", 1),
        attachments: [{ id: "versioned-file", mimeType: "image/png", sizeBytes: 3 }],
        attachmentPayload: reference,
      };
      const successor =
        change === "send-attempt"
          ? { ...original, sendAttempts: 1 }
          : { ...original, attachmentPayload: { ...reference, key: "replacement-payload" } };
      const originalAdmission = captureChatOutboxAdmission(
        state,
        state.sessionKey,
        original.agentId,
      );
      expect(await admitStoredChatComposerQueueItem(state, originalAdmission, original)).toBe(true);
      expect(
        await updateStoredChatComposerQueueItem(state, state.sessionKey, original, successor),
      ).toBe(true);

      expect(
        await updateStoredChatComposerQueueItem(state, state.sessionKey, original, {
          ...original,
          sendAttempts: 2,
        }),
      ).toBe(false);
      expect(
        await removeStoredChatComposerQueueItem(state, state.sessionKey, original.id, original),
      ).toBe(false);
      expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue[0]).toMatchObject(successor);
      expect(
        await removeStoredChatComposerQueueItem(state, state.sessionKey, successor.id, successor),
      ).toBe(true);
      expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
        draft: "keep this draft",
        queue: [],
      });
    },
  );

  it("keeps unresolved bare main and raw global independent until their owners resolve", async () => {
    const offlineMain = createState({ agentsList: null, hello: null, sessionKey: "main" });
    const offlineGlobal = createState({ agentsList: null, hello: null, sessionKey: "global" });
    const mainItem = reconnectItem("unresolved-main", 1);
    const globalItem = reconnectItem("unresolved-global", 2);
    const mainAdmission = captureChatOutboxAdmission(offlineMain, "main", mainItem.agentId);
    expect(await admitStoredChatComposerQueueItem(offlineMain, mainAdmission, mainItem)).toBe(true);
    const globalAdmission = captureChatOutboxAdmission(offlineGlobal, "global", globalItem.agentId);
    expect(await admitStoredChatComposerQueueItem(offlineGlobal, globalAdmission, globalItem)).toBe(
      true,
    );
    expect(listStoredChatOutboxes(offlineMain)).toEqual([
      {
        sessionKey: "main",
        queue: [{ ...mainItem, sessionKey: "main" }],
      },
      {
        sessionKey: "global",
        queue: [{ ...globalItem, sessionKey: "global" }],
      },
    ]);

    const resolved = createState({
      agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
      assistantAgentId: "alpha",
      sessionKey: "global",
    });
    await migrateLegacyChatOutboxMetadata(resolved);
    expect(listStoredChatOutboxes(resolved)).toEqual([
      {
        sessionKey: "global",
        agentId: "work",
        queue: [{ ...mainItem, sessionKey: "global", agentId: "work" }],
      },
      {
        sessionKey: "global",
        agentId: "alpha",
        queue: [{ ...globalItem, sessionKey: "global", agentId: "alpha" }],
      },
    ]);

    const attemptedMain = {
      ...mainItem,
      agentId: "work",
      sendAttempts: 1,
      sessionKey: "global",
    };
    const attemptedGlobal = {
      ...globalItem,
      agentId: "alpha",
      sendAttempts: 1,
      sessionKey: "global",
    };
    expect(
      await updateStoredChatComposerQueueItem(
        resolved,
        "global",
        { ...mainItem, agentId: "work", sessionKey: "global" },
        attemptedMain,
      ),
    ).toBe(true);
    expect(
      await updateStoredChatComposerQueueItem(
        resolved,
        "global",
        { ...globalItem, agentId: "alpha", sessionKey: "global" },
        attemptedGlobal,
      ),
    ).toBe(true);
    expect(
      await removeStoredChatComposerQueueItem(resolved, "global", mainItem.id, attemptedMain),
    ).toBe(true);
    expect(listStoredChatOutboxes(resolved)).toEqual([
      {
        sessionKey: "global",
        agentId: "alpha",
        queue: [attemptedGlobal],
      },
    ]);
    expect(
      await removeStoredChatComposerQueueItem(resolved, "global", globalItem.id, attemptedGlobal),
    ).toBe(true);
    expect(listStoredChatOutboxes(resolved)).toEqual([]);
  });

  it("migrates an unknown bare main alias to the default agent", async () => {
    const offline = createState({
      agentsList: null,
      assistantAgentId: "work",
      chatMessage: "offline workspace draft",
      hello: null,
      sessionKey: "workspace",
    });
    const item = reconnectItem("offline-workspace", 1);
    expect(persistChatComposerState(offline)).toBe(true);
    const admission = captureChatOutboxAdmission(offline, offline.sessionKey, item.agentId);
    expect(await admitStoredChatComposerQueueItem(offline, admission, item)).toBe(true);

    const reconnected = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      assistantAgentId: "alpha",
      sessionKey: "global",
    });
    const defaultWork = { ...reconnected, assistantAgentId: "work" };
    await migrateLegacyChatOutboxMetadata(reconnected);
    expect(listStoredChatOutboxes(reconnected)).toEqual([
      {
        agentId: "work",
        queue: [{ ...item, agentId: "work", sessionKey: "global" }],
        sessionKey: "global",
      },
    ]);
    expect(loadChatComposerSnapshot(defaultWork, "global")).toEqual({
      draft: "offline workspace draft",
      queue: [{ ...item, agentId: "work", sessionKey: "global" }],
    });
    expect(loadChatComposerSnapshot(reconnected, "global")).toBeNull();
  });

  it("retains shipped bare main aliases for explicit destination confirmation", async () => {
    const sourceKey = legacyStorageKeyForGateway("ws://gateway.test/control");
    const item = reconnectItem("legacy-main", 1);
    sessionStorage.setItem(
      sourceKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "main\u0000agent:previous": { queue: [item], updatedAt: 1 },
        },
      }),
    );
    const host = createState({ agentsList: { defaultId: "work", mainKey: "main" } });
    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(readChatOutboxRecovery(host).entries[0]?.session.queue).toEqual([item]);
  });

  it("keeps an unknown non-main opaque route agentless", async () => {
    const state = createState({
      agentsList: null,
      assistantAgentId: "work",
      hello: null,
      sessionKey: "matrix:group:RoomCase",
    });
    const item = reconnectItem("opaque-room", 1);
    const admission = captureChatOutboxAdmission(state, state.sessionKey, item.agentId);
    expect(await admitStoredChatComposerQueueItem(state, admission, item)).toBe(true);

    expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue).toEqual([
      { ...item, sessionKey: state.sessionKey },
    ]);
    expect(listStoredChatOutboxes(state)).toEqual([
      {
        queue: [{ ...item, sessionKey: state.sessionKey }],
        sessionKey: state.sessionKey,
      },
    ]);
  });

  it("quarantines unattributed selected-agent opaque rows without choosing an owner", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    const sessionKey = "matrix:group:RoomCase";
    const first = reconnectItem("legacy-work", 1);
    const second = reconnectItem("legacy-alpha", 2);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          [`${sessionKey}\u0000agent:work`]: {
            draft: "older draft",
            queue: [first],
            updatedAt: 1,
          },
          [`${sessionKey}\u0000agent:alpha`]: {
            draft: "newer draft",
            queue: [second],
            updatedAt: 2,
          },
        },
      }),
    );
    const state = createState({ assistantAgentId: "alpha", sessionKey });

    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(
      readChatOutboxRecovery(state)
        .entries.flatMap((entry) => (entry.session.queue ?? []).map((item) => item.id))
        .toSorted(),
    ).toEqual([first.id, second.id].toSorted());
    expect(sessionStorage.getItem(storageKey)).toContain('"recovery"');
  });

  it("does not retarget an explicit agent when a custom main alias becomes known", async () => {
    const offline = createState({
      agentsList: null,
      assistantAgentId: "work",
      hello: null,
      sessionKey: "agent:main:workspace",
    });
    const item = reconnectItem("explicit-main-workspace", 1);
    const admission = captureChatOutboxAdmission(offline, offline.sessionKey, item.agentId);
    expect(await admitStoredChatComposerQueueItem(offline, admission, item)).toBe(true);

    const selectedWork = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      assistantAgentId: "work",
      sessionKey: "global",
    });
    expect(loadChatComposerSnapshot(selectedWork, "global")).toBeNull();
    const selectedMain = { ...selectedWork, assistantAgentId: "main" };
    await migrateLegacyChatOutboxMetadata(selectedMain);
    expect(loadChatComposerSnapshot(selectedMain, "global")?.queue).toEqual([
      { ...item, agentId: "main", sessionKey: "global" },
    ]);
  });

  it("retains an unknown custom-main clear until defaults can migrate it", async () => {
    const resolved = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      assistantAgentId: "work",
      chatMessage: "stale custom-main draft",
      sessionKey: "global",
    });
    const queued = reconnectItem("custom-main-queue", 1);
    expect(persistChatComposerState(resolved)).toBe(true);
    const queuedAdmission = captureChatOutboxAdmission(
      resolved,
      resolved.sessionKey,
      queued.agentId,
    );
    expect(await admitStoredChatComposerQueueItem(resolved, queuedAdmission, queued)).toBe(true);

    const offline = createState({
      agentsList: null,
      assistantAgentId: null,
      hello: null,
      sessionKey: "workspace",
    });
    expect(persistChatComposerState(offline)).toBe(true);
    for (let index = 0; index < 21; index += 1) {
      const sessionKey = `agent:custom-draft-${index}:thread`;
      expect(
        persistChatComposerState(
          createState({ chatMessage: `newer custom ordinary draft ${index}`, sessionKey }),
        ),
      ).toBe(true);
    }
    for (let index = 0; index < 19; index += 1) {
      const sessionKey = `agent:custom-capacity-${index}:thread`;
      expect(
        await admitStoredChatComposerQueueItem(
          createState({ sessionKey }),
          captureChatOutboxAdmission(createState({ sessionKey }), sessionKey),
          reconnectItem(`custom-clear-capacity-${index}`, index + 2),
        ),
      ).toBe(true);
    }
    for (let index = 0; index < 25; index += 1) {
      expect(
        persistChatComposerState(createState({ sessionKey: `agent:newer-clear-${index}:thread` })),
      ).toBe(true);
    }

    const gatewayUrl = offline.settings?.gatewayUrl;
    const storageKey = storageKeyForGateway(gatewayUrl);
    const stored = sessionStorage.getItem(storageKey);
    expect(stored).not.toBeNull();
    const freshStorage = createStorageMock();
    freshStorage.setItem(storageKey, stored!);
    vi.stubGlobal("sessionStorage", freshStorage);

    expect(await hydrateChatOutboxMetadata(resolved)).toBe(true);
    expect(loadChatComposerSnapshot(resolved, "global")).toEqual({
      draft: "",
      queue: [{ ...queued, agentId: "work", sessionKey: "global" }],
    });
    expect(listStoredChatOutboxes(resolved)).toHaveLength(20);
  });

  it("restores an agent-qualified custom main alias before defaults load", async () => {
    const connected = createState({
      agentsList: { defaultId: "work", mainKey: "workspace" },
      assistantAgentId: "work",
      chatMessage: "qualified custom-main draft",
      sessionKey: "agent:work:workspace",
    });
    const queued = reconnectItem("qualified-custom-main", 1);
    expect(persistChatComposerState(connected)).toBe(true);
    const queuedAdmission = captureChatOutboxAdmission(
      connected,
      connected.sessionKey,
      queued.agentId,
    );
    expect(await admitStoredChatComposerQueueItem(connected, queuedAdmission, queued)).toBe(true);

    const gatewayUrl = connected.settings?.gatewayUrl;
    const storageKey = storageKeyForGateway(gatewayUrl);
    const stored = sessionStorage.getItem(storageKey);
    expect(stored).not.toBeNull();
    const freshStorage = createStorageMock();
    freshStorage.setItem(storageKey, stored!);
    vi.stubGlobal("sessionStorage", freshStorage);

    const offline = createState({
      agentsList: null,
      assistantAgentId: null,
      hello: null,
      sessionKey: "agent:work:workspace",
    });
    expect(await hydrateChatOutboxMetadata(offline)).toBe(true);
    expect(loadChatComposerDraftRevision(offline, offline.sessionKey)).toBeGreaterThan(0);
    expect(resolveUiConversationIdentity(offline, offline.sessionKey)).toEqual({
      agentId: "work",
      sessionKey: "agent:work:workspace",
    });
    expect(loadChatComposerSnapshot(offline, offline.sessionKey)).toEqual({
      draft: "qualified custom-main draft",
      queue: [{ ...queued, agentId: "work", sessionKey: offline.sessionKey }],
    });

    const unrelatedRoute = "agent:work:project";
    expect(resolveUiConversationIdentity(offline, unrelatedRoute)).toEqual({
      agentId: "work",
      sessionKey: unrelatedRoute,
    });
    expect(loadChatComposerSnapshot(offline, unrelatedRoute)).toBeNull();
  });

  it("does not let bounded clear fences crowd out a live draft", async () => {
    for (let index = 0; index < 20; index += 1) {
      const sessionKey = `agent:clear-only-${index}:thread`;
      expect(persistChatComposerState(createState({ sessionKey }))).toBe(true);
    }

    const live = createState({
      chatMessage: "keep this live input",
      sessionKey: "agent:live-after-clears:thread",
    });
    expect(persistChatComposerState(live)).toBe(true);
    expect(loadChatComposerSnapshot(live, live.sessionKey)?.draft).toBe("keep this live input");
  });

  it("migrates unresolved global input only to the selected agent", async () => {
    const alpha = createState({ assistantAgentId: "alpha", sessionKey: "global" });
    const alphaItem = reconnectItem("alpha-existing", 1);
    const alphaAdmission = captureChatOutboxAdmission(alpha, "global", alphaItem.agentId);
    expect(await admitStoredChatComposerQueueItem(alpha, alphaAdmission, alphaItem)).toBe(true);

    const unresolved = createState({ agentsList: null, hello: null, sessionKey: "global" });
    const unresolvedItem = reconnectItem("selected-work", 2);
    const unresolvedAdmission = captureChatOutboxAdmission(
      unresolved,
      "global",
      unresolvedItem.agentId,
    );
    expect(
      await admitStoredChatComposerQueueItem(unresolved, unresolvedAdmission, unresolvedItem),
    ).toBe(true);

    const selectedWork = createState({
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main" },
      sessionKey: "global",
    });
    await migrateLegacyChatOutboxMetadata(selectedWork);
    expect(listStoredChatOutboxes(selectedWork)).toEqual([
      {
        sessionKey: "global",
        agentId: "alpha",
        queue: [{ ...alphaItem, sessionKey: "global", agentId: "alpha" }],
      },
      {
        sessionKey: "global",
        agentId: "work",
        queue: [{ ...unresolvedItem, sessionKey: "global", agentId: "work" }],
      },
    ]);
  });

  it("quarantines every unattributed input across shipped main and global buckets", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const storageKey = legacyStorageKeyForGateway(gatewayUrl);
    const first = Array.from({ length: 50 }, (_, index) =>
      reconnectItem(`canonical-${index}`, index),
    );
    const second = Array.from({ length: 50 }, (_, index) =>
      reconnectItem(`legacy-${index}`, 50 + index),
    );
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "global\u0000agent:work": { queue: first, updatedAt: 2 },
          "agent:work:main\u0000agent:work": { queue: second, updatedAt: 1 },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(
      readChatOutboxRecovery(state)
        .entries.flatMap((entry) => entry.session.queue ?? [])
        .map((item) => item.id),
    ).toEqual([...first, ...second].map((item) => item.id));
    expect(listStoredChatOutboxes(state)).toEqual([]);
  });

  it("retains an alias draft while quarantining an unattributed canonical queue", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    const item = reconnectItem("newer-queue", 2);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "global\u0000agent:work": { queue: [item], updatedAt: 2 },
          "agent:work:main\u0000agent:work": { draft: "keep this draft", updatedAt: 1 },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "global" });
    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(loadChatComposerSnapshot(state, "global")).toBeNull();
    expect(loadChatComposerSnapshot(state, "agent:work:main")?.draft).toBe("keep this draft");
    expect(readChatOutboxRecovery(state).entries[0]?.session.queue?.[0]?.id).toBe(item.id);
    expect(sessionStorage.getItem(storageKey)).toContain('"recovery"');
    expect(sessionStorage.getItem(legacyStorageKey)).toBeNull();
  });

  it("quarantines a shipped qualified-main alias before Gateway defaults load", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const item = reconnectItem("legacy-offline-reload", 1);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:work:main\u0000agent:work": {
            queue: [{ ...item, sessionKey: "agent:work:main", agentId: "work" }],
            updatedAt: 1,
          },
        },
      }),
    );

    const offline = createState({ sessionKey: "agent:work:main" });
    expect(await hydrateChatOutboxMetadata(offline)).toBe(true);
    const restored = { ...item, agentId: "work", sessionKey: "agent:work:main" };
    expect(loadChatComposerSnapshot(offline, "agent:work:main")?.queue).toBeUndefined();
    expect(readChatOutboxRecovery(offline).entries[0]?.session.queue).toEqual([restored]);
    expect(sessionStorage.getItem(storageKeyForGateway(gatewayUrl))).toContain('"recovery"');
  });

  it("does not guess between agent-scoped main outboxes before defaults load", async () => {
    const workItem = reconnectItem("work-offline", 1);
    const otherItem = reconnectItem("other-offline", 2);
    expect(
      await admitStoredChatComposerQueueItem(
        createState({ assistantAgentId: "work", sessionKey: "global" }),
        captureChatOutboxAdmission(
          createState({ assistantAgentId: "work", sessionKey: "global" }),
          "global",
          workItem.agentId,
        ),
        workItem,
      ),
    ).toBe(true);
    expect(
      await admitStoredChatComposerQueueItem(
        createState({ assistantAgentId: "other", sessionKey: "global" }),
        captureChatOutboxAdmission(
          createState({ assistantAgentId: "other", sessionKey: "global" }),
          "global",
          otherItem.agentId,
        ),
        otherItem,
      ),
    ).toBe(true);

    expect(loadChatComposerSnapshot(createState({ sessionKey: "main" }), "main")).toBeNull();
  });

  it("counts a cleared agent draft when deciding whether an offline main owner is unique", async () => {
    const staleAlpha = createState({
      assistantAgentId: "alpha",
      chatMessage: "stale alpha draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(staleAlpha)).toBe(true);
    const clearedWork = createState({
      assistantAgentId: "work",
      chatMessage: "work draft",
      sessionKey: "global",
    });
    expect(persistChatComposerState(clearedWork)).toBe(true);
    expect(persistChatComposerState({ ...clearedWork, chatMessage: "" })).toBe(true);

    expect(loadChatComposerSnapshot(createState({ sessionKey: "main" }), "main")).toBeNull();
  });

  it("does not expose an unresolved queue under a resolved owner before migration", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const unresolved = createState({
      chatMessage: "unresolved draft",
      sessionKey: "main",
    });
    const item = reconnectItem("unresolved-with-quota", 1);
    expect(persistChatComposerState(unresolved)).toBe(true);
    const admission = captureChatOutboxAdmission(unresolved, "main", item.agentId);
    expect(await admitStoredChatComposerQueueItem(unresolved, admission, item)).toBe(true);
    const resolved = createState({
      agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
      assistantAgentId: "work",
      sessionKey: "global",
    });
    expect(loadChatComposerSnapshot(unresolved, "main")).toEqual({
      draft: "unresolved draft",
      queue: [{ ...item, sessionKey: "main" }],
    });
    expect(loadChatComposerSnapshot(resolved, "global")).toEqual({
      draft: "unresolved draft",
      queue: [],
    });
  });

  it("shares configured bare and agent main aliases with global", async () => {
    const state = createState({
      agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
      sessionKey: "workspace",
    });
    const bare = reconnectItem("bare-configured", 1);
    const qualified = reconnectItem("qualified-configured", 2);
    const bareAdmission = captureChatOutboxAdmission(state, "workspace", bare.agentId);
    expect(await admitStoredChatComposerQueueItem(state, bareAdmission, bare)).toBe(true);
    const qualifiedAdmission = captureChatOutboxAdmission(
      state,
      "agent:work:workspace",
      qualified.agentId,
    );
    expect(await admitStoredChatComposerQueueItem(state, qualifiedAdmission, qualified)).toBe(true);

    expect(loadChatComposerSnapshot(state, "global")?.queue.map((item) => item.id)).toEqual([
      "bare-configured",
      "qualified-configured",
    ]);
  });

  it("quarantines shipped alias rows and consumes legacy tombstones", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:work:main\u0000agent:work": {
            draft: "legacy draft",
            queue: [
              reconnectItem("removed", 1),
              { ...reconnectItem("kept", 2), sessionKey: "agent:work:main", agentId: "work" },
            ],
            removedQueueItemIds: ["removed"],
            updatedAt: 1,
          },
        },
      }),
    );

    const state = createState({ assistantAgentId: "work", sessionKey: "agent:work:main" });
    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(loadChatComposerSnapshot(state, "agent:work:main")).toEqual({
      draft: "legacy draft",
      queue: [],
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session.queue?.[0]?.id).toBe("kept");
    state.chatMessage = "updated draft";
    persistChatComposerState(state);
    expect(sessionStorage.getItem(storageKey)).not.toContain("removedQueueItemIds");
    expect(sessionStorage.getItem(legacyStorageKey)).toBeNull();
  });

  it("lists inactive outboxes for explicit reconnect routing", async () => {
    const state = createState();
    const older = reconnectItem("inactive-a", 1);
    const newer = reconnectItem("inactive-b", 2);
    const olderAdmission = captureChatOutboxAdmission(state, "agent:alpha:thread:1", older.agentId);
    expect(await admitStoredChatComposerQueueItem(state, olderAdmission, older)).toBe(true);
    const newerAdmission = captureChatOutboxAdmission(state, "agent:beta:thread:2", newer.agentId);
    expect(await admitStoredChatComposerQueueItem(state, newerAdmission, newer)).toBe(true);

    expect(listStoredChatOutboxes(state)).toEqual([
      {
        sessionKey: "agent:alpha:thread:1",
        agentId: "alpha",
        queue: [
          {
            ...older,
            sessionKey: "agent:alpha:thread:1",
            agentId: "alpha",
          },
        ],
      },
      {
        sessionKey: "agent:beta:thread:2",
        agentId: "beta",
        queue: [
          {
            ...newer,
            sessionKey: "agent:beta:thread:2",
            agentId: "beta",
          },
        ],
      },
    ]);
  });

  it("normalizes interrupted and in-flight states before durable replay", async () => {
    const state = createState();
    const sending: ChatQueueItem = {
      ...reconnectItem("sending", 1),
      sendState: "sending",
    };
    const waitingModel: ChatQueueItem = {
      ...reconnectItem("waiting-model", 2),
      sendState: "waiting-model",
      sendError: "previous attempt failed",
    };
    const executingCommand: ChatQueueItem = {
      ...reconnectItem("executing-command", 3),
      sendState: "executing-command",
    };
    const sendingAdmission = captureChatOutboxAdmission(state, state.sessionKey, sending.agentId);
    expect(await admitStoredChatComposerQueueItem(state, sendingAdmission, sending)).toBe(true);
    const waitingModelAdmission = captureChatOutboxAdmission(
      state,
      state.sessionKey,
      waitingModel.agentId,
    );
    expect(await admitStoredChatComposerQueueItem(state, waitingModelAdmission, waitingModel)).toBe(
      true,
    );
    const executingCommandAdmission = captureChatOutboxAdmission(
      state,
      state.sessionKey,
      executingCommand.agentId,
    );
    expect(
      await admitStoredChatComposerQueueItem(state, executingCommandAdmission, executingCommand),
    ).toBe(true);

    vi.stubGlobal("sessionStorage", createStorageMock());
    await hydrateChatOutboxMetadata(state);

    expect(loadChatComposerSnapshot(state, state.sessionKey)?.queue).toEqual([
      { ...sending, sendState: "waiting-reconnect", sessionKey: state.sessionKey, agentId: "lily" },
      {
        ...waitingModel,
        sendState: "failed",
        sendError: "Chat settings update was interrupted. Review and retry when ready.",
        sessionKey: state.sessionKey,
        agentId: "lily",
      },
      {
        ...executingCommand,
        sendState: "unconfirmed",
        sessionKey: state.sessionKey,
        agentId: "lily",
      },
    ]);
  });

  it("scopes composer state and outboxes by gateway", async () => {
    const state = createState({ chatMessage: "gateway-local draft" });
    persistChatComposerState(state);
    await admitStoredChatComposerQueueItem(
      state,
      captureChatOutboxAdmission(state, state.sessionKey),
      reconnectItem("gateway-local", 1),
    );
    const otherGateway = createState({
      settings: { gatewayUrl: "ws://other-gateway.test/control" },
    });

    expect(loadChatComposerSnapshot(otherGateway, otherGateway.sessionKey)).toBeNull();
    expect(listStoredChatOutboxes(otherGateway)).toEqual([]);
  });

  it("isolates long same-prefix gateways in owner-tagged v4 buckets", async () => {
    const sharedPrefix = `wss://gateway.test/${"a".repeat(260)}`;
    const firstGatewayUrl = `${sharedPrefix}?route=first`;
    const secondGatewayUrl = `${sharedPrefix}?route=second`;
    expect(legacyStorageKeyForGateway(firstGatewayUrl)).toBe(
      legacyStorageKeyForGateway(secondGatewayUrl),
    );
    expect(storageKeyForGateway(firstGatewayUrl)).not.toBe(storageKeyForGateway(secondGatewayUrl));

    const first = createState({
      chatMessage: "first gateway draft",
      settings: { gatewayUrl: firstGatewayUrl },
    });
    const second = createState({
      chatMessage: "second gateway draft",
      settings: { gatewayUrl: secondGatewayUrl },
    });
    const firstItem = reconnectItem("first-long-gateway", 1);
    const secondItem = reconnectItem("second-long-gateway", 2);
    expect(persistChatComposerState(first)).toBe(true);
    const firstAdmission = captureChatOutboxAdmission(first, first.sessionKey, firstItem.agentId);
    expect(await admitStoredChatComposerQueueItem(first, firstAdmission, firstItem)).toBe(true);
    expect(persistChatComposerState(second)).toBe(true);
    const secondAdmission = captureChatOutboxAdmission(
      second,
      second.sessionKey,
      secondItem.agentId,
    );
    expect(await admitStoredChatComposerQueueItem(second, secondAdmission, secondItem)).toBe(true);

    expect(loadChatComposerSnapshot(first, first.sessionKey)).toEqual({
      draft: "first gateway draft",
      queue: [{ ...firstItem, agentId: "lily", sessionKey: first.sessionKey }],
    });
    expect(loadChatComposerSnapshot(second, second.sessionKey)).toEqual({
      draft: "second gateway draft",
      queue: [{ ...secondItem, agentId: "lily", sessionKey: second.sessionKey }],
    });
    for (const gatewayUrl of [firstGatewayUrl, secondGatewayUrl]) {
      const stored = JSON.parse(sessionStorage.getItem(storageKeyForGateway(gatewayUrl)) ?? "{}");
      expect(stored).toMatchObject({ gatewayOwner: gatewayUrl, version: 4 });
    }
  });

  it("does not replay an exact-240 legacy key to a longer same-prefix gateway", async () => {
    const prefix = "wss://gateway.test/";
    const exactGatewayUrl = `${prefix}${"a".repeat(240 - encodeURIComponent(prefix).length)}`;
    const longerGatewayUrl = `${exactGatewayUrl}b`;
    expect(encodeURIComponent(exactGatewayUrl)).toHaveLength(240);
    expect(legacyStorageKeyForGateway(exactGatewayUrl)).toBe(
      legacyStorageKeyForGateway(longerGatewayUrl),
    );
    const item = reconnectItem("ambiguous-legacy-owner", 1);
    sessionStorage.setItem(
      legacyStorageKeyForGateway(exactGatewayUrl),
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:lily:main\u0000agent:lily": { queue: [item], updatedAt: 1 },
        },
      }),
    );

    for (const gatewayUrl of [exactGatewayUrl, longerGatewayUrl]) {
      const state = createState({ settings: { gatewayUrl } });
      expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
      expect(listStoredChatOutboxes(state)).toEqual([]);
      expect(sessionStorage.getItem(storageKeyForGateway(gatewayUrl))).toBeNull();
    }
  });

  it("quarantines an unattributed shipped v1 queue while retaining its draft", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const legacyStorageKey = legacyStorageKeyForGateway(gatewayUrl);
    const storageKey = storageKeyForGateway(gatewayUrl);
    const item = reconnectItem("legacy-short-gateway", 1);
    sessionStorage.setItem(
      legacyStorageKey,
      JSON.stringify({
        version: 1,
        sessions: {
          "agent:lily:main\u0000agent:lily": {
            draft: "shipped gateway draft",
            queue: [item],
            updatedAt: 1,
          },
        },
      }),
    );
    const state = createState({ settings: { gatewayUrl } });

    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(loadChatComposerSnapshot(state, state.sessionKey)).toEqual({
      draft: "shipped gateway draft",
      queue: [],
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session.queue?.[0]?.id).toBe(item.id);
    expect(sessionStorage.getItem(legacyStorageKey)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "{}")).toMatchObject({
      gatewayOwner: gatewayUrl,
      version: 4,
      recovery: {},
    });
  });

  it("keeps readable outboxes available when later storage writes fail", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const state = createState();
    const item = reconnectItem("readable-after-quota", 1);
    const admission = captureChatOutboxAdmission(state, state.sessionKey, item.agentId);
    expect(await admitStoredChatComposerQueueItem(state, admission, item)).toBe(true);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    expect(listStoredChatOutboxes(state)).toEqual([
      {
        sessionKey: "agent:lily:main",
        agentId: "lily",
        queue: [{ ...item, sessionKey: "agent:lily:main", agentId: "lily" }],
      },
    ]);
  });

  it("rejects an admission when its Gateway changes during hydration", async () => {
    const state = createState({ settings: { gatewayUrl: "ws://gateway-a.test" } });
    const item = reconnectItem("gateway-switch", 1);
    const admission = captureChatOutboxAdmission(state, state.sessionKey, item.agentId);
    const pending = admitStoredChatComposerQueueItem(state, admission, item);

    state.settings!.gatewayUrl = "ws://gateway-b.test";

    expect(await pending).toBe(false);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(
      listStoredChatOutboxes({ ...state, settings: { gatewayUrl: "ws://gateway-a.test" } }),
    ).toEqual([]);
  });

  it("keeps durable queues isolated across recovery owners on one Gateway", async () => {
    const ownerA = createState({
      client: { recoveryScope: "owner-a", recoveryScopeReady: true },
      connected: true,
    });
    const item = reconnectItem("credential-isolation", 1);
    const admission = captureChatOutboxAdmission(ownerA, ownerA.sessionKey, item.agentId);
    expect(await admitStoredChatComposerQueueItem(ownerA, admission, item)).toBe(true);

    const ownerB = createState({
      client: { recoveryScope: "owner-b", recoveryScopeReady: true },
      connected: true,
    });
    await hydrateChatOutboxMetadata(ownerB);

    expect(listStoredChatOutboxes(ownerB)).toEqual([]);
    expect(listStoredChatOutboxes(ownerA)[0]?.queue).toEqual([
      expect.objectContaining({ id: item.id }),
    ]);
  });

  it("quarantines an unresolved durable queue when a credential owner appears", async () => {
    const unresolved = createState({ client: null, connected: false });
    const item = reconnectItem("unresolved-credential", 1);
    const admission = captureChatOutboxAdmission(unresolved, unresolved.sessionKey, item.agentId);
    expect(admission.recoveryOwner).toBeUndefined();
    expect(await admitStoredChatComposerQueueItem(unresolved, admission, item)).toBe(true);

    const authenticated = createState({
      client: { recoveryScope: "owner-b", recoveryScopeReady: true },
      connected: true,
    });
    await hydrateChatOutboxMetadata(authenticated);

    expect(listStoredChatOutboxes(authenticated)).toEqual([]);
    expect(readChatOutboxRecovery(authenticated).entries[0]?.session.queue).toEqual([
      expect.objectContaining({ id: item.id }),
    ]);
  });

  it("leaves a foreign-tab legacy attachment queue for its source tab", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const targetOwner = gatewayOwner(gatewayUrl);
    const item = {
      ...reconnectItem("foreign-legacy-owner", 1),
      attachmentPayload: {
        key: "foreign-payload",
        recoveryScope: "owner-a",
        tabId: "source-tab",
      },
    };
    sessionStorage.setItem(
      storageKeyForGateway(gatewayUrl),
      JSON.stringify({
        version: 4,
        gatewayOwner: targetOwner,
        recovery: {},
        sessions: {
          "agent:lily:main\u0000agent:lily": {
            queue: [item],
            updatedAt: 1,
          },
        },
      }),
    );
    const ownerB = createState({
      client: { recoveryScope: "owner-b", recoveryScopeReady: true },
      connected: true,
      settings: { gatewayUrl },
    });
    await hydrateChatOutboxMetadata(ownerB);
    expect(listStoredChatOutboxes(ownerB)).toEqual([]);
    expect(sessionStorage.getItem(storageKeyForGateway(gatewayUrl))).toContain(item.id);

    const ownerA = createState({
      client: { recoveryScope: "owner-a", recoveryScopeReady: true },
      connected: true,
      settings: { gatewayUrl },
    });
    await hydrateChatOutboxMetadata(ownerA);
    expect(listStoredChatOutboxes(ownerA)).toEqual([]);
    expect(sessionStorage.getItem(storageKeyForGateway(gatewayUrl))).toContain(item.id);
  });

  it("prefers a same-version shutdown journal carrying complete attachment bytes", async () => {
    const gatewayUrl = "ws://gateway.test/control";
    const owner = "owner-a";
    const state = createState({
      client: { recoveryScope: owner, recoveryScopeReady: true },
      connected: true,
      settings: { gatewayUrl },
    });
    const tabId = await outboxPayloadTab();
    const key = JSON.stringify([gatewayOwner(gatewayUrl), tabId, owner]);
    const scopeKey = "agent:lily:main\u0000agent:lily";
    const item: ChatQueueItem = {
      ...reconnectItem("journal-attachment", 1),
      attachments: [
        { id: "attachment", mimeType: "text/plain", fileName: "proof.txt", sizeBytes: 5 },
      ],
      sessionKey: state.sessionKey,
      agentId: "lily",
    };
    const database = await openControlUiDatabase();
    const transaction = database.transaction("chatOutboxes", "readwrite");
    transaction.objectStore("chatOutboxes").put({
      key,
      version: 1,
      gatewayOwner: gatewayOwner(gatewayUrl),
      recoveryOwner: owner,
      tabId,
      sessions: { [scopeKey]: { queue: [item], updatedAt: 1 } },
    });
    await transactionComplete(transaction);
    const journalKey = `openclaw.control.chatPending.v1:${encodeURIComponent(gatewayOwner(gatewayUrl))}:${encodeURIComponent(owner)}:${encodeURIComponent(tabId)}`;
    journalStorage.setItem(
      journalKey,
      JSON.stringify({
        version: 1,
        gatewayOwner: gatewayOwner(gatewayUrl),
        recoveryOwner: owner,
        tabId,
        sessions: {
          [scopeKey]: {
            queue: [
              {
                ...item,
                attachments: [
                  {
                    ...item.attachments![0],
                    dataUrl: "data:text/plain;base64,cHJvb2Y=",
                  },
                ],
              },
            ],
            updatedAt: 1,
          },
        },
      }),
    );
    expect(journalStorage.getItem(journalKey)).toContain("journal-attachment");

    await hydrateChatOutboxMetadata(state);

    expect(listStoredChatOutboxes(state)[0]?.queue[0]?.attachments?.[0]?.dataUrl).toBe(
      "data:text/plain;base64,cHJvb2Y=",
    );
    expect(journalStorage.getItem(journalKey)).toBeNull();
  });

  it("retries a failed draft write when stopping", async () => {
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    let writes = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const state = createState();
    const persistence = new ChatComposerPersistence(() => state);
    persistence.start();
    state.chatMessage = "retry this write";

    persistence.persistNow();
    persistence.stop();

    expect(writes).toBe(2);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("retry this write");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
