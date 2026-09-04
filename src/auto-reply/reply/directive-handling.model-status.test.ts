import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedProviderAuth } from "../../agents/agent-auth-credential-modes.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { loadPreparedModelCatalogView } from "../../agents/model-catalog-view.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const catalogOwner = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadResolvedPublishedModelCatalogOwner: catalogOwner.load,
}));

vi.mock("../../agents/cli-backends.js", () => ({
  isCliRuntimeModelBackendForProvider: () => false,
  listCliRuntimeModelBackendBindings: () => [],
  listCliRuntimeProviderIds: () => [],
  resolveCliRuntimeCanonicalProvider: () => undefined,
  resolveCliRuntimeModelBackendBinding: () => undefined,
}));

const agentDir = "/tmp/chat-model-status/agent";
const workspaceDir = "/tmp/chat-model-status/workspace";
const ready: ModelCatalogEntry = {
  provider: "demo",
  id: "ready",
  name: "Ready",
  api: "openai-completions",
  baseUrl: "https://models.example.test/v1",
};
let config: OpenClawConfig;
let snapshot: ModelCatalogSnapshot;
let authStore: AuthProfileStore;
let providerAuth: PreparedProviderAuth;

beforeEach(() => {
  config = {
    agents: {
      defaults: {
        model: { primary: "demo/ready" },
        models: { "demo/ready": { alias: "Approved" } },
      },
    },
  };
  snapshot = { entries: [ready], routeVariants: [ready] };
  authStore = {
    version: 1,
    profiles: {
      "demo:work": { provider: "demo", type: "api_key", key: "test-private-key" },
    },
  };
  providerAuth = {};
  catalogOwner.load.mockReset().mockImplementation(async () => ({
    agentDir,
    agentId: "main",
    workspaceDir,
    config,
    modelCatalog: snapshot,
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    authStore,
    providerAuth,
  }));
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
});

function status(overrides: Partial<Parameters<typeof maybeHandleModelDirectiveInfo>[0]> = {}) {
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: authStore }]);
  return maybeHandleModelDirectiveInfo({
    directives: parseInlineSessionDirectives("/model status"),
    cfg: config,
    agentDir,
    activeAgentId: "main",
    workspaceDir,
    provider: "demo",
    model: "ready",
    defaultProvider: "demo",
    defaultModel: "ready",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    allowedModelKeys: new Set(),
    allowedModelCatalog: snapshot.entries,
    currentThinkLevel: "off",
    resetModelOverride: false,
    ...overrides,
  });
}

