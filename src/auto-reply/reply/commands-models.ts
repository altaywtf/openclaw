// Implements model listing and provider catalog commands.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { listCliRuntimeModelBackendBindings } from "../../agents/cli-backends.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { loadPreparedModelCatalogView } from "../../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentRuntimeLabel } from "../../status/agent-runtime-label.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

type ModelsCommandSessionEntry = Partial<
  Pick<SessionEntry, "authProfileOverride" | "modelProvider" | "model">
>;

export type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  modelNames: Map<string, string>;
  providerAuthLabels?: ReadonlyMap<string, string>;
  runtimeChoicesByProvider?: Map<string, ModelsRuntimeChoice[]>;
};

type PreparedModelsProviderData = ModelsProviderData & {
  modelCatalog: ModelCatalogEntry[];
};

export type ModelsRuntimeChoice = {
  id: string;
  label: string;
  description: string;
};

type ParsedModelsCommand =
  | { action: "providers" }
  | {
      action: "list";
      provider?: string;
      page: number;
      pageSize: number;
      all: boolean;
    }
  | {
      action: "add";
      provider?: string;
      modelId?: string;
    };

function normalizeRuntimeChoiceId(runtime: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(runtime);
  if (!normalized || normalized === "auto" || normalized === "default") {
    return "openclaw";
  }
  return normalized;
}

function buildRuntimeChoice(params: {
  cfg: OpenClawConfig;
  provider: string;
  runtime: string;
  cli?: boolean;
}): ModelsRuntimeChoice {
  const id = normalizeRuntimeChoiceId(params.runtime);
  const label = resolveAgentRuntimeLabel({ config: params.cfg, resolvedHarness: id });
  return {
    id,
    label,
    description:
      id === "openclaw"
        ? "Use the built-in OpenClaw runtime."
        : params.cli
          ? `Run ${params.provider} models through ${label}.`
          : `Use the ${label} runtime selected by the effective harness policy.`,
  };
}

function buildDefaultRuntimeChoice(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  provider: string;
  modelId?: string;
}): ModelsRuntimeChoice {
  const harnessPolicy = resolveAgentHarnessPolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  return buildRuntimeChoice({
    cfg: params.cfg,
    provider: params.provider,
    runtime: harnessPolicy.runtime,
  });
}

function addRuntimeChoice(
  choices: ModelsRuntimeChoice[],
  choice: ModelsRuntimeChoice,
): ModelsRuntimeChoice[] {
  if (!choices.some((existing) => existing.id === choice.id)) {
    choices.push(choice);
  }
  return choices;
}

export async function buildPreparedModelsProviderData(
  cfg: OpenClawConfig,
  agentId?: string,
  options: { view?: "default" | "all"; workspaceDir?: string } = {},
): Promise<PreparedModelsProviderData> {
  const view = await loadPreparedModelCatalogView({
    config: cfg,
    agentId,
    workspaceDir: options.workspaceDir,
    readOnly: options.view !== "all",
    ...(options.view === "all" ? { refreshFullCatalog: true } : {}),
    view: options.view,
  });
  const { resolvedDefault } = view;
  const byProvider = new Map<string, Set<string>>();
  const modelNames = new Map<string, string>();
  for (const entry of view.entries) {
    const models = byProvider.get(entry.provider) ?? new Set<string>();
    models.add(entry.id);
    byProvider.set(entry.provider, models);
    modelNames.set(`${entry.provider}/${entry.id}`, entry.name);
  }
  const providers = [...byProvider.keys()].toSorted();
  const runtimeChoicesByProvider = new Map<string, ModelsRuntimeChoice[]>();
  const runtimeBindings = [
    { provider: "openai", runtime: "codex", cli: false },
    ...listCliRuntimeModelBackendBindings().map((binding) => ({
      provider: binding.provider,
      runtime: binding.runtime,
      cli: true,
    })),
  ];
  for (const binding of runtimeBindings) {
    const provider = normalizeProviderId(binding.provider);
    const defaultModelId =
      provider === normalizeProviderId(resolvedDefault.provider)
        ? resolvedDefault.model
        : undefined;
    const choices = runtimeChoicesByProvider.get(provider) ?? [
      buildDefaultRuntimeChoice({
        cfg,
        agentId,
        provider,
        modelId: defaultModelId,
      }),
    ];
    addRuntimeChoice(choices, buildRuntimeChoice({ cfg, provider, runtime: "openclaw" }));
    addRuntimeChoice(
      choices,
      buildRuntimeChoice({
        cfg,
        provider,
        runtime: binding.runtime,
        cli: binding.cli,
      }),
    );
    runtimeChoicesByProvider.set(provider, choices);
  }

  return {
    byProvider,
    providers,
    resolvedDefault,
    modelNames,
    modelCatalog: view.entries,
    providerAuthLabels: view.providerAuthLabels,
    runtimeChoicesByProvider,
  };
}

