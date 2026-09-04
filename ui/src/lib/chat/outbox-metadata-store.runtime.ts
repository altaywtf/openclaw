import { getSafeLocalStorage, getSafeSessionStorage } from "../../local-storage.ts";
import { compareChatQueueOrder } from "./chat-queue-order.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import {
  openControlUiDatabase,
  requestResult,
  transactionComplete,
} from "./control-ui-database.runtime.ts";
import { recoverAbandonedChatOutboxes } from "./outbox-abandoned-recovery.runtime.ts";
import {
  chatOutboxDocumentStore,
  emptyChatOutboxDocument,
  mergeLegacyChatOutboxQueues,
  parseChatOutboxDocument,
  quarantineOwnerlessChatOutboxQueues,
  quarantineUnresolvedChatOutboxStore,
  retireChatOutboxDocumentItems,
  retireMigratedChatOutboxQueues,
  retireMigratedLegacyChatOutboxQueues,
  retireRemovedChatOutboxPayloads,
  type StoredChatOutboxDocument,
} from "./outbox-metadata-document.ts";
import {
  observeOutboxRecoveryOwner,
  outboxPayloadTab,
  outboxPayloadTabCandidate,
} from "./outbox-payload-store.runtime.ts";
import {
  adoptAbandonedPendingChatOutboxJournals,
  omitPendingChatOutboxAdmissions,
  readPendingChatOutboxJournal,
  settledPendingChatOutboxRetirements,
  writePendingChatOutboxJournal,
  type PendingChatOutboxJournal,
} from "./outbox-pending-journal.ts";
import {
  applyStoredChatOutboxScope,
  notifyStoredChatOutboxChanges,
  storedChatOutboxScopeKey,
  readStoredOutboxStore,
  resolvePendingComposerSessions,
  storageTargetForGateway,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type StoredChatOutboxScope,
  type StoredComposerState,
} from "./outbox-store.ts";

const STORE_NAME = "chatOutboxes";
const UNRESOLVED_RECOVERY_OWNER = "";

type CachedOutbox = {
  document: StoredChatOutboxDocument | null;
  hydration: Promise<boolean> | null;
  lane: Promise<void>;
  rescan: boolean;
};

const cacheByStorage = new WeakMap<Storage, Map<string, CachedOutbox>>();
type PendingAdmission = {
  item: ChatQueueItem;
  metadataStorage: Storage;
  scope: StoredChatOutboxScope;
  recoveryOwner: string;
  tabId: string;
  state: ChatComposerScope;
  storage: Storage;
  target: ReturnType<typeof storageTargetForGateway>;
};
const pendingAdmissions = new Set<PendingAdmission>();
const pendingAdmissionJournals = new Map<string, PendingAdmission>();
let pagehideInstalled = false;

function flushPendingAdmission(pending: PendingAdmission, invalidate = true): void {
  if (
    !pending.item.attachmentPayload &&
    pending.item.attachments?.some((attachment) => !attachment.dataUrl)
  ) {
    return;
  }
  const target = pending.target;
  const store = readPendingChatOutboxJournal(
    pending.storage,
    target.gatewayOwner,
    pending.recoveryOwner,
    pending.tabId,
  );
  const scopeKey = storedChatOutboxScopeKey(pending.scope);
  const session = store.sessions[scopeKey];
  const queue = session?.queue ?? [];
  if (store.retired.includes(pending.item.id)) {
    return;
  }
  const storedItem = applyStoredChatOutboxScope(pending.item, pending.scope);
  const existingIndex = queue.findIndex((item) => item.id === pending.item.id);
  const nextQueue = queue.slice();
  if (existingIndex >= 0) {
    nextQueue[existingIndex] = storedItem;
  } else {
    nextQueue.push(storedItem);
  }
  store.sessions[scopeKey] = {
    ...session,
    queue: nextQueue,
    updatedAt: Date.now(),
  };
  writePendingChatOutboxJournal(pending.storage, store);
  if (invalidate) {
    cacheEntry(pending.metadataStorage, target.gatewayOwner, pending.recoveryOwner).hydration =
      null;
  }
}

function flushPendingAdmissions(): void {
  for (const pending of pendingAdmissions) {
    try {
      flushPendingAdmission(pending);
    } catch {}
  }
}

