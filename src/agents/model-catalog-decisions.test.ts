import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import { setRuntimeExternalCliProfileIds } from "./auth-profiles/runtime-external-profile-references.js";
import * as harnessPolicy from "./harness/policy.js";
import { getPreparedModelCatalogDecisions } from "./model-catalog-decisions.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  openAIModelRoutesMock,
  platformRoute,
  subscriptionRoute,
} from "./openai-model-routes.test-support.js";
import {
  getPreparedModelRuntimePublicationRevision,
  notifyPreparedModelRuntimePublication,
  registerPreparedModelRuntimePublicationListener,
  resetPreparedModelRuntimePublicationListenersForTest,
} from "./prepared-model-runtime.publication-events.js";

vi.mock("./openai-model-routes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openai-model-routes.js")>()),
  createOpenAIModelRoutesResolver:
    () => (ref: { observedRoutes?: readonly { api?: string | null; baseUrl?: unknown }[] }) => {
      if (openAIModelRoutesMock.resolution !== undefined) {
        return openAIModelRoutesMock.resolution;
      }
      const routes = [platformRoute, subscriptionRoute].filter((route) =>
        ref.observedRoutes?.some(
          (observed) => observed.api === route.api && observed.baseUrl === route.baseUrl,
        ),
      );
      return routes.length ? { kind: "routes", defaultRuntimeId: "codex", routes } : null;
    },
}));

type DecisionFacts = Parameters<typeof getPreparedModelCatalogDecisions>[0];

const platform: ModelCatalogEntry = {
  provider: "openai",
  id: "catalog-model",
  name: "Catalog model",
  api: platformRoute.api,
  baseUrl: platformRoute.baseUrl,
};
const subscription: ModelCatalogEntry = {
  ...platform,
  api: subscriptionRoute.api,
  baseUrl: subscriptionRoute.baseUrl,
};

