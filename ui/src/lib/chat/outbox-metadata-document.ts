import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatQueueItem } from "./chat-types.ts";
import { removeOutboxPayloads } from "./outbox-payload-store.runtime.ts";
import {
  normalizeStoredSession,
  sameQueuedDeliveryVersion,
  type StoredComposerSession,
} from "./outbox-store-codec.ts";
import {
  readStoredOutboxStore,
  storageTargetForGateway,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type StoredComposerState,
} from "./outbox-store.ts";

export type StoredChatOutboxDocument = {
  key: string;
  version: 1;
  gatewayOwner: string;
  recoveryOwner: string;
  tabId: string;
  sessions: Record<string, StoredComposerSession>;
};

export function emptyChatOutboxDocument(
  key: string,
  gatewayOwner: string,
  recoveryOwner: string,
  tabId: string,
): StoredChatOutboxDocument {
  return { key, version: 1, gatewayOwner, recoveryOwner, tabId, sessions: {} };
}

export function parseChatOutboxDocument(
  value: unknown,
  key: string,
  gatewayOwner: string,
  recoveryOwner: string,
  tabId: string,
): StoredChatOutboxDocument | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  if (
    record.key !== key ||
    record.version !== 1 ||
    record.gatewayOwner !== gatewayOwner ||
    record.recoveryOwner !== recoveryOwner ||
    record.tabId !== tabId ||
    !isRecord(record.sessions)
  ) {
    throw new Error("Invalid chat outbox metadata record");
  }
  const sessions: Record<string, StoredComposerSession> = {};
  for (const [scopeKey, storedSession] of Object.entries(record.sessions)) {
    const session = normalizeStoredSession(storedSession);
    if (!session || session.draft || session.goalMode || session.draftRevision !== undefined) {
      throw new Error("Invalid chat outbox metadata session");
    }
    if (session.queue?.length) {
      sessions[scopeKey] = {
        ...(session.awaitingDefaults ? { awaitingDefaults: true } : {}),
        queue: session.queue,
        updatedAt: session.updatedAt,
      };
    }
  }
  return { key, version: 1, gatewayOwner, recoveryOwner, tabId, sessions };
}

export function chatOutboxDocumentStore(document: StoredChatOutboxDocument): StoredComposerState {
  return {
    version: 4,
    gatewayOwner: document.gatewayOwner,
    sessions: document.sessions,
    recovery: {},
  };
}

export function retireRemovedChatOutboxPayloads(
  previous: StoredChatOutboxDocument,
  current: StoredChatOutboxDocument,
): void {
  const references = (document: StoredChatOutboxDocument) =>
    Object.values(document.sessions).flatMap((session) =>
      (session.queue ?? []).flatMap((item) =>
        item.attachmentPayload ? [item.attachmentPayload] : [],
      ),
    );
  const retained = new Set(references(current).map((reference) => reference.key));
  const removed = references(previous).filter((reference) => !retained.has(reference.key));
  if (removed.length) {
    void removeOutboxPayloads(removed);
  }
}

function durableAttachmentScore(item: ChatQueueItem): number {
  if (
    item.attachmentPayload ||
    (item.attachments?.length &&
      item.attachments.every((attachment) => Boolean(attachment.dataUrl)))
  ) {
    return 2;
  }
  return item.attachments?.length ? 1 : 0;
}

export function mergeLegacyChatOutboxQueues(
  document: StoredChatOutboxDocument,
  legacy: StoredComposerState,
  options: {
    allowForeignTabAttachments?: boolean;
    allowOwnerless?: boolean;
    preferEquivalentIncoming?: boolean;
  } = {},
): Map<string, Map<string, string>> {
  const migrated = new Map<string, Map<string, string>>();
  for (const [scopeKey, session] of Object.entries(legacy.sessions)) {
    const queue = session.queue?.filter(
      (item) =>
        (!item.attachmentPayload && options.allowOwnerless === true) ||
        (item.attachmentPayload?.recoveryScope === document.recoveryOwner &&
          (item.attachmentPayload.tabId === document.tabId ||
            options.allowForeignTabAttachments === true) &&
          Boolean(document.recoveryOwner)),
    );
    if (!queue?.length) {
      continue;
    }
    const current = document.sessions[scopeKey];
    const byId = new Map((current?.queue ?? []).map((item) => [item.id, item]));
    let conflict = false;
    for (const item of queue) {
      const existing = byId.get(item.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
        if (options.preferEquivalentIncoming && sameQueuedDeliveryVersion(existing, item)) {
          if (durableAttachmentScore(item) > durableAttachmentScore(existing)) {
            byId.set(item.id, item);
          }
          continue;
        }
        conflict = true;
        break;
      }
      byId.set(item.id, item);
    }
    if (conflict) {
      continue;
    }
    document.sessions[scopeKey] = {
      ...(session.awaitingDefaults ? { awaitingDefaults: true } : {}),
      queue: [...byId.values()],
      updatedAt: Math.max(current?.updatedAt ?? 0, session.updatedAt),
    };
    migrated.set(scopeKey, new Map(queue.map((item) => [item.id, JSON.stringify(item)])));
  }
  return migrated;
}

