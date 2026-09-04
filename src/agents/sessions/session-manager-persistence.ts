import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  ensureSessionEntrySync,
  replaceTranscriptSuffixEventsSync,
  type TranscriptEntryAnchor,
} from "../../config/sessions/session-accessor.js";
import {
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  type InitialSessionTranscriptWriter,
} from "../../config/sessions/transcript-write-context.js";
import { copyCodeModeSourceAppendOptions } from "../transcript-code-mode-source.js";
import { isIndexedSessionEntry, parseOpaqueLeafEntry } from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import type { AppendPersistenceOptions, FileEntry, SessionEntry } from "./session-manager-types.js";

type PersistRecordResult =
  | undefined
  | {
      anchor?: TranscriptEntryAnchor;
      appended: boolean;
      adoptedMessageId?: string;
      effectiveParentId: string | null;
    };

function requireTranscriptEventAppend(
  result: ReturnType<typeof appendTranscriptEventSync>,
  message: string,
): void {
  if (result.ok && result.value) {
    return;
  }
  const cause = result.ok ? { code: "transcript-event-not-appended" as const } : result.error;
  throw new Error(`${message}: ${cause.code}`, { cause });
}

export class SessionManagerPersistence extends SessionManagerCore {
  #initialWriter: InitialSessionTranscriptWriter | undefined;

  removeTrailingEntries(
    predicate: (entry: SessionEntry) => boolean,
    options?: { preserveTrailing?: (entry: SessionEntry) => boolean },
  ): number {
    // Prepare on a detached tree so failed persistence leaves live readers and retries unchanged.
    const prepared = new SessionManagerPersistence(
      this.cwd,
      this.persistenceTarget,
      this.fileEntries,
      undefined,
      this.transcriptMutationAt,
    );
    prepared.opaqueFileEntries = this.opaqueFileEntries.map((entry) => ({ ...entry }));
    prepared.buildIndex();
    prepared.boundedContextLimits = this.boundedContextLimits;
    prepared.boundedContextIncomplete = this.boundedContextIncomplete;
    prepared.persistedBoundaryCount = this.persistedBoundaryCount;
    prepared.ensureCompletePersistedHistory();
    const expectedPersistedEntries = prepared.getPersistedFileEntries();
    let preservedStart = prepared.fileEntries.length;
    while (preservedStart > 1) {
      const entry = prepared.fileEntries[preservedStart - 1];
      if (!isIndexedSessionEntry(entry) || !options?.preserveTrailing?.(entry)) {
        break;
      }
      preservedStart -= 1;
    }

    let removeStart = preservedStart;
    while (removeStart > 1) {
      const entry = prepared.fileEntries[removeStart - 1];
      if (!isIndexedSessionEntry(entry) || !predicate(entry)) {
        break;
      }
      removeStart -= 1;
    }
    if (removeStart === preservedStart) {
      return 0;
    }

    const shiftOpaqueIndexesAfterRemoval = (start: number, count: number): void => {
      for (const opaqueEntry of prepared.opaqueFileEntries) {
        const removedBeforeOpaque = Math.max(0, Math.min(count, opaqueEntry.index - start));
        opaqueEntry.index -= removedBeforeOpaque;
      }
    };
    const removedCount = preservedStart - removeStart;
    const persistedPrefixLength =
      removeStart + prepared.opaqueFileEntries.filter((entry) => entry.index < removeStart).length;
    shiftOpaqueIndexesAfterRemoval(removeStart, removedCount);
    const removedEntries = prepared.fileEntries.splice(removeStart, removedCount) as SessionEntry[];
    const removedParentById = new Map(
      removedEntries.map((entry) => [entry.id, entry.parentId] as const),
    );
    for (let index = removeStart; index < prepared.fileEntries.length;) {
      const entry = prepared.fileEntries[index];
      if (
        isIndexedSessionEntry(entry) &&
        entry.type === "label" &&
        removedParentById.has(entry.targetId)
      ) {
        removedParentById.set(entry.id, entry.parentId);
        shiftOpaqueIndexesAfterRemoval(index, 1);
        prepared.fileEntries.splice(index, 1);
        continue;
      }
      index += 1;
    }

    const resolveRetainedParentId = (parentId: string | null): string | null => {
      const seen = new Set<string>();
      let currentId = parentId;
      while (currentId && removedParentById.has(currentId) && !seen.has(currentId)) {
        seen.add(currentId);
        currentId = removedParentById.get(currentId) ?? null;
      }
      return currentId;
    };
    const replacementParentId = resolveRetainedParentId(removedEntries[0]?.parentId ?? null);
    prepared.fileEntries = prepared.fileEntries.map((entry) => {
      if (!isIndexedSessionEntry(entry)) {
        return entry;
      }
      const parentId = resolveRetainedParentId(entry.parentId);
      return parentId === entry.parentId ? entry : ({ ...entry, parentId } as SessionEntry);
    });
    prepared.opaqueFileEntries = prepared.opaqueFileEntries.map((opaqueEntry) => {
      if (!isRecord(opaqueEntry.record)) {
        return opaqueEntry;
      }
      const record = opaqueEntry.record;
      const parentId =
        record.parentId === null || typeof record.parentId === "string"
          ? resolveRetainedParentId(record.parentId)
          : undefined;
      const leafEntry = parseOpaqueLeafEntry(record);
      const targetId = leafEntry ? resolveRetainedParentId(leafEntry.targetId) : undefined;
      const appendParentId =
        leafEntry?.appendParentId !== undefined
          ? resolveRetainedParentId(leafEntry.appendParentId)
          : undefined;
      if (
        (parentId === undefined || parentId === record.parentId) &&
        (targetId === undefined || targetId === leafEntry?.targetId) &&
        (appendParentId === undefined || appendParentId === leafEntry?.appendParentId)
      ) {
        return opaqueEntry;
      }
      return {
        ...opaqueEntry,
        record: {
          ...record,
          ...(parentId !== undefined ? { parentId } : {}),
          ...(targetId !== undefined ? { targetId } : {}),
          ...(appendParentId !== undefined ? { appendParentId } : {}),
        },
      };
    });

    prepared.clampOpaqueFileEntryIndexes();
    prepared.buildIndex();
    prepared.leafId = prepared.resolveCanonicalParentId(replacementParentId);
    prepared.appendParentId = replacementParentId;
    const events = prepared.getPersistedFileEntries(prepared.appendParentId, prepared.appendMode);
    let committedMutationAt: number | null | undefined;
    if (
      this.persistenceTarget &&
      !replaceTranscriptSuffixEventsSync(
        this.persistenceTarget,
        expectedPersistedEntries,
        events,
        persistedPrefixLength,
        prepared.transcriptMutationAt,
        (mutationAt) => {
          committedMutationAt = mutationAt;
        },
      )
    ) {
      throw new Error(`SQLite session changed before trimming ${this.sessionId}`);
    }
    // SAFETY: The reload codec partitions opaque records from canonical entries.
    this.setLoadedSessionTarget(this.persistenceTarget, events as FileEntry[]);
    this.boundedContextIncomplete = false;
    this.persistedBoundaryCount = undefined;
    this.transcriptMutationAt = committedMutationAt;
    return removedEntries.length;
  }

