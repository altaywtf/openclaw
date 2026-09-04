import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  buildQualifiedChatModelValue,
  findChatModelCatalogEntry,
  normalizeChatModelProviderId,
} from "../../lib/chat/model-ref.ts";

type DraftModelTarget = {
  entry?: ModelCatalogEntry;
  model: string;
  provider: string | null;
};

export function resolveDraftModelTarget(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): DraftModelTarget | null {
  const value = buildQualifiedChatModelValue(model, provider);
  if (!value) {
    return null;
  }
  const entry = findChatModelCatalogEntry(value, catalog);
  if (entry) {
    return {
      entry,
      model: entry.id,
      provider: normalizeChatModelProviderId(entry.provider) || null,
    };
  }
  const separator = value.indexOf("/");
  if (separator > 0) {
    return {
      model: value.slice(separator + 1),
      provider: normalizeChatModelProviderId(value.slice(0, separator)) || null,
    };
  }
  return {
    model: value,
    provider: normalizeChatModelProviderId(provider ?? "") || null,
  };
}
