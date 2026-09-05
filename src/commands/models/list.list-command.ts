/** Implementation of `openclaw models list`. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelChoice,
  ModelsListResult,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/server-capabilities.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { isLocalBaseUrl } from "../../agents/model-catalog-route.js";
import { loadPreparedModelCatalogView } from "../../agents/model-catalog-view.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { ExpectedCliError } from "../../cli/failure-output.js";
import { requestExitAfterOneShotOutput } from "../../cli/one-shot-exit.js";
import { callGateway, isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { buildPublicModelProjection } from "../../gateway/server-methods/models-list-public-projection.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { RuntimeEnv } from "../../runtime.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";
import { ensureFlagCompatibility, resolveModelsTargetAgent } from "./shared.js";

function toCliModelRow(model: ModelChoice): ModelRow {
  const key = modelKey(model.provider, model.id);
  return {
    key,
    name: model.name || model.id,
    input: model.input?.length ? model.input.join("+") : "text",
    contextWindow: model.contextWindow ?? null,
    ...(typeof model.contextTokens === "number" ? { contextTokens: model.contextTokens } : {}),
    local: model.local ?? null,
    available: model.available ?? null,
    tags: [...new Set([...(model.tags ?? []), ...(model.alias ? [`alias:${model.alias}`] : [])])],
  };
}

function printModelsList(
  rows: ModelRow[],
  runtime: RuntimeEnv,
  opts: { json?: boolean; plain?: boolean },
) {
  if (rows.length === 0 && !opts.json && !opts.plain) {
    runtime.log("No models found.");
  } else {
    printModelTable(rows, runtime, opts);
  }
  requestExitAfterOneShotOutput(runtime);
}

/** Lists configured, catalog, and runtime-discovered models as text, plain, or JSON. */
export async function modelsListCommand(
  opts: {
    all?: boolean;
    refresh?: boolean;
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
    return normalizeProviderId(rawProviderFilter);
  })();
  const { resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const includeFullCatalog = Boolean(opts.all || parsedProviderFilter);
  const localTarget = await isImplicitLocalGatewayTarget({ config: cfg });
  const explicitPort = Boolean(process.env.OPENCLAW_GATEWAY_PORT?.trim());
  const gatewayOwner =
    localTarget && !explicitPort
      ? await readActiveGatewayLockIdentity({ requireInspection: true })
      : undefined;
  if (!localTarget || explicitPort || gatewayOwner) {
    const result = await callGateway<ModelsListResult>({
      config: cfg,
      method: "models.list",
      requiredCapabilities: [GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG],
      ...(gatewayOwner ? { localPortOverride: gatewayOwner.port } : {}),
      params: {
        ...(opts.agent?.trim() ? { agentId: opts.agent.trim() } : {}),
        view: includeFullCatalog ? "all" : "default",
        ...(parsedProviderFilter ? { provider: parsedProviderFilter } : {}),
        includeDetails: true,
        ...(opts.refresh ? { refresh: true } : {}),
      },
    });
    if (result.refreshFailed) {
      runtime.error("Model discovery could not refresh. Showing the published model list.");
    }
    printModelsList(
      result.models.filter((model) => !opts.local || model.local === true).map(toCliModelRow),
      runtime,
      opts,
    );
    return;
  }
  runtime.error(
    opts.refresh
      ? "Gateway is not running. Refreshing the local model catalog."
      : "Gateway is not running. Showing the local cached model catalog.",
  );
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, {
    kind: "read",
  });
  const preparedCatalog = await loadPreparedModelCatalogView({
    agentId,
    agentDir,
    config: cfg,
    view: includeFullCatalog ? "all" : "default",
    readOnly: opts.refresh !== true,
    ...(opts.refresh ? { refreshFullCatalog: true } : {}),
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
    .map((model) =>
      toCliModelRow({
        ...buildPublicModelProjection(model, { includeDetails: true }),
        available: preparedCatalog.evaluate(model).availability,
        tags: [...(configuredTags.get(modelKey(model.provider, model.id)) ?? [])],
      }),
    );

  printModelsList(rows, runtime, opts);
}
