import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { resolveSecretRefString } from "../../secrets/resolve.js";
import { readSecretStoreValue } from "../../secrets/store/secret-store.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
  type AgentExecutionAuthBinding,
} from "../execution-auth-binding.js";
import { resolveProviderEnvAuthLookupMaps } from "../model-auth-env-vars.js";
import { resolveEnvApiKey } from "../model-auth-env.js";
import { getCustomProviderApiKey } from "../model-auth-provider-config.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { resolveExplicitAuthOrderSelection } from "./order.js";
import {
  buildPersistedAuthProfileSecretsStore,
  coercePersistedAuthProfileStore,
  loadPersistedAuthProfileStore,
  loadPersistedAuthProfileStoreAtDatabasePath,
  loadPersistedSharedAuthProfileStore,
} from "./persisted.js";
import { listProfilesForProvider, stripPendingAuthProfileProjection } from "./profile-list.js";
import { noteRuntimeAuthProfileStorePersistedMutation } from "./runtime-snapshots.js";
import {
  deferAuthProfilePostCommitPublication,
  deletePersistedAuthProfileStoreRaw,
  inspectPersistedAuthProfileStoreRaw,
  prepareAuthProfileReadOwner,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
  type AuthProfileDatabase,
  type PreparedAuthProfileStoreOwner,
} from "./sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStoreWithPreparedOwner,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

export type PendingAuthProfileSelection = {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  owner: PreparedAuthProfileStoreOwner;
};

export type PendingAuthProfileSetup = {
  modelRef: string;
  providerId: string;
  pluginId: string;
  authChoice: string;
  connectionPatch: Pick<OpenClawConfig, "models" | "plugins">;
};

type PendingAuthProfileStore = AuthProfileStore & {
  setup?: Record<string, PendingAuthProfileSetup>;
};

export type PendingAuthProfileProbe = {
  selection: PendingAuthProfileSelection;
  authFingerprint: string;
  resolvedCredential: AuthProfileCredential;
};

const pendingAuthProfileProbeScope = new AsyncLocalStorage<{
  selection: PendingAuthProfileSelection | undefined;
  isActive: () => boolean;
}>();

export async function withPendingAuthProfileProbe<T>(
  params: { profileId?: string; agentDir?: string; signal?: AbortSignal },
  run: () => Promise<T>,
): Promise<T> {
  const parent = pendingAuthProfileProbeScope.getStore();
  if (parent && !parent.isActive()) {
    throw new Error("The pending sign-in probe is no longer active.");
  }
  const selection = params.profileId
    ? resolvePendingAuthProfileSelection(params.profileId, params.agentDir)
    : undefined;
  let active = true;
  return await pendingAuthProfileProbeScope.run(
    {
      selection,
      isActive: () => active && !params.signal?.aborted && (!parent || parent.isActive()),
    },
    async () => {
      try {
        return await run();
      } finally {
        active = false;
      }
    },
  );
}

function assertPendingAuthProfileProbeAccess(selection: PendingAuthProfileSelection): void {
  const scope = pendingAuthProfileProbeScope.getStore();
  if (
    !scope?.isActive() ||
    scope.selection?.profileId !== selection.profileId ||
    scope.selection.owner.databasePath !== selection.owner.databasePath
  ) {
    throw new Error(
      "This saved sign-in is not available outside its active probe. Choose it in Model Setup to retry.",
    );
  }
}

