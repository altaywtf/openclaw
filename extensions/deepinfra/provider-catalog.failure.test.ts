import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeepInfraApiKeyCatalog } from "./provider-catalog.js";

const fetchGuard = vi.hoisted(() => vi.fn<LiveModelCatalogFetchGuard>());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuard,
}));

const context: ProviderCatalogContext = {
  config: {},
  env: {},
  resolveProviderApiKey: () => ({
    apiKey: "DEEPINFRA_API_KEY",
    discoveryApiKey: "activation-key",
    profileId: "deepinfra:configured",
  }),
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
};

describe("DeepInfra catalog acquisition outcome", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());
  afterEach(() => {
    clearLiveCatalogCacheForTests();
    fetchGuard.mockReset();
  });

  it.each(["metadata", "pricing"])(
    "catalog cutover: records failed %s despite a successful sibling fact",
    async (stage) => {
      const failedEndpoint = stage === "metadata" ? "/v1/openai/models" : "/models/list";
      fetchGuard.mockImplementation(async ({ url }) => ({
        response:
          new URL(url).pathname === failedEndpoint
            ? new Response("catalog fact unavailable", { status: 503 })
            : new URL(url).pathname === "/models/list"
              ? Response.json([
                  {
                    model_name: "fixture/model",
                    pricing: {
                      type: "tokens",
                      cents_per_input_token: 0.0002,
                      cents_per_output_token: 0.001,
                    },
                  },
                ])
              : Response.json({
                  data: [
                    {
                      id: "fixture/model",
                      metadata: {
                        tags: ["chat"],
                        context_length: 131072,
                        max_tokens: 65536,
                        pricing: { input_tokens: 3, output_tokens: 15 },
                      },
                    },
                  ],
                }),
        finalUrl: url,
        release: async () => undefined,
      }));
      const result = await buildDeepInfraApiKeyCatalog(context);
      expect(result?.outcomes).toEqual([{ provider: "deepinfra", status: "unavailable" }]);
      expect(fetchGuard).toHaveBeenCalledTimes(2);
    },
  );

  it("catalog cutover: keeps missing DeepInfra credentials a non-attempt", async () => {
    await expect(
      buildDeepInfraApiKeyCatalog({
        ...context,
        resolveProviderApiKey: () => ({ apiKey: undefined }),
      }),
    ).resolves.toBeNull();
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