  protected persistRecord(entry: unknown, options?: AppendPersistenceOptions): PersistRecordResult {
    if (this.persistenceTarget) {
      return this.persistSqliteRecord(entry, options);
    }
    return undefined;
  }

  persist(entry: SessionEntry, options?: AppendPersistenceOptions): PersistRecordResult {
    return this.persistRecord(entry, options);
  }

  private persistSqliteRecord(
    entry: unknown,
    options?: AppendPersistenceOptions,
  ): PersistRecordResult {
    if (!this.persistenceTarget) {
      return undefined;
    }
    const scope = this.persistenceTarget;
    const inheritedWriter = getOwnedSessionTranscriptInitialWriter({ sessionTarget: scope });
    this.#initialWriter ??= inheritedWriter;
    const initialWriter = this.#initialWriter;
    if (initialWriter) {
      initialWriter.assertActive();
      if (!initialWriter.committedFence && inheritedWriter !== initialWriter) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      // Retained managers keep this exact owner; a later attempt cannot lend them a new claim.
      Object.assign(
        scope,
        initialWriter.committedFence ?? {
          expectedLifecycleRevision: undefined,
          expectedWriterRunId: initialWriter.writerRunId,
        },
      );
    }
    if (this.persistenceHeaderPending || (initialWriter && !initialWriter.committedFence)) {
      if (
        !ensureSessionEntrySync(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
        })
      ) {
        throw new Error("Session transcript header was not persisted");
      }
      initialWriter?.assertActive();
      if (initialWriter?.committedFence) {
        Object.assign(scope, initialWriter.committedFence);
      }
    }
    if (this.persistenceHeaderPending) {
      const header = this.fileEntries[0];
      if (!header || header.type !== "session") {
        throw new Error("Session transcript header was not persisted");
      }
      let committedMutationAt: number | null | undefined;
      requireTranscriptEventAppend(
        appendTranscriptEventSync(scope, header, {
          captureMutationAtInTransaction: (mutationAt) => {
            committedMutationAt = mutationAt;
          },
        }),
        "Session transcript header was not persisted",
      );
      this.transcriptMutationAt = committedMutationAt;
      this.persistenceHeaderPending = false;
    }
    const leafEntry = parseOpaqueLeafEntry(entry);
    if (leafEntry) {
      let committedMutationAt: number | null | undefined;
      requireTranscriptEventAppend(
        appendTranscriptEventSync(scope, entry, {
          captureMutationAtInTransaction: (mutationAt) => {
            committedMutationAt = mutationAt;
          },
        }),
        `Session transcript leaf control was not persisted: ${leafEntry.id}`,
      );
      this.transcriptMutationAt = committedMutationAt;
      return undefined;
    }
    if (!isIndexedSessionEntry(entry)) {
      return undefined;
    }
    if (entry.type !== "message") {
      let committedMutationAt: number | null | undefined;
      requireTranscriptEventAppend(
        appendTranscriptEventSync(scope, entry, {
          ...(options?.appendIntent === "active-branch"
            ? { appendIntent: options.appendIntent }
            : {}),
          captureMutationAtInTransaction: (mutationAt) => {
            committedMutationAt = mutationAt;
          },
        }),
        `Session transcript entry was not persisted: ${entry.id}`,
      );
      this.transcriptMutationAt = committedMutationAt;
      return undefined;
    }
    const appendOptions = copyCodeModeSourceAppendOptions(options, {
      cwd: this.cwd,
      eventId: entry.id,
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.idempotencyLookup ? { idempotencyLookup: options.idempotencyLookup } : {}),
      message: entry.message,
      now: Date.parse(entry.timestamp),
      parentId: entry.parentId,
      ...(options?.appendIntent === "active-branch" ? { appendIntent: options.appendIntent } : {}),
    } satisfies Parameters<typeof appendTranscriptMessageSync>[1]);
    const outcome = appendTranscriptMessageSync(scope, appendOptions);
    if (!outcome.ok) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`, {
        cause: outcome.error,
      });
    }
    const result = outcome.value;
    if (!result) {
      throw new Error(`Session transcript message was not persisted: ${entry.id}`);
    }
    if (result.appended) {
      this.transcriptMutationAt = result.transcriptMutationAt;
    }
    // Carry the canonical storage bytes even when adopting a context-excluded row.
    entry.message = result.message;
    if (result.messageId !== entry.id) {
      const idempotencyKey =
        entry.message.role === "user" &&
        "idempotencyKey" in entry.message &&
        typeof entry.message.idempotencyKey === "string" &&
        entry.message.idempotencyKey.length > 0
          ? entry.message.idempotencyKey
          : undefined;
      if (idempotencyKey && options?.idempotencyLookup !== "caller-checked") {
        // Ingress can commit the keyed user after this manager loaded. The
        // caller reloads and adopts only when that canonical row is still active.
        if (!result.anchor) {
          throw new Error(`Session transcript anchor was not returned: ${result.messageId}`);
        }
        return {
          adoptedMessageId: result.messageId,
          anchor: result.anchor,
          appended: result.appended,
          effectiveParentId: result.effectiveParentId ?? null,
        };
      }
      throw new Error(`Session transcript parent entry was not persisted: ${entry.id}`);
    }
    if (
      options?.idempotencyLookup === "caller-checked" &&
      (!result?.appended || result.messageId !== entry.id)
    ) {
      throw new Error(`Session transcript append was not persisted: ${entry.id}`);
    }
    if (result.effectiveParentId === undefined) {
      throw new Error(`Session transcript append parent was not returned: ${entry.id}`);
    }
    return {
      ...(result.anchor ? { anchor: result.anchor } : {}),
      appended: result.appended,
      effectiveParentId: result.effectiveParentId,
    };
  }
}
