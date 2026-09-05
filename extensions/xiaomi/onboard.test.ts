// Xiaomi tests cover onboard plugin behavior.
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import {
  applyXiaomiConfig,
  applyXiaomiProviderConfig,
  applyXiaomiTokenPlanConfig,
} from "./onboard.js";
import { buildXiaomiProvider, buildXiaomiTokenPlanProvider } from "./provider-catalog.js";

describe("xiaomi onboard", () => {
  it.each(["merge", "replace"] as const)(
    "adds Xiaomi provider with correct settings: %s",
    (mode) => {
      const cfg = applyXiaomiConfig({ models: { mode } });
      const provider = cfg.models?.providers?.xiaomi;
      const catalog = buildXiaomiProvider();
      expect(provider).toEqual({ ...catalog, models: mode === "replace" ? catalog.models : [] });
      expect(cfg.agents?.defaults?.models?.["xiaomi/mimo-v2.5"]).toEqual({ alias: "Xiaomi" });
      expect(cfg.agents?.defaults?.model).toEqual({ primary: "xiaomi/mimo-v2.5" });
      expectProviderOnboardPrimaryModel({
        applyConfig: applyXiaomiConfig,
        modelRef: "xiaomi/mimo-v2.5",
      });
    },
  );

  it("merges Xiaomi models and keeps existing provider overrides", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyXiaomiProviderConfig,
      providerId: "xiaomi",
      providerApi: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      legacyApi: "openai-completions",
      legacyModelId: "custom-model",
      legacyModelName: "Custom",
    });
    expect(provider?.models.map((model) => model.id)).toEqual(["custom-model"]);
  });

  it.each(["merge", "replace"] as const)(
    "adds the regional Xiaomi Token Plan preset: %s",
    (mode) => {
      const cfg = applyXiaomiTokenPlanConfig({ models: { mode } }, "ams");
      const provider = cfg.models?.providers?.["xiaomi-token-plan"];
      const catalog = buildXiaomiTokenPlanProvider();
      expect(provider).toEqual({
        ...catalog,
        models: mode === "replace" ? catalog.models : [],
        baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
      });
      expect(cfg.agents?.defaults?.models?.["xiaomi-token-plan/mimo-v2.5-pro"]).toEqual({
        alias: "Xiaomi MiMo V2.5 Pro",
      });
      expect(cfg.agents?.defaults?.model).toEqual({ primary: "xiaomi-token-plan/mimo-v2.5-pro" });
      expectProviderOnboardPrimaryModel({
        applyConfig: (config) => applyXiaomiTokenPlanConfig(config, "ams"),
        modelRef: "xiaomi-token-plan/mimo-v2.5-pro",
      });
    },
  );

  it("merges Xiaomi Token Plan models and rewrites the selected regional base URL", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: (config) => applyXiaomiTokenPlanConfig(config, "sgp"),
      providerId: "xiaomi-token-plan",
      providerApi: "openai-completions",
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      legacyApi: "openai-completions",
      legacyModelId: "custom-token-plan-model",
      legacyModelName: "Custom Token Plan",
    });
    expect(provider?.models.map((model) => model.id)).toEqual(["custom-token-plan-model"]);
  });
});
