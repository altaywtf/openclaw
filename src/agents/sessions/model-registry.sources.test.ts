import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import {
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  type PluginModelCatalogMetadataSnapshot,
} from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const PROVIDER_ID = "registry-source-provider";
const PLUGIN_ID = "registry-source-owner";
const NATIVE_URL = "https://native.registry.invalid/v1";
const ACCOUNT_URL = "https://account.registry.invalid/v1";
const MODEL_PIN_URL = "https://operator.registry.invalid/v1";
const CURRENT_PROVIDER_HEADERS = { "X-Current-Provider": "current-provider" };
const CURRENT_MODEL_HEADERS = { "X-Current-Model": "current-model" };
const metadataSnapshot: PluginModelCatalogMetadataSnapshot = {
  index: { plugins: [{ pluginId: PLUGIN_ID, enabled: true }] },
  plugins: [
    {
      id: PLUGIN_ID,
      modelCatalog: {
        providers: {
          [PROVIDER_ID]: { api: "openai-responses", baseUrl: NATIVE_URL, models: [] },
        },
      },
    },
  ],
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map([[PROVIDER_ID, [PLUGIN_ID]]]),
    modelCatalogProviders: new Map([[PROVIDER_ID, [PLUGIN_ID]]]),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    modelIdNormalizationPolicies: new Map(),
  },
};

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 4_096,
  };
}

function createSourceRegistry(
  options: {
    mode?: "merge" | "replace";
    modelRoute?: Pick<ModelDefinitionConfig, "api" | "baseUrl">;
    sourceKey?: string;
    authStoreKey?: string;
  } = {},
) {
  const root = tempDirs.make("openclaw-registry-sources-");
  const configuredProvider: ModelProviderConfig = {
    api: "openai-responses",
    baseUrl: NATIVE_URL,
    ...(options.sourceKey ? { apiKey: options.sourceKey } : {}),
    headers: CURRENT_PROVIDER_HEADERS,
    models: [
      Object.assign(
        model("known"),
        { name: "Current known", headers: CURRENT_MODEL_HEADERS },
        options.modelRoute,
      ),
      model("configured-only"),
    ],
  };
  const cachedProvider: ModelProviderConfig = {
    api: "openai-responses",
    baseUrl: NATIVE_URL,
    apiKey: "retired-cache-key-not-real",
    authHeader: true,
    headers: { Authorization: "Bearer retired-provider-header-not-real" },
    models: ["known", "cached-only"].map((id) =>
      Object.assign(model(id), {
        api: "openai-responses",
        baseUrl: ACCOUNT_URL,
        headers: { Authorization: "Bearer retired-model-header-not-real" },
      }),
    ),
  };
  const staticProvider: ModelProviderConfig = {
    api: "openai-responses",
    baseUrl: NATIVE_URL,
    models: [model("known"), model("curated-only")],
  };
  return ModelRegistry.create(
    AuthStorage.inMemory(
      options.authStoreKey ? { [PROVIDER_ID]: { type: "api_key", key: options.authStoreKey } } : {},
    ),
    path.join(root, "models.json"),
    {
      config: {
        models: {
          ...(options.mode ? { mode: options.mode } : {}),
          providers: { [PROVIDER_ID]: configuredProvider },
        },
      },
      modelsJsonContents: null,
      pluginCatalogs: [
        {
          pluginId: PLUGIN_ID,
          contents: JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: { [PROVIDER_ID]: cachedProvider },
          }),
        },
      ],
      staticProviderConfigs: { [PROVIDER_ID]: staticProvider },
      pluginMetadataSnapshot: metadataSnapshot,
    },
  );
}

