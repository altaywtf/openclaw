import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { listSessionsFromStoreAsync } from "./session-utils-list.js";
import { getSessionDefaults, projectSessionPatchResult } from "./session-utils-model.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

const sessionKey = "agent:main:catalog-projection";
const catalog: ModelCatalogEntry[] = [
  {
    provider: "catalog-provider",
    id: "runtime-model",
    name: "Runtime Model",
    reasoning: true,
    contextWindow: 128_000,
    contextWindows: [
      { id: "32k", label: "32K", contextWindow: 32_000 },
      { id: "128k", label: "128K", contextWindow: 128_000 },
    ],
    contextWindowDefault: "128k",
    thinkingLevelMap: { minimal: null, medium: null },
  },
];

function config(primary = "openai/catalog-default"): OpenClawConfig {
  return {
    agents: {
      entries: { main: {} },
      defaults: {
        model: { primary },
        models: {
          "catalog-cli/runtime-model": { agentRuntime: { id: "catalog-cli" } },
        },
      },
    },
  };
}

function sessionEntry(provider = "catalog-cli", model = "runtime-model"): SessionEntry {
  return {
    sessionId: "catalog-projection",
    updatedAt: 1,
    providerOverride: provider,
    modelOverride: model,
    modelOverrideRouteResolution: "resolved",
    thinkingLevel: "high",
    contextWindow: "32k",
  };
}

beforeEach(() => {
  const registry = createEmptyPluginRegistry();
  registry.cliBackends = [
    {
      pluginId: "catalog",
      source: "test",
      backend: {
        id: "catalog-cli",
        modelProvider: "catalog-provider",
        config: { command: "unused" },
      },
    },
    {
      pluginId: "standalone",
      source: "test",
      backend: { id: "standalone-cli", config: { command: "unused" } },
    },
  ];
  setActivePluginRegistry(registry);
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  resetPluginRuntimeStateForTest();
});

describe("public session model identity", () => {
  it("projects declared provider identity and catalog capabilities in defaults without changing runtime", () => {
    const defaults = getSessionDefaults(config("catalog-cli/runtime-model"), catalog, {
      agentId: "main",
      allowPluginNormalization: false,
      providerPolicySource: "active",
    });

    expect(defaults).toMatchObject({
      modelProvider: "catalog-provider",
      model: "runtime-model",
      contextTokens: 128_000,
      contextWindow: "128k",
      agentRuntime: { id: "catalog-cli", source: "model" },
    });
    expect(defaults.contextWindows).toEqual(catalog[0].contextWindows);
    expect(defaults.thinkingLevels?.map((level) => level.id)).toEqual(["off", "low", "high"]);
  });

  it("projects an unconfigured runtime model through the backend declaration in patch results", async () => {
    const entry = sessionEntry();
    const result = await projectSessionPatchResult({
      canonicalKey: sessionKey,
      cfg: config(),
      entry,
      modelCatalogByAgent: new Map([["main", Promise.resolve(catalog)]]),
      storePath: "/tmp/catalog-projection.sqlite",
      targetAgentId: "main",
    });

    expect(result.resolved).toMatchObject({
      modelProvider: "catalog-provider",
      model: "runtime-model",
      contextWindow: "32k",
      thinkingLevel: "high",
      agentRuntime: { id: "catalog-cli" },
    });
    expect(result.resolved.thinkingLevels?.map((level) => level.id)).toEqual([
      "off",
      "low",
      "high",
    ]);
    expect(entry.providerOverride).toBe("catalog-cli");
  });

  it.each([
    { lightweightListRow: false, override: true },
    { lightweightListRow: true, override: true },
    { lightweightListRow: false, override: false },
    { lightweightListRow: true, override: false },
  ])(
    "projects canonical identity and runtime (lightweight=$lightweightListRow, override=$override)",
    ({ lightweightListRow, override }) => {
      const entry: SessionEntry = override
        ? sessionEntry()
        : {
            sessionId: "catalog-projection",
            updatedAt: 1,
            thinkingLevel: "high",
            contextWindow: "32k",
          };
      const row = buildGatewaySessionRow({
        cfg: config(override ? "openai/catalog-default" : "catalog-cli/runtime-model"),
        storePath: "",
        store: { [sessionKey]: entry },
        key: sessionKey,
        entry,
        modelCatalog: catalog,
        lightweightListRow,
        skipTranscriptUsageFallback: true,
      });

      expect(row).toMatchObject({
        modelProvider: "catalog-provider",
        model: "runtime-model",
        contextTokens: 32_000,
        contextWindow: "32k",
        agentRuntime: { id: "catalog-cli" },
      });
    },
  );

  it("keeps list defaults and session rows on the same canonical catalog identity", async () => {
    const entry = sessionEntry();
    const result = await listSessionsFromStoreAsync({
      cfg: config("catalog-cli/runtime-model"),
      storePath: "",
      store: { [sessionKey]: entry },
      modelCatalog: catalog,
      opts: { agentId: "main" },
    });

    expect(result.defaults.modelProvider).toBe("catalog-provider");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      modelProvider: "catalog-provider",
      model: "runtime-model",
      agentRuntime: { id: "catalog-cli" },
    });
  });

  it.each([
    {
      name: "a declared runtime provider despite conflicting configured inventory",
      provider: "catalog-cli",
      model: "runtime-model",
      expectedProvider: "catalog-provider",
      expectedModel: "runtime-model",
    },
    {
      name: "an explicit qualified provider",
      provider: "catalog-cli",
      model: "other-provider/nested/runtime-model",
      expectedProvider: "other-provider",
      expectedModel: "nested/runtime-model",
    },
    {
      name: "a standalone runtime without a declared provider",
      provider: "standalone-cli",
      model: "runtime-model",
      expectedProvider: "standalone-cli",
      expectedModel: "runtime-model",
    },
    {
      name: "an explicitly qualified standalone runtime",
      provider: "catalog-cli",
      model: "standalone-cli/runtime-model",
      expectedProvider: "standalone-cli",
      expectedModel: "runtime-model",
    },
    {
      name: "an unknown provider",
      provider: "unknown-provider",
      model: "runtime-model",
      expectedProvider: "unknown-provider",
      expectedModel: "runtime-model",
    },
    {
      name: "a canonical provider with a namespaced model",
      provider: "catalog-provider",
      model: "other-provider/runtime-model",
      expectedProvider: "catalog-provider",
      expectedModel: "other-provider/runtime-model",
    },
  ])(
    "preserves $name instead of guessing from defaults",
    async ({ provider, model, expectedProvider, expectedModel }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            model: { primary: "openai/catalog-default" },
            models: { "unrelated-provider/runtime-model": {} },
          },
        },
      };
      const result = await projectSessionPatchResult({
        canonicalKey: sessionKey,
        cfg,
        entry: sessionEntry(provider, model),
        modelCatalogByAgent: new Map(),
        storePath: "/tmp/catalog-projection.sqlite",
        targetAgentId: "main",
      });

      expect(result.resolved).toMatchObject({
        modelProvider: expectedProvider,
        model: expectedModel,
      });
    },
  );
});
