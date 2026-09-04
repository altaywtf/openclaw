import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  getRemoteModelCatalogPricing,
  getRemoteModelCatalogProviderOverlay,
  captureRemoteModelCatalogSnapshot,
  checkRemoteModelCatalogUpdate,
} from "./remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "./remote-overlay.test-support.js";

const mocks = {
  builtAt: vi.fn<() => number | undefined>(),
  read: vi.fn(),
};

const bundle = {
  schemaVersion: 1,
  generatedAt: 200,
  minVersion: "2026.7.0",
  sourceCommit: "abc",
  providers: { anthropic: { models: [{ id: "new" }] } },
  pricing: { "openai/gpt-external": { input: 2.5, output: 10 } },
};

beforeEach(() => {
  mocks.builtAt.mockReset().mockReturnValue(100);
  mocks.read.mockReset().mockReturnValue({
    bundle_json: JSON.stringify(bundle),
    source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
  });
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: mocks.builtAt,
    readStoredCatalog: mocks.read,
  });
});

afterEach(() => {
  setRemoteModelCatalogOverlaySourcesForTest();
});

describe("remote model catalog overlay", () => {
  it("reports downloaded updates without replacing the startup snapshot", () => {
    const config = {};
    const oldOverlay = getRemoteModelCatalogProviderOverlay(config, "anthropic");
    const updated = {
      ...bundle,
      generatedAt: 300,
      providers: { anthropic: { models: [{ id: "latest" }] } },
    };
    mocks.read.mockReturnValue({
      bundle_json: JSON.stringify(updated),
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
    });
    expect(getRemoteModelCatalogProviderOverlay(config, "anthropic")).toBe(oldOverlay);
    expect(
      checkRemoteModelCatalogUpdate(config, {
        sourceUrl: "https://catalog.openclaw.ai/models/v1/catalog.json",
        generatedAt: 300,
      }),
    ).toBe("restart-required");
    expect(getRemoteModelCatalogProviderOverlay(config, "anthropic")).toBe(oldOverlay);
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "source", "generation"])(
    "does not replace cached metadata for a changed %s",
    (change) => {
      const oldOverlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
      expect(
        checkRemoteModelCatalogUpdate(
          change === "disabled" ? { models: { catalogRefresh: { enabled: false } } } : {},
          {
            sourceUrl:
              change === "source"
                ? "https://mirror.example.test/catalog.json"
                : "https://catalog.openclaw.ai/models/v1/catalog.json",
            generatedAt: change === "generation" ? 300 : 200,
          },
        ),
      ).toBe("superseded");
      expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBe(oldOverlay);
    },
  );

  it("keeps its startup snapshot across plugin reloads and source changes", () => {
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    mocks.read.mockReturnValue({
      bundle_json: JSON.stringify({ ...bundle, generatedAt: 300 }),
      source_url: "https://mirror.example.test/catalog.json",
    });
    clearPluginMetadataLifecycleCaches();
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBe(overlay);
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("pins missing startup metadata before the first download or catalog read", () => {
    const stored = mocks.read();
    mocks.read.mockReturnValue(undefined);
    captureRemoteModelCatalogSnapshot();
    mocks.read.mockReturnValue(stored);
    expect(
      checkRemoteModelCatalogUpdate({}, { sourceUrl: stored.source_url, generatedAt: 200 }),
    ).toBe("restart-required");
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    expect(getRemoteModelCatalogPricing({})).toBeUndefined();
  });

  it("passes the startup rows and prices to a new worker after a download", async () => {
    const overlay = getRemoteModelCatalogProviderOverlay({}, "anthropic");
    const pricing = getRemoteModelCatalogPricing({});
    mocks.read.mockReturnValue({
      bundle_json: JSON.stringify({ ...bundle, generatedAt: 300 }),
      source_url: "https://catalog.openclaw.ai/models/v1/catalog.json",
    });
    const worker = new Worker(new URL("./remote-overlay.worker.test-support.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      workerData: { config: {}, provider: "anthropic" },
    });
    try {
      const [result] = await once(worker, "message");
      expect(result).toEqual({ overlay, pricing });
    } finally {
      await worker.terminate();
    }
  });

  it("loads a newer compatible bundle once", () => {
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(getRemoteModelCatalogPricing({})?.["openai/gpt-external"]).toEqual({
      input: 2.5,
      output: 10,
    });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("fails closed when disabled, stale, or missing a build stamp", () => {
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { enabled: false } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.builtAt.mockReturnValue(200);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
    setRemoteModelCatalogOverlaySourcesForTest({
      bundledGeneratedAt: mocks.builtAt,
      readStoredCatalog: mocks.read,
    });
    mocks.builtAt.mockReturnValue(undefined);
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toBeUndefined();
  });

  it("does not reuse a cached overlay after disablement or a URL change", () => {
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toHaveProperty("models");
    expect(
      getRemoteModelCatalogProviderOverlay(
        { models: { catalogRefresh: { enabled: false } } },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(
      getRemoteModelCatalogProviderOverlay(
        {
          models: { catalogRefresh: { url: "https://mirror.example.test/catalog.json" } },
        },
        "anthropic",
      ),
    ).toBeUndefined();
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
import { once } from "node:events";
import { Worker } from "node:worker_threads";
