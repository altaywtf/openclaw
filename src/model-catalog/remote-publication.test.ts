// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveModelPricing, resolveModelPricingContext } from "./pricing.js";
import { checkRemoteModelCatalogUpdate } from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";
import { refreshRemoteModelCatalog } from "./remote-refresh.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "remote-publication" });
  resetPreparedModelRuntimeHarness(state);
  mocks.configuredAgentIds = ["default"];
  setRemoteModelCatalogOverlaySourcesForTest({ bundledGeneratedAt: () => 100 });
});

afterEach(async (context) => {
  setRemoteModelCatalogOverlaySourcesForTest();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await cleanupPreparedModelRuntimeHarness(state, context.task.result?.state === "fail");
});

it("keeps downloaded rows and prices inactive until restart, including across config publication", async () => {
  vi.doUnmock("../plugins/plugin-metadata-snapshot.js");
  const { createPluginMetadataSnapshotFixture } =
    await import("../plugins/plugin-metadata.test-support.js");
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "custom",
        providers: ["custom"],
        modelCatalog: {
          providers: {
            custom: { api: "openai-completions", models: [{ id: "bundled", name: "Bundled" }] },
          },
          discovery: { custom: "static" },
        },
      },
    ],
  });
  vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshot").mockReturnValue(metadataSnapshot);
  const catalog = await vi.importActual<typeof import("../agents/model-catalog.js")>(
    "../agents/model-catalog.js",
  );
  vi.doMock("../agents/model-catalog.js", () => catalog);

  let bundle = {
    schemaVersion: 1,
    sourceCommit: "test-catalog",
    generatedAt: 200,
    providers: { custom: { models: [{ id: "baseline", name: "Baseline" }] } },
    pricing: { "custom/usage-model": { input: 1, output: 2 } },
  };
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(bundle));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback catalog server did not bind a port");
  }
  const sourceUrl = `http://127.0.0.1:${address.port}/catalog.json`;
  const config = { models: { catalogRefresh: { url: sourceUrl } } };
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => ({
    entries: catalog.loadManifestModelCatalog({ config, metadataSnapshot }),
    routeVariants: [],
  }));
  const phases: string[] = [];
  const unregister = registerPreparedModelRuntimePublicationListener(({ phase }) => {
    if (phase !== "catalog-published") {
      phases.push(phase);
    }
  });
  try {
    await expect(
      refreshRemoteModelCatalog({ config, bundledGeneratedAt: () => 100 }),
    ).resolves.toMatchObject({ status: "updated" });
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      pluginMetadataSnapshot: metadataSnapshot,
    });
    expect(mocks.warn.mock.calls).toEqual([]);
    const input = { agentId: "default", agentDir: state.agentDir("default"), config };
    const initial = await prepareModelRuntimeSnapshot(input);
    expect((await initial.loadFullModelCatalog!()).entries).toContainEqual(
      expect.objectContaining({ id: "baseline" }),
    );
    expect(resolveModelPricing(resolveModelPricingContext(config), "custom/usage-model")).toEqual({
      input: 1,
      output: 2,
    });
    mocks.runPreparedModelCatalogWorker.mockClear();
    expect(checkRemoteModelCatalogUpdate(config, { sourceUrl, generatedAt: 200 })).toBe(
      "unchanged",
    );
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();

    bundle = {
      ...bundle,
      generatedAt: 300,
      providers: {
        custom: {
          models: [...bundle.providers.custom.models, { id: "downloaded", name: "Downloaded" }],
        },
      },
      pricing: { "custom/usage-model": { input: 3, output: 6 } },
    };
    await expect(
      refreshRemoteModelCatalog({ config, force: true, bundledGeneratedAt: () => 100 }),
    ).resolves.toMatchObject({ status: "updated" });
    await expect(refreshRemoteModelCatalog({ config })).resolves.toMatchObject({
      status: "fresh",
      generatedAt: 300,
    });
    expect(requests).toBe(2);
    phases.length = 0;
    const publication = checkRemoteModelCatalogUpdate(config, {
      sourceUrl,
      generatedAt: 300,
    });
    const snapshot = await prepareModelRuntimeSnapshot(input);
    expect({
      rows: (await snapshot.loadFullModelCatalog!()).entries.map(({ id }) => id),
      pricing: resolveModelPricing(resolveModelPricingContext(config), "custom/usage-model"),
    }).toEqual({
      rows: ["baseline", "bundled"],
      pricing: { input: 1, output: 2 },
    });
    expect(publication).toBe("restart-required");
    expect(snapshot).toBe(initial);
    expect(phases).toEqual([]);
    expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();

    const nextConfig = { ...config, plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      pluginMetadataSnapshot: metadataSnapshot,
    });
    expect(catalog.loadManifestModelCatalog({ config: nextConfig, metadataSnapshot })).toEqual(
      catalog.loadManifestModelCatalog({ config, metadataSnapshot }),
    );
    expect(
      resolveModelPricing(resolveModelPricingContext(nextConfig), "custom/usage-model"),
    ).toEqual({
      input: 1,
      output: 2,
    });
    bundle = {
      ...bundle,
      generatedAt: 400,
      pricing: { "custom/usage-model": { input: 5, output: 10 } },
    };
    await expect(
      refreshRemoteModelCatalog({ config, force: true, bundledGeneratedAt: () => 100 }),
    ).resolves.toMatchObject({ status: "updated" });
    const configReady = createDeferred<typeof nextConfig>();
    const failure = new Error("config publication failed");
    mocks.discoverAuthStorage.mockImplementationOnce(() => {
      throw failure;
    });
    const configPublication = refreshPreparedModelRuntimeSnapshots(() => configReady.promise);
    const failedPublication = expect(configPublication).rejects.toBe(failure);
    try {
      expect(checkRemoteModelCatalogUpdate(nextConfig, { sourceUrl, generatedAt: 400 })).toBe(
        "restart-required",
      );
      expect(resolveModelPricing(resolveModelPricingContext(config), "custom/usage-model")).toEqual(
        {
          input: 1,
          output: 2,
        },
      );
    } finally {
      configReady.resolve(structuredClone(nextConfig));
      await failedPublication;
    }
    expect(
      catalog
        .loadManifestModelCatalog({ config: { ...config }, metadataSnapshot })
        .map(({ id }) => id),
    ).toEqual(["baseline", "bundled"]);
    expect(
      resolveModelPricing(resolveModelPricingContext({ ...config }), "custom/usage-model"),
    ).toEqual({
      input: 1,
      output: 2,
    });

    setRemoteModelCatalogOverlaySourcesForTest({ bundledGeneratedAt: () => 100 });
    const restartedConfig = structuredClone(nextConfig);
    await refreshPreparedModelRuntimeSnapshots(restartedConfig, {
      pluginMetadataSnapshot: metadataSnapshot,
    });
    expect(
      catalog.loadManifestModelCatalog({ config: restartedConfig, metadataSnapshot }),
    ).toContainEqual(expect.objectContaining({ id: "downloaded" }));
    expect(
      resolveModelPricing(resolveModelPricingContext(restartedConfig), "custom/usage-model"),
    ).toEqual({
      input: 5,
      output: 10,
    });
    expect(checkRemoteModelCatalogUpdate(restartedConfig, { sourceUrl, generatedAt: 400 })).toBe(
      "unchanged",
    );
  } finally {
    unregister();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
