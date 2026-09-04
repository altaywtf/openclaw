import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");

type PreparedModelRuntimePublicationEvent =
  | { phase: "catalog-published" | "invalidated" | "published" }
  | { phase: "failed" | "catalog-failed"; error: Error };

const publicationListeners = new Set<(event: PreparedModelRuntimePublicationEvent) => void>();
let publicationRevision = 0;

export function getPreparedModelRuntimePublicationRevision(): number {
  return publicationRevision;
}

/** Observes committed prepared model/auth generations without starting discovery. */
export function registerPreparedModelRuntimePublicationListener(
  listener: (event: PreparedModelRuntimePublicationEvent) => void,
): () => void {
  publicationListeners.add(listener);
  return () => publicationListeners.delete(listener);
}

export function notifyPreparedModelRuntimePublication(
  event: PreparedModelRuntimePublicationEvent,
): void {
  publicationRevision += 1;
  for (const listener of publicationListeners) {
    try {
      listener(event);
    } catch (error) {
      log.warn(`prepared model runtime publication listener failed: ${String(error)}`);
    }
  }
}

export function resetPreparedModelRuntimePublicationListenersForTest(): void {
  publicationListeners.clear();
}
