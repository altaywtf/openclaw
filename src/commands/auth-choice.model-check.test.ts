import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  dualRoutes,
  platformRoute,
  subscriptionRoute,
} from "../agents/openai-model-routes.test-support.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
import { setPreparedModelRuntimeAuthMaterializations } from "../agents/prepared-model-runtime-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  resolveDefaultModelAuthStatus,
  warnIfModelConfigLooksOff,
} from "./auth-choice.model-check.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const acquireReadOnlyPreparedModelRuntime = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
const ensureAuthProfileStore = vi.hoisted(() => vi.fn());
vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquireReadOnlyPreparedModelRuntime,
}));
vi.mock("../agents/auth-profiles.js", () => ({ ensureAuthProfileStore }));
vi.mock("../agents/openai-model-routes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/openai-model-routes.js")>()),
  createOpenAIModelRoutesResolver: () => () => dualRoutes,
}));

const config: OpenClawConfig = {
  agents: { list: [{ id: "draft", workspace: "/tmp/draft", model: "fixture/model" }] },
};
const scope = { agentId: "draft", agentDir: "/tmp/draft-agent" };

function prepareOwner(
  overrides: Partial<PublishedModelCatalogOwnerCandidate> = {},
): PublishedModelCatalogOwnerCandidate {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const owner = {
    catalogOwner: { agentId: "draft", workspaceDir: "/tmp/draft" },
    agentDir: scope.agentDir,
    config,
    providerAuth: {},
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    oauthRefreshProviderIds: [],
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    ...overrides,
  } satisfies PublishedModelCatalogOwnerCandidate;
  acquireReadOnlyPreparedModelRuntime.mockResolvedValue({ snapshot: owner, release });
  return owner;
}

describe("draft model authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareOwner();
  });

  it("uses the exact draft owner's native sign-in without rereading stored credentials", async () => {
    prepareOwner({ providerAuth: { fixture: { mode: "oauth", runtime: "fixture-native" } } });
    const note = vi.fn(async () => {});

    await warnIfModelConfigLooksOff(config, makePrompter({ note }), scope);

    expect(note).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(acquireReadOnlyPreparedModelRuntime).toHaveBeenCalledWith({
      config,
      ...scope,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["fixture", "other"])(
    "evaluates a staged %s credential without changing the captured auth store",
    async (provider) => {
      const store: AuthProfileStore = { version: 1, profiles: {} };
      prepareOwner({ authStore: store });
      const result = await resolveDefaultModelAuthStatus(config, {
        ...scope,
        pendingAuthProfiles: [
          {
            profileId: `${provider}:pending`,
            credential: { type: "api_key", provider, key: "fixture-key" },
          },
        ],
      });

      expect(result.evaluation?.availability === true).toBe(provider === "fixture");
      expect(store).toEqual({ version: 1, profiles: {} });
      expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    },
  );

  it("keeps external renewal provenance when overlaying another staged credential", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture:external": {
          type: "oauth",
          provider: "fixture",
          access: "fixture-access",
          refresh: "fixture-refresh",
          expires: 1,
        },
      },
      runtimeExternalProfileIds: ["fixture:external"],
      runtimeExternalCliProfileIds: ["fixture:external"],
    };
    prepareOwner({ authStore: store });
    const before = structuredClone(store);
    const note = vi.fn(async () => {});

    await warnIfModelConfigLooksOff(config, makePrompter({ note }), {
      ...scope,
      pendingAuthProfiles: [
        {
          profileId: "other:pending",
          credential: { type: "api_key", provider: "other", key: "fixture-key" },
        },
      ],
    });

    expect(note).not.toHaveBeenCalled();
    expect(store).toEqual(before);
  });

  it("does not inherit external renewal authority when a staged profile replaces that ID", async () => {
    const credential = {
      type: "oauth" as const,
      provider: "fixture",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 1,
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: { "fixture:external": credential },
      runtimeExternalProfileIds: ["fixture:external"],
      runtimeExternalCliProfileIds: ["fixture:external"],
    };
    prepareOwner({ authStore: store });

    const result = await resolveDefaultModelAuthStatus(config, {
      ...scope,
      pendingAuthProfiles: [
        {
          profileId: "fixture:external",
          credential: { ...credential, access: "staged-access", refresh: "staged-refresh" },
        },
      ],
    });

    expect(result.evaluation?.availability).not.toBe(true);
    expect(store.profiles["fixture:external"]).toEqual(credential);
    expect(store.runtimeExternalCliProfileIds).toEqual(["fixture:external"]);
  });

  it.each([false, true])(
    "preserves paired route authentication with subscription first=%s",
    async (subscriptionFirst) => {
      const draft: OpenClawConfig = {
        agents: { list: [{ id: "draft", workspace: "/tmp/draft", model: "openai/gpt-5.4" }] },
      };
      const platform = { id: "gpt-5.4", name: "Model", provider: "openai", ...platformRoute };
      const subscription = { ...platform, ...subscriptionRoute };
      const owner = prepareOwner({
        config: draft,
        modelCatalog: {
          entries: [platform],
          routeVariants: subscriptionFirst ? [subscription, platform] : [platform, subscription],
        },
      });
      setPreparedModelRuntimeAuthMaterializations(owner, [
        {
          provider: "openai",
          modelId: "gpt-5.4",
          modelApi: subscriptionRoute.api,
          modelBaseUrl: subscriptionRoute.baseUrl,
          requestTransportOverrides: "none",
          authMode: "oauth",
          runtimeOwnerId: "codex",
        },
      ]);

      const result = await resolveDefaultModelAuthStatus(draft, scope);

      expect(result.evaluation).toMatchObject({
        availability: true,
        evidence: "runtime",
        selectedRoute: subscriptionRoute,
      });
    },
  );

  it("keeps an unobserved selected model indeterminate without forcing discovery", async () => {
    prepareOwner({ modelCatalog: { entries: [], routeVariants: [] } });
    const note = vi.fn(async () => {});

    await warnIfModelConfigLooksOff(config, makePrompter({ note }), scope);

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('Auth readiness could not be confirmed for "fixture/model"'),
      "Model check",
    );
  });

  it("propagates draft acquisition failure instead of checking published config", async () => {
    const error = new Error("draft acquisition failed");
    acquireReadOnlyPreparedModelRuntime.mockRejectedValueOnce(error);

    await expect(resolveDefaultModelAuthStatus(config, scope)).rejects.toBe(error);
    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
  });
});
