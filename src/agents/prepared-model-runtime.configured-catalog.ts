import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InlineModelEntry } from "./embedded-agent-runner/model.inline-provider.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelCatalogLogicalKey } from "./openai-model-routes.js";
import {
  toStaticCatalogEntry,
  type PreparedConfiguredRuntimeModel,
} from "./prepared-model-runtime.configured.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

type ConfiguredCatalogAgentFacts = {
  input: { config: OpenClawConfig };
  configuredModelRefs: readonly ModelCatalogRef[];
};

type ConfiguredCatalogWorkspaceFacts = {
  configuredCatalogEntries: readonly ModelCatalogEntry[];
  inlineProviderModels: readonly InlineModelEntry[];
};

type ConfiguredRuntimeFacts = {
  templateModelRegistry: ModelRegistry;
  modelCatalog: ModelCatalogSnapshot;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  inlineProviderModels: readonly InlineModelEntry[];
};

function createConfiguredModelCatalogSnapshot(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ModelCatalogSnapshot {
  const entries = new Map<string, ModelCatalogEntry>();
  const addEntry = (entry: ModelCatalogEntry) => {
    const key = modelCatalogLogicalKey(entry);
    if (!entries.has(key)) {
      entries.set(key, entry);
    }
  };
  // The registry has merged current settings with cached discovery. Raw configured rows must
  // not replace those routes with an inherited provider preset during cold startup.
  if (params.agentFacts.input.config.models?.mode !== "replace") {
    for (const model of params.templateModelRegistry.getAll()) {
      addEntry(toStaticCatalogEntry(model));
    }
  }
  for (const entry of params.workspaceFacts.configuredCatalogEntries) {
    addEntry(entry);
  }
  if (params.agentFacts.input.config.models?.mode === "replace") {
    const configuredEntries = [...entries.values()];
    return { entries: configuredEntries, routeVariants: configuredEntries };
  }
  for (const configured of params.configuredRuntimeModels) {
    addEntry(toStaticCatalogEntry(configured.model));
  }
  for (const { provider, modelId } of params.agentFacts.configuredModelRefs) {
    const model = params.templateModelRegistry.find(provider, modelId);
    if (model) {
      addEntry(toStaticCatalogEntry(model));
    }
  }
  const configuredEntries = [...entries.values()];
  const staticEntries = params.configuredRuntimeModels.map(({ model }) =>
    toStaticCatalogEntry(model),
  );
  return {
    entries: configuredEntries,
    routeVariants: configuredEntries,
    ...(staticEntries.length > 0 ? { staticEntries } : {}),
  };
}

export function prepareConfiguredRuntimeFacts(params: {
  agentFacts: ConfiguredCatalogAgentFacts;
  workspaceFacts: ConfiguredCatalogWorkspaceFacts;
  templateModelRegistry: ModelRegistry;
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
}): ConfiguredRuntimeFacts {
  return {
    templateModelRegistry: params.templateModelRegistry,
    modelCatalog: createConfiguredModelCatalogSnapshot(params),
    configuredRuntimeModels: params.configuredRuntimeModels,
    inlineProviderModels: params.workspaceFacts.inlineProviderModels,
  };
}
