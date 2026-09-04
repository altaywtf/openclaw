// Model picker flow lets users select provider models for config defaults.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadPreparedModelCatalogView } from "../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { formatLiteralProviderPrefixedModelRef } from "../agents/model-ref-shared.js";
import {
  buildModelAliasIndex,
  type ModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { formatTokenK } from "../commands/models/shared.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { computeModelPolicyAllowlist } from "../config/model-policy-allowlist-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";

export { applyPrimaryModel } from "../plugins/provider-model-primary.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const BROWSE_VALUE = "__browse__";
const PROVIDER_FILTER_THRESHOLD = 30;
type PickerCatalogView = Awaited<ReturnType<typeof loadPreparedModelCatalogView>>;

function formatKeepCurrentModelLabel(params: {
  configuredRaw?: string;
  configuredLabel: string;
  resolvedKey: string;
}): string {
  return params.configuredRaw
    ? t("wizard.model.keepCurrent", { value: params.configuredLabel })
    : t("wizard.model.keepCurrentDefault", { value: params.resolvedKey });
}

function formatModelRefLabel(params: {
  provider: string;
  model: string;
  key: string;
  literalPrefixProviders: Set<string>;
}): string {
  const providerId = normalizeProviderId(params.provider);
  const modelId = params.model.trim().toLowerCase();
  return providerId &&
    params.literalPrefixProviders.has(providerId) &&
    modelId.startsWith(`${providerId}/`)
    ? formatLiteralProviderPrefixedModelRef(params.provider, params.key)
    : params.key;
}

type PromptDefaultModelParams = {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  allowKeep?: boolean;
  includeManual?: boolean;
  includeProviderPluginSetups?: boolean;
  ignoreAllowlist?: boolean;
  loadCatalog?: boolean;
  browseCatalogOnDemand?: boolean;
  preferredProvider?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: RuntimeEnv;
  message?: string;
};

type PromptDefaultModelResult = { model?: string; config?: OpenClawConfig };
type PromptModelAllowlistResult = { models?: string[]; scopeKeys?: string[] };

async function loadModelPickerRuntime() {
  return import("../commands/model-picker.runtime.js");
}

const loadResolvedModelPickerRuntime = createLazyRuntimeSurface(
  loadModelPickerRuntime,
  ({ modelPickerRuntime }) => modelPickerRuntime,
);

function resolveConfiguredModelKeys(cfg: OpenClawConfig, agentId: string): string[] {
  const models = {
    ...cfg.agents?.defaults?.models,
    ...resolveAgentConfig(cfg, agentId)?.models,
  };
  return Object.keys(models)
    .map((key) => key.trim())
    .filter(Boolean);
}

function orderPickerCatalog(
  view: PickerCatalogView,
  preferredProvider?: string,
): ModelCatalogEntry[] {
  const sourceOrder = new Map<string, number>();
  for (const entry of view.catalog) {
    const key = modelCatalogEntryKey(entry);
    if (!sourceOrder.has(key)) {
      sourceOrder.set(key, sourceOrder.size);
    }
  }
  const entries = preferredProvider
    ? view.entries.filter((entry) => view.matchesProvider(entry.provider, preferredProvider))
    : view.entries;
  return entries.toSorted(
    (left, right) =>
      (sourceOrder.get(modelCatalogEntryKey(left)) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(modelCatalogEntryKey(right)) ?? Number.MAX_SAFE_INTEGER),
  );
}

function normalizeModelKeys(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const value = normalizeAgentModelRefForConfig(raw);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
  }
  return next;
}

function resolveFallbackModelKey(params: {
  cfg: OpenClawConfig;
  raw: string;
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
}): string | undefined {
  const raw = normalizeOptionalString(params.raw);
  if (!raw) {
    return undefined;
  }
  const resolved = resolveModelRefFromString({
    cfg: params.cfg,
    raw,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  });
  if (!resolved) {
    return undefined;
  }
  return modelKey(resolved.ref.provider, resolved.ref.model);
}

