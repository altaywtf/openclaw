import {
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeFastMode,
} from "openclaw/plugin-sdk/provider-model-capabilities";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type AnthropicServiceTier = "auto" | "standard_only";

export function normalizeAnthropicServiceTier(value: unknown): AnthropicServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized === "auto" || normalized === "standard_only" ? normalized : undefined;
}

export function resolveAnthropicFastModeTransport(
  model: {
    id: string;
    provider: string;
    api?: string;
    baseUrl?: string;
    params?: Record<string, unknown>;
  },
  endpointClass: string,
): "speed" | "priority" | undefined {
  if (
    model.provider.trim().toLowerCase() !== "anthropic" ||
    model.api?.trim().toLowerCase() !== "anthropic-messages" ||
    (endpointClass !== "default" && endpointClass !== "anthropic-public")
  ) {
    return undefined;
  }
  if (supportsClaudeFastMode(model)) {
    return "speed";
  }
  return resolveClaudeSonnet5ModelIdentity(model) === undefined ? "priority" : undefined;
}
