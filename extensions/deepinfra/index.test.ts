// Deepinfra tests cover index plugin behavior.
import {
  createCapturedPluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import deepinfraPlugin from "./index.js";
import { DEEPINFRA_MODEL_CATALOG } from "./provider-models.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";

function buildDeepInfraCatalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    agentDir: "/tmp/openclaw-agent",
    resolveProviderApiKey: () => ({ apiKey: "profile-key" }),
    resolveProviderAuth: () => ({
      apiKey: "profile-key",
      mode: "api_key",
      source: "profile",
    }),
  };
}

function makeAgentModelEntry(id = "profile/live-model") {
  return {
    id,
    object: "model",
    owned_by: "deepinfra",
    metadata: {
      description: id,
      context_length: 32768,
      max_tokens: 4096,
      pricing: { input_tokens: 1, output_tokens: 2 },
      tags: ["chat"],
    },
  };
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function mockDiscoveryFetch(id = "profile/live-model") {
  return vi.fn(async (url: string) => {
    if (url === DEEPINFRA_MODELS_URL) {
      return jsonResponse({ data: [makeAgentModelEntry(id)] });
    }
    expect(url).toBe("https://api.deepinfra.com/models/list");
    return jsonResponse([
      {
        model_name: id,
        pricing: {
          type: "tokens",
          cents_per_input_token: 0.0004,
          cents_per_output_token: 0.0008,
        },
      },
    ]);
  });
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
});

async function withLiveDiscoveryTestEnv(
  mockFetch: ReturnType<typeof vi.fn>,
  runAssertions: () => Promise<void>,
) {
  vi.stubGlobal("fetch", mockFetch);

  try {
    await runAssertions();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("deepinfra catalog ownership", () => {
  it("keeps static inventory separate from missing-credential discovery", async () => {
    const fetchMock = vi.fn();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    await withLiveDiscoveryTestEnv(fetchMock, async () => {
      const context = buildDeepInfraCatalogContext();
      const result = await provider.staticCatalog?.run(context);
      expect(
        result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
      ).toEqual(DEEPINFRA_MODEL_CATALOG.map((model) => model.id));
      await expect(
        provider.catalog?.run({
          ...context,
          resolveProviderApiKey: () => ({ apiKey: undefined }),
        }),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("deepinfra capability registration", () => {
  it("registers all DeepInfra-backed OpenClaw provider surfaces", () => {
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);

    expect(captured.providers.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.imageGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.mediaUnderstandingProviders.map((provider) => provider.id)).toEqual([
      "deepinfra",
    ]);
    expect(captured.embeddingProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.speechProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["deepinfra"]);
  });

  it("uses profile-resolved API keys for live text catalog discovery", async () => {
    clearLiveCatalogCacheForTests();
    const mockFetch = mockDiscoveryFetch();
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);
    const provider = captured.providers[0];
    if (!provider?.catalog) {
      throw new Error("expected DeepInfra provider registration");
    }
    const catalog = provider.catalog;

    await withLiveDiscoveryTestEnv(mockFetch, async () => {
      const result = await catalog.run(buildDeepInfraCatalogContext());
      if (!result || !("provider" in result)) {
        throw new Error("expected single-provider DeepInfra catalog result");
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(
        expect.arrayContaining([DEEPINFRA_MODELS_URL, "https://api.deepinfra.com/models/list"]),
      );
      expect(result.provider.models[0]?.cost).toEqual({
        input: 4,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
      });
      expect(result?.provider.apiKey).toBe("profile-key");
      expect(result.provider.models.map((model) => model.id)).toEqual([
        "profile/live-model",
        ...DEEPINFRA_MODEL_CATALOG.map((model) => model.id),
      ]);
      expect(result.outcomes).toEqual([{ provider: "deepinfra", status: "ready" }]);
      await provider.augmentModelCatalog?.({ entries: [] } as never);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("deepinfra isCacheTtlEligible", () => {
  it("returns true for anthropic/* proxied models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "anthropic/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  // Locked to case-insensitive to stay consistent with the shared proxy cache
  // wrapper, which lowercases the modelId before the "anthropic/" prefix check.
  it("returns true regardless of modelId case", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "Anthropic/Claude-4-Sonnet",
      }),
    ).toBe(true);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "ANTHROPIC/claude-4-sonnet",
      }),
    ).toBe(true);
  });

  it("returns false for non-anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
      }),
    ).toBe(false);
    expect(
      provider.isCacheTtlEligible?.({
        provider: "deepinfra",
        modelId: "zai-org/GLM-5.1",
      }),
    ).toBe(false);
  });
});
