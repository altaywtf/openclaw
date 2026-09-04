// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as agentDatabase from "../state/openclaw-agent-db-readonly.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveAgentDir } from "./agent-scope.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { loadPersistedPluginModelCatalogsReadOnly } from "./plugin-model-catalog.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  activateStandalonePreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  readPreparedProviderAuthFacts,
  resetPreparedProviderAuthFactsForTest,
} from "./prepared-provider-auth-facts.js";

const mocks = getPreparedModelRuntimeMocks();

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  resetPreparedModelRuntimeHarness(state);
  resetPreparedProviderAuthFactsForTest();
});
afterEach(async ({ task }) => {
  cliBackendsTesting.resetDepsForTest();
  resetPreparedProviderAuthFactsForTest();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("prepared provider auth publication ownership", () => {
  it.each([
    { kind: "read-only", configuredOwner: false },
    { kind: "read-only", configuredOwner: true },
    { kind: "dynamic run", configuredOwner: true },
  ])(
    "keeps $kind auth local during and after a check (configured owner: $configuredOwner)",
    async ({ kind, configuredOwner }) => {
      mocks.configuredAgentIds = ["default"];
      const config = { agents: { entries: { default: {} } } };
      const expectedGlobalAuth = configuredOwner ? { custom: { mode: "api_key" } } : undefined;
      if (configuredOwner) {
        await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
        const configured = await prepareModelRuntimeSnapshot({
          agentId: "default",
          agentDir: state.agentDir("default"),
          config,
        });
        await configured.loadFullModelCatalog!();
      }
      expect(readPreparedProviderAuthFacts("default")).toEqual(expectedGlobalAuth);
      mocks.authStorage.getAll.mockReturnValue({
        custom: { type: "token", token: "temporary-check-token" },
      });
      const acquire =
        kind === "dynamic run"
          ? acquireAgentRunPreparedModelRuntime
          : acquireReadOnlyPreparedModelRuntime;
      const lease = await acquire({
        agentId: "default",
        agentDir: state.agentDir("default"),
        workspaceDir: state.workspaceDir,
        config,
      });
      let duringCheck: ReturnType<typeof readPreparedProviderAuthFacts>;
      try {
        expect(lease.snapshot.providerAuth).toEqual({ custom: { mode: "token" } });
        duringCheck = readPreparedProviderAuthFacts("default");
      } finally {
        lease.release();
      }
      const afterCheck = readPreparedProviderAuthFacts("default");
      if (configuredOwner) {
        mocks.authStorage.getAll.mockReturnValue({
          updated: { type: "api_key", key: "updated-owner-key" },
        });
        await refreshPreparedModelRuntimeSnapshots(config);
      }
      const afterUpdate = readPreparedProviderAuthFacts("default");
      mocks.configuredAgentIds = [];
      await refreshPreparedModelRuntimeSnapshots({ agents: { entries: {} } });
      expect({
        duringCheck,
        afterCheck,
        afterUpdate,
        afterRemoval: readPreparedProviderAuthFacts("default"),
      }).toEqual({
        duringCheck: expectedGlobalAuth,
        afterCheck: expectedGlobalAuth,
        afterUpdate: configuredOwner ? { updated: { mode: "api_key" } } : undefined,
        afterRemoval: undefined,
      });
    },
  );

  it("preserves standalone native selection through a read-only check and Gateway takeover", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "fixture-cli",
          modelProvider: "custom",
          pluginId: "fixture",
          config: { command: "fixture-cli" },
        },
      ],
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
    });
    mocks.configuredAgentIds = ["default"];
    mocks.authStorage.getAll.mockReturnValue({
      "fixture-cli": {
        type: "oauth",
        access: "native-access",
        refresh: "native-refresh",
        expires: 4_102_444_800_000,
      },
    });
    const input = {
      agentId: "default",
      agentDir: state.agentDir("default"),
      workspaceDir: state.workspaceDir,
      config: { agents: { entries: { default: {} } } },
    };
    const selection = {
      config: input.config,
      agentId: input.agentId,
      provider: "custom",
      modelId: "fixture-model",
    };
    await activateStandalonePreparedModelRuntime(input);
    expect(resolveAgentHarnessPolicy(selection)).toEqual({
      runtime: "fixture-cli",
      runtimeSource: "auth",
    });
    mocks.authStorage.getAll.mockReturnValue({
      custom: { type: "token", token: "temporary-check-token" },
    });
    const lease = await acquireReadOnlyPreparedModelRuntime(input);
    const duringCheck = resolveAgentHarnessPolicy(selection);
    try {
      await refreshPreparedModelRuntimeSnapshots(input.config, { gatewayLifecycle: true });
    } finally {
      lease.release();
    }
    expect({
      duringCheck,
      afterTakeover: readPreparedProviderAuthFacts("default"),
      runtimeAfterTakeover: resolveAgentHarnessPolicy(selection),
    }).toEqual({
      duringCheck: { runtime: "fixture-cli", runtimeSource: "auth" },
      afterTakeover: { custom: { mode: "token" } },
      runtimeAfterTakeover: { runtime: "auto", runtimeSource: "implicit" },
    });
  });

  it("withdraws shared auth while a configured replacement is pending and after failure", async () => {
    mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots({});
    expect(readPreparedProviderAuthFacts("default")).toEqual({ custom: { mode: "api_key" } });
    const nextConfig = createDeferred<Record<string, never>>();
    const replacement = refreshPreparedModelRuntimeSnapshots(() => nextConfig.promise);
    const whilePending = readPreparedProviderAuthFacts("default");
    const rejected = expect(replacement).rejects.toThrow("replacement rejected");
    nextConfig.reject(new Error("replacement rejected"));
    await rejected;
    expect({
      whilePending,
      afterFailure: readPreparedProviderAuthFacts("default"),
    }).toEqual({ whilePending: undefined, afterFailure: undefined });
  });
});

