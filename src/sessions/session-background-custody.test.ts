import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readExactSessionEntryRowValidated } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.js";
import { resetSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import * as postCommit from "../infra/sqlite-post-commit.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  isSessionBackgroundTargetRetired,
  releaseSessionBackgroundTarget,
  retainSessionBackgroundTarget,
  type SessionBackgroundTarget,
} from "./session-background-custody.js";
import {
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "./session-lifecycle-events.js";

let directory: string;
let storePath: string;
const sessionKey = "agent:main:main";
const targets: SessionBackgroundTarget[] = [];

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-custody-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  storePath = path.join(directory, "agent.sqlite");
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath },
    { sessionId: "original", updatedAt: 1 },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const target of targets.splice(0)) {
    releaseSessionBackgroundTarget(target);
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function capture(databasePath = storePath): SessionBackgroundTarget {
  const retained = retainOpenClawAgentDatabaseReadOnly({
    agentId: "main",
    path: databasePath,
  });
  if (!retained.found) {
    throw new Error("expected the source database");
  }
  const databaseClaim = retained.claim;
  const entry = readExactSessionEntryRowValidated(databaseClaim.database, sessionKey)?.entry;
  const target: SessionBackgroundTarget = {
    agentId: "main",
    sessionKey,
    sessionId: entry?.sessionId,
    lifecycleRevision: entry?.lifecycleRevision,
    databaseClaim,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    abortController: new AbortController(),
  };
  retainSessionBackgroundTarget(target);
  targets.push(target);
  return target;
}

it.runIf(process.platform !== "win32").each([false, true])(
  "retires a same-identity reset through a different SQLite alias (cold source: %s)",
  async (cold) => {
    if (cold) {
      closeOpenClawAgentDatabaseByPath(storePath);
    }
    const target = capture();
    const alias = path.join(directory, "alias.sqlite");
    fs.symlinkSync(storePath, alias);
    await resetSessionEntryLifecycle({
      storePath: alias,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: ({ currentEntry }) => ({ ...currentEntry!, updatedAt: 2 }),
    });
    expect(isSessionBackgroundTargetRetired(target)).toBe(true);
    expect(target.abortController.signal.aborted).toBe(true);
    expect(target.databaseClaim.isCurrent()).toBe(false);
  },
);

it.each([false, true])(
  "publishes replacement custody and identity only on outer commit (rollback: %s)",
  (rollback) => {
    const target = capture();
    const database = target.databaseClaim.database;
    const observed: Array<{
      mutation: SessionIdentityMutation;
      inTransaction: boolean;
      sessionId: string | undefined;
      retired: boolean;
    }> = [];
    const unsubscribe = onSessionIdentityMutation((mutation) => {
      observed.push({
        mutation,
        inTransaction: database.db.isTransaction,
        sessionId: readExactSessionEntryRowValidated(database, sessionKey)?.entry.sessionId,
        retired: isSessionBackgroundTargetRetired(target),
      });
    });
    try {
      const replace = () =>
        runOpenClawAgentWriteTransaction(
          () => {
            replaceSessionEntrySync(
              { agentId: "main", sessionKey, storePath },
              { sessionId: "replacement", updatedAt: 2 },
            );
            expect(isSessionBackgroundTargetRetired(target)).toBe(false);
            if (rollback) {
              throw new Error("rollback");
            }
          },
          { agentId: "main", path: storePath },
        );
      if (rollback) {
        expect(replace).toThrow("rollback");
      } else {
        replace();
      }
      expect(observed).toEqual(
        rollback
          ? []
          : [
              {
                mutation: {
                  kind: "replace",
                  previous: { sessionId: "original", sessionKeys: [sessionKey] },
                  current: { sessionId: "replacement", sessionKeys: [sessionKey] },
                },
                inTransaction: false,
                sessionId: "replacement",
                retired: true,
              },
            ],
      );
      expect(readExactSessionEntryRowValidated(database, sessionKey)?.entry.sessionId).toBe(
        rollback ? "original" : "replacement",
      );
      expect(isSessionBackgroundTargetRetired(target)).toBe(!rollback);
    } finally {
      unsubscribe();
    }
  },
);

it("preserves fresh same-identity work captured by an earlier commit observer", () => {
  const previous = capture();
  const entry = readExactSessionEntryRowValidated(
    previous.databaseClaim.database,
    sessionKey,
  )!.entry;
  let fresh: SessionBackgroundTarget | undefined;
  runOpenClawAgentWriteTransaction(
    (database) => {
      deferOpenClawAgentPostCommitPublication(database, () => {
        replaceSessionEntrySync({ agentId: "main", sessionKey, storePath }, entry);
        fresh = capture();
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "intermediate", updatedAt: 2 },
      );
    },
    { agentId: "main", path: storePath },
  );
  expect(isSessionBackgroundTargetRetired(previous)).toBe(true);
  expect(fresh).toBeDefined();
  expect(fresh!.sessionId).toBe(entry.sessionId);
  expect(fresh!.lifecycleRevision).toBe(entry.lifecycleRevision);
  expect(isSessionBackgroundTargetRetired(fresh!)).toBe(false);
  expect(fresh!.abortController.signal.aborted).toBe(false);
});

it("preserves fresh same-identity work captured by a reset abort observer", async () => {
  const first = capture();
  const second = capture();
  let fresh: SessionBackgroundTarget | undefined;
  first.abortController.signal.addEventListener(
    "abort",
    () => {
      fresh = capture();
    },
    { once: true },
  );
  await resetSessionEntryLifecycle({
    storePath,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    buildNextEntry: ({ currentEntry }) => ({ ...currentEntry!, updatedAt: 2 }),
  });
  expect(isSessionBackgroundTargetRetired(first)).toBe(true);
  expect(isSessionBackgroundTargetRetired(second)).toBe(true);
  expect(fresh).toBeDefined();
  expect(fresh!.sessionId).toBe(first.sessionId);
  expect(fresh!.lifecycleRevision).toBe(first.lifecycleRevision);
  expect(isSessionBackgroundTargetRetired(fresh!)).toBe(false);
  expect(fresh!.abortController.signal.aborted).toBe(false);
});

it("preserves fresh same-identity work captured before import publication", async () => {
  const previous = capture();
  const database = previous.databaseClaim.database;
  const entry = readExactSessionEntryRowValidated(database, sessionKey)!.entry;
  const defer = postCommit.deferSqlitePostCommitPublication;
  let insertedObserver = false;
  let fresh: SessionBackgroundTarget | undefined;
  vi.spyOn(postCommit, "deferSqlitePostCommitPublication").mockImplementation((db, publish) => {
    if (db === database.db && !insertedObserver) {
      insertedObserver = true;
      defer(db, () => {
        replaceSessionEntrySync({ agentId: "main", sessionKey, storePath }, entry);
        fresh = capture();
      });
    }
    return defer(db, publish);
  });
  await importSqliteSessionRows({
    agentId: "main",
    sessionKey,
    storePath,
    entry: { sessionId: "imported", updatedAt: 2 },
  });
  expect(insertedObserver).toBe(true);
  expect(isSessionBackgroundTargetRetired(previous)).toBe(true);
  expect(fresh).toBeDefined();
  expect(fresh!.sessionId).toBe(entry.sessionId);
  expect(fresh!.lifecycleRevision).toBe(entry.lifecycleRevision);
  expect(isSessionBackgroundTargetRetired(fresh!)).toBe(false);
  expect(fresh!.abortController.signal.aborted).toBe(false);
});

it("cannot revive a closed store claim by reopening its original pathname", () => {
  const target = capture();
  closeOpenClawAgentDatabaseByPath(storePath);
  const successor = capture();
  expect(isSessionBackgroundTargetRetired(target)).toBe(true);
  expect(isSessionBackgroundTargetRetired(successor)).toBe(false);
});

it.each([false, true])("keeps fresh work after lifecycle rotation (nested: %s)", (nested) => {
  const target = capture();
  let fresh: SessionBackgroundTarget | undefined;
  target.abortController.signal.addEventListener(
    "abort",
    () => {
      if (nested) {
        rotateAgentEventLifecycleGeneration();
      }
      fresh = capture();
    },
    { once: true },
  );
  rotateAgentEventLifecycleGeneration();
  expect(isSessionBackgroundTargetRetired(target)).toBe(true);
  expect(target.abortController.signal.aborted).toBe(true);
  expect(fresh).toBeDefined();
  expect(fresh!.lifecycleGeneration).toBe(getAgentEventLifecycleGeneration());
  expect(isSessionBackgroundTargetRetired(fresh!)).toBe(false);
  expect(fresh!.abortController.signal.aborted).toBe(false);
});
