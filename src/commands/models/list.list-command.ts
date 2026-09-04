/** Implementation of `openclaw models list`. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import { loadPreparedModelCatalogView } from "../../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { parseModelRef } from "../../agents/model-selection-normalize.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { ExpectedCliError } from "../../cli/failure-output.js";
import { requestExitAfterOneShotOutput } from "../../cli/one-shot-exit.js";
import type { RuntimeEnv } from "../../runtime.js";
import { isLocalBaseUrl } from "./list.local-url.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";
import { ensureFlagCompatibility, resolveModelsTargetAgent } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

const ROW_INPUT_KINDS = new Set(["text", "image", "document"]);

function toCliModelRow(
  model: ModelCatalogEntry,
  evaluation: ModelAuthAvailabilityEvaluation,
  configuredTags: ReadonlyMap<string, readonly string[]>,
): ModelRow {
  const key = modelKey(model.provider, model.id);
  const baseUrl = model.baseUrl ?? "";
  const input = (model.input ?? []).filter((item) => ROW_INPUT_KINDS.has(item));
  return {
    key,
    name: model.name || model.id,
    input: input.length > 0 ? input.join("+") : "text",
    contextWindow: model.contextWindow ?? null,
    ...(typeof model.contextTokens === "number" ? { contextTokens: model.contextTokens } : {}),
    local: isLocalBaseUrl(baseUrl),
    available: evaluation.availability ?? null,
    tags: [
      ...new Set([
        ...(configuredTags.get(key) ?? []),
        ...(model.alias ? [`alias:${model.alias}`] : []),
      ]),
    ],
  };
}

/** Lists configured, catalog, and runtime-discovered models as text, plain, or JSON. */
export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    agent?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const rawProviderFilter = opts.provider?.trim();
  const parsedProviderFilter = (() => {
    if (!rawProviderFilter) {
      return undefined;
    }
    if (/\s/u.test(rawProviderFilter)) {
      const message = `Invalid provider filter "${sanitizeTerminalText(rawProviderFilter)}". Use a provider id such as "moonshot", not a display label.`;
      throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
    }
    const parsed = parseModelRef(
      `${rawProviderFilter}/_`,
      DEFAULT_PROVIDER,
      DISPLAY_MODEL_PARSE_OPTIONS,
    );
    return parsed?.provider ?? normalizeLowercaseStringOrEmpty(rawProviderFilter);
  })();
  const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, {
    kind: "read",
  });
  const includeFullCatalog = Boolean(opts.all || parsedProviderFilter);
  const preparedCatalog = await loadPreparedModelCatalogView({
    agentId,
    agentDir,
    config: cfg,
    view: includeFullCatalog ? "all" : "default",
    readOnly: !includeFullCatalog,
    ...(includeFullCatalog ? { refreshFullCatalog: true } : {}),
  });
  const providerAliasCanonicalizer = createModelCatalogProviderAliasCanonicalizer({
    cfg,
    metadataSnapshot: preparedCatalog.metadataSnapshot,
  });
  const providerFilter = parsedProviderFilter
    ? providerAliasCanonicalizer.provider(parsedProviderFilter)
    : undefined;
  const { entries } = preparedCatalog.configuredEntries;
  if (providerFilter) {
    const knownProviderIds = new Set(
      [
        ...preparedCatalog.metadataSnapshot.owners.providers.keys(),
        ...preparedCatalog.metadataSnapshot.owners.modelCatalogProviders.keys(),
        ...Object.keys(cfg.models?.providers ?? {}),
        ...entries.map((entry) => entry.ref.provider),
        ...preparedCatalog.entries.map((entry) => entry.provider),
      ].map(providerAliasCanonicalizer.provider),
    );
    if (!knownProviderIds.has(providerFilter)) {
      const message = `Unknown provider filter "${sanitizeTerminalText(rawProviderFilter ?? providerFilter)}" for this installation. Run ${formatCliCommand("openclaw plugins list --json")} to see installed providers, or configure it under models.providers.`;
      throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
    }
  }
  const configuredTags = new Map(entries.map((entry) => [entry.key, [...entry.tags]] as const));
  const rows = preparedCatalog.entries
    .filter(
      (model) =>
        (!providerFilter ||
          providerAliasCanonicalizer.provider(model.provider) === providerFilter) &&
        (!opts.local || isLocalBaseUrl(model.baseUrl ?? "")),
    )
    .map((model) => toCliModelRow(model, preparedCatalog.evaluate(model), configuredTags));

  if (rows.length === 0 && !opts.json && !opts.plain) {
    runtime.log("No models found.");
  } else {
    printModelTable(rows, runtime, opts);
  }
  requestExitAfterOneShotOutput(runtime);
}
