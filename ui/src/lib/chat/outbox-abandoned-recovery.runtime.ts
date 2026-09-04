import { requestResult, transactionComplete } from "./control-ui-database.runtime.ts";
import {
  chatOutboxDocumentStore,
  mergeLegacyChatOutboxQueues,
  parseChatOutboxDocument,
  retireMigratedChatOutboxQueues,
  type StoredChatOutboxDocument,
} from "./outbox-metadata-document.ts";

const STORE_NAME = "chatOutboxes";

export async function recoverAbandonedChatOutboxes(
  database: IDBDatabase,
  gatewayOwner: string,
  recoveryOwner: string,
  tabId: string,
): Promise<boolean> {
  if (!navigator.locks) {
    return false;
  }
  const scan = database.transaction(STORE_NAME);
  const records = (await requestResult(
    scan.objectStore(STORE_NAME).getAll(),
  )) as StoredChatOutboxDocument[]; // SAFETY: The owning module writes only this document shape.
  await transactionComplete(scan);
  const candidates = records.filter(
    (record) =>
      record.gatewayOwner === gatewayOwner &&
      record.recoveryOwner === recoveryOwner &&
      record.tabId !== tabId,
  );
  const targetKey = JSON.stringify([gatewayOwner, tabId, recoveryOwner]);
  let blocked = false;
  for (const candidate of candidates) {
    await navigator.locks.request(
      `openclaw-outbox:${candidate.tabId}`,
      { ifAvailable: true, mode: "exclusive" },
      async (lock) => {
        if (!lock) {
          blocked = true;
          return;
        }
        const transaction = database.transaction(STORE_NAME, "readwrite", {
          durability: "strict",
        });
        const store = transaction.objectStore(STORE_NAME);
        const [targetValue, sourceValue] = await Promise.all([
          requestResult(store.get(targetKey)),
          requestResult(store.get(candidate.key)),
        ]);
        const source = parseChatOutboxDocument(
          sourceValue,
          candidate.key,
          gatewayOwner,
          recoveryOwner,
          candidate.tabId,
        );
        if (!source) {
          return;
        }
        const target =
          parseChatOutboxDocument(targetValue, targetKey, gatewayOwner, recoveryOwner, tabId) ??
          ({
            key: targetKey,
            version: 1,
            gatewayOwner,
            recoveryOwner,
            tabId,
            sessions: {},
          } satisfies StoredChatOutboxDocument);
        const migrated = mergeLegacyChatOutboxQueues(target, chatOutboxDocumentStore(source), {
          allowForeignTabAttachments: true,
          allowOwnerless: true,
          preferEquivalentIncoming: true,
        });
        retireMigratedChatOutboxQueues(source, migrated);
        store.put(target);
        if (Object.keys(source.sessions).length) {
          store.put(source);
        } else {
          store.delete(source.key);
        }
        await transactionComplete(transaction);
      },
    );
  }
  return blocked;
}
