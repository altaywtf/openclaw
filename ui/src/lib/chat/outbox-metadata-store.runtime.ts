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
  writePendingChatOutboxItem,
  removePendingChatOutboxItem,
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
// One admission registration owns both live preparation and recoverable failure.
// Recovery may adopt a detached row, but cannot race a live preparation.
class PendingAdmission {
  phase: "preparing" | "recoverable" | "retiring" | "retired" | "committed" = "preparing";
  get active(): boolean {
    return this.phase === "preparing" || this.phase === "retiring";
  }
  constructor(
    public item: ChatQueueItem,
    readonly metadataStorage: Storage,
    readonly storage: Storage,
    readonly scope: StoredChatOutboxScope,
    readonly gatewayOwner: string,
    readonly recoveryOwner: string,
    readonly tabId: string,
  ) {}
  write(item = this.item, recoverable = false): boolean {
    if (this.phase === "retiring" || this.phase === "retired" || this.phase === "committed") {
      return false;
    }
    if (!item.attachmentPayload && item.attachments?.some((attachment) => !attachment.dataUrl)) {
      // Native Blob ownership cannot leave the composer until its payload is durable.
      return false;
    }
    try {
      writePendingChatOutboxItem(this.storage, this, item.id, {
        scopeKey: storedChatOutboxScopeKey(this.scope),
        item: applyStoredChatOutboxScope(item, this.scope),
      });
      this.item = item;
      if (recoverable) {
        this.phase = "recoverable";
        cacheEntry(this.metadataStorage, this.gatewayOwner, this.recoveryOwner).hydration = null;
      }
      return true;
    } catch {
      return false;
    }
  }
  release(): void {
    this.phase = "committed";
    try {
      removePendingChatOutboxItem(this.storage, this, this.item.id);
      pendingAdmissions.delete(this.item.id);
    } catch {
      // Keep the settled registration so later durable transitions can retry cleanup.
    }
  }
  retire(): boolean {
    try {
      writePendingChatOutboxItem(this.storage, this, this.item.id);
      this.phase = this.active ? "retiring" : "retired";
      cacheEntry(this.metadataStorage, this.gatewayOwner, this.recoveryOwner).hydration = null;
      return true;
    } catch {
      return false;
    }
  }
}
const pendingAdmissions = new Map<string, PendingAdmission>();

export function protectPendingChatOutboxAdmission(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
  item: ChatQueueItem,
): (() => void) | null {
  if (state.selectedChatSessionIncognito) {
    return () => undefined;
  }
  const storage = getSafeLocalStorage();
  const metadataStorage = getSafeSessionStorage();
  const tabId = metadataStorage ? outboxPayloadTabCandidate(metadataStorage) : null;
  if (!storage || !metadataStorage || !tabId) {
    return null;
  }
  const pending = new PendingAdmission(
    item,
    metadataStorage,
    storage,
    scope,
    storageTargetForGateway(state.settings?.gatewayUrl).gatewayOwner,
    observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER,
    tabId,
  );
  // Native attachments are still composer-owned here. Their first write follows
  // payload persistence; every releasable prompt is protected synchronously.
  const native =
    !item.attachmentPayload && item.attachments?.some((attachment) => !attachment.dataUrl);
  if (!native && !pending.write()) {
    return null;
  }
  pendingAdmissions.set(item.id, pending);
  return () => pending.release();
}

export function finishPendingChatOutboxAdmission(itemId: string): void {
  const pending = pendingAdmissions.get(itemId);
  if (!pending || !pending.active) {
    return;
  }
  pending.phase = pending.phase === "retiring" ? "retired" : "recoverable";
  cacheEntry(pending.metadataStorage, pending.gatewayOwner, pending.recoveryOwner).hydration = null;
}

export function retirePendingChatOutboxAdmission(itemId: string): boolean {
  return pendingAdmissions.get(itemId)?.retire() ?? true;
}

