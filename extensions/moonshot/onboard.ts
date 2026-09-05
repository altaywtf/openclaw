// Moonshot setup module handles plugin onboarding behavior.
import {
  createProviderConnectionPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildMoonshotProvider,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_DEFAULT_MODEL_ID,
  MOONSHOT_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";

const moonshotPresetAppliers = createProviderConnectionPresetAppliers<[string]>({
  primaryModelRef: MOONSHOT_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig, baseUrl: string) => ({
    providerId: "moonshot",
    api: "openai-completions",
    baseUrl,
    catalogModels: () =>
      buildMoonshotProvider().models.filter((model) => model.id === MOONSHOT_DEFAULT_MODEL_ID),
    aliases: [{ modelRef: MOONSHOT_DEFAULT_MODEL_REF, alias: "Kimi" }],
  }),
});

export function applyMoonshotConfig(cfg: OpenClawConfig): OpenClawConfig {
  return moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_BASE_URL);
}

export function applyMoonshotConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return moonshotPresetAppliers.applyConfig(cfg, MOONSHOT_CN_BASE_URL);
}