function resolveFallbackModelKeys(params: {
  cfg: OpenClawConfig;
  rawFallbacks: string[];
  defaultProvider: string;
  aliasIndex: ModelAliasIndex;
}): string[] {
  return normalizeModelKeys(
    params.rawFallbacks
      .map((raw) =>
        resolveFallbackModelKey({
          cfg: params.cfg,
          raw,
          defaultProvider: params.defaultProvider,
          aliasIndex: params.aliasIndex,
        }),
      )
      .filter((key): key is string => Boolean(key)),
  );
}

async function resolveLiteralPrefixProviderIds(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  providerRefs?: readonly string[];
}): Promise<Set<string>> {
  const { resolvePluginProviders } = await loadResolvedModelPickerRuntime();
  const providers = resolvePluginProviders({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    activate: false,
    cache: false,
    includeUntrustedWorkspacePlugins: false,
    ...(params.providerRefs?.length ? { providerRefs: params.providerRefs } : {}),
  });
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!provider.preserveLiteralProviderPrefix) {
      continue;
    }
    const id = normalizeProviderId(provider.id);
    if (id) {
      ids.add(id);
    }
    for (const alias of provider.aliases ?? []) {
      const aliasId = normalizeProviderId(alias);
      if (aliasId) {
        ids.add(aliasId);
      }
    }
  }
  return ids;
}

function modelCatalogEntryKey(entry: { provider: string; id: string }): string {
  return modelKey(entry.provider, entry.id);
}

function addModelSelectOption(params: {
  entry: ModelCatalogEntry;
  options: WizardSelectOption[];
  seen: Set<string>;
  literalPrefixProviders: Set<string>;
  view: PickerCatalogView;
}) {
  const { entry } = params;
  const key = modelCatalogEntryKey(entry);
  if (params.seen.has(key)) {
    return;
  }
  const hints: string[] = [];
  if (entry.name && entry.name !== entry.id) {
    hints.push(entry.name);
  }
  if (entry.contextWindow) {
    hints.push(`ctx ${formatTokenK(entry.contextWindow)}`);
  }
  if (entry.reasoning) {
    hints.push("reasoning");
  }
  if (entry.alias) {
    hints.push(`alias: ${entry.alias}`);
  }
  const runtime = params.view.runtime(entry);
  if (runtime) {
    hints.push(`${runtime.id} runtime route`);
  }
  const evaluation = params.view.evaluate(entry);
  if (evaluation.availability === false) {
    hints.push(evaluation.unavailableReason ?? "unavailable");
  }
  params.options.push({
    value: key,
    label: formatModelRefLabel({
      provider: entry.provider,
      model: entry.id,
      key,
      literalPrefixProviders: params.literalPrefixProviders,
    }),
    hint: hints.length > 0 ? hints.join(" · ") : undefined,
  });
  params.seen.add(key);
}

function splitModelKey(key: string): { provider: string; id: string } | undefined {
  const slashIndex = key.indexOf("/");
  return slashIndex > 0 && slashIndex < key.length - 1
    ? { provider: key.slice(0, slashIndex), id: key.slice(slashIndex + 1) }
    : undefined;
}

async function promptManualModel(params: {
  prompter: WizardPrompter;
  allowBlank: boolean;
  initialValue?: string;
}): Promise<PromptDefaultModelResult> {
  const modelInput = await params.prompter.text({
    message: params.allowBlank
      ? t("wizard.model.defaultModelBlankToKeep")
      : t("wizard.model.defaultModel"),
    initialValue: params.initialValue,
    placeholder: "provider/model",
    validate: params.allowBlank
      ? undefined
      : (value) => (normalizeOptionalString(value) ? undefined : t("common.required")),
  });
  const model = (modelInput ?? "").trim();
  if (!model) {
    return {};
  }
  return { model: normalizeAgentModelRefForConfig(model) };
}

function buildModelProviderFilterOptions(
  models: Array<{ provider: string }>,
): Array<{ value: string; label: string; hint: string }> {
  const providerIds = sortUniqueStrings(models.map((entry) => entry.provider));
  return providerIds.map((provider) => {
    const count = models.filter((entry) => entry.provider === provider).length;
    return {
      value: provider,
      label: provider,
      hint: t("wizard.model.modelCount", { count, plural: count === 1 ? "" : "s" }),
    };
  });
}