export function journalChatOutboxAdmission(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
  item: ChatQueueItem,
  recoveryOwner = observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER,
): boolean {
  if (state.selectedChatSessionIncognito) {
    return false;
  }
  const storage = getSafeLocalStorage();
  const metadataStorage = getSafeSessionStorage();
  const tabId = metadataStorage ? outboxPayloadTabCandidate(metadataStorage) : null;
  if (!storage || !metadataStorage || !tabId) {
    return false;
  }
  try {
    const pending = {
      item,
      metadataStorage,
      recoveryOwner,
      scope,
      state,
      storage,
      tabId,
      target: storageTargetForGateway(state.settings?.gatewayUrl),
    };
    flushPendingAdmission(pending);
    pendingAdmissionJournals.set(item.id, pending);
    return true;
  } catch {
    return false;
  }
}

export function protectPendingChatOutboxAdmission(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
  item: ChatQueueItem,
): (() => void) | null {
  if (state.selectedChatSessionIncognito) {
    return () => undefined;
  }
  if (typeof document === "undefined") {
    return () => undefined;
  }
  const storage = getSafeLocalStorage();
  const metadataStorage = getSafeSessionStorage();
  const tabId = metadataStorage ? outboxPayloadTabCandidate(metadataStorage) : null;
  if (!storage || !metadataStorage || !tabId) {
    return null;
  }
  if (typeof window !== "undefined" && !pagehideInstalled) {
    window.addEventListener("pagehide", flushPendingAdmissions);
    pagehideInstalled = true;
  }
  const pending = {
    item,
    metadataStorage,
    recoveryOwner: observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER,
    scope,
    state,
    storage,
    tabId,
    target: storageTargetForGateway(state.settings?.gatewayUrl),
  };
  pendingAdmissions.add(pending);
  pendingAdmissionJournals.set(item.id, pending);
  try {
    // Reserve one submission synchronously before the composer releases it. The
    // journal stays O(one in-flight prompt); the durable queue remains IndexedDB-owned.
    flushPendingAdmission(pending, false);
  } catch {
    pendingAdmissions.delete(pending);
    pendingAdmissionJournals.delete(item.id);
    return null;
  }
  return () => releasePendingChatOutboxAdmission(item.id);
}

export function releasePendingChatOutboxAdmission(itemId: string): void {
  const pending = pendingAdmissionJournals.get(itemId);
  if (!pending) {
    return;
  }
  pendingAdmissions.delete(pending);
  pendingAdmissionJournals.delete(itemId);
  try {
    const journal = readPendingChatOutboxJournal(
      pending.storage,
      pending.target.gatewayOwner,
      pending.recoveryOwner,
      pending.tabId,
    );
    for (const [scopeKey, session] of Object.entries(journal.sessions)) {
      const queue = session.queue?.filter((item) => item.id !== itemId) ?? [];
      if (queue.length) {
        journal.sessions[scopeKey] = { ...session, queue };
      } else {
        delete journal.sessions[scopeKey];
      }
    }
    journal.retired = journal.retired.filter((id) => id !== itemId);
    writePendingChatOutboxJournal(pending.storage, journal);
  } catch {
    // A verified IndexedDB row remains authoritative if shutdown storage is unavailable.
  }
}

export function retirePendingChatOutboxAdmission(itemId: string): boolean {
  const pending = pendingAdmissionJournals.get(itemId);
  if (!pending) {
    return true;
  }
  try {
    const journal = readPendingChatOutboxJournal(
      pending.storage,
      pending.target.gatewayOwner,
      pending.recoveryOwner,
      pending.tabId,
    );
    for (const [scopeKey, session] of Object.entries(journal.sessions)) {
      const queue = session.queue?.filter((item) => item.id !== itemId) ?? [];
      if (queue.length) {
        journal.sessions[scopeKey] = { ...session, queue };
      } else {
        delete journal.sessions[scopeKey];
      }
    }
    journal.retired = [...new Set([...journal.retired, itemId])];
    writePendingChatOutboxJournal(pending.storage, journal);
    cacheEntry(
      pending.metadataStorage,
      pending.target.gatewayOwner,
      pending.recoveryOwner,
    ).hydration = null;
  } catch {
    return false;
  }
  pendingAdmissions.delete(pending);
  pendingAdmissionJournals.delete(itemId);
  return true;
}

