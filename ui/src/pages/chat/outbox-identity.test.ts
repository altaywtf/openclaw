// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateChatOutboxMetadata } from "../../lib/chat/outbox-metadata-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { readQueuedMessageById, removeQueuedMessage, updateQueuedMessage } from "./chat-queue.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  loadChatComposerSnapshot,
  persistChatComposerState,
  updateStoredChatComposerQueueItem,
  removeStoredChatComposerQueueItem,
} from "./composer-persistence.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

const gatewayUrl = "ws://outbox.test";
const state = {
  settings: { gatewayUrl },
  assistantAgentId: "selected",
  agentsList: { defaultId: "default", mainKey: "workspace", scope: "per-sender" },
  sessionKey: "agent:default:workspace",
  chatMessage: "draft",
  chatQueue: [],
};

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => vi.unstubAllGlobals());

describe("outbox destination identity", () => {
  it.each([
    ["main", "agent:default:workspace", "default"],
    ["workspace", "agent:default:workspace", "default"],
    ["agent:other:main", "agent:other:workspace", "other"],
    ["agent:other:workspace", "agent:other:workspace", "other"],
    ["global", "global", "selected"],
    ["agent:other:global", "agent:other:global", "other"],
    ["agent:bad agent:notes", "agent:bad agent:notes", "bad-agent"],
    [
      "agent:other:matrix:channel:!AbC:example.org",
      "agent:other:matrix:channel:!AbC:example.org",
      "other",
    ],
  ])(
    "retains %s through admission, reload, and a selected-agent change",
    async (input, sessionKey, agentId) => {
      const host = { ...state, sessionKey: input };
      expect(persistChatComposerState(host)).toBe(true);
      expect(
        await admitStoredChatComposerQueueItem(host, captureChatOutboxAdmission(host, input), {
          id: "queued",
          text: "follow up",
          createdAt: 1,
          sendState: "waiting-idle",
        }),
      ).toBe(true);
      const reloaded = { ...state, assistantAgentId: "different" };
      expect(listStoredChatOutboxes(reloaded)).toEqual([
        {
          sessionKey,
          agentId,
          queue: [
            {
              id: "queued",
              text: "follow up",
              createdAt: 1,
              sendState: "waiting-idle",
              sessionKey,
              agentId,
            },
          ],
        },
      ]);
      expect(loadChatComposerSnapshot(reloaded, sessionKey, agentId)?.draft).toBe("draft");
    },
  );

  it("maps main aliases to global only under configured global scope", async () => {
    const host = { ...state, agentsList: { ...state.agentsList, scope: "global" } };
    expect(resolveUiConversationIdentity(host, "main")).toEqual({
      sessionKey: "global",
      agentId: "default",
    });
    expect(resolveUiConversationIdentity(host, "agent:other:workspace")).toEqual({
      sessionKey: "global",
      agentId: "other",
    });
  });

  it("never restores a sole global agent draft into unresolved main", async () => {
    expect(persistChatComposerState({ ...state, sessionKey: "global" })).toBe(true);
    expect(loadChatComposerSnapshot({ settings: { gatewayUrl } }, "main")).toBeNull();
  });

  it("does not replay collapsed v2 global data using today's selected agent or main key", async () => {
    sessionStorage.setItem(
      `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayUrl)}`,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "global\u0000agent:selected": {
            draft: "lost destination",
            draftRevision: 8,
            updatedAt: 8,
            queue: [
              {
                id: "uncertain",
                text: "possibly sent",
                createdAt: 1,
                sessionKey: "global",
                agentId: "selected",
                sendRunId: "original-attempt",
                sendAttempts: 1,
                sendState: "unconfirmed",
              },
            ],
          },
        },
      }),
    );
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(loadChatComposerSnapshot(state, "global")).toBeNull();
  });
});

