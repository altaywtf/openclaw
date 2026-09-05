import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatQueueItem } from "./chat-types.ts";
import { normalizeStoredSession, type StoredComposerSession } from "./outbox-store-codec.ts";

const PENDING_JOURNAL_PREFIX = "openclaw.control.chatPending.v1:";

export type PendingChatOutboxJournal = {
  version: 1;
  gatewayOwner: string;
  recoveryOwner: string;
  tabId: string;
  sessions: Record<string, StoredComposerSession>;
  retired: string[];
};
type JournalOwner = Pick<PendingChatOutboxJournal, "gatewayOwner" | "recoveryOwner" | "tabId">;

function pendingJournalKey(owner: JournalOwner): string {
  return `${PENDING_JOURNAL_PREFIX}${encodeURIComponent(owner.gatewayOwner)}:${encodeURIComponent(owner.recoveryOwner)}:${encodeURIComponent(owner.tabId)}:`;
}

function journalKeys(storage: Storage, prefix: string): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => key?.startsWith(prefix) === true,
  );
}

// Acceptance only touches this row. Enumerating other admissions belongs to async
// recovery, never to the synchronous composer handoff.
export function writePendingChatOutboxItem(
  storage: Storage,
  owner: JournalOwner,
  id: string,
  submission?: { scopeKey: string; item: ChatQueueItem },
): void {
  const journal: PendingChatOutboxJournal = {
    gatewayOwner: owner.gatewayOwner,
    recoveryOwner: owner.recoveryOwner,
    tabId: owner.tabId,
    version: 1,
    sessions: submission
      ? { [submission.scopeKey]: { queue: [submission.item], updatedAt: Date.now() } }
      : {},
    retired: submission ? [] : [id],
  };
  storage.setItem(`${pendingJournalKey(owner)}${encodeURIComponent(id)}`, JSON.stringify(journal));
}

export function removePendingChatOutboxItem(
  storage: Storage,
  owner: JournalOwner,
  id: string,
): void {
  storage.removeItem(`${pendingJournalKey(owner)}${encodeURIComponent(id)}`);
}

export function readPendingChatOutboxJournal(
  storage: Storage,
  gatewayOwner: string,
  recoveryOwner: string,
  tabId: string,
): PendingChatOutboxJournal {
  const journal: PendingChatOutboxJournal = {
    version: 1,
    gatewayOwner,
    recoveryOwner,
    tabId,
    sessions: {},
    retired: [],
  };
  for (const key of journalKeys(storage, pendingJournalKey(journal))) {
    try {
      const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (
        !isRecord(value) ||
        value.version !== 1 ||
        value.gatewayOwner !== gatewayOwner ||
        value.recoveryOwner !== recoveryOwner ||
        value.tabId !== tabId ||
        !isRecord(value.sessions)
      ) {
        continue;
      }
      for (const [scopeKey, storedSession] of Object.entries(value.sessions)) {
        const session = normalizeStoredSession(storedSession);
        if (session?.queue?.length) {
          journal.sessions[scopeKey] = {
            ...session,
            queue: [...(journal.sessions[scopeKey]?.queue ?? []), ...session.queue],
          };
        }
      }
      if (Array.isArray(value.retired)) {
        journal.retired.push(...value.retired.filter((id): id is string => typeof id === "string"));
      }
    } catch {
      // Corrupt records cannot authorize replay or erase another admission.
    }
  }
  return journal;
}

export function writePendingChatOutboxJournal(
  storage: Storage,
  journal: PendingChatOutboxJournal,
): void {
  const retained = new Set<string>();
  for (const [scopeKey, session] of Object.entries(journal.sessions)) {
    for (const item of session.queue ?? []) {
      writePendingChatOutboxItem(storage, journal, item.id, { scopeKey, item });
      retained.add(`${pendingJournalKey(journal)}${encodeURIComponent(item.id)}`);
    }
  }
  for (const id of journal.retired) {
    writePendingChatOutboxItem(storage, journal, id);
    retained.add(`${pendingJournalKey(journal)}${encodeURIComponent(id)}`);
  }
  for (const key of journalKeys(storage, pendingJournalKey(journal))) {
    if (!retained.has(key)) {
      storage.removeItem(key);
    }
  }
}

export function omitPendingChatOutboxAdmissions(
  journal: PendingChatOutboxJournal,
  active: ReadonlySet<string>,
): PendingChatOutboxJournal {
  const sessions = Object.fromEntries(
    Object.entries(journal.sessions).flatMap(([key, session]) => {
      const queue = session.queue?.filter((item) => !active.has(item.id));
      return queue?.length ? [[key, { ...session, queue }]] : [];
    }),
  );
  return { ...journal, sessions };
}

export function settledPendingChatOutboxRetirements(
  retired: ReadonlySet<string>,
  activeIds: Iterable<string>,
): Set<string> {
  const settled = new Set(retired);
  for (const id of activeIds) {
    settled.delete(id);
  }
  return settled;
}

export async function adoptAbandonedPendingChatOutboxJournals(
  storage: Storage,
  gatewayOwner: string,
  recoveryOwner: string,
  tabId: string,
): Promise<boolean> {
  if (!navigator.locks) {
    return false;
  }
  const tabs = new Set<string>();
  for (const key of journalKeys(storage, PENDING_JOURNAL_PREFIX)) {
    try {
      const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (
        isRecord(value) &&
        value.gatewayOwner === gatewayOwner &&
        value.recoveryOwner === recoveryOwner &&
        typeof value.tabId === "string" &&
        value.tabId !== tabId
      ) {
        tabs.add(value.tabId);
      }
    } catch {}
  }
  let blocked = false;
  for (const sourceTab of tabs) {
    await navigator.locks.request(
      `openclaw-outbox:${sourceTab}`,
      { ifAvailable: true, mode: "exclusive" },
      (lock) => {
        if (!lock) {
          blocked = true;
          return;
        }
        const candidate = readPendingChatOutboxJournal(
          storage,
          gatewayOwner,
          recoveryOwner,
          sourceTab,
        );
        const current = readPendingChatOutboxJournal(storage, gatewayOwner, recoveryOwner, tabId);
        for (const [scopeKey, session] of Object.entries(candidate.sessions)) {
          const existing = current.sessions[scopeKey];
          const byId = new Map((existing?.queue ?? []).map((item) => [item.id, item]));
          for (const item of session.queue ?? []) {
            if (!byId.has(item.id)) {
              byId.set(item.id, item);
            }
          }
          current.sessions[scopeKey] = {
            ...session,
            queue: [...byId.values()],
            updatedAt: Math.max(existing?.updatedAt ?? 0, session.updatedAt),
          };
        }
        current.retired = [...new Set([...current.retired, ...candidate.retired])];
        writePendingChatOutboxJournal(storage, current);
        writePendingChatOutboxJournal(storage, { ...candidate, sessions: {}, retired: [] });
      },
    );
  }
  return blocked;
}
