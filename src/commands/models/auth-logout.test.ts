// Covers `models auth logout`: store removal, config-reference cleanup, and refusals.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  listProfilesForProvider: vi.fn(() => [] as string[]),
  removeAuthProfilesAcrossOwnerStores:
    vi.fn<typeof import("../../agents/auth-profiles.js").removeAuthProfilesAcrossOwnerStores>(),
  resolvePendingAuthProfileSelection: vi.fn(() => undefined),
  loadModelsConfig: vi.fn(),
  updateConfig: vi.fn(),
  logConfigUpdated: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(async () => "refreshed" as const),
  confirm: vi.fn(async () => true),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfiles:
    mocks.ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider: mocks.listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("../../agents/auth-profiles/pending.js", () => ({
  resolvePendingAuthProfileSelection: mocks.resolvePendingAuthProfileSelection,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: (_cfg: OpenClawConfig, rawAgentId?: string) => ({
      agentId: rawAgentId ?? "main",
      agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
    }),
    updateConfig: mocks.updateConfig,
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ confirm: mocks.confirm }),
}));

const { modelsAuthLogoutCommand, removeModelAuthCredentials } = await import("./auth-logout.js");

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (...messages) => {
      logs.push(messages.join(" "));
    },
    error: () => {},
    exit: () => {},
  };
}

function storeWith(profileIds: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [
        profileId,
        {
          type: "oauth" as const,
          provider: profileId.split(":")[0]!,
          access: "access",
          refresh: "refresh",
          expires: 1_000_000,
        },
      ]),
    ),
  };
}

async function withStdinIsTty<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const hadOwnIsTTY = Object.hasOwn(stdin, "isTTY");
  const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  Object.defineProperty(stdin, "isTTY", {
    configurable: true,
    value: isTTY,
  });
  try {
    return await run();
  } finally {
    if (hadOwnIsTTY && previousIsTTYDescriptor) {
      Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
    } else {
      Reflect.deleteProperty(stdin, "isTTY");
    }
  }
}

