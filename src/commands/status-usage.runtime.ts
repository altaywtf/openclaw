// Optional status usage probes own credential and provider runtime imports.
import {
  resolveAmbientOwnerAgentId,
  resolveConfiguredAgentId,
} from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { loadPreparedModelCatalogView } from "../agents/model-catalog-view.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  buildCodexSyntheticUsageAuth,
  mergeUsageSummaries,
  shouldUseCodexSyntheticUsageForRuntime,
} from "../status/codex-synthetic-usage.js";

const providerUsageLoader = createLazyImportLoader(() => import("../infra/provider-usage.js"));

export type StatusUsageSummaryOptions = {
  config: OpenClawConfig;
  timeoutMs?: number;
  agentId?: string;
  agentDir?: string;
};

/** Loads provider usage for status output from an explicit or ambient system-agent scope. */
export async function resolveStatusUsageSummary(params: StatusUsageSummaryOptions) {
  const { loadProviderUsageSummary } = await providerUsageLoader.load();
  const rawAgentId = params.agentId?.trim();
  if (params.agentId !== undefined && !rawAgentId) {
    throw new Error("--agent must not be blank");
  }
  const agentId = rawAgentId ? normalizeAgentId(rawAgentId) : undefined;
  if (agentId) {
    resolveConfiguredAgentId(params.config, agentId);
  }
  let resolvedAgentId = agentId;
  let agentDir = params.agentDir;
  if (!agentDir) {
    resolvedAgentId ??= resolveAmbientOwnerAgentId(params.config, undefined, {
      surface: "status usage credentials",
      hint: "Set agents.defaults.systemAgent.agentId.",
    });
    agentDir = resolveAgentDir(params.config, resolvedAgentId);
  }
  const usage = await loadProviderUsageSummary({
    timeoutMs: params.timeoutMs,
    config: params.config,
    agentDir,
  });
  const prepared = await loadPreparedModelCatalogView({
    config: params.config,
    agentDir,
    agentId: resolvedAgentId,
    readOnly: true,
  });
  const entry = findModelInCatalog(
    prepared.entries,
    prepared.resolvedDefault.provider,
    prepared.resolvedDefault.model,
  );
  if (!entry) {
    return usage;
  }
  const evaluation = prepared.evaluate(entry);
  if (
    evaluation.selectedAuthMode === "api_key" ||
    evaluation.selectedAuthMode === "api-key" ||
    !shouldUseCodexSyntheticUsageForRuntime({
      provider: entry.provider,
      effectiveHarness: prepared.runtime(entry)?.id,
    })
  ) {
    return usage;
  }
  const codexUsage = await loadProviderUsageSummary({
    timeoutMs: params.timeoutMs,
    providers: ["openai"],
    auth: [buildCodexSyntheticUsageAuth({ authProfileId: evaluation.selectedProfileId })],
    config: params.config,
    agentDir,
  });
  return mergeUsageSummaries(usage, codexUsage);
}