export function retireMigratedChatOutboxQueues(
  document: { sessions: Record<string, StoredComposerSession> },
  migrated: Map<string, Map<string, string>>,
): void {
  for (const [scopeKey, migratedItems] of migrated) {
    const session = document.sessions[scopeKey];
    if (!session?.queue?.length) {
      continue;
    }
    const queue = session.queue.filter(
      (item) => migratedItems.get(item.id) !== JSON.stringify(item),
    );
    if (queue.length) {
      document.sessions[scopeKey] = { ...session, queue };
    } else {
      delete document.sessions[scopeKey];
    }
  }
}

export function retireChatOutboxDocumentItems(
  document: StoredChatOutboxDocument | null,
  retired: ReadonlySet<string>,
): boolean {
  if (!document || !retired.size) {
    return false;
  }
  let changed = false;
  for (const [scopeKey, session] of Object.entries(document.sessions)) {
    const queue = session.queue?.filter((item) => !retired.has(item.id)) ?? [];
    if (queue.length === (session.queue?.length ?? 0)) {
      continue;
    }
    changed = true;
    if (queue.length) {
      document.sessions[scopeKey] = { ...session, queue };
    } else {
      delete document.sessions[scopeKey];
    }
  }
  return changed;
}

export function quarantineOwnerlessChatOutboxQueues(legacy: StoredComposerState): boolean {
  let changed = false;
  for (const [scopeKey, session] of Object.entries(legacy.sessions)) {
    const queue = session.queue ?? [];
    const ownerless = queue.filter((item) => !item.attachmentPayload);
    if (!ownerless.length) {
      continue;
    }
    const recoveryId = `credential:${scopeKey}:${ownerless.map((item) => item.id).join(",")}`;
    legacy.recovery[recoveryId] ??= {
      sourceVersion: 4,
      sourceScopeKey: scopeKey,
      session: { ...session, queue: ownerless },
    };
    const retained = queue.filter((item) => item.attachmentPayload);
    if (
      retained.length ||
      session.draft ||
      session.goalMode ||
      session.draftRevision !== undefined
    ) {
      legacy.sessions[scopeKey] = {
        ...session,
        ...(retained.length ? { queue: retained } : { queue: undefined }),
      };
    } else {
      delete legacy.sessions[scopeKey];
    }
    changed = true;
  }
  return changed;
}

export function quarantineUnresolvedChatOutboxStore(
  destination: StoredComposerState,
  source: StoredComposerState,
): boolean {
  const transfers = Object.entries(source.sessions).flatMap(([scopeKey, session]) => {
    const queue = session.queue ?? [];
    if (!queue.length) {
      return [];
    }
    const id = `credential:${scopeKey}:${queue.map((item) => item.id).join(",")}`;
    return [
      {
        id,
        entry: { sourceVersion: 4 as const, sourceScopeKey: scopeKey, session },
      },
    ];
  });
  if (
    transfers.some(({ id, entry }) => {
      const existing = destination.recovery[id];
      return existing && JSON.stringify(existing) !== JSON.stringify(entry);
    })
  ) {
    return false;
  }
  for (const { id, entry } of transfers) {
    destination.recovery[id] = entry;
  }
  return transfers.length > 0;
}

export function retireMigratedLegacyChatOutboxQueues(
  storage: Storage,
  state: ChatComposerScope,
  migrated: Map<string, Map<string, string>>,
): void {
  if (!migrated.size) {
    return;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const legacy = readStoredOutboxStore(storage, target);
  for (const [scopeKey, migratedItems] of migrated) {
    const session = legacy.sessions[scopeKey];
    if (!session?.queue?.length) {
      continue;
    }
    const queue = session.queue.filter(
      (item) => migratedItems.get(item.id) !== JSON.stringify(item),
    );
    if (queue.length) {
      legacy.sessions[scopeKey] = { ...session, queue };
      continue;
    }
    const { queue: _queue, ...draft } = session;
    if (draft.draft || draft.goalMode || draft.draftRevision !== undefined) {
      legacy.sessions[scopeKey] = draft;
    } else {
      delete legacy.sessions[scopeKey];
    }
  }
  // IndexedDB now owns every referenced payload; metadata retirement must not
  // garbage-collect attachment blobs that the migrated queue still references.
  writeStoredOutboxStore(storage, target, legacy, { retirePayloads: false });
}
