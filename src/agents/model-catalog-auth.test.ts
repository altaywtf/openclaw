import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveExternalCliAuthProfiles } from "./auth-profiles/external-cli-sync.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "./model-auth-runtime-config.js";
import { createModelCatalogAuthResolver } from "./model-catalog-auth.js";

vi.mock("./auth-profiles/external-cli-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-profiles/external-cli-sync.js")>()),
  resolveExternalCliAuthProfiles: vi.fn(() => []),
}));

vi.mock("./model-auth-runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-auth-runtime-config.js")>()),
  resolveManagedSecretRefRuntimeProviderAuth: vi.fn(),
}));

afterEach(() => {
  vi.mocked(resolveManagedSecretRefRuntimeProviderAuth).mockReset();
});

describe("prepared catalog authentication", () => {
  it("uses captured authentication without rediscovering an external CLI account", () => {
    const resolver = createModelCatalogAuthResolver({
      cfg: { agents: { defaults: { model: "minimax/test-model" } } },
      agentId: "main",
      workspaceDir: "/tmp/prepared-catalog-auth",
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      preparedAuthStore: { version: 1, profiles: {} },
      preparedProviderAuth: { minimax: { mode: "oauth", runtime: "minimax-cli" } },
      preparedSyntheticAuthComplete: true,
    });
    expect(resolver.evaluateModelAuth("minimax", { modelId: "test-model" })).toMatchObject({
      availability: true,
      runtimeAuth: { id: "minimax-cli", source: "native" },
    });
    expect(resolveExternalCliAuthProfiles).not.toHaveBeenCalled();
  });

  it("keeps environment observations fixed until another preparation", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            apiKey: { source: "env", provider: "default", id: "CATALOG_TEST_KEY" },
          },
        },
      },
    };
    const env = { CATALOG_TEST_KEY: "captured-key" };
    const resolver = createModelAuthAvailabilityResolver({
      cfg,
      env,
      authStore: { version: 1, profiles: {} },
    });
    env.CATALOG_TEST_KEY = "";
    expect(resolver.evaluateModelAuth("custom").availability).toBe(true);
    const replacement = createModelAuthAvailabilityResolver({
      cfg,
      env,
      authStore: { version: 1, profiles: {} },
    });
    expect(replacement.evaluateModelAuth("custom").availability).toBeUndefined();
  });

  it("keeps resolved-secret observations fixed for later selection contexts", () => {
    vi.mocked(resolveManagedSecretRefRuntimeProviderAuth).mockReturnValue({
      apiKey: "captured-key",
      source: "captured-provider-secret",
      mode: "api-key",
    });
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            apiKey: { source: "env", provider: "default", id: "CATALOG_TEST_KEY" },
          },
        },
      },
    };
    const resolver = createModelAuthAvailabilityResolver({
      cfg,
      env: {},
      authStore: { version: 1, profiles: {} },
    });
    vi.mocked(resolveManagedSecretRefRuntimeProviderAuth).mockReturnValue(undefined);
    expect(resolver.evaluateModelAuth("custom").availability).toBe(true);
  });
});