function formatProviderLine(params: { provider: string; count: number }): string {
  return `- ${params.provider} (${params.count})`;
}

function parseListArgs(tokens: string[]): Extract<ParsedModelsCommand, { action: "list" }> {
  const provider = normalizeOptionalString(tokens[0]);

  let page = 1;
  let all = false;
  for (const token of tokens.slice(1)) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower === "all" || lower === "--all") {
      all = true;
      continue;
    }
    if (lower.startsWith("page=")) {
      const value = parseStrictPositiveInteger(lower.slice("page=".length));
      if (value !== undefined) {
        page = value;
      }
      continue;
    }
    const pageToken = parseStrictPositiveInteger(lower);
    if (pageToken !== undefined) {
      page = pageToken;
    }
  }

  let pageSize = PAGE_SIZE_DEFAULT;
  for (const token of tokens) {
    const lower = normalizeLowercaseStringOrEmpty(token);
    if (lower.startsWith("limit=") || lower.startsWith("size=")) {
      const rawValue = lower.slice(lower.indexOf("=") + 1);
      const value = parseStrictPositiveInteger(rawValue);
      if (value !== undefined) {
        pageSize = Math.min(PAGE_SIZE_MAX, value);
      }
    }
  }

  return {
    action: "list",
    provider: provider ? normalizeProviderId(provider) : undefined,
    page,
    pageSize,
    all,
  };
}

function parseModelsArgs(raw: string): ParsedModelsCommand {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { action: "providers" };
  }

  const tokens = trimmed.split(/\s+/g).filter(Boolean);
  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  switch (first) {
    case "providers":
      return { action: "providers" };
    case "list":
      return parseListArgs(tokens.slice(1));
    case "add":
      return {
        action: "add",
        provider: normalizeOptionalString(tokens[1]),
        modelId: normalizeOptionalString(tokens.slice(2).join(" ")),
      };
    default:
      return parseListArgs(tokens);
  }
}

function formatProviderLabel(provider: string, authLabel?: string): string {
  return authLabel ? `${provider} · 🔑 ${authLabel}` : provider;
}