export async function preparePendingAuthProfileProbe(params: {
  profileId: string;
  agentDir?: string;
  config: OpenClawConfig;
}): Promise<PendingAuthProfileProbe | undefined> {
  const pending = resolvePendingAuthProfileSelection(params.profileId, params.agentDir);
  if (!pending) {
    return undefined;
  }
  assertPendingAuthProfileProbeAccess(pending);
  const { resolveApiKeyForProfile } = await import("./oauth.js");
  const resolved = await resolveApiKeyForProfile({
    cfg: params.config,
    agentDir: params.agentDir,
    profileId: params.profileId,
    store: projectExplicitPendingAuthProfile(
      loadAuthProfileStoreWithoutExternalProfiles(params.agentDir),
      params.profileId,
      params.agentDir,
    ),
    allowProfileFallback: false,
  });
  const selection = resolvePendingAuthProfileSelection(params.profileId, params.agentDir);
  const credential = resolved?.credential;
  if (!resolved || !selection || !credential) {
    throw new Error("The pending sign-in could not prepare its exact credential for verification.");
  }
  const rawCredential = buildPersistedAuthProfileSecretsStore({
    version: AUTH_STORE_VERSION,
    profiles: { [params.profileId]: credential },
  }).profiles[params.profileId];
  const authFingerprint =
    credential.type === "oauth"
      ? fingerprintAuthProfileCredential({ profileId: params.profileId, credential })
      : fingerprintResolvedProviderAuth({
          apiKey: resolved.apiKey,
          profileId: params.profileId,
          source: `profile:${params.profileId}`,
          mode: credential.type === "api_key" ? "api-key" : "token",
        });
  if (
    !authFingerprint ||
    selection.owner.databasePath !== pending.owner.databasePath ||
    !isDeepStrictEqual(rawCredential, selection.credential)
  ) {
    throw new Error("The pending sign-in changed while preparing verification. Retry model setup.");
  }
  return {
    selection: { ...selection, credential: structuredClone(selection.credential) },
    authFingerprint,
    resolvedCredential: structuredClone(credential),
  };
}

export function loadPendingAuthProfileStore(
  agentDir?: string,
  database?: AuthProfileDatabase,
  env: NodeJS.ProcessEnv = process.env,
): PendingAuthProfileStore {
  const inspected = inspectPersistedAuthProfileStoreRaw(agentDir, database, "pending", env);
  if (inspected.status === "unreadable") {
    throw new Error(
      "Saved pending credentials could not be read. Run openclaw doctor before retrying.",
    );
  }
  if (inspected.status === "missing") {
    return { version: AUTH_STORE_VERSION, profiles: {} };
  }
  const raw = inspected.raw;
  const store = coercePersistedAuthProfileStore(raw);
  if (!store) {
    throw new Error("Saved pending credentials are invalid. Run openclaw doctor before retrying.");
  }
  if (!isRecord(raw) || raw.setup === undefined) {
    return store;
  }
  if (!isRecord(raw.setup)) {
    throw new Error(
      "Saved sign-in setup metadata is invalid. Run openclaw doctor before retrying.",
    );
  }
  const setup: Record<string, PendingAuthProfileSetup> = {};
  for (const [profileId, entry] of Object.entries(raw.setup)) {
    if (
      !store.profiles[profileId] ||
      !isRecord(entry) ||
      typeof entry.modelRef !== "string" ||
      typeof entry.providerId !== "string" ||
      typeof entry.pluginId !== "string" ||
      typeof entry.authChoice !== "string" ||
      !isRecord(entry.connectionPatch) ||
      Object.keys(entry.connectionPatch).some((key) => key !== "models" && key !== "plugins")
    ) {
      throw new Error(
        "Saved sign-in setup metadata is invalid. Run openclaw doctor before retrying.",
      );
    }
    setup[profileId] = {
      modelRef: entry.modelRef,
      providerId: entry.providerId,
      pluginId: entry.pluginId,
      authChoice: entry.authChoice,
      connectionPatch: entry.connectionPatch as Pick<OpenClawConfig, "models" | "plugins">,
    };
  }
  return { ...store, setup };
}

function savePendingAuthProfileStore(
  store: PendingAuthProfileStore,
  agentDir: string | undefined,
  database: AuthProfileDatabase,
  owner: PreparedAuthProfileStoreOwner,
  profileIds: string[],
): void {
  if (Object.keys(store.profiles).length === 0) {
    deletePersistedAuthProfileStoreRaw(agentDir, database, "pending");
  } else {
    writePersistedAuthProfileStoreRaw(
      {
        ...buildPersistedAuthProfileSecretsStore(store),
        ...(store.setup ? { setup: store.setup } : {}),
      },
      agentDir,
      database,
      "pending",
    );
  }
  const publish = () =>
    noteRuntimeAuthProfileStorePersistedMutation(
      agentDir,
      { credentialsChanged: true, profileSetChanged: true, stateChanged: false, profileIds },
      owner,
    );
  if (!deferAuthProfilePostCommitPublication(database, publish)) {
    publish();
  }
}

