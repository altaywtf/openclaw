import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../../../../src/auto-reply/thinking.shared.js";
import type {
  GatewaySessionRow,
  GatewayThinkingLevelOption,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { pushUniqueTrimmedSelectOption } from "../select-options.ts";
import { sessionModelMatchesDefaults } from "../session-model-defaults.ts";
// Control UI module implements thinking behavior.
import { areUiSessionKeysEquivalent } from "../sessions/session-key.ts";
import { buildQualifiedChatModelValue, findChatModelCatalogEntry } from "./model-ref.ts";

type ThinkingSessionDefaults = SessionsListResult["defaults"] | undefined;

type ChatThinkingSelection = {
  source: "override" | "default";
  value: string;
  displayLabel: string;
} & ({ kind: "anchored"; index: number } | { kind: "unanchored" });

export type ChatThinkingTarget = Pick<
  GatewaySessionRow,
  | "agentRuntime"
  | "model"
  | "modelProvider"
  | "thinkingDefault"
  | "thinkingLevel"
  | "thinkingLevels"
  | "thinkingOptions"
>;

export type ChatThinkingSelectState = {
  selection: ChatThinkingSelection;
  inherited: { value: string; displayLabel: string };
  options: Array<{ value: string; label: string }>;
};

type ThinkingProfile = Pick<
  ChatThinkingTarget,
  "thinkingLevels" | "thinkingDefault" | "agentRuntime"
>;

export function resolveThinkingProfileForSession(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  catalog: readonly ModelCatalogEntry[] = [],
): ThinkingProfile | undefined {
  const target = session?.model || session?.modelProvider ? session : defaults;
  const catalogEntry = findChatModelCatalogEntry(
    buildQualifiedChatModelValue(target?.model, target?.modelProvider),
    catalog,
  );
  const sessionRuntime = session?.agentRuntime?.id;
  const catalogRuntime = catalogEntry?.agentRuntime?.id;
  const candidates = [
    session,
    sessionModelMatchesDefaults(session, defaults) ? defaults : undefined,
    sessionRuntime && catalogRuntime && sessionRuntime !== catalogRuntime
      ? undefined
      : catalogEntry,
  ];
  return candidates.find(
    (candidate) =>
      candidate?.thinkingLevels !== undefined || candidate?.thinkingDefault !== undefined,
  );
}

function resolveThinkingLevelOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  catalog: readonly ModelCatalogEntry[] = [],
): GatewayThinkingLevelOption[] {
  return resolveThinkingProfileForSession(session, defaults, catalog)?.thinkingLevels ?? [];
}

export function resolveThinkingCommandArgOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults?: SessionsListResult["defaults"],
  catalog: readonly ModelCatalogEntry[] = [],
): string[] {
  const options = resolveThinkingLevelOptionsForSession(session, defaults, catalog).map((level) =>
    normalizeThinkingOptionValue(level.id),
  );
  return options.length > 0
    ? ["default", ...new Set(options.filter((option) => option && option !== "default"))]
    : [];
}

export function formatThinkingCommandOptionsForSession(
  session: ChatThinkingTarget | undefined,
  defaults?: SessionsListResult["defaults"],
  catalog: readonly ModelCatalogEntry[] = [],
): string {
  const levels = resolveThinkingProfileForSession(session, defaults, catalog)?.thinkingLevels;
  if (levels === undefined) {
    return t("common.unknown");
  }
  const options = levels.map((level) => level.label).join(", ");
  return options
    ? options.split(", ").includes("default")
      ? options
      : `default, ${options}`
    : t("common.none");
}

export function resolveThinkingLevelInput(
  rawLevel: string,
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  catalog: readonly ModelCatalogEntry[] = [],
): string | undefined {
  const normalized = normalizeThinkLevel(rawLevel);
  if (normalized) {
    return normalized;
  }
  const rawKey = normalizeLowercaseStringOrEmpty(rawLevel);
  return resolveThinkingLevelOptionsForSession(session, defaults, catalog)
    .map((option) => ({
      id: normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id),
      label: normalizeLowercaseStringOrEmpty(option.label),
    }))
    .find((option) => option.id === rawKey || option.label === rawKey)?.id;
}

