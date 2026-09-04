import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  prepareStatusModelAuth,
  resolveModelAuthLabel,
  type StatusModelAuth,
} from "./model-auth-label.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ResolvedPublishedModelCatalogOwner } from "./prepared-model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "./prepared-model-runtime.publication-events.js";

const owner = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./prepared-model-catalog.js", () => ({
  loadResolvedPublishedModelCatalogOwner: owner.load,
}));
vi.mock("./cli-backends.js", () => ({
  isCliRuntimeModelBackendForProvider: () => false,
  listCliRuntimeModelBackendBindings: () => [],
  listCliRuntimeProviderIds: () => [],
  resolveCliRuntimeCanonicalProvider: () => undefined,
  resolveCliRuntimeModelBackendBinding: () => undefined,
}));

const config: OpenClawConfig = {
  auth: { order: { demo: ["demo:work", "demo:alternate"] } },
  agents: {
    entries: {
      main: { agentDir: "/tmp/status-auth-agent", workspace: "/tmp/status-auth-workspace" },
    },
  },
};
const catalog: ModelCatalogEntry[] = [
  { provider: "demo", id: "hidden", name: "Hidden", status: "deprecated" },
  { provider: "other", id: "active", name: "Active" },
];
const defaultParams = {
  cfg: config,
  agentId: "main",
  sessionKey: "agent:main:main",
  provider: "demo",
  model: "hidden",
};

function createOwner(): ResolvedPublishedModelCatalogOwner {
  return {
    config,
    agentId: "main",
    agentDir: "/tmp/status-auth-agent",
    workspaceDir: "/tmp/status-auth-workspace",
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/status-auth-workspace" },
    oauthRefreshProviderIds: [],
    modelCatalog: { entries: catalog, routeVariants: catalog },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    authStore: {
      version: 1,
      profiles: {
        "demo:work": { type: "api_key", provider: "demo", key: "test-private-key" },
        "demo:alternate": { type: "token", provider: "demo", token: "test-private-token" },
        "other:work": { type: "api_key", provider: "other", key: "test-other-key" },
      },
    },
    providerAuth: {},
  };
}

beforeEach(() => {
  owner.load.mockReset().mockImplementation(async () => createOwner());
});
afterEach(() => vi.restoreAllMocks());