export function saveAuthProfileCandidates(params: {
  profiles: readonly { profileId: string; credential: AuthProfileCredential }[];
  baseConfig: OpenClawConfig;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  setup: PendingAuthProfileSetup;
}): void {
  const env = params.env ?? process.env;
  const authContext = {
    config: params.baseConfig,
    env,
    metadataSnapshot: resolvePluginMetadataSnapshot({ config: params.baseConfig, env }),
  };
  const authProviderId = (provider: string) => resolveProviderIdForAuth(provider, authContext);
  const { aliasMap, envCandidateMap, authEvidenceMap } =
    resolveProviderEnvAuthLookupMaps(authContext);
  const connectedProviders = new Set(
    Object.keys(params.baseConfig.models?.providers ?? {})
      .filter((provider) => getCustomProviderApiKey(params.baseConfig, provider))
      .map(authProviderId),
  );
  for (const { credential } of params.profiles) {
    if (
      resolveEnvApiKey(authProviderId(credential.provider), env, {
        config: params.baseConfig,
        aliasMap,
        candidateMap: envCandidateMap,
        authEvidenceMap,
      })
    ) {
      connectedProviders.add(authProviderId(credential.provider));
    }
  }
  const readOwner = prepareAuthProfileReadOwner(params.agentDir, env);
  const shared = loadPersistedSharedAuthProfileStore(readOwner.env);
  const local = loadPersistedAuthProfileStoreAtDatabasePath(
    readOwner.databasePath,
    params.agentDir || readOwner.location !== "state-db" ? "agent" : "shared-state",
  );
  const effectiveProfiles = { ...shared?.profiles, ...local?.profiles };
  const profiles = params.profiles.map((profile) => ({
    ...profile,
    credential: normalizeAuthProfileCredential(profile.credential),
  }));
  runAuthProfileWriteTransaction(
    params.agentDir,
    (database, owner) => {
      const ownerDir = "agentId" in database ? params.agentDir : undefined;
      const active: AuthProfileStore = loadPersistedAuthProfileStore(ownerDir, { database }) ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      const pending = loadPendingAuthProfileStore(ownerDir, database);
      for (const credential of Object.values({ ...effectiveProfiles, ...active.profiles })) {
        connectedProviders.add(authProviderId(credential.provider));
      }
      let activeChanged = false;
      const pendingIds: string[] = [];
      for (const { profileId, credential } of profiles) {
        if (active.profiles[profileId] || pending.profiles[profileId]) {
          throw new Error("The saved credential identity already exists. Start a new sign-in.");
        }
        if (connectedProviders.has(authProviderId(credential.provider))) {
          pending.profiles[profileId] = credential;
          pending.setup = { ...pending.setup, [profileId]: params.setup };
          pendingIds.push(profileId);
        } else {
          active.profiles[profileId] = credential;
          activeChanged = true;
        }
      }
      if (activeChanged) {
        saveAuthProfileStoreWithPreparedOwner(
          active,
          ownerDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
          database,
          owner,
        );
      }
      if (pendingIds.length > 0) {
        savePendingAuthProfileStore(pending, ownerDir, database, owner, pendingIds);
      }
    },
    { sharedStoreWrite: true, env: params.env },
  );
}

export function resolvePendingAuthProfileSelection(
  profileId: string,
  agentDir?: string,
): PendingAuthProfileSelection | undefined {
  const env = { ...process.env };
  const visited = new Set<string>();
  for (const ownerDir of [agentDir, undefined]) {
    const owner = prepareAuthProfileReadOwner(ownerDir, env);
    if (visited.has(owner.databasePath)) {
      continue;
    }
    visited.add(owner.databasePath);
    const credential = loadPendingAuthProfileStore(ownerDir, undefined, env).profiles[profileId];
    if (credential) {
      const secrets =
        credential.type === "oauth"
          ? [credential.access, credential.refresh, credential.idToken]
          : credential.type === "api_key"
            ? [credential.key]
            : [credential.token];
      for (const secret of secrets) {
        if (secret) {
          registerSecretValueForRedaction(secret);
        }
      }
      return {
        profileId,
        credential,
        agentDir: ownerDir,
        owner,
      };
    }
  }
  return undefined;
}

