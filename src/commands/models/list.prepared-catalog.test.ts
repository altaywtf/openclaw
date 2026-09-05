import { beforeEach, describe, expect, it, vi } from "vitest";
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

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

let owner: ResolvedPublishedModelCatalogOwner;

beforeEach(() => {
  vi.clearAllMocks();
  const entries = [
    {
      provider: "catalog-provider",
      id: "pinned",
      name: "Pinned Model",
      api: "anthropic-messages" as const,
      baseUrl: "https://catalog.example.test",
      input: ["text" as const],
      contextWindow: 200_000,
    },
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
  mocks.loadModelsConfigWithSource.mockResolvedValue({ resolvedConfig: owner.config });
  mocks.resolveModelsTargetAgent.mockReturnValue({
    agentId: owner.agentId,
    agentDir: owner.agentDir,
  });
  mocks.loadOwner.mockImplementation(async () => owner);
  mocks.readGatewayOwner.mockResolvedValue(undefined);
  mocks.callGateway.mockReset();
});

describe("models list transport ownership", () => {
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

  it("does not fall back locally when the running Gateway rejects the list", async () => {
    mocks.readGatewayOwner.mockResolvedValue({ pid: 123, port: 19001, createdAt: "fixture" });
    const failure = new Error("Gateway rejected catalog access");
    mocks.callGateway.mockRejectedValue(failure);

    await expect(modelsListCommand({ all: true, json: true }, runtime)).rejects.toBe(failure);

    expect(mocks.loadOwner).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("rejects an unknown local provider instead of printing another provider", async () => {
    await expect(modelsListCommand({ provider: "missing", json: true }, runtime)).rejects.toThrow(
      'Unknown provider filter "missing"',
    );

    expect(runtime.writeJson).not.toHaveBeenCalled();
  });
});
