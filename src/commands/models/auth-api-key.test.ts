import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential, AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  upsertAuthProfileWithLockOrThrow:
    vi.fn<
      typeof import("../../agents/auth-profiles/profiles.js").upsertAuthProfileWithLockOrThrow
    >(),
  loadValidConfigOrThrow: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles.js")>()),
  ensureAuthProfileStoreWithoutExternalProfiles:
    mocks.ensureAuthProfileStoreWithoutExternalProfiles,
}));
vi.mock("../../agents/auth-profiles/profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/profiles.js")>()),
  upsertAuthProfileWithLockOrThrow: mocks.upsertAuthProfileWithLockOrThrow,
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  loadValidConfigOrThrow: mocks.loadValidConfigOrThrow,
  updateConfig: mocks.updateConfig,
}));
vi.mock("../../logging/secret-redaction-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/secret-redaction-registry.js")>()),
  registerSecretValueForRedaction: vi.fn(),
}));

const { saveModelProviderApiKey } = await import("./auth.js");
const connection = { baseUrl: "https://provider.example/v1", models: [] };
const request = {
  provider: "sample",
  apiKey: "synthetic-new-key",
  agentDir: "/tmp/agent-writer",
};

describe("saveModelProviderApiKey", () => {
  let currentConfig: OpenClawConfig;
  let store: AuthProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    currentConfig = { agents: { defaults: { model: "other/current" } } };
    store = { version: 1, profiles: {} };
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockImplementation(() => store);
    mocks.loadValidConfigOrThrow.mockImplementation(async () => currentConfig);
    mocks.upsertAuthProfileWithLockOrThrow.mockImplementation(async ({ profileId, credential }) => {
      store.profiles[profileId] = credential;
      return store;
    });
    mocks.updateConfig.mockImplementation(
      async (mutator: (config: OpenClawConfig) => OpenClawConfig) => {
        currentConfig = mutator(currentConfig);
        return currentConfig;
      },
    );
  });

  it("pins a configured connection to a non-secret profile reference without changing the default", async () => {
    currentConfig.models = {
      providers: { sample: { ...connection, apiKey: "previous-key" } },
    };

    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).resolves.toBe("sample:manual-api-key");

    expect(store.profiles).toEqual({
      "sample:manual-api-key": { type: "api_key", provider: "sample", key: "synthetic-new-key" },
    });
    expect(mocks.upsertAuthProfileWithLockOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/agent-writer" }),
    );
    expect(currentConfig.models?.providers?.sample).toEqual({
      ...connection,
      apiKey: "sample:manual-api-key",
    });
    expect(currentConfig.auth?.profiles?.["sample:manual-api-key"]).toEqual({
      provider: "sample",
      mode: "api_key",
    });
    expect(currentConfig.agents?.defaults?.model).toBe("other/current");
  });

  it.each([
    { profileId: undefined, expectedProfileId: "sample:manual" },
    { profileId: "sample:work", expectedProfileId: "sample:work" },
  ])(
    "keeps CLI profile $expectedProfileId metadata-only",
    async ({ profileId, expectedProfileId }) => {
      currentConfig.models = {
        providers: { sample: { ...connection, apiKey: "configured-key" } },
      };

      await expect(saveModelProviderApiKey({ ...request, profileId })).resolves.toBe(
        expectedProfileId,
      );

      expect(Object.keys(store.profiles)).toEqual([expectedProfileId]);
      expect(store.profiles[expectedProfileId]).toEqual({
        type: "api_key",
        provider: "sample",
        key: "synthetic-new-key",
      });
      expect(currentConfig.auth?.profiles?.[expectedProfileId]).toEqual({
        provider: "sample",
        mode: "api_key",
      });
      expect(currentConfig.models?.providers?.sample?.apiKey).toBe("configured-key");
      expect(currentConfig.agents?.defaults?.model).toBe("other/current");
    },
  );

  it("saves an unconfigured provider without inventing connection settings", async () => {
    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).resolves.toBe("sample:manual-api-key");

    expect(store.profiles["sample:manual-api-key"]).toEqual({
      type: "api_key",
      provider: "sample",
      key: "synthetic-new-key",
    });
    expect(currentConfig.models).toBeUndefined();
  });

  it.each([
    { type: "api_key", provider: "other", key: "other-key" },
    { type: "oauth", provider: "sample", access: "access", refresh: "refresh", expires: 1_000_000 },
  ] satisfies AuthProfileCredential[])(
    "preserves an existing $type profile owned by $provider",
    async (credential) => {
      store.profiles["sample:manual-api-key"] = credential;

      await expect(
        saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
      ).rejects.toThrow("belongs to another sign-in");
      expect(store.profiles["sample:manual-api-key"]).toEqual(credential);
      expect(mocks.upsertAuthProfileWithLockOrThrow).not.toHaveBeenCalled();
      expect(mocks.updateConfig).not.toHaveBeenCalled();
    },
  );

  it("preserves a connection configured for OAuth", async () => {
    currentConfig.models = { providers: { sample: { ...connection, auth: "oauth" } } };

    await expect(
      saveModelProviderApiKey({ ...request, config: currentConfig, bindProviderConfig: true }),
    ).rejects.toThrow("uses another sign-in method");
    expect(store.profiles).toEqual({});
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("reports a saved credential when its config write fails", async () => {
    mocks.updateConfig.mockRejectedValueOnce(new Error("Config is read-only"));

    await expect(saveModelProviderApiKey(request)).rejects.toThrow(
      "API key saved, but provider settings could not be applied: Config is read-only",
    );
    expect(store.profiles["sample:manual"]).toMatchObject({ key: "synthetic-new-key" });
    expect(currentConfig.auth).toBeUndefined();
  });

  it("rejects a blank API key before changing credentials or config", async () => {
    await expect(saveModelProviderApiKey({ ...request, apiKey: "  " })).rejects.toThrow(
      "API key is required",
    );
    expect(store.profiles).toEqual({});
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "JWT token",
      value: ["eyJhbGciOiJub25l", "eyJzdWIiOiJmaXh0dXJlIn0", "signature123456"].join("."),
      error: "looks like token or OAuth material",
    },
    {
      label: "structured OAuth credential",
      value: '{"access_token":"fixture-token"}',
      error: "looks like token or OAuth material",
    },
    {
      label: "unrecognized value",
      value: "fixture-not-an-api-key",
      error: "does not look like an OpenAI API key",
    },
  ])("rejects $label before changing credentials or config", async ({ value, error }) => {
    await expect(
      saveModelProviderApiKey({ ...request, provider: "openai", apiKey: value }),
    ).rejects.toThrow(error);
    expect(store.profiles).toEqual({});
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});
