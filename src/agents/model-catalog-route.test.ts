import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveThinkingProfile } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import type { ProviderDefaultThinkingPolicyContext } from "../plugins/provider-thinking.types.js";
import {
  type ModelCatalogRoutePolicy,
  projectModelCatalogEntryForRoute,
  resolveConfiguredModelCatalogOverrides,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";

const matchesRoute = (entry: ModelCatalogEntry, route: ProviderModelRouteCandidate) =>
  entry.api === route.api && entry.baseUrl === route.baseUrl;
const routePolicy: ModelCatalogRoutePolicy = {
  resolveIdentity: (entry) => ({ id: entry.id, key: `${entry.provider}/${entry.id}` }),
  matchesRoute,
};

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const satisfies ProviderModelRouteCandidate;

const chatGPTRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const satisfies ProviderModelRouteCandidate;

const platformEntry: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 1_000_000,
  contextTokens: 272_000,
  reasoning: true,
  thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
  input: ["text", "image"],
  params: { platformOnly: true },
  compat: { supportsTools: false },
};

const chatGPTEntry: ModelCatalogEntry = {
  provider: "openai",
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  contextWindow: 400_000,
  contextTokens: 300_000,
  reasoning: true,
  thinkingLevelMap: { off: null, xhigh: null, max: "max" },
  input: ["text"],
  params: { chatGPTOnly: true },
  compat: { supportsTools: true },
};

