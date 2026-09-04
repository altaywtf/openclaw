// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readPublishedPreparedModelCatalog } from "./prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime scoped refresh", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it.each([
    { change: "neutral", scoped: false, retained: true },
    { change: "neutral", scoped: true, retained: true },
    { change: "provider", scoped: false, retained: false },
    { change: "plugin", scoped: false, retained: false },
    { change: "account", scoped: false, retained: false },
    { change: "default-model", scoped: false, retained: false },
    { change: "agent-model", scoped: true, retained: false },
  ])(
    "preserves only compatible inventory with fresh auth after $change reload (scoped: $scoped)",
    async ({ change, scoped, retained }) => {
      mocks.configuredAgentIds = ["pro"];
      const config: OpenClawConfig = {
        agents: { entries: { pro: {} } },
        models: {
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "https://first.example.test/v1",
              models: [],
            },
          },
        },
        plugins: { entries: { custom: { enabled: true, config: { region: "first" } } } },
      };
      const credential = {
        type: "oauth" as const,
        provider: "custom",
        accountId: "first-account",
        access: "initial-access",
        refresh: "initial-refresh",
        expires: 4_102_444_800_000,
      };
      const initialAuthStore = {
        version: 1,
        profiles: { "custom:primary": credential },
      };
      mocks.preparedAuthStore = initialAuthStore;
      mocks.authStorage.getAll.mockReturnValue({ custom: credential });
      const discovered = {
        provider: "custom",
        id: "discovered-model",
        name: "Discovered Model",
      };
      mocks.runPreparedModelCatalogWorker.mockResolvedValue({
        entries: [discovered],
        routeVariants: [discovered],
      });
      await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
      const input = { agentId: "pro", agentDir: state.agentDir("pro"), config };
      const original = getPreparedModelRuntimeSnapshot(input)!;
      await original.loadFullModelCatalog!();
      expect(readPublishedPreparedModelCatalog(original).modelCatalog.entries).toMatchObject([
        discovered,
      ]);

      const refreshedCredential = {
        ...credential,
        accountId: change === "account" ? "second-account" : credential.accountId,
        access: "refreshed-access",
        refresh: "refreshed-refresh",
      };
      const refreshedAuthStore = {
        version: 1,
        profiles: { "custom:primary": refreshedCredential },
      };
      mocks.preparedAuthStore = refreshedAuthStore;
      mocks.authStorage.getAll.mockReturnValue({ custom: refreshedCredential });
      const nextConfig = structuredClone(config);
      nextConfig.messages = { responsePrefix: "updated" };
      if (change === "provider") {
        nextConfig.models!.providers!.custom!.baseUrl = "https://second.example.test/v1";
      }
      if (change === "plugin") {
        nextConfig.plugins!.entries!.custom!.config = { region: "second" };
      }
      const configuredModelChanged = change === "default-model" || change === "agent-model";
      if (configuredModelChanged) {
        const selection = { model: "custom/newly-configured" };
        if (change === "default-model") {
          nextConfig.agents!.defaults = selection;
        } else {
          nextConfig.agents!.entries!.pro = selection;
        }
        mocks.resolveStaticCatalogModel.mockReturnValue({
          provider: "custom",
          id: "newly-configured",
          name: "Newly Configured",
          api: "openai-completions",
          baseUrl: "https://first.example.test/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
        });
      }
      mocks.runPreparedModelCatalogWorker.mockRejectedValue(new Error("discovery unavailable"));
      await refreshPreparedModelRuntimeSnapshots(nextConfig, {
        gatewayLifecycle: true,
        ...(scoped ? { agentIds: new Set(["pro"]) } : {}),
      });
      const replacement = getPreparedModelRuntimeSnapshot({ ...input, config: nextConfig })!;
      const expectedEntries = configuredModelChanged
        ? [{ provider: "custom", id: "newly-configured" }]
        : retained
          ? [discovered]
          : [];
      if (configuredModelChanged) {
        expect(replacement.modelCatalog.entries).toMatchObject(expectedEntries);
      }
      const published = readPublishedPreparedModelCatalog(replacement);
      expect(published.modelCatalog.entries).toMatchObject(expectedEntries);
      expect(getPreparedModelRuntimeAuthStore(published)).toEqual(refreshedAuthStore);
      expect(getPreparedModelRuntimeAuthStore(published)).not.toBe(initialAuthStore);
      expect(() => original.readFullModelCatalog!()).toThrow("superseded");

      await expect(replacement.loadFullModelCatalog!({ refresh: true })).rejects.toThrow(
        "discovery unavailable",
      );
      const afterFailure = readPublishedPreparedModelCatalog(replacement);
      expect(afterFailure.modelCatalog).toMatchObject({
        entries: expectedEntries,
        refreshFailed: true,
      });
      expect(getPreparedModelRuntimeAuthStore(afterFailure)).toEqual(refreshedAuthStore);
    },
  );

  it.each([false, true])(
    "retains catalog callbacks across scoped exec reloads (warmed: %s)",
    async (warmed) => {
      mocks.configuredAgentIds = ["pro", "free"];
      const initialConfig = {
        agents: {
          defaults: { model: "openai/gpt-5.6-luna" },
          entries: {
            pro: { tools: { exec: { security: "full", ask: "off" } } },
            free: {},
          },
        },
      } satisfies OpenClawConfig;
      const buildCounts: number[] = [];
      const options = {
        gatewayLifecycle: true,
        onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
      };
      const freeInput = {
        config: initialConfig,
        agentId: "free",
        agentDir: state.agentDir("free"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: "/tmp/workspace-free",
      };
      const proInput = {
        ...freeInput,
        agentId: "pro",
        agentDir: state.agentDir("pro"),
        workspaceDir: "/tmp/workspace-pro",
      };
      // The harness stubs discovery, not the snapshot's catalog guards. Real worker retirement
      // and auth liveness are covered by prepared-model-catalog-worker.integration.test.ts.
      mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
        entries: [],
        routeVariants: [],
      }));
      await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
      const retainedReader = getPreparedModelRuntimeSnapshot(freeInput)!;
      const retainedAuthStore = getPreparedModelRuntimeAuthStore(retainedReader);
      let catalog = warmed ? await retainedReader.loadFullModelCatalog!() : undefined;

      for (const ask of ["always", "off"] as const) {
        const previousPro = getPreparedModelRuntimeSnapshot(proInput)!;
        const nextConfig = {
          agents: {
            ...initialConfig.agents,
            entries: {
              ...initialConfig.agents.entries,
              pro: { tools: { exec: { security: "full", ask } } },
            },
          },
        } satisfies OpenClawConfig;
        await refreshPreparedModelRuntimeSnapshots(nextConfig, {
          ...options,
          agentIds: new Set(["pro"]),
        });

        const retained = getPreparedModelRuntimeSnapshot({ ...freeInput, config: nextConfig })!;
        expect(retained).toMatchObject({ agentId: "free", config: nextConfig });
        expect(retained).not.toBe(retainedReader);
        expect(retainedReader.config).toBe(initialConfig);
        expect(retained.metadataSnapshot).toBe(retainedReader.metadataSnapshot);
        expect(retained.modelCatalog).toBe(retainedReader.modelCatalog);
        expect(getPreparedModelRuntimeAuthStore(retained)).toBe(retainedAuthStore);
        expect(retained.readFullModelCatalog!()).toBe(catalog);
        expect(retainedReader.readFullModelCatalog!()).toBe(catalog);
        const refreshed = await retained.loadFullModelCatalog!({ refresh: true });
        expect(refreshed).not.toBe(catalog);
        expect(retainedReader.readFullModelCatalog!()).toBe(refreshed);
        catalog = refreshed;
        expect(() => previousPro.readFullModelCatalog!()).toThrow("superseded");
        await expect(previousPro.loadFullModelCatalog!()).rejects.toThrow("superseded");
      }
      expect(buildCounts).toEqual([2, 1, 1]);
    },
  );

  it("falls back to full refresh when an out-of-scope owner dependency changes", async () => {
    mocks.configuredAgentIds = ["pro", "free"];
    const initialConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.6" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { pro: {}, free: {} },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([2, 2]);
  });

  it("builds only a newly added non-default agent", async () => {
    mocks.configuredAgentIds = ["free"];
    const initialConfig = {
      agents: { entries: { free: { model: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const nextConfig = {
      agents: {
        entries: {
          free: { model: "openai/gpt-5.5" },
          pro: { model: "openai/gpt-5.6" },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];

    await refreshPreparedModelRuntimeSnapshots(initialConfig, {
      gatewayLifecycle: true,
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });
    mocks.configuredAgentIds = ["free", "pro"];
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      gatewayLifecycle: true,
      agentIds: new Set(["pro"]),
      onBuildStats: (stats) => buildCounts.push(stats.agentCount),
    });

    expect(buildCounts).toEqual([1, 1]);
    expect(
      getPreparedModelRuntimeSnapshot({
        config: nextConfig,
        agentId: "pro",
        agentDir: state.agentDir("pro"),
        inheritedAuthDir: state.agentDir("default"),
        workspaceDir: "/tmp/workspace-pro",
      }),
    ).toMatchObject({ agentId: "pro", config: nextConfig });
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