async function maybeFilterModelsByProvider(params: {
  models: ModelCatalogEntry[];
  preferredProvider?: string;
  prompter: WizardPrompter;
}): Promise<ModelCatalogEntry[]> {
  const providers = sortUniqueStrings(params.models.map((entry) => entry.provider));
  if (
    params.preferredProvider ||
    providers.length < 2 ||
    params.models.length <= PROVIDER_FILTER_THRESHOLD
  ) {
    return params.models;
  }
  const selection = await params.prompter.select({
    message: t("wizard.model.filterByProvider"),
    options: [
      { value: "*", label: t("wizard.model.allProviders") },
      ...buildModelProviderFilterOptions(params.models),
    ],
    searchable: true,
  });
  return selection === "*"
    ? params.models
    : params.models.filter((entry) => entry.provider === selection);
}

async function resolveProviderPluginSetupOptions(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WizardSelectOption[]> {
  const runtime = await loadResolvedModelPickerRuntime();
  const providerModelPickerOptions = runtime
    .resolveProviderModelPickerContributions({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
    })
    .map((contribution) => contribution.option);
  return providerModelPickerOptions.map((entry) =>
    Object.assign(
      { value: entry.value, label: entry.label },
      entry.hint ? { hint: entry.hint } : {},
    ),
  );
}

async function maybeHandleProviderPluginSelection(params: {
  selection: string;
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: RuntimeEnv;
}): Promise<PromptDefaultModelResult | null> {
  let pluginResolution: string | null = null;
  let pluginProviders: ProviderPlugin[] = [];
  if (params.selection.startsWith("provider-plugin:")) {
    pluginResolution = params.selection;
  } else if (!params.selection.includes("/")) {
    const { resolvePluginProviders } = await loadResolvedModelPickerRuntime();
    pluginProviders = resolvePluginProviders({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      mode: "setup",
    });
    pluginResolution = pluginProviders.some(
      (provider) => normalizeProviderId(provider.id) === normalizeProviderId(params.selection),
    )
      ? params.selection
      : null;
  }
  if (!pluginResolution) {
    return null;
  }
  if (!params.agentDir || !params.runtime) {
    await params.prompter.note(
      t("wizard.model.providerSetupUnavailable"),
      t("wizard.model.providerSetupUnavailableTitle"),
    );
    return {};
  }
  const {
    resolvePluginProviders,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    runProviderPluginAuthMethod,
  } = await loadResolvedModelPickerRuntime();
  if (pluginProviders.length === 0) {
    pluginProviders = resolvePluginProviders({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      mode: "setup",
    });
  }
  const resolved = resolveProviderPluginChoice({
    providers: pluginProviders,
    choice: pluginResolution,
  });
  if (!resolved) {
    return {};
  }
  const applied = await runProviderPluginAuthMethod({
    config: params.cfg,
    runtime: params.runtime,
    prompter: params.prompter,
    method: resolved.method,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  if (applied.defaultModel) {
    await runProviderModelSelectedHook({
      config: applied.config,
      model: applied.defaultModel,
      prompter: params.prompter,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  }
  return { model: applied.defaultModel, config: applied.config };
}

export async function promptDefaultModel(
  params: PromptDefaultModelParams,
): Promise<PromptDefaultModelResult> {
  const cfg = params.config;
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const pickerAgentDir = params.agentDir ?? resolveAgentDir(cfg, agentId, params.env);
  const allowKeep = params.allowKeep ?? true;
  const includeManual = params.includeManual ?? true;
  const includeProviderPluginSetups = params.includeProviderPluginSetups ?? false;
  const loadCatalog = params.loadCatalog ?? true;
  const browseCatalogOnDemand = params.browseCatalogOnDemand ?? false;
  const ignoreAllowlist = params.ignoreAllowlist ?? false;
  const preferredProviderRaw = normalizeOptionalString(params.preferredProvider);
  const preferredProvider = preferredProviderRaw
    ? normalizeProviderId(preferredProviderRaw)
    : undefined;
  const providerScopedCatalog = Boolean(browseCatalogOnDemand && preferredProvider);
  let configuredRaw =
    resolveAgentModelPrimaryValue(
      resolveAgentConfig(cfg, agentId)?.model ?? cfg.agents?.defaults?.model,
    ) ?? "";
  const useStaticModelNormalization = !loadCatalog || browseCatalogOnDemand;
  let resolved = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowPluginNormalization: useStaticModelNormalization ? false : undefined,
  });
  let resolvedKey = modelKey(resolved.provider, resolved.model);
  let configuredKey = configuredRaw ? resolvedKey : "";
  let literalPrefixProvidersCache: Set<string> | undefined;
  const resolveCachedLiteralPrefixProviders = async () => {
    if (!literalPrefixProvidersCache) {
      literalPrefixProvidersCache = await resolveLiteralPrefixProviderIds({
        cfg,
        workspaceDir: params.workspaceDir,
        env: params.env,
        ...(providerScopedCatalog && preferredProvider
          ? { providerRefs: [preferredProvider] }
          : {}),
      });
    }
    return literalPrefixProvidersCache;
  };
  const resolveConfiguredDisplayLabel = async () => {
    const providerId = normalizeProviderId(resolved.provider);
    if (!providerId) {
      return configuredRaw || resolvedKey;
    }
    const literalPrefixProviders = await resolveCachedLiteralPrefixProviders();
    return formatModelRefLabel({
      provider: resolved.provider,
      model: resolved.model,
      key: configuredRaw || resolvedKey,
      literalPrefixProviders,
    });
  };

  if (
    loadCatalog &&
    browseCatalogOnDemand &&
    allowKeep &&
    (!preferredProvider || normalizeProviderId(resolved.provider) === preferredProvider)
  ) {
    const configuredLabel = await resolveConfiguredDisplayLabel();
    const options: WizardSelectOption[] = [
      {
        value: KEEP_VALUE,
        label: formatKeepCurrentModelLabel({ configuredRaw, configuredLabel, resolvedKey }),
        hint:
          configuredRaw && configuredRaw !== resolvedKey
            ? t("wizard.model.resolvesTo", { value: resolvedKey })
            : undefined,
      },
    ];
    if (includeManual) {
      options.push({ value: MANUAL_VALUE, label: t("wizard.model.enterManually") });
    }
    options.push({
      value: BROWSE_VALUE,
      label: t("wizard.model.browseAll"),
      hint: t("wizard.model.loadsProviderCatalogs"),
    });

    const selection = await params.prompter.select({
      message: params.message ?? t("wizard.model.defaultModel"),
      options,
      initialValue: KEEP_VALUE,
      searchable: false,
    });
    if (selection === KEEP_VALUE) {
      return {};
    }
    if (selection === MANUAL_VALUE) {
      return promptManualModel({
        prompter: params.prompter,
        allowBlank: false,
        initialValue: configuredRaw || resolvedKey || undefined,
      });
    }
    if (selection !== BROWSE_VALUE) {
      return { model: selection };
    }
  }

  if (!loadCatalog) {
    const configuredLabel = await resolveConfiguredDisplayLabel();
    const options: WizardSelectOption[] = [];
    if (allowKeep) {
      options.push({
        value: KEEP_VALUE,
        label: formatKeepCurrentModelLabel({ configuredRaw, configuredLabel, resolvedKey }),
        hint:
          configuredRaw && configuredRaw !== resolvedKey
            ? t("wizard.model.resolvesTo", { value: resolvedKey })
            : undefined,
      });
    }
    if (includeManual) {
      options.push({ value: MANUAL_VALUE, label: t("wizard.model.enterManually") });
    }
    if (configuredKey && !options.some((option) => option.value === configuredKey)) {
      options.push({
        value: configuredKey,
        label: configuredKey,
        hint: t("wizard.model.current"),
      });
    }
    if (options.length === 0) {
      return promptManualModel({
        prompter: params.prompter,
        allowBlank: allowKeep,
        initialValue: configuredRaw || resolvedKey || undefined,
      });
    }
    const selection = await params.prompter.select({
      message: params.message ?? t("wizard.model.defaultModel"),
      options,
      initialValue: allowKeep ? KEEP_VALUE : configuredKey || MANUAL_VALUE,
      searchable: false,
    });
    if (selection === KEEP_VALUE) {
      return {};
    }
    if (selection === MANUAL_VALUE) {
      return promptManualModel({
        prompter: params.prompter,
        allowBlank: false,
        initialValue: configuredRaw || resolvedKey || undefined,
      });
    }
    return { model: selection };
  }

  const catalogProgress = params.prompter.progress(t("wizard.model.loadingModels"));
  let view: PickerCatalogView;
  try {
    view = await loadPreparedModelCatalogView({
      config: cfg,
      agentId,
      agentDir: pickerAgentDir,
      workspaceDir: params.workspaceDir,
      env: params.env,
      readOnly: Boolean(preferredProvider),
      ...(preferredProvider
        ? { providerDiscoveryProviderIds: [preferredProvider], scopedLiveProviderDiscovery: true }
        : {}),
      ...(ignoreAllowlist ? { view: "all" as const } : {}),
    });
  } finally {
    catalogProgress.stop();
  }
  resolved = view.resolvedDefault;
  resolvedKey = modelKey(resolved.provider, resolved.model);
  configuredRaw = view.defaultModel ?? "";
  configuredKey = configuredRaw ? resolvedKey : "";
  // Only ready models are suggestions; explicit current/manual choices and allowlist edits remain available.
  const models = orderPickerCatalog(view, preferredProvider).filter(
    (entry) => view.evaluate(entry).availability === true,
  );
  const filteredModels = await maybeFilterModelsByProvider({
    models,
    preferredProvider,
    prompter: params.prompter,
  });
  const literalPrefixProviders = await resolveCachedLiteralPrefixProviders();

  // Show the literal form (e.g. nvidia/nvidia/...) in the "Keep current" label
  // for providers that set preserveLiteralProviderPrefix, so the user sees the
  // same ref they'll pick from the catalog rows. Config itself stays canonical.
  const configuredLabel = formatModelRefLabel({
    provider: resolved.provider,
    model: resolved.model,
    key: configuredRaw || resolvedKey,
    literalPrefixProviders,
  });

  const options: WizardSelectOption[] = [];
  if (allowKeep) {
    options.push({
      value: KEEP_VALUE,
      label: formatKeepCurrentModelLabel({ configuredRaw, configuredLabel, resolvedKey }),
    });
  }
  if (includeManual) {
    options.push({ value: MANUAL_VALUE, label: t("wizard.model.enterManually") });
  }
  if (includeProviderPluginSetups && params.agentDir && !providerScopedCatalog) {
    options.push(
      ...(await resolveProviderPluginSetupOptions({
        cfg,
        workspaceDir: params.workspaceDir,
        env: params.env,
      })),
    );
  }

  const seen = new Set<string>();
  for (const entry of filteredModels) {
    addModelSelectOption({
      entry,
      options,
      seen,
      literalPrefixProviders,
      view,
    });
  }
  if (configuredKey && !seen.has(configuredKey)) {
    options.push({
      value: configuredKey,
      label: configuredLabel,
      hint: t("wizard.model.currentNotInCatalog"),
    });
  }

  const firstPreferredModelKey =
    preferredProvider && filteredModels[0] ? modelCatalogEntryKey(filteredModels[0]) : undefined;
  let initialValue: string | undefined = allowKeep ? KEEP_VALUE : configuredKey || undefined;
  if (
    firstPreferredModelKey &&
    (!allowKeep || !view.matchesProvider(resolved.provider, preferredProvider))
  ) {
    initialValue = firstPreferredModelKey;
  }
  if (options.length === 0) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }

  const selection = await params.prompter.select({
    message: params.message ?? t("wizard.model.defaultModel"),
    options,
    initialValue,
    searchable: true,
  });
  const selectedValue = selection ?? "";
  if (selectedValue === KEEP_VALUE) {
    return {};
  }
  if (selectedValue === MANUAL_VALUE) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: false,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }

  const providerPluginResult = await maybeHandleProviderPluginSelection({
    selection: selectedValue,
    cfg,
    prompter: params.prompter,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    runtime: params.runtime,
  });
  if (providerPluginResult) {
    return providerPluginResult;
  }

  const model = normalizeAgentModelRefForConfig(selectedValue);
  const { runProviderModelSelectedHook } = await loadResolvedModelPickerRuntime();
  await runProviderModelSelectedHook({
    config: cfg,
    model,
    prompter: params.prompter,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return { model };
}

export async function promptModelAllowlist(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  message?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowedKeys?: string[];
  initialSelections?: string[];
  preferredProvider?: string;
  loadCatalog?: boolean;
}): Promise<PromptModelAllowlistResult> {
  const cfg = params.config;
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const agent = resolveAgentConfig(cfg, agentId);
  const pickerAgentDir = params.agentDir ?? resolveAgentDir(cfg, agentId, params.env);
  const existingKeys = resolveConfiguredModelKeys(cfg, agentId);
  const configuredRaw =
    resolveAgentModelPrimaryValue(agent?.model ?? cfg.agents?.defaults?.model) ?? "";
  const allowedKeys = normalizeModelKeys(params.allowedKeys ?? []);
  const preferredProvider = normalizeOptionalString(params.preferredProvider);
  const resolved = resolveDefaultModelForAgent({ cfg, agentId, allowPluginNormalization: false });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: resolved.provider });
  const fallbackKeys = resolveFallbackModelKeys({
    cfg,
    rawFallbacks: resolveAgentModelFallbackValues(agent?.model ?? cfg.agents?.defaults?.model),
    defaultProvider: resolved.provider,
    aliasIndex,
  });
  const initialSeeds = normalizeModelKeys([
    ...existingKeys,
    ...(configuredRaw ? [resolvedKey] : []),
    ...fallbackKeys,
    ...(params.initialSelections ?? []),
  ]);
  const loadCatalog = (params.loadCatalog ?? true) && allowedKeys.length === 0;
  let scopeKeys = allowedKeys.length > 0 ? allowedKeys : undefined;
  const options: WizardSelectOption[] = [];
  if (loadCatalog) {
    const progress = params.prompter.progress(t("wizard.model.loadingModels"));
    let view: PickerCatalogView;
    try {
      view = await loadPreparedModelCatalogView({
        config: cfg,
        agentId,
        agentDir: pickerAgentDir,
        workspaceDir: params.workspaceDir,
        env: params.env,
        view: "all",
        readOnly: Boolean(preferredProvider),
        ...(preferredProvider
          ? { providerDiscoveryProviderIds: [preferredProvider], scopedLiveProviderDiscovery: true }
          : {}),
      });
    } finally {
      progress.stop();
    }
    const catalog = orderPickerCatalog(view, preferredProvider);
    const literalPrefixProviders = await resolveLiteralPrefixProviderIds({
      cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      ...(preferredProvider ? { providerRefs: [preferredProvider] } : {}),
    });
    const seen = new Set<string>();
    const allowedKeySet = scopeKeys ? new Set(scopeKeys) : undefined;
    for (const entry of catalog) {
      if (allowedKeySet && !allowedKeySet.has(modelCatalogEntryKey(entry))) {
        continue;
      }
      addModelSelectOption({ entry, options, seen, literalPrefixProviders, view });
    }
    if (preferredProvider && !scopeKeys) {
      scopeKeys = normalizeModelKeys([
        ...catalog.map(modelCatalogEntryKey),
        ...existingKeys.filter((key) => {
          const ref = splitModelKey(key);
          return ref ? view.matchesProvider(ref.provider, preferredProvider) : false;
        }),
      ]);
    }
  } else if (!scopeKeys) {
    scopeKeys = preferredProvider
      ? initialSeeds.filter(
          (key) => splitModelKey(key)?.provider === normalizeProviderId(preferredProvider),
        )
      : undefined;
    if (!scopeKeys?.length) {
      return {};
    }
  }
  const scopeKeySet = scopeKeys ? new Set(scopeKeys) : undefined;
  const initialKeys = scopeKeySet
    ? initialSeeds.filter((key) => scopeKeySet.has(key))
    : initialSeeds;
  if (loadCatalog && options.length === 0 && !scopeKeys?.length) {
    const raw = await params.prompter.text({
      message: params.message ?? t("wizard.model.allowlistText"),
      initialValue: existingKeys.length > 0 ? initialKeys.join(", ") : "",
      placeholder: "provider/model, other-provider/model",
    });
    const models = normalizeModelKeys((raw ?? "").split(","));
    return models.length > 0 ? { models } : {};
  }
  const seen = new Set(options.map((option) => option.value));
  for (const key of scopeKeys ?? initialKeys) {
    if (!seen.has(key)) {
      options.push({
        value: key,
        label: key,
        hint: t(loadCatalog ? "wizard.model.configuredNotInCatalog" : "wizard.model.configured"),
      });
      seen.add(key);
    }
  }
  const selected = normalizeModelKeys(
    await params.prompter.multiselect({
      message: params.message ?? t("wizard.model.allowlistPicker"),
      options,
      initialValues: initialKeys.length > 0 ? initialKeys : undefined,
      searchable: true,
    }),
  );
  if (selected.length > 0) {
    return { models: selected, ...(scopeKeys ? { scopeKeys } : {}) };
  }
  if (!scopeKeys && existingKeys.length === 0) {
    return { models: [] };
  }
  const confirmed = await params.prompter.confirm({
    message: t(scopeKeys ? "wizard.model.removeProviderModels" : "wizard.model.clearAllowlist"),
    initialValue: false,
  });
  return confirmed ? { models: [], ...(scopeKeys ? { scopeKeys } : {}) } : {};
}