export function projectExplicitPendingAuthProfile(
  store: AuthProfileStore,
  profileId: string | undefined,
  agentDir?: string,
): AuthProfileStore {
  const active = stripPendingAuthProfileProjection(store);
  const scope = pendingAuthProfileProbeScope.getStore();
  if (
    !profileId ||
    active.profiles[profileId] ||
    !scope?.isActive() ||
    scope.selection?.profileId !== profileId
  ) {
    return active;
  }
  const pending = resolvePendingAuthProfileSelection(profileId, agentDir);
  if (pending) {
    assertPendingAuthProfileProbeAccess(pending);
  }
  return pending
    ? {
        ...active,
        profiles: { ...active.profiles, [profileId]: pending.credential },
        runtimePendingProfileIds: [profileId],
      }
    : active;
}

export function updatePendingAuthProfile(
  selection: PendingAuthProfileSelection,
  update: (store: AuthProfileStore) => boolean,
): AuthProfileStore {
  return runAuthProfileWriteTransaction(
    selection.agentDir,
    (database, owner) => {
      assertPendingAuthProfileProbeAccess(selection);
      if (database.path !== selection.owner.databasePath) {
        throw new Error("Pending credential belongs to another auth-store owner.");
      }
      const store = loadPendingAuthProfileStore(selection.agentDir, database);
      if (!store.profiles[selection.profileId]) {
        throw new Error("The pending sign-in is no longer available.");
      }
      if (update(store)) {
        savePendingAuthProfileStore(store, selection.agentDir, database, owner, [
          selection.profileId,
        ]);
      }
      return store;
    },
    { env: selection.owner.env },
  );
}

export function assertPendingAuthProfileCurrent(
  selection: PendingAuthProfileSelection,
  expected: AuthProfileCredential,
): void {
  assertPendingAuthProfileProbeAccess(selection);
  const owner = prepareAuthProfileReadOwner(selection.agentDir, selection.owner.env);
  if (owner.databasePath !== selection.owner.databasePath) {
    throw new Error("Pending credential belongs to another auth-store owner.");
  }
  const current = loadPendingAuthProfileStore(selection.agentDir, undefined, selection.owner.env)
    .profiles[selection.profileId];
  if (!current) {
    throw new Error("The pending sign-in is no longer available.");
  }
  if (!isDeepStrictEqual(current, expected)) {
    throw new Error("The pending sign-in changed while resolving credentials. Retry verification.");
  }
}

type VerifiedPendingAuthProfile = {
  proof: PendingAuthProfileProbe;
  verifiedAuth: AgentExecutionAuthBinding;
  config?: OpenClawConfig;
};

export async function validatePendingAuthProfileProbe(
  params: VerifiedPendingAuthProfile,
): Promise<void> {
  const { selection } = params.proof;
  const profileId = selection.profileId;
  if (
    params.verifiedAuth.authProfileId !== profileId ||
    params.verifiedAuth.authFingerprint !== params.proof.authFingerprint
  ) {
    throw new Error(
      "The model did not verify the saved replacement credential. Sign-in remains pending.",
    );
  }
  const assertCurrent = () => {
    const owner = prepareAuthProfileReadOwner(selection.agentDir, selection.owner.env);
    if (owner.databasePath !== selection.owner.databasePath) {
      throw new Error("Pending credential belongs to another auth-store owner.");
    }
    const current = loadPendingAuthProfileStore(selection.agentDir, undefined, selection.owner.env)
      .profiles[profileId];
    if (!current || !isDeepStrictEqual(current, selection.credential)) {
      throw new Error("The verified sign-in changed before activation. Verify it again.");
    }
  };
  assertCurrent();
  const credential = selection.credential;
  const ref =
    credential.type === "api_key"
      ? credential.keyRef
      : credential.type === "token"
        ? credential.tokenRef
        : undefined;
  if (ref) {
    const current = await resolveSecretRefString(ref, {
      config: params.config ?? {},
      env: ref.source === "store" ? selection.owner.env : process.env,
    });
    const resolved = params.proof.resolvedCredential;
    const expected =
      resolved.type === "api_key"
        ? resolved.key
        : resolved.type === "token"
          ? resolved.token
          : undefined;
    if (current !== expected) {
      throw new Error("The verified credential changed. Verify the saved sign-in again.");
    }
    assertCurrent();
  }
}