export function persistPendingChatOutboxAdmission(item: ChatQueueItem): boolean {
  return pendingAdmissions.get(item.id)?.write(item, true) ?? false;
}

export function updatePendingChatOutboxAdmission(item: ChatQueueItem): boolean {
  return pendingAdmissions.get(item.id)?.write(item) ?? false;
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
  const settled = settledPendingChatOutboxRetirements(
    retired,
    [...pendingAdmissions.values()]
      .filter(
        (pending) =>
          pending.active &&
          pending.storage === storage &&
          pending.gatewayOwner === gatewayOwner &&
          pending.recoveryOwner === recoveryOwner,
      )
      .map((pending) => pending.item.id),
  );
  retireMigratedChatOutboxQueues(journal, migrated);
  journal.retired = journal.retired.filter((id) => !settled.has(id));
  writePendingChatOutboxJournal(storage, journal);
  // A cancellation written during the commit still owns the row until the
  // next recovery transaction removes it; migration must not erase that fence.
  const retained = new Set([
    ...journal.retired,
    ...Object.values(journal.sessions).flatMap((session) =>
      (session.queue ?? []).map((item) => item.id),
    ),
  ]);
  for (const items of migrated.values()) {
    for (const id of items.keys()) {
      settled.add(id);
    }
  }
  for (const id of settled) {
    const pending = pendingAdmissions.get(id);
    if (
      pending &&
      !pending.active &&
      pending.storage === storage &&
      pending.gatewayOwner === gatewayOwner &&
      pending.recoveryOwner === recoveryOwner &&
      !retained.has(id)
    ) {
      pending.release();
    }
  }
}

function omitActivePendingAdmissions(
  journal: PendingChatOutboxJournal,
  storage: Storage,
  gatewayOwner: string,
  recoveryOwner: string,
): PendingChatOutboxJournal {
  const active = new Set(
    [...pendingAdmissions.values()]
      .filter(
        (pending) =>
          pending.active &&
          pending.storage === storage &&
          pending.gatewayOwner === gatewayOwner &&
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
    retired,
  );
  if (unresolvedJournal && unresolvedJournalQuarantined) {
    // The commit may outlive a new admission. Retire only the versions copied
    // into recovery, never replace the journal with the pre-commit snapshot.
    const quarantined = new Map(
      Object.entries(unresolvedJournal.sessions).map(([scope, session]) => [
        scope,
        new Map((session.queue ?? []).map((item) => [item.id, JSON.stringify(item)])),
      ]),
    );
    retireMigratedPendingChatOutboxJournal(
      journalStorage,
      target.gatewayOwner,
      UNRESOLVED_RECOVERY_OWNER,
      tabId,
      quarantined,
      new Set(unresolvedJournal.retired),
    );
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
  const pendingVersions = new Map(
    [...pendingAdmissions].map(([id, pending]) => [id, pending.item]),
  );
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
    const previousRows = new Map(
      Object.values(current.sessions).flatMap((session) =>
        (session.queue ?? []).map((item) => [item.id, JSON.stringify(item)] as const),
      ),
    );
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
    // Only rows changed by this commit can release their captured admission.
    // A later journal revision or an unrelated write must retain recovery ownership.
    for (const session of Object.values(document.sessions)) {
      for (const item of session.queue ?? []) {
        const pending = pendingAdmissions.get(item.id);
        if (
          pending?.phase !== "retiring" &&
          pending?.phase !== "retired" &&
          pending?.metadataStorage === storage &&
          pending.gatewayOwner === target.gatewayOwner &&
          pending.recoveryOwner === recoveryOwner &&
          pending.item === pendingVersions.get(item.id) &&
          previousRows.get(item.id) !== JSON.stringify(item) &&
          (!item.attachments?.length || item.attachmentPayload || item.attachmentStorageError)
        ) {
          pending.release();
        }
      }
    }
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