export function applyModelAllowlist(
  cfg: OpenClawConfig,
  models: string[],
  opts: { scopeKeys?: string[] } = {},
): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const normalized = normalizeModelKeys(models);
  const scopeKeys = opts.scopeKeys ? normalizeModelKeys(opts.scopeKeys) : [];
  const scopeKeySet = scopeKeys.length > 0 ? new Set(scopeKeys) : null;
  const existingModels = normalizeAgentModelMapForConfig(defaults?.models ?? {});
  const legacyAllow = computeModelPolicyAllowlist({
    root: cfg,
    defaults,
  });
  const existingAllow = normalizeModelKeys(defaults?.modelPolicy?.allow ?? legacyAllow ?? []);
  const scopeProviders = new Set(
    scopeKeys.map((key) => normalizeProviderId(key.slice(0, key.indexOf("/")))),
  );
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
  const isPolicyRefInScope = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (trimmed.endsWith("/*")) {
      return scopeProviders.has(normalizeProviderId(trimmed.slice(0, -2)));
    }
    const resolved = resolveModelRefFromString({
      cfg,
      raw: trimmed,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    return Boolean(
      resolved && scopeKeySet?.has(modelKey(resolved.ref.provider, resolved.ref.model)),
    );
  };
  if (normalized.length === 0) {
    // No agent defaults means no policy/legacy map to edit; nothing to clear.
    if (!defaults || (!defaults.modelPolicy && !legacyAllow)) {
      return cfg;
    }
    if (scopeKeySet) {
      const nextAllow = existingAllow.filter((key) => !isPolicyRefInScope(key));
      const { modelPolicy: _modelPolicy, ...restDefaults } = defaults;
      return {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...restDefaults,
            ...(nextAllow.length > 0 || legacyAllow
              ? { modelPolicy: { ...defaults?.modelPolicy, allow: nextAllow } }
              : {}),
          },
        },
      };
    }
    if (legacyAllow) {
      return {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...defaults,
            modelPolicy: { ...defaults?.modelPolicy, allow: [] },
          },
        },
      };
    }
    const { modelPolicy: _modelPolicy, ...restDefaults } = defaults;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: restDefaults,
      },
    };
  }

  if (scopeKeySet) {
    const nextModels = { ...existingModels };
    for (const key of normalized) {
      nextModels[key] = existingModels[key] ?? {};
    }
    const nextAllow = existingAllow.filter((key) => !isPolicyRefInScope(key));
    for (const key of normalized) {
      if (!nextAllow.includes(key)) {
        nextAllow.push(key);
      }
    }
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...defaults,
          models: nextModels,
          modelPolicy: { ...defaults?.modelPolicy, allow: nextAllow },
        },
      },
    };
  }

  const nextModels: Record<string, { alias?: string }> = { ...existingModels };
  for (const key of normalized) {
    nextModels[key] = existingModels[key] ?? {};
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        models: nextModels,
        modelPolicy: { ...defaults?.modelPolicy, allow: normalized },
      },
    },
  };
}

