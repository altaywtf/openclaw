import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  augmentModelCatalogWithAgentHarness: vi.fn(),
  loadAuthStore: vi.fn(() => ({ version: 1, profiles: {} })),
}));

vi.mock("../../agents/harness/model-catalog.js", () => ({
  augmentModelCatalogWithAgentHarness: mocks.augmentModelCatalogWithAgentHarness,
}));

vi.mock("../../agents/prepared-model-runtime.auth-store.js", () => ({
  loadPreparedModelRuntimeAuthStore: mocks.loadAuthStore,
}));

const authStore: AuthProfileStore = {
  version: 1,
  profiles: {
    "custom:test": { type: "api_key", provider: "custom", key: "test-provider-key" },
  },
};

function catalogEntry(id: string): ModelCatalogEntry {
  return { id, name: id, provider: "custom", api: "openai-responses" };
}

function preparedMetadataSnapshot() {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "custom",
        providers: ["custom"],
        modelIdNormalization: {
          providers: {
            custom: {
              aliases: {
                legacy: "modern",
              },
            },
          },
        },
      },
    ],
  });
}

function publishedSource(cfg: OpenClawConfig, snapshot: ModelCatalogSnapshot) {
  const facts = {
    metadataSnapshot: preparedMetadataSnapshot(),
    authStore,
    providerAuth: {},
    authMaterializations: [],
  };
  const loadGatewayModelCatalogSnapshot = vi.fn();
  const context = {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalogSnapshot,
    logGateway: { debug: vi.fn() },
  } as GatewayRequestContext;
  return {
    kind: "published" as const,
    context,
    config: cfg,
    snapshot,
    facts,
  };
}

describe("models.list plugin metadata handoff", () => {
  beforeEach(() => {
    mocks.augmentModelCatalogWithAgentHarness.mockClear();
    mocks.loadAuthStore.mockClear();
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("uses published normalization and auth facts in startup projection and browse", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "custom/legacy" },
          models: {
            "custom/legacy": { alias: "Preferred" },
            "custom/another": {},
          },
        },
      },
    };
    const snapshot: ModelCatalogSnapshot = {
      entries: [catalogEntry("modern"), catalogEntry("another"), catalogEntry("not-configured")],
      routeVariants: [],
    };
    const source = publishedSource(cfg, snapshot);
    const inventory = await buildModelsListResult({
      source,
      agentId: "main",
      params: { view: "all" },
    });
    expect(inventory.models.map((entry) => entry.id)).toEqual([
      "another",
      "modern",
      "not-configured",
    ]);

    const result = await buildModelsListResult({
      source,
      agentId: "main",
      params: { view: "configured" },
    });

    expect(result.models).toEqual([
      expect.objectContaining({ provider: "custom", id: "another", available: true }),
      expect.objectContaining({
        provider: "custom",
        id: "modern",
        alias: "Preferred",
        available: true,
      }),
    ]);
    expect(source.context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(mocks.augmentModelCatalogWithAgentHarness).not.toHaveBeenCalled();
    expect(mocks.loadAuthStore).not.toHaveBeenCalled();
  });

  it("keeps provider settings paired with the captured auth store", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://custom.invalid",
            api: "openai-responses",
            models: [{ id: "modern", name: "Modern" }],
          },
        },
      },
    };
    const source = publishedSource(cfg, {
      entries: [catalogEntry("modern")],
      routeVariants: [],
    });
    const result = await buildModelsListResult({
      source,
      agentId: "main",
      params: { view: "provider-config" },
    });
    expect(result.models).toEqual([
      expect.objectContaining({ provider: "custom", id: "modern", available: true }),
    ]);
    expect(mocks.loadAuthStore).not.toHaveBeenCalled();
  });

  it.each(["default", "configured", "all"] as const)(
    "keeps an empty published %s view empty without discovery",
    async (view) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { models: { "custom/*": {} } } },
      };
      const source = publishedSource(cfg, { entries: [], routeVariants: [] });

      const result = await buildModelsListResult({
        source,
        agentId: "main",
        params: { view },
      });

      expect(result.models).toEqual([]);
      expect(source.context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(mocks.augmentModelCatalogWithAgentHarness).not.toHaveBeenCalled();
    },
  );

  it.each(["default", "configured"] as const)(
    "includes configured static rows in the %s picker without harness discovery",
    async (view) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "custom/modern" } },
      };
      const source = publishedSource(cfg, {
        entries: [],
        routeVariants: [],
        staticEntries: [catalogEntry("modern"), catalogEntry("not-configured")],
      });

      const result = await buildModelsListResult({
        source,
        agentId: "main",
        params: { view },
      });

      expect(result.models).toEqual([
        expect.objectContaining({ provider: "custom", id: "modern", available: true }),
      ]);
      expect(source.context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(mocks.augmentModelCatalogWithAgentHarness).not.toHaveBeenCalled();
    },
  );
});
