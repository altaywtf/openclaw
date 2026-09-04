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