describe("outbox browser-state transfer", () => {
  const seed = (version: 1 | 2 | 3, sessions: Record<string, unknown>) => {
    const key = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
    const raw = JSON.stringify({ version, gatewayOwner: gatewayUrl, sessions });
    sessionStorage.setItem(key, raw);
    return { key, raw };
  };
  const queue = Array.from({ length: 60 }, (_, i) => ({
    id: `saved-${i}`,
    text: `message ${i}`,
    createdAt: i + 1,
    sendRunId: `attempt-${i}`,
    sendAttempts: i === 0 ? 1 : 0,
    sendState: i === 0 ? "unconfirmed" : "waiting-reconnect",
    attachments: [
      { id: `attachment-${i}`, mimeType: "text/plain", dataUrl: "data:text/plain;base64,YQ==" },
    ],
  }));
  const legacy = {
    draft: "saved objective",
    goalMode: { action: "start" },
    draftRevision: 42,
    updatedAt: 50,
    queue,
  };

  it("quarantines v1 literal global separately from qualified main", async () => {
    const source = seed(1, {
      "global\u0000agent:selected": legacy,
      "agent:selected:main\u0000agent:selected": { ...legacy, queue: [queue[0]] },
    });
    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(
      readChatOutboxRecovery(state)
        .entries.map((entry) => entry.sourceScopeKey)
        .toSorted(),
    ).toEqual(["agent:selected:main\u0000agent:selected", "global\u0000agent:selected"]);
    expect(sessionStorage.getItem(source.key)).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key)!).sessions[
        "global\u0000agent:selected"
      ].draftRevision,
    ).toBe(42);
  });

  it("retains every collapsed entry unsent and restores it only into an explicitly confirmed empty destination", async () => {
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const [entry] = readChatOutboxRecovery(state).entries;
    expect(entry?.session).toEqual(legacy);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: "agent:selected:review",
      agentId: "selected",
    })!;
    expect(await restoreChatOutboxRecovery(state, entry!, destination)).toBe("restored");
    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(readChatOutboxRecovery(state).entries).toEqual([]);
    const restored = listStoredChatOutboxes(state)[0]!;
    expect(restored.queue).toHaveLength(60);
    expect(
      restored.queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]),
    ).toEqual(queue.map((item) => [item.id, item.sendRunId, item.sendAttempts, item.attachments]));
    expect(restored.queue[0]?.sendState).toBe("unconfirmed");
    expect(restored.queue.slice(1).every((item) => item.sendState === "failed")).toBe(true);
    expect(loadChatComposerSnapshot(state, restored.sessionKey)?.goalMode).toEqual({
      action: "start",
    });
    expect(sessionStorage.getItem(source.key)).toBeNull();
    expect(await restoreChatOutboxRecovery(state, entry!, destination)).toBe("conflict");
  });

  it.each(
    ([1, 2, 3] as const).flatMap((version) =>
      ["quota", "noop"].map((failure) => ({ version, failure })),
    ),
  )("keeps v$version source bytes when migration writes $failure", ({ version, failure }) => {
    const source = seed(version, { "main\u0000agent:selected": legacy });
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      if (failure === "quota") {
        throw new DOMException("quota", "QuotaExceededError");
      }
    });
    expect(readChatOutboxRecovery(state).entries[0]?.session.queue).toHaveLength(60);
    expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    write.mockRestore();
    expect(readChatOutboxRecovery(state).entries).toHaveLength(1);
    expect(sessionStorage.getItem(source.key)).toBeNull();
  });

  it("does not overwrite a newer destination edit or remove its recoverable source", async () => {
    seed(2, { "global\u0000agent:selected": legacy });
    const entry = readChatOutboxRecovery(state).entries[0]!;
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: state.sessionKey,
      agentId: "default",
    })!;
    expect(persistChatComposerState({ ...state, chatMessage: "newer input" })).toBe(true);
    expect(await restoreChatOutboxRecovery(state, entry, destination)).toBe("conflict");
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("newer input");
    expect(readChatOutboxRecovery(state).entries[0]).toEqual(entry);
  });

  it.each([1, 2, 3] as const)(
    "retains later v%i writes for review after the current namespace exists",
    async (version) => {
      const source = seed(version, { "main\u0000agent:selected": legacy });
      const first = readChatOutboxRecovery(state).entries[0]!;
      const later = { ...legacy, draft: "written after downgrade", draftRevision: 99 };
      seed(version, { "main\u0000agent:selected": later });
      const entries = readChatOutboxRecovery(state).entries;
      expect(entries.map((entry) => entry.session.draft)).toEqual([
        first.session.draft,
        "written after downgrade",
      ]);
      expect(listStoredChatOutboxes(state)).toEqual([]);
      expect(sessionStorage.getItem(source.key)).toBeNull();
    },
  );

  it.each([1, 2, 3] as const)(
    "does not reimport an acknowledged v%i source when legacy deletion failed",
    async (version) => {
      const source = seed(version, { "main\u0000agent:selected": legacy });
      const remove = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {});
      const entry = readChatOutboxRecovery(state).entries[0]!;
      const destination = captureChatOutboxRecoveryDestination(state, {
        sessionKey: state.sessionKey,
        agentId: "default",
      })!;
      expect(await restoreChatOutboxRecovery(state, entry, destination)).toBe("restored");
      expect(await hydrateChatOutboxMetadata(state)).toBe(true);
      expect(sessionStorage.getItem(source.key)).toBe(source.raw);
      expect(readChatOutboxRecovery(state).entries).toEqual([]);
      expect(listStoredChatOutboxes(state)[0]?.queue).toHaveLength(60);
      remove.mockRestore();
    },
  );

  it("keeps full recovery usable while a later source waits intact for space", async () => {
    const target = storageTargetForGateway(gatewayUrl);
    sessionStorage.setItem(
      target.key,
      JSON.stringify({
        version: 4,
        gatewayOwner: gatewayUrl,
        sessions: {},
        recovery: Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [
            `old-${i}`,
            {
              sourceVersion: 2,
              sourceScopeKey: `old-${i}`,
              session: { draft: `draft ${i}`, draftRevision: i + 1, updatedAt: i + 1 },
            },
          ]),
        ),
      }),
    );
    const source = seed(2, { "global\u0000agent:selected": legacy });
    const recovery = readChatOutboxRecovery(state);
    expect(recovery.blocked).toBe(true);
    expect(recovery.entries).toHaveLength(80);
    expect(sessionStorage.getItem(source.key)).toBe(source.raw);
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: state.sessionKey,
      agentId: "default",
    })!;
    expect(await restoreChatOutboxRecovery(state, recovery.entries[0]!, destination)).toBe(
      "restored",
    );
    const resumed = readChatOutboxRecovery(state);
    expect(resumed.blocked).toBe(false);
    expect(resumed.entries).toHaveLength(80);
    expect(resumed.entries.at(-1)?.session).toEqual(legacy);
    expect(loadChatComposerSnapshot(state, state.sessionKey)?.draft).toBe("draft 0");
    expect(sessionStorage.getItem(source.key)).toBeNull();
  });

  it("leaves recovery intact on failed transfer and current reopen", async () => {
    seed(2, { "global\u0000agent:selected": legacy });
    const entry = readChatOutboxRecovery(state).entries[0]!;
    const destination = captureChatOutboxRecoveryDestination(state, {
      sessionKey: state.sessionKey,
      agentId: "default",
    })!;
    const source = sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key);
    const write = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(await restoreChatOutboxRecovery(state, entry, destination)).toBe("storage-failed");
    expect(sessionStorage.getItem(storageTargetForGateway(gatewayUrl).key)).toBe(source);
    write.mockRestore();
    const reopened = createStorageMock();
    reopened.setItem(storageTargetForGateway(gatewayUrl).key, source!);
    vi.stubGlobal("sessionStorage", reopened);
    expect(readChatOutboxRecovery(state).entries[0]).toEqual(entry);
    expect(listStoredChatOutboxes(state)).toEqual([]);
  });
});

