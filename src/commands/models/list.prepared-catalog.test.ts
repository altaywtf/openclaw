import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ResolvedPublishedModelCatalogOwner } from "../../agents/prepared-model-catalog.types.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  loadOwner:
    vi.fn<
      typeof import("../../agents/prepared-model-catalog.js").loadResolvedPublishedModelCatalogOwner
    >(),
  loadModelsConfigWithSource: vi.fn(),
  resolveModelsTargetAgent: vi.fn(),
  readGatewayOwner: vi.fn(),
  callGateway: vi.fn(),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: mocks.readGatewayOwner,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isImplicitLocalGatewayTarget: async () => true,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfigWithSource: mocks.loadModelsConfigWithSource,
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadResolvedPublishedModelCatalogOwner: mocks.loadOwner,
}));

vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveModelsTargetAgent: mocks.resolveModelsTargetAgent,
}));

import { modelsListCommand } from "./list.list-command.js";

let owner: ResolvedPublishedModelCatalogOwner;
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
  const entries: ModelCatalogEntry[] = [
    {
      provider: "catalog-provider",
      id: "pinned",
      name: "Pinned Model",
      api: "anthropic-messages",
      baseUrl: "https://catalog.example.test",
      input: ["text"],
      contextWindow: 200_000,
    },
    { provider: "catalog-provider", id: "discovered", name: "Discovered Model" },
    { provider: "another", id: "other-model", name: "Other Model" },
  ];
  owner = {
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/openclaw-workspace" },
    agentId: "main",
    agentDir: "/tmp/openclaw-agent",
    workspaceDir: "/tmp/openclaw-workspace",
    config: {
      agents: { defaults: { model: { primary: "catalog-provider/pinned" } } },
    },
    providerAuth: {},
    authStore: {
      version: 1,
      profiles: {
        "catalog-provider:test": {
          type: "api_key",
          provider: "catalog-provider",
          key: "test-provider-key",
        },
      },
    },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    oauthRefreshProviderIds: [],
    modelCatalog: markPreparedModelCatalogFull({ entries, routeVariants: entries }),
  };
  mocks.loadModelsConfigWithSource.mockImplementation(async () => ({
    resolvedConfig: owner.config,
  }));
  mocks.resolveModelsTargetAgent.mockReturnValue({
    agentId: owner.agentId,
    agentDir: owner.agentDir,
  });
  mocks.loadOwner.mockImplementation(async () => owner);
  mocks.readGatewayOwner.mockResolvedValue(undefined);
  mocks.callGateway.mockReset();
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("models list prepared catalog boundary", () => {
  it.each([false, true])("uses the running Gateway inventory with refresh=%s", async (refresh) => {
    mocks.readGatewayOwner.mockResolvedValue({ pid: 123, port: 19001, createdAt: "fixture" });
    mocks.callGateway.mockResolvedValue({
      models: [
        {
          provider: "catalog-provider",
          id: "account-only",
          name: "Account-only model",
          input: ["text", "image"],
          contextWindow: 128_000,
          contextTokens: 64_000,
          local: true,
          available: true,
          tags: ["default"],
        },
      ],
    });
    await modelsListCommand(
      { agent: "main", provider: "catalog-provider", local: true, json: true, refresh },
      runtime,
    );
    expect(mocks.loadOwner).not.toHaveBeenCalled();
    expect(mocks.resolveModelsTargetAgent).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "models.list",
        params: {
          agentId: "main",
          view: "all",
          provider: "catalog-provider",
          includeDetails: true,
          ...(refresh ? { refresh: true } : {}),
        },
      }),
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        count: 1,
        models: [
          {
            key: "catalog-provider/account-only",
            name: "Account-only model",
            input: "text+image",
            contextWindow: 128_000,
            contextTokens: 64_000,
            local: true,
            available: true,
            tags: ["default"],
          },
        ],
      },
      2,
    );
  });

  it("runs standalone discovery only for an explicit refresh", async () => {
    await modelsListCommand({ all: true, refresh: true, json: true }, runtime);
    expect(mocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: false, refreshFullCatalog: true }),
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("does not fall back to local inference when the running Gateway rejects a list", async () => {
    mocks.readGatewayOwner.mockResolvedValue({ pid: 123, port: 19001, createdAt: "fixture" });
    const failure = new Error("Gateway rejected catalog access");
    mocks.callGateway.mockRejectedValue(failure);
    await expect(modelsListCommand({ all: true, json: true }, runtime)).rejects.toBe(failure);
    expect(mocks.loadOwner).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("filters published provider inventory without requiring --all", async () => {
    await modelsListCommand({ provider: "catalog-provider", json: true }, runtime);

    expect(mocks.loadOwner).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        count: 2,
        models: [
          expect.objectContaining({ key: "catalog-provider/discovered", available: true }),
          expect.objectContaining({ key: "catalog-provider/pinned", available: true }),
        ],
      },
      2,
    );
  });

  it("shows only authenticated or configured rows on ordinary reads without full discovery", async () => {
    await modelsListCommand({ json: true }, runtime);

    expect(mocks.loadOwner).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
    expect(mocks.loadOwner.mock.calls[0]?.[0]).not.toHaveProperty("refreshFullCatalog");
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        count: 2,
        models: [
          expect.objectContaining({ key: "catalog-provider/discovered", available: true }),
          {
            key: "catalog-provider/pinned",
            name: "Pinned Model",
            input: "text",
            contextWindow: 200_000,
            local: false,
            available: true,
            tags: ["default"],
          },
        ],
      },
      2,
    );
  });

  it.each([
    { view: "all", provider: "catalog-provider", cli: false },
    { view: "provider", provider: "catalog-provider", cli: false },
    { view: "all", provider: "fixture-cli", cli: true },
    { view: "provider", provider: "fixture-cli", cli: true },
  ])(
    "keeps same-generation static rows in $view browse (CLI: $cli)",
    async ({ view, provider, cli }) => {
      const staticModel: ModelCatalogEntry = {
        provider,
        id: cli ? "cli-model" : "static-fallback",
        name: cli ? "Prepared CLI Model" : "Prepared Static Fallback",
        api: "openai-completions",
        baseUrl: cli ? "cli://fixture" : "https://catalog.example.test/v1",
        contextWindow: 64_000,
        input: ["text", "image"],
      };
      owner.config.agents = {
        defaults: {
          model: {
            primary: "catalog-provider/pinned",
            fallbacks: [`${provider}/${staticModel.id}`],
          },
        },
        entries: { main: {} },
      };
      if (cli) {
        cliBackendsTesting.setDepsForTest({
          resolveRuntimeCliBackends: () => [
            { id: provider, pluginId: "fixture", config: { command: "fixture-cli" } },
          ],
          resolvePluginSetupRegistry: () => ({
            providers: [],
            cliBackends: [],
            configMigrations: [],
            autoEnableProbes: [],
            diagnostics: [],
          }),
        });
        owner.authStore.profiles["fixture-cli:test"] = {
          type: "api_key",
          provider,
          key: "fixture-cli-key",
        };
        owner.config.models = {
          providers: {
            [provider]: {
              api: "openai-completions",
              baseUrl: "cli://fixture",
              models: [
                {
                  id: staticModel.id,
                  name: staticModel.name,
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 64_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        };
      }
      const liveEntries = owner.modelCatalog.entries;
      const routeVariants = [...liveEntries, staticModel];
      const configuredOwner: ResolvedPublishedModelCatalogOwner = {
        ...owner,
        modelCatalog: {
          entries: [...liveEntries, staticModel],
          routeVariants,
          staticEntries: [staticModel],
        },
      };
      const fullOwner: ResolvedPublishedModelCatalogOwner = {
        ...owner,
        modelCatalog: markPreparedModelCatalogFull({
          entries: liveEntries,
          routeVariants: liveEntries,
          staticEntries: [staticModel],
        }),
      };
      mocks.loadOwner.mockImplementation(async (params) =>
        params?.readOnly ? configuredOwner : fullOwner,
      );
      const expectedRow = expect.objectContaining({
        key: `${provider}/${staticModel.id}`,
        name: staticModel.name,
        contextWindow: 64_000,
        input: "text+image",
        available: true,
      });

      await modelsListCommand({ json: true }, runtime);
      expect(runtime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ models: expect.arrayContaining([expectedRow]) }),
        2,
      );

      await modelsListCommand(
        { json: true, ...(view === "all" ? { all: true } : { provider }) },
        runtime,
      );

      expect(mocks.loadOwner).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }));
      expect(runtime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ models: expect.arrayContaining([expectedRow]) }),
        2,
      );
    },
  );

  it.each([
    { credential: "unknown", available: null },
    { credential: "expired", available: false },
  ])(
    "keeps $credential auth inventory visible in explicit all browse",
    async ({ credential, available }) => {
      if (credential === "expired") {
        owner.authStore.profiles["another:test"] = {
          type: "token",
          provider: "another",
          token: "test-expired-token",
          expires: 1,
        };
      }
      await modelsListCommand({ all: true, json: true }, runtime);

      expect(mocks.loadOwner).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
      expect(runtime.writeJson).toHaveBeenCalledWith(
        {
          count: 3,
          models: [
            expect.objectContaining({ key: "another/other-model", available }),
            expect.objectContaining({ key: "catalog-provider/discovered", available: true }),
            expect.objectContaining({ key: "catalog-provider/pinned", available: true }),
          ],
        },
        2,
      );
    },
  );

  it("reports rejected provider credentials rather than treating their presence as availability", async () => {
    owner.modelCatalog.providerOutcomes = [
      {
        provider: "catalog-provider",
        status: "auth-rejected",
        profileId: "catalog-provider:test",
      },
    ];

    await modelsListCommand({ provider: "catalog-provider", json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        count: 2,
        models: [
          expect.objectContaining({ key: "catalog-provider/discovered", available: false }),
          expect.objectContaining({ key: "catalog-provider/pinned", available: false }),
        ],
      },
      2,
    );
  });

  it("rejects an unknown provider instead of printing another provider's models", async () => {
    await expect(modelsListCommand({ provider: "missing", json: true }, runtime)).rejects.toThrow(
      'Unknown provider filter "missing"',
    );
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });
});
