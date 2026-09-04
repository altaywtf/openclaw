import { isRecord } from "@openclaw/normalization-core/record-coerce";
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

function pendingJournalKey(gatewayOwner: string, recoveryOwner: string, tabId: string): string {
  return `${PENDING_JOURNAL_PREFIX}${encodeURIComponent(gatewayOwner)}:${encodeURIComponent(recoveryOwner)}:${encodeURIComponent(tabId)}`;
}

export function readPendingChatOutboxJournal(
  storage: Storage,
  gatewayOwner: string,
  recoveryOwner: string,
  tabId: string,
): PendingChatOutboxJournal {
  const key = pendingJournalKey(gatewayOwner, recoveryOwner, tabId);
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
      throw new Error("Invalid pending chat journal");
    }
    const sessions: Record<string, StoredComposerSession> = {};
    for (const [scopeKey, storedSession] of Object.entries(value.sessions)) {
      const session = normalizeStoredSession(storedSession);
      if (session?.queue?.length) {
        sessions[scopeKey] = session;
      }
    }
    const retired = Array.isArray(value.retired)
      ? value.retired.filter((id): id is string => typeof id === "string")
      : [];
    return { version: 1, gatewayOwner, recoveryOwner, tabId, sessions, retired };
  } catch {
    return { version: 1, gatewayOwner, recoveryOwner, tabId, sessions: {}, retired: [] };
  }
}

export function writePendingChatOutboxJournal(
  storage: Storage,
  journal: PendingChatOutboxJournal,
): void {
  const key = pendingJournalKey(journal.gatewayOwner, journal.recoveryOwner, journal.tabId);
  if (Object.keys(journal.sessions).length || journal.retired.length) {
    storage.setItem(key, JSON.stringify(journal));
  } else {
    storage.removeItem(key);
  }
}

export function omitPendingChatOutboxAdmissions(
  journal: PendingChatOutboxJournal,
  active: ReadonlySet<string>,
): PendingChatOutboxJournal {
  if (!active.size) {
    return journal;
  }
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
  const candidates = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key?.startsWith(PENDING_JOURNAL_PREFIX) === true)
    .flatMap((key) => {
      try {
        const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
        return isRecord(value) &&
          value.gatewayOwner === gatewayOwner &&
          value.recoveryOwner === recoveryOwner &&
          typeof value.tabId === "string" &&
          value.tabId !== tabId
          ? [readPendingChatOutboxJournal(storage, gatewayOwner, recoveryOwner, value.tabId)]
          : [];
      } catch {
        return [];
      }
    });
  let blocked = false;
  for (const candidate of candidates) {
    await navigator.locks.request(
      `openclaw-outbox:${candidate.tabId}`,
      { ifAvailable: true, mode: "exclusive" },
      (lock) => {
        if (!lock) {
          blocked = true;
          return;
        }
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
        storage.removeItem(pendingJournalKey(gatewayOwner, recoveryOwner, candidate.tabId));
      },
    );
  }
  return blocked;
}