function createFacts(): DecisionFacts {
  return {
    cfg: { agents: { defaults: { model: "openai/catalog-model" } } },
    agentId: "main",
    workspaceDir: "/tmp/model-catalog-decisions",
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    snapshot: { entries: [platform], routeVariants: [platform, subscription] },
    auth: {
      authStore: {
        version: 1,
        profiles: {
          "openai:platform": { provider: "openai", type: "api_key", key: "fixture-key" },
          "openai:subscription": {
            provider: "openai",
            type: "oauth",
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
      providerAuth: {},
    },
    authMaterializations: [],
    catalogComplete: true,
    env: {},
  };
}

afterEach(() => {
  openAIModelRoutesMock.resolution = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("prepared catalog decision ownership", () => {
  it("shares one source across wrappers of the same published facts", async () => {
    const facts = createFacts();
    const first = getPreparedModelCatalogDecisions(facts);
    const second = getPreparedModelCatalogDecisions({
      ...facts,
      snapshot: { ...facts.snapshot },
      auth: { ...facts.auth },
    });
    expect(second).toBe(first);
    expect(second.evaluate({ ...platform, api: subscription.api })).toBe(first.evaluate(platform));
    expect(first.isCurrent()).toBe(true);
  });

  it("shares one source when readers allocate fresh empty materialization arrays", () => {
    const facts = createFacts();
    const first = getPreparedModelCatalogDecisions({ ...facts, authMaterializations: undefined });
    expect(getPreparedModelCatalogDecisions({ ...facts, authMaterializations: [] })).toBe(first);
    expect(
      getPreparedModelCatalogDecisions({ ...facts, authMaterializations: Object.freeze([]) }),
    ).toBe(first);
  });

  it.each(["agent", "workspace", "config", "metadata", "outcomes", "completeness"] as const)(
    "separates sources with different %s facts",
    (changed) => {
      const facts = createFacts();
      const first = getPreparedModelCatalogDecisions(facts);
      const next = {
        ...facts,
        ...(changed === "agent" ? { agentId: "other" } : {}),
        ...(changed === "workspace" ? { workspaceDir: "/tmp/other-catalog-owner" } : {}),
        ...(changed === "config" ? { cfg: { ...facts.cfg } } : {}),
        ...(changed === "metadata"
          ? { metadataSnapshot: createPluginMetadataSnapshotFixture() }
          : {}),
        ...(changed === "outcomes"
          ? {
              snapshot: {
                ...facts.snapshot,
                providerOutcomes: [{ provider: "openai", status: "auth-rejected" as const }],
              },
            }
          : {}),
        ...(changed === "completeness" ? { catalogComplete: false } : {}),
      };
      expect(getPreparedModelCatalogDecisions(next)).not.toBe(first);
    },
  );

  it("replaces the source after auth publication without changing the original decision", async () => {
    const facts = createFacts();
    const first = getPreparedModelCatalogDecisions(facts);
    facts.auth.authStore.profiles = {};
    expect(await first.evaluate(platform)).toMatchObject({ availability: true });

    notifyPreparedModelRuntimePublication({ phase: "published" });
    const second = getPreparedModelCatalogDecisions(facts);
    expect(first.isCurrent()).toBe(false);
    expect(second).not.toBe(first);
    expect(second.isCurrent()).toBe(true);
    expect((await second.evaluate(platform)).availability).not.toBe(true);
    expect(await first.evaluate(platform)).toMatchObject({ availability: true });
  });

  it("captures materializations and replaces them through publication", async () => {
    const facts = createFacts();
    facts.auth.authStore.profiles = {};
    const materializations: NonNullable<DecisionFacts["authMaterializations"]>[number][] = [];
    facts.authMaterializations = materializations;
    const first = getPreparedModelCatalogDecisions(facts);
    materializations.push({
      provider: "openai",
      modelId: platform.id,
      modelApi: platformRoute.api,
      modelBaseUrl: platformRoute.baseUrl,
      requestTransportOverrides: "none",
      authMode: "api_key",
      runtimeOwnerId: "codex",
    });
    expect((await first.evaluate(platform)).availability).not.toBe(true);

    notifyPreparedModelRuntimePublication({ phase: "invalidated" });
    notifyPreparedModelRuntimePublication({ phase: "published" });
    const second = getPreparedModelCatalogDecisions(facts);
    expect(first.isCurrent()).toBe(false);
    expect(await second.evaluate(platform)).toMatchObject({
      availability: true,
      runtimeAuth: { id: "codex", source: "materialized" },
    });
  });

  it("increments publication revision before listeners and survives listener resets", () => {
    const first = getPreparedModelCatalogDecisions(createFacts());
    const initial = getPreparedModelRuntimePublicationRevision();
    const observed: Array<{ revision: number; current: boolean }> = [];
    const release = registerPreparedModelRuntimePublicationListener(() => {
      observed.push({
        revision: getPreparedModelRuntimePublicationRevision(),
        current: first.isCurrent(),
      });
    });
    try {
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      expect(observed).toEqual([{ revision: initial + 1, current: false }]);
      resetPreparedModelRuntimePublicationListenersForTest();
      expect(getPreparedModelRuntimePublicationRevision()).toBe(initial + 1);
      notifyPreparedModelRuntimePublication({ phase: "published" });
      expect(getPreparedModelRuntimePublicationRevision()).toBe(initial + 2);
      expect(observed).toHaveLength(1);
    } finally {
      release();
    }
  });

  it.each([false, true])(
    "owns the complete physical route group with reverse=%s",
    async (reverse) => {
      const facts = createFacts();
      facts.snapshot.routeVariants = reverse ? [subscription, platform] : [platform, subscription];
      const source = getPreparedModelCatalogDecisions(facts);
      const context = { lockedProfileId: "openai:subscription" };
      const result = await source.evaluate(platform, context);
      expect(result).toMatchObject({
        availability: true,
        selectedProfileId: context.lockedProfileId,
        selectedRoute: subscriptionRoute,
      });
      expect(await source.evaluate(subscription, context)).toBe(result);
    },
  );

  it.each(["static", "configured"] as const)(
    "owns %s rows absent from the live catalog",
    async (kind) => {
      const facts = createFacts();
      facts.snapshot = {
        entries: [],
        routeVariants: [],
        ...(kind === "static" ? { staticEntries: [platform] } : {}),
      };
      if (kind === "configured") {
        facts.cfg.models = {
          providers: {
            openai: {
              api: platformRoute.api,
              baseUrl: platformRoute.baseUrl,
              models: [
                {
                  id: platform.id,
                  name: platform.name,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 1024,
                },
              ],
            },
          },
        };
      }
      expect(
        await getPreparedModelCatalogDecisions(facts).evaluate({
          ...subscription,
          nativeRuntime: "unowned-runtime",
        }),
      ).toMatchObject({ availability: true, selectedRoute: platformRoute });
    },
  );

  it("does not let an inventory subset poison the canonical decision source", async () => {
    const facts = createFacts();
    const source = getPreparedModelCatalogDecisions(facts);
    const inventoryEntries = [
      {
        ...platform,
        baseUrl: "https://inventory.example.invalid/v1",
        nativeRuntime: "unowned-runtime",
      },
    ];
    const context = { preferredProfileId: "openai:subscription" };
    const inventoryDecision = await source.evaluate(inventoryEntries[0], context);
    expect(inventoryDecision).toMatchObject({
      availability: true,
      selectedProfileId: "openai:subscription",
      selectedRoute: subscriptionRoute,
    });
    expect(inventoryDecision.runtimeAuth).toBeUndefined();
    expect(getPreparedModelCatalogDecisions(facts)).toBe(source);
    expect(await source.evaluate(subscription, context)).toBe(inventoryDecision);
  });

  it("does not expand observed routes with logical or stale static donors", async () => {
    const facts = createFacts();
    facts.snapshot = {
      entries: [platform],
      routeVariants: [subscription],
      staticEntries: [platform],
    };
    const source = getPreparedModelCatalogDecisions(facts);
    expect(await source.evaluate(platform, { lockedProfileId: "openai:platform" })).toMatchObject({
      availability: false,
      selectedRoute: subscriptionRoute,
    });
    expect(source.variants(platform)).toEqual([subscription]);
  });

  it("exposes frozen owned rows and physical metadata without losing thinking provenance", () => {
    const facts = createFacts();
    const policy = () => undefined;
    const row: ModelCatalogEntry & ThinkingCatalogPolicyCarrier = {
      ...subscription,
      contextWindow: 65536,
      compat: { supportsDeveloperRole: false },
      params: { temperature: 0.5 },
      [PREPARED_THINKING_POLICY]: policy,
    };
    facts.snapshot = { entries: [row], routeVariants: [row] };
    const source = getPreparedModelCatalogDecisions(facts);
    const [owned] = source.entries;
    if (!owned) {
      throw new Error("Expected the owned model row");
    }
    const captured: ModelCatalogEntry & ThinkingCatalogPolicyCarrier = owned;
    row.contextWindow = 1024;
    row.params = { temperature: 1 };
    expect(source.entries).toEqual([captured]);
    expect(source.variants(subscription)).toEqual([captured]);
    expect(captured).toMatchObject({
      contextWindow: 65536,
      compat: { supportsDeveloperRole: false },
      params: { temperature: 0.5 },
    });
    expect(captured[PREPARED_THINKING_POLICY]).toBe(policy);
    expect(Object.isFrozen(source.entries)).toBe(true);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(source.variants(subscription))).toBe(true);
    expect(Object.isFrozen(captured.params)).toBe(true);
    expect(source.variants({ provider: "openai", id: "unknown" })).toEqual([]);
  });

  it("keeps preferred and locked profile contexts separate", async () => {
    const source = getPreparedModelCatalogDecisions(createFacts());
    expect(
      await source.evaluate(platform, { preferredProfileId: "openai:subscription" }),
    ).toMatchObject({ availability: true, selectedProfileId: "openai:subscription" });
    expect(await source.evaluate(platform, { lockedProfileId: "openai:platform" })).toMatchObject({
      availability: true,
      selectedProfileId: "openai:platform",
    });
    expect((await source.evaluate(platform, { lockedProfileId: "missing" })).availability).toBe(
      false,
    );
    expect(await source.evaluate(platform, { preferredProfileId: "missing" })).toMatchObject({
      availability: true,
    });
  });

  it("isolates native runtime contexts and rejects caller-invented provenance", async () => {
    const facts = createFacts();
    const native: ModelCatalogEntry = {
      provider: "acme",
      id: "native-model",
      name: "Native model",
      nativeRuntime: "acme-cli",
    };
    facts.snapshot = { entries: [native], routeVariants: [native] };
    facts.auth = {
      authStore: { version: 1, profiles: {} },
      providerAuth: { "acme-cli": { mode: "oauth" } },
    };
    const source = getPreparedModelCatalogDecisions(facts);
    expect(await source.evaluate(native)).toMatchObject({
      availability: true,
      runtimeAuth: { id: "acme-cli", source: "native" },
    });
    expect(
      (
        await source.evaluate(native, {
          runtimeOverride: { id: "openclaw", source: "session" },
        })
      ).availability,
    ).not.toBe(true);
    expect((await source.evaluate({ ...native, id: "unknown-model" })).availability).not.toBe(true);
    expect(await source.evaluate({ ...native, nativeRuntime: "forged-runtime" })).toMatchObject({
      runtimeAuth: { id: "acme-cli", source: "native" },
    });
  });

  it("captures environment evidence before a new context is evaluated", async () => {
    const facts = createFacts();
    facts.auth.authStore.profiles = {
      "openai:env": {
        provider: "openai",
        type: "api_key",
        keyRef: { source: "env", provider: "default", id: "CATALOG_DECISION_KEY" },
      },
    };
    facts.env = { CATALOG_DECISION_KEY: "captured-key" };
    const source = getPreparedModelCatalogDecisions(facts);
    delete facts.env.CATALOG_DECISION_KEY;
    expect(await source.evaluate(platform, { lockedProfileId: "openai:env" })).toMatchObject({
      availability: true,
    });
    notifyPreparedModelRuntimePublication({ phase: "published" });
    expect(
      (await getPreparedModelCatalogDecisions(facts).evaluate(platform)).availability,
    ).not.toBe(true);
  });

  it("clones runtime CLI provenance with the credential store", async () => {
    const facts = createFacts();
    const model = { provider: "acme", id: "model", name: "Model" };
    facts.snapshot = { entries: [model], routeVariants: [] };
    facts.auth.authStore.profiles = {
      "acme:cli": {
        provider: "acme",
        type: "oauth",
        access: "expired",
        refresh: "refresh",
        expires: 1,
      },
    };
    setRuntimeExternalCliProfileIds(facts.auth.authStore, ["acme:cli"]);
    const source = getPreparedModelCatalogDecisions(facts);
    setRuntimeExternalCliProfileIds(facts.auth.authStore, []);
    facts.auth.authStore.profiles = {};
    expect(await source.evaluate(model, { lockedProfileId: "acme:cli" })).toMatchObject({
      availability: true,
      selectedProfileId: "acme:cli",
    });
  });

  it("keeps cold profile contexts on the captured clock until publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const facts = createFacts();
    const model = { provider: "acme", id: "model", name: "Model" };
    facts.snapshot = { entries: [model], routeVariants: [] };
    facts.auth.authStore.profiles = {
      "acme:token": { provider: "acme", type: "token", token: "fixture-token", expires: 11_000 },
    };
    const source = getPreparedModelCatalogDecisions(facts);
    expect(await source.evaluate(model)).toMatchObject({ availability: true });

    vi.setSystemTime(12_000);
    expect(await source.evaluate(model, { preferredProfileId: "acme:token" })).toMatchObject({
      availability: true,
      selectedProfileId: "acme:token",
    });
    notifyPreparedModelRuntimePublication({ phase: "published" });
    expect((await getPreparedModelCatalogDecisions(facts).evaluate(model)).availability).toBe(
      false,
    );
  });

  it("marks an in-flight decision stale before it settles after publication", async () => {
    const facts = createFacts();
    const source = getPreparedModelCatalogDecisions(facts);
    const pending = source.evaluate(platform);
    notifyPreparedModelRuntimePublication({ phase: "published" });
    expect(await pending).toMatchObject({ availability: true });
    expect(source.isCurrent()).toBe(false);
    expect(getPreparedModelCatalogDecisions(facts).isCurrent()).toBe(true);
  });

  it.each(["utility", "image"] as const)(
    "does not transfer native or materialized agent auth to the %s purpose",
    async (purpose) => {
      const facts = createFacts();
      facts.auth.authStore.profiles = {};
      facts.auth = {
        ...facts.auth,
        providerAuth: { openai: { mode: "oauth", runtime: "codex" } },
      };
      facts.authMaterializations = [
        {
          provider: "openai",
          modelId: platform.id,
          modelApi: platformRoute.api,
          modelBaseUrl: platformRoute.baseUrl,
          requestTransportOverrides: "none",
          authMode: "api_key",
          runtimeOwnerId: "codex",
        },
      ];
      const source = getPreparedModelCatalogDecisions(facts);
      const agentDecision = await source.evaluate(platform);
      expect(agentDecision.availability).toBe(true);
      expect((await source.evaluate(platform, { purpose })).availability).not.toBe(true);
      expect(await source.evaluate(platform, { purpose: "agent" })).toBe(agentDecision);
    },
  );

  it("keeps image auth provider-wide while utility auth follows the text route", async () => {
    const facts = createFacts();
    facts.snapshot = { entries: [subscription], routeVariants: [subscription] };
    delete facts.auth.authStore.profiles["openai:subscription"];
    const source = getPreparedModelCatalogDecisions(facts);
    expect(await source.evaluate(subscription, { purpose: "image" })).toEqual({
      availability: true,
      routeResolution: null,
    });
    expect(await source.evaluate(subscription, { purpose: "utility" })).toMatchObject({
      availability: false,
      selectedRoute: subscriptionRoute,
    });
  });

  it.each(["utility", "image"] as const)(
    "captures the %s clock and credentials before the first purpose read",
    async (purpose) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const facts = createFacts();
      const row = { provider: "acme", id: "direct-model", name: "Direct model" };
      facts.snapshot = { entries: [row], routeVariants: [] };
      facts.env = { DIRECT_PURPOSE_KEY: "captured-key" };
      facts.auth.authStore.profiles = {
        "acme:token": {
          provider: "acme",
          type: "token",
          tokenRef: { source: "env", provider: "default", id: "DIRECT_PURPOSE_KEY" },
          expires: 11_000,
        },
      };
      const source = getPreparedModelCatalogDecisions(facts);
      delete facts.env.DIRECT_PURPOSE_KEY;
      facts.auth.authStore.profiles = {};
      vi.setSystemTime(12_000);
      expect((await source.evaluate(row, { purpose })).availability).toBe(true);
      expect(await source.runtime(row, { purpose })).toBeUndefined();
    },
  );

  it("keeps native runtime selection on captured facts after awaited evaluations", async () => {
    const facts = createFacts();
    const row = {
      provider: "acme",
      id: "native-model",
      name: "Native model",
      nativeRuntime: "acme-cli",
    };
    const nativeAuth: Record<string, { mode: "oauth" }> = { "acme-cli": { mode: "oauth" } };
    facts.snapshot = { entries: [row], routeVariants: [row] };
    facts.auth = { authStore: { version: 1, profiles: {} }, providerAuth: nativeAuth };
    const source = getPreparedModelCatalogDecisions(facts);
    await source.evaluate(row);
    delete nativeAuth["acme-cli"];
    facts.cfg.models = {
      providers: {
        acme: {
          baseUrl: "https://acme.example.invalid",
          models: [],
          agentRuntime: { id: "other" },
        },
      },
    };
    expect(await source.runtime(row)).toEqual({ id: "acme-cli", source: "auth" });
    expect(await source.runtime({ ...row, nativeRuntime: "forged" })).toEqual({
      id: "acme-cli",
      source: "auth",
    });
    expect(await source.runtime({ ...row, id: "unknown" })).toBeUndefined();
  });

  it.each(["model", "provider"] as const)(
    "preserves captured explicit %s runtime policy and explicit context overrides",
    async (scope) => {
      const facts = createFacts();
      const row = { provider: "acme", id: "model", name: "Model" };
      facts.snapshot = { entries: [row], routeVariants: [row] };
      facts.auth = {
        authStore: { version: 1, profiles: {} },
        providerAuth: { acme: { mode: "oauth", runtime: "acme-cli" } },
      };
      facts.cfg =
        scope === "model"
          ? {
              agents: {
                defaults: { models: { "acme/model": { agentRuntime: { id: "openclaw" } } } },
              },
            }
          : {
              models: {
                providers: {
                  acme: {
                    baseUrl: "https://acme.example.invalid",
                    models: [],
                    agentRuntime: { id: "openclaw" },
                  },
                },
              },
            };
      const source = getPreparedModelCatalogDecisions(facts);
      expect(await source.runtime(row)).toEqual({ id: "openclaw", source: scope });
      expect(
        await source.runtime(row, { runtimeOverride: { id: "chosen", source: "session" } }),
      ).toEqual({ id: "chosen", source: "session" });
    },
  );

  it("does not choose a runtime from materialized authentication", async () => {
    const facts = createFacts();
    const row = { provider: "acme", id: "model", name: "Model" };
    facts.snapshot = { entries: [row], routeVariants: [] };
    facts.authMaterializations = [
      {
        provider: "acme",
        modelId: row.id,
        modelApi: platformRoute.api,
        modelBaseUrl: platformRoute.baseUrl,
        requestTransportOverrides: "none",
        authMode: "api_key",
        runtimeOwnerId: "materialized-runtime",
      },
    ];
    expect(await getPreparedModelCatalogDecisions(facts).runtime(row)).toBeUndefined();
  });

  it("uses one captured clock across agent and direct resolver construction", async () => {
    const facts = createFacts();
    const row = { provider: "acme", id: "model", name: "Model" };
    facts.snapshot = { entries: [row], routeVariants: [] };
    facts.auth.authStore.profiles = {
      "acme:token": { provider: "acme", type: "token", token: "fixture-token", expires: 11_000 },
    };
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(10_000).mockReturnValue(12_000);
    try {
      const source = getPreparedModelCatalogDecisions(facts);
      for (const purpose of ["agent", "utility", "image"] as const) {
        expect(await source.evaluate(row, { purpose })).toMatchObject({ availability: true });
      }
    } finally {
      clock.mockRestore();
    }
  });

  it("binds runtime to the selected competing route rather than the first or caller row", async () => {
    const selectedRoute = {
      ...subscriptionRoute,
      baseUrl: "https://relay.example.invalid/v1",
      requestTransportOverrides: "present" as const,
      runtimePolicy: { compatibleIds: ["openclaw"] },
    };
    const facts = createFacts();
    facts.snapshot.routeVariants = [platform, { ...subscription, baseUrl: selectedRoute.baseUrl }];
    openAIModelRoutesMock.resolution = {
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [platformRoute, selectedRoute],
    };
    const policy = vi
      .spyOn(harnessPolicy, "resolveConfiguredAgentHarnessPolicy")
      .mockImplementation(({ modelApi, modelBaseUrl, requestTransportOverrides }) => ({
        runtime:
          modelApi === selectedRoute.api &&
          modelBaseUrl === selectedRoute.baseUrl &&
          requestTransportOverrides === selectedRoute.requestTransportOverrides
            ? "openclaw"
            : "codex",
        runtimeSource: "implicit",
      }));
    try {
      const source = getPreparedModelCatalogDecisions(facts);
      const context = { lockedProfileId: "openai:subscription" };
      const evaluation = source.evaluate(platform, context);
      expect(await source.runtime(platform, context)).toEqual({
        id: "openclaw",
        source: "implicit",
      });
      expect(await evaluation).toMatchObject({ selectedRoute });
      expect(
        await source.runtime(
          {
            ...platform,
            api: "openai-completions",
            baseUrl: "https://unowned.example.invalid",
          },
          context,
        ),
      ).toEqual({ id: "openclaw", source: "implicit" });
      expect(source.evaluate(platform, context)).toBe(evaluation);
    } finally {
      policy.mockRestore();
    }
  });
});
