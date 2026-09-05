import type { OpenClawConfig, ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyArceeConfig, applyArceeOpenRouterConfig } from "../../extensions/arcee/api.js";
import { applyBasetenConfig } from "../../extensions/baseten/api.js";
import { applyCerebrasConfig } from "../../extensions/cerebras/api.js";
import { applyChutesConfig } from "../../extensions/chutes/api.js";
import { applyFeatherlessConfig } from "../../extensions/featherless/api.js";
import { applyHuggingfaceConfig } from "../../extensions/huggingface/api.js";
import { applyLongCatConfig } from "../../extensions/longcat/api.js";
import { applyMetaConfig } from "../../extensions/meta/api.js";
import { applyMistralConfig } from "../../extensions/mistral/api.js";
import { applyNvidiaConfig } from "../../extensions/nvidia/api.js";
import { applySyntheticConfig } from "../../extensions/synthetic/api.js";
import { applyTogetherConfig } from "../../extensions/together/api.js";
import { applyXaiConfig } from "../../extensions/xai/api.js";
import { applyXiaomiConfig } from "../../extensions/xiaomi/api.js";

const presets = [
  { name: "Arcee direct", providerId: "arcee", apply: applyArceeConfig },
  { name: "Arcee relay", providerId: "arcee", apply: applyArceeOpenRouterConfig },
  { name: "Baseten", providerId: "baseten", apply: applyBasetenConfig },
  { name: "Cerebras", providerId: "cerebras", apply: applyCerebrasConfig },
  { name: "Chutes", providerId: "chutes", apply: applyChutesConfig },
  { name: "Featherless", providerId: "featherless", apply: applyFeatherlessConfig },
  { name: "Hugging Face", providerId: "huggingface", apply: applyHuggingfaceConfig },
  { name: "LongCat", providerId: "longcat", apply: applyLongCatConfig },
  { name: "Meta", providerId: "meta", apply: applyMetaConfig },
  { name: "Mistral", providerId: "mistral", apply: applyMistralConfig },
  { name: "NVIDIA", providerId: "nvidia", apply: applyNvidiaConfig },
  { name: "Synthetic", providerId: "synthetic", apply: applySyntheticConfig },
  { name: "Together", providerId: "together", apply: applyTogetherConfig },
  { name: "xAI", providerId: "xai", apply: applyXaiConfig },
  { name: "Xiaomi", providerId: "xiaomi", apply: applyXiaomiConfig },
];

const manualModel: ModelDefinitionConfig = {
  id: "operator/manual-model",
  name: "Operator model",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 7, cacheRead: 1, cacheWrite: 2 },
  contextWindow: 32_768,
  maxTokens: 2_048,
};

describe.each(presets)("$name hosted setup inventory", ({ providerId, apply }) => {
  it("does not persist generated catalog rows or widen policy in merge mode", () => {
    const config: OpenClawConfig = {
      models: { mode: "merge" },
      agents: { defaults: { modelPolicy: { allow: ["operator/pinned-model"] } } },
    };
    const before = structuredClone(config);

    const next = apply(config);

    expect(
      Object.values(next.models?.providers ?? {}).flatMap((provider) => provider.models ?? []),
    ).toEqual([]);
    expect(next.agents?.defaults?.modelPolicy).toEqual(config.agents?.defaults?.modelPolicy);
    expect(config).toEqual(before);
  });

  it("retains existing model definitions without appending generated inventory", () => {
    const config: OpenClawConfig = {
      models: {
        mode: "merge",
        providers: {
          [providerId]: {
            baseUrl: "https://operator.example.test/v1",
            api: "openai-completions",
            models: [structuredClone(manualModel)],
          },
          "operator-endpoint": {
            baseUrl: "http://127.0.0.1:8123/v1",
            api: "openai-completions",
            headers: { "x-operator-header": "preserve" },
            models: [structuredClone(manualModel)],
          },
        },
      },
      agents: { defaults: { modelPolicy: { allow: [`${providerId}/${manualModel.id}`] } } },
    };
    const before = structuredClone(config);

    const next = apply(config);

    expect(next.models?.providers?.[providerId]?.models).toEqual([manualModel]);
    expect(next.models?.providers?.["operator-endpoint"]).toEqual(
      config.models?.providers?.["operator-endpoint"],
    );
    expect(next.agents?.defaults?.modelPolicy).toEqual(config.agents?.defaults?.modelPolicy);
    expect(config).toEqual(before);
  });

  it("keeps explicitly requested replace-mode setup self-contained", () => {
    const next = apply({ models: { mode: "replace" } });

    expect(next.models?.mode).toBe("replace");
    expect(next.models?.providers?.[providerId]?.models.length).toBeGreaterThan(0);
  });
});
