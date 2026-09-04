import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { admitStoredChatComposerQueueItem } from "../chat/composer-persistence.ts";
import { prepareInitialTurnHandoff } from "../chat/initial-turn-handoff.ts";

/** Returns true when attachment payload ownership moved to the volatile handoff. */
export async function retainRejectedInitialTurn(options: {
  agentId: string;
  attachments: ChatAttachment[];
  context: ApplicationContext;
  error: string;
  message: string;
  mentions?: readonly HumanMention[];
  sessionKey: string;
}): Promise<boolean> {
  const gateway = options.context.gateway.snapshot;
  const settings = loadSettings();
  const rejectedItem = {
    id: generateUUID(),
    text: options.message,
    ...(options.mentions?.length ? { mentions: options.mentions } : {}),
    attachments: options.attachments,
    createdAt: Date.now(),
    kind: "queued" as const,
    refreshSessions: true,
    sendAttempts: 1,
    sendError: options.error,
    sendState: "failed" as const,
    sessionKey: options.sessionKey,
    agentId: normalizeAgentId(options.agentId),
  };
  // The rejected turn already has a server-created destination; never resolve
  // it against the defaults of a later selected route.
  const admission = {
    scope: { sessionKey: rejectedItem.sessionKey, agentId: rejectedItem.agentId },
    awaitingDefaults: false,
    gatewayOwner: storageTargetForGateway(settings.gatewayUrl).gatewayOwner,
    recoveryOwner: gateway.client?.recoveryScopeReady ? gateway.client.recoveryScope : undefined,
  };
  const persisted = await admitStoredChatComposerQueueItem(
    {
      settings,
      assistantAgentId: gateway.assistantAgentId,
      agentsList: options.context.agents.state.agentsList,
      client: gateway.client,
      connected: Boolean(gateway.client),
      hello: gateway.hello,
    },
    admission,
    rejectedItem,
  );
  if (persisted) {
    return false;
  }
  // The server already created this key. A volatile handoff prevents retry
  // from creating a duplicate when large attachments exceed browser storage.
  prepareInitialTurnHandoff(options.sessionKey, {
    ...rejectedItem,
    sendRunId: generateUUID(),
  });
  return true;
}
