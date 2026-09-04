import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { SessionBackgroundTarget } from "../sessions/session-background-custody.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type SystemEventTurn = SessionBackgroundTarget & { source: InputProvenance };

type SystemEventOwnership = { agentId?: string; turn?: SystemEventTurn };

const SYSTEM_EVENT_OWNERSHIP_KEY = Symbol.for("openclaw.systemEvents.ownership");

// The queue is process-global, so duplicated runtime chunks must share its
// object-identity metadata or another agent can consume an owner-marked event.
const owners = resolveGlobalSingleton(
  SYSTEM_EVENT_OWNERSHIP_KEY,
  () => new WeakMap<object, SystemEventOwnership>(),
);

function normalizeOwnerAgentId(agentId: string | null | undefined): string | null {
  return normalizeOptionalString(agentId) ? normalizeAgentId(agentId) : null;
}

export function withSystemEventOwner<T extends object>(options: T, agentId: string): T {
  recordSystemEventOwner(options, agentId);
  return options;
}

export function withSystemEventTurn<T extends object>(options: T, turn: SystemEventTurn): T {
  owners.set(options, { agentId: turn.agentId, turn });
  return options;
}

export function resolveSystemEventTurn(event: object): SystemEventTurn | undefined {
  return owners.get(event)?.turn;
}

export function recordSystemEventOwner(event: object, agentId: string | null): void {
  const normalized = normalizeOwnerAgentId(agentId);
  if (normalized) {
    owners.set(event, { ...owners.get(event), agentId: normalized });
  }
}

export function cloneSystemEventOwner(source: object, clone: object): void {
  const ownership = owners.get(source);
  if (ownership) {
    owners.set(clone, ownership);
  }
}

export function resolveSystemEventOwnerAgentId(event: object): string | null {
  return owners.get(event)?.agentId ?? null;
}

export function selectAgentSystemEvents<T extends object>(
  events: readonly T[],
  agentId: string,
): T[] {
  const normalizedAgentId = normalizeAgentId(agentId);
  // Unowned events retain their legacy first-consumer semantics. Owner-marked
  // events stay invisible to other agents sharing the transient global queue.
  return events.filter((event) => {
    const ownerAgentId = resolveSystemEventOwnerAgentId(event);
    return ownerAgentId === null || ownerAgentId === normalizedAgentId;
  });
}
