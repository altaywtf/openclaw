import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventId,
  readTranscriptStorageRows,
  type SqliteTranscriptStorageRow,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  canonicalizeTranscriptEventMedia,
  insertTranscriptRowsWithoutProjectionInTransaction,
  readEventTimestamp,
  scheduleTranscriptProjectionReconcile,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  markSessionTranscriptIndexDirtyInTransaction,
  replaceSessionTranscriptIndexSuffixInTransaction,
  sessionTranscriptIndexNeedsReconcile,
  type SessionTranscriptIndexProjection,
} from "./session-transcript-index.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-rebuild.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

// Build the exact active-branch projection expected before or after a suffix rewrite.
function prepareTranscriptIndexProjection(
  events: readonly TranscriptEvent[],
  seqByIndex: readonly number[],
  createdAtByIndex: readonly number[],
): SessionTranscriptIndexProjection {
  const tree = scanSessionTranscriptTree(events);
  const visibleIndexes =
    tree.nodes.length > 0
      ? selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.index)
      : tree.hasLeafControl
        ? []
        : events.map((_event, index) => index);
  const activeRows: SessionTranscriptIndexProjection["activeRows"] = [];
  let activeMessageCount = 0;
  for (const index of visibleIndexes) {
    const event = events[index];
    if (!shouldProjectActiveEvent(event)) {
      continue;
    }
    const messagePosition = hasTranscriptMessage(event) ? activeMessageCount++ : null;
    const createdAt = createdAtByIndex[index] ?? Date.now();
    const ftsEntry = extractTranscriptIndexEntry(event, createdAt);
    activeRows.push({
      activePosition: activeRows.length,
      contextEligible: transcriptEventContextEligibility(event),
      eventSeq: seqByIndex[index] ?? index,
      messagePosition,
      ...(ftsEntry ? { ftsEntry } : {}),
    });
  }
  return {
    activeMessageCount,
    activeRows,
    indexedSeq: seqByIndex.at(-1) ?? -1,
    leafEventId: tree.appendParentId,
  };
}

export type SqliteTranscriptSuffixMutationPlan = {
  expectedRows: readonly SqliteTranscriptStorageRow[];
  next: readonly TranscriptEvent[];
  nextCreatedAt: readonly number[];
  nextProjection: SessionTranscriptIndexProjection;
  prefixLength: number;
  previousProjection: SessionTranscriptIndexProjection;
  startSeq: number;
};