describe("/model status prepared catalog", () => {
  it("excludes retired and unauthenticated inventory rows, not just nested duplicates", async () => {
    config.agents!.defaults!.modelPolicy = { allow: [] };
    const retired = { ...ready, id: "retired", status: "deprecated" as const };
    const missing = { provider: "unavailable", id: "unconfigured", name: "Unconfigured" };
    snapshot.entries = [ready, retired, missing];
    snapshot.routeVariants = snapshot.entries;
    const prepared = await loadPreparedModelCatalogView({
      config,
      agentDir,
      agentId: "main",
      workspaceDir,
      readOnly: true,
    });
    expect(prepared.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "demo/ready",
    ]);

    const reply = await status();

    expect(reply?.text).toContain("  • demo/ready");
    expect(reply?.text).not.toContain("demo/retired");
    expect(reply?.text).not.toContain("unavailable/unconfigured");
  });

  it("reports the prepared profile rejection rather than stored credential presence", async () => {
    snapshot.providerOutcomes = [
      { provider: "demo", profileId: "demo:work", status: "auth-rejected" },
    ];
    const prepared = await loadPreparedModelCatalogView({ config, agentId: "main" });
    expect(prepared.evaluate(prepared.entries[0]!)).toMatchObject({
      availability: false,
      unavailableReason: "auth-failed",
      selectedProfileId: "demo:work",
    });

    const reply = await status();

    expect(reply?.text).toContain("unavailable: auth-failed");
    expect(reply?.text).toContain("profile: demo:work");
    expect(reply?.text).not.toContain("test-private-key");
  });

  it("keeps configured unknown availability, aliases, and prepared route details", async () => {
    const offline = { ...ready, id: "offline", provider: "other", name: "Offline" };
    snapshot.entries.push(offline);
    snapshot.routeVariants = snapshot.entries;
    config.agents!.defaults!.models!["other/offline"] = {};

    const reply = await status();

    expect(reply?.text).toContain("demo/ready (Approved)");
    expect(reply?.text).toContain("available");
    expect(reply?.text).toContain("profile: demo:work");
    expect(reply?.text).toContain("other/offline");
    expect(reply?.text).toContain("availability unknown");
    expect(reply?.text).toContain("endpoint: https://models.example.test/v1");
    expect(reply?.text).toContain("api: openai-completions");
  });

  it("does not apply one model's auth label to its provider's other runtime", async () => {
    const native = { ...ready, id: "native", nativeRuntime: "fixture-cli" };
    snapshot.entries.push(native);
    snapshot.routeVariants = snapshot.entries;
    snapshot.providerOutcomes = [
      { provider: "demo", profileId: "demo:work", status: "auth-rejected" },
    ];
    config.agents!.defaults!.models!["demo/native"] = {
      agentRuntime: { id: "fixture-cli" },
    };
    providerAuth = { "fixture-cli": { mode: "oauth" } };

    const reply = await status();
    const rows = reply?.text?.split("\n") ?? [];

    expect(rows.find((line) => line.includes("  • demo/ready"))).toContain(
      "unavailable: auth-failed",
    );
    expect(rows.find((line) => line.includes("  • demo/native"))).toContain(
      "available; auth: oauth",
    );
    expect(rows.find((line) => line.includes("  • demo/native"))).toContain("runtime: fixture-cli");
    expect(rows.find((line) => line.startsWith("[demo]"))).toBe("[demo]");
  });

  it.each([false, true])(
    "retains explicitly configured nested duplicates: %s",
    async (configureDirect) => {
      const direct = { provider: "other", id: "chat", name: "Direct" };
      const nested = { ...ready, id: "other/chat" };
      config = {
        agents: {
          defaults: {
            model: { primary: "demo/other/chat" },
            models: {
              "demo/other/chat": {},
              ...(configureDirect ? { "other/chat": {} } : {}),
            },
          },
        },
      };
      snapshot.entries = [direct, nested];
      snapshot.routeVariants = snapshot.entries;

      const reply = await status();

      expect(reply?.text).toContain("  • demo/other/chat");
      expect(reply?.text?.includes("  • other/chat")).toBe(configureDirect);
    },
  );

  it("uses the prepared agent policy rather than the caller's stale catalog", async () => {
    const blocked = { ...ready, id: "blocked" };
    snapshot.entries.push(blocked);
    snapshot.routeVariants = snapshot.entries;
    config.agents!.defaults!.modelPolicy = { allow: ["demo/ready"] };

    const reply = await status({
      allowedModelKeys: new Set(["demo/*"]),
      allowedModelCatalog: snapshot.entries,
    });

    expect(reply?.text).toContain("  • demo/ready");
    expect(reply?.text).not.toContain("  • demo/blocked");
    expect(catalogOwner.load).toHaveBeenCalledWith(
      expect.objectContaining({ config, agentDir, agentId: "main", workspaceDir, readOnly: true }),
    );
  });

  it("keeps selected and active session facts separate from catalog defaults", async () => {
    const reply = await status({
      provider: "session",
      model: "selected",
      defaultProvider: "stale",
      defaultModel: "default",
      sessionEntry: {
        modelProvider: "fallback",
        model: "active",
        agentRuntimeOverride: "codex",
      },
      resetModelOverride: true,
    });

    expect(reply?.text).toContain("Current: session/selected (selected)");
    expect(reply?.text).toContain("Active: fallback/active (runtime)");
    expect(reply?.text).toContain("Default: demo/ready");
    expect(reply?.text).toContain("Session runtime: codex");
    expect(reply?.text).toContain("(previous selection reset to default)");
    expect(reply?.text).toContain("Agent: main");
  });

  it("keeps current session information when the prepared catalog is empty", async () => {
    config = {};
    snapshot = { entries: [], routeVariants: [], refreshFailed: true };

    const reply = await status({ provider: "session", model: "selected" });

    expect(reply?.text).toContain("Current: session/selected");
    expect(reply?.text).toContain("No models available.");
    expect(reply?.text).toContain("Catalog refresh failed");
  });

  it("leaves explicit model selections to the selection handler", async () => {
    expect(
      await status({ directives: parseInlineSessionDirectives("/model demo/ready -s") }),
    ).toBeUndefined();
    expect(catalogOwner.load).not.toHaveBeenCalled();
  });
});
