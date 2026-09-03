import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadSessionEntriesForTarget } from "./server-methods/sessions-shared.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "./session-request-agent.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import { buildGatewaySessionRow } from "./session-utils.js";

export type ControlUiSessionAccess = {
  sessionKey: string;
  title?: string;
  derivedTitle?: string;
  agentId: string;
  kind?: string;
  channel?: string;
  updatedAt?: number | null;
  lastMessagePreview?: string;
  archived?: boolean;
};

/** Resolve a session only when the current Gateway client may still discover it. */
export function resolveControlUiSessionAccess(
  sessionKey: string,
  cfg: OpenClawConfig,
  client: GatewayClient | null,
): ControlUiSessionAccess | null {
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey);
  if (!requestedAgent.ok) {
    return null;
  }
  const { target, storePath, store, entry } = loadSessionEntriesForTarget({
    key: sessionKey,
    cfg,
    ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
  });
  if (!entry) {
    return null;
  }
  const entryFilter = createSessionListEntryFilter({ client, cfg });
  if (entryFilter && !entryFilter(target.canonicalKey, entry)) {
    return null;
  }
  const row = buildGatewaySessionRow({
    cfg,
    storePath,
    store,
    key: target.canonicalKey,
    entry,
    includeDerivedTitles: true,
    includeLastMessage: true,
    skipTranscriptUsageFallback: true,
  });
  return {
    sessionKey: row.key,
    agentId: row.agentId ?? target.agentId,
    title: row.displayName,
    derivedTitle: row.derivedTitle,
    kind: row.kind,
    channel: row.channel,
    updatedAt: row.updatedAt,
    lastMessagePreview: row.lastMessagePreview,
    archived: row.archived,
  };
}
