import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderFastModeCapabilityContext } from "../plugins/provider-fast-mode.types.js";
import * as providerPolicies from "../plugins/provider-public-artifacts.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { createModelCatalogFastModeResolver } from "./model-catalog-capabilities.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

const entry: ModelCatalogEntry = {
  id: "fast-model",
  name: "Fast model",
  provider: "catalog-capability-fixture",
  api: "openai-responses",
  baseUrl: "https://capability.example/v1",
};
const runtime: GatewayAgentRuntime = { id: "fixture-runtime", source: "model" };
const evaluation: ModelAuthAvailabilityEvaluation = {
  availability: true,
  routeResolution: null,
  selectedAuthMode: "api_key",
};

function setup(cfg: OpenClawConfig = {}, entries: ModelCatalogEntry[] = [entry, entry]) {
  const rootDir = tempDirs.make("openclaw-catalog-capability-");
  fs.writeFileSync(
    path.join(rootDir, "provider-policy-api.js"),
    `export function resolveFastModeCapability(context) {
      if (context.modelId === "unknown") return undefined;
      return context.api === "openai-responses" &&
        context.baseUrl === "https://capability.example/v1" &&
        context.endpointClass === "openai-public" &&
        context.agentRuntime === "fixture-runtime" &&
        context.authRequirement === "api-key" &&
        context.params?.serviceTier !== "manual";
    }`,
  );
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: entry.provider,
        origin: "global",
        trustedOfficialInstall: true,
        rootDir,
        providers: [entry.provider],
        providerEndpoints: [{ endpointClass: "openai-public", hosts: ["capability.example"] }],
      },
    ],
  });
  const loadPolicy = vi.spyOn(providerPolicies, "resolveProviderPolicySurface");
  const resolve = createModelCatalogFastModeResolver({
    cfg,
    agentId: "main",
    entries,
    metadataSnapshot,
  });
  return { resolve, loadPolicy, metadataSnapshot };
}

