import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ActivateSetupInferenceParams } from "../../system-agent/setup-inference-core.js";
import {
  activateGatewaySetupInference,
  runSystemAgentGatewayTask,
} from "./system-agent-execution.js";

const mocks = vi.hoisted(() => ({
  activateSetup: vi.fn(),
  appliedHash: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: mocks.activateSetup,
}));
vi.mock("../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-snapshot.js")>()),
  getRuntimeConfigAppliedHash: mocks.appliedHash,
}));

describe("saved credential runtime application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCommandQueueStateForTest();
  });
  afterEach(resetCommandQueueStateForTest);

  it("rechecks the applied config after asynchronous credential preparation", async () => {
    const application = createRuntimeConfigWriteApplication();
    const claim = application.claim()!;
    const preparing = createDeferredCore<void>();
    const release = createDeferredCore<void>();
    const persisted = vi.fn();
    mocks.appliedHash.mockReturnValue("fixture-committed-config");
    mocks.activateSetup.mockImplementation(async (params: ActivateSetupInferenceParams) => {
      params.onRuntimeApplication?.(application);
      params.onCredentialActivation?.({
        sourceConfigHash: "fixture-committed-config",
        activate: async (beforeCommit?: () => void) => {
          preparing.resolve();
          await release.promise;
          beforeCommit?.();
          persisted();
        },
      });
      claim.settle("applied");
      return { ok: true, modelRef: "fixture/model", latencyMs: 1, lines: [] };
    });
    const completion = activateGatewaySetupInference({
      kind: "saved-auth:fixture%3Acandidate",
      surface: "gateway",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await preparing.promise;
      mocks.appliedHash.mockReturnValue("fixture-newer-config");
      release.resolve();
      const completed = await completion;
      expect(persisted).not.toHaveBeenCalled();
      expect("error" in completed && String(completed.error)).toContain("remains pending");
    } finally {
      release.resolve();
      claim.settle("stopped");
      await completion;
    }
  });

  it.each([
    "applied",
    "applied-restart-required",
    "restart-pending",
    "failed",
    "stopped",
    "superseded",
    "unclaimed",
    "hash-changed",
    "write-restart-required",
  ] as const)("keeps the credential pending until the exact config serves: %s", async (outcome) => {
    const application = createRuntimeConfigWriteApplication();
    const claim = outcome === "unclaimed" ? undefined : application.claim()!;
    const registered = createDeferredCore<void>();
    const activateCredential = vi.fn();
    mocks.appliedHash.mockReturnValue("fixture-old-config");
    mocks.activateSetup.mockImplementation(async (params: ActivateSetupInferenceParams) => {
      params.onRuntimeApplication?.(application);
      params.onCredentialActivation?.({
        sourceConfigHash: "fixture-committed-config",
        activate: activateCredential,
      });
      registered.resolve();
      return {
        ok: true,
        modelRef: "fixture/model",
        latencyMs: 1,
        lines: [],
        ...(outcome === "write-restart-required" ? { gatewayRestartRequired: true } : {}),
      };
    });
    const completion = activateGatewaySetupInference({
      kind: "saved-auth:fixture%3Acandidate",
      surface: "gateway",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      await registered.promise;
      await runSystemAgentGatewayTask(async () => undefined);
      expect(activateCredential).not.toHaveBeenCalled();
      mocks.appliedHash.mockReturnValue(
        outcome === "hash-changed" ? "fixture-newer-config" : "fixture-committed-config",
      );
      claim?.settle(
        outcome === "hash-changed" || outcome === "write-restart-required"
          ? "applied"
          : outcome === "unclaimed"
            ? "unclaimed"
            : outcome,
      );
      const completed = await completion;
      if (outcome === "applied") {
        expect(completed).toMatchObject({ result: { ok: true } });
        expect(activateCredential).toHaveBeenCalledOnce();
      } else {
        expect(activateCredential).not.toHaveBeenCalled();
        if (
          outcome === "applied-restart-required" ||
          outcome === "restart-pending" ||
          outcome === "write-restart-required"
        ) {
          expect(completed).toMatchObject({
            result: {
              ok: true,
              gatewayRestartRequired: true,
              lines: [expect.stringContaining("remains pending")],
            },
          });
        } else {
          expect("error" in completed && String(completed.error)).toContain("remains pending");
        }
      }
    } finally {
      claim?.settle("stopped");
      await completion;
    }
  });
});
