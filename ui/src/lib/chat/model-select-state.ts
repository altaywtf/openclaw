// Chat model select state derivation.
import type {
  FastMode,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import {
  buildCatalogDisplayLookup,
  buildChatModelOptionFromLookup,
  buildQualifiedChatModelValue,
  findChatModelCatalogEntry,
  formatCatalogChatModelDisplayFromLookup,
} from "./model-ref.ts";

type ChatModelSelectStateInput = {
  activeSession?: GatewaySessionRow;
  agentDefaultModel?: string;
  chatModelCatalog: ModelCatalogEntry[];
  modelOverrides: Readonly<Record<string, string | null | undefined>>;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
};

type ChatModelSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  unavailableReason?: ModelCatalogEntry["unavailableReason"];
};

type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultLabel: string;
  modelOverrideSource: GatewaySessionRow["modelOverrideSource"];
  options: ChatModelSelectOption[];
};

export type ChatFastModeSelectValue = "" | "on" | "off" | "auto";

export type ChatFastModeSelectState = {
  /** Fast output is effectively enabled (explicitly or via auto/inherited default). */
  active: boolean;
  currentOverride: ChatFastModeSelectValue;
  disabled: boolean;
  /** Short state word shown inside the speed toggle. */
  label: string;
  /** Value the toggle commits when clicked. */
  nextValue: ChatFastModeSelectValue;
  supported: boolean;
};

export type ChatFastModeTarget = Pick<
  GatewaySessionRow,
  "effectiveFastMode" | "fastMode" | "model" | "modelProvider" | "agentRuntime"
>;

type ChatFastModeSelectStateInput = {
  activeRunId: string | null;
  catalog: ModelCatalogEntry[];
  connected: boolean;
  currentModelOverride: string;
  fastModeTarget?: ChatFastModeTarget;
  gatewayAvailable: boolean;
  loading: boolean;
  sending: boolean;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
};

function resolveModelOverrideSource(state: ChatModelSelectStateInput) {
  // A local selection is newer than the row that still reports the previous
  // provenance, so it owns the answer until the refreshed row lands.
  if (Object.hasOwn(state.modelOverrides, state.sessionKey)) {
    return state.modelOverrides[state.sessionKey] == null ? null : "user";
  }
  return state.activeSession?.modelOverrideSource;
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const sharedOverrides = state.modelOverrides;
  if (Object.hasOwn(sharedOverrides, state.sessionKey)) {
    return buildQualifiedChatModelValue(sharedOverrides[state.sessionKey]);
  }

  const active = state.activeSession;
  return buildQualifiedChatModelValue(active?.model, active?.modelProvider);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  const agentDefault = buildQualifiedChatModelValue(state.agentDefaultModel);
  if (agentDefault) {
    return agentDefault;
  }
  return buildQualifiedChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
  );
}

function buildChatModelOptions(
  catalog: ModelCatalogEntry[],
  displayLookup: ReturnType<typeof buildCatalogDisplayLookup>,
): ChatModelSelectOption[] {
  return catalog.map((entry) => ({
    ...buildChatModelOptionFromLookup(entry, displayLookup),
    ...(entry.available === false
      ? { disabled: true, unavailableReason: entry.unavailableReason }
      : {}),
  }));
}

export function resolveChatModelUnavailableReason(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): ModelCatalogEntry["unavailableReason"] {
  const entry = findChatModelCatalogEntry(buildQualifiedChatModelValue(model, provider), catalog);
  return entry?.available === false ? entry.unavailableReason : undefined;
}

export function chatModelUnavailableMessage(
  reason: ModelCatalogEntry["unavailableReason"],
): string | undefined {
  if (reason === "missing-auth") {
    return t("modelSetup.missingAuth");
  }
  return reason === "auth-failed"
    ? `${t("modelSetup.failure.auth")}. ${t("modelSetup.failureGuidance.auth")}`
    : undefined;
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const catalog = state.chatModelCatalog ?? [];
  const displayLookup = buildCatalogDisplayLookup(catalog);
  const options = buildChatModelOptions(catalog, displayLookup);
  const currentOverride = resolveChatModelOverrideValue(state);
  const defaultModel = resolveDefaultModelValue(state);
  const defaultLabel = formatCatalogChatModelDisplayFromLookup(defaultModel, displayLookup);

  return {
    currentOverride,
    defaultModel,
    defaultLabel: defaultModel ? `Default (${defaultLabel})` : "Default model",
    modelOverrideSource: resolveModelOverrideSource(state),
    options,
  };
}

export function normalizeChatFastModeInput(raw: string): FastMode | undefined {
  if (raw === "auto") {
    return "auto";
  }
  if (raw === "on") {
    return true;
  }
  if (raw === "off") {
    return false;
  }
  return undefined;
}

export function resolveChatFastModeStatus(session: GatewaySessionRow | undefined): string {
  const mode = session?.effectiveFastMode ?? session?.fastMode;
  const value =
    mode === "auto"
      ? t("chat.commandResults.fast.autoValue", {
          seconds: String(session?.fastAutoOnSeconds ?? 60),
        })
      : t(mode === true ? "chat.commandResults.fast.on" : "chat.commandResults.fast.off");
  const source = session?.effectiveFastModeSource;
  const sourceSuffix =
    source === "session"
      ? t("chat.commandResults.fast.sourceSession")
      : source === "agent"
        ? t("chat.commandResults.fast.sourceAgent")
        : source === "config"
          ? t("chat.commandResults.fast.sourceModel")
          : source === "default"
            ? t("chat.commandResults.fast.sourceDefault")
            : "";
  return `${t("chat.commandResults.fast.current", { value })}${sourceSuffix}.`;
}

export function resolveChatFastModeSelectState(
  input: ChatFastModeSelectStateInput,
): ChatFastModeSelectState {
  const activeRow = input.fastModeTarget;
  const target = activeRow ?? input.sessionsResult?.defaults;
  const value =
    input.currentModelOverride ||
    buildQualifiedChatModelValue(target?.model, target?.modelProvider);
  const entry = findChatModelCatalogEntry(value, input.catalog);
  const runtimeMatches =
    !target?.agentRuntime ||
    !entry?.agentRuntime ||
    target.agentRuntime.id === entry.agentRuntime.id;
  const canSelectFastMode = runtimeMatches && entry?.supportsFastMode === true;
  const currentOverride =
    activeRow?.fastMode === "auto"
      ? "auto"
      : activeRow?.fastMode === true
        ? "on"
        : activeRow?.fastMode === false
          ? "off"
          : "";
  const effectiveMode = activeRow?.effectiveFastMode ?? activeRow?.fastMode;
  const supported = canSelectFastMode || Boolean(currentOverride);
  const active = effectiveMode === true || effectiveMode === "auto";
  const label =
    effectiveMode === "auto"
      ? "Auto"
      : active
        ? "Fast"
        : effectiveMode === false
          ? "Standard"
          : "Default";
  const nextValue: ChatFastModeSelectValue = !canSelectFastMode ? "" : active ? "off" : "on";
  return {
    active,
    currentOverride,
    disabled:
      !supported ||
      !input.connected ||
      input.loading ||
      input.sending ||
      Boolean(input.activeRunId) ||
      input.stream !== null ||
      !input.gatewayAvailable,
    label,
    nextValue,
    supported,
  };
}