describe("models auth logout", () => {
  let currentConfig: OpenClawConfig;
  let configAtRemoval: OpenClawConfig | undefined;
  let authStore: AuthProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    currentConfig = {};
    configAtRemoval = undefined;
    authStore = storeWith(["openai:manual"]);
    mocks.removeAuthProfilesAcrossOwnerStores.mockReset();
    mocks.removeAuthProfilesAcrossOwnerStores.mockImplementation(async ({ profileIds }) => {
      configAtRemoval = currentConfig;
      for (const profileId of profileIds) {
        delete authStore.profiles[profileId];
      }
      return true;
    });
    mocks.confirm.mockResolvedValue(true);
    mocks.listProfilesForProvider.mockReturnValue([]);
    mocks.updateConfig.mockReset();
    mocks.updateConfig.mockImplementation(
      async (mutator: (config: OpenClawConfig) => OpenClawConfig) => {
        currentConfig = mutator(currentConfig);
        return currentConfig;
      },
    );
    mocks.loadModelsConfig.mockImplementation(async () => currentConfig);
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockImplementation(() => authStore);
  });

  it("removes the profile from the selected agent store", async () => {
    const runtime = createRuntime();
    await modelsAuthLogoutCommand({ profileId: "openai:manual", agent: "poe", yes: true }, runtime);

    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/tmp/agent-poe", profileIds: ["openai:manual"] }),
    );
    expect(authStore.profiles).toEqual({});
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("poe", "logout");
    expect(runtime.logs).toContain("Removed auth profile: openai:manual (openai/oauth)");
    expect(runtime.logs.some((line) => line.includes("No auth profiles remain for openai"))).toBe(
      true,
    );
    // Nothing in config referenced the profile, so config stays untouched.
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("clears config bindings before deleting only the selected profile", async () => {
    authStore = storeWith(["openai:manual", "openai:backup", "anthropic:manual"]);
    currentConfig = {
      auth: {
        profiles: {
          "openai:manual": { provider: "openai", mode: "oauth" },
          "openai:backup": { provider: "openai", mode: "api_key" },
          "anthropic:manual": { provider: "anthropic", mode: "oauth" },
        },
        order: {
          openai: ["openai:manual", "openai:backup"],
          anthropic: ["anthropic:manual"],
        },
      },
      models: {
        providers: {
          openai: { baseUrl: "https://provider.example/v1", models: [], apiKey: "openai:manual" },
          anthropic: {
            baseUrl: "https://other.example/v1",
            models: [],
            apiKey: "anthropic:manual",
          },
        },
      },
    };

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    expect(currentConfig.auth).toEqual({
      profiles: {
        "openai:backup": { provider: "openai", mode: "api_key" },
        "anthropic:manual": { provider: "anthropic", mode: "oauth" },
      },
      order: {
        openai: ["openai:backup"],
        anthropic: ["anthropic:manual"],
      },
    });
    expect(configAtRemoval?.auth).toEqual(currentConfig.auth);
    expect(configAtRemoval?.models?.providers?.openai).toEqual({
      baseUrl: "https://provider.example/v1",
      models: [],
    });
    expect(currentConfig.models?.providers?.openai).not.toHaveProperty("apiKey");
    expect(currentConfig.models?.providers?.anthropic?.apiKey).toBe("anthropic:manual");
    expect(Object.keys(authStore.profiles)).toEqual(["openai:backup", "anthropic:manual"]);
    expect(mocks.logConfigUpdated).toHaveBeenCalledTimes(1);
  });

  it("deletes an emptied provider order but keeps an authored empty one", async () => {
    currentConfig = {
      auth: {
        profiles: { "openai:manual": { provider: "openai", mode: "oauth" } },
        order: { openai: ["openai:manual"], anthropic: [] },
      },
    };

    await modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime());

    // `anthropic: []` is an authored "select no profiles" instruction for an
    // unrelated provider; only the order this removal emptied may go.
    expect(currentConfig.auth).toEqual({
      profiles: {},
      order: { anthropic: [] },
    });
  });

  it("keeps credentials when clearing the config reference fails", async () => {
    currentConfig = {
      auth: { profiles: { "openai:manual": { provider: "openai", mode: "oauth" } } },
    };
    mocks.updateConfig.mockRejectedValueOnce(new Error("config write failed"));

    await expect(
      modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime()),
    ).rejects.toThrow("config write failed");

    expect(Object.keys(authStore.profiles)).toEqual(["openai:manual"]);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
  });

  it.each([
    ["configured-key", undefined],
    [
      { source: "env", provider: "default", id: "CUSTOM_OPENAI_KEY" },
      { source: "env", provider: "default", id: "CUSTOM_OPENAI_KEY" },
    ],
    ["openai:token", "openai:token"],
  ] as const)(
    "removes saved API keys while preserving non-key binding %j",
    async (apiKey, expectedKey) => {
      authStore = storeWith(["openai:oauth"]);
      authStore.profiles["openai:key"] = { type: "api_key", provider: "openai", key: "saved-key" };
      authStore.profiles["openai:token"] = {
        type: "token",
        provider: "openai",
        token: "saved-token",
      };
      currentConfig = {
        models: {
          providers: {
            openai: { baseUrl: "https://provider.example/v1", models: [], apiKey },
            other: { baseUrl: "https://other.example/v1", models: [], apiKey: "other-key" },
          },
        },
      };

      await removeModelAuthCredentials({
        config: currentConfig,
        agentDir: "/tmp/agent-main",
        profileIds: ["openai:key"],
        apiKeyProvider: "openai",
      });

      expect(configAtRemoval?.models?.providers?.openai?.apiKey).toEqual(expectedKey);
      expect(currentConfig.models?.providers?.other?.apiKey).toBe("other-key");
      expect(Object.keys(authStore.profiles)).toEqual(["openai:oauth", "openai:token"]);
    },
  );

  it.each([
    {
      label: "unknown profile id",
      profileId: "openai:missing",
      cfg: {} as OpenClawConfig,
      expected: 'Auth profile "openai:missing" not found for agent "main"',
    },
    {
      label: "blank profile id",
      profileId: "  ",
      cfg: {} as OpenClawConfig,
      expected: "Missing profile id",
    },
  ])("refuses removal for $label", async ({ profileId, cfg, expected }) => {
    currentConfig = cfg;

    await expect(
      modelsAuthLogoutCommand({ profileId, yes: true }, createRuntime()),
    ).rejects.toThrow(expected);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });

  it("fails when the auth store update does not complete", async () => {
    mocks.removeAuthProfilesAcrossOwnerStores.mockResolvedValue(false);

    await expect(
      modelsAuthLogoutCommand({ profileId: "openai:manual", yes: true }, createRuntime()),
    ).rejects.toThrow("Saved credentials could not be removed");
    expect(Object.keys(authStore.profiles)).toEqual(["openai:manual"]);
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
  });

  it("keeps the profile when an interactive confirmation is declined", async () => {
    mocks.confirm.mockResolvedValue(false);
    await withStdinIsTty(true, async () => {
      const runtime = createRuntime();
      await modelsAuthLogoutCommand({ profileId: "openai:manual" }, runtime);
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
      expect(runtime.logs).toContain("Cancelled.");
    });
  });

  it("refuses to remove without --yes when stdin is not a TTY", async () => {
    await withStdinIsTty(false, async () => {
      await expect(
        modelsAuthLogoutCommand({ profileId: "openai:manual" }, createRuntime()),
      ).rejects.toThrow("Pass --yes to remove it non-interactively.");
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    });
  });
});
