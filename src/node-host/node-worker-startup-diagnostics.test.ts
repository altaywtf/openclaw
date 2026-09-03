import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi as logTestApi } from "../logging/logger.test-support.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  NODE_WORKER_STARTUP_MESSAGE_TYPE,
  parseNodeWorkerStartupMessage,
} from "../worker/node-supervisor-protocol.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import {
  createNodeWorkerSupervisorFixture,
  waitForNodeWorkerTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await logTestApi.flushFileLogQueueForTests();
  resetLogger();
  setLoggerOverride(null);
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

it("accepts only bounded closed startup frames", () => {
  const message = {
    type: NODE_WORKER_STARTUP_MESSAGE_TYPE,
    runId: "r".repeat(256),
    turnId: "t".repeat(256),
    phase: "hello-ready",
    workerTimeMs: 1.5,
  };
  expect(parseNodeWorkerStartupMessage(message)).toEqual(message);
  for (const invalid of [
    { ...message, runId: "r".repeat(257) },
    { ...message, turnId: "t".repeat(257) },
    { ...message, runId: "" },
    { ...message, turnId: "turn\0" },
    { ...message, phase: "arbitrary-detail" },
    { ...message, credential: "must-not-project" },
    ...[-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"].map((workerTimeMs) => ({
      ...message,
      workerTimeMs,
    })),
  ]) {
    expect(parseNodeWorkerStartupMessage(invalid)).toBeNull();
  }
});

it("correlates real IPC with the current turn, bounds duplicates, and keeps cancellation authoritative", async () => {
  const root = tempDirs.make("node-startup-");
  const { supervisor, bundleRoot, workspaceDir } = createNodeWorkerSupervisorFixture(root);
  const logFile = path.join(root, "startup.log");
  setLoggerOverride({ level: "debug", file: logFile, consoleLevel: "silent" });
  const input = testWorkerLaunchInput(workspaceDir, "startup-first", "startup");
  const workerFile = path.join(
    bundleRoot,
    input.gatewayNamespace,
    "bundles",
    input.expectedBundleHash,
    "worker.mjs",
  );
  // Exercise the real supervisor, process gate, IPC adapter, stores and log sink.
  // Only the worker workload is synthetic; it deliberately sends hostile telemetry.
  fs.writeFileSync(
    workerFile,
    TEST_WORKER_SOURCE.replace("let currentTurn;", "let currentTurn; let previousStartup;").replace(
      'if (mode === "admission-rearm") {',
      String.raw`if (mode === "startup" || mode === "startup-hold") {
  const send = (message) => new Promise((resolve) => process.send(message, resolve));
  const frame = {
    type: "openclaw-worker-startup-v1", runId: descriptor.assignment.runId,
    turnId: descriptor.assignment.turnId, phase: "hello-ready", workerTimeMs: 10,
  };
  if (previousStartup) await send(previousStartup);
  await send({ ...frame, phase: "first-inference", workerTimeMs: 20 });
  await send({ ...frame, runId: "wrong-run" });
  await send({ ...frame, turnId: "wrong-turn" });
  await send({ ...frame, extra: descriptor.admission.credential });
  await send(frame);
  for (let count = 0; count < 20; count++) await send(frame);
  await send({ ...frame, phase: "first-inference", workerTimeMs: 9 });
  if (mode === "startup-hold") return;
  previousStartup = { ...frame, phase: "first-inference", workerTimeMs: 20 };
  for (let count = 0; count < 20; count++) await send(previousStartup);
  finish(descriptor, completedResult, true);
} else if (mode === "admission-rearm") {`,
    ),
  );
  const events = () => {
    logTestApi.drainFileLogQueueSyncForTests();
    return fs
      .readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row["2"] === "node worker startup")
      .map((row) => row["1"] as Record<string, unknown>);
  };
  const next = (turnId: string, prompt = "startup") => {
    const launch = testWorkerLaunchInput(workspaceDir, turnId, prompt);
    launch.descriptor.assignment.runId = `run-${turnId}`;
    launch.descriptor.assignment.operationalRunInstance.runId = launch.descriptor.assignment.runId;
    return launch;
  };
  let owner: Awaited<ReturnType<typeof supervisor.launch>> | undefined;
  try {
    owner = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect((await waitForNodeWorkerTerminal(supervisor, input.launchId)).state).toBe("completed");
    const count = events().length;
    await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(events()).toHaveLength(count);
    const second = next("startup-second");
    expect(await supervisor.launch(second, TEST_WORKER_ENDPOINT)).toMatchObject({
      worker: owner.worker,
    });
    await waitForNodeWorkerTerminal(supervisor, second.launchId);
    const cancelled = next("startup-cancelled", "startup-hold");
    await supervisor.launch(cancelled, TEST_WORKER_ENDPOINT);
    await vi.waitFor(() =>
      expect(events()).toContainEqual(
        expect.objectContaining({
          launchId: cancelled.launchId,
          phase: "hello-ready",
        }),
      ),
    );
    expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(cancelled))).toMatchObject({
      state: "cancelled",
    });
    const final = next("startup-final");
    const replacement = await supervisor.launch(final, TEST_WORKER_ENDPOINT);
    expect(replacement.worker).not.toEqual(owner.worker);
    await waitForNodeWorkerTerminal(supervisor, final.launchId);

    for (const launch of [input, second, cancelled, final]) {
      const observed = events().filter((event) => event.launchId === launch.launchId);
      expect(observed.map((event) => event.phase)).toEqual([
        "launch-received",
        ...(launch === input || launch === final ? ["start-gate-opened"] : []),
        "hello-ready",
        ...(launch === cancelled ? [] : ["first-inference"]),
      ]);
      for (const event of observed) {
        expect(event).toMatchObject({
          ...testNodeWorkerLaunchIdentity(launch),
          turnId: launch.launchId,
        });
        expect(event.nodeElapsedMs).toBeGreaterThanOrEqual(0);
      }
      const nodeTimes = observed.map((event) => Number(event.nodeTimeMs));
      expect(nodeTimes).toEqual(nodeTimes.toSorted((a, b) => a - b));
      expect(observed.find((event) => event.phase === "hello-ready")?.workerTimeMs).toBe(10);
    }
    expect(fs.readFileSync(logFile, "utf8")).not.toContain(input.descriptor.admission.credential);
  } finally {
    await supervisor.close();
  }
  expect(owner?.worker).toBeDefined();
  expect(inspectNodeWorkerProcessIdentity(owner!.worker!)).toMatch(/^(dead|reused)$/u);
});
