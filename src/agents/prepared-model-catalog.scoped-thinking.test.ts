import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import { setPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const publishedSnapshotMock =
  vi.fn<(input: PreparedModelRuntimeInput) => PreparedModelRuntimeSnapshot | undefined>();
const preparedSnapshotMock =
  vi.fn<(input: PreparedModelRuntimeInput) => Promise<PreparedModelRuntimeSnapshot>>();

vi.mock("./prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prepared-model-runtime.js")>();
  return {
    ...actual,
    getPreparedModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) =>
      publishedSnapshotMock(input),
    prepareModelRuntimeSnapshot: (input: PreparedModelRuntimeInput) => preparedSnapshotMock(input),
  };
});

const ownerScope = { agentId: "main", agentDir: "/tmp/prepared-thinking-main" };
const runtimeEntry: ModelCatalogEntry = {
  provider: "ollama",
  id: "runtime-model",
  name: "Runtime model",
  reasoning: true,
};

function createPublishedSnapshot(
  config: OpenClawConfig,
  modelCatalog: ModelCatalogSnapshot,
): PreparedModelRuntimeSnapshot {
  return {
    ...ownerScope,
    catalogOwner: undefined,
    activeProjectKeys: [],
    config,
    providerAuth: {},
    oauthRefreshProviderIds: [],
    metadataSnapshot: createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    }),
    allowGatewaySubagentBinding: false,
    modelCatalog,
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("Capability reads must not create runtime stores");
    },
  };
}

describe("loadProviderScopedThinkingCatalog", () => {
  beforeEach(() => {
    publishedSnapshotMock.mockReset();
    preparedSnapshotMock.mockReset();
    preparedSnapshotMock.mockImplementation(async (input) => {
      const snapshot = publishedSnapshotMock(input);
      if (!snapshot) {
        throw new PreparedModelRuntimeOwnerNotPublishedError("No published test owner");
      }
      return snapshot;
    });
  });

  it("uses reasoning capabilities from the published generation", async () => {
    const config = {};
    const entry: ModelCatalogEntry = {
      provider: "acme",
      id: "reasoner",
      name: "Reasoner",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "high", "ultra"] },
    };
    publishedSnapshotMock.mockReturnValue(
      createPublishedSnapshot(config, { entries: [entry], routeVariants: [] }),
    );
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    const catalog = await loadProviderScopedThinkingCatalog({
      ...ownerScope,
      config,
      provider: entry.provider,
      model: entry.id,
    });

    expect(catalog).toEqual([entry]);
  });

  it("uses completed worker capabilities instead of the startup subset without discovery", async () => {
    const config = {};
    const completed: ModelCatalogSnapshot = {
      entries: [{ ...runtimeEntry, input: ["text", "image"] }],
      routeVariants: [],
    };
    setPreparedModelFullCatalogAuth(completed, {
      authStore: { version: 1, profiles: {} },
      providerAuth: {},
    });
    const discover = vi.fn(async () => completed);
    publishedSnapshotMock.mockReturnValue({
      ...createPublishedSnapshot(config, { entries: [], routeVariants: [] }),
      readFullModelCatalog: () => completed,
      loadFullModelCatalog: discover,
    });
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    const catalog = await loadProviderScopedThinkingCatalog({
      ...ownerScope,
      config,
      provider: runtimeEntry.provider,
      model: runtimeEntry.id,
    });

    expect(catalog).toEqual(completed.entries);
    expect(discover).not.toHaveBeenCalled();
  });

  it.each(["thinking", "input"] as const)(
    "preserves runtime-only published %s capabilities",
    async (capability) => {
      const config = {};
      const entry: ModelCatalogEntry = {
        ...runtimeEntry,
        api: "ollama",
        baseUrl: "https://ollama.invalid",
        input: ["text", "image"],
      };
      publishedSnapshotMock.mockReturnValue(
        createPublishedSnapshot(config, { entries: [entry], routeVariants: [entry] }),
      );
      const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

      const catalog = await loadProviderScopedThinkingCatalog({
        ...ownerScope,
        config,
        provider: entry.provider,
        model: entry.id,
        ...(capability === "input"
          ? { requiredInputRoute: { api: entry.api, baseUrl: entry.baseUrl } }
          : {}),
      });

      expect(catalog).toEqual([entry]);
    },
  );

  it("leaves an unknown model unresolved instead of constructing another catalog", async () => {
    const config = {};
    publishedSnapshotMock.mockReturnValue(
      createPublishedSnapshot(config, { entries: [runtimeEntry], routeVariants: [] }),
    );
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    const catalog = await loadProviderScopedThinkingCatalog({
      ...ownerScope,
      config,
      provider: runtimeEntry.provider,
      model: "unpublished-model",
    });

    expect(catalog).toEqual([runtimeEntry]);
    await expect(
      loadProviderScopedThinkingCatalog({
        ...ownerScope,
        config,
        provider: runtimeEntry.provider,
        model: "unpublished-model",
        requiredInputRoute: { api: "ollama", baseUrl: "https://ollama.invalid" },
      }),
    ).resolves.toEqual([]);
  });

  it("rejects a replaced config instead of rebuilding scoped model facts", async () => {
    const previousConfig = { skills: { entries: { marker: { enabled: false } } } };
    publishedSnapshotMock.mockReturnValue(
      createPublishedSnapshot(previousConfig, { entries: [runtimeEntry], routeVariants: [] }),
    );
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    await expect(
      loadProviderScopedThinkingCatalog({
        ...ownerScope,
        config: { skills: { entries: { marker: { enabled: true } } } },
        provider: runtimeEntry.provider,
        model: runtimeEntry.id,
      }),
    ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
  });

  const inputCases: Array<{
    name: string;
    input?: ModelCatalogEntry["input"];
    expected?: ModelCatalogEntry["input"];
    requiredApi?: ModelCatalogEntry["api"];
    customRoute?: boolean;
  }> = [
    { name: "vision", input: ["text", "image"], expected: ["text", "image"] },
    { name: "text-only", input: ["text"], expected: ["text"] },
    { name: "reasoning without input metadata" },
    { name: "different endpoint", input: ["text", "image"], customRoute: true },
    { name: "different API", input: ["text", "image"], requiredApi: "openai-completions" },
  ];

  it.each(inputCases)("resolves input from the published route: $name", async (testCase) => {
    const config = {};
    const entry: ModelCatalogEntry = {
      provider: "acme",
      id: "selected",
      name: "Selected",
      reasoning: true,
      api: "openai-responses",
      baseUrl: "https://provider.invalid/v1",
      input: testCase.input,
    };
    publishedSnapshotMock.mockReturnValue(
      createPublishedSnapshot(config, { entries: [entry], routeVariants: [] }),
    );
    const { loadProviderScopedThinkingCatalog } = await import("./prepared-model-catalog.js");

    const catalog = await loadProviderScopedThinkingCatalog({
      ...ownerScope,
      config,
      provider: entry.provider,
      model: entry.id,
      requiredInputRoute: {
        api: testCase.requiredApi ?? entry.api,
        baseUrl: testCase.customRoute ? "https://custom.invalid/v1" : entry.baseUrl,
      },
    });

    expect(catalog).toEqual(
      testCase.expected
        ? [expect.objectContaining({ id: entry.id, input: testCase.expected })]
        : [],
    );
  });
});
