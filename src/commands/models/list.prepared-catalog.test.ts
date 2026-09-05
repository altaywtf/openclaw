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
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("models list prepared catalog boundary", () => {
  it("discovers and filters provider inventory without requiring --all", async () => {
    await modelsListCommand({ provider: "catalog-provider", json: true }, runtime);

    expect(mocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: false, refreshFullCatalog: true }),
    );
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

      expect(mocks.loadOwner).toHaveBeenLastCalledWith(
        expect.objectContaining({ readOnly: false, refreshFullCatalog: true }),
      );
      expect(runtime.writeJson).toHaveBeenLastCalledWith(
        expect.objectContaining({ models: expect.arrayContaining([expectedRow]) }),
        2,
      );
    },
  );

  it("keeps replace-mode default output limited to authored provider models", async () => {
    const pinned = owner.modelCatalog.entries[0]!;
    const outside: ModelCatalogEntry = {
      provider: "catalog-provider",
      id: "outside-replacement",
      name: "Outside Replacement",
      api: "anthropic-messages",
      baseUrl: "https://catalog.example.test",
      input: ["text"],
      contextWindow: 32_000,
    };
    owner.config = {
      agents: {
        defaults: {
          model: {
            primary: "catalog-provider/pinned",
            fallbacks: ["catalog-provider/outside-replacement"],
          },
        },
        entries: { main: {} },
      },
      models: {
        mode: "replace",
        providers: {
          "catalog-provider": {
            api: "anthropic-messages",
            baseUrl: "https://catalog.example.test",
            models: [
              {
                id: "pinned",
                name: pinned.name,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };
    owner.modelCatalog = markPreparedModelCatalogFull({
      entries: [pinned],
      routeVariants: [pinned, outside],
      staticEntries: [outside],
    });

    await modelsListCommand({ json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenLastCalledWith(
      { count: 1, models: [expect.objectContaining({ key: "catalog-provider/pinned" })] },
      2,
    );
    expect(mocks.loadOwner).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

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

      expect(mocks.loadOwner).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: false, refreshFullCatalog: true }),
      );
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
