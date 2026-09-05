import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { createModelCatalogFastModeResolver } from "./model-catalog-capabilities.js";
import {
  findModelCatalogEntry,
  findModelInCatalog,
  prepareModelRunCapabilities,
} from "./model-catalog-lookup.js";
import { assignProviderModelOrder } from "./model-catalog-order.js";
import { resolveConfiguredModelCatalogOverrides } from "./model-catalog-route.js";
import { prepareModelCatalogView } from "./model-catalog-view.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";

const modelDefaults = {
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 4096,
};
const baseUrl = "https://sample.example/v1";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  {
    name: "local without credentials",
    baseUrl: "http://127.0.0.1:11434",
    auth: undefined,
    available: true,
  },
  {
    name: "remote without credentials",
    baseUrl: "https://ollama.example.com",
    auth: undefined,
    available: false,
  },
  {
    name: "local with explicit auth",
    baseUrl: "http://127.0.0.1:11434",
    auth: "token" as const,
    available: false,
  },
])("keeps Ollama availability scoped to its route: $name", async ({ baseUrl, auth, available }) => {
  const entry: ModelCatalogEntry = {
    provider: "ollama",
    id: "qwen3.5",
    name: "Qwen 3.5",
    api: "ollama",
    baseUrl,
  };
  const view = await prepareModelCatalogView({
    cfg: {
      agents: { defaults: { models: { "ollama/qwen3.5": {} } } },
      ...(auth ? { models: { providers: { ollama: { baseUrl, models: [], auth } } } } : {}),
    },
    agentId: "main",
    workspaceDir: "/tmp/ollama-catalog-view",
    snapshot: { entries: [entry], routeVariants: [entry] },
    catalogComplete: true,
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [{ id: "ollama", providers: ["ollama"], syntheticAuthRefs: ["ollama"] }],
    }),
    auth: { authStore: { version: 1, profiles: {} }, providerAuth: {} },
    env: {},
    view: "configured",
  });

  expect(view.entries).toHaveLength(1);
  expect(view.evaluate(entry).availability === true).toBe(available);
});

const fastModeEntry: ModelCatalogEntry = {
  provider: "sample",
  id: "fast-model",
  name: "Fast model",
  api: "openai-responses",
  baseUrl,
};
const fastModeEvaluation: ModelAuthAvailabilityEvaluation = {
  availability: true,
  routeResolution: null,
  selectedAuthMode: "api_key",
};
const fastModeRuntime: GatewayAgentRuntime = { id: "fixture-runtime", source: "model" };

function createFastModeMetadataSnapshot(params: {
  endpointClass: "custom" | "openai-public";
  policyBody?: string;
}) {
  const rootDir = tempDirs.make("openclaw-model-catalog-view-");
  if (params.policyBody) {
    fs.writeFileSync(
      path.join(rootDir, "provider-policy-api.js"),
      `export function resolveFastModeCapability(context) {
        ${params.policyBody}
      }`,
    );
  }
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "sample-policy",
        origin: "global",
        trustedOfficialInstall: true,
        rootDir,
        providers: ["sample"],
        providerEndpoints: [{ endpointClass: params.endpointClass, hosts: ["sample.example"] }],
      },
    ],
  });
}

function prepareFastModeResolver(params: {
  endpointClass: "custom" | "openai-public";
  policyBody?: string;
}) {
  const metadataSnapshot = createFastModeMetadataSnapshot(params);
  const resolve = createModelCatalogFastModeResolver({
    cfg: {},
    agentId: "main",
    entries: [fastModeEntry],
    metadataSnapshot,
  });
  return () =>
    resolve({
      entry: fastModeEntry,
      evaluation: fastModeEvaluation,
      runtime: fastModeRuntime,
    });
}

