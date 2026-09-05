import { isDeepStrictEqual } from "node:util";
import { resolveMutableAgentEntry } from "../../agents/agent-scope-config.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import {
  AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH,
  resolveConfiguredModelPolicyAllow,
} from "../../agents/model-selection-shared.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import { parseModelPolicyWildcardRef } from "../../config/model-policy-ref.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "../../wizard/prompts.js";
import { loadValidConfigOrThrow, resolveModelsTargetAgent, updateConfig } from "./shared.js";

export type ProviderModelAccessChoice = "all" | "keep";
export type ProviderModelAccessResult = "enabled" | "already-visible" | "restricted" | "failed";
export type ProviderModelAccessDecision = {
  choice: ProviderModelAccessChoice | undefined;
  policy: ReturnType<typeof snapshotProviderModelPolicy>;
};

function snapshotProviderModelPolicy(
  policy: ReturnType<typeof resolveConfiguredModelPolicyAllow>,
  agentId: string,
) {
  const refs = policy.refs.map(
    (ref) => parseModelPolicyWildcardRef(ref)?.key ?? normalizeAgentModelRefForConfig(ref),
  );
  return {
    configPath: policy.configPath,
    agentId: policy.configPath === AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH ? agentId : undefined,
    refs: [...new Set(refs)].toSorted(),
  };
}

function providerModelPolicyNeedsUpdate(
  policy: ReturnType<typeof resolveConfiguredModelPolicyAllow>,
  provider: string,
): boolean {
  return (
    policy.refs.length > 0 &&
    !policy.refs.some((entry) => parseModelPolicyWildcardRef(entry)?.key === `${provider}/*`)
  );
}

export function prepareProviderModelAccessChoice(params: {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
  providerLabel: string;
}): WizardSelectParams<ProviderModelAccessChoice> | undefined {
  const provider = normalizeProviderId(params.provider);
  const policy = resolveConfiguredModelPolicyAllow({ cfg: params.config, agentId: params.agentId });
  if (!providerModelPolicyNeedsUpdate(policy, provider)) {
    return undefined;
  }
  return {
    message: `Your current model restrictions may hide ${params.providerLabel} models. What should happen after sign-in?`,
    initialValue: "keep",
    options: [
      { value: "all", label: `Show all ${params.providerLabel} models` },
      { value: "keep", label: "Keep current restrictions" },
    ],
  };
}

export async function chooseProviderModelAccess(
  params: Parameters<typeof prepareProviderModelAccessChoice>[0] & {
    prompter: WizardPrompter;
    choice?: ProviderModelAccessChoice;
  },
): Promise<ProviderModelAccessDecision> {
  const policy = snapshotProviderModelPolicy(
    resolveConfiguredModelPolicyAllow({ cfg: params.config, agentId: params.agentId }),
    params.agentId,
  );
  const prompt = prepareProviderModelAccessChoice(params);
  return {
    choice: prompt ? (params.choice ?? (await params.prompter.select(prompt))) : undefined,
    policy,
  };
}

function appendProviderModelPolicy(params: {
  config: OpenClawConfig;
  agentId: string;
  provider: string;
  decision: ProviderModelAccessDecision;
}): boolean {
  resolveModelsTargetAgent(params.config, params.agentId, { kind: "mutation" });
  const provider = normalizeProviderId(params.provider);
  const policy = resolveConfiguredModelPolicyAllow({ cfg: params.config, agentId: params.agentId });
  const currentPolicy = snapshotProviderModelPolicy(policy, params.agentId);
  if (!isDeepStrictEqual(currentPolicy, params.decision.policy)) {
    throw new Error("The model restriction changed during sign-in. Choose model access again.");
  }
  if (!providerModelPolicyNeedsUpdate(policy, provider)) {
    return false;
  }
  const allow = [...policy.refs, `${provider}/*`];
  if (policy.configPath === AGENT_MODEL_POLICY_ALLOW_CONFIG_PATH) {
    const entry = resolveMutableAgentEntry(params.config, params.agentId);
    if (!entry) {
      throw new Error(`Agent "${params.agentId}" no longer exists in the current config.`);
    }
    entry.modelPolicy = { ...entry.modelPolicy, allow };
    return true;
  }
  params.config.agents ??= {};
  params.config.agents.defaults ??= {};
  params.config.agents.defaults.modelPolicy = {
    ...params.config.agents.defaults.modelPolicy,
    allow,
  };
  return true;
}

export async function adoptProviderModelPolicy(params: {
  provider: string;
  agentId: string;
  runtime: RuntimeEnv;
  decision: ProviderModelAccessDecision;
}): Promise<ProviderModelAccessResult> {
  try {
    const current = await loadValidConfigOrThrow();
    resolveModelsTargetAgent(current, params.agentId, { kind: "mutation" });
    const provider = normalizeProviderId(params.provider);
    const policy = resolveConfiguredModelPolicyAllow({ cfg: current, agentId: params.agentId });
    if (!providerModelPolicyNeedsUpdate(policy, provider)) {
      return "already-visible";
    }
    if (params.decision.choice !== "all") {
      return "restricted";
    }
    let changed = false;
    const application = createRuntimeConfigWriteApplication(
      captureGatewayRootWorkAdmissionContinuationScope()?.run,
    );
    await updateConfig(
      (config) => {
        changed = appendProviderModelPolicy({ ...params, config });
        return config;
      },
      { writeOptions: attachRuntimeConfigWriteApplication({}, application) },
    );
    if (changed) {
      if (application.claimed && (await application.result) !== "applied") {
        throw new Error("the running Gateway did not apply the saved model policy");
      }
      logConfigUpdated(params.runtime);
      return "enabled";
    }
    return "already-visible";
  } catch (error) {
    params.runtime.error(
      `Provider sign-in succeeded, but model access could not be updated: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}
