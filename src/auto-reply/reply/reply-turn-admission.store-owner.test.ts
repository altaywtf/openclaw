import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import * as registry from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "global";
const sessionId = "copied-session-id";
const successorId = "compacted-session-id";

afterEach(() => {
  testing.resetReplyRunRegistry();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

function seed(storePath: string, id = sessionId) {
  replaceSessionEntrySync({ storePath, sessionKey }, { sessionId: id, updatedAt: 1 });
}

async function admitOwner(storePath?: string, id = sessionId) {
  const result = await admitReplyTurn({
    sessionKey,
    sessionId: id,
    storePath,
    kind: "visible",
    resetTriggered: false,
  });
  if (result.status !== "owned") {
    throw new Error("fixture requires a genuinely admitted parent operation");
  }
  return result.operation;
}

it.each(
  (["active", "successor", "followup"] as const).flatMap((barrier) =>
    [true, false].map((sameStore) => ({ barrier, sameStore })),
  ),
)(
  "follows $barrier rotation only in its physical store, sameStore=$sameStore",
  async ({ barrier, sameStore }) => {
    const ownerStore = path.join(tempDirs.make("reply-owner-"), "sessions.json");
    const targetStore = sameStore
      ? ownerStore
      : path.join(tempDirs.make("reply-target-"), "sessions.json");
    seed(ownerStore);
    if (!sameStore) {
      seed(targetStore);
    }
    const owner = await admitOwner(ownerStore);
    const released = createDeferred();
    const waited =
      barrier === "active"
        ? vi.spyOn(registry.replyRunRegistry, "waitForIdle")
        : vi.spyOn(
            registry,
            barrier === "successor"
              ? "waitForReplyRunSuccessorAdmission"
              : "waitForReplyRunFollowupAdmission",
          );
    const rotate = (operation: registry.ReplyOperation) => {
      operation.updateSessionId(successorId);
      seed(ownerStore, successorId);
    };
    if (barrier === "successor") {
      registry.registerReplyOperationSuccessorBarrier({
        operation: owner,
        sessionId,
        sessionKeys: [sessionKey],
        start: () => released.promise,
      });
      rotate(owner);
      owner.complete();
    } else if (barrier === "followup") {
      owner.completeWithAfterClearBarrier(released.promise);
    }
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath: targetStore,
      kind: "queued_followup",
      resetTriggered: false,
    });
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalled());
      if (barrier === "active") {
        rotate(owner);
        owner.complete();
      } else if (barrier === "followup") {
        // A later visible turn may advance this same-store delivery barrier.
        const visible = await admitOwner(ownerStore);
        rotate(visible);
        visible.complete();
      }
      released.resolve();
      const result = await pending;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        expect(result.operation.sessionId).toBe(sameStore ? successorId : sessionId);
        result.operation.complete();
      }
    } finally {
      owner.complete();
      released.resolve();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it.each(["before", "after"] as const)(
  "keeps same-store rotation when a foreign barrier is installed %s the rotation",
  async (foreignOrder) => {
    const ownerStore = path.join(tempDirs.make("reply-rotation-owner-"), "sessions.json");
    const foreignStore = path.join(tempDirs.make("reply-rotation-foreign-"), "sessions.json");
    seed(ownerStore);
    seed(foreignStore);
    const owner = await admitOwner(ownerStore);
    const ownerDelivery = createDeferred();
    const foreignDelivery = createDeferred();
    owner.completeWithAfterClearBarrier(ownerDelivery.promise);
    const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath: ownerStore,
      kind: "queued_followup",
      resetTriggered: false,
    });
    const installForeignBarrier = async () => {
      const foreign = await admitOwner(foreignStore);
      foreign.completeWithAfterClearBarrier(foreignDelivery.promise);
    };
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalled());
      if (foreignOrder === "before") {
        await installForeignBarrier();
      }
      const visible = await admitOwner(ownerStore);
      seed(ownerStore, successorId);
      visible.updateSessionId(successorId);
      visible.complete();
      if (foreignOrder === "after") {
        await installForeignBarrier();
      }
      ownerDelivery.resolve();
      foreignDelivery.resolve();
      const result = await pending;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        expect(result.operation.sessionId).toBe(successorId);
        result.operation.complete();
      }
    } finally {
      owner.complete();
      ownerDelivery.resolve();
      foreignDelivery.resolve();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it.each(
  [false, true].flatMap((replacementBarrier) =>
    [false, true].map((storeless) => ({ replacementBarrier, storeless })),
  ),
)(
  "rejects unrelated replacement, replacementBarrier=$replacementBarrier storeless=$storeless",
  async ({ replacementBarrier, storeless }) => {
    const storePath = storeless
      ? undefined
      : path.join(tempDirs.make("reply-replaced-owner-"), "sessions.json");
    if (storePath) {
      seed(storePath);
    }
    const owner = await admitOwner(storePath);
    const delivery = createDeferred();
    const replacementDelivery = createDeferred();
    owner.completeWithAfterClearBarrier(delivery.promise);
    const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
    const pending = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
    });
    try {
      await vi.waitFor(() => expect(waited).toHaveBeenCalled());
      if (storePath) {
        seed(storePath, "unrelated-replacement");
      }
      const replacement = await admitOwner(storePath, "unrelated-replacement");
      expect(replacement.sessionId).toBe("unrelated-replacement");
      expect(replacement.hasOwnedSessionId(sessionId)).toBe(false);
      if (replacementBarrier) {
        replacement.completeWithAfterClearBarrier(replacementDelivery.promise);
      } else {
        replacement.complete();
      }
      delivery.resolve();
      replacementDelivery.resolve();
      await expect(pending).resolves.toMatchObject({
        status: "skipped",
        reason: "lifecycle-invalidated",
      });
    } finally {
      owner.complete();
      delivery.resolve();
      replacementDelivery.resolve();
      const result = await pending;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it("follows connected compactions by distinct owners from either predecessor", async () => {
  const storePath = path.join(tempDirs.make("reply-lineage-owner-"), "sessions.json");
  seed(storePath);
  const owner = await admitOwner(storePath);
  const delivery = createDeferred();
  owner.completeWithAfterClearBarrier(delivery.promise);
  const waited = vi.spyOn(registry, "waitForReplyRunFollowupAdmission");
  const controller = new AbortController();
  const pending: Promise<{ status: string; sessionId?: string }>[] = [];
  const enqueue = (expectedSessionId: string) => {
    pending.push(
      admitReplyTurn({
        sessionKey,
        sessionId: expectedSessionId,
        expectedSessionId,
        storePath,
        kind: "queued_followup",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      }).then((result) => {
        if (result.status !== "owned") {
          return { status: result.status };
        }
        const admittedId = result.operation.sessionId;
        result.operation.complete();
        return { status: result.status, sessionId: admittedId };
      }),
    );
  };
  try {
    enqueue(sessionId);
    await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(1));
    for (const nextId of [successorId, "second-compaction"]) {
      const visible = await admitOwner(storePath);
      seed(storePath, nextId);
      visible.updateSessionId(nextId);
      visible.complete();
      if (nextId === successorId) {
        enqueue(successorId);
        await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(2));
      }
    }
    delivery.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      { status: "owned", sessionId: "second-compaction" },
      { status: "owned", sessionId: "second-compaction" },
    ]);
  } finally {
    owner.complete();
    delivery.resolve();
    controller.abort();
    await Promise.allSettled(pending);
  }
});