describe("case-sensitive model catalog identity", () => {
  it("retains both configured IDs with their distinct names and context limits", async () => {
    const models: ModelDefinitionConfig[] = [
      { ...modelDefaults, id: "Model-A", name: "Uppercase model", contextWindow: 32_000 },
      { ...modelDefaults, id: "model-a", name: "Lowercase model", contextWindow: 64_000 },
    ];
    const entries: ModelCatalogEntry[] = models.map((model) => ({
      ...model,
      provider: "sample",
      api: "openai-completions",
      baseUrl,
    }));
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "sample/Model-A",
          models: { "sample/Model-A": {}, "sample/model-a": {} },
        },
      },
      models: { providers: { sample: { api: "openai-completions", baseUrl, models } } },
    };

    const view = await prepareModelCatalogView({
      cfg,
      agentId: "main",
      workspaceDir: "/tmp/model-catalog-identity",
      snapshot: { entries, routeVariants: entries },
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      auth: {
        authStore: {
          version: 1,
          profiles: {
            "sample:fixture": { type: "api_key", provider: "sample", key: "synthetic-sample-key" },
          },
        },
        providerAuth: {},
      },
      env: {},
      view: "configured",
    });

    expect(view.entries).toHaveLength(2);
    expect(view.entries.map((entry) => view.evaluate(entry).routeResolution)).toEqual([null, null]);
    expect(view.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Model-A", name: "Uppercase model", contextWindow: 32_000 }),
        expect.objectContaining({ id: "model-a", name: "Lowercase model", contextWindow: 64_000 }),
      ]),
    );
  });

  it("applies runtime capabilities only to the matching case", () => {
    const entries: ModelCatalogEntry[] = [
      { provider: "sample", id: "Model-A", name: "Uppercase model", reasoning: false },
      { provider: "sample", id: "model-a", name: "Lowercase model", reasoning: false },
    ];

    const catalog = materializePreparedModelCatalog({ entries, routeVariants: entries }, [
      {
        provider: "sample",
        modelId: "model-a",
        model: {
          ...modelDefaults,
          provider: "sample",
          id: "model-a",
          name: "Runtime model",
          api: "openai-completions",
          baseUrl,
          contextWindow: 128_000,
          reasoning: true,
          compat: { supportsTools: true },
        },
      },
    ]);

    expect(catalog.entries).toEqual([
      { provider: "sample", id: "Model-A", name: "Uppercase model", reasoning: false },
      expect.objectContaining({
        id: "model-a",
        name: "Lowercase model",
        reasoning: true,
        compat: { supportsTools: true },
      }),
    ]);
  });

  it("does not borrow configured metadata or limits from a differently cased ID", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          sample: {
            baseUrl,
            models: [
              {
                ...modelDefaults,
                id: "Model-A",
                name: "Configured uppercase",
                contextWindow: 32_000,
                contextTokens: 16_000,
              },
              {
                ...modelDefaults,
                id: "model-a",
                name: "Configured lowercase",
                contextWindow: 128_000,
                contextTokens: 64_000,
                reasoning: true,
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    };

    expect(
      resolveConfiguredModelCatalogOverrides({ cfg, entry: { provider: "sample", id: "Model-A" } }),
    ).toEqual({
      name: "Configured uppercase",
      contextWindow: 32_000,
      contextTokens: 16_000,
      reasoning: false,
      configuredReasoning: false,
      input: ["text"],
    });
    expect(
      resolveConfiguredModelCatalogOverrides({ cfg, entry: { provider: "sample", id: "model-a" } }),
    ).toEqual({
      name: "Configured lowercase",
      contextWindow: 128_000,
      contextTokens: 64_000,
      reasoning: true,
      configuredReasoning: true,
      input: ["text", "image"],
    });
  });

  it("retains independent provider order for case-distinct IDs", () => {
    const upper = { provider: "sample", id: "Model-A", name: "Uppercase model" };
    const lower = { provider: "sample", id: "model-a", name: "Lowercase model" };

    const ordered = assignProviderModelOrder(
      [upper, lower],
      [
        { ...upper, providerOrder: 5 },
        { ...lower, providerOrder: 2 },
      ],
    );

    expect(ordered.map(({ id, providerOrder }) => ({ id, providerOrder }))).toEqual([
      { id: "Model-A", providerOrder: 5 },
      { id: "model-a", providerOrder: 2 },
    ]);
  });

  describe("catalog lookup", () => {
    const upper: ModelCatalogEntry = {
      provider: "sample",
      id: "Model-A",
      name: "Uppercase model",
      input: ["text", "image"],
    };
    const lower: ModelCatalogEntry = {
      provider: "sample",
      id: "model-a",
      name: "Lowercase model",
      input: ["text"],
    };

    it.each([
      {
        name: "prefers the exact lowercase identity",
        catalog: [upper, lower],
        modelId: "model-a",
        expectedId: "model-a",
        vision: false,
      },
      {
        name: "rejects ambiguous case-insensitive matches",
        catalog: [upper, lower],
        modelId: "MODEL-A",
        expectedId: undefined,
        vision: false,
      },
      {
        name: "retains a unique legacy case-insensitive match",
        catalog: [upper],
        modelId: "MODEL-A",
        expectedId: "Model-A",
        vision: true,
      },
    ])("$name", ({ catalog, modelId, expectedId, vision }) => {
      expect(findModelInCatalog(catalog, "sample", modelId)?.id).toBe(expectedId);
      expect(
        prepareModelRunCapabilities([catalog, []], ["sample", modelId, "openclaw"]).modelHasVision,
      ).toBe(vision);
    });

    it("prefers the exact case when the provider is omitted", () => {
      expect(findModelCatalogEntry([upper, lower], { modelId: "model-a" })).toMatchObject({
        id: "model-a",
        input: ["text"],
      });
    });
  });
});

