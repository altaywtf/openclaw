import { createHash, randomUUID } from "node:crypto";
import { persistAuthProfileBatch } from "../agents/auth-profiles.js";
import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import {
  saveAuthProfileCandidates,
  type PendingAuthProfileSetup,
} from "../agents/auth-profiles/pending.js";
import { createMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isValidEnvSecretRefId, type SecretRef } from "../config/types.secrets.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import {
  deleteSecretStoreEntry,
  readSecretStoreValue,
  writeSecretStoreEntry,
} from "../secrets/store/secret-store.js";
import type { ProviderAuthProfile, ProviderAuthResult } from "./provider-authentication.types.js";

const STORE_SCOPE = { kind: "team" } as const;
const STORE_NAME_DIGEST_LENGTH = 24;

type StoreRollback = {
  name: string;
  previousValue?: string;
};

type PreparedProviderAuthProfiles = {
  profiles: ProviderAuthProfile[];
  rollback: () => void;
};

type PersistProviderAuthProfileBatchParams = Omit<
  Parameters<typeof persistAuthProfileBatch>[0],
  "profiles"
> & {
  profiles: readonly ProviderAuthProfile[];
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

export function buildPendingAuthProfileSetup(params: {
  baseConfig: OpenClawConfig;
  config: OpenClawConfig;
  modelRef: string;
  providerId: string;
  pluginId: string;
  authChoice: string;
}): PendingAuthProfileSetup {
  const patch = createMergePatch(params.baseConfig, params.config) as Partial<OpenClawConfig>;
  return {
    modelRef: params.modelRef,
    providerId: params.providerId,
    pluginId: params.pluginId,
    authChoice: params.authChoice,
    connectionPatch: {
      ...(patch.models ? { models: patch.models } : {}),
      ...(patch.plugins ? { plugins: patch.plugins } : {}),
    },
  };
}

export function prepareProviderAuthSetupResult(result: ProviderAuthResult): ProviderAuthResult {
  // Setup owns these immutable instance IDs. Re-login allocates a new ID;
  // deleted candidates are never recreated for retained probes or refreshes.
  const { auth: _auth, ...configPatch } = result.configPatch ?? {};
  return {
    ...result,
    ...(result.configPatch ? { configPatch } : {}),
    profiles: result.profiles.map((profile) => ({
      ...profile,
      profileId: buildAuthProfileId({
        providerId: profile.credential.provider,
        profileName: randomUUID(),
      }),
    })),
  };
}

export function persistProviderAuthSetupCandidates(params: {
  profiles: readonly ProviderAuthProfile[];
  baseConfig: OpenClawConfig;
  config: OpenClawConfig;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  setup: PendingAuthProfileSetup;
}): ProviderAuthProfile[] {
  const prepared = prepareProviderAuthProfilesForPersistence(params);
  try {
    saveAuthProfileCandidates({
      profiles: prepared.profiles,
      baseConfig: params.baseConfig,
      agentDir: params.agentDir,
      env: params.env,
      setup: params.setup,
    });
  } catch (error) {
    try {
      prepared.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Setup credential persistence failed and protected-store rollback could not be confirmed.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  return prepared.profiles;
}

function resolveStoreName(profile: ProviderAuthProfile): string {
  const storage = profile.secretStorage;
  if (!storage) {
    throw new Error("Provider auth profile does not request protected secret storage.");
  }
  const namePrefix = storage.namePrefix.trim();
  // Stable per final profile so relogin replaces one owned entry instead of accumulating
  // secrets; provider identity prevents different owners from sharing that entry.
  const digest = createHash("sha256")
    .update(profile.credential.provider)
    .update("\0")
    .update(profile.profileId)
    .digest("hex")
    .slice(0, STORE_NAME_DIGEST_LENGTH)
    .toUpperCase();
  const name = `${namePrefix}_${digest}`;
  if (!isValidEnvSecretRefId(name)) {
    throw new Error(
      "Provider auth secret-store name prefix must produce a valid environment-style name.",
    );
  }
  return name;
}

function buildStoredCredential(profile: ProviderAuthProfile, ref: SecretRef) {
  const credential = profile.credential;
  if (credential.type === "token" && typeof credential.token === "string") {
    const { token: _token, ...withoutToken } = credential;
    return { ...withoutToken, tokenRef: ref };
  }
  if (credential.type === "api_key" && typeof credential.key === "string") {
    const { key: _key, ...withoutKey } = credential;
    return { ...withoutKey, keyRef: ref };
  }
  throw new Error(
    `Provider auth profile "${profile.profileId}" requested protected storage without an inline static credential.`,
  );
}

function rollbackStoreWrites(
  writes: readonly StoreRollback[],
  database: { env: NodeJS.ProcessEnv } | undefined,
): void {
  const errors: unknown[] = [];
  for (const write of writes.toReversed()) {
    try {
      if (write.previousValue === undefined) {
        deleteSecretStoreEntry({ scope: STORE_SCOPE, name: write.name, database });
      } else {
        writeSecretStoreEntry({
          scope: STORE_SCOPE,
          name: write.name,
          value: write.previousValue,
          kind: "secret",
          updatedBy: "provider-auth-rollback",
          database,
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Could not confirm rollback of protected provider credentials; run openclaw doctor --fix before retrying.",
    );
  }
}

/** Materializes provider-minted static credentials only when their final persistence begins. */
export function prepareProviderAuthProfilesForPersistence(params: {
  profiles: readonly ProviderAuthProfile[];
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PreparedProviderAuthProfiles {
  const database = params.env ? { env: params.env } : undefined;
  const writes: StoreRollback[] = [];
  let rolledBack = false;
  const rollback = () => {
    if (rolledBack) {
      return;
    }
    rollbackStoreWrites(writes, database);
    rolledBack = true;
  };

  try {
    const profiles = params.profiles.map((profile): ProviderAuthProfile => {
      if (!profile.secretStorage) {
        return profile;
      }
      const name = resolveStoreName(profile);
      const existing = readSecretStoreValue({ scope: STORE_SCOPE, name, database });
      if (!existing.ok && existing.error.code !== "SECRET_STORE_NOT_FOUND") {
        throw new Error(
          "The protected secret store is unavailable. Check the OpenClaw state-directory permissions and retry; the auth profile was not changed.",
          { cause: existing.error },
        );
      }
      const credential = profile.credential;
      const value =
        credential.type === "token"
          ? credential.token
          : credential.type === "api_key"
            ? credential.key
            : undefined;
      if (typeof value !== "string") {
        throw new Error(
          `Provider auth profile "${profile.profileId}" requested protected storage without an inline static credential.`,
        );
      }
      registerSecretValueForRedaction(value);
      try {
        writeSecretStoreEntry({
          scope: STORE_SCOPE,
          name,
          value,
          kind: "secret",
          updatedBy: "provider-auth",
          database,
        });
      } catch (error) {
        throw new Error(
          "Could not write the protected secret store. Check the OpenClaw state-directory permissions and retry; the auth profile was not changed.",
          { cause: error },
        );
      }
      writes.push({ name, ...(existing.ok ? { previousValue: existing.value } : {}) });
      const ref: SecretRef = {
        source: "store",
        provider: resolveDefaultSecretProviderAlias(params.config, "store", {
          preferFirstProviderForSource: true,
        }),
        id: name,
      };
      const { secretStorage: _secretStorage, ...persistentProfile } = profile;
      return {
        ...persistentProfile,
        credential: buildStoredCredential(profile, ref),
      };
    });
    return { profiles, rollback };
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Provider credential persistence failed and protected-store rollback could not be confirmed.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

/** Persists a provider-auth batch and couples its rollback to protected-store materialization. */
export async function persistProviderAuthProfileBatch(
  params: PersistProviderAuthProfileBatchParams,
): Promise<{ profiles: ProviderAuthProfile[]; rollback: () => void }> {
  const env = params.stateDir
    ? { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir }
    : params.env;
  const prepared = prepareProviderAuthProfilesForPersistence({
    profiles: params.profiles,
    config: params.config,
    ...(env ? { env } : {}),
  });
  let persisted: Awaited<ReturnType<typeof persistAuthProfileBatch>>;
  try {
    persisted = await persistAuthProfileBatch({
      profiles: prepared.profiles,
      ...(params.order ? { order: params.order } : {}),
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    });
  } catch (error) {
    try {
      prepared.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Provider auth persistence failed and protected-store rollback could not be confirmed.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  let rolledBack = false;
  return {
    profiles: prepared.profiles,
    rollback: () => {
      if (rolledBack) {
        return;
      }
      let profileError: Error | undefined;
      try {
        persisted.rollback();
      } catch (error) {
        profileError = error instanceof Error ? error : new Error(String(error), { cause: error });
      }
      try {
        prepared.rollback();
      } catch (error) {
        if (profileError) {
          throw new AggregateError(
            [profileError, error],
            "Could not confirm rollback of provider auth profiles and protected credentials.",
            { cause: error },
          );
        }
        throw error;
      }
      if (profileError) {
        throw profileError;
      }
      rolledBack = true;
    },
  };
}