describe("prepared fixture containment", () => {
  function assertOwnedPath(target: string) {
    const relative = path.relative(state.root, path.resolve(target));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`PREPARED_FIXTURE_ESCAPE: ${target}`);
    }
  }

  beforeEach(() => {
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (typeof args[0] === "string" && path.basename(args[0]) === "models.json") {
        assertOwnedPath(args[0]);
      }
      return readFileSync(...args);
    });
    const readDatabase = agentDatabase.withOpenClawAgentDatabaseReadOnly;
    vi.spyOn(agentDatabase, "withOpenClawAgentDatabaseReadOnly").mockImplementation(
      (operation, options, behavior) => {
        // Guard before delegation: the reader may reuse a handle before probing the file.
        assertOwnedPath(options.path!);
        return readDatabase(operation, options, behavior);
      },
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("contains native model capture", async () => {
    mocks.configuredAgentIds = ["default", "worker"];
    await refreshPreparedModelRuntimeSnapshots({});
    expect(mocks.discoverModels).toHaveBeenCalled();
  });

  it("contains the native read-only catalog boundary", () => {
    expect(loadPersistedPluginModelCatalogsReadOnly(resolveAgentDir({}, "default"))).toEqual([]);
    expect(agentDatabase.withOpenClawAgentDatabaseReadOnly).toHaveBeenCalledWith(
      expect.any(Function),
      { agentId: "default", path: path.join(state.agentDir("default"), "openclaw-agent.sqlite") },
    );
  });
});

