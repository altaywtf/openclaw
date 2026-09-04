// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  registerPreparedModelRuntimePublicationListener,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime reload auth adoption", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it("retains discovered models without rediscovery on a token rotation", async () => {
    mocks.configuredAgentIds = ["default"];
    const credential = {
      type: "oauth" as const,
      provider: "custom",
      accountId: "same-account",
      access: "initial-access",
      refresh: "initial-refresh",
      expires: Date.now() + 60_000,
    };
    mocks.preparedAuthStore = { version: 1, profiles: { "custom:default": credential } };
    mocks.authStorage.getAll.mockReturnValue({ custom: credential });
    mocks.runPreparedModelCatalogWorker.mockResolvedValue({
      entries: [{ id: "discovered-model", name: "Discovered Model", provider: "custom" }],
      routeVariants: [],
      providerOutcomes: [
        { provider: "custom", profileId: "custom:default", status: "auth-rejected" },
      ],
    });
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    };

    await refreshPreparedModelRuntimeSnapshots(input.config, {
      gatewayLifecycle: true,
    });
    // Publication kicked birth discovery; an ordinary read joins that in-flight build.
    const original = await prepareModelRuntimeSnapshot(input);
    await original.loadFullModelCatalog?.();
    expect(original.readFullModelCatalog?.()?.entries).toEqual([
      expect.objectContaining({ id: "discovered-model" }),
    ]);
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    mocks.runPreparedModelCatalogWorker.mockClear();
    mocks.createPreparedModelCatalogWorkerInput.mockClear();
    mocks.preparedAuthStore = {
      version: 1,
      profiles: {
        "custom:default": { ...credential, access: "rotated-access", refresh: "rotated-refresh" },
      },
    };
    mocks.mutationListener?.({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: false,
    });

    const refreshed = await prepareModelRuntimeSnapshot(input);
    expect(refreshed.readFullModelCatalog?.()?.entries).toEqual([
      expect.objectContaining({ id: "discovered-model" }),
    ]);
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
    expect(refreshed.readFullModelCatalog!()?.providerOutcomes).not.toContainEqual(
      expect.objectContaining({ status: "auth-rejected" }),
    );
    expect(getPreparedModelFullCatalogAuth(refreshed.readFullModelCatalog!()!)?.authStore).toEqual(
      mocks.preparedAuthStore,
    );
    expect(() => original.readFullModelCatalog!()).toThrow("superseded");
    expect(
      mocks.createPreparedModelCatalogWorkerInput.mock.calls.at(-1)?.[0].agentFacts.providerIds,
    ).toEqual(["custom"]);
  });

  it("reprepares worker-only auth without rediscovering retained models", async () => {
    mocks.configuredAgentIds = ["default"];
    mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
      mocks.authStorage.getAll.mockReturnValue({
        custom: { type: "api_key", key: "configured-key" },
        discovered: { type: "api_key", key: "worker-key" },
      });
      return {
        entries: [{ provider: "discovered", id: "worker-model", name: "Worker Model" }],
        routeVariants: [],
      };
    });
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    };
    await refreshPreparedModelRuntimeSnapshots(input.config, { gatewayLifecycle: true });
    const original = await prepareModelRuntimeSnapshot(input);
    await original.loadFullModelCatalog!();
    expect(original.providerAuth.discovered).toBeUndefined();
    mocks.authStorage.getAll.mockReturnValue({ custom: { type: "api_key", key: "rotated" } });
    mocks.runPreparedModelAuthWorker.mockResolvedValue({
      authStore: { version: 1, profiles: {} },
      providerAuth: { discovered: { mode: "api_key" } },
    });
    mocks.mutationListener?.({
      agentDir: input.agentDir,
      affectsInheritedStores: false,
      profileSetChanged: false,
    });
    const refreshed = await prepareModelRuntimeSnapshot(input);
    expect(
      getPreparedModelFullCatalogAuth(refreshed.readFullModelCatalog!()!)?.providerAuth,
    ).toMatchObject({ discovered: { mode: "api_key" } });
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    expect(mocks.runPreparedModelAuthWorker).toHaveBeenCalledOnce();
  });

  it("finishes birth discovery when token rotation retires its first worker", async () => {
    mocks.configuredAgentIds = ["default"];
    const firstDiscovery = createDeferred<{ entries: []; routeVariants: [] }>();
    mocks.runPreparedModelCatalogWorker.mockImplementationOnce(() => firstDiscovery.promise);
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    };
    try {
      await refreshPreparedModelRuntimeSnapshots(input.config, { gatewayLifecycle: true });
      await vi.waitFor(() => expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce());
      mocks.mutationListener?.({
        agentDir: input.agentDir,
        affectsInheritedStores: false,
        profileSetChanged: false,
      });
      const refreshed = await prepareModelRuntimeSnapshot(input);
      firstDiscovery.resolve({ entries: [], routeVariants: [] });
      await vi.waitFor(() => expect(refreshed.readFullModelCatalog!()).toBeDefined());
      expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
    } finally {
      firstDiscovery.resolve({ entries: [], routeVariants: [] });
    }
  });

  it("reports failed discovery while retaining the published inventory", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const snapshot = await prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config: {},
    });
    const original = await snapshot.loadFullModelCatalog!();
    const listener = vi.fn();
    const unregister = registerPreparedModelRuntimePublicationListener(listener);
    const failure = new Error("catalog service unavailable");
    try {
      mocks.runPreparedModelCatalogWorker.mockRejectedValueOnce(failure);
      await expect(snapshot.loadFullModelCatalog!({ refresh: true })).rejects.toThrow(failure);
      expect(snapshot.readFullModelCatalog!()).toBe(original);
      expect(snapshot.readFullModelCatalog!()?.refreshFailed).toBe(true);
      expect(listener).toHaveBeenCalledWith({ phase: "catalog-failed", error: failure });
      await snapshot.loadFullModelCatalog!({ refresh: true });
      expect(snapshot.readFullModelCatalog!()?.refreshFailed).toBeUndefined();
    } finally {
      unregister();
    }
  });

  it("rediscovers the catalog once when an auth mutation changes the profile set", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
    });
    const snapshot = await prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      config,
    });
    await snapshot.loadFullModelCatalog?.();
    expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce();
    mocks.runPreparedModelCatalogWorker.mockClear();

    mocks.mutationListener?.({
      agentDir: state.agentDir("default"),
      affectsInheritedStores: false,
      profileSetChanged: true,
    });

    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ config });
    await vi.waitFor(() => expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledOnce());
  });

  it("commits config build, auth drain, publication, and dispatch in order", async () => {
    mocks.configuredAgentIds = ["default"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
    });
    const phases: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) =>
      phases.push(phase),
    );
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("default"),
        affectsInheritedStores: false,
        profileSetChanged: true,
      });
      const dispatch = loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" });
      await refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      await dispatch;
      expect(phases).toContain("published");
      expect(phases.indexOf("invalidated")).toBeLessThan(phases.indexOf("published"));
    } finally {
      unregister();
    }
  });

  it("recovers with a corrective auth mutation after a failed build", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
    });
    const failure = new Error("auth refresh build failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw failure;
    });
    mocks.mutationListener?.({
      agentDir: state.agentDir("default"),
      affectsInheritedStores: false,
      profileSetChanged: true,
    });
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).rejects.toBe(
      failure,
    );

    mocks.mutationListener?.({
      agentDir: state.agentDir("default"),
      affectsInheritedStores: false,
      profileSetChanged: true,
    });
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }),
    ).resolves.toMatchObject({ agentId: "default" });
  });

  it("commits no published owner when the final independent owner fails", async () => {
    mocks.configuredAgentIds = ["default", "secondary"];
    await refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true });
    const failure = new Error("secondary auth refresh failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => mocks.authStorage);
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(refreshPreparedModelRuntimeSnapshots({}, { gatewayLifecycle: true })).rejects.toBe(
      failure,
    );
    await expect(loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" })).rejects.toThrow(
      "not published",
    );
    await expect(
      loadPublishedGatewayReplyDispatchRuntime({ agentId: "secondary" }),
    ).rejects.toThrow("not published");
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