export function persistPendingChatOutboxAdmission(item: ChatQueueItem): boolean {
  for (const pending of pendingAdmissions) {
    if (pending.item.id === item.id) {
      const retired = readPendingChatOutboxJournal(
        pending.storage,
        pending.target.gatewayOwner,
        pending.recoveryOwner,
        pending.tabId,
      ).retired.includes(item.id);
      if (retired) {
        pendingAdmissions.delete(pending);
        return false;
      }
      pending.item = item;
      try {
        flushPendingAdmission(pending);
        pendingAdmissions.delete(pending);
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function updatePendingChatOutboxAdmission(item: ChatQueueItem): boolean {
  for (const pending of pendingAdmissions) {
    if (pending.item.id !== item.id) {
      continue;
    }
    pending.item = item;
    try {
      flushPendingAdmission(pending, false);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function cacheEntry(storage: Storage, gatewayOwner: string, recoveryOwner: string): CachedOutbox {
  const byOwner = cacheByStorage.get(storage) ?? new Map<string, CachedOutbox>();
  cacheByStorage.set(storage, byOwner);
  const ownerKey = `${gatewayOwner}\u0000${recoveryOwner}`;
  const existing = byOwner.get(ownerKey);
  if (existing) {
    return existing;
  }
  const created: CachedOutbox = {
    document: null,
    hydration: null,
    lane: Promise.resolve(),
    rescan: false,
  };
  byOwner.set(ownerKey, created);
  return created;
}

function retireMigratedPendingChatOutboxJournal(
  storage: Storage,
  gatewayOwner: string,
  recoveryOwner: string,
  tabId: string,
  migrated: Map<string, Map<string, string>>,
  retired: ReadonlySet<string>,
): void {
  if (!migrated.size && !retired.size) {
    return;
  }
  const journal = readPendingChatOutboxJournal(storage, gatewayOwner, recoveryOwner, tabId);
  retireMigratedChatOutboxQueues(journal, migrated);
  journal.retired = journal.retired.filter((id) => !retired.has(id));
  writePendingChatOutboxJournal(storage, journal);
}

function omitActivePendingAdmissions(
  journal: PendingChatOutboxJournal,
  storage: Storage,
  gatewayOwner: string,
  recoveryOwner: string,
): PendingChatOutboxJournal {
  const active = new Set(
    [...pendingAdmissions]
      .filter(
        (pending) =>
          pending.storage === storage &&
          pending.target.gatewayOwner === gatewayOwner &&
          pending.recoveryOwner === recoveryOwner,
      )
      .map((pending) => pending.item.id),
  );
  return omitPendingChatOutboxAdmissions(journal, active);
}

async function hydrateEntry(
  state: ChatComposerScope,
  storage: Storage,
  entry: CachedOutbox,
  target: ReturnType<typeof storageTargetForGateway>,
  recoveryOwner: string,
) {
  const journalStorage = getSafeLocalStorage();
  if (!journalStorage) {
    return false;
  }
  const tabId = await outboxPayloadTab();
  const journalRescan = await adoptAbandonedPendingChatOutboxJournals(
    journalStorage,
    target.gatewayOwner,
    recoveryOwner,
    tabId,
  );
  const key = JSON.stringify([target.gatewayOwner, tabId, recoveryOwner]);
  const database = await openControlUiDatabase();
  const documentRescan = await recoverAbandonedChatOutboxes(
    database,
    target.gatewayOwner,
    recoveryOwner,
    tabId,
  );
  entry.rescan = journalRescan || documentRescan;
  const transaction = database.transaction(STORE_NAME, "readwrite", { durability: "strict" });
  const completion = transactionComplete(transaction);
  const objectStore = transaction.objectStore(STORE_NAME);
  const storedRequest = requestResult(objectStore.get(key));
  const unresolvedKey = recoveryOwner
    ? JSON.stringify([target.gatewayOwner, tabId, UNRESOLVED_RECOVERY_OWNER])
    : undefined;
  const unresolvedRequest = unresolvedKey
    ? requestResult(objectStore.get(unresolvedKey))
    : Promise.resolve(undefined);
  const [stored, unresolved] = await Promise.all([storedRequest, unresolvedRequest]);
  let document = parseChatOutboxDocument(stored, key, target.gatewayOwner, recoveryOwner, tabId);
  const unresolvedDocument = unresolvedKey
    ? parseChatOutboxDocument(
        unresolved,
        unresolvedKey,
        target.gatewayOwner,
        UNRESOLVED_RECOVERY_OWNER,
        tabId,
      )
    : null;
  document ??= emptyChatOutboxDocument(key, target.gatewayOwner, recoveryOwner, tabId);
  const journal = omitActivePendingAdmissions(
    readPendingChatOutboxJournal(journalStorage, target.gatewayOwner, recoveryOwner, tabId),
    journalStorage,
    target.gatewayOwner,
    recoveryOwner,
  );
  const unresolvedJournal = recoveryOwner
    ? omitActivePendingAdmissions(
        readPendingChatOutboxJournal(
          journalStorage,
          target.gatewayOwner,
          UNRESOLVED_RECOVERY_OWNER,
          tabId,
        ),
        journalStorage,
        target.gatewayOwner,
        UNRESOLVED_RECOVERY_OWNER,
      )
    : null;
  const retired = new Set([...journal.retired, ...(unresolvedJournal?.retired ?? [])]);
  const retiredCurrentItems = retireChatOutboxDocumentItems(document, retired);
  const retiredUnresolvedItems = retireChatOutboxDocumentItems(unresolvedDocument, retired);
  if (unresolvedJournal) {
    for (const [scopeKey, session] of Object.entries(unresolvedJournal.sessions)) {
      const queue = session.queue?.filter((item) => !retired.has(item.id)) ?? [];
      if (queue.length) {
        unresolvedJournal.sessions[scopeKey] = { ...session, queue };
      } else {
        delete unresolvedJournal.sessions[scopeKey];
      }
    }
  }
  const journalMigrated = mergeLegacyChatOutboxQueues(
    document,
    {
      version: 4,
      gatewayOwner: target.gatewayOwner,
      sessions: journal.sessions,
      recovery: {},
    },
    {
      allowForeignTabAttachments: true,
      allowOwnerless: true,
      preferEquivalentIncoming: true,
    },
  );
  const legacy = readStoredOutboxStore(storage, target);
  resolvePendingComposerSessions(legacy, state);
  let legacyChanged = quarantineOwnerlessChatOutboxQueues(legacy);
  const unresolvedQuarantined = unresolvedDocument
    ? quarantineUnresolvedChatOutboxStore(legacy, chatOutboxDocumentStore(unresolvedDocument))
    : false;
  const unresolvedJournalQuarantined = unresolvedJournal
    ? quarantineUnresolvedChatOutboxStore(legacy, {
        version: 4,
        gatewayOwner: target.gatewayOwner,
        sessions: unresolvedJournal.sessions,
        recovery: {},
      })
    : false;
  legacyChanged ||= unresolvedQuarantined || unresolvedJournalQuarantined;
  if (legacyChanged) {
    writeStoredOutboxStore(storage, target, legacy, { retirePayloads: false });
  }
  if (unresolvedQuarantined && unresolvedDocument) {
    unresolvedDocument.sessions = {};
  }
  const migrated = mergeLegacyChatOutboxQueues(document, legacy);
  const resolved = resolvePendingComposerSessions(chatOutboxDocumentStore(document), state);
  const currentTarget = storageTargetForGateway(state.settings?.gatewayUrl);
  const currentRecoveryOwner = observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER;
  if (
    currentTarget.gatewayOwner !== target.gatewayOwner ||
    currentRecoveryOwner !== recoveryOwner
  ) {
    transaction.abort();
    await completion.catch(() => undefined);
    return false;
  }
  if (
    migrated.size ||
    journalMigrated.size ||
    unresolvedQuarantined ||
    resolved ||
    retiredCurrentItems ||
    retiredUnresolvedItems ||
    !stored
  ) {
    objectStore.put(document);
    if (unresolvedKey && unresolvedDocument) {
      if (Object.keys(unresolvedDocument.sessions).length) {
        objectStore.put(unresolvedDocument);
      } else {
        objectStore.delete(unresolvedKey);
      }
    }
  }
  await completion;
  entry.document = document;
  if (unresolvedKey) {
    const unresolvedEntry = cacheEntry(storage, target.gatewayOwner, UNRESOLVED_RECOVERY_OWNER);
    unresolvedEntry.document = unresolvedDocument;
  }
  retireMigratedPendingChatOutboxJournal(
    journalStorage,
    target.gatewayOwner,
    recoveryOwner,
    tabId,
    journalMigrated,
    settledPendingChatOutboxRetirements(
      retired,
      [...pendingAdmissions]
        .filter(
          (pending) =>
            pending.storage === journalStorage &&
            pending.target.gatewayOwner === target.gatewayOwner &&
            pending.recoveryOwner === recoveryOwner,
        )
        .map((pending) => pending.item.id),
    ),
  );
  if (unresolvedJournal) {
    if (unresolvedJournalQuarantined) {
      unresolvedJournal.sessions = {};
      unresolvedJournal.retired = [];
      writePendingChatOutboxJournal(journalStorage, unresolvedJournal);
    }
  }
  if (migrated.size) {
    retireMigratedLegacyChatOutboxQueues(storage, state, migrated);
  }
  notifyStoredChatOutboxChanges();
  return true;
}

export function hydrateChatOutboxMetadata(state: ChatComposerScope): Promise<boolean> {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return Promise.resolve(false);
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const recoveryOwner = observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER;
  const entry = cacheEntry(storage, target.gatewayOwner, recoveryOwner);
  entry.hydration ??= hydrateEntry(state, storage, entry, target, recoveryOwner).then(
    (hydrated) => {
      if (!hydrated || entry.rescan) {
        entry.hydration = null;
        entry.rescan = false;
      }
      return hydrated;
    },
    () => {
      entry.hydration = null;
      return false;
    },
  );
  return entry.hydration;
}

export function readChatOutboxMetadata(state: ChatComposerScope): StoredComposerState | null {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return null;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const recoveryOwner = observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER;
  const document = cacheEntry(storage, target.gatewayOwner, recoveryOwner).document;
  if (!document) {
    return null;
  }
  return structuredClone(chatOutboxDocumentStore(document));
}

export function readUnresolvedChatOutboxMetadata(
  state: ChatComposerScope,
): StoredComposerState | null {
  if (observeOutboxRecoveryOwner(state)) {
    return null;
  }
  const storage = getSafeSessionStorage();
  if (!storage) {
    return null;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const document = cacheEntry(storage, target.gatewayOwner, UNRESOLVED_RECOVERY_OWNER).document;
  return document ? structuredClone(chatOutboxDocumentStore(document)) : null;
}

export function hasEarlierUnresolvedChatOutboxItem(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
  item: ChatQueueItem,
): boolean {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return false;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const unresolved = cacheEntry(storage, target.gatewayOwner, UNRESOLVED_RECOVERY_OWNER).document;
  const queue = unresolved?.sessions[storedChatOutboxScopeKey(scope)]?.queue ?? [];
  return queue.some((candidate) =>
    candidate.id !== item.id ? compareChatQueueOrder(candidate, item) < 0 : false,
  );
}

export async function mutateChatOutboxMetadata(
  state: ChatComposerScope,
  mutate: (store: StoredComposerState) => boolean,
): Promise<boolean> {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return false;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const recoveryOwner = observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER;
  const entry = cacheEntry(storage, target.gatewayOwner, recoveryOwner);
  if (
    !(await hydrateChatOutboxMetadata(state)) ||
    storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner !== target.gatewayOwner ||
    (observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER) !== recoveryOwner
  ) {
    return false;
  }
  let result = false;
  const previousLane = entry.lane;
  entry.lane = (async () => {
    await previousLane;
    const current = entry.document;
    if (!current) {
      return;
    }
    const database = await openControlUiDatabase();
    const document = structuredClone(current);
    const store = chatOutboxDocumentStore(document);
    if (!mutate(store)) {
      return;
    }
    document.sessions = store.sessions;
    const transaction = database.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    transaction.objectStore(STORE_NAME).put(document);
    await transactionComplete(transaction);
    retireRemovedChatOutboxPayloads(current, document);
    entry.document = document;
    result = true;
    notifyStoredChatOutboxChanges();
  })().catch(() => undefined);
  await entry.lane;
  return result;
}

export async function migrateLegacyChatOutboxMetadata(
  state: ChatComposerScope,
  options: { allowOwnerless?: boolean } = {},
): Promise<boolean> {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return false;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const recoveryOwner = observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER;
  const entry = cacheEntry(storage, target.gatewayOwner, recoveryOwner);
  if (
    !(await hydrateChatOutboxMetadata(state)) ||
    storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner !== target.gatewayOwner ||
    (observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER) !== recoveryOwner
  ) {
    return false;
  }
  let result = false;
  const previousLane = entry.lane;
  entry.lane = (async () => {
    await previousLane;
    const current = entry.document;
    if (!current) {
      return;
    }
    const legacy = readStoredOutboxStore(storage, target);
    resolvePendingComposerSessions(legacy, state);
    const document = structuredClone(current);
    const resolved = resolvePendingComposerSessions(chatOutboxDocumentStore(document), state);
    const migrated = mergeLegacyChatOutboxQueues(document, legacy, {
      allowOwnerless: options.allowOwnerless,
    });
    if (!migrated.size && !resolved) {
      result = true;
      return;
    }
    const database = await openControlUiDatabase();
    const transaction = database.transaction(STORE_NAME, "readwrite", { durability: "strict" });
    transaction.objectStore(STORE_NAME).put(document);
    await transactionComplete(transaction);
    entry.document = document;
    retireMigratedLegacyChatOutboxQueues(storage, state, migrated);
    notifyStoredChatOutboxChanges();
    result = true;
  })().catch(() => undefined);
  await entry.lane;
  return result;
}
