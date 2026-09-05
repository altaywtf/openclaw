import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as runtime from "../../runtime.js";
import { registerModelCapabilityCommands } from "./model.js";

const mocks = vi.hoisted(() => ({
  loadCatalog: vi.fn(),
  loadView: vi.fn(),
  loadMetadata: vi.fn(),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: mocks.loadCatalog,
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

vi.mock("../../agents/model-catalog-view.js", () => ({
  loadPreparedModelCatalogView: mocks.loadView,
}));

vi.mock("../../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadMetadata,
}));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("lists only published inventory instead of merging a second manifest catalog", async () => {
  const published = [{ provider: "alpha", id: "published", name: "Published model" }];
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "beta",
        providers: ["beta"],
        modelCatalog: {
          providers: {
            beta: { models: [{ id: "not-published", name: "Unpublished manifest model" }] },
          },
          discovery: { beta: "static" },
        },
      },
    ],
  });
  setRuntimeConfigSnapshot({});
  mocks.loadCatalog.mockResolvedValue(published);
  mocks.loadView.mockResolvedValue({
    entries: published,
    catalog: published,
    runtimeCatalog: published,
    metadataSnapshot,
    resolvedDefault: { provider: "alpha", model: "published" },
  });
  mocks.loadMetadata.mockReturnValue(metadataSnapshot);
  const writeJson = vi.spyOn(runtime, "writeRuntimeJson").mockImplementation(() => {});
  const program = new Command();
  registerModelCapabilityCommands(program);

  await program.parseAsync(["model", "list", "--json"], { from: "user" });

  expect(writeJson).toHaveBeenCalledWith(runtime.defaultRuntime, published);
});
