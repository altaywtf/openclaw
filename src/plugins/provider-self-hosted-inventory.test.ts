import { describe, expect, it, vi } from "vitest";
import { mergeProviders } from "../agents/models-config.merge.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderCatalogContext } from "./provider-catalog.types.js";
import { discoverOpenAICompatibleSelfHostedProvider } from "./provider-self-hosted-setup.js";

const PROVIDER_ID = "manual-endpoint";
const BASE_URL = "http://127.0.0.1:8123/v1";

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 1_024,
  };
}

describe("self-hosted inventory source ownership", () => {
  it.each([false, true])(
    "selects manual inventory before discovery unless the owner opts in: wildcard=%s",
    async (wildcard) => {
      const configuredModel = model("manual-model");
      const discoveredModel = model("discovered-model");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            modelPolicy: {
              allow: [`${PROVIDER_ID}/${wildcard ? "*" : "manual-model"}`],
            },
          },
        },
        models: {
          providers: {
            [PROVIDER_ID]: {
              baseUrl: BASE_URL,
              api: "openai-completions",
              headers: { "x-manual-header": "preserve" },
              models: [configuredModel],
            },
          },
        },
      };
      const before = structuredClone(config);
      const buildProvider = vi.fn(async (_params: { apiKey?: string; baseUrl?: string }) => ({
        baseUrl: BASE_URL,
        api: "openai-completions" as const,
        models: [discoveredModel],
      }));
      const context: ProviderCatalogContext = {
        config,
        env: {},
        resolveProviderApiKey: () => ({
          apiKey: "self-hosted-key-not-real",
          discoveryApiKey: "self-hosted-key-not-real",
        }),
        resolveProviderAuth: () => ({
          apiKey: "self-hosted-key-not-real",
          mode: "api_key",
          source: "profile",
        }),
      };

      const discovery = await discoverOpenAICompatibleSelfHostedProvider({
        ctx: context,
        providerId: PROVIDER_ID,
        buildProvider,
      });
      const providers = mergeProviders({
        implicit: discovery ? { [PROVIDER_ID]: discovery.provider } : {},
        explicit: config.models?.providers,
      });

      if (wildcard) {
        expect(buildProvider).toHaveBeenCalledExactlyOnceWith({
          apiKey: "self-hosted-key-not-real",
          baseUrl: BASE_URL,
        });
        expect(providers[PROVIDER_ID]?.models.map((entry) => entry.id)).toEqual([
          "manual-model",
          "discovered-model",
        ]);
      } else {
        expect(buildProvider).not.toHaveBeenCalled();
        expect(discovery).toBeNull();
        expect(providers[PROVIDER_ID]?.models).toEqual([configuredModel]);
      }
      expect(providers[PROVIDER_ID]).toMatchObject({
        baseUrl: BASE_URL,
        api: "openai-completions",
        headers: { "x-manual-header": "preserve" },
      });
      expect(config).toEqual(before);
    },
  );
});