describe("partially preserved legacy identity", () => {
  it("quarantines independently targeted and ambiguous unattributed legacy items", async () => {
    sessionStorage.setItem(
      storageTargetForGateway(gatewayUrl).previousKey,
      JSON.stringify({
        version: 2,
        gatewayOwner: gatewayUrl,
        sessions: {
          "global\u0000agent:selected": {
            draft: "ambiguous draft",
            updatedAt: 1,
            queue: [
              {
                id: "exact",
                text: "qualified",
                createdAt: 1,
                sessionKey: "agent:other:thread",
                agentId: "other",
                sendAttempts: 1,
                sendRunId: "original",
                sendState: "unconfirmed",
              },
              { id: "ambiguous", text: "collapsed", createdAt: 2, sessionKey: "global" },
            ],
          },
        },
      }),
    );
    expect(await hydrateChatOutboxMetadata(state)).toBe(true);
    expect(listStoredChatOutboxes(state)).toEqual([]);
    const recovery = readChatOutboxRecovery(state).entries;
    expect(recovery.some((entry) => entry.session.draft === "ambiguous draft")).toBe(true);
    expect(
      recovery.flatMap((entry) => (entry.session.queue ?? []).map((item) => item.id)).toSorted(),
    ).toEqual(["ambiguous", "exact"]);
  });
});