export function isThinkingLevelOptionForSession(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  level: string,
  catalog: readonly ModelCatalogEntry[] = [],
): boolean | undefined {
  return resolveThinkingProfileForSession(session, defaults, catalog)?.thinkingLevels?.some(
    (option) => {
      const id = normalizeThinkLevel(option.id) ?? normalizeLowercaseStringOrEmpty(option.id);
      return id === level || normalizeThinkLevel(option.label) === level;
    },
  );
}

export function resolveCurrentThinkingLevel(
  session: ChatThinkingTarget | undefined,
  defaults: ThinkingSessionDefaults,
  models: ModelCatalogEntry[],
): string {
  const persisted = session?.thinkingLevel?.trim();
  const profile = resolveThinkingProfileForSession(session, defaults, models);
  return persisted
    ? (profile?.thinkingLevels?.find(
        (level) =>
          normalizeThinkingOptionValue(level.id) === normalizeThinkingOptionValue(persisted),
      )?.label ?? persisted)
    : (profile?.thinkingDefault ?? t("common.unknown"));
}

function buildThinkingOptions(
  levels: readonly GatewayThinkingLevelOption[],
): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  const addOption = (value: string, label?: string) => {
    const normalizedValue = normalizeThinkingOptionValue(value);
    pushUniqueTrimmedSelectOption(options, seen, normalizedValue, () =>
      formatThinkingOverrideLabel(normalizedValue, label),
    );
  };

  for (const level of levels) {
    addOption(level.id, level.label);
  }
  return options;
}

export function resolveChatThinkingSelectState(params: {
  catalog: readonly ModelCatalogEntry[];
  defaults?: SessionsListResult["defaults"];
  session?: ChatThinkingTarget;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
}): ChatThinkingSelectState {
  const session =
    params.session ??
    params.sessionsResult?.sessions?.find((row) =>
      areUiSessionKeysEquivalent(row.key, params.sessionKey),
    );
  const persisted = session?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const defaults = params.defaults ?? params.sessionsResult?.defaults;
  const profile = resolveThinkingProfileForSession(session, defaults, params.catalog);
  const levels = profile?.thinkingLevels ?? [];
  const defaultLevel = profile?.thinkingDefault ?? "";
  const options = buildThinkingOptions(levels);
  const defaultValue = normalizeThinkingOptionValue(defaultLevel);
  const inherited = {
    value: defaultValue,
    displayLabel: formatInheritedThinkingLabel(defaultLevel),
  };
  const selectionValue = currentOverride || defaultValue;
  const selectionIndex = options.findIndex((option) => option.value === selectionValue);
  const source = currentOverride ? "override" : "default";
  const displayLabel = currentOverride
    ? (options[selectionIndex]?.label ?? formatThinkingOverrideLabel(currentOverride))
    : inherited.displayLabel;
  return {
    selection:
      selectionIndex >= 0
        ? { kind: "anchored", source, value: selectionValue, displayLabel, index: selectionIndex }
        : { kind: "unanchored", source, value: selectionValue, displayLabel },
    inherited,
    options,
  };
}

export function normalizeThinkingOptionValue(raw: string): string {
  return normalizeThinkLevel(raw) ?? normalizeLowercaseStringOrEmpty(raw);
}

export function formatInheritedThinkingLabel(effectiveLevel: string | null | undefined): string {
  if (!effectiveLevel) {
    return t("common.unknown");
  }
  const normalized = normalizeThinkingOptionValue(effectiveLevel);
  return `Inherited: ${formatThinkingLevelDisplayLabel(normalized)}`;
}

export function formatThinkingOverrideLabel(value: string, label?: string | null): string {
  const normalized = normalizeThinkingOptionValue(value);
  if (!normalized || normalized === "off") {
    return "Off";
  }
  return formatThinkingLevelDisplayLabel(label?.trim() || normalized);
}

function formatThinkingLevelDisplayLabel(value: string): string {
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (["on", "enable", "enabled"].includes(raw)) {
    return "On";
  }
  const normalized = normalizeThinkingOptionValue(value);
  switch (normalized) {
    case "adaptive":
      return "Adaptive";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
    case "ultra":
      return "Ultra";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
