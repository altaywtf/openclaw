export { resolveClaudeSonnet5ModelIdentity, supportsClaudeFastMode } from "@openclaw/llm-core";
export { resolveMinimaxFastModelId } from "../llm/providers/minimax-fast-mode.js";
export {
  supportsOpenAIResponsesFastMode,
  normalizeOpenAIServiceTier,
} from "../llm/providers/openai-fast-mode.js";
export type { ProviderFastModeCapabilityContext } from "../plugins/provider-fast-mode.types.js";
