import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "../plugins/types.js";
import { activateSetupInference } from "./setup-inference-activate.js";

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  turn: vi.fn(),
  commit: vi.fn(),
}));

vi.mock("../plugins/enable.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/enable.js")>()),
  enablePluginWithCapabilityConsent: async (config: OpenClawConfig) => ({ enabled: true, config }),
}));

vi.mock("../plugins/provider-auth-persistence.js", () => ({
  persistProviderAuthProfileBatch: mocks.persist,
}));

vi.mock("./setup-inference-turn.js", () => ({
  runSetupInferenceTurn: mocks.turn,
}));

vi.mock("../plugins/install-record-commit.js", () => ({
  transformConfigWithPendingPluginInstalls: mocks.commit,
}));

describe("provider setup activation", () => {
  let config: OpenClawConfig;
  let login: ProviderAuthResult;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      agents: {
        entries: { main: { default: true } },
        defaults: { model: "fixture/existing" },
      },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://provider.example.invalid/v1",
            api: "openai-completions",
            models: ["existing", "starter", "chosen"].map((id) => ({
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
    login = {
      profiles: [
        {
          profileId: "fixture:saved",
          credential: { type: "api_key", provider: "fixture", key: "test-key" },
        },
      ],
      defaultModel: "fixture/starter",
    };
    mocks.persist.mockResolvedValue(undefined);
    mocks.turn.mockResolvedValue({ ok: true, latencyMs: 12 });
    mocks.commit.mockImplementation(async ({ transform }) => {
      const result = await transform(config);
      config = result.nextConfig;
      return { followUp: { requiresRestart: false } };
    });
  });

  function activate(params: {
    kind: "provider-auth" | "api-key";
    modelRef?: string;
    discovery?: boolean;
    manual?: boolean;
  }) {
    const choice: ProviderAuthChoiceMetadata = {
      pluginId: "fixture",
      providerId: "fixture",
      methodId: "login",
      choiceId: "fixture-login",
      choiceLabel: "Fixture",
      appGuidedAuth: "oauth",
      appGuidedSecret: true,
      onboardingScopes: ["text-inference"],
      ...(params.discovery ? { appGuidedDiscovery: true } : {}),
      ...(params.manual ? { optionKey: "fixtureKey", cliOption: "--fixture-key <key>" } : {}),
    };
    const method: ProviderAuthMethod = {
      id: "login",
      label: "Fixture login",
      kind: params.kind === "api-key" && !params.manual ? "api_key" : "oauth",
      run: async () => login,
      starterModel: "fixture/starter",
      wizard: { onboardingScopes: ["text-inference"] },
      ...(params.manual ? { runNonInteractive: async () => config } : {}),
      ...(params.discovery
        ? {
            appGuidedSetup: {
              detect: async () => ({ modelRef: "fixture/starter" }),
              prepare: async ({ modelRef }) => ({ profiles: [], defaultModel: modelRef }),
            },
          }
        : {}),
    };
    return activateSetupInference({
      kind: params.kind,
      modelRef: params.modelRef,
      authChoice: choice.choiceId,
      apiKey: "test-key",
      surface: "cli",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter: createWizardPrompter(),
      deps: {
        readConfigFileSnapshot: async () =>
          createConfigFileSnapshot({
            path: "/isolated/openclaw.json",
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
        resolveManifestProviderAuthChoice: () => choice,
        resolvePluginProviders: () => [
          {
            id: "fixture",
            pluginId: "fixture",
            label: "Fixture",
            auth: [method],
          },
        ],
        loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: {} }),
      },
    });
  }

  it.each([
    { kind: "provider-auth" as const },
    { kind: "api-key" as const },
    { kind: "api-key" as const, manual: true },
    { kind: "provider-auth" as const, discovery: true },
  ])("tests and commits only the explicitly selected model: %j", async (params) => {
    const result = await activate({ ...params, modelRef: "fixture/chosen" });

    expect(result).toMatchObject({ ok: true, modelRef: "fixture/chosen" });
    expect(mocks.turn).toHaveBeenCalledOnce();
    expect(mocks.turn.mock.calls[0]?.[0].route.modelLabel).toBe("fixture/chosen");
    expect(config.agents?.defaults?.model).toBe("fixture/chosen");
  });

  it("rejects a model from another provider without testing or changing the default", async () => {
    const result = await activate({ kind: "provider-auth", modelRef: "other/chosen" });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not compatible") });
    expect(mocks.turn).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(config.agents?.defaults?.model).toBe("fixture/existing");
  });

  it("keeps saved credentials and reports the unchanged default when verification fails", async () => {
    mocks.turn.mockResolvedValue({ ok: false, status: "auth", error: "Selected model denied" });

    const result = await activate({ kind: "provider-auth", modelRef: "fixture/chosen" });

    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(config.agents?.defaults?.model).toBe("fixture/existing");
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Credentials saved; default unchanged"),
    });
  });
});