/** Plans complete-tree projection work before the synchronous SQLite write transaction. */
export function prepareSqliteTranscriptSuffixMutation(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
): SqliteTranscriptSuffixMutationPlan {
  const expectedRows = readTranscriptStorageRows(database, resolved.sessionId);
  const expected = expectedEvents.map(canonicalizeTranscriptEventMedia);
  const next = nextEvents.map(canonicalizeTranscriptEventMedia);
  const expectedJson = expected.map((event) => JSON.stringify(event));
  if (
    expectedRows.length !== expectedJson.length ||
    expectedRows.some((row, index) => row.eventJson !== expectedJson[index])
  ) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${resolved.sessionId}`,
    );
  }

  const nextJson = next.map((event) => JSON.stringify(event));
  let prefixLength = 0;
  while (
    prefixLength < expectedJson.length &&
    prefixLength < nextJson.length &&
    expectedJson[prefixLength] === nextJson[prefixLength]
  ) {
    prefixLength += 1;
  }
  const unchanged = prefixLength === expectedJson.length && prefixLength === nextJson.length;
  if (!unchanged && (next.length > expected.length || prefixLength === 0)) {
    throw new Error(
      `Transcript mutation is not a bounded suffix removal for ${resolved.sessionId}`,
    );
  }

  const startSeq = expectedRows[prefixLength]?.seq ?? (expectedRows.at(-1)?.seq ?? -1) + 1;
  const nextSeqByIndex = next.map((_event, index) =>
    index < prefixLength ? (expectedRows[index]?.seq ?? index) : startSeq + index - prefixLength,
  );
  const previousProjection = prepareTranscriptIndexProjection(
    expected,
    expectedRows.map((row) => row.seq),
    expectedRows.map((row) => row.createdAt),
  );
  const storedCreatedAtByEventId = new Map(
    expected.flatMap((event, index) => {
      const eventId = readTranscriptEventId(event);
      const createdAt = expectedRows[index]?.createdAt;
      return eventId && createdAt !== undefined ? [[eventId, createdAt] as const] : [];
    }),
  );
  const nextCreatedAt = next.map((event, index) => {
    if (index < prefixLength) {
      return expectedRows[index]?.createdAt ?? Date.now();
    }
    const eventId = readTranscriptEventId(event);
    return (
      (eventId ? storedCreatedAtByEventId.get(eventId) : undefined) ??
      readEventTimestamp(event) ??
      Date.now()
    );
  });
  return {
    expectedRows,
    next,
    nextCreatedAt,
    nextProjection: prepareTranscriptIndexProjection(next, nextSeqByIndex, nextCreatedAt),
    prefixLength,
    previousProjection,
    startSeq,
  };
}

/** Mutates an exact transcript suffix without rotating generation or invalidating its projection. */
export function replaceSqliteTranscriptSuffixInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  plan: SqliteTranscriptSuffixMutationPlan,
): void {
  // Recheck the pre-transaction snapshot before applying its prepared projection plan.
  const storedRows = readTranscriptStorageRows(database, resolved.sessionId);
  if (
    storedRows.length !== plan.expectedRows.length ||
    storedRows.some((row, index) => {
      const expected = plan.expectedRows[index];
      return (
        row.seq !== expected?.seq ||
        row.createdAt !== expected.createdAt ||
        row.eventJson !== expected.eventJson
      );
    })
  ) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${resolved.sessionId}`,
    );
  }
  if (plan.prefixLength === plan.expectedRows.length && plan.prefixLength === plan.next.length) {
    return;
  }

  const projectionIsHealthy = !sessionTranscriptIndexNeedsReconcile(
    database.db,
    resolved.sessionId,
  );

  // Preserve the suffix's established retry owner before replacing identity rows.
  const db = getSessionKysely(database.db);
  const suffixIdentityKeys = new Map(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select(["event_id", "message_idempotency_key"])
        .where("session_id", "=", resolved.sessionId)
        .where("seq", ">=", plan.startSeq),
    ).rows.map((row) => [row.event_id, row.message_idempotency_key]),
  );
  const retainedIdempotencyKeys = new Set(
    plan.next.slice(plan.prefixLength).flatMap((event) => {
      const eventId = readTranscriptEventId(event);
      const key = eventId ? suffixIdentityKeys.get(eventId) : undefined;
      return key ? [key] : [];
    }),
  );

  // Replace raw and identity suffix rows without touching generation or mutation time yet.
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("transcript_event_identities")
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", plan.startSeq),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("transcript_events")
      .where("session_id", "=", resolved.sessionId)
      .where("seq", ">=", plan.startSeq),
  );
  insertTranscriptRowsWithoutProjectionInTransaction(
    database,
    resolved.sessionId,
    plan.next.slice(plan.prefixLength).map((event, index) => {
      const seq = plan.startSeq + index;
      const createdAt = plan.nextCreatedAt[plan.prefixLength + index] ?? Date.now();
      const eventId = readTranscriptEventId(event);
      const retainedIdempotencyKey = eventId ? suffixIdentityKeys.get(eventId) : undefined;
      if (retainedIdempotencyKey) {
        return {
          event,
          seq,
          createdAt,
          messageIdempotencyKey: retainedIdempotencyKey,
        };
      }
      return { event, seq, createdAt };
    }),
    retainedIdempotencyKeys,
  );

  // Repair healthy derived rows inline; preserve dirty-state ownership for the worker.
  if (projectionIsHealthy) {
    replaceSessionTranscriptIndexSuffixInTransaction(database.db, resolved.sessionId, {
      unchangedBeforeSeq: plan.startSeq,
      previous: plan.previousProjection,
      next: plan.nextProjection,
    });
  } else {
    markSessionTranscriptIndexDirtyInTransaction(database.db, resolved.sessionId);
    scheduleTranscriptProjectionReconcile(database, resolved.sessionId, true, {});
  }
  touchTranscriptMutationInTransaction(database, resolved.sessionId);
}