describe("captured outbox scope review regressions", () => {
  it("keeps only row data when a durable row becomes a local model wait", async () => {
    const host = { ...state, hello: null };
    const admission = captureChatOutboxAdmission(host, host.sessionKey);
    const item = { id: "model-wait", text: "keep target", createdAt: 1 };
    expect(await admitStoredChatComposerQueueItem(host, admission, item)).toBe(true);
    const stored = listStoredChatOutboxes(host)[0]!.queue[0]!;

    await updateQueuedMessage(host, item.id, (current) => ({
      ...current,
      sendState: "waiting-model",
    }));

    expect(readQueuedMessageById(host, item.id)).toEqual({ ...stored, sendState: "waiting-model" });
    expect(await removeQueuedMessage(host, item.id)).toBe("removed");
    expect(host.chatQueue).toEqual([]);
    expect(readQueuedMessageById(host, item.id)).toBeNull();
  });
  it("verifies the admitted queue target when a notification changes defaults", async () => {
    const host = { ...state, agentsList: { ...state.agentsList } };
    const unsubscribe = subscribeStoredChatOutboxChanges(() => {
      host.agentsList.mainKey = "changed";
    });
    try {
      const item = { id: "captured-admission", text: "keep target", createdAt: 1 };
      const admitted = await admitStoredChatComposerQueueItem(
        host,
        captureChatOutboxAdmission(host, "main"),
        item,
      );
      expect(listStoredChatOutboxes(host)).toEqual([
        {
          sessionKey: state.sessionKey,
          agentId: "default",
          queue: [{ ...item, sessionKey: state.sessionKey, agentId: "default" }],
        },
      ]);
      expect(admitted).toBe(true);
    } finally {
      unsubscribe();
    }
  });
  it("updates and removes an enumerated captured scope after mainKey changes", async () => {
    const initial = {
      ...state,
      sessionKey: "agent:main:main",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    };
    expect(
      await admitStoredChatComposerQueueItem(
        initial,
        captureChatOutboxAdmission(initial, initial.sessionKey),
        {
          id: "captured",
          text: "keep target",
          createdAt: 1,
        },
      ),
    ).toBe(true);
    const changed = { ...initial, agentsList: { ...initial.agentsList, mainKey: "workspace" } };
    const original = listStoredChatOutboxes(changed)[0]!;
    const item = original.queue[0]!;
    const next = {
      ...item,
      sendState: "unconfirmed" as const,
      sendAttempts: 1,
      sendRunId: "captured-attempt",
    };
    expect(
      await updateStoredChatComposerQueueItem(changed, original.sessionKey, item, next, "other"),
    ).toBe(false);
    await removeStoredChatComposerQueueItem(changed, original.sessionKey, item.id, item, "other");
    expect(listStoredChatOutboxes(changed)).toEqual([original]);
    expect(
      await updateStoredChatComposerQueueItem(
        changed,
        original.sessionKey,
        item,
        next,
        original.agentId,
      ),
    ).toBe(true);
    expect(listStoredChatOutboxes(changed)[0]).toMatchObject({
      sessionKey: initial.sessionKey,
      queue: [next],
    });
    expect(
      await removeStoredChatComposerQueueItem(
        changed,
        original.sessionKey,
        item.id,
        next,
        original.agentId,
      ),
    ).toBe(true);
    expect(listStoredChatOutboxes(changed)).toEqual([]);
  });
  it.each(["bucket", "item"])(
    "quarantines conflicting %s agent facts in legacy state",
    (conflict) => {
      const scopeKey = `agent:main:notes\u0000agent:${conflict === "bucket" ? "work" : "main"}`;
      sessionStorage.setItem(
        storageTargetForGateway(gatewayUrl).legacyKey,
        JSON.stringify({
          version: 1,
          sessions: {
            [scopeKey]: {
              updatedAt: 1,
              queue: [
                {
                  id: "conflicting",
                  text: "preserve me",
                  createdAt: 1,
                  sessionKey: "agent:main:notes",
                  agentId: "work",
                },
              ],
            },
          },
        }),
      );
      expect(listStoredChatOutboxes(state)).toEqual([]);
      expect(readChatOutboxRecovery(state).entries[0]?.session.queue?.[0]).toMatchObject({
        id: "conflicting",
        agentId: "work",
        sessionKey: "agent:main:notes",
      });
    },
  );
});
