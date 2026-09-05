import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  getPreparedModelCatalogDecisions,
  type ModelCatalogDecisionFacts,
} from "./model-catalog-decisions.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

function createFacts(): ModelCatalogDecisionFacts {
  const entry = { provider: "custom", id: "model", name: "Model" };
  return {
    cfg: { agents: { defaults: { model: "custom/model" } } },
    agentId: "main",
    workspaceDir: "/tmp/catalog-lifetime",
    snapshot: { entries: [entry], routeVariants: [entry] },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    auth: {
      authStore: {
        version: 1,
        profiles: {
          "custom:primary": { type: "api_key", provider: "custom", key: "fixture-key" },
        },
      },
      providerAuth: {},
    },
    env: {},
  };
}

afterEach(() => vi.useRealTimers());

describe("catalog decision lifetime", () => {
  it.each(["agent", "utility", "image"] as const)(
    "limits a session profile lock to its provider for %s decisions",
    async (purpose) => {
      const facts = createFacts();
      const other = { provider: "other", id: "model", name: "Other" };
      facts.snapshot.entries.push(other);
      facts.auth.authStore.profiles["other:primary"] = {
        type: "api_key",
        provider: "other",
        key: "other-fixture-key",
      };
      const source = getPreparedModelCatalogDecisions(facts);
      const selection = { purpose, profileProvider: "custom", lockedProfileId: "missing" };
      const entry = facts.snapshot.entries[0]!;
      expect((await source.evaluate(entry, selection)).availability).toBe(false);
      expect((await source.evaluate(other, selection)).availability).toBe(true);
      expect((await source.evaluate(entry)).availability).toBe(true);
      expect((await source.evaluate(other, selection)).availability).toBe(true);
    },
  );

  it("does not lend another runtime's materialized authentication to the implicit runtime", async () => {
    const facts = createFacts();
    const entry: ModelCatalogEntry = {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    facts.cfg = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    facts.snapshot = { entries: [entry], routeVariants: [entry] };
    facts.auth.authStore.profiles = {};
    facts.authMaterializations = [
      {
        provider: entry.provider,
        modelId: entry.id,
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "none",
        authMode: "api_key",
        runtimeOwnerId: "openclaw",
      },
    ];
    const source = getPreparedModelCatalogDecisions(facts);
    expect(await source.runtime(entry)).toEqual({ id: "codex", source: "implicit" });
    expect((await source.evaluate(entry)).availability).not.toBe(true);
  });

  it.each(["cooldown", "token expiry"] as const)(
    "replaces a stale source at %s without discovering a catalog",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const facts = createFacts();
      if (kind === "cooldown") {
        facts.auth.authStore.usageStats = { "custom:primary": { cooldownUntil: 20_000 } };
      } else {
        facts.auth.authStore.profiles["custom:primary"] = {
          provider: "custom",
          type: "token",
          token: "fixture-token",
          expires: 20_000,
        };
      }
      const entry = facts.snapshot.entries[0]!;
      const first = getPreparedModelCatalogDecisions(facts);
      expect((await first.evaluate(entry)).availability).toBe(kind === "token expiry");
      vi.setSystemTime(20_000);
      expect(first.isCurrent()).toBe(false);
      const second = getPreparedModelCatalogDecisions(facts);
      expect(second).not.toBe(first);
      expect((await second.evaluate(entry)).availability).toBe(kind === "cooldown");
      expect(second.isCurrent()).toBe(true);
      expect(getPreparedModelCatalogDecisions(facts)).toBe(second);
    },
  );

  it.each(["custom:primary", "missing"])(
    "does not borrow native runtime auth for locked profile %s",
    async (lockedProfileId) => {
      const facts = createFacts();
      facts.auth = {
        ...facts.auth,
        providerAuth: { custom: { mode: "oauth", runtime: "custom-cli" } },
      };
      const entry = facts.snapshot.entries[0]!;
      const source = getPreparedModelCatalogDecisions(facts);
      expect((await source.evaluate(entry, { lockedProfileId })).availability).toBe(
        lockedProfileId === "custom:primary",
      );
      expect(await source.runtime(entry, { lockedProfileId })).toBeUndefined();
    },
  );
});