describe("ModelRegistry prepared source ownership", () => {
  it.each([
    {
      name: "native provider preset",
      modelRoute: undefined,
      api: "openai-responses",
      baseUrl: ACCOUNT_URL,
    },
    {
      name: "newer authored model pin",
      modelRoute: { api: "openai-completions", baseUrl: MODEL_PIN_URL },
      api: "openai-completions",
      baseUrl: MODEL_PIN_URL,
    },
  ] as const)("merges cached and static rows below a $name", ({ modelRoute, api, baseUrl }) => {
    const registry = createSourceRegistry({ modelRoute, authStoreKey: "current-store-key" });

    expect(registry.getError()).toBeUndefined();
    expect.soft(registry.find(PROVIDER_ID, "known")).toMatchObject({
      id: "known",
      name: "Current known",
      api,
      baseUrl,
      maxTokensSource: "configured",
    });
    expect.soft(registry.find(PROVIDER_ID, "cached-only")).toMatchObject({
      baseUrl: ACCOUNT_URL,
      maxTokensSource: "discovered",
    });
    expect.soft(registry.getAll().filter((entry) => entry.id === "known")).toHaveLength(1);
    expect(
      registry
        .getAll()
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(["cached-only", "configured-only", "curated-only", "known"]);
  });

  it("keeps replace-mode declarations closed to cached and static inventory", () => {
    const registry = createSourceRegistry({ mode: "replace", authStoreKey: "current-store-key" });

    expect(registry.getError()).toBeUndefined();
    expect(
      registry
        .getAll()
        .map((entry) => entry.id)
        .toSorted(),
    ).toEqual(["configured-only", "known"]);
    expect(registry.find(PROVIDER_ID, "known")).toMatchObject({ baseUrl: NATIVE_URL });
  });

  it("does not treat a generated shard as credential authority without current config", async () => {
    const root = tempDirs.make("openclaw-registry-cache-auth-");
    const registry = ModelRegistry.create(AuthStorage.inMemory(), path.join(root, "models.json"), {
      modelsJsonContents: null,
      pluginMetadataSnapshot: metadataSnapshot,
      pluginCatalogs: [
        {
          pluginId: PLUGIN_ID,
          contents: JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              [PROVIDER_ID]: {
                api: "openai-responses",
                baseUrl: ACCOUNT_URL,
                apiKey: "retired-cache-key-not-real",
                authHeader: true,
                headers: { Authorization: "Bearer retired-provider-header-not-real" },
                models: [
                  Object.assign(model("cached-only"), {
                    headers: { Authorization: "Bearer retired-model-header-not-real" },
                  }),
                ],
              },
            },
          }),
        },
      ],
    });
    const selected = registry.find(PROVIDER_ID, "cached-only");

    expect(registry.getError()).toBeUndefined();
    expect(selected).toBeDefined();
    expect(registry.getProviderAuthStatus(PROVIDER_ID).configured).toBe(false);
    await expect(registry.getApiKeyAndHeaders(selected!)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
  });

  it.each([
    { name: "current auth store", authStoreKey: "current-store-key", sourceKey: undefined },
    { name: "current source key", authStoreKey: undefined, sourceKey: "current-source-key" },
    {
      name: "both current sources",
      authStoreKey: "current-store-key",
      sourceKey: "current-source-key",
    },
    { name: "no current credential", authStoreKey: undefined, sourceKey: undefined },
  ])("does not borrow cached credentials with $name", async ({ authStoreKey, sourceKey }) => {
    const registry = createSourceRegistry({ authStoreKey, sourceKey });
    expect(registry.getError()).toBeUndefined();
    for (const id of ["known", "cached-only"]) {
      const selected = registry.find(PROVIDER_ID, id);
      expect(selected).toBeDefined();
      await expect.soft(registry.getApiKeyAndHeaders(selected!)).resolves.toEqual({
        ok: true,
        apiKey: authStoreKey ?? sourceKey,
        headers:
          id === "known"
            ? { ...CURRENT_PROVIDER_HEADERS, ...CURRENT_MODEL_HEADERS }
            : CURRENT_PROVIDER_HEADERS,
      });
    }
    expect(registry.getProviderAuthStatus(PROVIDER_ID).configured).toBe(
      Boolean(authStoreKey ?? sourceKey),
    );
  });

  it.each(["openai-completions", "operator-custom-api"])(
    "preserves raw SDK file routing and inline auth for %s without a current config snapshot",
    async (api) => {
      const root = tempDirs.make("openclaw-registry-sdk-contract-");
      const modelsPath = path.join(root, "models.json");
      fs.writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            [PROVIDER_ID]: {
              api,
              baseUrl: MODEL_PIN_URL,
              apiKey: "sdk-source-key",
              authHeader: true,
              headers: { "X-SDK-Provider": "provider" },
              models: [{ id: "sdk-model", headers: { "X-SDK-Model": "model" } }],
            },
          },
        }),
      );
      const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
        includePluginCatalogs: false,
        pluginMetadataSnapshot: metadataSnapshot,
      });
      const selected = registry.find(PROVIDER_ID, "sdk-model");

      expect(registry.getError()).toBeUndefined();
      expect(selected).toMatchObject({ api, baseUrl: MODEL_PIN_URL });
      await expect(registry.getApiKeyAndHeaders(selected!)).resolves.toEqual({
        ok: true,
        apiKey: "sdk-source-key",
        headers: {
          "X-SDK-Provider": "provider",
          "X-SDK-Model": "model",
          Authorization: "Bearer sdk-source-key",
        },
      });
    },
  );
});
