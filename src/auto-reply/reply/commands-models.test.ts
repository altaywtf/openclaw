// Tests model command output, catalog loading, and provider auth status rendering.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedProviderAuth } from "../../agents/agent-auth-credential-modes.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  buildPreparedModelsProviderData,
  formatModelsAvailableHeader,
  handleModelsCommand,
} from "./commands-models.js";
import type { HandleCommandsParams } from "./commands-types.js";

const modelCatalogMocks = vi.hoisted(() => ({
  loadOwner:
    vi.fn<
      typeof import("../../agents/prepared-model-catalog.js").loadResolvedPublishedModelCatalogOwner
    >(),
  augmentModelCatalogWithAgentHarness: vi.fn(),
}));
const pluginMetadataMocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
}));
let catalogSnapshot: ModelCatalogSnapshot;
let authStore: AuthProfileStore;
let providerAuth: PreparedProviderAuth;
const MODELS_ADD_DEPRECATED_TEXT =
  "⚠️ /models add is deprecated. Use /models to browse providers and /model to switch models.";

function setFastModelsCliBackendDeps(): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
      {
        id: "google-gemini-cli",
        pluginId: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
        bundleMcp: false,
      },
    ],
  });
}

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadResolvedPublishedModelCatalogOwner: modelCatalogMocks.loadOwner,
}));

vi.mock("../../agents/harness/model-catalog.js", () => ({
  augmentModelCatalogWithAgentHarness: modelCatalogMocks.augmentModelCatalogWithAgentHarness,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrent,
}));

const telegramModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
  }),
  commands: {
    buildModelsProviderChannelData: ({ providers }) => ({
      telegram: {
        buttons: providers.map((provider) => [
          {
            text: provider.id,
            callback_data: `models:${provider.id}`,
          },
        ]),
      },
    }),
  },
};

const menuOnlyModelsTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "menuonly",
    label: "Menu Only",
    capabilities: {
      chatTypes: ["direct"],
      nativeCommands: true,
    },
  }),
  commands: {
    buildModelsMenuChannelData: ({ providers }) => ({
      menuonly: {
        providerIds: providers.map((provider) => provider.id),
        labels: providers.map((provider) => `${provider.id}:${provider.count}`),
      },
    }),
  },
};

const textSurfaceModelsTestPlugins = (["discord", "whatsapp"] as const).map((id) => ({
  pluginId: id,
  plugin: createChannelTestPluginBase({ id }),
  source: "test",
}));

function setModelCatalog(entries: ModelCatalogEntry[]): void {
  const routeVariants = entries.map<ModelCatalogEntry>((entry) =>
    entry.provider === "openai"
      ? { api: "openai-responses", baseUrl: "https://api.openai.com/v1", ...entry }
      : entry,
  );
  catalogSnapshot = markPreparedModelCatalogFull({
    entries: routeVariants,
    routeVariants,
    runtimeBindings: [
      { provider: "anthropic", runtime: "claude-cli" },
      { provider: "google", runtime: "google-gemini-cli" },
    ],
  });
}

function setAuthProfiles(providers: string[]): void {
  authStore = {
    version: 1,
    profiles: Object.fromEntries(
      providers.map((provider) => [
        `${provider}:test`,
        { type: "api_key" as const, provider, key: "test-provider-key" },
      ]),
    ),
  };
}

