import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import * as sqliteTransaction from "../../infra/sqlite-transaction.js";
import {
  isSessionBackgroundTargetRetired,
  releaseSessionBackgroundTarget,
  retainSessionBackgroundTarget,
  type SessionBackgroundTarget,
} from "../../sessions/session-background-custody.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { loadSessionEntryWithDatabase } from "./session-accessor.sqlite-entry.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => Promise<void>) | undefined,
  beforeReclaim: undefined as (() => Promise<void>) | undefined,
  beforeCommitRequest: undefined as (() => void) | undefined,
  afterCommitRequest: undefined as (() => void) | undefined,
}));

vi.mock("./session-accessor.sqlite-reclamation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-reclamation.js")>();
  return {
    ...actual,
    runSqliteSessionReclamation: async (
      ...args: Parameters<typeof actual.runSqliteSessionReclamation>
    ) => {
      await archiveMaterializationHook.beforeReclaim?.();
      return await actual.runSqliteSessionReclamation(...args);
    },
  };
});

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    runSqliteTranscriptArchiveWorkerOperation: (
      params: Parameters<typeof actual.runSqliteTranscriptArchiveWorkerOperation>[0],
    ) =>
      actual.runSqliteTranscriptArchiveWorkerOperation({
        ...params,
        onCommitRequest: params.onCommitRequest
          ? () => {
              archiveMaterializationHook.beforeCommitRequest?.();
              params.onCommitRequest?.();
              archiveMaterializationHook.afterCommitRequest?.();
            }
          : undefined,
      }),
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const backgroundTargets: SessionBackgroundTarget[] = [];

function captureBackgroundTarget(storePath: string, sessionKey: string): SessionBackgroundTarget {
  const { entry, databaseClaim } = loadSessionEntryWithDatabase({ storePath, sessionKey });
  const target: SessionBackgroundTarget = {
    agentId: "main",
    sessionKey,
    sessionId: entry?.sessionId,
    lifecycleRevision: entry?.lifecycleRevision,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    abortController: new AbortController(),
    databaseClaim,
  };
  retainSessionBackgroundTarget(target);
  backgroundTargets.push(target);
  return target;
}

