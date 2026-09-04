import { getSafeSessionStorage } from "../../local-storage.ts";
import { resolveUiConversationIdentity } from "../sessions/session-key.ts";
import { compareChatQueueOrder } from "./chat-queue-order.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import {
  readChatOutboxMetadata,
  readUnresolvedChatOutboxMetadata,
} from "./outbox-metadata-store.runtime.ts";
import { outboxPayloadMatchesOwner } from "./outbox-payload-store.runtime.ts";
import type { StoredComposerSession } from "./outbox-store-codec.ts";
import {
  readProjectedOutboxStore,
  parseStoredChatOutboxScope,
  resolvePendingComposerSessions,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type StoredComposerState,
  type StoredChatOutboxScope,
} from "./outbox-store.ts";

export { subscribeStoredChatOutboxChanges };

export type StoredChatOutbox = StoredChatOutboxScope & { queue: ChatQueueItem[] };

function listStoredComposerRows(
  state: ChatComposerScope,
): Array<{ scope: StoredChatOutboxScope; session: StoredComposerSession }> {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return [];
  }
  try {
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readProjectedOutboxStore(storage, target);
    if (resolvePendingComposerSessions(store, state)) {
      try {
        writeStoredOutboxStore(storage, target, store);
      } catch {
        // Readable pending records remain intact if quota blocks their transfer.
      }
    }
    return Object.entries(store.sessions).flatMap(([key, session]) => {
      const scope = parseStoredChatOutboxScope(key);
      return scope
        ? [
            {
              scope,
              session: {
                ...session,
                queue: session.queue?.filter((item) => outboxPayloadMatchesOwner(state, item)),
              },
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

export function listAllStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  const stores = [readUnresolvedChatOutboxMetadata(state), readChatOutboxMetadata(state)].filter(
    (store): store is StoredComposerState => store !== null,
  );
  if (!stores.length) {
    return [];
  }
  const sessions = new Map<string, ChatQueueItem[]>();
  for (const store of stores) {
    for (const [key, session] of Object.entries(store.sessions)) {
      const byId = new Map((sessions.get(key) ?? []).map((item) => [item.id, item]));
      for (const item of session.queue ?? []) {
        byId.set(item.id, item);
      }
      sessions.set(key, [...byId.values()]);
    }
  }
  return [...sessions]
    .flatMap(([key, session]) => {
      const scope = parseStoredChatOutboxScope(key);
      return scope ? [{ scope, queue: session }] : [];
    })
    .flatMap(({ scope, queue }) =>
      queue.length
        ? [
            {
              ...scope,
              queue: queue.toSorted(compareChatQueueOrder),
            },
          ]
        : [],
    )
    .toSorted(
      (left, right) =>
        (left.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) -
          (right.queue[0]?.createdAt ?? Number.MAX_SAFE_INTEGER) ||
        left.sessionKey.localeCompare(right.sessionKey),
    );
}

export function listStoredChatOutboxes(state: ChatComposerScope): StoredChatOutbox[] {
  return listAllStoredChatOutboxes(state).flatMap((outbox) => {
    const queue = outbox.queue.filter((item) => outboxPayloadMatchesOwner(state, item));
    return queue.length ? [{ ...outbox, queue }] : [];
  });
}

export function summarizeStoredChatOutboxes(state: ChatComposerScope) {
  const idsByScope = new Map<string, { all: Set<string>; attention: Set<string> }>();
  const draftScopes = new Set<string>();
  for (const { scope, session } of listStoredComposerRows(state)) {
    const scopeKey = storedChatOutboxScopeKey(scope);
    if (session.draft) {
      draftScopes.add(scopeKey);
    }
    const ids = idsByScope.get(scopeKey) ?? {
      all: new Set<string>(),
      attention: new Set<string>(),
    };
    for (const item of listStoredChatOutboxes(state).find(
      (outbox) => storedChatOutboxScopeKey(outbox) === storedChatOutboxScopeKey(scope),
    )?.queue ?? []) {
      if (!item.pendingRunId) {
        ids.all.add(item.id);
        if (item.sendState === "failed" || item.sendState === "unconfirmed") {
          ids.attention.add(item.id);
        }
      }
    }
    if (ids.all.size) {
      idsByScope.set(scopeKey, ids);
    }
  }
  for (const outbox of listStoredChatOutboxes(state)) {
    const scopeKey = storedChatOutboxScopeKey(outbox);
    if (idsByScope.has(scopeKey)) {
      continue;
    }
    const all = new Set(outbox.queue.filter((item) => !item.pendingRunId).map((item) => item.id));
    const attention = new Set(
      outbox.queue
        .filter(
          (item) =>
            !item.pendingRunId && (item.sendState === "failed" || item.sendState === "unconfirmed"),
        )
        .map((item) => item.id),
    );
    if (all.size) {
      idsByScope.set(scopeKey, { all, attention });
    }
  }
  const attentionCountsByScope = new Map<string, number>();
  let total = 0;
  for (const [scopeKey, ids] of idsByScope) {
    total += ids.all.size;
    if (ids.attention.size) {
      attentionCountsByScope.set(scopeKey, ids.attention.size);
    }
  }
  // Resolve sidebar queries with this render's state; stored destinations stay captured.
  const sessionScopeKey = (sessionKey: string) =>
    storedChatOutboxScopeKey(resolveUiConversationIdentity(state, sessionKey));
  return {
    total,
    attentionCountForSession: (sessionKey: string) =>
      attentionCountsByScope.get(sessionScopeKey(sessionKey)) ?? 0,
    hasSessionDraft: (sessionKey: string) => draftScopes.has(sessionScopeKey(sessionKey)),
  };
}
