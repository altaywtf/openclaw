import {
  dispatchBackgroundTurn,
  type BackgroundTurnResult,
} from "../auto-reply/reply/background-turn.js";
import { getRuntimeConfigSnapshot } from "../config/config.js";
import { readExactSessionEntryRowValidated } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  INTERNAL_PROVENANCE_SOURCE_CHANNEL,
  normalizeInputProvenance,
} from "../sessions/input-provenance.js";
import { isSessionBackgroundTargetRetired } from "../sessions/session-background-custody.js";
import { isSameOpenClawAgentDatabase } from "../state/openclaw-agent-db-identity.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import { emitBackgroundTurnHeartbeatEvent } from "./heartbeat-event-projection.js";
import {
  resolveSystemEventTurn,
  selectAgentSystemEvents,
  type SystemEventTurn,
} from "./system-event-ownership.js";
import { buildSessionEventPrompt, fitsSessionEventPromptBudget } from "./system-event-prompt.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  type SystemEvent,
} from "./system-events.js";

export type SessionEventTurnResult = BackgroundTurnResult & { eventsConsumed: number };

function sameTarget(left?: SystemEventTurn, right?: SystemEventTurn): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.agentId === right.agentId &&
      left.sessionKey === right.sessionKey &&
      left.databaseClaim.identity === right.databaseClaim.identity &&
      left.sessionId === right.sessionId &&
      left.lifecycleRevision === right.lifecycleRevision &&
      left.lifecycleGeneration === right.lifecycleGeneration &&
      JSON.stringify(normalizeInputProvenance(left.source)) ===
        JSON.stringify(normalizeInputProvenance(right.source)),
    )
  );
}

function isCurrent(target: SystemEventTurn): boolean {
  if (
    isSessionBackgroundTargetRetired(target) ||
    target.abortController.signal.aborted ||
    target.lifecycleGeneration !== getAgentEventLifecycleGeneration()
  ) {
    return false;
  }
  const entry = readExactSessionEntryRowValidated(
    target.databaseClaim.database,
    target.sessionKey,
  )?.entry;
  return (
    entry?.sessionId === target.sessionId && entry?.lifecycleRevision === target.lifecycleRevision
  );
}

/** One carrier start owns one homogeneous batch; later routes retain their own accounting. */
export async function runSessionEventTurn(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  signal?: AbortSignal;
  onStarted?: (runId: string) => void;
}): Promise<SessionEventTurnResult | undefined> {
  const configSnapshot = getRuntimeConfigSnapshot();
  const cfg = configSnapshot ?? params.cfg;
  let eventsConsumed = 0;
  const consume = (events: readonly SystemEvent[]) => {
    eventsConsumed += consumeSelectedSystemEventEntries(params.sessionKey, events).length;
  };
  const skipped = (reason: string): SessionEventTurnResult => ({
    status: "skipped",
    reason,
    executionStarted: false,
    eventsConsumed,
    durationMs: 0,
  });
  const retire = (event: SystemEvent) => {
    const before = eventsConsumed;
    consume([event]);
    if (eventsConsumed > before) {
      emitBackgroundTurnHeartbeatEvent(skipped("lifecycle-invalidated"), event.deliveryContext);
    }
  };
  const queued = selectAgentSystemEvents(
    peekSystemEventEntries(params.sessionKey),
    params.agentId,
  ).filter((event) => {
    const target = resolveSystemEventTurn(event);
    if (target && !isCurrent(target)) {
      retire(event);
      return false;
    }
    return true;
  });
  const first = queued[0];
  if (!first) {
    return eventsConsumed ? skipped("lifecycle-invalidated") : undefined;
  }
  const originalTarget = resolveSystemEventTurn(first);
  const events: SystemEvent[] = [];
  const exec = originalTarget?.source.sourceTool === "exec";
  for (const event of queued) {
    if (
      !sameTarget(originalTarget, resolveSystemEventTurn(event)) ||
      JSON.stringify(event.deliveryContext) !== JSON.stringify(first.deliveryContext)
    ) {
      continue;
    }
    // Sanitization and failure framing can expand text; budget the actual prompt projection.
    if (
      events.length &&
      !fitsSessionEventPromptBudget(
        [...events, event].map((entry) => entry.text),
        exec,
      )
    ) {
      break;
    }
    events.push(event);
  }
  let claimed = false;
  let changedBatch = false;
  let configurationChanged = false;
  const signal = AbortSignal.any([
    ...events.flatMap((event) => {
      const owned = resolveSystemEventTurn(event);
      return owned ? [owned.abortController.signal] : [];
    }),
    ...(params.signal ? [params.signal] : []),
  ]);
  const route = first.deliveryContext;
  const result = await dispatchBackgroundTurn({
    ...params,
    cfg,
    prompt: buildSessionEventPrompt(
      events.map((event) => event.text),
      {
        exec,
        deliverToUser: Boolean(route?.channel && route.to),
      },
    ),
    source: originalTarget?.source ?? {
      kind: "internal_system",
      sourceTool: "system-event",
      sourceChannel: INTERNAL_PROVENANCE_SOURCE_CHANNEL,
    },
    deliveryContext: route,
    policy: { trigger: "background", terminalReplyExpectation: "optional" },
    signal,
    expectedSessionId: originalTarget?.sessionId,
    claim: (operation, _storePath, databaseClaim) => {
      configurationChanged = getRuntimeConfigSnapshot() !== configSnapshot;
      if (configurationChanged) {
        throw new DOMException("System event configuration changed before admission", "AbortError");
      }
      const pending = new Set(peekSystemEventEntries(params.sessionKey).map((event) => event.id));
      for (const event of events) {
        const owned = resolveSystemEventTurn(event);
        if (owned && !isCurrent(owned)) {
          retire(event);
          changedBatch = true;
        }
      }
      changedBatch ||= events.some((event) => !pending.has(event.id));
      if (changedBatch) {
        throw new DOMException(
          "System event was consumed or retired before admission",
          "AbortError",
        );
      }
      signal.throwIfAborted();
      databaseClaim?.assertCurrent();
      if (
        !databaseClaim ||
        operation.key !== params.sessionKey ||
        (originalTarget &&
          !isSameOpenClawAgentDatabase(
            databaseClaim.database,
            originalTarget.databaseClaim.database,
          ))
      ) {
        throw new DOMException("System event target was retired", "AbortError");
      }
      // UUID validation and consumption stay synchronous, before hooks or model work.
      consume(events);
      claimed = true;
    },
  });
  if (!claimed) {
    const pending = new Set(peekSystemEventEntries(params.sessionKey).map((event) => event.id));
    if (
      (result.status === "skipped" && result.reason === "active-run") ||
      configurationChanged ||
      ((changedBatch || signal.aborted) && events.some((event) => pending.has(event.id)))
    ) {
      const retained = skipped("active-run");
      emitBackgroundTurnHeartbeatEvent(retained, route);
      return retained;
    }
    consume(events);
  }
  emitBackgroundTurnHeartbeatEvent(result, route);
  return { ...result, eventsConsumed };
}
