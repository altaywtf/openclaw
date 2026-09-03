import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseNodeWorkerStartupMessage } from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerSupervisorIdentity } from "./node-worker-supervisor-contract.js";

const log = createSubsystemLogger("node-host/worker-startup");

/** One bounded observer per admitted turn; these facts never authorize a worker. */
export function createNodeWorkerStartupDiagnostics(
  identity: NodeWorkerSupervisorIdentity,
  receivedAtMs: number,
) {
  let gateRecorded = false;
  let helloAtMs: number | undefined;
  let inferenceRecorded = false;
  const record = (
    phase: "launch-received" | "start-gate-opened" | "hello-ready" | "first-inference",
    nodeTimeMs: number,
    workerTimeMs?: number,
  ) => {
    try {
      log.debug("node worker startup", {
        launchId: identity.launchId,
        runId: identity.runId,
        environmentId: identity.environmentId,
        sessionId: identity.sessionId,
        ownerEpoch: identity.ownerEpoch,
        placementGeneration: identity.placementGeneration,
        planHash: identity.planHash,
        turnId: identity.launchId,
        phase,
        nodeTimeMs,
        nodeElapsedMs: nodeTimeMs - receivedAtMs,
        ...(workerTimeMs === undefined ? {} : { workerTimeMs }),
      });
    } catch {
      // A diagnostic sink failure must not change launch or turn settlement.
    }
  };
  record("launch-received", receivedAtMs);
  return {
    startGateOpened() {
      if (gateRecorded) {
        return;
      }
      gateRecorded = true;
      record("start-gate-opened", performance.now());
    },
    accept(value: unknown) {
      const message = parseNodeWorkerStartupMessage(value);
      if (
        !message ||
        message.runId !== identity.runId ||
        message.turnId !== identity.launchId ||
        inferenceRecorded
      ) {
        return;
      }
      if (message.phase === "hello-ready") {
        if (helloAtMs !== undefined) {
          return;
        }
        helloAtMs = message.workerTimeMs;
      } else {
        if (helloAtMs === undefined || message.workerTimeMs < helloAtMs) {
          return;
        }
        inferenceRecorded = true;
      }
      // Node and child clocks have different origins. Only compare each clock
      // with itself; IPC arrival is not the worker's event timestamp.
      record(message.phase, performance.now(), message.workerTimeMs);
    },
  };
}
