/** Command for removing one saved model auth profile. */
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
} from "../../agents/auth-profiles.js";
import { resolvePendingAuthProfileSelection } from "../../agents/auth-profiles/pending.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth-provider-config.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  configReferencesAuthProfile,
  removeAuthProfileConfig,
} from "../../plugins/provider-auth-helpers.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent, updateConfig } from "./shared.js";

export async function removeModelAuthCredentials(params: {
  config: OpenClawConfig;
  agentDir: string;
  profileIds: readonly string[];
  apiKeyProvider?: string;
  provider?: string;
}): Promise<void> {
  const owner =
    params.apiKeyProvider === undefined
      ? undefined
      : resolveProviderIdForAuth(params.apiKeyProvider, { config: params.config });
  const configuredKeys = Object.keys(params.config.models?.providers ?? {}).filter(
    (provider) =>
      owner !== undefined &&
      resolveProviderIdForAuth(provider, { config: params.config }) === owner,
  );
  if (
    configuredKeys.some(
      (provider) => params.config.models?.providers?.[provider]?.apiKey !== undefined,
    ) ||
    params.profileIds.some((profileId) => configReferencesAuthProfile(params.config, profileId))
  ) {
    await updateConfig((current) => {
      let next = current;
      for (const profileId of params.profileIds) {
        next = removeAuthProfileConfig(next, profileId);
      }
      if (configuredKeys.length > 0 && next.models?.providers) {
        const store = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir);
        const providers = { ...next.models.providers };
        for (const provider of configuredKeys) {
          const entry = providers[provider];
          if (
            entry &&
            resolveProviderEntryApiKeyProfileReference({ cfg: next, provider, store }).kind ===
              "literal"
          ) {
            const { apiKey: _removed, ...rest } = entry;
            providers[provider] = rest;
          }
        }
        next = { ...next, models: { ...next.models, providers } };
      }
      return next;
    });
  }
  if (!(await removeAuthProfilesAcrossOwnerStores(params))) {
    throw new Error("Saved credentials could not be removed. Wait a moment and retry.");
  }
}

/** Removes a saved auth profile from the agent auth store and from config. */
export async function modelsAuthLogoutCommand(
  opts: { profileId: string; agent?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  const profileId = opts.profileId?.trim();
  if (!profileId) {
    throw new Error(
      `Missing profile id. Run ${formatCliCommand("openclaw models auth list")} to see saved profile ids.`,
    );
  }

  const cfg = await loadModelsConfig({ commandName: "models auth logout", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, { kind: "mutation" });
  // External CLI overlays (Claude/Codex CLI) are not ours to delete, so the
  // removable set is exactly the persisted store.
  const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
  const credential =
    store.profiles[profileId] ??
    resolvePendingAuthProfileSelection(profileId, agentDir)?.credential;
  if (!credential) {
    throw new Error(
      `Auth profile "${profileId}" not found for agent "${agentId}". Run ${formatCliCommand(`openclaw models auth list --agent ${agentId}`)} to see saved profile ids.`,
    );
  }

  const description = `${profileId} (${credential.provider}/${credential.type})`;
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Refusing to remove auth profile ${description} without confirmation. Pass --yes to remove it non-interactively.`,
      );
    }
    const proceed = await createClackPrompter().confirm({
      message: `Remove auth profile ${description} from agent ${agentId}?`,
      initialValue: false,
    });
    if (!proceed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  // Config first: `auth.profiles`/`auth.order` are a separate surface from the
  // store, and a failed config write after the credential is gone would leave a
  // dangling reference that logout can no longer repair (the profile lookup
  // above would then fail). This order makes a partial failure retryable.
  await removeModelAuthCredentials({ config: cfg, agentDir, profileIds: [profileId] });
  if (configReferencesAuthProfile(cfg, profileId)) {
    logConfigUpdated(runtime);
  }

  await refreshRunningGatewayAuthState(agentId, "logout");

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Removed auth profile: ${description}`);
  const remaining = listProfilesForProvider(store, credential.provider).filter(
    (id) => id !== profileId,
  );
  if (remaining.length === 0) {
    runtime.log(
      `No auth profiles remain for ${credential.provider}. Run ${formatCliCommand(`openclaw models auth login --provider ${credential.provider}`)} to sign in again.`,
    );
  }
}
