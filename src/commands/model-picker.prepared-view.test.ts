import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { promptDefaultModel } from "./model-picker.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const mocks = vi.hoisted(() => ({
  loadPreparedModelCatalogView: vi.fn(),
  loadPreparedModelCatalogSnapshot: vi.fn(),
}));

vi.mock("../agents/model-catalog-view.js", () => ({
  loadPreparedModelCatalogView: mocks.loadPreparedModelCatalogView,
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: mocks.loadPreparedModelCatalogSnapshot,
}));

vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    resolvePluginProviders: () => [],
    runProviderModelSelectedHook: vi.fn(),
  },
}));

describe("prepared model picker ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPreparedModelCatalogSnapshot.mockResolvedValue({ entries: [], routeVariants: [] });
  });

  it("keeps canonical provider rows when the requested provider is a declared alias", async () => {
    const { prepareModelCatalogView } = await vi.importActual<
      typeof import("../agents/model-catalog-view.js")
    >("../agents/model-catalog-view.js");
    const entry = { provider: "custom", id: "model", name: "Model" };
    const view = await prepareModelCatalogView({
      cfg: {},
      agentId: "main",
      workspaceDir: "/tmp/picker-provider-alias",
      snapshot: { entries: [entry], routeVariants: [entry] },
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom",
            providers: ["custom"],
            providerAuthAliases: { "custom-alias": "custom" },
          },
        ],
      }),
      auth: {
        authStore: {
          version: 1,
          profiles: {
            "custom:primary": { provider: "custom", type: "api_key", key: "fixture-key" },
          },
        },
        providerAuth: {},
      },
      env: {},
      view: "all",
    });
    mocks.loadPreparedModelCatalogView.mockResolvedValue(view);
    const select = vi.fn().mockResolvedValue("custom/model");
    await expect(
      promptDefaultModel({
        config: {},
        prompter: makePrompter({ select }),
        preferredProvider: "custom-alias",
        allowKeep: false,
        includeManual: false,
      }),
    ).resolves.toEqual({ model: "custom/model" });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [expect.objectContaining({ value: "custom/model" })],
      }),
    );
  });

  it("offers the selected agent's prepared model without rediscovering catalog or auth", async () => {
    const entry: ModelCatalogEntry = {
      provider: "fixture",
      id: "native-model",
      name: "Native model",
      nativeRuntime: "fixture-runtime",
    };
    mocks.loadPreparedModelCatalogView.mockResolvedValue({
      entries: [entry],
      catalog: [entry],
      defaultModel: "fixture/native-model",
      resolvedDefault: { provider: "fixture", model: "native-model" },
      configuredEntries: { entries: [], byKey: new Map() },
      evaluate: () => ({ availability: true, routeResolution: null }),
      runtime: () => ({ id: "fixture-runtime", source: "auth" }),
    });
    const select = vi.fn().mockResolvedValue("fixture/native-model");
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: { model: "other/global-model" },
        entries: { research: { model: "fixture/native-model" } },
      },
    };

    await expect(
      promptDefaultModel({
        config,
        agentId: "research",
        prompter,
        allowKeep: false,
        includeManual: false,
      }),
    ).resolves.toEqual({ model: "fixture/native-model" });
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          expect.objectContaining({
            value: "fixture/native-model",
            hint: expect.stringContaining("fixture-runtime"),
          }),
        ],
      }),
    );
    expect(mocks.loadPreparedModelCatalogView).toHaveBeenCalledWith(
      expect.objectContaining({ config, agentId: "research" }),
    );
    expect(mocks.loadPreparedModelCatalogSnapshot).not.toHaveBeenCalled();
  });
});