describe("model catalog capabilities", () => {
  it.each([
    { id: "claude-opus-5", selectedAuthMode: "api_key", expected: true },
    { id: "claude-sonnet-5", selectedAuthMode: "api_key", expected: false },
    { id: "claude-opus-5", selectedAuthMode: undefined, expected: undefined },
  ])(
    "uses the bundled model/auth contract for $id / $selectedAuthMode",
    ({ id, selectedAuthMode, expected }) => {
      const model: ModelCatalogEntry = {
        id,
        name: id,
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "anthropic",
            providers: ["anthropic"],
            providerEndpoints: [
              { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
            ],
          },
        ],
      });
      const resolve = createModelCatalogFastModeResolver({
        cfg: {},
        agentId: "main",
        entries: [model],
        metadataSnapshot,
      });
      expect(
        resolve({
          entry: model,
          evaluation: { ...evaluation, selectedAuthMode },
          runtime: { id: "openclaw", source: "model" },
        }),
      ).toBe(expected);
    },
  );

  it("loads a custom policy once and resolves each supplied row independently", () => {
    const { resolve, loadPolicy, metadataSnapshot } = setup();
    expect(loadPolicy).toHaveBeenCalledExactlyOnceWith(entry.provider, {
      manifestRegistry: metadataSnapshot.manifestRegistry,
    });
    expect(resolve({ entry, evaluation, runtime })).toBe(true);
    expect(
      resolve({ entry: { ...entry, params: { serviceTier: "manual" } }, evaluation, runtime }),
    ).toBe(false);
    expect(resolve({ entry: { ...entry, id: "unknown" }, evaluation, runtime })).toBeUndefined();
    expect(loadPolicy).toHaveBeenCalledOnce();
  });

  it("keeps the captured hook after another view changes policy lookup", () => {
    const { resolve, loadPolicy, metadataSnapshot } = setup();
    loadPolicy.mockReturnValue({ resolveFastModeCapability: () => false });
    const replacement = createModelCatalogFastModeResolver({
      cfg: {},
      agentId: "main",
      entries: [entry],
      metadataSnapshot,
    });
    expect(replacement({ entry, evaluation, runtime })).toBe(false);
    expect(resolve({ entry, evaluation, runtime })).toBe(true);
  });

  it("keeps endpoint classification bound to the original metadata snapshot", () => {
    const { resolve, metadataSnapshot } = setup();
    const replacementSnapshot = createPluginMetadataSnapshotFixture({
      plugins: metadataSnapshot.plugins.map((plugin) =>
        Object.assign({}, plugin, {
          providerEndpoints: [{ endpointClass: "custom", hosts: ["capability.example"] }],
        }),
      ),
    });
    const replacement = createModelCatalogFastModeResolver({
      cfg: {},
      agentId: "main",
      entries: [entry],
      metadataSnapshot: replacementSnapshot,
    });
    expect(replacement({ entry, evaluation, runtime })).toBe(false);
    expect(resolve({ entry, evaluation, runtime })).toBe(true);
  });

  it("keeps a captured missing hook unknown without rediscovering it", () => {
    const { loadPolicy, metadataSnapshot } = setup();
    loadPolicy.mockReturnValue({});
    const resolve = createModelCatalogFastModeResolver({
      cfg: {},
      agentId: "main",
      entries: [entry],
      metadataSnapshot,
    });
    loadPolicy.mockClear();
    expect(resolve({ entry, evaluation, runtime })).toBeUndefined();
    expect(loadPolicy).not.toHaveBeenCalled();
  });

  it.each([undefined, "auto", "default"])("leaves runtime %s unresolved", (id) => {
    const { resolve } = setup();
    expect(
      resolve({
        entry,
        evaluation,
        runtime: id ? { id, source: "implicit" } : undefined,
      }),
    ).toBeUndefined();
  });

  it("uses the selected route, not an available sibling route", () => {
    const { resolve } = setup();
    const available: ProviderModelRouteCandidate = {
      api: "openai-responses",
      baseUrl: entry.baseUrl!,
      authRequirement: "api-key",
      requestTransportOverrides: "none",
    };
    const selected: ProviderModelRouteCandidate = {
      api: "openai-completions",
      baseUrl: "https://selected.example/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "present",
    };
    const routed: ModelAuthAvailabilityEvaluation = {
      ...evaluation,
      routeResolution: { kind: "routes", routes: [available, selected] },
      selectedRoute: selected,
    };
    const projected = { ...entry, api: selected.api, baseUrl: selected.baseUrl };
    expect(resolve({ entry: projected, evaluation: routed, runtime })).toBe(false);
    expect(resolve({ entry, evaluation: { ...routed, selectedRoute: available }, runtime })).toBe(
      true,
    );
    expect(
      resolve({ entry, evaluation: { ...routed, selectedRoute: undefined }, runtime }),
    ).toBeUndefined();
  });

  it.each(["indeterminate", "incompatible"] as const)(
    "does not reuse a concrete-looking row when route evaluation is %s",
    (kind) => {
      const { resolve } = setup();
      const routeResolution =
        kind === "indeterminate"
          ? { kind }
          : { kind, code: "unsupported", message: "No compatible route" };
      expect(
        resolve({ entry, evaluation: { ...evaluation, routeResolution }, runtime }),
      ).toBeUndefined();
    },
  );

  it("uses the exact auth evaluation without inferring an account from config", () => {
    const { resolve } = setup({
      auth: { profiles: { configured: { provider: entry.provider, mode: "api_key" } } },
    });
    expect(
      resolve({ entry, evaluation: { ...evaluation, selectedAuthMode: "oauth" }, runtime }),
    ).toBe(false);
    expect(resolve({ entry, evaluation: { ...evaluation, availability: false }, runtime })).toBe(
      true,
    );
  });

  it("passes selected route facts and merged parameter-owner records to the captured hook", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          params: { serviceTier: "default", defaultOnly: true },
          models: {
            [`${entry.provider}/${entry.id}`]: {
              params: { serviceTier: "model", modelOnly: true },
            },
          },
        },
        entries: { main: { params: { serviceTier: "manual", agentOnly: true } } },
      },
    };
    const { loadPolicy, metadataSnapshot } = setup();
    const hook = vi.fn<(context: ProviderFastModeCapabilityContext) => boolean>(() => false);
    loadPolicy.mockReturnValue({ resolveFastModeCapability: hook });
    const resolve = createModelCatalogFastModeResolver({
      cfg,
      agentId: "main",
      entries: [entry],
      metadataSnapshot,
    });
    const selectedRoute: ProviderModelRouteCandidate = {
      api: "openai-responses",
      baseUrl: entry.baseUrl!,
      authRequirement: "api-key",
      requestTransportOverrides: "present",
    };
    expect(
      resolve({
        entry: { ...entry, params: { serviceTier: "entry", canonicalModelId: "physical-model" } },
        evaluation: {
          ...evaluation,
          routeResolution: { kind: "routes", routes: [selectedRoute] },
          selectedRoute,
        },
        runtime,
      }),
    ).toBe(false);
    expect(hook).toHaveBeenCalledExactlyOnceWith({
      provider: entry.provider,
      modelId: entry.id,
      api: selectedRoute.api,
      baseUrl: selectedRoute.baseUrl,
      endpointClass: "openai-public",
      agentRuntime: runtime.id,
      authRequirement: selectedRoute.authRequirement,
      requestTransportOverrides: "present",
      params: {
        canonicalModelId: "physical-model",
        serviceTier: "manual",
        defaultOnly: true,
        modelOnly: true,
        agentOnly: true,
      },
    });
  });

  it("does not manufacture route, auth, request, or endpoint facts from configured defaults", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          [entry.provider]: { api: "openai-responses", baseUrl: entry.baseUrl!, models: [] },
        },
      },
    };
    const { loadPolicy, metadataSnapshot } = setup();
    const hook = vi.fn<(context: ProviderFastModeCapabilityContext) => undefined>(() => undefined);
    loadPolicy.mockReturnValue({ resolveFastModeCapability: hook });
    const resolve = createModelCatalogFastModeResolver({
      cfg,
      agentId: "main",
      entries: [entry],
      metadataSnapshot,
    });
    resolve({
      entry: { id: entry.id, name: entry.name, provider: entry.provider },
      evaluation: { availability: undefined, routeResolution: null },
      runtime,
    });
    expect(hook).toHaveBeenCalledExactlyOnceWith({
      provider: entry.provider,
      modelId: entry.id,
      api: undefined,
      baseUrl: undefined,
      endpointClass: undefined,
      agentRuntime: runtime.id,
      authRequirement: undefined,
      requestTransportOverrides: undefined,
      params: undefined,
    });
  });

  it("does not discover a new provider during publication", () => {
    const { resolve, loadPolicy } = setup();
    expect(
      resolve({ entry: { ...entry, provider: "not-captured" }, evaluation, runtime }),
    ).toBeUndefined();
    expect(loadPolicy).toHaveBeenCalledOnce();
  });

  it("does not turn provider policy failures into capability decisions", () => {
    const { loadPolicy, metadataSnapshot } = setup();
    loadPolicy.mockReturnValue({
      resolveFastModeCapability() {
        throw new Error("policy failed");
      },
    });
    const resolve = createModelCatalogFastModeResolver({
      cfg: {},
      agentId: "main",
      entries: [entry],
      metadataSnapshot,
    });
    expect(() => resolve({ entry, evaluation, runtime })).toThrow("policy failed");
  });
});