beforeEach(() => {
  setFastModelsCliBackendDeps();
  modelCatalogMocks.loadOwner.mockReset();
  modelCatalogMocks.loadOwner.mockImplementation(async (params = {}) => ({
    catalogOwner: {
      agentId: params.agentId ?? "main",
      workspaceDir: params.workspaceDir ?? "/tmp",
    },
    agentId: params.agentId ?? "main",
    agentDir: params.agentDir ?? "/tmp/models-agent",
    workspaceDir: params.workspaceDir ?? "/tmp",
    config: expectDefined(params.config, "prepared owner config"),
    modelCatalog: catalogSnapshot,
    authStore,
    providerAuth,
    metadataSnapshot: pluginMetadataMocks.getCurrent(),
    oauthRefreshProviderIds: [],
  }));
  modelCatalogMocks.augmentModelCatalogWithAgentHarness.mockClear();
  setModelCatalog([
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
  ]);
  pluginMetadataMocks.getCurrent.mockReset();
  pluginMetadataMocks.getCurrent.mockReturnValue(createPluginMetadataSnapshotFixture());
  setAuthProfiles(["anthropic", "google", "openai"]);
  providerAuth = {};
  const registry = createTestRegistry([
    ...textSurfaceModelsTestPlugins,
    {
      pluginId: "telegram",
      plugin: telegramModelsTestPlugin,
      source: "test",
    },
    {
      pluginId: "menuonly",
      plugin: menuOnlyModelsTestPlugin,
      source: "test",
    },
  ]);
  registry.cliBackends = [
    {
      pluginId: "anthropic",
      backend: {
        id: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
      },
      source: "test",
    },
    {
      pluginId: "google",
      backend: {
        id: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
      },
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

function buildParams(
  commandBodyNormalized: string,
  cfgOverrides: Partial<OpenClawConfig> = {},
): HandleCommandsParams {
  return {
    cfg: {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
      commands: {
        text: true,
      },
      ...cfgOverrides,
    } as OpenClawConfig,
    ctx: {
      Surface: "discord",
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "user-1",
      channel: "discord",
      channelId: "channel-1",
      surface: "discord",
      ownerList: [],
      from: "user-1",
      to: "bot",
    },
    sessionKey: "agent:main:discord:direct:user-1",
    workspaceDir: "/tmp",
    provider: "anthropic",
    model: "claude-opus-4-5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
  } as unknown as HandleCommandsParams;
}

describe("handleModelsCommand", () => {
  it("shows a simple providers menu on text surfaces", async () => {
    const result = await handleModelsCommand(buildParams("/models"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Providers:");
    expect(result?.reply?.text).toContain("- anthropic (2)");
    expect(result?.reply?.text).toContain("- google (1)");
    expect(result?.reply?.text).toContain("- openai (2)");
    expect(result?.reply?.text).toContain("Use: /models <provider>");
    expect(result?.reply?.text).toContain("Switch: /model <provider/model>");
    expect(result?.reply?.text).not.toContain("Add: /models add");
    expect(modelCatalogMocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp" }),
    );
  });

  it("browses published owner rows without harness discovery", async () => {
    const result = await handleModelsCommand(buildParams("/models"), true);

    expect(modelCatalogMocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(modelCatalogMocks.augmentModelCatalogWithAgentHarness).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("- openai (2)");
  });

  it("keeps all browse on the published catalog without requesting refresh", async () => {
    const params = buildParams("/models openai all");
    params.workspaceDir = "/tmp/spawned-workspace";
    await handleModelsCommand(params, true);

    expect(modelCatalogMocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        workspaceDir: "/tmp/spawned-workspace",
      }),
    );
    expect(modelCatalogMocks.loadOwner).not.toHaveBeenCalledWith(
      expect.objectContaining({ refreshFullCatalog: true }),
    );
  });

  it("hides unauthenticated providers by default and keeps all as explicit browse", async () => {
    setAuthProfiles(["anthropic"]);

    const providersResult = await handleModelsCommand(buildParams("/models"), true);
    expect(providersResult?.reply?.text).toContain("- anthropic (2)");
    expect(providersResult?.reply?.text).not.toContain("- google");
    expect(providersResult?.reply?.text).not.toContain("- openai");

    const defaultListResult = await handleModelsCommand(buildParams("/models openai"), true);
    expect(defaultListResult?.reply?.text).toContain("Unknown provider: openai");

    const allListResult = await handleModelsCommand(buildParams("/models openai all"), true);
    expect(allListResult?.reply?.text).toContain("Models (openai) — showing 1-2 of 2 (page 1/1)");
    expect(allListResult?.reply?.text).toContain("- openai/gpt-4.1");
    expect(allListResult?.reply?.text).toContain("- openai/gpt-4.1-mini");
  });

  it("does not offer an OpenAI row with a conflicting API and endpoint", async () => {
    setModelCatalog([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);

    const data = await buildPreparedModelsProviderData({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    } as OpenClawConfig);

    expect(data.byProvider.has("openai")).toBe(false);
  });

  it.each(["default", "all"] as const)(
    "retains selected route metadata for %s browse",
    async (view) => {
      authStore = {
        version: 1,
        profiles: {
          "openai:subscription": {
            type: "oauth",
            provider: "openai",
            access: "test-access",
            refresh: "test-refresh",
            expires: Date.now() + 3_600_000,
          },
        },
      };
      const selected: ModelCatalogEntry = {
        provider: "openai",
        id: "gpt-5.5",
        name: "ChatGPT GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        contextWindow: 128_000,
        thinkingLevelMap: { high: "high", xhigh: "xhigh" },
      };
      setModelCatalog([
        {
          ...selected,
          name: "Platform GPT-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 32_000,
        },
        selected,
      ]);

      const data = await buildPreparedModelsProviderData(
        {
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        } as OpenClawConfig,
        undefined,
        { view },
      );

      expect(data.byProvider.get("openai")).toEqual(new Set(["gpt-5.5"]));
      expect(data.modelNames.get("openai/gpt-5.5")).toBe("ChatGPT GPT-5.5");
      expect(data.modelCatalog.filter((entry) => entry.provider === "openai")).toEqual([selected]);
    },
  );

  it("shows plugin-normalized allowlist models in browse data", async () => {
    pluginMetadataMocks.getCurrent.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom-model-normalizer",
            modelIdNormalization: {
              providers: {
                custom: { aliases: { legacy: "modern" } },
              },
            },
          },
        ],
      }),
    );
    setModelCatalog([{ provider: "custom", id: "modern", name: "Modern" }]);
    setAuthProfiles(["custom"]);
    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "custom/modern" },
          models: { "custom/legacy": {} },
        },
      },
    } as OpenClawConfig);

    expect(data.byProvider.get("custom")).toEqual(new Set(["modern"]));
  });

  it("does not re-add the default provider when provider visibility is restricted", async () => {
    setModelCatalog([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "openai", id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
      { provider: "openai", id: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { provider: "vllm", id: "llama-local", name: "Llama Local" },
      { provider: "vllm", id: "qwen3-local", name: "Qwen3 Local" },
    ]);
    setAuthProfiles(["anthropic", "openai", "vllm"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
          },
        },
      }),
      true,
    );

    expect(modelCatalogMocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
    expect(result?.reply?.text).toContain("- openai (2)");
    expect(result?.reply?.text).toContain("- vllm (2)");
    expect(result?.reply?.text).not.toContain("- anthropic");
  });

  it("shows canonical providers without retired or CLI runtime aliases", async () => {
    setModelCatalog([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus" },
      { provider: "google-gemini-cli", id: "gemini-3.1-pro-preview", name: "Gemini Pro" },
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus" },
      { provider: "google", id: "gemini-3.1-pro-preview", name: "Gemini Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);
    setAuthProfiles(["anthropic", "google", "openai", "claude-cli", "google-gemini-cli"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- anthropic (1)");
    expect(result?.reply?.text).toContain("- google (1)");
    expect(result?.reply?.text).toContain("- openai (1)");
    expect(result?.reply?.text).not.toContain("- claude-cli (");
    expect(result?.reply?.text).not.toContain("- google-gemini-cli (");
    expect(result?.reply?.text).not.toMatch(/^- codex \(/m);
    expect(result?.reply?.text).not.toMatch(/^- codex-cli \(/m);
  });

  it("does not treat standalone CLI backends as canonical provider aliases", async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "acme-cli",
          pluginId: "acme",
          config: { command: "acme" },
          bundleMcp: false,
        },
      ],
    });
    pluginMetadataMocks.getCurrent.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "acme", cliBackends: ["acme-cli"] }],
      }),
    );
    setModelCatalog([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "acme-cli", id: "acme-model", name: "Acme Model" },
    ]);
    setAuthProfiles(["anthropic", "acme-cli"]);

    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "anthropic/*": {},
          },
        },
      },
    } as OpenClawConfig);

    expect(data.byProvider.has("acme-cli")).toBe(false);
  });

  it("keeps configured provider model lists scoped to user config", async () => {
    setModelCatalog([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "minimax", id: "abab-7", name: "Abab 7" },
      { provider: "minimax", id: "abab-6.5", name: "Abab 6.5" },
    ]);
    setAuthProfiles(["anthropic", "minimax"]);

    const minimaxData = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "minimax/abab-7": {},
          },
        },
      },
    } as OpenClawConfig);
    expect([...(minimaxData.byProvider.get("minimax") ?? [])]).toEqual(["abab-7"]);
  });

  it("does not synthesize claude-cli models when the catalog has no claude-cli entries", async () => {
    setModelCatalog([{ provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" }]);
    setAuthProfiles(["anthropic", "claude-cli"]);

    const result = await handleModelsCommand(
      buildParams("/models claude-cli", {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-7" },
          },
        },
      }),
      true,
    );

    expect(result?.reply?.text).not.toMatch(/^- claude-cli\//m);
  });

  it("hides CLI runtime providers from the picker when the user has no CLI auth", async () => {
    setModelCatalog([
      { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus 4.7 (CLI)" },
      { provider: "codex-cli", id: "gpt-5.5", name: "GPT-5.5 (CLI)" },
      { provider: "google-gemini-cli", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (CLI)" },
    ]);
    // Default mock state: only anthropic / google / openai authenticated — no CLI providers.
    setAuthProfiles(["anthropic"]);

    const result = await handleModelsCommand(
      buildParams("/models", {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7" } } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("- anthropic (");
    expect(result?.reply?.text).not.toMatch(/^- claude-cli \(/m);
    expect(result?.reply?.text).not.toMatch(/^- codex-cli \(/m);
    expect(result?.reply?.text).not.toMatch(/^- google-gemini-cli \(/m);
  });

  it("labels the OpenAI default runtime choice as Codex", async () => {
    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("openai")?.[0]).toEqual({
      id: "codex",
      label: "OpenAI Codex",
      description: "Use the OpenAI Codex runtime.",
    });
    expect(data.runtimeChoicesByProvider?.get("openai")?.[1]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("keeps custom OpenAI-compatible providers on the OpenClaw default runtime choice", async () => {
    const data = await buildPreparedModelsProviderData({
      models: {
        providers: {
          openai: {
            baseUrl: "https://openai-compatible.example.test/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("openai")?.[0]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("lets exact model runtime policy override provider runtime policy in picker choices", async () => {
    const data = await buildPreparedModelsProviderData({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("openai")?.[0]).toEqual({
      id: "codex",
      label: "OpenAI Codex",
      description: "Use the OpenAI Codex runtime.",
    });
    expect(data.runtimeChoicesByProvider?.get("openai")?.[1]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("does not apply one model's runtime override to another model's choices", async () => {
    setModelCatalog([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    ]);

    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "anthropic/claude-opus-4-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-sonnet-4-5": {},
          },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByModel?.get("anthropic/claude-opus-4-5")?.[0]).toEqual({
      id: "claude-cli",
      label: "Claude CLI",
      description: "Use the Claude CLI runtime.",
    });
    expect(data.runtimeChoicesByModel?.get("anthropic/claude-sonnet-4-5")?.[0]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("honors provider wildcard runtime policy for non-default provider picker choices", async () => {
    setModelCatalog([
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    ]);

    const data = await buildPreparedModelsProviderData({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "anthropic/*": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } as OpenClawConfig);

    expect(data.runtimeChoicesByProvider?.get("anthropic")?.[0]).toEqual({
      id: "claude-cli",
      label: "Claude CLI",
      description: "Use the Claude CLI runtime.",
    });
    expect(data.runtimeChoicesByProvider?.get("anthropic")?.[1]).toEqual({
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    });
  });

  it("filters nested provider namespaces with the same prefix policy as enforcement", async () => {
    setModelCatalog([
      { provider: "clawrouter", id: "anthropic/claude-haiku-4-5", name: "Claude Haiku" },
      { provider: "clawrouter", id: "google/gemini-3.5-flash", name: "Gemini Flash" },
      { provider: "openai", id: "catalog-model", name: "Catalog Model" },
    ]);
    setAuthProfiles(["clawrouter", "openai"]);

    const data = await buildPreparedModelsProviderData({
      agents: { defaults: { modelPolicy: { allow: ["clawrouter/anthropic/*"] } } },
    } as OpenClawConfig);

    expect(data.providers).toEqual(["clawrouter"]);
    expect([...expectDefined(data.byProvider.get("clawrouter"), "clawrouter models")]).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);
  });

  it("keeps the telegram provider picker browse-only", async () => {
    setModelCatalog([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus (CLI)" },
      { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
      { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
    ]);
    setAuthProfiles(["anthropic", "claude-cli", "google", "openai"]);
    const params = buildParams("/models");
    params.ctx.Surface = "telegram";
    params.command.channel = "telegram";
    params.command.surface = "telegram";

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toBe("Select a provider:");
    expect(result?.reply?.channelData).toEqual({
      telegram: {
        buttons: [
          [{ text: "anthropic", callback_data: "models:anthropic" }],
          [{ text: "google", callback_data: "models:google" }],
          [{ text: "openai", callback_data: "models:openai" }],
        ],
      },
    });
  });

  it("keeps plugin menu hook compatibility for provider pickers", async () => {
    setModelCatalog([
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
      { provider: "claude-cli", id: "claude-opus-4-7", name: "Claude Opus (CLI)" },
      { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
      { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
      { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
    ]);
    setAuthProfiles(["anthropic", "claude-cli", "google", "openai"]);
    const params = buildParams("/models");
    params.ctx.Surface = "menuonly";
    params.command.channel = "menuonly";
    params.command.surface = "menuonly";

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toBe("Select a provider:");
    expect(result?.reply?.channelData).toEqual({
      menuonly: {
        providerIds: ["anthropic", "google", "openai"],
        labels: ["anthropic:2", "google:1", "openai:2"],
      },
    });
  });

  it("lists models for /models <provider>", async () => {
    const result = await handleModelsCommand(buildParams("/models openai"), true);

    expect(result?.reply?.text).toContain(
      "Models (openai · 🔑 API key) — showing 1-2 of 2 (page 1/1)",
    );
    expect(result?.reply?.text).toContain("- openai/gpt-4.1");
    expect(result?.reply?.text).toContain("- openai/gpt-4.1-mini");
    expect(result?.reply?.text).toContain("Switch: /model <provider/model>");
  });

  it("does not coerce partial list page or limit tokens", async () => {
    const result = await handleModelsCommand(
      buildParams("/models openai page=2next limit=1x"),
      true,
    );

    expect(result?.reply?.text).toContain(
      "Models (openai · 🔑 API key) — showing 1-2 of 2 (page 1/1)",
    );
  });

  it("ignores unsafe bare list page tokens", async () => {
    const result = await handleModelsCommand(buildParams("/models openai 9007199254740992"), true);

    expect(result?.reply?.text).toContain(
      "Models (openai · 🔑 API key) — showing 1-2 of 2 (page 1/1)",
    );
  });

  it("does not list bare fallback models under the default provider when catalog ownership is unique", async () => {
    setModelCatalog([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ]);
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["deepseek-v4-flash", "deepseek-v4-pro"],
          },
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies Partial<OpenClawConfig>;

    const data = await buildPreparedModelsProviderData(cfg as OpenClawConfig);

    expect([...(data.byProvider.get("openai") ?? [])]).toEqual(["gpt-5.4"]);
    expect([...(data.byProvider.get("deepseek") ?? [])].toSorted()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("keeps /models list <provider> as an alias", async () => {
    const result = await handleModelsCommand(buildParams("/models list anthropic"), true);

    expect(result?.reply?.text).toContain(
      "Models (anthropic · 🔑 API key) — showing 1-2 of 2 (page 1/1)",
    );
    expect(result?.reply?.text).toContain("- anthropic/claude-opus-4-5");
  });

  it.each(["auto", "user"] as const)(
    "uses the target session's %s profile selection instead of wrapper hints",
    async (source) => {
      const params = buildParams("/models anthropic");
      params.sessionEntry = {
        sessionId: "wrapper-session",
        updatedAt: Date.now(),
        authProfileOverride: "wrapper-auth",
      };
      params.sessionStore = {
        "agent:main:discord:direct:user-1": {
          sessionId: "target-session",
          updatedAt: Date.now(),
          authProfileOverride: "target-auth",
          authProfileOverrideSource: source,
        },
      };

      const result = await handleModelsCommand(params, true);

      if (source === "auto") {
        expect(result?.reply?.text).toContain("Models (anthropic · 🔑 API key) — showing 1-2 of 2");
      } else {
        expect(result?.reply?.text).toContain("Models (anthropic) — showing 1-1 of 1");
        expect(result?.reply?.text).not.toContain("🔑 API key");
        expect(result?.reply?.text).not.toContain("anthropic/claude-sonnet-4-5");
      }
      expect(result?.reply?.text).not.toContain("target-auth");
      expect(result?.reply?.text).not.toContain("wrapper-auth");
    },
  );

  it("labels a subscription route from its prepared OAuth credential", async () => {
    authStore = {
      version: 1,
      profiles: {
        "openai:test": {
          type: "oauth",
          provider: "openai",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 3_600_000,
        },
      },
    };
    setModelCatalog([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "Subscription Model",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ]);

    const result = await handleModelsCommand(buildParams("/models openai"), true);

    expect(result?.reply?.text).toContain(
      "Models (openai · 🔑 account sign-in) — showing 1-1 of 1",
    );
    expect(result?.reply?.text).not.toContain("native sign-in");
  });

  it("does not claim native sign-in from an implicit runtime without prepared login", async () => {
    setAuthProfiles([]);
    setModelCatalog([{ provider: "openai", id: "gpt-5.5", name: "Pinned Model" }]);
    const result = await handleModelsCommand(
      buildParams("/models openai", {
        agents: { defaults: { model: "openai/gpt-5.5" } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("Models (openai) — showing 1-1 of 1");
    expect(result?.reply?.text).not.toContain("🔑");
  });

  it.each(["inline", "prepared"] as const)(
    "labels %s API credentials without inventing native sign-in",
    async (authSource) => {
      setAuthProfiles([]);
      setModelCatalog([{ provider: "catalog-provider", id: "api-model", name: "API Model" }]);
      providerAuth = authSource === "prepared" ? { "catalog-provider": { mode: "api_key" } } : {};
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "catalog-provider/api-model" } },
        ...(authSource === "inline"
          ? {
              models: {
                providers: {
                  "catalog-provider": {
                    baseUrl: "https://catalog.example.test",
                    apiKey: "test-inline-key",
                    models: [],
                  },
                },
              },
            }
          : {}),
      };

      const result = await handleModelsCommand(buildParams("/models catalog-provider", cfg), true);

      expect(result?.reply?.text).toContain(
        "Models (catalog-provider · 🔑 API key) — showing 1-1 of 1",
      );
      expect(result?.reply?.text).not.toContain("native sign-in");
    },
  );

  it("omits one provider auth label when its rows use different prepared auth", async () => {
    setAuthProfiles(["catalog-provider"]);
    providerAuth = { "catalog-runtime": { mode: "oauth" } };
    setModelCatalog([
      { provider: "catalog-provider", id: "api-model", name: "API Model" },
      {
        provider: "catalog-provider",
        id: "native-model",
        name: "Native Model",
        nativeRuntime: "catalog-runtime",
      },
    ]);
    const result = await handleModelsCommand(
      buildParams("/models catalog-provider", {
        agents: { defaults: { model: "catalog-provider/api-model" } },
      }),
      true,
    );

    expect(result?.reply?.text).toContain("Models (catalog-provider) — showing 1-2 of 2");
    expect(result?.reply?.text).not.toContain("🔑");
  });

  it("keeps public header arguments without deriving auth from them", () => {
    const params = {
      provider: "openai",
      total: 2,
      cfg: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      agentId: "main",
      agentDir: "/tmp/models-agent",
      workspaceDir: "/tmp/models-workspace",
      sessionEntry: { authProfileOverride: "unprepared-profile" },
    };
    expect(formatModelsAvailableHeader(params)).toBe("Models (openai) — 2 available");
    expect(formatModelsAvailableHeader({ ...params, authLabel: "account sign-in" })).toBe(
      "Models (openai · 🔑 account sign-in) — 2 available",
    );
  });

  it("uses spawned workspace for direct /models provider visibility", async () => {
    setAuthProfiles(["anthropic"]);
    const params = buildParams("/models");
    params.workspaceDir = "/tmp/current-workspace";
    params.sessionStore = {
      "agent:main:discord:direct:user-1": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        spawnedWorkspaceDir: "/tmp/spawned-workspace",
      },
    };

    const result = await handleModelsCommand(params, true);

    expect(result?.reply?.text).toContain("- anthropic (2)");
    expect(modelCatalogMocks.loadOwner).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/spawned-workspace" }),
    );
  });

  it.each(["/models add", "/models add ollama", "/models add openai gpt-5.5"])(
    "returns a deprecation message for %s",
    async (command) => {
      const result = await handleModelsCommand(buildParams(command), true);
      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: MODELS_ADD_DEPRECATED_TEXT },
      });
    },
  );
});