export function applyModelFallbacksFromSelection(
  cfg: OpenClawConfig,
  selection: string[],
  opts: { scopeKeys?: string[] } = {},
): OpenClawConfig {
  const normalized = normalizeModelKeys(selection);
  const scopeKeys = opts.scopeKeys ? normalizeModelKeys(opts.scopeKeys) : [];
  const scopeKeySet = scopeKeys.length > 0 ? new Set(scopeKeys) : null;
  if (normalized.length === 0 && !scopeKeySet) {
    return cfg;
  }

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const includesResolvedPrimary = normalized.includes(resolvedKey);
  if (!includesResolvedPrimary && !scopeKeySet) {
    return cfg;
  }

  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : existingModel && typeof existingModel === "object"
        ? existingModel.primary
        : undefined;
  const normalizedExistingPrimary =
    existingPrimary != null ? normalizeAgentModelRefForConfig(existingPrimary) : undefined;
  const preservedModelFields =
    existingModel && typeof existingModel === "object"
      ? (({ fallbacks: _oldFallbacks, ...rest }) => rest)(existingModel)
      : {};

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: resolved.provider,
  });
  const existingFallbacks =
    existingModel && typeof existingModel === "object" && Array.isArray(existingModel.fallbacks)
      ? resolveFallbackModelKeys({
          cfg,
          rawFallbacks: existingModel.fallbacks,
          defaultProvider: resolved.provider,
          aliasIndex,
        })
      : [];
  const existingFallbackSet = new Set(existingFallbacks);
  const rawSelectedFallbacks = normalized.filter((key) => key !== resolvedKey);
  const selectedFallbacks =
    scopeKeySet && !includesResolvedPrimary
      ? rawSelectedFallbacks.filter((key) => existingFallbackSet.has(key))
      : rawSelectedFallbacks;
  const preserveExistingFallback = (fallback: string) =>
    scopeKeySet !== null && scopeKeySet.has(fallback) === false;
  const fallbacks = mergeFallbackSelection({
    existingFallbacks,
    selectedFallbacks,
    preserveExistingFallback,
  });
  const nextModel = {
    ...preservedModelFields,
    ...(normalizedExistingPrimary != null ? { primary: normalizedExistingPrimary } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
  if (Object.keys(nextModel).length === 0) {
    if (!defaults || !Object.hasOwn(defaults, "model")) {
      return cfg;
    }
    const { model: _ignoredModel, ...restDefaults } = defaults;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: restDefaults,
      },
    };
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: nextModel,
      },
    },
  };
}

function mergeFallbackSelection(params: {
  existingFallbacks: string[];
  selectedFallbacks: string[];
  preserveExistingFallback: (fallback: string) => boolean;
}): string[] {
  const selected = new Set(params.selectedFallbacks);
  const fallbacks: string[] = [];
  for (const fallback of params.existingFallbacks) {
    if (params.preserveExistingFallback(fallback)) {
      fallbacks.push(fallback);
      continue;
    }
    if (selected.delete(fallback)) {
      fallbacks.push(fallback);
    }
  }
  for (const fallback of params.selectedFallbacks) {
    if (selected.has(fallback)) {
      fallbacks.push(fallback);
    }
  }
  return fallbacks;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