export function formatModelsAvailableHeader(params: {
  provider: string;
  total: number;
  cfg?: OpenClawConfig;
  authLabel?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string {
  return `Models (${formatProviderLabel(params.provider, params.authLabel)}) — ${params.total} available`;
}

function buildModelsMenuText(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): string {
  return [
    "Providers:",
    ...params.providers.map((provider) =>
      formatProviderLine({
        provider,
        count: params.byProvider.get(provider)?.size ?? 0,
      }),
    ),
    "",
    "Use: /models <provider>",
    "Switch: /model <provider/model>",
  ].join("\n");
}

function buildProviderInfos(params: {
  providers: string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): Array<{ id: string; count: number }> {
  return params.providers.map((provider) => ({
    id: provider,
    count: params.byProvider.get(provider)?.size ?? 0,
  }));
}

export async function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): Promise<ReplyPayload | null> {
  const body = params.commandBodyNormalized.trim();
  if (!body.startsWith("/models")) {
    return null;
  }

  const argText = body.replace(/^\/models\b/i, "").trim();
  const parsed = parseModelsArgs(argText);

  const { byProvider, providers, modelNames, providerAuthLabels } =
    await buildPreparedModelsProviderData(params.cfg, params.agentId, {
      ...(parsed.action === "list" && parsed.all ? { view: "all" as const } : {}),
      workspaceDir: params.workspaceDir,
    });
  const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
  const providerInfos = buildProviderInfos({ providers, byProvider });

  if (parsed.action === "providers") {
    const channelData =
      commandPlugin?.commands?.buildModelsMenuChannelData?.({
        providers: providerInfos,
      }) ??
      commandPlugin?.commands?.buildModelsProviderChannelData?.({
        providers: providerInfos,
      });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider }),
    };
  }

  if (parsed.action === "add") {
    return { text: MODELS_ADD_DEPRECATED_TEXT };
  }

  const { provider, page, pageSize, all } = parsed;

  if (!provider) {
    const channelData = commandPlugin?.commands?.buildModelsProviderChannelData?.({
      providers: providerInfos,
    });
    if (channelData) {
      return {
        text: "Select a provider:",
        channelData,
      };
    }
    return {
      text: buildModelsMenuText({ providers, byProvider }),
    };
  }

  if (!byProvider.has(provider)) {
    return {
      text: [
        `Unknown provider: ${provider}`,
        "",
        "Available providers:",
        ...providers.map((entry) => `- ${entry}`),
        "",
        "Use: /models <provider>",
      ].join("\n"),
    };
  }

  const models = [...(byProvider.get(provider) ?? new Set<string>())].toSorted();
  const total = models.length;

  if (total === 0) {
    const emptyProviderLabel = formatProviderLabel(provider, providerAuthLabels?.get(provider));
    return {
      text: [
        `Models (${emptyProviderLabel}) — none`,
        "",
        "Browse: /models",
        "Switch: /model <provider/model>",
      ].join("\n"),
    };
  }

  const interactivePageSize = 8;
  const interactiveTotalPages = Math.max(1, Math.ceil(total / interactivePageSize));
  const interactivePage = Math.max(1, Math.min(page, interactiveTotalPages));
  const interactiveChannelData = commandPlugin?.commands?.buildModelsListChannelData?.({
    provider,
    models,
    currentModel: params.currentModel,
    currentPage: interactivePage,
    totalPages: interactiveTotalPages,
    pageSize: interactivePageSize,
    modelNames,
  });
  if (interactiveChannelData) {
    return {
      text: formatModelsAvailableHeader({
        provider,
        total,
        authLabel: providerAuthLabels?.get(provider),
      }),
      channelData: interactiveChannelData,
    };
  }

  const effectivePageSize = all ? total : pageSize;
  const pageCount = effectivePageSize > 0 ? Math.ceil(total / effectivePageSize) : 1;
  const safePage = all ? 1 : Math.max(1, Math.min(page, pageCount));

  if (!all && page !== safePage) {
    return {
      text: [
        `Page out of range: ${page} (valid: 1-${pageCount})`,
        "",
        `Try: /models list ${provider} ${safePage}`,
        `All: /models list ${provider} all`,
      ].join("\n"),
    };
  }

  const startIndex = (safePage - 1) * effectivePageSize;
  const endIndexExclusive = Math.min(total, startIndex + effectivePageSize);
  const pageModels = models.slice(startIndex, endIndexExclusive);
  const providerLabel = formatProviderLabel(provider, providerAuthLabels?.get(provider));
  const lines = [
    `Models (${providerLabel}) — showing ${startIndex + 1}-${endIndexExclusive} of ${total} (page ${safePage}/${pageCount})`,
  ];
  for (const id of pageModels) {
    lines.push(`- ${provider}/${id}`);
  }
  lines.push("", "Switch: /model <provider/model>");
  if (!all && safePage < pageCount) {
    lines.push(`More: /models list ${provider} ${safePage + 1}`);
  }
  if (!all) {
    lines.push(`All: /models list ${provider} all`);
  }
  return { text: lines.join("\n") };
}

export const handleModelsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBodyNormalized = params.command.commandBodyNormalized.trim();
  if (!commandBodyNormalized.startsWith("/models")) {
    return null;
  }
  const parsed = parseModelsArgs(commandBodyNormalized.replace(/^\/models\b/i, "").trim());
  const unauthorized = rejectUnauthorizedCommand(params, "/models");
  if (unauthorized) {
    return unauthorized;
  }

  if (parsed.action === "add") {
    return { shouldContinue: false, reply: { text: MODELS_ADD_DEPRECATED_TEXT } };
  }

  const modelsAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: params.cfg,
      })
    : (params.agentId ?? "main");
  const currentAgentId = params.agentId ?? "main";
  const modelsAgentDir =
    modelsAgentId === currentAgentId && params.agentDir
      ? params.agentDir
      : resolveAgentDir(params.cfg, modelsAgentId);
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  const reply = await resolveModelsCommandReply({
    cfg: params.cfg,
    commandBodyNormalized,
    surface: params.ctx.Surface,
    currentModel: params.model ? `${params.provider}/${params.model}` : undefined,
    agentId: modelsAgentId,
    agentDir: modelsAgentDir,
    workspaceDir:
      targetSessionEntry?.spawnedWorkspaceDir ??
      (modelsAgentId === currentAgentId ? params.workspaceDir : undefined),
    sessionEntry: targetSessionEntry,
  });
  if (!reply) {
    return null;
  }
  return { reply, shouldContinue: false };
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
