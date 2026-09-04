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
import { loadPersistedPluginModelCatalogsReadOnly } from "./plugin-model-catalog.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import { refreshPreparedModelRuntimeSnapshots } from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  resetPreparedModelRuntimeHarness(state);
});
afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
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
