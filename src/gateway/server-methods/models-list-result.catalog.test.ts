import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../server-model-catalog-auth.js";
import { registerGatewayModelCatalogPrivateAccess } from "../server-model-catalog-auth.js";
import { buildModelsListResult, prepareModelsListResult } from "./models-list-result.js";

function catalogOwner(
  config: OpenClawConfig,
  entries: ModelCatalogEntry[],
  overrides: Partial<PreparedGatewayModelCatalogSnapshot> = {},
): PreparedGatewayModelCatalogSnapshot {
  return {
    agentId: "main",
    agentDir: "/tmp/models-list-agent",
    workspaceDir: "/tmp/models-list-workspace",
    config,
    providerAuth: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    oauthRefreshProviderIds: [],
    authMaterializations: [],
    entries,
    routeVariants: entries,
    catalogComplete: false,
    ...overrides,
  };
}

function catalogContext(
  config: OpenClawConfig,
  access: Parameters<typeof registerGatewayModelCatalogPrivateAccess>[1],
) {
  const loadGatewayModelCatalogSnapshot = vi.fn(async () => {
    throw new Error("Unexpected legacy catalog load");
  });
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, access);
  return { getRuntimeConfig: () => config, loadGatewayModelCatalogSnapshot };
}

describe("models.list completed catalog facts", () => {
  it.each(["default", "configured", "all"] as const)(
    "reads the published %s catalog without starting discovery",
    async (view) => {
      const config: OpenClawConfig = {
        agents: { defaults: { model: "test/curated" } },
      };
      const curated = {
        provider: "test",
        id: "curated",
        name: "Curated",
        api: "openai-completions" as const,
        baseUrl: "https://test.invalid",
      };
      const owner = catalogOwner(config, [curated], {
        providerAuth: { test: { mode: "api_key" } },
        authStore: {
          version: 1,
          profiles: {
            "test:default": { type: "api_key", provider: "test", key: "synthetic-key" },
          },
        },
      });
      const loadDeferred = vi.fn(async () => {
        throw new Error("List reads must not start discovery");
      });
      const context = catalogContext(config, {
        loadDeferred,
        readPrepared: async () => owner,
      });

      const result = await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view },
      });

      expect(result.models).toEqual([
        expect.objectContaining({ provider: "test", id: "curated", available: true }),
      ]);
      expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(loadDeferred).not.toHaveBeenCalled();
    },
  );

  it("does not construct a catalog when the lifecycle owner is unavailable", async () => {
    const config: OpenClawConfig = {};
    const loadDeferred = vi.fn(async () => {
      throw new Error("Unexpected request-time catalog construction");
    });
    const context = catalogContext(config, {
      loadDeferred,
      readPrepared: async () => undefined,
    });

    await expect(
      buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view: "configured" },
      }),
    ).rejects.toThrow("Model catalog is not ready");
    expect(loadDeferred).not.toHaveBeenCalled();
  });

  it.each([undefined, "test"])(
    "does not return an owner replaced while its published snapshot is being read (provider=%s)",
    async (provider) => {
      const config: OpenClawConfig = {};
      const stale = { id: "stale", name: "Stale", provider: "previous" };
      const current = { id: "current", name: "Current", provider: "test" };
      const owner = catalogOwner(config, [current], {
        catalogComplete: true,
      });
      const readPrepared = vi
        .fn(async () => owner)
        .mockImplementationOnce(async () => {
          notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
          return { ...owner, entries: [stale], routeVariants: [stale] };
        });
      const loadDeferred = vi.fn();
      const context = catalogContext(config, {
        loadDeferred,
        readPrepared,
      });
      const result = await buildModelsListResult({
        source: {
          kind: "gateway",
          context,
        },
        agentId: "main",
        params: { view: "all", ...(provider ? { provider } : {}) },
      });
      expect(result.models).toEqual([expect.objectContaining({ id: "current" })]);
      expect(readPrepared).toHaveBeenCalledTimes(2);
      expect(loadDeferred).not.toHaveBeenCalled();
    },
  );

  it("uses a refreshed generation for the next ordinary read without rediscovery", async () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "test/discovered" } },
    };
    const discovered = { id: "discovered", name: "Discovered", provider: "test" };
    const owner = catalogOwner(config, [discovered], {
      catalogComplete: true,
    });
    const loadDeferred = vi.fn(async () => {
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      return owner;
    });
    const readPrepared = vi.fn(async () => owner);
    const context = catalogContext(config, {
      loadDeferred,
      readPrepared,
    });

    const refreshed = await prepareModelsListResult({
      source: { kind: "gateway", context },
      agentId: "main",
      params: { view: "configured", refresh: true },
    });
    expect(refreshed.isCurrent()).toBe(true);
    const ordinary = await buildModelsListResult({
      source: { kind: "gateway", context },
      agentId: "main",
      params: { view: "configured" },
    });

    expect(ordinary.models).toEqual([expect.objectContaining({ id: "discovered" })]);
    expect(loadDeferred).toHaveBeenCalledOnce();
    expect(readPrepared).toHaveBeenCalledTimes(2);
    notifyPreparedModelRuntimePublication({ phase: "invalidated" });
    expect(refreshed.isCurrent()).toBe(false);
  });

  it("uses an inherited auth profile from the prepared owner", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "models-list-inherited-auth-", agentEnv: "main" },
      async (state) => {
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              "test:inherited": { type: "api_key", provider: "test", key: "synthetic-key" },
            },
          },
          "main",
        );
        const config: OpenClawConfig = {
          agents: {
            defaults: {
              authInheritance: { agentId: "main" },
              model: "test/inherited",
            },
            entries: { worker: { model: "test/inherited" } },
          },
          models: {
            providers: {
              test: {
                baseUrl: "http://127.0.0.1:1",
                models: [
                  {
                    id: "inherited",
                    name: "Inherited",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32_000,
                    maxTokens: 4_096,
                  },
                ],
              },
            },
          },
        };
        const loadGatewayModelCatalogSnapshot = vi.fn();
        const owner = {
          agentId: "worker",
          agentDir: state.agentDir("worker"),
          workspaceDir: "/tmp",
          config,
          providerAuth: {},
          authStore: {
            version: 1,
            profiles: {
              "test:inherited": { type: "api_key", provider: "test", key: "synthetic-key" },
            },
          },
          metadataSnapshot: createPluginMetadataSnapshotFixture(),
          oauthRefreshProviderIds: [],
          authMaterializations: [],
          entries: [
            {
              id: "inherited",
              name: "Inherited",
              provider: "test",
              api: "openai-completions" as const,
              baseUrl: "http://127.0.0.1:1",
              contextWindow: 32_000,
              input: ["text" as const],
            },
          ],
          routeVariants: [],
          catalogComplete: false,
        } satisfies PreparedGatewayModelCatalogSnapshot;
        const context = {
          getRuntimeConfig: () => config,
          loadGatewayModelCatalogSnapshot,
          logGateway: { debug: vi.fn(), warn: vi.fn() },
        } as never;
        registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
          loadDeferred: async () => {
            throw new Error("unexpected discovery");
          },
          readPrepared: async () => owner,
        });

        const result = await buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: "worker",
          params: { view: "configured" },
        });

        expect(result.models).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "inherited", provider: "test", available: true }),
          ]),
        );
      },
    );
  });

  it("rejects when an explicit catalog load fails", async () => {
    const config: OpenClawConfig = {};
    const error = new Error("catalog unavailable");
    const context = catalogContext(config, {
      loadDeferred: async () => {
        throw error;
      },
      readPrepared: async () => undefined,
    });

    await expect(
      buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: "main",
        params: { view: "configured", refresh: true },
      }),
    ).rejects.toBe(error);
  });
});