describe("captured model catalog capabilities", () => {
  it.each([
    {
      state: "present",
      firstPolicy: "return true;",
      secondPolicy: "return false;",
      firstExpected: true,
      secondExpected: false,
    },
    {
      state: "missing",
      firstPolicy: undefined,
      secondPolicy: "return true;",
      firstExpected: undefined,
      secondExpected: true,
    },
  ])(
    "keeps a captured $state provider policy unchanged across generations",
    ({ firstPolicy, secondPolicy, firstExpected, secondExpected }) => {
      const first = prepareFastModeResolver({
        endpointClass: "openai-public",
        policyBody: firstPolicy,
      });
      const second = prepareFastModeResolver({
        endpointClass: "openai-public",
        policyBody: secondPolicy,
      });

      expect(second()).toBe(secondExpected);
      expect(first()).toBe(firstExpected);
    },
  );

  it("keeps endpoint classification bound to the captured metadata generation", () => {
    const policyBody = 'return context.endpointClass === "openai-public";';
    const first = prepareFastModeResolver({ endpointClass: "openai-public", policyBody });
    const second = prepareFastModeResolver({ endpointClass: "custom", policyBody });

    expect(second()).toBe(false);
    expect(first()).toBe(true);
  });

  it("forwards final parameter precedence without inventing missing route or auth facts", () => {
    const metadataSnapshot = createFastModeMetadataSnapshot({
      endpointClass: "openai-public",
      policyBody: `
        if (
          context.modelId === "configured-model" &&
          context.api === "openai-completions" &&
          context.baseUrl === "https://sample.example/v1" &&
          context.endpointClass === "openai-public" &&
          context.agentRuntime === "fixture-runtime" &&
          context.authRequirement === "api-key" &&
          context.requestTransportOverrides === "present" &&
          context.params?.serviceTier === "agent" &&
          context.params?.entryOnly === true &&
          context.params?.defaultOnly === true &&
          context.params?.modelOnly === true &&
          context.params?.agentOnly === true
        ) return true;
        if (
          context.modelId === "missing-model" &&
          context.api === undefined &&
          context.baseUrl === undefined &&
          context.endpointClass === undefined &&
          context.authRequirement === undefined &&
          context.requestTransportOverrides === undefined &&
          context.params === undefined
        ) return true;
        return undefined;
      `,
    });
    const configuredEntry: ModelCatalogEntry = {
      ...fastModeEntry,
      id: "configured-model",
      params: { serviceTier: "entry", entryOnly: true },
    };
    const selectedRoute: ProviderModelRouteCandidate = {
      api: "openai-completions",
      baseUrl,
      authRequirement: "api-key",
      requestTransportOverrides: "present",
    };
    const configured = createModelCatalogFastModeResolver({
      cfg: {
        agents: {
          defaults: {
            params: { serviceTier: "default", defaultOnly: true },
            models: {
              "sample/configured-model": {
                params: { serviceTier: "model", modelOnly: true },
              },
            },
          },
          list: [{ id: "main", params: { serviceTier: "agent", agentOnly: true } }],
        },
      },
      agentId: "main",
      entries: [configuredEntry],
      metadataSnapshot,
    });
    expect(
      configured({
        entry: configuredEntry,
        evaluation: {
          availability: true,
          routeResolution: { kind: "routes", routes: [selectedRoute] },
          selectedRoute,
          selectedAuthMode: "oauth",
        },
        runtime: fastModeRuntime,
      }),
    ).toBe(true);

    const missingEntry = { provider: "sample", id: "missing-model", name: "Missing facts model" };
    const missing = createModelCatalogFastModeResolver({
      cfg: {},
      agentId: "main",
      entries: [missingEntry],
      metadataSnapshot,
    });
    expect(
      missing({
        entry: missingEntry,
        evaluation: { availability: undefined, routeResolution: null },
        runtime: fastModeRuntime,
      }),
    ).toBe(true);
  });
});