describe("prepared build candidate lifetime", () => {
  it.each(["failure", "supersession", "timeout"] as const)(
    "closes retained-catalog workers when a batch ends in %s",
    async (outcome) => {
      let current = true;
      const auth = { authStore: { version: 1, profiles: {} }, providerAuth: {} };
      const secondAuth = createDeferred<typeof auth>();
      mocks.runPreparedModelAuthWorker
        .mockResolvedValueOnce(auth)
        .mockImplementationOnce(() => secondAuth.promise);
      const candidates = ["first", "second"].map((agentId) => {
        const input = { config: {}, agentDir: state.agentDir(agentId), readOnly: true };
        return {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          catalogInventory: { snapshot: { entries: [], routeVariants: [] } },
          isGenerationCurrent: () => current,
          isBuildCurrent: () => current,
        };
      });
      const build = startSerializedSnapshotBuildBatch(
        candidates,
        new Map(),
        outcome === "timeout" ? 100 : 1_000,
      );
      const rejection = expect(build.pending).rejects.toThrow(
        outcome === "failure"
          ? "auth unavailable"
          : outcome === "timeout"
            ? "timed out"
            : "superseded",
      );
      try {
        await vi.waitFor(() => expect(mocks.runPreparedModelAuthWorker).toHaveBeenCalledTimes(2));
        const closedBeforeEnd = mocks.closePreparedModelCatalogWorker.mock.calls.length;
        if (outcome === "failure") {
          secondAuth.reject(new Error("auth unavailable"));
        } else if (outcome === "supersession") {
          current = false;
          secondAuth.resolve(auth);
        } else {
          await rejection;
          secondAuth.resolve(auth);
        }
        await rejection;
        await build.completion;
        expect(closedBeforeEnd).toBe(0);
        expect(mocks.closePreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
      } finally {
        secondAuth.resolve(auth);
        await build.completion;
      }
    },
  );

  it("fails a timed-out publication without overlapping its late build with a retry", async () => {
    getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
    const build = createDeferred<{ entries: []; routeVariants: [] }>();
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => await build.promise);
    const input = { config: {}, agentDir: state.agentDir("timeout") };
    const candidate = {
      input: { ...input, readOnly: true },
      catalogOwner: preparePublishedModelCatalogOwnerIdentity({ ...input, readOnly: true }),
      catalogInventory: {},
    };
    const first = startSerializedSnapshotBuildBatch([candidate], new Map(), 1_000);
    try {
      await expect(first.pending).rejects.toThrow("prepared model runtime publication timed out");
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();

      build.resolve({ entries: [], routeVariants: [] });
      await first.completion;
      const retry = startSerializedSnapshotBuildBatch([candidate], new Map(), 1_000);
      await expect(retry.pending).resolves.toHaveLength(1);
      await retry.completion;
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    } finally {
      build.resolve({ entries: [], routeVariants: [] });
      await first.completion;
    }
  });

  it.each([
    {
      name: "batch explicit generation",
      generation: true,
      build: true,
      allowed: true,
      callbacks: true,
    },
    {
      name: "batch default",
      generation: undefined,
      build: undefined,
      allowed: true,
      callbacks: false,
    },
    {
      name: "batch build-only",
      generation: undefined,
      build: true,
      allowed: true,
      callbacks: false,
    },
    {
      name: "batch missing build predicate",
      generation: false,
      build: undefined,
      allowed: true,
      callbacks: false,
    },
    {
      name: "batch inherited generation predicate",
      generation: false,
      build: false,
      allowed: false,
      callbacks: false,
    },
  ])("preserves $name semantics", async ({ generation, build, allowed, callbacks }) => {
    const input = { config: {}, agentDir: state.agentDir("candidate-lifetime"), readOnly: true };
    const candidate = {
      input,
      catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
      catalogInventory: {},
      ...(generation === undefined ? {} : { isGenerationCurrent: () => generation }),
      ...(build === undefined ? {} : { isBuildCurrent: () => build }),
    };
    const started = startSerializedSnapshotBuildBatch([candidate], new Map(), 1_000);
    try {
      if (!allowed) {
        await expect(started.pending).rejects.toThrow("superseded");
      } else {
        const { snapshot } = (await started.pending)[0]!;
        if (callbacks) {
          await expect(snapshot.loadFullModelCatalog!()).resolves.toMatchObject({ entries: [] });
        } else {
          await expect(snapshot.loadFullModelCatalog!()).rejects.toThrow("superseded");
        }
      }
      expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    } finally {
      await started.completion;
    }
  });

  it.each(["before", "after"] as const)(
    "checks supersession %s workspace preparation",
    async (checkpoint) => {
      const input = {
        config: {},
        agentDir: state.agentDir("candidate-checkpoint"),
        readOnly: true,
      };
      const candidate = {
        input,
        catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
        catalogInventory: {},
        isGenerationCurrent: () => false,
        isBuildCurrent: () => false,
        ...(checkpoint === "before" ? { isPreparationCurrent: () => false } : {}),
      };
      const build = startSerializedSnapshotBuildBatch([candidate], new Map(), 1_000);
      try {
        await expect(build.pending).rejects.toThrow("superseded");
        expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(checkpoint === "before" ? 0 : 1);
        expect(mocks.discoverModels).not.toHaveBeenCalled();
      } finally {
        await build.completion;
      }
    },
  );
});
