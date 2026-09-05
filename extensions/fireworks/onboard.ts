import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  buildFireworksCatalogModels,
  buildFireworksProvider,
  FIREWORKS_DEFAULT_MODEL_REF,
} from "./provider-catalog.js";

export const { applyConfig: applyFireworksConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: FIREWORKS_DEFAULT_MODEL_REF,
  resolveParams: () => {
    const defaultProvider = buildFireworksProvider();
    return {
      providerId: "fireworks",
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      catalogModels: buildFireworksCatalogModels,
      aliases: [{ modelRef: FIREWORKS_DEFAULT_MODEL_REF, alias: "GLM 5.2 Fast" }],
    };
  },
});
