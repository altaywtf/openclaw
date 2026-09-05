import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  findModelCatalogEntry,
  findModelInCatalog,
  prepareModelRunCapabilities,
} from "./model-catalog-lookup.js";
import { assignProviderModelOrder } from "./model-catalog-order.js";
import { resolveConfiguredModelCatalogOverrides } from "./model-catalog-route.js";
import { prepareModelCatalogView } from "./model-catalog-view.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";

const modelDefaults = {
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 4096,
};
const baseUrl = "https://sample.example/v1";

describe("case-sensitive model catalog identity", () => {
  it("retains both configured IDs with their distinct names and context limits", async () => {
    const models: ModelDefinitionConfig[] = [
      { ...modelDefaults, id: "Model-A", name: "Uppercase model", contextWindow: 32_000 },
      { ...modelDefaults, id: "model-a", name: "Lowercase model", contextWindow: 64_000 },
    ];
    const entries: ModelCatalogEntry[] = models.map((model) => ({
      ...model,
      provider: "sample",
      api: "openai-completions",
      baseUrl,
    }));
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "sample/Model-A",
          models: { "sample/Model-A": {}, "sample/model-a": {} },
        },
      },
      models: { providers: { sample: { api: "openai-completions", baseUrl, models } } },
    };

    const view = await prepareModelCatalogView({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/model-catalog-identity",
      snapshot: { entries, routeVariants: entries },
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      auth: {
        authStore: {
          version: 1,
          profiles: {
            "sample:fixture": { type: "api_key", provider: "sample", key: "synthetic-sample-key" },
          },
        },
        providerAuth: {},
      },
      env: {},
      view: "configured",
    });

    expect(view.entries).toHaveLength(2);
    expect(view.entries.map((entry) => view.evaluate(entry).routeResolution)).toEqual([null, null]);
    expect(view.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Model-A", name: "Uppercase model", contextWindow: 32_000 }),
        expect.objectContaining({ id: "model-a", name: "Lowercase model", contextWindow: 64_000 }),
      ]),
    );
  });

  it("applies runtime capabilities only to the matching case", () => {
    const entries: ModelCatalogEntry[] = [
      { provider: "sample", id: "Model-A", name: "Uppercase model", reasoning: false },
      { provider: "sample", id: "model-a", name: "Lowercase model", reasoning: false },
    ];

    const catalog = materializePreparedModelCatalog({ entries, routeVariants: entries }, [
      {
        provider: "sample",
        modelId: "model-a",
        model: {
          ...modelDefaults,
          provider: "sample",
          id: "model-a",
          name: "Runtime model",
          api: "openai-completions",
          baseUrl,
          contextWindow: 128_000,
          reasoning: true,
          compat: { supportsTools: true },
        },
      },
    ]);

    expect(catalog.entries).toEqual([
      { provider: "sample", id: "Model-A", name: "Uppercase model", reasoning: false },
      expect.objectContaining({
        id: "model-a",
        name: "Lowercase model",
        reasoning: true,
        compat: { supportsTools: true },
      }),
    ]);
  });

  it("does not borrow configured metadata or limits from a differently cased ID", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          sample: {
            baseUrl,
            models: [
              {
                ...modelDefaults,
                id: "Model-A",
                name: "Configured uppercase",
                contextWindow: 32_000,
                contextTokens: 16_000,
              },
              {
                ...modelDefaults,
                id: "model-a",
                name: "Configured lowercase",
                contextWindow: 128_000,
                contextTokens: 64_000,
                reasoning: true,
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    };

    expect(
      resolveConfiguredModelCatalogOverrides({ cfg, entry: { provider: "sample", id: "Model-A" } }),
    ).toEqual({
      name: "Configured uppercase",
      contextWindow: 32_000,
      contextTokens: 16_000,
      reasoning: false,
      configuredReasoning: false,
      input: ["text"],
    });
    expect(
      resolveConfiguredModelCatalogOverrides({ cfg, entry: { provider: "sample", id: "model-a" } }),
    ).toEqual({
      name: "Configured lowercase",
      contextWindow: 128_000,
      contextTokens: 64_000,
      reasoning: true,
      configuredReasoning: true,
      input: ["text", "image"],
    });
  });

  it("retains independent provider order for case-distinct IDs", () => {
    const upper = { provider: "sample", id: "Model-A", name: "Uppercase model" };
    const lower = { provider: "sample", id: "model-a", name: "Lowercase model" };

    const ordered = assignProviderModelOrder(
      [upper, lower],
      [
        { ...upper, providerOrder: 5 },
        { ...lower, providerOrder: 2 },
      ],
    );

    expect(ordered.map(({ id, providerOrder }) => ({ id, providerOrder }))).toEqual([
      { id: "Model-A", providerOrder: 5 },
      { id: "model-a", providerOrder: 2 },
    ]);
  });

  describe("catalog lookup", () => {
    const upper: ModelCatalogEntry = {
      provider: "sample",
      id: "Model-A",
      name: "Uppercase model",
      input: ["text", "image"],
    };
    const lower: ModelCatalogEntry = {
      provider: "sample",
      id: "model-a",
      name: "Lowercase model",
      input: ["text"],
    };

    it.each([
      {
        name: "prefers the exact lowercase identity",
        catalog: [upper, lower],
        modelId: "model-a",
        expectedId: "model-a",
        vision: false,
      },
      {
        name: "rejects ambiguous case-insensitive matches",
        catalog: [upper, lower],
        modelId: "MODEL-A",
        expectedId: undefined,
        vision: false,
      },
      {
        name: "retains a unique legacy case-insensitive match",
        catalog: [upper],
        modelId: "MODEL-A",
        expectedId: "Model-A",
        vision: true,
      },
    ])("$name", ({ catalog, modelId, expectedId, vision }) => {
      expect(findModelInCatalog(catalog, "sample", modelId)?.id).toBe(expectedId);
      expect(
        prepareModelRunCapabilities([catalog, []], ["sample", modelId, "openclaw"]).modelHasVision,
      ).toBe(vision);
    });

    it("prefers the exact case when the provider is omitted", () => {
      expect(findModelCatalogEntry([upper, lower], { modelId: "model-a" })).toMatchObject({
        id: "model-a",
        input: ["text"],
      });
    });
  });
});
