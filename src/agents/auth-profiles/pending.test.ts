import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { persistProviderAuthSetupCandidates } from "../../plugins/provider-auth-persistence.js";
import * as setupRegistry from "../../plugins/setup-registry.js";
import * as secretResolver from "../../secrets/resolve.js";
import { withSecureTestNodeCommand } from "../../secrets/test-node-command.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  resolveEnvApiKey,
  resolveProviderDirectAuthPlanningEvidence,
  resolveProviderEnvAuthEvidence,
} from "../model-auth-env.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { createOAuthManager } from "./oauth-manager.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { resolveAuthProfileOrder } from "./order.js";
import {
  loadPendingAuthProfileStore,
  preparePendingAuthProfileProbe,
  projectExplicitPendingAuthProfile,
  promotePendingAuthProfile,
  removePendingAuthProfiles,
  resolvePendingAuthProfileSelection,
  saveAuthProfileCandidates,
  updatePendingAuthProfile,
  withPendingAuthProfileProbe,
  type PendingAuthProfileSetup,
} from "./pending.js";
import { buildPersistedAuthProfileSecretsStore, mergeAuthProfileStores } from "./persisted.js";
import { buildPortableAuthProfileStoreForAgentCopy } from "./portability.js";
import {
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
} from "./profiles.js";
import {
  closeAuthProfileReadPool,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import {
  clearRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const priorId = "fixture:working";
const candidateId = "fixture:candidate";
const setup: PendingAuthProfileSetup = {
  modelRef: "fixture/model",
  providerId: "fixture",
  pluginId: "fixture",
  authChoice: "fixture-login",
  connectionPatch: {},
};
const prior: AuthProfileCredential = {
  type: "api_key",
  provider: "fixture",
  key: "fixture-working-key",
};
const candidate: AuthProfileCredential = {
  type: "api_key",
  provider: "fixture",
  key: "fixture-candidate-key",
};

async function withStore(
  agentId: "main" | "work",
  run: (agentDir: string) => Promise<void>,
): Promise<void> {
  const root = tempDirs.make("openclaw-pending-auth-");
  const agentDir = path.join(root, "agents", agentId, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  await withEnvAsync(
    {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    },
    async () => {
      try {
        await persistAuthProfileBatch({
          agentDir,
          stateDir: root,
          profiles: [{ profileId: priorId, credential: prior }],
        });
        await run(agentDir);
      } finally {
        clearRuntimeAuthProfileStoreSnapshot(agentDir);
        clearRuntimeAuthProfileStoreSnapshot();
        closeAuthProfileReadPool({ kind: "root", rootPath: root });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
}

describe("reserved pending credential ownership", () => {
  it.each(
    (["env", "file", "exec"] as const).flatMap((source) =>
      [false, true].map((rotate) => ({ source, rotate })),
    ),
  )(
    "rechecks $source reference values before promotion (rotate=$rotate)",
    async ({ source, rotate }) =>
      withSecureTestNodeCommand((command) =>
        withStore("main", async (agentDir) => {
          const originalKey = "fixture-verified-reference-key";
          const replacementKey = "fixture-rotated-reference-key";
          const secretPath = path.join(path.dirname(agentDir), "pending-reference.json");
          fs.writeFileSync(secretPath, JSON.stringify({ key: originalKey }), { mode: 0o600 });
          const config: OpenClawConfig =
            source === "env"
              ? {}
              : {
                  secrets: {
                    providers: {
                      fixture:
                        source === "file"
                          ? { source: "file", path: secretPath, mode: "json" }
                          : {
                              source: "exec",
                              command,
                              args: [
                                "-e",
                                'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).key)',
                                secretPath,
                              ],
                              jsonOnly: false,
                            },
                    },
                  },
                };
          const keyRef: SecretRef = {
            source,
            provider: source === "env" ? "default" : "fixture",
            id: source === "env" ? "FIXTURE_PENDING_KEY" : source === "file" ? "/key" : "key",
          };
          await withEnvAsync({ FIXTURE_PENDING_KEY: originalKey }, async () => {
            saveAuthProfileCandidates({
              baseConfig: config,
              profiles: [
                {
                  profileId: candidateId,
                  credential: { type: "api_key", provider: "fixture", keyRef },
                },
              ],
              agentDir,
              setup,
            });
            const proof = await withPendingAuthProfileProbe(
              { profileId: candidateId, agentDir },
              () => preparePendingAuthProfileProbe({ profileId: candidateId, agentDir, config }),
            );
            if (!proof) {
              throw new Error("The pending reference did not prepare a verification proof.");
            }
            expect(proof.resolvedCredential).toMatchObject({ key: originalKey });
            await withEnvAsync(
              { FIXTURE_PENDING_KEY: rotate ? replacementKey : originalKey },
              async () => {
                if (rotate) {
                  fs.writeFileSync(secretPath, JSON.stringify({ key: replacementKey }), {
                    mode: 0o600,
                  });
                }
                const promotion = Promise.resolve().then(() =>
                  promotePendingAuthProfile({
                    proof,
                    verifiedAuth: {
                      authProfileId: candidateId,
                      authFingerprint: proof.authFingerprint,
                    },
                    config,
                  }),
                );
                if (rotate) {
                  await expect(promotion).rejects.toThrow();
                } else {
                  await expect(promotion).resolves.toBe(true);
                }
                const active = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
                expect(active.profiles[priorId]).toEqual(prior);
                expect(active.profiles[candidateId]).toEqual(
                  rotate ? undefined : proof.selection.credential,
                );
                expect(loadPendingAuthProfileStore().profiles[candidateId]).toEqual(
                  rotate ? proof.selection.credential : undefined,
                );
              },
            );
          });
        }),
      ),
  );

  it.each([true, false])(
    "classifies setup-provider auth by an actual credential (present=%s)",
    async (present) =>
      withStore("main", async (agentDir) => {
        const provider = "setup-fallback-fixture";
        const profileId = `${provider}:replacement`;
        const credential = { ...candidate, provider };
        const baseConfig: OpenClawConfig = {};
        const snapshot = createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: provider,
              origin: "global",
              providers: [provider],
              setup: { requiresRuntime: true, providers: [{ id: provider }] },
            },
          ],
        });
        vi.spyOn(setupRegistry, "resolvePluginSetupProviderCore").mockImplementation((params) =>
          params.provider === provider
            ? {
                id: provider,
                label: "Setup fallback fixture",
                auth: [],
                resolveConfigApiKey: () => (present ? "fixture-existing-setup-key" : undefined),
              }
            : undefined,
        );
        withPluginMetadataSnapshotScope(
          snapshot,
          () => {
            expect(
              resolveProviderDirectAuthPlanningEvidence(provider, process.env, {
                config: baseConfig,
              }),
            ).toMatchObject({ kind: "setup-provider" });
            expect(resolveEnvApiKey(provider, process.env, { config: baseConfig })).toEqual(
              present ? { apiKey: "fixture-existing-setup-key", source: "env" } : null,
            );
            const before = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
            persistProviderAuthSetupCandidates({
              baseConfig,
              config: baseConfig,
              profiles: [{ profileId, credential }],
              agentDir,
              setup: { ...setup, providerId: provider, pluginId: provider },
            });
            const after = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
            const pending = loadPendingAuthProfileStore();
            expect(after.profiles).toEqual({
              ...before.profiles,
              ...(present ? {} : { [profileId]: credential }),
            });
            expect(pending.profiles[profileId]).toEqual(present ? credential : undefined);
          },
          { trustConfigIdentity: true },
        );
      }),
  );

  it.each(["environment", "alias-config", "alias-profile-stored", "alias-profile-configured"])(
    "keeps a replacement pending for pre-existing %s auth",
    async (source) =>
      withStore("main", async (agentDir) => {
        await withEnvAsync(
          {
            MOONSHOT_API_KEY: source === "environment" ? "fixture-existing-env-key" : undefined,
            KIMI_API_KEY: undefined,
          },
          async () => {
            const provider = "moonshot";
            const alias = "moonshotai";
            const existingId = `${provider}:working`;
            const replacementId = `${alias}:replacement`;
            const existing = { ...prior, provider };
            const replacement = { ...candidate, provider: alias };
            const hasProfile = source.startsWith("alias-profile");
            const baseConfig: OpenClawConfig = {
              ...(source === "alias-profile-configured"
                ? { auth: { order: { [provider]: [existingId] } } }
                : {}),
              ...(source === "alias-config"
                ? {
                    models: {
                      providers: {
                        [provider]: {
                          api: "openai-completions",
                          baseUrl: "https://existing.example.invalid/v1",
                          apiKey: "fixture-existing-config-key",
                          models: [],
                        },
                      },
                    },
                  }
                : {}),
            };
            expect(resolveProviderIdForAuth(alias, { config: baseConfig })).toBe(provider);
            if (source === "environment") {
              expect(
                resolveProviderEnvAuthEvidence(alias, process.env, { config: baseConfig }),
              ).toMatchObject({ source: "env: MOONSHOT_API_KEY" });
            }
            if (hasProfile) {
              await persistAuthProfileBatch({
                agentDir,
                profiles: [{ profileId: existingId, credential: existing }],
                ...(source === "alias-profile-stored"
                  ? { order: { [provider]: [existingId] } }
                  : {}),
              });
            }
            const before = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
            const persistence = {
              profiles: [{ profileId: replacementId, credential: replacement }],
              baseConfig,
              config: baseConfig,
              agentDir,
              setup: {
                ...setup,
                providerId: alias,
                pluginId: provider,
                modelRef: `${alias}/fixture-model`,
              },
            };
            persistProviderAuthSetupCandidates(persistence);
            expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual(
              before.profiles,
            );
            expect(loadPendingAuthProfileStore().profiles[replacementId]).toEqual(replacement);
            if (!hasProfile) {
              return;
            }
            expect(resolveAuthProfileOrder({ cfg: baseConfig, provider, store: before })).toEqual([
              existingId,
            ]);
            const proof = await withPendingAuthProfileProbe(
              { profileId: replacementId, agentDir },
              () =>
                preparePendingAuthProfileProbe({
                  profileId: replacementId,
                  agentDir,
                  config: baseConfig,
                }),
            );
            if (!proof) {
              throw new Error("The alias replacement did not prepare a verification proof.");
            }
            await promotePendingAuthProfile({
              proof,
              verifiedAuth: {
                authProfileId: replacementId,
                authFingerprint: proof.authFingerprint,
              },
              config: baseConfig,
            });
            const promoted = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
            expect(promoted.profiles[existingId]).toEqual(existing);
            expect(promoted.order?.[provider]).toEqual([existingId, replacementId]);
            expect(resolveAuthProfileOrder({ cfg: baseConfig, provider, store: promoted })).toEqual(
              [existingId, replacementId],
            );
          },
        );
      }),
  );

  it.each(["main", "work"] as const)(
    "keeps pending credentials outside active serialization, copying, and merge for %s",
    async (agentId) =>
      withStore(agentId, async (agentDir) => {
        saveAuthProfileCandidates({
          baseConfig: {},
          profiles: [{ profileId: candidateId, credential: candidate }],
          agentDir,
          setup,
        });
        const selection = resolvePendingAuthProfileSelection(candidateId, agentDir)!;
        expect(selection).toBeDefined();
        const active = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
        expect(active.profiles).toEqual({ [priorId]: prior });
        expect(resolveAuthProfileOrder({ provider: "fixture", store: active })).toEqual([priorId]);
        const explicit = await withPendingAuthProfileProbe(
          { profileId: candidateId, agentDir },
          async () => projectExplicitPendingAuthProfile(active, candidateId, agentDir),
        );
        expect(explicit.profiles[candidateId]).toEqual(candidate);
        expect(resolveAuthProfileOrder({ provider: "fixture", store: explicit })).toEqual([
          priorId,
        ]);
        expect(buildPersistedAuthProfileSecretsStore(explicit).profiles).toEqual(active.profiles);
        expect(buildPortableAuthProfileStoreForAgentCopy(explicit).store.profiles).toEqual(
          active.profiles,
        );
        expect(mergeAuthProfileStores(active, explicit).profiles).toEqual(active.profiles);
        saveAuthProfileStore(explicit, agentDir, {
          sharedStoreWrite: true,
          syncExternalCli: false,
        });
        runAuthProfileWriteTransaction(
          selection.agentDir,
          (database) => {
            writePersistedAuthProfileStoreRaw(
              buildPersistedAuthProfileSecretsStore(active),
              selection.agentDir,
              database,
            );
          },
          { env: selection.owner.env },
        );
        closeAuthProfileReadPool();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual(
          active.profiles,
        );
        expect(loadPendingAuthProfileStore(selection.agentDir).profiles[candidateId]).toEqual(
          candidate,
        );
        expect(loadPendingAuthProfileStore(selection.agentDir).setup?.[candidateId]).toEqual(setup);
      }),
  );

  it("promotes only the candidate bound to the successful probe", async () =>
    withStore("main", async (agentDir) => {
      saveAuthProfileCandidates({
        baseConfig: {},
        profiles: [
          { profileId: candidateId, credential: candidate },
          { profileId: "fixture:other", credential: { ...candidate, key: "fixture-other-key" } },
        ],
        agentDir,
        setup,
      });
      const proof = await withPendingAuthProfileProbe({ profileId: candidateId, agentDir }, () =>
        preparePendingAuthProfileProbe({ profileId: candidateId, agentDir, config: {} }),
      );
      expect(proof).toBeDefined();
      await expect(
        promotePendingAuthProfile({
          proof: proof!,
          verifiedAuth: { authProfileId: "fixture:other", authFingerprint: proof!.authFingerprint },
        }),
      ).rejects.toThrow("did not verify");
      await promotePendingAuthProfile({
        proof: proof!,
        verifiedAuth: { authProfileId: candidateId, authFingerprint: proof!.authFingerprint },
      });
      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({
        [priorId]: prior,
        [candidateId]: candidate,
      });
      expect(loadPendingAuthProfileStore(proof!.selection.agentDir).profiles).toEqual({
        "fixture:other": { ...candidate, key: "fixture-other-key" },
      });
    }));

  it("rejects a changed candidate instead of treating its current value as verified", async () =>
    withStore("main", async (agentDir) => {
      saveAuthProfileCandidates({
        baseConfig: {},
        profiles: [{ profileId: candidateId, credential: candidate }],
        agentDir,
        setup,
      });
      const proof = await withPendingAuthProfileProbe({ profileId: candidateId, agentDir }, () =>
        preparePendingAuthProfileProbe({ profileId: candidateId, agentDir, config: {} }),
      );
      expect(proof).toBeDefined();
      await withPendingAuthProfileProbe({ profileId: candidateId, agentDir }, async () => {
        updatePendingAuthProfile(proof!.selection, (store) => {
          store.profiles[candidateId] = { ...candidate, key: "fixture-changed-key" };
          return true;
        });
      });
      await expect(
        promotePendingAuthProfile({
          proof: proof!,
          verifiedAuth: { authProfileId: candidateId, authFingerprint: proof!.authFingerprint },
        }),
      ).rejects.toThrow("changed before activation");
      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({
        [priorId]: prior,
      });
    }));

  it.each(["retain", "delete"] as const)(
    "keeps OAuth refresh writeback pending and respects %s during refresh",
    async (action) =>
      withStore("main", async (agentDir) => {
        const oauth = {
          type: "oauth" as const,
          provider: "fixture",
          access: "fixture-old-access",
          refresh: "fixture-old-refresh",
          expires: Date.now() - 1000,
        };
        saveAuthProfileCandidates({
          baseConfig: {},
          profiles: [{ profileId: candidateId, credential: oauth }],
          agentDir,
          setup,
        });
        const selection = resolvePendingAuthProfileSelection(candidateId, agentDir)!;
        const refreshed = {
          ...oauth,
          access: "fixture-refreshed-access",
          refresh: "fixture-refreshed-refresh",
          expires: Date.now() + 60_000,
        };
        const bootstrap = vi.fn(() => null);
        const manager = createOAuthManager({
          buildApiKey: async (_provider, credential) => credential.access,
          refreshCredential: async () => {
            if (action === "delete") {
              removePendingAuthProfiles({
                agentDir: selection.agentDir,
                profileIds: [candidateId],
              });
            }
            return refreshed;
          },
          readBootstrapCredential: bootstrap,
          isRefreshTokenReusedError: () => false,
        });
        const resolution = withPendingAuthProfileProbe({ profileId: candidateId, agentDir }, () =>
          manager.resolveOAuthAccess({
            store: projectExplicitPendingAuthProfile(
              loadAuthProfileStoreWithoutExternalProfiles(agentDir),
              candidateId,
              agentDir,
            ),
            profileId: candidateId,
            credential: oauth,
            agentDir,
            pending: selection,
          }),
        );
        if (action === "retain") {
          await expect(resolution).resolves.toMatchObject({ apiKey: refreshed.access });
          expect(loadPendingAuthProfileStore(selection.agentDir).profiles[candidateId]).toEqual(
            refreshed,
          );
        } else {
          await expect(resolution).rejects.toThrow("pending sign-in is no longer available");
          expect(
            loadPendingAuthProfileStore(selection.agentDir).profiles[candidateId],
          ).toBeUndefined();
        }
        expect(bootstrap).not.toHaveBeenCalled();
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({
          [priorId]: prior,
        });
      }),
  );

  it("removes a pending profile from its owner without removing working access", async () =>
    withStore("main", async (agentDir) => {
      saveAuthProfileCandidates({
        baseConfig: {},
        profiles: [{ profileId: candidateId, credential: candidate }],
        agentDir,
        setup,
      });
      await expect(
        removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: [candidateId] }),
      ).resolves.toBe(true);
      expect(resolvePendingAuthProfileSelection(candidateId, agentDir)).toBeUndefined();
      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({
        [priorId]: prior,
      });
    }));

  it.each([false, true])(
    "purges pending auth aliases without widening provider or ID scope (narrow=%s)",
    async (narrow) =>
      withStore("main", async (agentDir) => {
        const provider = "moonshot";
        const workingId = `${provider}:working`;
        const firstId = "moonshotai:first";
        const secondId = "moonshotai:second";
        const working = { ...prior, provider };
        const aliased = { ...candidate, provider: "moonshotai" };
        await persistAuthProfileBatch({
          agentDir,
          profiles: [{ profileId: workingId, credential: working }],
        });
        saveAuthProfileCandidates({
          baseConfig: {},
          agentDir,
          profiles: [
            { profileId: firstId, credential: aliased },
            { profileId: secondId, credential: aliased },
            { profileId: candidateId, credential: candidate },
          ],
          setup,
        });
        await removeProviderAuthProfilesWithLock({
          provider,
          agentDir,
          ...(narrow ? { profileIds: [firstId] } : {}),
        });
        expect(loadPendingAuthProfileStore().profiles).toEqual({
          [candidateId]: candidate,
          ...(narrow ? { [secondId]: aliased } : {}),
        });
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({
          [priorId]: prior,
          ...(narrow ? { [workingId]: working } : {}),
        });
      }),
  );

  it("rejects a revoked pending key after awaited protected-secret resolution", async () =>
    withStore("main", async (agentDir) => {
      persistProviderAuthSetupCandidates({
        baseConfig: {},
        profiles: [
          {
            profileId: candidateId,
            credential: candidate,
            secretStorage: { kind: "store", namePrefix: "FIXTURE_PENDING" },
          },
        ],
        config: {},
        agentDir,
        setup,
        env: process.env,
      });
      const selection = resolvePendingAuthProfileSelection(candidateId, agentDir)!;
      const started = createDeferredCore<void>();
      const release = createDeferredCore<void>();
      const original = secretResolver.resolveSecretRefString;
      vi.spyOn(secretResolver, "resolveSecretRefString").mockImplementation(async (...args) => {
        const value = await original(...args);
        started.resolve();
        await release.promise;
        return value;
      });
      const resolving = withPendingAuthProfileProbe({ profileId: candidateId, agentDir }, () =>
        resolveApiKeyForProfile({
          cfg: {},
          agentDir,
          profileId: candidateId,
          store: projectExplicitPendingAuthProfile(
            loadAuthProfileStoreWithoutExternalProfiles(agentDir),
            candidateId,
            agentDir,
          ),
        }),
      );
      await started.promise;
      removePendingAuthProfiles({ agentDir: selection.agentDir, profileIds: [candidateId] });
      release.resolve();
      await expect(resolving).rejects.toThrow("pending sign-in is no longer available");
      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({
        [priorId]: prior,
      });
    }));

  it.each(["protected", "oauth"] as const)(
    "rejects retained stores, nested probes, and late %s results after scope closure",
    async (kind) =>
      withStore("main", async (agentDir) => {
        const oauth = {
          type: "oauth" as const,
          provider: "fixture",
          access: "fixture-pending-access",
          refresh: "fixture-pending-refresh",
          expires: Date.now() + 3_600_000,
        };
        persistProviderAuthSetupCandidates({
          baseConfig: {},
          profiles: [
            kind === "oauth"
              ? { profileId: candidateId, credential: oauth }
              : {
                  profileId: candidateId,
                  credential: candidate,
                  secretStorage: { kind: "store", namePrefix: "FIXTURE_PENDING" },
                },
          ],
          config: {},
          agentDir,
          setup,
        });
        const selection = resolvePendingAuthProfileSelection(candidateId, agentDir)!;
        const active = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
        const started = createDeferredCore<void>();
        const release = createDeferredCore<void>();
        const original = secretResolver.resolveSecretRefString;
        vi.spyOn(secretResolver, "resolveSecretRefString").mockImplementation(async (...args) => {
          const value = await original(...args);
          started.resolve();
          await release.promise;
          return value;
        });
        const manager = createOAuthManager({
          buildApiKey: async (_provider, credential) => {
            started.resolve();
            await release.promise;
            return credential.access;
          },
          refreshCredential: async () => null,
          readBootstrapCredential: () => null,
          isRefreshTokenReusedError: () => false,
        });
        const probe = { profileId: candidateId, agentDir };
        const retained = await withPendingAuthProfileProbe(probe, async () => {
          const store = projectExplicitPendingAuthProfile(active, candidateId, agentDir);
          const resolve = async () =>
            kind === "oauth"
              ? await manager.resolveOAuthAccess({
                  store,
                  profileId: candidateId,
                  credential: oauth,
                  agentDir,
                  pending: selection,
                })
              : await resolveApiKeyForProfile({ cfg: {}, store, profileId: candidateId, agentDir });
          const resolving = withPendingAuthProfileProbe(probe, resolve);
          const delayed = release.promise.then(resolve);
          const nested = release.promise.then(() => withPendingAuthProfileProbe(probe, resolve));
          await started.promise;
          return { store, resolve, resolving, delayed, nested };
        });
        expect(
          projectExplicitPendingAuthProfile(retained.store, candidateId, agentDir).profiles,
        ).toEqual(active.profiles);
        const outcomes = Promise.all([
          expect(retained.resolve()).rejects.toThrow("outside its active probe"),
          expect(retained.resolving).rejects.toThrow("outside its active probe"),
          expect(retained.delayed).rejects.toThrow("outside its active probe"),
          expect(retained.nested).rejects.toThrow("probe is no longer active"),
        ]);
        release.resolve();
        await outcomes;
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual(
          active.profiles,
        );
        expect(loadPendingAuthProfileStore(selection.agentDir).profiles[candidateId]).toEqual(
          selection.credential,
        );
      }),
  );
});
