// Chat model reference normalization.
import type { ModelCatalogEntry } from "../../api/types.ts";

export function normalizeChatModelProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

export function buildQualifiedChatModelValue(
  model: string | null | undefined,
  provider?: string | null,
): string {
  const trimmedModel = model?.trim();
  if (!trimmedModel) {
    return "";
  }
  const trimmedProvider = provider?.trim();
  if (!trimmedProvider) {
    return trimmedModel;
  }
  const providerPrefix = `${trimmedProvider.toLowerCase()}/`;
  return trimmedModel.toLowerCase().startsWith(providerPrefix)
    ? trimmedModel
    : `${trimmedProvider}/${trimmedModel}`;
}

export function findChatModelCatalogEntry(
  value: string,
  catalog: readonly ModelCatalogEntry[],
): ModelCatalogEntry | undefined {
  const key = value.trim().toLowerCase();
  return catalog.find((entry) => createQualifiedCatalogKey(entry) === key);
}

function formatChatModelDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return trimmed;
  }
  return `${trimmed.slice(separator + 1)} · ${trimmed.slice(0, separator)}`;
}

function formatRawCatalogLabel(entry: ModelCatalogEntry): string {
  const provider = entry.provider?.trim();
  return provider ? `${entry.id} · ${provider}` : entry.id;
}

function resolveCatalogDisplayName(entry: ModelCatalogEntry): string {
  const name = entry.name.trim();
  const alias = entry.alias?.trim();
  if (!name || !alias) {
    return name || alias || "";
  }
  if (alias.toLowerCase() === name.toLowerCase()) {
    return name;
  }
  // Aliases are selectable metadata, not a replacement for model identity.
  // Preserve richer custom labels only when they already contain the full name.
  return alias.toLowerCase().includes(name.toLowerCase()) ? alias : `${name} · ${alias}`;
}

function createQualifiedCatalogKey(entry: ModelCatalogEntry): string {
  return buildQualifiedChatModelValue(entry.id, entry.provider).trim().toLowerCase();
}

function createNameProviderKey(name: string, provider?: string | null): string {
  return `${name.toLowerCase()}\u0000${provider?.trim().toLowerCase() ?? ""}`;
}

type ChatModelDisplayLookup = ReadonlyMap<string, string>;

export function buildCatalogDisplayLookup(catalog: ModelCatalogEntry[]): Map<string, string> {
  const nameToValues = new Map<string, Set<string>>();
  const nameProviderToValues = new Map<string, Set<string>>();

  for (const entry of catalog) {
    const name = resolveCatalogDisplayName(entry);
    if (!name) {
      continue;
    }

    const qualifiedKey = createQualifiedCatalogKey(entry);
    const normalizedName = name.toLowerCase();
    const providerKey = createNameProviderKey(name, entry.provider);

    const nameValues = nameToValues.get(normalizedName) ?? new Set<string>();
    nameValues.add(qualifiedKey);
    nameToValues.set(normalizedName, nameValues);

    const nameProviderValues = nameProviderToValues.get(providerKey) ?? new Set<string>();
    nameProviderValues.add(qualifiedKey);
    nameProviderToValues.set(providerKey, nameProviderValues);
  }

  const displayLookup = new Map<string, string>();
  for (const entry of catalog) {
    const qualifiedKey = createQualifiedCatalogKey(entry);
    const name = resolveCatalogDisplayName(entry);
    if (!name) {
      displayLookup.set(qualifiedKey, formatRawCatalogLabel(entry));
      continue;
    }

    const normalizedName = name.toLowerCase();
    if ((nameToValues.get(normalizedName)?.size ?? 0) <= 1) {
      displayLookup.set(qualifiedKey, name);
      continue;
    }

    const provider = entry.provider?.trim();
    if ((nameProviderToValues.get(createNameProviderKey(name, provider))?.size ?? 0) <= 1) {
      displayLookup.set(qualifiedKey, provider ? `${name} · ${provider}` : `${name} · ${entry.id}`);
      continue;
    }

    displayLookup.set(qualifiedKey, `${name} · ${formatRawCatalogLabel(entry)}`);
  }

  return displayLookup;
}

export function formatCatalogChatModelDisplayFromLookup(
  value: string,
  displayLookup: ChatModelDisplayLookup,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return displayLookup.get(trimmed.toLowerCase()) ?? formatChatModelDisplay(trimmed);
}

export function buildChatModelOptionFromLookup(
  entry: ModelCatalogEntry,
  displayLookup: ChatModelDisplayLookup,
): { value: string; label: string } {
  const value = buildQualifiedChatModelValue(entry.id, entry.provider);
  return {
    value,
    label: displayLookup.get(value.toLowerCase()) ?? formatRawCatalogLabel(entry),
  };
}