it("keeps rekeyed source lineage separate from the adopted target", async () => {
  const storePath = path.join(tempDirs.make("reply-rekeyed-lineage-"), "sessions.json");
  seed(storePath);
  const owner = await admitOwner(storePath);
  const release = createDeferred();
  registry.registerReplyOperationSuccessorBarrier({
    operation: owner,
    sessionId,
    sessionKeys: [sessionKey],
    start: () => release.promise,
  });
  seed(storePath, successorId);
  owner.updateSessionId(successorId);
  const targetKey = "agent:main:adopted-target";
  const targetId = "adopted-session";
  replaceSessionEntrySync(
    { storePath, sessionKey: targetKey },
    { sessionId: targetId, updatedAt: 1 },
  );
  const adopted = await admitReplyTurn({
    sessionKey: targetKey,
    sessionId: successorId,
    expectedSessionId: targetId,
    storePath,
    kind: "visible",
    resetTriggered: false,
    adoptOperation: owner,
  });
  expect(adopted.status).toBe("owned");
  owner.updateSessionId(targetId);
  expect(owner.hasOwnedSessionId(targetId)).toBe(true);
  const waited = vi.spyOn(registry, "waitForReplyRunSuccessorAdmission");
  const controller = new AbortController();
  const pending = [sessionId, targetId].map(async (expectedSessionId) => {
    const result = await admitReplyTurn({
      sessionKey,
      sessionId: expectedSessionId,
      expectedSessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    if (result.status !== "owned") {
      return { status: result.status, reason: result.reason };
    }
    const admittedId = result.operation.sessionId;
    result.operation.complete();
    return { status: result.status, sessionId: admittedId };
  });
  try {
    await vi.waitFor(() => expect(waited).toHaveBeenCalledTimes(2));
    owner.complete();
    release.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      { status: "owned", sessionId: successorId },
      { status: "skipped", reason: "lifecycle-invalidated" },
    ]);
  } finally {
    owner.complete();
    release.resolve();
    controller.abort();
    await Promise.allSettled(pending);
  }
});