describe("prepared status model auth", () => {
  it("evaluates a hidden exact model with the user profile lock", async () => {
    const facts = await prepareStatusModelAuth({
      ...defaultParams,
      workspaceDir: "/tmp/spawned-status-workspace",
      sessionEntry: {
        sessionId: "status",
        updatedAt: 1,
        authProfileOverride: "demo:alternate",
        authProfileOverrideSource: "user",
      },
    });

    expect(facts.selected.auth).toMatchObject({
      kind: "prepared",
      evaluation: { selectedProfileId: "demo:alternate", selectedAuthMode: "token" },
    });
    expect(resolveModelAuthLabel(facts.selected.auth)).toBe("token (demo:alternate)");
    expect(owner.load).toHaveBeenCalledWith(
      expect.objectContaining({
        readOnly: true,
        agentId: "main",
        agentDir: "/tmp/status-auth-agent",
        workspaceDir: "/tmp/spawned-status-workspace",
      }),
    );
  });

  it("keeps an absent exact model unknown even when the provider has credentials", async () => {
    const facts = await prepareStatusModelAuth({ ...defaultParams, model: "absent" });
    expect(facts.selected.auth).toEqual({ kind: "unknown" });
    expect(resolveModelAuthLabel(facts.selected.auth)).toBeUndefined();
  });

  it("uses the provider in a qualified session override rather than the configured default", async () => {
    const facts = await prepareStatusModelAuth({
      ...defaultParams,
      provider: "other",
      model: "active",
      sessionEntry: {
        sessionId: "status",
        updatedAt: 1,
        modelOverride: "demo/hidden",
      },
    });
    expect(facts.selected.label).toBe("demo/hidden");
    expect(resolveModelAuthLabel(facts.selected.auth)).toBe("api-key (demo:work)");
  });

  it("prepares different selected and active routes without borrowing their labels", async () => {
    const facts = await prepareStatusModelAuth({
      ...defaultParams,
      sessionEntry: { sessionId: "status", updatedAt: 1, modelProvider: "other", model: "active" },
    });
    expect(facts.activeDiffers).toBe(true);
    expect(resolveModelAuthLabel(facts.selected.auth)).toBe("api-key (demo:work)");
    expect(resolveModelAuthLabel(facts.active.auth)).toBe("api-key (other:work)");
    expect(owner.load).toHaveBeenCalledOnce();
  });

  it("keeps different runtime contexts on one owner across an awaited publication change", async () => {
    const first = createOwner();
    first.modelCatalog.entries = [catalog[0]!, { ...catalog[1]!, nativeRuntime: "fixture-cli" }];
    first.modelCatalog.routeVariants = first.modelCatalog.entries;
    const initialOwner: ResolvedPublishedModelCatalogOwner = {
      ...first,
      providerAuth: { "fixture-cli": { mode: "oauth" } },
    };
    const replacementOwner: ResolvedPublishedModelCatalogOwner = {
      ...first,
      providerAuth: { "fixture-cli": { mode: "token" } },
    };
    const captured = createDeferredCore();
    const resume = createDeferredCore();
    let publishedOwner = initialOwner;
    owner.load.mockImplementation(async () => {
      const snapshot = publishedOwner;
      captured.resolve();
      await resume.promise;
      return snapshot;
    });

    const pending = prepareStatusModelAuth({
      ...defaultParams,
      resolvedHarness: "openclaw",
      sessionEntry: {
        sessionId: "status",
        updatedAt: 1,
        modelProvider: "other",
        model: "active",
        agentHarnessId: "fixture-cli",
      },
    });
    await captured.promise;
    publishedOwner = replacementOwner;
    notifyPreparedModelRuntimePublication({ phase: "published" });
    resume.resolve();

    const facts = await pending;

    expect(resolveModelAuthLabel(facts.selected.auth)).toBe("api-key (demo:work)");
    expect(resolveModelAuthLabel(facts.active.auth)).toBe("oauth");
    expect(facts.selected.runtime?.id).toBe("openclaw");
    expect(facts.active.runtime?.id).toBe("fixture-cli");
    expect(owner.load).toHaveBeenCalledOnce();
  });

  it("captures profile preference and runtime identity before awaited preparation", async () => {
    const sessionEntry = {
      sessionId: "status",
      updatedAt: 1,
      modelProvider: "other",
      model: "active",
      agentHarnessId: "openclaw",
      authProfileOverride: "demo:alternate",
      authProfileOverrideSource: "auto" as const,
    };
    const pending = prepareStatusModelAuth({
      ...defaultParams,
      sessionEntry,
      resolvedHarness: "codex",
    });
    sessionEntry.authProfileOverride = "changed";
    sessionEntry.model = "changed";

    const facts = await pending;

    expect(facts.active.model).toBe("active");
    expect(facts.selected.auth).toMatchObject({
      kind: "prepared",
      evaluation: { selectedProfileId: "demo:alternate" },
    });
    expect(facts.selected.runtime).toEqual({ id: "codex", source: "session" });
    expect(facts.active.runtime).toEqual({ id: "openclaw", source: "session" });
    expect(owner.load).toHaveBeenCalledOnce();
  });

  it("captures legacy label overrides without preparing credentials", async () => {
    const facts = await prepareStatusModelAuth({
      ...defaultParams,
      modelAuthOverride: "oauth (provided)",
      activeModelAuthOverride: undefined,
    });
    expect(facts.selected.auth).toEqual({ kind: "provided", label: "oauth (provided)" });
    expect(facts.active.auth).toEqual({ kind: "provided", label: undefined });
    expect(owner.load).not.toHaveBeenCalled();
  });

  it("prepares the profile binding even when a legacy display label is supplied", async () => {
    const facts = await prepareStatusModelAuth({
      ...defaultParams,
      sessionEntry: {
        sessionId: "status",
        updatedAt: 1,
        authProfileOverride: "demo:alternate",
        authProfileOverrideSource: "user",
      },
      modelAuthOverride: "account label",
    });

    expect(resolveModelAuthLabel(facts.selected.auth)).toBe("account label");
    expect(facts.selected.auth).toMatchObject({
      kind: "prepared",
      evaluation: { selectedProfileId: "demo:alternate", selectedAuthMode: "token" },
    });
  });

  it("keeps an unresolved profile lock when the exact model is absent", async () => {
    const facts = await prepareStatusModelAuth({
      ...defaultParams,
      model: "absent",
      sessionEntry: {
        sessionId: "status",
        updatedAt: 1,
        authProfileOverride: "demo:alternate",
        authProfileOverrideSource: "user",
      },
      modelAuthOverride: "account label",
    });

    expect(facts.lockedProfileId).toBe("demo:alternate");
    expect(facts.selected.auth).toEqual({ kind: "provided", label: "account label" });
  });
});

describe("resolveModelAuthLabel", () => {
  it("labels a deferred route only when the prepared native auth owner is available", () => {
    expect(
      resolveModelAuthLabel({
        kind: "prepared",
        evaluation: {
          availability: true,
          routeResolution: null,
          evidence: "runtime",
          runtimeAuth: { id: "fixture-cli", source: "native" },
        },
      }),
    ).toBe("native (fixture-cli)");
  });

  it.each([
    { kind: "unknown" },
    {
      kind: "prepared",
      evaluation: {
        availability: undefined,
        routeResolution: null,
        runtimeAuth: { id: "fixture-cli", source: "native" },
      },
    },
  ] satisfies StatusModelAuth[])("does not invent a native login from $kind facts", (auth) => {
    expect(resolveModelAuthLabel(auth)).toBeUndefined();
  });

  it.each(["api_key", "api-key", "oauth", "token", "aws-sdk"])(
    "formats prepared %s without reading credentials",
    (mode) => {
      expect(
        resolveModelAuthLabel({
          kind: "prepared",
          evaluation: {
            availability: true,
            routeResolution: null,
            selectedAuthMode: mode,
            selectedProfileId: "demo:work",
          },
        }),
      ).toBe(`${mode === "api_key" ? "api-key" : mode} (demo:work)`);
    },
  );

  it("reports rejected auth rather than a successful native login", () => {
    expect(
      resolveModelAuthLabel({
        kind: "prepared",
        evaluation: {
          availability: false,
          routeResolution: null,
          unavailableReason: "auth-failed",
          runtimeAuth: { id: "fixture-cli", source: "native" },
          selectedAuthMode: "oauth",
        },
      }),
    ).toBe("unavailable (auth-failed)");
  });
});
