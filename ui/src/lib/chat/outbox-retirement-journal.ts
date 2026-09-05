import { getSafeLocalStorage, getSafeSessionStorage } from "../../local-storage.ts";
import {
  observeOutboxRecoveryOwner,
  outboxPayloadTabCandidate,
} from "./outbox-payload-store.runtime.ts";
import {
  readPendingChatOutboxJournal,
  writePendingChatOutboxItem,
  removePendingChatOutboxItem,
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
  const owner = { gatewayOwner: target.gatewayOwner, recoveryOwner, tabId };
  try {
    writePendingChatOutboxItem(storage, owner, itemId);
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
      removePendingChatOutboxItem(storage, owner, itemId);
    } catch {
      // A retained tombstone is safer than replaying a user-deleted prompt.
    }
  };
}
