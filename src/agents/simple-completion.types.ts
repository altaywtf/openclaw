import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { AgentHarnessIsolatedCompletionParamsV2 } from "./harness/types.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

export type PreparedSimpleCompletionModel =
  | {
      model: Model;
      auth: ResolvedProviderAuth;
      /** Non-reversible owner proof captured from the same auth snapshot. */
      sourceAuthFingerprint?: string;
    }
  | {
      error: string;
      cause?: unknown;
      auth?: ResolvedProviderAuth;
    };

export type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string;
  /** Shipped SDK return field; new selections carry canonical identity in provider. */
  runtimeProvider?: string;
  profileId?: string;
  agentDir: string;
};

export type PreparedSimpleCompletionModelForAgent =
  | (Extract<PreparedSimpleCompletionModel, { model: Model }> & {
      selection: AgentSimpleCompletionSelection;
    })
  | (Extract<PreparedSimpleCompletionModel, { error: string }> & {
      selection?: AgentSimpleCompletionSelection;
    });

export type PrepareSimpleCompletionModelForAgentParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  modelRef?: string;
  useUtilityModel?: boolean;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<ResolvedProviderAuth["mode"]>;
  allowBundledStaticCatalogFallback?: boolean;
  /** @deprecated no-op; kept for plugin-SDK source compatibility, remove at next SDK-breaking window. */
  useAsyncModelResolution?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  modelResolver?: SimpleCompletionModelResolver;
  signal?: AbortSignal;
};

export type PrepareSimpleCompletionModelParams = {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  provider: string;
  modelId: string;
  modelIdSource?: "input" | "selected";
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<ResolvedProviderAuth["mode"]>;
  allowBundledStaticCatalogFallback?: boolean;
  skipAgentDiscovery?: boolean;
  bindAuthOwner?: boolean;
  /** Internal caller-owned credential and route selection; do not rediscover auth. */
  preparedAuthPlan?: AgentRuntimeAuthPlan;
  /** Unlock caller-owned fallback only after credential resolution starts. */
  onAuthResolutionStarted?: () => void;
  modelResolver?: SimpleCompletionModelResolver;
  signal?: AbortSignal;
  /** Internal caller-owned generation. Public plugin callers use the agent helper below. */
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  workspaceDir?: string;
  agentRuntimeId?: string;
};

export type RunIsolatedCompletionParams = {
  config?: OpenClawConfig;
  provider: string;
  model: string;
  /** Explicit credential owner. CLI and harness paths must not replace it with another profile. */
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Concrete owner already resolved by the caller, when available. */
  agentHarnessRuntimeOverride?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** Revalidate the caller's authority before credential handoff and dispatch. */
  assertCurrent?: () => void;
  thinkLevel?: ThinkLevel;
  outputTextPolicy?: AgentHarnessIsolatedCompletionParamsV2["outputTextPolicy"];
  streamParams?: AgentHarnessIsolatedCompletionParamsV2["streamParams"];
};
