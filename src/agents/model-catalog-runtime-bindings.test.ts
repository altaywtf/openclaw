import { beforeEach, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { prepareModelCatalogRuntimeBindings } from "./model-catalog-runtime-bindings.js";
import { createModelPickerVisibleProviderPredicate } from "./model-runtime-aliases.js";

const mocks = vi.hoisted(() => ({
  setupRegistry: vi.fn(() => ({ cliBackends: [] })),
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupCliBackend: vi.fn(() => null),
  resolvePluginSetupRegistry: mocks.setupRegistry,
}));

beforeEach(() => {
  mocks.setupRegistry.mockClear();
});

it("keeps canonical and standalone providers visible while hiding runtime aliases", () => {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "alpha", providers: ["alpha"], cliBackends: ["alpha", "alpha-cli"] },
      { id: "standalone", providers: ["standalone-cli"], cliBackends: ["standalone-cli"] },
    ],
  });
  const pluginRegistry = createTestRegistry();
  pluginRegistry.cliBackends = [
    {
      pluginId: "alpha",
      source: "test",
      backend: { id: "alpha", modelProvider: "alpha", config: { command: "alpha" } },
    },
    {
      pluginId: "alpha",
      source: "test",
      backend: { id: "alpha-cli", modelProvider: "alpha", config: { command: "alpha" } },
    },
    {
      pluginId: "standalone",
      source: "test",
      backend: { id: "standalone-cli", config: { command: "standalone" } },
    },
  ];
  const runtimeBindings = prepareModelCatalogRuntimeBindings({
    config: {},
    metadataSnapshot,
    pluginRegistry,
    env: {},
  });
  const visible = createModelPickerVisibleProviderPredicate({ runtimeBindings });

  expect(runtimeBindings).toEqual([
    { provider: "alpha", runtime: "alpha" },
    { provider: "alpha", runtime: "alpha-cli" },
  ]);
  expect(visible("alpha-cli")).toBe(false);
  expect(visible("alpha")).toBe(true);
  expect(visible("standalone-cli")).toBe(true);
  expect(mocks.setupRegistry).not.toHaveBeenCalled();
});

it("keeps an older generation's bindings unchanged when a new generation is prepared", () => {
  const capture = (runtime: string) => {
    const pluginRegistry = createTestRegistry();
    pluginRegistry.cliBackends = [
      {
        pluginId: "alpha",
        source: "test",
        backend: { id: runtime, modelProvider: "alpha", config: { command: "alpha" } },
      },
    ];
    return prepareModelCatalogRuntimeBindings({
      config: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [{ id: "alpha", providers: ["alpha"], cliBackends: [runtime] }],
      }),
      pluginRegistry,
      env: {},
    });
  };
  const first = capture("first-cli");
  const second = capture("second-cli");

  expect(first).toEqual([{ provider: "alpha", runtime: "first-cli" }]);
  expect(second).toEqual([{ provider: "alpha", runtime: "second-cli" }]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first[0])).toBe(true);
  expect(mocks.setupRegistry).not.toHaveBeenCalled();
});

it("does not infer bindings from provider and harness activation hints", () => {
  const runtimeBindings = prepareModelCatalogRuntimeBindings({
    config: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "activation-hints",
          providers: ["alpha"],
          activation: { onProviders: ["beta"], onAgentHarnesses: ["fixture-native"] },
        },
      ],
    }),
    env: {},
  });

  expect(runtimeBindings).toEqual([]);
  expect(mocks.setupRegistry).not.toHaveBeenCalled();
});
