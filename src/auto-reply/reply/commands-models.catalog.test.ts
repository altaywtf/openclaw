import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { prepareModelCatalogView } from "../../agents/model-catalog-view.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolvePublishedModelCatalogOwner } from "../../agents/prepared-model-catalog-owner.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildModelsListResult } from "../../gateway/server-methods/models-list-result.js";
import { registerGatewayModelCatalogPrivateAccess } from "../../gateway/server-model-catalog-auth.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { buildPreparedModelsProviderData, formatModelsAvailableHeader } from "./commands-models.js";

const loaders = vi.hoisted(() => ({
  loadOwner: vi.fn(),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogOwnerSnapshot: loaders.loadOwner,
  loadPublishedPreparedModelCatalogOwnerSnapshot: loaders.loadOwner,
  loadResolvedPublishedModelCatalogOwner: async () =>
    resolvePublishedModelCatalogOwner(await loaders.loadOwner()),
}));

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});

describe("published model choices across surfaces", () => {
  it.each([false, true])(
    "keeps native-login availability bound to its runtime (direct override=%s)",
    async (directOverride) => {
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
      const config = {
        agents: {
          defaults: {
            model: "catalog-provider/pinned",
            ...(directOverride
              ? { models: { "catalog-provider/*": { agentRuntime: { id: "openclaw" } } } }
              : {}),
          },
          entries: { main: {} },
        },
      } satisfies OpenClawConfig;
      const entries: ModelCatalogEntry[] = ["pinned", "discovered"].map((id) => ({
        id,
        name: id,
        provider: "catalog-provider",
        nativeRuntime: "catalog-runtime",
        api: "anthropic-messages",
      }));
      const authStore = { version: 1 as const, profiles: {} };
      const providerAuth = { "catalog-runtime": { mode: "oauth" as const } };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const owner = {
        agentId: "main",
        agentDir: "/tmp/catalog-parity-agent",
        workspaceDir: "/tmp/catalog-parity-workspace",
        catalogOwner: { agentId: "main", workspaceDir: "/tmp/catalog-parity-workspace" },
        config,
        modelCatalog: { entries, routeVariants: entries },
        providerAuth,
        metadataSnapshot,
        oauthRefreshProviderIds: [],
      };
      setPreparedModelRuntimeAuthStore(owner, authStore);
      loaders.loadOwner.mockResolvedValue(owner);
      const loadCatalog = async () => ({
        ...owner,
        ...owner.modelCatalog,
        authStore,
        authMaterializations: [],
        catalogComplete: true,
      });
      registerGatewayModelCatalogPrivateAccess(loadCatalog, {
        loadDeferred: loadCatalog,
        readPrepared: loadCatalog,
      });
      const gateway = await buildModelsListResult({
        source: {
          kind: "gateway",
          context: {
            getRuntimeConfig: () => config,
            loadGatewayModelCatalogSnapshot: loadCatalog,
          },
        },
        agentId: "main",
        params: { view: "default", preparedOnly: true },
      });
      const expectedModels = directOverride ? ["pinned"] : ["discovered", "pinned"];
      expect(gateway.models.map((model) => model.id).toSorted()).toEqual(expectedModels);
      expect(gateway.models.every((model) => model.available)).toBe(!directOverride);
      expect(gateway.models.map((model) => model.agentRuntime?.id)).toEqual(
        expectedModels.map(() => (directOverride ? "openclaw" : "catalog-runtime")),
      );
      const chat = await buildPreparedModelsProviderData(config, "main");
      expect([...(chat.byProvider.get("catalog-provider") ?? [])].toSorted()).toEqual(
        gateway.models.map((model) => model.id).toSorted(),
      );
      expect(chat.providerAuthLabels?.get("catalog-provider")).toBe(
        directOverride ? undefined : "native sign-in",
      );
      expect(
        formatModelsAvailableHeader({
          provider: "catalog-provider",
          total: expectedModels.length,
          authLabel: chat.providerAuthLabels?.get("catalog-provider"),
        }),
      ).toBe(
        directOverride
          ? "Models (catalog-provider) — 1 available"
          : "Models (catalog-provider · 🔑 native sign-in) — 2 available",
      );
      if (!directOverride) {
        const locked = await prepareModelCatalogView({
          cfg: config,
          agentId: owner.agentId,
          workspaceDir: owner.workspaceDir,
          snapshot: owner.modelCatalog,
          metadataSnapshot,
          auth: { authStore, providerAuth },
          lockedProfileId: "catalog-provider:missing",
        });
        expect(locked.entries.map((entry) => entry.id)).toEqual(["pinned"]);
        expect(locked.evaluate(locked.entries[0]!).availability).toBe(false);
      }
    },
  );
});
