import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import type { PreparedConfiguredRuntimeModel } from "./prepared-model-runtime.configured.js";

export function completeConfiguredRuntimeModels(params: {
  configuredModelRefs: readonly ModelCatalogRef[];
  configuredRuntimeModels: readonly PreparedConfiguredRuntimeModel[];
  resolveDynamicModel: (lookup: {
    provider: string;
    modelId: string;
  }) => ProviderRuntimeModel | undefined;
}): PreparedConfiguredRuntimeModel[] {
  const existing = new Map(
    params.configuredRuntimeModels.map((configured) => [
      resolveModelCatalogIdentityKey({ provider: configured.provider, id: configured.modelId }),
      configured,
    ]),
  );
  const completed: PreparedConfiguredRuntimeModel[] = [];
  const seen = new Set<string>();
  for (const ref of params.configuredModelRefs) {
    const key = resolveModelCatalogIdentityKey({ provider: ref.provider, id: ref.modelId });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const prepared = existing.get(key);
    const model = prepared?.model ?? params.resolveDynamicModel(ref);
    if (model) {
      completed.push({ ...ref, model });
    }
  }
  return completed;
}
