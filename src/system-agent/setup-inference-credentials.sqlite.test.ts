import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import {
  listPendingAuthProfileSetups,
  loadPendingAuthProfileStore,
  removePendingAuthProfiles,
  resolvePendingAuthProfileSelection,
  updatePendingAuthProfile,
} from "../agents/auth-profiles/pending.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import {
  clearRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { persistProviderAuthProfileBatch } from "../plugins/provider-auth-persistence.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../plugins/types.js";
import { readSecretStoreValue } from "../secrets/store/secret-store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { activateSetupInference } from "./setup-inference-activate.js";

const mocks = vi.hoisted(() => ({
  turn: vi.fn(),
  commit: vi.fn(),
}));

vi.mock("../plugins/enable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/enable.js")>()),
  enablePluginWithCapabilityConsent: async (config: OpenClawConfig) => ({ enabled: true, config }),
}));

vi.mock("./setup-inference-turn.js", () => ({
  runSetupInferenceTurn: mocks.turn,
}));

vi.mock("../plugins/install-record-commit.js", () => ({
  transformConfigWithPendingPluginInstalls: mocks.commit,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workingProfileId = "fixture:default";
const workingKey = "fixture-working-key";
const incomingKey = "fixture-incoming-key";
type CredentialCase = {
  storage: "inline" | "protected";
  order: "implicit" | "configured" | "stored";
  outcome?: "reject" | "success" | "cancel" | "config-error" | "retry" | "retry-echo";
  fresh?: boolean;
  change?: "connection" | "message" | "credential" | "deleted" | "binding";
  source?: "profile" | "config" | "secret-ref";
  firstKeyInResult?: boolean;
  providerAlias?: boolean;
};

function readCredentialValue(credential: AuthProfileCredential | undefined): string {
  if (credential?.type !== "api_key") {
    throw new Error("Expected the fixture API-key credential.");
  }
  if (credential.key !== undefined) {
    return credential.key;
  }
  if (credential.keyRef?.source !== "store") {
    throw new Error("Expected the fixture protected-store reference.");
  }
  const result = readSecretStoreValue({
    scope: { kind: "team" },
    name: credential.keyRef.id,
    database: { env: process.env },
  });
  if (!result.ok) {
    throw new Error("Expected the fixture protected credential to remain readable.");
  }
  return result.value;
}

describe("setup credential preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSecretRedactionRegistryForTest();
  });
  afterEach(resetSecretRedactionRegistryForTest);

  it.each([
    { storage: "inline", order: "implicit" },
    { storage: "inline", order: "stored" },
    { storage: "protected", order: "configured" },
    { storage: "inline", order: "implicit", outcome: "success" },
    { storage: "protected", order: "stored", outcome: "success" },
    { storage: "protected", order: "configured", outcome: "cancel" },
    { storage: "inline", order: "implicit", outcome: "config-error" },
    { storage: "inline", order: "implicit", outcome: "success", change: "connection" },
    { storage: "inline", order: "implicit", outcome: "success", change: "message" },
    { storage: "inline", order: "implicit", outcome: "success", change: "credential" },
    { storage: "inline", order: "implicit", outcome: "success", change: "deleted" },
    { storage: "inline", order: "implicit", outcome: "success", change: "binding" },
    { storage: "protected", order: "implicit", outcome: "retry" },
    { storage: "inline", order: "implicit", outcome: "retry-echo" },
    { storage: "inline", order: "implicit", fresh: true },
    { storage: "inline", order: "implicit", source: "config" },
    { storage: "inline", order: "implicit", source: "secret-ref" },
    { storage: "inline", order: "implicit", fresh: true, firstKeyInResult: true },
    { storage: "inline", order: "stored", outcome: "success", providerAlias: true },
  ] satisfies CredentialCase[])(
    "preserves save/probe/adopt boundaries ($storage, $order, $outcome, fresh=$fresh, change=$change, source=$source, firstKeyInResult=$firstKeyInResult, providerAlias=$providerAlias)",
    async ({
      storage,
      order,
      outcome = "reject",
      fresh = false,
      change,
      source = "profile",
      firstKeyInResult = false,
      providerAlias = false,
    }: CredentialCase) => {
      const provider = providerAlias ? "moonshot" : "fixture";
      const hasWorkingProfile = !fresh && source === "profile";
      const root = tempDirs.make("openclaw-setup-credential-preservation-");
      const stateDir = path.join(root, "state");
      const agentDir = path.join(stateDir, "agents", "main", "agent");
      const configPath = path.join(root, "openclaw.json");
      let config: OpenClawConfig = {
        agents: {
          entries: { main: { default: true } },
          defaults: { model: `${provider}/existing` },
        },
        ...(order === "configured" ? { auth: { order: { [provider]: [workingProfileId] } } } : {}),
        models: {
          providers: {
            [provider]: {
              baseUrl: "https://provider.example.invalid/v1",
              api: "openai-completions",
              ...(source === "config"
                ? { apiKey: workingKey }
                : source === "secret-ref"
                  ? {
                      apiKey: {
                        source: "env",
                        provider: "default",
                        id: "FIXTURE_PREEXISTING_KEY",
                      },
                    }
                  : {}),
              models: ["existing", "candidate"].map((id) => ({
                id,
                name: id,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 4096,
              })),
            },
          },
        },
      };
      const initialConfig = structuredClone(config);
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config), "utf8");
      await withEnvAsync(
        {
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          FIXTURE_PREEXISTING_KEY: undefined,
        },
        async () => {
          try {
            if (providerAlias) {
              expect(resolveProviderIdForAuth("moonshotai", { config })).toBe(provider);
            }
            const authResult = (key: string): ProviderAuthResult => ({
              profiles: [
                {
                  profileId: workingProfileId,
                  credential: {
                    type: "api_key",
                    provider: providerAlias && key === incomingKey ? "moonshotai" : provider,
                    key,
                  },
                  ...(storage === "protected"
                    ? {
                        secretStorage: {
                          kind: "store",
                          namePrefix: "FIXTURE_SETUP_KEY",
                        },
                      }
                    : {}),
                },
              ],
              defaultModel: `${provider}/candidate`,
              ...(key === incomingKey && !change
                ? {
                    configPatch: {
                      models: {
                        providers: {
                          [provider]: {
                            ...config.models!.providers![provider]!,
                            baseUrl: "https://new-connection.example.invalid/v1",
                            ...(firstKeyInResult ? { apiKey: incomingKey } : {}),
                          },
                        },
                      },
                    },
                  }
                : {}),
            });
            if (hasWorkingProfile) {
              await persistProviderAuthProfileBatch({
                profiles: authResult(workingKey).profiles,
                config,
                agentDir,
                stateDir,
                env: process.env,
              });
            }
            const initialStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
            if (hasWorkingProfile) {
              initialStore.lastGood = { [provider]: workingProfileId };
              initialStore.usageStats = { [workingProfileId]: { lastUsed: Date.now() } };
            }
            if (order === "stored") {
              initialStore.order = { [provider]: [workingProfileId] };
            }
            saveAuthProfileStore(initialStore, agentDir, {
              sharedStoreWrite: true,
              syncExternalCli: false,
            });
            setRuntimeAuthProfileStoreSnapshot(
              loadAuthProfileStoreWithoutExternalProfiles(agentDir),
              agentDir,
            );
            const before = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
            const beforeOrder = resolveAuthProfileOrder({
              cfg: config,
              store: before,
              provider,
            });
            expect(beforeOrder).toEqual(hasWorkingProfile ? [workingProfileId] : []);
            const probeObservations: Array<{
              store: AuthProfileStore;
              pending: AuthProfileStore;
              published: AuthProfileStore | undefined;
              selectedProfileId: string | undefined;
              workingValue?: string;
              connection?: string;
            }> = [];
            const abortController = new AbortController();
            mocks.turn.mockImplementation(
              async ({
                route,
              }: {
                route: { authProfileId?: string; runConfig: OpenClawConfig };
              }) => {
                const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
                const pending = loadPendingAuthProfileStore();
                probeObservations.push({
                  store: structuredClone(store),
                  pending: structuredClone(pending),
                  published: structuredClone(getRuntimeAuthProfileStoreSnapshot(agentDir)),
                  selectedProfileId: route.authProfileId,
                  workingValue: hasWorkingProfile
                    ? readCredentialValue(store.profiles[workingProfileId])
                    : undefined,
                  connection: route.runConfig.models?.providers?.[provider]?.baseUrl,
                });
                if (change === "connection" || change === "message") {
                  config = structuredClone(config);
                  if (change === "connection") {
                    config.models!.providers![provider]!.baseUrl =
                      "https://changed-during-verification.example.invalid/v1";
                  } else {
                    config.messages = { responsePrefix: "Concurrent edit" };
                  }
                }
                if (change === "credential" || change === "deleted") {
                  const selection = resolvePendingAuthProfileSelection(
                    route.authProfileId!,
                    agentDir,
                  )!;
                  if (change === "deleted") {
                    removePendingAuthProfiles({
                      agentDir: selection.agentDir,
                      profileIds: [selection.profileId],
                    });
                  } else {
                    updatePendingAuthProfile(selection, (pendingStore) => {
                      pendingStore.profiles[selection.profileId] = {
                        type: "api_key",
                        provider,
                        key: "fixture-changed-during-verification",
                      };
                      return true;
                    });
                  }
                }
                if (outcome === "cancel") {
                  abortController.abort();
                }
                if (outcome === "retry-echo" && probeObservations.length > 1) {
                  throw new Error(`Provider error echoed ${incomingKey}`);
                }
                if (
                  outcome === "success" ||
                  outcome === "config-error" ||
                  (outcome === "retry" && probeObservations.length > 1)
                ) {
                  const profileId =
                    route.authProfileId ??
                    resolveAuthProfileOrder({ cfg: route.runConfig, store, provider })[0]!;
                  const credential = pending.profiles[profileId] ?? store.profiles[profileId];
                  if (!credential || credential.type !== "api_key") {
                    throw new Error("Expected the explicitly selected fixture credential.");
                  }
                  return {
                    ok: true,
                    latencyMs: 1,
                    text: "OK",
                    auth: {
                      authProfileId: profileId,
                      authFingerprint:
                        change === "binding"
                          ? "fixture-other-successful-credential"
                          : fingerprintResolvedProviderAuth({
                              profileId,
                              apiKey: readCredentialValue(credential),
                              source: `profile:${profileId}`,
                              mode: "api-key",
                            }),
                    },
                  };
                }
                return { ok: false, status: "billing", error: "Fixture model access denied." };
              },
            );
            mocks.commit.mockImplementation(async ({ transform }) => {
              const active = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
              expect(config.models?.providers?.[provider]?.baseUrl).toBe(
                change === "connection"
                  ? "https://changed-during-verification.example.invalid/v1"
                  : "https://provider.example.invalid/v1",
              );
              expect(
                Object.values(active.profiles).some(
                  (credential) => readCredentialValue(credential) === incomingKey,
                ),
              ).toBe(false);
              expect(
                Object.values(loadPendingAuthProfileStore().profiles).some(
                  (credential) => readCredentialValue(credential) === incomingKey,
                ),
              ).toBe(change !== "credential" && change !== "deleted");
              expect(resolveAuthProfileOrder({ cfg: config, store: active, provider })).toEqual(
                beforeOrder,
              );
              if (outcome === "config-error") {
                throw new Error("Fixture config write rejected.");
              }
              config = (await transform(config)).nextConfig;
              return { nextConfig: config, followUp: { requiresRestart: false } };
            });
            const method: ProviderAuthMethod = {
              id: "login",
              label: "Fixture login",
              kind: "api_key",
              run: vi.fn(async () => authResult(incomingKey)),
              starterModel: `${provider}/candidate`,
              wizard: { onboardingScopes: ["text-inference"] },
            };
            const activation: Parameters<typeof activateSetupInference>[0] = {
              kind: "api-key",
              modelRef: `${provider}/candidate`,
              authChoice: "fixture-login",
              apiKey: incomingKey,
              surface: "cli",
              runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
              prompter: createWizardPrompter(),
              signal: abortController.signal,
              deps: {
                readConfigFileSnapshot: async () =>
                  createConfigFileSnapshot({
                    path: configPath,
                    exists: true,
                    raw: JSON.stringify(config),
                    parsed: config,
                    sourceConfig: config,
                    runtimeConfig: config,
                    valid: true,
                    issues: [],
                    warnings: [],
                    legacyIssues: [],
                  }),
                resolveManifestProviderAuthChoice: () => ({
                  pluginId: "fixture",
                  providerId: provider,
                  methodId: "login",
                  choiceId: "fixture-login",
                  choiceLabel: "Fixture",
                  appGuidedSecret: true,
                  onboardingScopes: ["text-inference"],
                }),
                resolvePluginProviders: () => [
                  { id: provider, pluginId: "fixture", label: "Fixture", auth: [method] },
                ],
                loadAuthProfileStoreForRuntime: loadAuthProfileStoreWithoutExternalProfiles,
              },
            };
            const result = await activateSetupInference(activation).catch(
              (error: unknown) => error,
            );

            if (change === "credential" || change === "deleted" || change === "binding") {
              expect(mocks.turn).toHaveBeenCalledOnce();
              expect(result).toBeInstanceOf(Error);
              expect(config).toEqual(initialConfig);
              expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual(
                before.profiles,
              );
              return;
            }
            if (outcome === "config-error" || change === "connection") {
              expect(result).toBeInstanceOf(Error);
              expect(String(result)).toContain("default update");
              expect(String(result)).toContain("remains pending");
            } else {
              expect(result).toMatchObject(
                outcome === "success"
                  ? { ok: true }
                  : { ok: false, status: outcome === "cancel" ? "unavailable" : "billing" },
              );
            }
            expect(mocks.turn).toHaveBeenCalledOnce();
            if (outcome !== "success" && outcome !== "config-error") {
              expect(mocks.commit).not.toHaveBeenCalled();
            }
            if (outcome !== "success") {
              expect(config).toEqual(initialConfig);
            }
            if (change === "connection") {
              expect(config.models?.providers?.[provider]?.baseUrl).toBe(
                "https://changed-during-verification.example.invalid/v1",
              );
              expect(config.agents?.defaults?.model).toBe(`${provider}/existing`);
            } else if (change === "message") {
              expect(config.messages?.responsePrefix).toBe("Concurrent edit");
            }
            expect(probeObservations).toHaveLength(1);
            const observation = probeObservations[0]!;
            if (!fresh) {
              expect(observation.workingValue).toBe(hasWorkingProfile ? workingKey : undefined);
              expect(observation.store).toMatchObject({
                profiles: before.profiles,
                lastGood: before.lastGood,
                usageStats: before.usageStats,
              });
            }
            const incomingProfiles = Object.entries(
              fresh ? observation.store.profiles : observation.pending.profiles,
            ).filter(([, credential]) => readCredentialValue(credential) === incomingKey);
            expect(incomingProfiles).toHaveLength(1);
            const [incomingProfileId] = incomingProfiles[0]!;
            if (!fresh) {
              expect(observation.published?.profiles[incomingProfileId]).toBeUndefined();
              expect(observation.store.profiles[incomingProfileId]).toBeUndefined();
            }
            expect(observation.selectedProfileId).toBe(incomingProfileId);
            expect(observation.connection).toBe(
              change
                ? "https://provider.example.invalid/v1"
                : "https://new-connection.example.invalid/v1",
            );
            if (!fresh) {
              expect(
                resolveAuthProfileOrder({
                  cfg: config,
                  store: observation.store,
                  provider,
                }),
              ).toEqual(beforeOrder);
            }
            if (outcome === "retry" || outcome === "retry-echo") {
              const saved = listPendingAuthProfileSetups(agentDir);
              expect(saved).toHaveLength(1);
              expect(saved[0]?.setup.connectionPatch.models?.providers?.[provider]?.baseUrl).toBe(
                "https://new-connection.example.invalid/v1",
              );
              closeAuthProfileReadPool();
              closeOpenClawAgentDatabasesForTest();
              closeOpenClawStateDatabaseForTest();
              resetSecretRedactionRegistryForTest();
              const retried = activateSetupInference({
                ...activation,
                kind: `saved-auth:${encodeURIComponent(saved[0]!.profileId)}`,
                apiKey: undefined,
              });
              if (outcome === "retry-echo") {
                const error = await retried.catch((caught: unknown) => caught);
                expect(error).toBeInstanceOf(Error);
                expect(String(error)).not.toContain(incomingKey);
                expect(String(error)).toContain("Provider error echoed");
              } else {
                await expect(retried).resolves.toMatchObject({ ok: true });
              }
              expect(method.run).toHaveBeenCalledOnce();
              expect(probeObservations[1]?.connection).toBe(observation.connection);
            }
            const after = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
            if (hasWorkingProfile) {
              expect(readCredentialValue(after.profiles[workingProfileId])).toBe(workingKey);
            }
            if (
              fresh ||
              (outcome === "success" && change !== "connection") ||
              outcome === "retry"
            ) {
              expect(readCredentialValue(after.profiles[incomingProfileId])).toBe(incomingKey);
              expect(loadPendingAuthProfileStore().profiles[incomingProfileId]).toBeUndefined();
            } else {
              expect(after.profiles[incomingProfileId]).toBeUndefined();
              expect(
                readCredentialValue(loadPendingAuthProfileStore().profiles[incomingProfileId]),
              ).toBe(incomingKey);
            }
            if ((outcome === "success" && change !== "connection") || outcome === "retry") {
              expect(config.agents?.defaults?.model).toBe(
                `${provider}/candidate@${incomingProfileId}`,
              );
            }
          } finally {
            clearRuntimeAuthProfileStoreSnapshot(agentDir);
            clearRuntimeAuthProfileStoreSnapshot();
            closeOpenClawAgentDatabasesForTest();
            closeOpenClawStateDatabaseForTest();
          }
        },
      );
    },
  );
});
