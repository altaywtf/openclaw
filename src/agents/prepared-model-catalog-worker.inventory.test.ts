import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "../plugins/provider-catalog.types.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import { prepareModelCatalogView } from "./model-catalog-view.js";
import { loadPersistedPluginModelCatalogsReadOnly } from "./plugin-model-catalog.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { readPublishedPreparedModelCatalog } from "./prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import { acquireReadOnlyPreparedModelRuntime } from "./prepared-model-runtime.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const PROVIDER_ID = "inventory-hosted";
const PLUGIN_ID = "inventory-owner";
const PROFILE_ID = `${PROVIDER_ID}:account`;
const API_BASE_URL = "https://api.inventory.invalid/v1";
const ACCOUNT_BASE_URL = "https://account.inventory.invalid/v1";
const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 4_096,
  };
}

async function createInventoryFixture(
  options: {
    mode?: "merge" | "replace";
    allow?: string[];
    baseUrl?: string;
    headers?: Record<string, string>;
    configuredModels?: ModelDefinitionConfig[];
    observedModels?: ModelDefinitionConfig[];
    providerCredentials?: Pick<ModelProviderConfig, "apiKey" | "authHeader" | "headers">;
    refreshResult?: ProviderCatalogResult;
  } = {},
) {
  const root = makeTempDir("openclaw-worker-inventory-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const pluginDir = path.join(root, "plugin");
  const pluginFile = path.join(pluginDir, "index.cjs");
  const marker = path.join(root, "catalog-calls.jsonl");
  const normalizedRoutes = path.join(root, "normalized-routes.jsonl");
  for (const directory of [agentDir, workspaceDir, pluginDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const env = { ...process.env };
  const curatedModels = [model("known"), model("new-account-model"), model("curated-only")];
  const observedModels = options.observedModels ?? curatedModels.slice(0, 2);
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
const refreshResult = ${JSON.stringify(options.refreshResult ?? null)};
let catalogCalls = 0;
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)},
      label: "Inventory hosted fixture",
      auth: [],
      normalizeResolvedModel({ model }) {
        fs.appendFileSync(${JSON.stringify(normalizedRoutes)}, JSON.stringify({
          isMainThread,
          id: model.id,
          api: model.api,
          baseUrl: model.baseUrl,
        }) + "\\n");
        return model;
      },
      catalog: {
        order: "simple",
        run(context) {
          const auth = context.resolveProviderAuth(${JSON.stringify(PROVIDER_ID)});
          const result = ++catalogCalls > 1 && refreshResult ? refreshResult : { provider: {
            baseUrl: ${JSON.stringify(ACCOUNT_BASE_URL)},
            api: "openai-responses",
            auth: "oauth",
            ...${JSON.stringify(options.providerCredentials ?? {})},
            models: ${JSON.stringify(observedModels)},
          } };
          fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
            isMainThread,
            mode: auth.mode,
            source: auth.source,
            agentDir: context.agentDir,
            models: (result.provider?.models ?? []).map((entry) => entry.id),
            outcomes: result.outcomes,
          }) + "\\n");
          return result;
        },
      },
    });
  },
};
`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      modelCatalog: {
        providers: {
          [PROVIDER_ID]: {
            baseUrl: API_BASE_URL,
            api: "openai-responses",
            models: curatedModels,
          },
        },
        discovery: { [PROVIDER_ID]: "refreshable" },
      },
    }),
  );
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: `${PROVIDER_ID}/known`,
        models: { [`${PROVIDER_ID}/known`]: {} },
        modelPolicy: { allow: options.allow ?? [] },
      },
    },
    models: {
      mode: options.mode ?? "merge",
      providers: {
        [PROVIDER_ID]: {
          baseUrl: options.baseUrl ?? API_BASE_URL,
          api: "openai-responses",
          ...(options.headers ? { headers: options.headers } : {}),
          models: options.configuredModels ?? [model("known"), model("configured-only")],
        },
      },
    },
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [pluginFile] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    },
  };
  const configBefore = structuredClone(config);
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        [PROFILE_ID]: {
          type: "oauth",
          provider: PROVIDER_ID,
          access: "inventory-access-not-real",
          refresh: "inventory-refresh-not-real",
          expires: 4_102_444_800_000,
        },
      },
    },
    agentDir,
  );
  const input = {
    agentId: "main",
    agentDir,
    inheritedAuthDir: agentDir,
    workspaceDir,
    config,
    env,
  };
  let current = true;
  retireAfterTest(() => {
    current = false;
  });
  const [build] = await startSerializedSnapshotBuildBatch(
    [
      {
        input,
        catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
        catalogInventory: {},
        isGenerationCurrent: () => current,
        isBuildCurrent: () => current,
      },
    ],
    new Map(),
    30_000,
  ).pending;
  if (!build?.snapshot.loadFullModelCatalog) {
    throw new Error("inventory fixture did not publish a full-catalog loader");
  }
  const loadFullCatalog = build.snapshot.loadFullModelCatalog;
  return {
    input,
    config,
    configBefore,
    agentDir,
    marker,
    normalizedRoutes,
    snapshot: build.snapshot,
    loadFullCatalog,
    project: async (view: "all" | "configured" | "default") => {
      const fullCatalog = build.snapshot.readFullModelCatalog?.();
      const published = readPublishedPreparedModelCatalog(build.snapshot);
      const auth = fullCatalog
        ? getPreparedModelFullCatalogAuth(fullCatalog)
        : {
            authStore: getPreparedModelRuntimeAuthStore(build.snapshot),
            providerAuth: build.snapshot.providerAuth,
          };
      if (!auth?.authStore) {
        throw new Error("inventory catalog omitted its paired account auth");
      }
      return prepareModelCatalogView({
        cfg: config,
        agentId: "main",
        workspaceDir,
        snapshot: published.modelCatalog,
        metadataSnapshot: build.snapshot.metadataSnapshot,
        auth: { authStore: auth.authStore, providerAuth: auth.providerAuth },
        view,
        env,
      });
    },
    close: async () => {
      current = false;
      await build.close();
    },
  };
}

describe("prepared worker inventory ownership", () => {
  it.each([
    {
      name: "native provider preset",
      configuredRoute: {},
      expectedApi: "openai-responses",
      expectedBaseUrl: ACCOUNT_BASE_URL,
    },
    {
      name: "explicit model proxy",
      configuredRoute: {
        api: "openai-completions",
        baseUrl: "https://operator-model.example.test/v1",
      },
      expectedApi: "openai-completions",
      expectedBaseUrl: "https://operator-model.example.test/v1",
    },
    {
      name: "explicit model native pin",
      configuredRoute: { api: "openai-completions", baseUrl: API_BASE_URL },
      expectedApi: "openai-completions",
      expectedBaseUrl: API_BASE_URL,
    },
  ] as const)(
    "preserves account route ownership beside a $name",
    async ({ configuredRoute, expectedApi, expectedBaseUrl }) => {
      const fixture = await createInventoryFixture({
        configuredModels: [{ ...model("known"), ...configuredRoute }, model("configured-only")],
        observedModels: ["known", "new-account-model"].map(
          (id): ModelDefinitionConfig =>
            Object.assign(model(id), {
              api: "openai-responses",
              baseUrl: ACCOUNT_BASE_URL,
            }),
        ),
      });
      try {
        const catalog = await fixture.loadFullCatalog();
        const view = await fixture.project("all");
        const expectedRoutes = [
          { id: "known", api: expectedApi, baseUrl: expectedBaseUrl },
          { id: "new-account-model", api: "openai-responses", baseUrl: ACCOUNT_BASE_URL },
        ];
        for (const route of expectedRoutes) {
          const publishedRoute = expect.objectContaining({ provider: PROVIDER_ID, ...route });
          expect.soft(catalog.entries).toContainEqual(publishedRoute);
          expect.soft(catalog.routeVariants).toContainEqual(publishedRoute);
          expect.soft(view.entries).toContainEqual(publishedRoute);
        }
        const shard = loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [PLUGIN_ID])[0];
        expect(shard).toBeDefined();
        expect.soft(JSON.parse(shard!.contents)).toMatchObject({
          providers: {
            [PROVIDER_ID]: {
              models: expect.arrayContaining(
                expectedRoutes.map((route) => expect.objectContaining(route)),
              ),
            },
          },
        });
        const normalized = fs
          .readFileSync(fixture.normalizedRoutes, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(normalized).toEqual(
          expect.arrayContaining(
            expectedRoutes.map((route) =>
              expect.objectContaining({ isMainThread: false, ...route }),
            ),
          ),
        );
        expect(fixture.config).toEqual(fixture.configBefore);
      } finally {
        await fixture.close();
      }
    },
  );

  it("retains curated browse inventory after full publication without inventing account access", async () => {
    const fixture = await createInventoryFixture();
    try {
      expect(fs.existsSync(fixture.marker)).toBe(false);
      expect(fixture.snapshot.modelCatalog.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: PROVIDER_ID, id: "new-account-model" }),
          expect.objectContaining({ provider: PROVIDER_ID, id: "curated-only" }),
        ]),
      );
      const catalog = await fixture.loadFullCatalog();
      expect(JSON.parse(fs.readFileSync(fixture.marker, "utf8").trim().split("\n")[0]!)).toEqual({
        isMainThread: false,
        mode: "oauth",
        source: "profile",
        agentDir: fixture.agentDir,
        models: ["known", "new-account-model"],
      });
      expect(catalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "new-account-model" }),
      );
      const view = await fixture.project("all");
      const observed = view.entries.find((entry) => entry.id === "new-account-model");
      const curated = view.entries.find((entry) => entry.id === "curated-only");

      expect(observed).toBeDefined();
      expect(curated).toBeDefined();
      expect(view.evaluate(observed!).availability).toBe(true);
      expect(view.evaluate(curated!).availability).not.toBe(true);
      expect(view.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "configured-only" }),
      );
      expect(fixture.config).toEqual(fixture.configBefore);
    } finally {
      await fixture.close();
    }
  });

  it("keeps explicit model policy separate from the completed account inventory", async () => {
    const fixture = await createInventoryFixture({ allow: [`${PROVIDER_ID}/known`] });
    try {
      await fixture.loadFullCatalog();
      const configured = await fixture.project("configured");
      const all = await fixture.project("all");

      expect(configured.entries.map((entry) => entry.id)).toEqual(["known"]);
      expect(all.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "new-account-model" }),
      );
      expect(fixture.config).toEqual(fixture.configBefore);
    } finally {
      await fixture.close();
    }
  });

  it("reads a worker-persisted account-only model in a fresh static owner", async () => {
    const fixture = await createInventoryFixture({
      observedModels: ["known", "account-only"].map((id) =>
        Object.assign(model(id), { api: "openai-responses", baseUrl: ACCOUNT_BASE_URL }),
      ),
    });
    try {
      expect(loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [PLUGIN_ID])).toEqual([]);
      await fixture.loadFullCatalog();
      const persisted = loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [PLUGIN_ID]);
      const shard = persisted.find((catalog) => catalog.pluginId === PLUGIN_ID);
      expect(shard).toBeDefined();
      expect(JSON.parse(shard!.contents)).toMatchObject({
        providers: {
          [PROVIDER_ID]: {
            models: expect.arrayContaining([expect.objectContaining({ id: "account-only" })]),
          },
        },
      });
      const catalogCalls = fs.readFileSync(fixture.marker, "utf8");
      await fixture.close();

      const lease = await acquireReadOnlyPreparedModelRuntime(fixture.input);
      try {
        expect.soft(lease.snapshot.modelCatalog.entries).toContainEqual(
          expect.objectContaining({
            provider: PROVIDER_ID,
            id: "known",
            baseUrl: ACCOUNT_BASE_URL,
          }),
        );
        expect.soft(lease.snapshot.modelCatalog.entries).toContainEqual(
          expect.objectContaining({
            provider: PROVIDER_ID,
            id: "account-only",
            baseUrl: ACCOUNT_BASE_URL,
          }),
        );
        expect
          .soft(lease.snapshot.modelCatalog.entries)
          .toContainEqual(expect.objectContaining({ provider: PROVIDER_ID, id: "curated-only" }));
        expect(fs.readFileSync(fixture.marker, "utf8")).toBe(catalogCalls);
        expect(loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [PLUGIN_ID])).toEqual(
          persisted,
        );
        expect(fixture.config).toEqual(fixture.configBefore);
      } finally {
        lease.release();
      }
    } finally {
      await fixture.close();
    }
  });

  it("retains last-good account inventory on an unavailable outcome with current auth", async () => {
    const outcome: ProviderCatalogOutcome = { provider: PROVIDER_ID, status: "unavailable" };
    const cachedCredentials = {
      apiKey: "retired-cache-key-not-real",
      authHeader: true,
      headers: { Authorization: "Bearer retired-cache-token-not-real" },
    };
    const cachedModelHeaders = { Authorization: "Bearer retired-model-token-not-real" };
    const fixture = await createInventoryFixture({
      observedModels: [model("known"), { ...model("account-only"), headers: cachedModelHeaders }],
      providerCredentials: cachedCredentials,
      refreshResult: { providers: {}, outcomes: [outcome] },
    });
    try {
      await fixture.loadFullCatalog();
      const expectedCachedCatalog = expect.objectContaining({
        providers: expect.objectContaining({
          [PROVIDER_ID]: expect.objectContaining({
            models: expect.arrayContaining([
              expect.objectContaining({ id: "account-only", baseUrl: ACCOUNT_BASE_URL }),
            ]),
          }),
        }),
      });
      const cachedCatalogs = loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [
        PLUGIN_ID,
      ]).map((catalog) => JSON.parse(catalog.contents));
      expect(cachedCatalogs).toContainEqual(expectedCachedCatalog);
      expect(cachedCatalogs).toContainEqual(
        expect.objectContaining({
          providers: expect.objectContaining({
            [PROVIDER_ID]: expect.objectContaining({
              ...cachedCredentials,
              models: expect.arrayContaining([
                expect.objectContaining({ id: "account-only", headers: cachedModelHeaders }),
              ]),
            }),
          }),
        }),
      );
      const initialView = await fixture.project("all");
      const initialModel = initialView.entries.find((entry) => entry.id === "account-only");
      expect(initialModel).toBeDefined();
      expect(initialView.evaluate(initialModel!).availability).toBe(true);

      saveAuthProfileStore({ version: 1, profiles: {} }, fixture.agentDir);
      await fixture.loadFullCatalog({ refresh: true });
      const published = readPublishedPreparedModelCatalog(fixture.snapshot).modelCatalog;
      const auth = getPreparedModelFullCatalogAuth(published);

      expect(JSON.parse(fs.readFileSync(fixture.marker, "utf8").trim().split("\n")[1]!)).toEqual({
        isMainThread: false,
        mode: "none",
        source: "none",
        agentDir: fixture.agentDir,
        models: [],
        outcomes: [outcome],
      });
      const retainedRow = expect.objectContaining({
        provider: PROVIDER_ID,
        id: "account-only",
        baseUrl: ACCOUNT_BASE_URL,
      });
      expect.soft(published.entries).toContainEqual(retainedRow);
      expect.soft(published.routeVariants).toContainEqual(retainedRow);
      expect.soft(published.providerOutcomes).toContainEqual(outcome);
      expect.soft(published.refreshFailed).toBe(true);
      expect(auth).toBeDefined();
      expect(auth!.authStore.profiles[PROFILE_ID]).toBeUndefined();
      const persistedAfterFailure = loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [
        PLUGIN_ID,
      ]);
      expect
        .soft(persistedAfterFailure.map((catalog) => JSON.parse(catalog.contents)))
        .toContainEqual(expectedCachedCatalog);
      const recoveredProvider = JSON.parse(persistedAfterFailure[0]!.contents).providers[
        PROVIDER_ID
      ];
      for (const field of ["apiKey", "auth", "authHeader", "headers"]) {
        expect(recoveredProvider).not.toHaveProperty(field);
      }
      for (const recoveredModel of recoveredProvider.models) {
        expect(recoveredModel).not.toHaveProperty("headers");
      }

      const view = await fixture.project("all");
      const retainedModel = view.entries.find((entry) => entry.id === "account-only");
      expect(retainedModel).toBeDefined();
      expect(view.evaluate(retainedModel!).availability).toBeUndefined();
      expect(fixture.config).toEqual(fixture.configBefore);
      const catalogCalls = fs.readFileSync(fixture.marker, "utf8");
      await fixture.close();
      const lease = await acquireReadOnlyPreparedModelRuntime(fixture.input);
      try {
        expect.soft(lease.snapshot.modelCatalog.entries).toContainEqual(retainedRow);
        expect(fs.readFileSync(fixture.marker, "utf8")).toBe(catalogCalls);
        expect(loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [PLUGIN_ID])).toEqual(
          persistedAfterFailure,
        );
      } finally {
        lease.release();
      }
    } finally {
      await fixture.close();
    }
  });

  it.each(["unavailable", "auth-rejected", "ready"] as const)(
    "retains cached account rows only for a failed discovery outcome: %s",
    async (status) => {
      const outcomes: ProviderCatalogOutcome[] = [{ provider: PROVIDER_ID, status }];
      const fixture = await createInventoryFixture({
        observedModels: [model("known"), model("account-only")],
        refreshResult:
          status === "ready"
            ? {
                provider: {
                  api: "openai-responses",
                  baseUrl: ACCOUNT_BASE_URL,
                  models: [],
                },
                outcomes,
              }
            : { providers: {}, outcomes },
      });
      const readCachedCatalogs = () =>
        loadPersistedPluginModelCatalogsReadOnly(fixture.agentDir, [PLUGIN_ID]).map((catalog) =>
          JSON.parse(catalog.contents),
        );
      const accountInventory = expect.objectContaining({
        providers: expect.objectContaining({
          [PROVIDER_ID]: expect.objectContaining({
            models: expect.arrayContaining([expect.objectContaining({ id: "account-only" })]),
          }),
        }),
      });
      try {
        await fixture.loadFullCatalog();
        expect(readCachedCatalogs()).toContainEqual(accountInventory);
        await fixture.loadFullCatalog({ refresh: true });

        if (status === "ready") {
          expect(readCachedCatalogs()).not.toContainEqual(accountInventory);
        } else {
          expect(readCachedCatalogs()).toContainEqual(accountInventory);
        }
        expect(readCachedCatalogs()).toContainEqual(
          expect.objectContaining({
            providers: expect.objectContaining({
              [PROVIDER_ID]: expect.objectContaining({
                models: expect.arrayContaining([
                  expect.objectContaining({ id: "configured-only" }),
                ]),
              }),
            }),
          }),
        );
        expect(fixture.config).toEqual(fixture.configBefore);
      } finally {
        await fixture.close();
      }
    },
  );

  it("keeps an authored proxy under a native provider ID manual without native discovery", async () => {
    const proxyBaseUrl = "https://operator-proxy.example.test/v1";
    const fixture = await createInventoryFixture({
      baseUrl: proxyBaseUrl,
      headers: { "x-operator-route": "preserve" },
    });
    const expectedRows = [
      { id: "configured-only", baseUrl: proxyBaseUrl },
      { id: "known", baseUrl: proxyBaseUrl },
    ];
    try {
      expect
        .soft(
          fixture.snapshot.modelCatalog.entries
            .filter((entry) => entry.provider === PROVIDER_ID)
            .map(({ id, baseUrl }) => ({ id, baseUrl }))
            .toSorted((left, right) => left.id.localeCompare(right.id)),
        )
        .toEqual(expectedRows);
      const catalog = await fixture.loadFullCatalog();
      const view = await fixture.project("all");

      expect
        .soft(
          catalog.entries
            .filter((entry) => entry.provider === PROVIDER_ID)
            .map(({ id, baseUrl }) => ({ id, baseUrl }))
            .toSorted((left, right) => left.id.localeCompare(right.id)),
        )
        .toEqual(expectedRows);
      expect
        .soft(
          view.entries
            .filter((entry) => entry.provider === PROVIDER_ID)
            .map(({ id, baseUrl }) => ({ id, baseUrl }))
            .toSorted((left, right) => left.id.localeCompare(right.id)),
        )
        .toEqual(expectedRows);
      expect.soft(fs.existsSync(fixture.marker)).toBe(false);
      expect(fixture.config).toEqual(fixture.configBefore);
    } finally {
      await fixture.close();
    }
  });

  it("keeps replace mode manual through startup and full publication without account discovery", async () => {
    const fixture = await createInventoryFixture({ mode: "replace" });
    try {
      expect
        .soft(fixture.snapshot.modelCatalog.entries.map((entry) => entry.id).toSorted())
        .toEqual(["configured-only", "known"]);
      for (const phase of ["startup", "full"] as const) {
        if (phase === "full") {
          await fixture.loadFullCatalog();
        }
        for (const requestedView of ["default", "configured", "all"] as const) {
          const view = await fixture.project(requestedView);
          expect(view.entries.map((entry) => entry.id).toSorted()).toEqual([
            "configured-only",
            "known",
          ]);
          expect(fs.existsSync(fixture.marker)).toBe(false);
        }
      }
      expect(fixture.config).toEqual(fixture.configBefore);
    } finally {
      await fixture.close();
    }
  });
});
