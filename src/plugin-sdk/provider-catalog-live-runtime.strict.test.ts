import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePluginRegistration } from "../plugins/captured-registration.js";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  buildOpenAICompatibleProviderFamilyCatalog,
  clearLiveCatalogCacheForTests,
  LiveModelCatalogHttpError,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import type { ProviderCatalogContext } from "./provider-catalog-shared.js";
import { defineSingleProviderPluginEntry } from "./provider-entry.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";
import * as ssrfRuntime from "./ssrf-runtime.js";

const seedModel: ModelDefinitionConfig = {
  id: "account-model",
  name: "Account model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

const providerConfig: ModelProviderConfig = {
  api: "openai-completions",
  baseUrl: "https://provider.example.test/v1",
  models: [seedModel],
};

const strictBuilders = [
  {
    name: "model ID filtering",
    build: (fetchGuard: LiveModelCatalogFetchGuard) =>
      buildLiveModelProviderConfig({
        providerId: "provider",
        endpoint: `${providerConfig.baseUrl}/models`,
        providerConfig,
        models: [seedModel],
        fetchGuard,
        discoveryMode: "strict",
      }),
  },
  {
    name: "provider row projection",
    build: (fetchGuard: LiveModelCatalogFetchGuard) =>
      buildLiveModelProviderConfig({
        providerId: "provider",
        endpoint: `${providerConfig.baseUrl}/models`,
        providerConfig,
        models: [seedModel],
        fetchGuard,
        projectRows: (rows) => (rows.length > 0 ? [seedModel] : []),
        discoveryMode: "strict",
      }),
  },
  {
    name: "OpenAI-compatible discovery",
    build: (fetchGuard: LiveModelCatalogFetchGuard) =>
      buildOpenAICompatibleLiveModelProviderConfig({
        providerId: "provider",
        providerConfig,
        fetchGuard,
        discoveryMode: "strict",
      }),
  },
];

describe("strict live provider catalogs", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());
  afterEach(() => vi.restoreAllMocks());

  describe.each(strictBuilders)("$name", ({ build }) => {
    it.each([
      { name: "network failure", error: new Error("Catalog connection failed") },
      { name: "auth rejection", error: new LiveModelCatalogHttpError("provider", 401) },
    ])("propagates the original $name instead of returning seed rows", async ({ error }) => {
      const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async () => {
        throw error;
      });

      await expect(build(fetchGuard)).rejects.toBe(error);
      expect(fetchGuard).toHaveBeenCalledOnce();
    });

    it("preserves an authoritative empty account catalog without seed rows", async () => {
      const release = vi.fn(async () => undefined);
      const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async ({ url }) => ({
        response: Response.json({ data: [] }),
        finalUrl: url,
        release,
      }));

      await expect(build(fetchGuard)).resolves.toMatchObject({ models: [] });
      expect(fetchGuard).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    });
  });

  it("does not attribute public custom-builder discovery to its activation credential", async () => {
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async ({ init }) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      throw new LiveModelCatalogHttpError("provider", 503);
    });
    const entry = defineSingleProviderPluginEntry({
      id: "provider",
      name: "Provider",
      description: "Provider catalog",
      provider: {
        label: "Provider",
        catalog: {
          discoveryMode: "strict",
          buildProvider: () =>
            buildOpenAICompatibleLiveModelProviderConfig({
              providerId: "provider",
              providerConfig,
              discoveryMode: "strict",
              fetchGuard,
            }),
        },
      },
    });
    const provider = capturePluginRegistration(entry).providers[0];
    const resolveProviderApiKey = vi
      .fn<ProviderCatalogContext["resolveProviderApiKey"]>()
      .mockReturnValueOnce({ apiKey: "tested-key", profileId: "provider:tested" })
      .mockReturnValue({ apiKey: "replacement-key", profileId: "provider:replacement" });
    const resolveProviderAuth = vi.fn<ProviderCatalogContext["resolveProviderAuth"]>();

    await expect(
      provider?.catalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth,
      }),
    ).resolves.toEqual({
      providers: {},
      outcomes: [
        {
          provider: "provider",
          status: "unavailable",
        },
      ],
    });
    expect(resolveProviderApiKey).toHaveBeenCalledExactlyOnceWith("provider");
    expect(resolveProviderAuth).not.toHaveBeenCalled();
    expect(fetchGuard).toHaveBeenCalledOnce();
  });

  it.each([401, 503])(
    "keeps a successful family sibling and reports HTTP %i using the tested auth identity",
    async (status) => {
      const release = vi.fn(async () => undefined);
      const fetchGuard = vi
        .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
        .mockImplementation(async ({ url, init }) => {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tested-key");
          return {
            response: url.includes("/plan/")
              ? new Response("", { status })
              : Response.json({ data: [{ id: seedModel.id }] }),
            finalUrl: url,
            release,
          };
        });
      const family = buildOpenAICompatibleProviderFamilyCatalog({
        credentialProviderId: "family",
        entries: [
          {
            id: "family",
            label: "Family",
            baseUrl: providerConfig.baseUrl,
            models: [seedModel],
            buildProvider: () => providerConfig,
          },
          {
            id: "family-plan",
            label: "Family Plan",
            baseUrl: "https://provider.example.test/plan/v1",
            models: [seedModel],
            buildProvider: () => ({
              ...providerConfig,
              baseUrl: "https://provider.example.test/plan/v1",
            }),
          },
        ],
        staticCatalog: async () => ({ providers: {} }),
        augmentModelCatalog: () => [],
        discoveryMode: "strict",
      });
      const resolveProviderApiKey = vi
        .fn<ProviderCatalogContext["resolveProviderApiKey"]>()
        .mockReturnValueOnce({
          apiKey: "tested-key",
          discoveryApiKey: "tested-key",
          profileId: "family:tested",
        })
        .mockReturnValue({
          apiKey: "replacement-key",
          discoveryApiKey: "replacement-key",
          profileId: "family:replacement",
        });
      const resolveProviderAuth = vi.fn<ProviderCatalogContext["resolveProviderAuth"]>();

      const result = await family.catalog.run({
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth,
      });

      expect(result).toMatchObject({
        providers: { family: { models: [seedModel] } },
        outcomes: [
          { provider: "family", profileId: "family:tested", status: "ready" },
          {
            provider: "family-plan",
            profileId: "family:tested",
            status: status === 401 ? "auth-rejected" : "unavailable",
            ...(status === 401 ? { rejectionScope: "catalog" } : {}),
          },
        ],
      });
      expect(result && "providers" in result ? Object.keys(result.providers) : []).toEqual([
        "family",
      ]);
      expect(resolveProviderApiKey).toHaveBeenCalledExactlyOnceWith("family");
      expect(resolveProviderAuth).not.toHaveBeenCalled();
      expect(fetchGuard).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledTimes(2);
    },
  );
});
