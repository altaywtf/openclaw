import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import {
  prepareSessionBackgroundTargetRetirement,
  prepareChangedSessionBackgroundTargets,
} from "../../sessions/session-background-custody.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { SessionEntry } from "./types.js";

type SessionIdentityDatabase = OpenClawAgentDatabaseClaim["database"];

export function prepareSessionBackgroundEntryChanges(
  database: SessionIdentityDatabase,
  previous: ReadonlyMap<string, SessionEntry | undefined>,
  current: ReadonlyMap<string, SessionEntry | undefined>,
  reset?: true,
): () => void {
  const retirements = [...new Set([...previous.keys(), ...current.keys()])].map((sessionKey) =>
    prepareChangedSessionBackgroundTargets({
      database,
      sessionKey,
      previous: previous.get(sessionKey),
      current: current.get(sessionKey),
      reset,
    }),
  );
  const publish = () => retirements.forEach((retire) => retire());
  return () => {
    if (!deferSqlitePostCommitPublication(database.db, publish)) {
      publish();
    }
  };
}

type SqliteSessionEntryRemovalIdentity = {
  expectedEntry?: SessionEntry;
  sessionKey: string;
};

type SqliteProjectedLifecycleIdentityMutation = {
  removals: Array<{
    expectedEntry: SessionEntry;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    sessionKey: string;
  }>;
};

function toSessionIdentityTarget(entry: SessionEntry | undefined, sessionKeys: readonly string[]) {
  const sessionId = normalizeOptionalString(entry?.sessionId);
  return { ...(sessionId ? { sessionId } : {}), sessionKeys };
}

function emitCommittedSessionEntryRemoval(sessionKey: string, entry?: SessionEntry): void {
  emitSessionIdentityMutation({
    kind: "delete",
    previous: toSessionIdentityTarget(entry, [sessionKey]),
  });
}

export function prepareCommittedSessionEntryRemovals(
  database: SessionIdentityDatabase,
  removals: readonly SqliteSessionEntryRemovalIdentity[],
): () => void {
  const retire = prepareSessionBackgroundTargetRetirement(
    database,
    new Map(removals.map((removal) => [removal.sessionKey, removal.expectedEntry])),
  );
  const previousByKey = new Map<string, ReturnType<typeof toSessionIdentityTarget>>();
  for (const removal of removals) {
    if (!previousByKey.has(removal.sessionKey)) {
      previousByKey.set(
        removal.sessionKey,
        toSessionIdentityTarget(removal.expectedEntry, [removal.sessionKey]),
      );
    }
  }
  return () => {
    retire();
    for (const previous of previousByKey.values()) {
      emitSessionIdentityMutation({ kind: "delete", previous });
    }
  };
}

function emitCommittedSessionEntryChange(params: {
  currentKey: string;
  currentEntry: SessionEntry;
  previousKey: string;
  previousEntry: SessionEntry;
}): void {
  const previous = toSessionIdentityTarget(params.previousEntry, [params.previousKey]);
  const current = toSessionIdentityTarget(params.currentEntry, [params.currentKey]);
  const moved = params.previousKey !== params.currentKey;
  if (!moved && previous.sessionId === current.sessionId) {
    return;
  }
  emitSessionIdentityMutation({
    kind: moved ? "move" : "replace",
    previous,
    current,
  });
}

export function prepareSessionIdentityPublication(
  database: SessionIdentityDatabase,
  previous: ReadonlyMap<string, SessionEntry>,
  current: ReadonlyMap<string, SessionEntry>,
): () => void {
  // Compaction advances its subscribers before this generic publication. Every
  // other UUID or revision change retires the predecessor, including legacy rows.
  const retire = prepareSessionBackgroundEntryChanges(database, previous, current);
  const publish = () => {
    retire();
    const currentKeysBySessionId = new Map<string, string[]>();
    for (const [sessionKey, entry] of current) {
      const sessionId = normalizeOptionalString(entry.sessionId);
      if (sessionId) {
        currentKeysBySessionId.set(sessionId, [
          ...(currentKeysBySessionId.get(sessionId) ?? []),
          sessionKey,
        ]);
      }
    }

    const movedKeysByCurrentKey = new Map<string, string[]>();
    const handledPreviousKeys = new Set<string>();
    const handledCurrentKeys = new Set<string>();
    for (const [sessionKey, entry] of previous) {
      if (current.has(sessionKey)) {
        continue;
      }
      const sessionId = normalizeOptionalString(entry.sessionId);
      const currentKeys = sessionId ? currentKeysBySessionId.get(sessionId) : undefined;
      if (currentKeys?.length !== 1) {
        continue;
      }
      const [currentKey] = currentKeys;
      if (!currentKey) {
        continue;
      }
      movedKeysByCurrentKey.set(currentKey, [
        ...(movedKeysByCurrentKey.get(currentKey) ?? []),
        sessionKey,
      ]);
      handledPreviousKeys.add(sessionKey);
      handledCurrentKeys.add(currentKey);
    }
    for (const [currentKey, previousKeys] of movedKeysByCurrentKey) {
      const currentEntry = current.get(currentKey);
      if (currentEntry) {
        emitSessionIdentityMutation({
          kind: "move",
          previous: toSessionIdentityTarget(currentEntry, previousKeys),
          current: toSessionIdentityTarget(currentEntry, [currentKey]),
        });
      }
    }

    for (const [sessionKey, previousEntry] of previous) {
      const currentEntry = current.get(sessionKey);
      if (currentEntry) {
        handledCurrentKeys.add(sessionKey);
        emitCommittedSessionEntryChange({
          currentEntry,
          currentKey: sessionKey,
          previousEntry,
          previousKey: sessionKey,
        });
      } else if (!handledPreviousKeys.has(sessionKey)) {
        emitCommittedSessionEntryRemoval(sessionKey, previousEntry);
      }
    }

    for (const [sessionKey, currentEntry] of current) {
      if (handledCurrentKeys.has(sessionKey)) {
        continue;
      }
      emitSessionIdentityMutation({
        kind: "create",
        previous: { sessionKeys: [] },
        current: toSessionIdentityTarget(currentEntry, [sessionKey]),
      });
    }
  };
  // Savepoint success is not COMMIT; identity observers can cancel live work.
  return () => {
    if (!deferSqlitePostCommitPublication(database.db, publish)) {
      publish();
    }
  };
}

export function prepareLifecycleIdentityPublication(params: {
  database: SessionIdentityDatabase;
  projected: SqliteProjectedLifecycleIdentityMutation;
  removedSessionKeys: readonly string[];
}): () => void {
  const removedKeys = new Set(params.removedSessionKeys);
  const previous = new Map(
    params.projected.removals
      .filter((removal) => removedKeys.has(removal.sessionKey))
      .map((removal) => [removal.sessionKey, removal.expectedEntry]),
  );
  const current = new Map<string, SessionEntry>();
  for (const upsert of params.projected.upsertedEntries) {
    if (!current.has(upsert.sessionKey) && upsert.expectedEntry) {
      previous.set(upsert.sessionKey, upsert.expectedEntry);
    }
    current.set(upsert.sessionKey, upsert.entry);
  }
  return prepareSessionIdentityPublication(params.database, previous, current);
}
