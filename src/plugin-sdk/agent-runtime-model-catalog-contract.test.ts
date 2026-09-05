import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  loadCatalog: vi.fn(),
  discoverCatalog: vi.fn(),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  getPreparedModelCatalogSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
  loadPreparedModelCatalog: (...args: unknown[]) => mocks.loadCatalog(...args),
  discoverProviderModelCatalog: (...args: unknown[]) => mocks.discoverCatalog(...args),
}));

import {
  loadModelCatalog,
  loadPreparedModelCatalog,
  resolveThinkingDefaultWithRuntimeCatalog,
} from "openclaw/plugin-sdk/agent-runtime";

describe("agent-runtime model catalog compatibility", () => {
  beforeEach(() => {
    mocks.getSnapshot.mockReset();
    mocks.loadCatalog.mockReset();
    mocks.discoverCatalog.mockReset();
  });

  describe.each([
    { name: "loadPreparedModelCatalog", load: loadPreparedModelCatalog },
    { name: "loadModelCatalog", load: loadModelCatalog },
  ])("$name", ({ load }) => {
    it.each([
      { name: "omitted", params: {}, readOnly: false },
      { name: "read-only", params: { readOnly: true }, readOnly: true },
      { name: "writable", params: { readOnly: false }, readOnly: false },
    ])("preserves the shipped $name read mode", async ({ params, readOnly }) => {
      const entries = [{ provider: "test", id: "prepared", name: "Prepared" }];
      mocks.loadCatalog.mockResolvedValue(entries);

      await expect(load(params)).resolves.toBe(entries);
      expect(mocks.loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly });
      expect(mocks.discoverCatalog).not.toHaveBeenCalled();
    });
  });

  it("confines the shipped explicit discovery option to the SDK boundary", async () => {
    const entries = [{ provider: "test", id: "discovered", name: "Discovered" }];
    mocks.discoverCatalog.mockResolvedValue(entries);
    await expect(
      loadPreparedModelCatalog({
        agentId: "main",
        readOnly: true,
        providerDiscoveryProviderIds: ["test"],
        scopedLiveProviderDiscovery: true,
      }),
    ).resolves.toBe(entries);
    expect(mocks.discoverCatalog).toHaveBeenCalledWith({
      agentId: "main",
      readOnly: true,
      providerIds: ["test"],
    });
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
  });

  it("uses the shipped thinking catalog callback", async () => {
    const readCatalog = vi.fn(async () => []);

    await expect(
      resolveThinkingDefaultWithRuntimeCatalog({
        cfg: { agents: { defaults: { thinkingDefault: "low" } } },
        provider: "example",
        model: "example-model",
        loadModelCatalog: readCatalog,
      }),
    ).resolves.toBe("low");
    expect(readCatalog).toHaveBeenCalledOnce();
  });

  it("propagates failures from the shipped thinking catalog callback", async () => {
    const failure = new Error("catalog unavailable");

    await expect(
      resolveThinkingDefaultWithRuntimeCatalog({
        cfg: {},
        provider: "example",
        model: "example-model",
        loadModelCatalog: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it("keeps legacy cache-only reads nonblocking", async () => {
    mocks.getSnapshot.mockReturnValue({
      entries: [{ provider: "test", id: "cached", name: "Cached" }],
      routeVariants: [],
    });

    await expect(loadModelCatalog({ cacheOnly: true, useCache: true })).resolves.toEqual([
      { provider: "test", id: "cached", name: "Cached" },
    ]);
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
  });

  it("accepts legacy options without overriding lifecycle metadata", async () => {
    type LegacyMetadataSnapshot = Omit<PluginMetadataSnapshot, "owners"> & {
      owners: Omit<PluginMetadataSnapshot["owners"], "modelIdNormalizationPolicies">;
    };
    type AcceptedMetadataSnapshot = NonNullable<
      NonNullable<Parameters<typeof loadModelCatalog>[0]>["metadataSnapshot"]
    >;
    expectTypeOf<LegacyMetadataSnapshot>().toMatchTypeOf<AcceptedMetadataSnapshot>();
    expectTypeOf<PluginMetadataSnapshot>().toMatchTypeOf<AcceptedMetadataSnapshot>();
    mocks.loadCatalog.mockResolvedValue([]);
    const config = {};
    const env = { OPENCLAW_STATE_DIR: "/tmp/plugin-state" };

    await loadModelCatalog({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      metadataSnapshot: {} as never,
      readOnly: true,
      useCache: false,
      workspaceDir: "/tmp/plugin-workspace",
    });

    expect(mocks.loadCatalog).toHaveBeenCalledWith({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      readOnly: true,
      workspaceDir: "/tmp/plugin-workspace",
    });
  });
});
