import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  registerAgentEventLifecycleRotationHandler,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import type { SessionBackgroundTarget } from "./session-background-custody.js";

let beforeCustodyRotation: (() => void) | undefined;
// The earlier observer must register before custody's module installs its own handler.
registerAgentEventLifecycleRotationHandler("custody-rotation-test", () =>
  beforeCustodyRotation?.(),
);
const {
  isSessionBackgroundTargetRetired,
  releaseSessionBackgroundTarget,
  retainSessionBackgroundTarget,
} = await import("./session-background-custody.js");
const { loadSessionEntryWithDatabase, replaceSessionEntrySync } =
  await import("../config/sessions/session-accessor.sqlite-entry.js");
const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");

it("keeps work from a nested rotation in an earlier lifecycle handler", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "custody-rotation-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: path.join(directory, "agent.sqlite"),
  };
  const targets: SessionBackgroundTarget[] = [];
  const capture = () => {
    const { entry, databaseClaim } = loadSessionEntryWithDatabase(scope);
    const target: SessionBackgroundTarget = {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      sessionId: entry?.sessionId,
      lifecycleRevision: entry?.lifecycleRevision,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      databaseClaim,
      abortController: new AbortController(),
    };
    retainSessionBackgroundTarget(target);
    targets.push(target);
    return target;
  };
  try {
    replaceSessionEntrySync(scope, { sessionId: "original", updatedAt: 1 });
    const previous = capture();
    let nested = false;
    let fresh: SessionBackgroundTarget | undefined;
    beforeCustodyRotation = () => {
      if (!nested) {
        nested = true;
        rotateAgentEventLifecycleGeneration();
        fresh = capture();
      }
    };
    rotateAgentEventLifecycleGeneration();
    expect(isSessionBackgroundTargetRetired(previous)).toBe(true);
    expect(fresh).toBeDefined();
    expect(fresh!.lifecycleGeneration).toBe(getAgentEventLifecycleGeneration());
    expect(isSessionBackgroundTargetRetired(fresh!)).toBe(false);
    expect(fresh!.abortController.signal.aborted).toBe(false);
  } finally {
    beforeCustodyRotation = undefined;
    targets.forEach(releaseSessionBackgroundTarget);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
