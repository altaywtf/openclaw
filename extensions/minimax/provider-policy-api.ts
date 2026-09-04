// MiniMax policy module exposes static provider policy before runtime registration.
import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/core";
import {
  resolveMinimaxFastModelId,
  type ProviderFastModeCapabilityContext,
} from "openclaw/plugin-sdk/provider-model-capabilities";
import { resolveMinimaxThinkingProfile } from "./thinking.js";

export function resolveFastModeCapability(ctx: ProviderFastModeCapabilityContext) {
  if (!ctx.api || !ctx.agentRuntime) {
    return undefined;
  }
  return (
    ctx.agentRuntime === "openclaw" &&
    resolveMinimaxFastModelId({ ...ctx, id: ctx.modelId }) !== undefined
  );
}

export function resolveThinkingProfile(context: ProviderDefaultThinkingPolicyContext) {
  return resolveMinimaxThinkingProfile(context.modelId);
}
