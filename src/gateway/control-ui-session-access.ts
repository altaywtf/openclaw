import { visitSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMediaReferenceForComparison } from "../media/media-reference-comparison.js";
import { splitMediaFromOutput } from "../media/parse.js";
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

const MEDIA_SOURCE_FIELDS = new Set(["url", "path", "source", "mediaUrl", "mediaPath"]);

function mediaSourceMatches(candidate: string, source: string): boolean {
  return (
    normalizeMediaReferenceForComparison(candidate) === normalizeMediaReferenceForComparison(source)
  );
}

function textReferencesMediaSource(text: string, source: string): boolean {
  return (
    splitMediaFromOutput(text).mediaUrls?.some((candidate) =>
      mediaSourceMatches(candidate, source),
    ) === true
  );
}

function valueReferencesMediaSource(
  value: unknown,
  source: string,
  field?: string,
  depth = 0,
  allowTextReferences = true,
): boolean {
  if (typeof value === "string") {
    return MEDIA_SOURCE_FIELDS.has(field ?? "")
      ? mediaSourceMatches(value, source)
      : allowTextReferences &&
          (field === "text" || field === "content") &&
          textReferencesMediaSource(value, source);
  }
  if (depth >= 32 || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      valueReferencesMediaSource(entry, source, undefined, depth + 1, allowTextReferences),
    );
  }
  return Object.entries(value).some(([key, entry]) =>
    valueReferencesMediaSource(entry, source, key, depth + 1, allowTextReferences),
  );
}

function sessionReferencesMediaSource(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  source: string;
  storePath: string;
}): boolean {
  let found = false;
  try {
    visitSessionTranscriptMessageEvents(params, (entry) => {
      // SAFETY: transcript events are parsed records; only optional role fields are inspected.
      const event = entry.event as {
        message?: { role?: unknown };
        role?: unknown;
      };
      const role = event.message?.role ?? event.role;
      // Tool results can own rendered attachments, but their text must not
      // grant file access merely by mentioning a MEDIA directive.
      if (
        !found &&
        (role === "assistant" || role === "user" || role === "toolResult") &&
        valueReferencesMediaSource(entry.event, params.source, undefined, 0, role === "assistant")
      ) {
        found = true;
      }
    });
  } catch {
    return false;
  }
  return found;
}

/** Resolve a session only when the current Gateway client may still discover it. */
export function resolveControlUiSessionAccess(
  sessionKey: string,
  cfg: OpenClawConfig,
  client: GatewayClient | null,
  mediaSource?: string,
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
  if (
    mediaSource &&
    !sessionReferencesMediaSource({
      agentId: target.agentId,
      sessionId: entry.sessionId,
      sessionKey: target.canonicalKey,
      source: mediaSource,
      storePath,
    })
  ) {
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