describe("projectModelCatalogEntryForRoute", () => {
  it.each([false, true])(
    "uses the selected donor for both projections regardless of catalog order (reverse=%s)",
    (reverse) => {
      const { entry, runtimeEntry } = projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: reverse ? [chatGPTEntry, platformEntry] : [platformEntry, chatGPTEntry],
      });
      expect(entry).toMatchObject({ contextWindow: 400_000, input: ["text"] });
      expect(entry).not.toHaveProperty("params");
      expect(entry).not.toHaveProperty("compat");
      expect(runtimeEntry).toMatchObject({
        contextWindow: 400_000,
        input: ["text"],
        params: { chatGPTOnly: true },
        compat: { supportsTools: true },
      });
    },
  );

  it("prefers the physical route donor over a matching merged logical row", () => {
    const logicalEntry: ModelCatalogEntry = {
      ...chatGPTEntry,
      compat: { supportsTools: false },
      params: { logicalOnly: true },
    };

    const { runtimeEntry } = projectModelCatalogEntryForRoute({
      entry: logicalEntry,
      projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
      catalog: [platformEntry, chatGPTEntry],
    });

    expect(runtimeEntry).toMatchObject({
      compat: { supportsTools: true },
      params: { chatGPTOnly: true },
    });
  });

  it("projects one physical row onto the selected route capabilities", () => {
    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: platformRoute, policy: routePolicy },
        catalog: [platformEntry, chatGPTEntry],
      }).entry,
    ).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_000_000,
      contextTokens: 272_000,
      reasoning: true,
      thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
    });

    expect(
      projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: [platformEntry, chatGPTEntry],
      }).entry,
    ).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 400_000,
      contextTokens: 300_000,
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: null, max: "max" },
      input: ["text"],
    });
  });

  it("omits sibling-route capabilities when no selected-route row exists", () => {
    const rows = projectModelCatalogEntryForRoute({
      entry: platformEntry,
      projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
      catalog: [platformEntry],
    });
    expect(rows.entry).toEqual({
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(rows.runtimeEntry).toEqual(rows.entry);
  });

  it.each([
    {
      name: "platform",
      route: platformRoute,
      donor: true,
      expected: "high",
      owner: "fixture-platform",
    },
    {
      name: "subscription",
      route: chatGPTRoute,
      donor: true,
      expected: "ultra",
      owner: "fixture-subscription",
    },
    { name: "missing donor", route: chatGPTRoute, donor: false, expected: "off", owner: undefined },
    { name: "unresolved", route: undefined, donor: true, expected: "off", owner: undefined },
  ])(
    "retains only the $name route's prepared thinking owner",
    ({ route, donor, expected, owner }) => {
      const resolvePolicy = vi.fn((context: ProviderDefaultThinkingPolicyContext) =>
        context.provider === "fixture-platform"
          ? ({ levels: [{ id: "off" }, { id: "high" }], defaultLevel: "high" } as const)
          : ({
              levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
              defaultLevel: "ultra",
            } as const),
      );
      const entry = { ...platformEntry, thinkingPolicyProvider: "fixture-platform" };
      const catalog: ModelCatalogSnapshot = {
        entries: [entry],
        routeVariants: [
          entry,
          ...(donor ? [{ ...chatGPTEntry, thinkingPolicyProvider: "fixture-subscription" }] : []),
        ],
      };
      prepareModelCatalogThinkingPolicies({
        catalog,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        providers: ["fixture-platform", "fixture-subscription"].map((id) => ({
          provider: { id, resolveThinkingProfile: resolvePolicy },
        })),
      });
      const ambient = vi
        .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
        .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
      try {
        const { entry: projected } = projectModelCatalogEntryForRoute({
          entry: expectDefined(catalog.entries[0], "prepared route test entry"),
          projection: route
            ? { kind: "selected", route, policy: routePolicy }
            : { kind: "unresolved", policy: routePolicy },
          catalog: catalog.routeVariants,
        });
        expect(
          resolveThinkingProfile({
            provider: projected.provider,
            model: projected.id,
            catalog: [projected],
            agentRuntime: "codex",
            providerPolicySource: "active",
          }).defaultLevel,
        ).toBe(expected);
        if (owner) {
          expect(resolvePolicy).toHaveBeenCalledWith(expect.objectContaining({ provider: owner }));
          expect(ambient).not.toHaveBeenCalled();
        } else {
          expect(resolvePolicy).not.toHaveBeenCalled();
          expect(projected).not.toHaveProperty("thinkingPolicyProvider");
          expect(ambient).toHaveBeenCalledOnce();
        }
      } finally {
        ambient.mockRestore();
      }
    },
  );

  it("returns the physical row unchanged for unmanaged models", () => {
    const { entry, runtimeEntry } = projectModelCatalogEntryForRoute({
      entry: platformEntry,
      projection: { kind: "unmanaged" },
    });
    expect(entry).toEqual(platformEntry);
    expect(runtimeEntry).toEqual(platformEntry);
  });

  it("removes physical route facts while managed selection is unresolved", () => {
    const { entry, runtimeEntry } = projectModelCatalogEntryForRoute({
      entry: platformEntry,
      projection: { kind: "unresolved", policy: routePolicy },
    });
    expect(entry).toEqual({ provider: "openai", id: "gpt-5.5", name: "GPT-5.5" });
    expect(runtimeEntry).toEqual(entry);
  });

  it("does not copy private route policy facts into the catalog row", () => {
    const donor = {
      ...chatGPTEntry,
      apiKey: "fixture-key",
      headers: { Authorization: "fixture-token" },
    };
    const { entry, runtimeEntry } = projectModelCatalogEntryForRoute({
      entry: platformEntry,
      projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
      catalog: [donor],
    });
    for (const row of [entry, runtimeEntry]) {
      expect(row).not.toHaveProperty("authRequirement");
      expect(row).not.toHaveProperty("requestTransportOverrides");
      expect(row).not.toHaveProperty("apiKey");
      expect(row).not.toHaveProperty("headers");
    }
    expect(entry).not.toHaveProperty("params");
    expect(entry).not.toHaveProperty("compat");
  });

  it.each([false, true])(
    "applies explicit logical overrides to both projections (donor=%s)",
    (hasDonor) => {
      const cfg = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.5",
                  name: "Configured model",
                  contextWindow: 200_000,
                  contextTokens: 160_000,
                  reasoning: false,
                  thinkingLevelMap: { off: "none", max: null },
                  input: ["text", "image"],
                  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
                  maxTokens: 8_000,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig;
      const overrides = resolveConfiguredModelCatalogOverrides({ cfg, entry: platformEntry });

      const { entry, runtimeEntry } = projectModelCatalogEntryForRoute({
        entry: platformEntry,
        projection: { kind: "selected", route: chatGPTRoute, policy: routePolicy },
        catalog: hasDonor ? [platformEntry, chatGPTEntry] : [platformEntry],
        overrides,
      });
      for (const row of [entry, runtimeEntry]) {
        expect(row).toMatchObject({
          provider: "openai",
          id: "gpt-5.5",
          name: "Configured model",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 200_000,
          contextTokens: 160_000,
          reasoning: false,
          configuredReasoning: false,
          thinkingLevelMap: { off: "none", max: null },
          input: ["text", "image"],
        });
      }
    },
  );

  it("marks configured reasoning overrides as authoritative", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5", reasoning: false }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveConfiguredModelCatalogOverrides({ cfg, entry: platformEntry })).toEqual({
      reasoning: false,
      configuredReasoning: false,
    });
  });

  it("merges logical overrides from canonical duplicate model rows", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [
              { id: "openai/gpt-5.5", name: "Configured GPT-5.5" },
              { id: "gpt-5.5", name: "Ignored duplicate name", contextTokens: 160_000 },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const canonicalPolicy: ModelCatalogRoutePolicy = {
      ...routePolicy,
      resolveIdentity: (entry) => {
        const id = entry.id.replace(/^openai\//u, "");
        return { id, key: `${entry.provider}/${id}` };
      },
    };

    expect(
      resolveConfiguredModelCatalogOverrides({
        cfg,
        entry: platformEntry,
        policy: canonicalPolicy,
      }),
    ).toEqual({ name: "Configured GPT-5.5", contextTokens: 160_000 });
  });

  it("preserves literal provider-scoped model ids", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [{ id: "openai/acme-model", name: "Configured Acme" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const literalEntry = { ...platformEntry, id: "openai/acme-model" };

    expect(
      resolveConfiguredModelCatalogOverrides({
        cfg,
        entry: literalEntry,
        policy: routePolicy,
      }),
    ).toEqual({ name: "Configured Acme" });
  });
});
