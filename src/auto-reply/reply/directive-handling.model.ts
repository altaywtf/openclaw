// Handles model directives and persists provider/model selections.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import { resolveSessionModelProfiles } from "../../agents/session-model-ref.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { shortenHomePath } from "../../utils.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import { resolveSupportedThinkingLevel } from "../thinking.js";
import type { ThinkingCatalogEntry } from "../thinking.shared.js";
import type { ReplyPayload } from "../types.js";
import { resolveModelsCommandReply } from "./commands-models.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { ThinkLevel } from "./directives.js";

export async function maybeHandleModelDirectiveInfo(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  activeAgentId: string;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  policyAliasIndex?: ModelAliasIndex;
  allowedModelKeys: ReadonlySet<string>;
  allowedModelCatalog: Array<{ provider: string; id?: string; name?: string }>;
  currentThinkLevel: ThinkLevel;
  thinkingCatalog?: ThinkingCatalogEntry[];
  runtimePolicySessionKey?: string;
  resetModelOverride: boolean;
  workspaceDir?: string;
  surface?: string;
  sessionEntry?: Pick<SessionEntry, "modelProvider" | "model"> &
    Partial<Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">>;
}): Promise<ReplyPayload | undefined> {
  if (!params.directives.hasModelDirective) {
    return undefined;
  }

  const rawDirective = normalizeOptionalString(params.directives.rawModelDirective);
  const directive = rawDirective ? normalizeLowercaseStringOrEmpty(rawDirective) : undefined;
  const isLiteralModelDirective = params.directives.modelDirectiveSource !== "alias";
  const wantsStatus = isLiteralModelDirective && directive === "status";
  const wantsSummary = isLiteralModelDirective && !rawDirective;
  const wantsLegacyList = isLiteralModelDirective && directive === "list";
  if (!wantsSummary && !wantsStatus && !wantsLegacyList) {
    return undefined;
  }

  if (params.directives.rawModelProfile) {
    return { text: "Auth profile override requires a model selection.", isError: true };
  }
  if (params.directives.rawModelRuntime) {
    return { text: "Runtime override requires a model selection.", isError: true };
  }
  if (params.directives.modelScope) {
    const scopeLabel =
      params.directives.modelScope === "session"
        ? "Session-only"
        : params.directives.modelScope === "agent"
          ? "Agent"
          : "Global";
    return {
      text: `${scopeLabel} scope requires a model selection.`,
      isError: true,
    };
  }

  if (wantsLegacyList) {
    const reply = await resolveModelsCommandReply({
      cfg: params.cfg,
      commandBodyNormalized: "/models",
      surface: params.surface,
      currentModel: `${params.provider}/${params.model}`,
      agentId: params.activeAgentId,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      sessionEntry: params.sessionEntry,
    });
    return reply ?? { text: "No models available." };
  }

  if (wantsSummary) {
    const modelRefs = resolveSelectedAndActiveModel({
      selectedProvider: params.provider,
      selectedModel: params.model,
      sessionEntry: params.sessionEntry,
    });
    const current = modelRefs.selected.label;
    const thinkingRuntime = resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: params.provider,
      modelId: params.model,
      agentId: params.activeAgentId,
      sessionKey: params.runtimePolicySessionKey,
      sessionEntry: params.sessionEntry,
    });
    const effectiveThinkLevel = resolveSupportedThinkingLevel({
      provider: params.provider,
      model: params.model,
      level: params.currentThinkLevel,
      catalog: params.thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
    const thinkingLine = `Think: ${effectiveThinkLevel} (change with /think <level>)`;
    const activeRuntimeLine = modelRefs.activeDiffers
      ? `Active: ${modelRefs.active.label} (runtime)`
      : null;
    const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
    const channelData = commandPlugin?.commands?.buildModelBrowseChannelData?.();
    if (channelData) {
      return {
        text: [
          `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
          activeRuntimeLine,
          thinkingLine,
          "",
          "Tap below to select a model, or use:",
          "/model <provider/model> -s for this session only",
          "/model <provider/model> -a to update this agent's default",
          "/model <provider/model> -g to update the global default",
          "/model <provider/model> --runtime <runtime> -s to switch harnesses",
          "/model status for details",
        ]
          .filter(Boolean)
          .join("\n"),
        channelData,
      };
    }

    return {
      text: [
        `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
        activeRuntimeLine,
        thinkingLine,
        "",
        "Session: /model <provider/model> -s",
        "Agent default: /model <provider/model> -a",
        "Global default: /model <provider/model> -g",
        "Runtime: /model <provider/model> --runtime <runtime> -s",
        "Browse: /models (providers) or /models <provider> (models)",
        "More: /model status",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const { loadPreparedModelCatalogView } = await import("../../agents/model-catalog-view.js");
  const prepared = await loadPreparedModelCatalogView({
    config: params.cfg,
    agentDir: params.agentDir,
    agentId: params.activeAgentId,
    workspaceDir: params.workspaceDir,
    readOnly: true,
    view: "default",
    ...resolveSessionModelProfiles(params.cfg, params.activeAgentId, params.sessionEntry),
  });
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider: params.provider,
    selectedModel: params.model,
    sessionEntry: params.sessionEntry,
  });
  const current = modelRefs.selected.label;
  const defaultLabel = `${prepared.resolvedDefault.provider}/${prepared.resolvedDefault.model}`;
  const lines = [
    `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
    modelRefs.activeDiffers ? `Active: ${modelRefs.active.label} (runtime)` : null,
    `Default: ${defaultLabel}`,
    `Agent: ${params.activeAgentId}`,
    `Auth store: ${shortenHomePath(resolveAuthStorePathForDisplay(params.agentDir))}`,
  ].filter((line): line is string => Boolean(line));
  if (params.resetModelOverride) {
    lines.push(`(previous selection reset to default)`);
  }

  if (params.sessionEntry?.agentRuntimeOverride) {
    lines.push(
      `Session runtime: ${params.sessionEntry.agentRuntimeOverride} (catalog uses agent defaults)`,
    );
  }
  if (prepared.refreshFailed) {
    lines.push("Catalog refresh failed; check Gateway logs.");
  }
  if (prepared.entries.length === 0) {
    lines.push("", "No models available.");
  }

  const byProvider = new Map<string, ModelCatalogEntry[]>();
  for (const entry of prepared.entries) {
    const models = byProvider.get(entry.provider);
    if (models) {
      models.push(entry);
    } else {
      byProvider.set(entry.provider, [entry]);
    }
  }

  for (const [provider, models] of byProvider) {
    const authLabel = prepared.providerAuthLabels.get(provider);
    lines.push("", `[${provider}]${authLabel ? ` auth: ${authLabel}` : ""}`);
    for (const entry of models) {
      const evaluation = prepared.evaluate(entry);
      const runtime = prepared.runtime(entry);
      const availability =
        evaluation.availability === true
          ? "available"
          : evaluation.availability === false
            ? `unavailable${evaluation.unavailableReason ? `: ${evaluation.unavailableReason}` : ""}`
            : "availability unknown";
      const details = [
        availability,
        evaluation.selectedAuthMode ? `auth: ${evaluation.selectedAuthMode}` : null,
        evaluation.selectedProfileId ? `profile: ${evaluation.selectedProfileId}` : null,
        evaluation.unavailableUntil
          ? `retry: ${new Date(evaluation.unavailableUntil).toISOString()}`
          : null,
        runtime ? `runtime: ${runtime.id}` : null,
        `endpoint: ${entry.baseUrl ?? "default"}`,
        entry.api ? `api: ${entry.api}` : null,
      ].filter(Boolean);
      lines.push(
        `  • ${provider}/${entry.id}${entry.alias ? ` (${entry.alias})` : ""} — ${details.join("; ")}`,
      );
    }
  }
  return { text: lines.join("\n") };
}
