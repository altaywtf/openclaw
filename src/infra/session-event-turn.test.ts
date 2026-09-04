import { symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { BackgroundTurnParams } from "../auto-reply/reply/background-turn.types.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { loadSessionEntryWithDatabase } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { captureExecCompletionTarget, enqueueExecCompletion } from "./exec-completion.js";
import { runSessionEventTurn } from "./session-event-turn.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("../auto-reply/reply/background-turn.js", () => ({ dispatchBackgroundTurn: dispatch }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:main";
let storePath: string;
let cfg: OpenClawConfig;
let prompts: string[];

beforeEach(async () => {
  storePath = path.join(tempDirs.make("session-event-turn-"), "sessions.json");
  cfg = { session: { store: storePath } };
  setRuntimeConfigSnapshot(cfg);
  await replaceSessionEntry({ storePath, sessionKey }, { sessionId: "session", updatedAt: 1 });
  prompts = [];
  dispatch.mockImplementation(admit);
});

async function admit(params: BackgroundTurnParams, afterClaim?: () => void) {
  const admittedStore = params.cfg.session?.store;
  const admitted = loadSessionEntryWithDatabase({ storePath: admittedStore, sessionKey });
  const operation = createReplyOperation({
    sessionKey,
    sessionId: admitted.entry?.sessionId ?? "created-session",
    resetTriggered: false,
  });
  try {
    params.claim?.(operation, admittedStore, admitted.databaseClaim);
    afterClaim?.();
    prompts.push(params.prompt);
    params.onStarted?.("run");
    return { status: "settled", execution: "ok", executionStarted: true, durationMs: 1 };
  } catch (error) {
    return {
      status: "settled",
      execution: "failed",
      executionStarted: false,
      error: String(error),
      durationMs: 1,
    };
  } finally {
    operation.complete();
    admitted.databaseClaim.release();
  }
}

afterEach(() => {
  resetSystemEventsForTest();
  closeOpenClawAgentDatabasesForTest();
  clearRuntimeConfigSnapshot();
  vi.clearAllMocks();
});

it("leaves whole later occurrences queued when a batch reaches its prompt budget", async () => {
  enqueueSystemEvent("a".repeat(7_990), { sessionKey });
  enqueueSystemEvent("second-event-".repeat(20), { sessionKey });
  await runSessionEventTurn({ cfg, agentId: "main", sessionKey });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).not.toContain("second-event");
  expect(peekSystemEvents(sessionKey)).toEqual(["second-event-".repeat(20)]);
});

it.each([false, true])(
  "isolates closed occurrence custody from a live sibling, stale first=%s",
  async (staleFirst) => {
    const stale = captureExecCompletionTarget({
      agentId: "main",
      sessionKey,
      sessionStore: storePath,
    })!;
    const live = captureExecCompletionTarget({
      agentId: "main",
      sessionKey,
      sessionStore: storePath,
    })!;
    for (const target of staleFirst ? [stale, live] : [live, stale]) {
      enqueueExecCompletion(
        target === stale ? "stale output" : "live output",
        { sessionKey },
        target,
      );
    }
    stale.databaseClaim.release();
    await runSessionEventTurn({ cfg, agentId: "main", sessionKey });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("live output");
    expect(prompts[0]).not.toContain("stale output");
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  },
);

it("reports consumed work independently of whether a model started", async () => {
  dispatch.mockImplementationOnce(async (params: BackgroundTurnParams) => {
    const admitted = loadSessionEntryWithDatabase({ storePath, sessionKey });
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "session",
      resetTriggered: false,
    });
    try {
      params.claim?.(operation, storePath, admitted.databaseClaim);
      return { status: "settled", execution: "not-run", executionStarted: false, durationMs: 1 };
    } finally {
      operation.complete();
      admitted.databaseClaim.release();
    }
  });
  enqueueSystemEvent("plugin-owned event", { sessionKey });
  expect(await runSessionEventTurn({ cfg, agentId: "main", sessionKey })).toMatchObject({
    eventsConsumed: 1,
    executionStarted: false,
  });
});

function queueCompletion(text: string) {
  const target = captureExecCompletionTarget({
    agentId: "main",
    sessionKey,
    sessionStore: storePath,
  })!;
  return { target, remove: enqueueExecCompletion(text, { sessionKey }, target)! };
}

it("retains an unpolled sibling when polling cancels a batch before admission", async () => {
  const first = queueCompletion("first output");
  queueCompletion("second output");
  dispatch.mockImplementationOnce(async (params: BackgroundTurnParams) => {
    first.remove();
    return await admit(params);
  });
  expect(await runSessionEventTurn({ cfg, agentId: "main", sessionKey })).toMatchObject({
    status: "skipped",
    reason: "active-run",
    eventsConsumed: 0,
  });
  expect(prompts).toEqual([]);
  expect(peekSystemEvents(sessionKey)).toEqual(["second output"]);
  await runSessionEventTurn({ cfg, agentId: "main", sessionKey });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("second output");
});

it("does not let a settled poll abort claimed siblings or consume another source", async () => {
  const first = queueCompletion("first output");
  const second = queueCompletion("second output");
  enqueueSystemEvent("independent system event", { sessionKey });
  dispatch.mockImplementationOnce((params: BackgroundTurnParams) =>
    admit(params, () => {
      expect(first.remove()).toBe(false);
      expect(second.remove()).toBe(false);
      expect(params.signal?.aborted).toBe(false);
    }),
  );
  expect(await runSessionEventTurn({ cfg, agentId: "main", sessionKey })).toMatchObject({
    eventsConsumed: 2,
  });
  expect(prompts[0]).toContain("first output");
  expect(prompts[0]).toContain("second output");
  expect(peekSystemEvents(sessionKey)).toEqual(["independent system event"]);
});

it("binds a first-use generic event to the canonical newly opened session owner", async () => {
  cfg = {
    session: { store: path.join(tempDirs.make("session-event-first-use-"), "sessions.json") },
  };
  setRuntimeConfigSnapshot(cfg);
  enqueueSystemEvent("first event", { sessionKey });
  expect(await runSessionEventTurn({ cfg, agentId: "main", sessionKey })).toMatchObject({
    status: "settled",
    execution: "ok",
    eventsConsumed: 1,
  });
  expect(prompts[0]).toContain("first event");
});

it("retains source custody across an unwarmed alias-only configuration reload", async () => {
  queueCompletion("original output");
  const alias = path.join(tempDirs.make("session-event-alias-"), "alias");
  symlinkSync(path.dirname(storePath), alias, "dir");
  const reloaded = { session: { store: path.join(alias, "sessions.json") } };
  dispatch.mockImplementationOnce(async (params: BackgroundTurnParams) => {
    setRuntimeConfigSnapshot(reloaded);
    return await admit(params);
  });
  expect(await runSessionEventTurn({ cfg, agentId: "main", sessionKey })).toMatchObject({
    status: "skipped",
    reason: "active-run",
    eventsConsumed: 0,
  });
  expect(prompts).toEqual([]);
  expect(await runSessionEventTurn({ cfg, agentId: "main", sessionKey })).toMatchObject({
    status: "settled",
    execution: "ok",
    eventsConsumed: 1,
  });
  expect(prompts[0]).toContain("original output");
});