describe("SQLite reclamation admission races", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-reclamation-admission-race-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    archiveMaterializationHook.beforeMaterialize = undefined;
    archiveMaterializationHook.beforeReclaim = undefined;
    archiveMaterializationHook.beforeCommitRequest = undefined;
    archiveMaterializationHook.afterCommitRequest = undefined;
    for (const target of backgroundTargets.splice(0)) {
      releaseSessionBackgroundTarget(target);
    }
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
  });

  it.runIf(process.platform !== "win32").each([false, true])(
    "publishes exact committed retirement without retiring a fresh subscriber (parent closed: %s)",
    async (closeParent) => {
      const sessionKey = "agent:main:postcommit-custody";
      const directory = tempDirs.make("reclamation-closed-parent-");
      const originalPath = path.join(directory, "original.sqlite");
      const alias = path.join(directory, "alias.sqlite");
      const scope = { agentId: "main", sessionKey, storePath: originalPath };
      await replaceSessionEntry(scope, { sessionId: "same-identity", updatedAt: 1 });
      const entry = loadSessionEntry(scope)!;
      fs.symlinkSync(originalPath, alias);
      loadSessionEntry({ ...scope, storePath: alias });
      const previous = captureBackgroundTarget(alias, sessionKey);
      let fresh: SessionBackgroundTarget | undefined;
      archiveMaterializationHook.afterCommitRequest = () => {
        // The real grant/join has completed; the Worker's result is still queued behind this callback.
        expect(loadSessionEntry({ ...scope, storePath: alias })).toBeUndefined();
        if (closeParent) {
          expect(closeOpenClawAgentDatabaseByPath(originalPath)).toBe(true);
        }
        replaceSessionEntrySync({ ...scope, storePath: alias }, entry);
        expect(loadSessionEntry({ ...scope, storePath: alias })).toEqual(entry);
        fresh = captureBackgroundTarget(alias, sessionKey);
      };
      await expect(
        deleteSessionEntryLifecycle({
          archiveTranscript: false,
          commitGuard: () => {},
          storePath: originalPath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        }),
      ).resolves.toMatchObject({ deleted: true });
      expect(fresh).toBeDefined();
      expect(isSessionBackgroundTargetRetired(previous)).toBe(true);
      expect(previous.abortController.signal.aborted).toBe(true);
      expect(isSessionBackgroundTargetRetired(fresh!)).toBe(false);
      expect(fresh!.abortController.signal.aborted).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps worker reclamation on the opened database after an alias retarget",
    async () => {
      const sessionKey = "agent:main:retargeted-reclamation";
      const sessionId = "retargeted-reclamation";
      const directory = tempDirs.make("reclamation-alias-");
      const originalPath = path.join(directory, "original.sqlite");
      const replacementPath = path.join(directory, "replacement.sqlite");
      const alias = path.join(directory, "alias.sqlite");
      await replaceSessionEntry(
        { sessionKey, storePath: originalPath },
        { sessionId, updatedAt: 1 },
      );
      // Close/checkpoint before copying so both files start with the same durable row and revision.
      closeOpenClawAgentDatabasesForTest();
      fs.copyFileSync(originalPath, replacementPath);
      fs.symlinkSync(originalPath, alias);
      expect(loadSessionEntry({ sessionKey, storePath: alias })).toMatchObject({ sessionId });
      archiveMaterializationHook.beforeReclaim = async () => {
        fs.unlinkSync(alias);
        fs.symlinkSync(replacementPath, alias);
      };

      await expect(
        deleteSessionEntryLifecycle({
          archiveTranscript: false,
          storePath: alias,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        }),
      ).resolves.toMatchObject({ deleted: true });
      expect(loadSessionEntry({ sessionKey, storePath: originalPath })).toBeUndefined();
      expect(loadSessionEntry({ sessionKey, storePath: replacementPath })).toMatchObject({
        sessionId,
      });
    },
  );

  it("publishes the committed deletion after a recovered commit barrier failure", async () => {
    const sessionKey = "agent:main:recovered-deletion";
    const sessionId = "recovered-deletion";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "archive the committed deletion" },
    ]);
    const actualTransaction = sqliteTransaction.runSqliteImmediateTransactionSync;
    let faultInjected = false;
    archiveMaterializationHook.beforeCommitRequest = () => {
      vi.spyOn(sqliteTransaction, "runSqliteImmediateTransactionSync").mockImplementationOnce(
        (db, operation, options) => {
          actualTransaction(db, operation, options);
          faultInjected = true;
          throw new Error("injected failure after barrier acquired");
        },
      );
    };
    const mutations: string[] = [];
    const unsubscribe = onSessionIdentityMutation((event) => {
      if (event.previous.sessionKeys.includes(sessionKey)) {
        mutations.push(event.kind);
      }
    });
    try {
      const result = await deleteSessionEntryLifecycle({
        archiveTranscript: true,
        commitGuard: () => {},
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expect(faultInjected).toBe(true);
      expect(result.deleted).toBe(true);
      expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
      expect(
        result.archivedTranscripts.map((archive) => fs.existsSync(archive.archivedPath)),
      ).toEqual([true]);
      expect(mutations).toEqual(["delete"]);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { hasHistory: false, checkpoint: "prepare" },
    { hasHistory: true, checkpoint: "prepare" },
    { hasHistory: false, checkpoint: "commit" },
    { hasHistory: true, checkpoint: "commit" },
  ])(
    "preserves session data and custody when authority closes at $checkpoint (history: $hasHistory)",
    async ({ hasHistory, checkpoint }) => {
      const sessionKey = "agent:main:revoked-deletion";
      const sessionId = "revoked-deletion-current";
      const historicalSessionId = "revoked-deletion-history";
      if (hasHistory) {
        await replaceSessionEntry(
          { sessionKey, storePath },
          { sessionId: historicalSessionId, updatedAt: 1 },
        );
        await replaceTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }, [
          { type: "session", id: historicalSessionId, content: "retained history" },
        ]);
      }
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 2 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        { type: "session", id: sessionId, content: "retained current transcript" },
      ]);
      let authorized = true;
      const background = captureBackgroundTarget(storePath, sessionKey);
      if (checkpoint === "prepare") {
        archiveMaterializationHook.beforeReclaim = async () => {
          await Promise.resolve();
          authorized = false;
        };
      } else {
        archiveMaterializationHook.beforeCommitRequest = () => {
          authorized = false;
        };
      }

      await expect(
        deleteSessionEntryLifecycle({
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
          commitGuard: () => {
            if (!authorized) {
              throw new Error("caller authority closed");
            }
          },
          storePath,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        }),
      ).rejects.toThrow("caller authority closed");
      expect(isSessionBackgroundTargetRetired(background)).toBe(false);
      expect(background.abortController.signal.aborted).toBe(false);
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
      await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([
        expect.objectContaining({ id: sessionId, content: "retained current transcript" }),
      ]);
      if (hasHistory) {
        await expect(
          loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
        ).resolves.toEqual([
          expect.objectContaining({ id: historicalSessionId, content: "retained history" }),
        ]);
      }
    },
  );

  it("fences new historical-generation work through the Worker commit", async () => {
    const sessionKey = "agent:main:historical-admission-race";
    const historicalSessionId = "historical-admission-previous";
    const currentSessionId = "historical-admission-current";
    const historicalEvent = {
      type: "session" as const,
      id: historicalSessionId,
      content: "historical admission transcript",
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalSessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }, [
      historicalEvent,
    ]);
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: currentSessionId, updatedAt: 2 },
    );

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await materializationStarted;
    const assertHistoricalGenerationExists = async () => {
      const events = await loadTranscriptEvents({
        sessionKey,
        sessionId: historicalSessionId,
        storePath,
      });
      if (events.length === 0) {
        throw new Error("historical generation no longer exists");
      }
    };
    let admissionSettled = false;
    const admissionOutcome = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, historicalSessionId],
      assertAllowed: assertHistoricalGenerationExists,
      revalidateAllowed: assertHistoricalGenerationExists,
    })
      .then((lease) => {
        lease.release();
        return "admitted";
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        admissionSettled = true;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admissionSettled).toBe(false);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(admissionOutcome).resolves.toBe("historical generation no longer exists");
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
    ).resolves.toEqual([]);
  });

  it("fences new current-generation work through the Worker commit", async () => {
    const sessionKey = "agent:main:current-admission-race";
    const sessionId = "current-admission-run";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "current admission transcript" },
    ]);

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await materializationStarted;
    const assertCurrentGenerationExists = async () => {
      const events = await loadTranscriptEvents({ sessionKey, sessionId, storePath });
      if (events.length === 0) {
        throw new Error("current generation no longer exists");
      }
    };
    let admissionSettled = false;
    const admissionOutcome = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: assertCurrentGenerationExists,
      revalidateAllowed: assertCurrentGenerationExists,
    })
      .then((lease) => {
        lease.release();
        return "admitted";
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        admissionSettled = true;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admissionSettled).toBe(false);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(admissionOutcome).resolves.toBe("current generation no longer exists");
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([]);
  });
});
