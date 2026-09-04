import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readExactSessionEntryRowValidated } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { logWarn } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { INTERNAL_PROVENANCE_SOURCE_CHANNEL } from "../sessions/input-provenance.js";
import {
  isSessionBackgroundTargetRetired,
  releaseSessionBackgroundTarget,
  retainSessionBackgroundTarget,
} from "../sessions/session-background-custody.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { OpenClawAgentDatabaseClaim } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import {
  resolveEventSessionKeyForPolicy,
  type EventSessionRoutingPolicy,
} from "./event-session-routing.js";
import { withSystemEventTurn, type SystemEventTurn } from "./system-event-ownership.js";
import { enqueueSystemEventWithReceipt } from "./system-events.js";

export function captureExecCompletionTarget(params: {
  sessionKey?: string;
  agentId?: string;
  sessionStore?: string;
  eventRouting?: EventSessionRoutingPolicy;
}): SystemEventTurn | undefined {
  if (!params.sessionKey || isSubagentSessionKey(params.sessionKey)) {
    return undefined;
  }
  const agentId = params.agentId ?? parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!agentId) {
    return undefined;
  }
  let databaseClaim: OpenClawAgentDatabaseClaim | undefined;
  try {
    const scope = resolveSqliteScope({
      agentId,
      sessionKey: resolveEventSessionKeyForPolicy(params.sessionKey, params.eventRouting),
      storePath: resolveSessionStorePathCore(params.sessionStore, { agentId }),
    });
    const opened = retainOpenClawAgentDatabaseReadOnly(toDatabaseOptions(scope));
    if (!opened.found) {
      return undefined;
    }
    databaseClaim = opened.claim;
    const entry = readExactSessionEntryRowValidated(
      databaseClaim.database,
      scope.sessionKey,
    )?.entry;
    const target: SystemEventTurn = {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      sessionId: entry?.sessionId,
      lifecycleRevision: entry?.lifecycleRevision,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      abortController: new AbortController(),
      databaseClaim,
      source: {
        kind: "internal_system",
        sourceTool: "exec",
        sourceChannel: INTERNAL_PROVENANCE_SOURCE_CHANNEL,
      },
    };
    retainSessionBackgroundTarget(target);
    return target;
  } catch {
    databaseClaim?.release();
    // Optional notification custody must never veto an already authorized command.
    logWarn("Exec completion notifications unavailable: source session could not be captured.");
    return undefined;
  }
}

export function enqueueExecCompletion(
  text: string,
  options: Parameters<typeof enqueueSystemEventWithReceipt>[1],
  target: SystemEventTurn,
): (() => boolean) | null {
  if (isSessionBackgroundTargetRetired(target) || target.abortController.signal.aborted) {
    releaseSessionBackgroundTarget(target);
    return null;
  }
  const remove = enqueueSystemEventWithReceipt(
    text,
    withSystemEventTurn({ ...options, sessionKey: target.sessionKey }, target),
    { allowDuplicate: true },
  );
  if (!remove) {
    releaseSessionBackgroundTarget(target);
    return null;
  }
  return () => {
    const removed = remove();
    // A settled poll cannot abort a continuation that already claimed this occurrence.
    if (removed) {
      target.abortController.abort();
    }
    return removed;
  };
}