export async function promotePendingAuthProfile(
  params: VerifiedPendingAuthProfile & { beforeCommit?: () => void },
): Promise<boolean> {
  await validatePendingAuthProfileProbe(params);
  const { selection } = params.proof;
  const profileId = selection.profileId;
  const effective = loadAuthProfileStoreWithoutExternalProfiles(selection.agentDir);
  const providerKey = normalizeProviderId(selection.credential.provider);
  const providerAuthKey = resolveProviderIdForAuth(providerKey, {
    config: params.config,
    env: selection.owner.env,
  });
  return runAuthProfileWriteTransaction(
    selection.agentDir,
    (database, owner) => {
      if (database.path !== selection.owner.databasePath) {
        throw new Error("Pending credential belongs to another auth-store owner.");
      }
      const pending = loadPendingAuthProfileStore(selection.agentDir, database);
      const credential = pending.profiles[profileId];
      if (!credential || !isDeepStrictEqual(credential, selection.credential)) {
        throw new Error("The verified sign-in changed before activation. Verify it again.");
      }
      const ref =
        credential.type === "api_key"
          ? credential.keyRef
          : credential.type === "token"
            ? credential.tokenRef
            : undefined;
      if (ref?.source === "store") {
        const storedSecret = readSecretStoreValue({
          scope: { kind: "team" },
          name: ref.id,
          database: { env: selection.owner.env },
        });
        const resolved = params.proof.resolvedCredential;
        const expected =
          resolved.type === "api_key"
            ? resolved.key
            : resolved.type === "token"
              ? resolved.token
              : undefined;
        if (!storedSecret.ok || storedSecret.value !== expected) {
          throw new Error(
            "The verified protected credential changed. Verify the saved sign-in again.",
          );
        }
      }
      const active: AuthProfileStore = loadPersistedAuthProfileStore(selection.agentDir, {
        database,
      }) ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      if (active.profiles[profileId]) {
        throw new Error("The verified sign-in identity is already active. Review model setup.");
      }
      active.profiles[profileId] = credential;
      const explicit = resolveExplicitAuthOrderSelection({
        storeOrder: active.order ?? effective.order,
        configuredOrder: params.config?.auth?.order,
        providerKey,
        providerAuthKey,
      }).order;
      const order = explicit ? [...new Set([...explicit, profileId])] : undefined;
      if (order) {
        active.order = { ...active.order, [providerAuthKey]: order };
      }
      params.beforeCommit?.();
      saveAuthProfileStoreWithPreparedOwner(
        active,
        selection.agentDir,
        {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
          ...(order ? { preserveOrderProfileIds: order } : {}),
        },
        database,
        owner,
      );
      delete pending.profiles[profileId];
      if (pending.setup) {
        delete pending.setup[profileId];
      }
      savePendingAuthProfileStore(pending, selection.agentDir, database, owner, [profileId]);
      return true;
    },
    { env: selection.owner.env },
  );
}

export function listPendingAuthProfileSetups(
  agentDir?: string,
): Array<{ profileId: string; setup: PendingAuthProfileSetup }> {
  const entries = new Map<string, PendingAuthProfileSetup>();
  for (const ownerDir of [undefined, agentDir]) {
    const store = loadPendingAuthProfileStore(ownerDir);
    for (const [profileId, setup] of Object.entries(store.setup ?? {})) {
      entries.set(profileId, setup);
    }
  }
  return [...entries].map(([profileId, setup]) => ({ profileId, setup }));
}

export function removePendingAuthProfiles(params: {
  agentDir?: string;
  provider?: string;
  profileIds?: readonly string[];
}): void {
  const owner = prepareAuthProfileReadOwner(params.agentDir);
  const store = loadPendingAuthProfileStore(params.agentDir);
  const removed = (
    params.provider === undefined
      ? Object.keys(store.profiles)
      : listProfilesForProvider(store, params.provider)
  ).filter((profileId) => params.profileIds === undefined || params.profileIds.includes(profileId));
  if (removed.length === 0) {
    return;
  }
  runAuthProfileWriteTransaction(
    params.agentDir,
    (database, currentOwner) => {
      if (database.path !== owner.databasePath) {
        throw new Error("Pending credential belongs to another auth-store owner.");
      }
      const current = loadPendingAuthProfileStore(params.agentDir, database);
      for (const profileId of removed) {
        delete current.profiles[profileId];
        if (current.setup) {
          delete current.setup[profileId];
        }
      }
      savePendingAuthProfileStore(current, params.agentDir, database, currentOwner, removed);
    },
    { env: owner.env },
  );
}
