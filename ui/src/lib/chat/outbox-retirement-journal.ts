import { getSafeLocalStorage, getSafeSessionStorage } from "../../local-storage.ts";
import {
  observeOutboxRecoveryOwner,
  outboxPayloadTabCandidate,
} from "./outbox-payload-store.runtime.ts";
import {
  readPendingChatOutboxJournal,
  writePendingChatOutboxJournal,
} from "./outbox-pending-journal.ts";
import { storageTargetForGateway, type ChatComposerScope } from "./outbox-store.ts";

const UNRESOLVED_RECOVERY_OWNER = "";

export function isPendingChatOutboxAdmissionRetired(
  gatewayOwner: string,
  recoveryOwner: string | undefined,
  itemId: string,
): boolean {
  const storage = getSafeLocalStorage();
  const tabStorage = getSafeSessionStorage();
  const tabId = tabStorage ? outboxPayloadTabCandidate(tabStorage) : null;
  if (!storage || !tabId) {
    return false;
  }
  return readPendingChatOutboxJournal(
    storage,
    gatewayOwner,
    recoveryOwner ?? UNRESOLVED_RECOVERY_OWNER,
    tabId,
  ).retired.includes(itemId);
}

export function protectChatOutboxRetirement(
  state: ChatComposerScope,
  itemId: string,
): (() => void) | null {
  const storage = getSafeLocalStorage();
  const tabStorage = getSafeSessionStorage();
  const tabId = tabStorage ? outboxPayloadTabCandidate(tabStorage) : null;
  if (!storage || !tabId) {
    return null;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const recoveryOwner = observeOutboxRecoveryOwner(state) ?? UNRESOLVED_RECOVERY_OWNER;
  try {
    const journal = readPendingChatOutboxJournal(
      storage,
      target.gatewayOwner,
      recoveryOwner,
      tabId,
    );
    journal.retired = [...new Set([...journal.retired, itemId])];
    writePendingChatOutboxJournal(storage, journal);
  } catch {
    return null;
  }
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    try {
      const journal = readPendingChatOutboxJournal(
        storage,
        target.gatewayOwner,
        recoveryOwner,
        tabId,
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
      writePendingChatOutboxJournal(storage, journal);
    } catch {
      // A retained tombstone is safer than replaying a user-deleted prompt.
    }
  };
}
