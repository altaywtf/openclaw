import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { buildModelsListResult } from "./models-list-result.js";

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
  return {
    kind: "published" as const,
    context: { getRuntimeConfig: () => cfg },
    config: cfg,
    snapshot,
    facts,
  };
}

describe("models.list plugin metadata handoff", () => {
  beforeEach(() => {
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
  });

  it("keeps an empty published catalog empty", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: { "custom/*": {} } } },
    };
    const source = publishedSource(cfg, { entries: [], routeVariants: [] });

    const result = await buildModelsListResult({
      source,
      agentId: "main",
      params: { view: "default" },
    });

    expect(result.models).toEqual([]);
  });

  it("includes configured static rows in the default picker", async () => {
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
      params: { view: "default" },
    });

    expect(result.models).toEqual([
      expect.objectContaining({ provider: "custom", id: "modern", available: true }),
    ]);
  });
});
