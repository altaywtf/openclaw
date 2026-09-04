import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { upsertAuthProfile } from "./auth-profiles/profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  noteRuntimeAuthProfileStorePersistedMutation,
} from "./auth-profiles/runtime-snapshots.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

let state: OpenClawTestState;
let config: OpenClawConfig;

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "prepared-auth-topology",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  config = {
    plugins: { enabled: false },
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: { main: {}, worker: {} },
    },
  };
  await refreshPreparedModelRuntimeSnapshots(config);
});

afterEach(async () => {
  await refreshPreparedModelRuntimeSnapshots({ agents: { entries: {} } });
  resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  await state.cleanup();
});

function saveCredential(key = "fixture-first-key") {
  upsertAuthProfile({
    profileId: "fixture:login",
    credential: { type: "api_key", provider: "fixture", key },
    agentDir: state.agentDir("main"),
  });
}

async function expectPublishedCredential(expectedConfig: OpenClawConfig, key: string) {
  for (const agentId of ["main", "worker"]) {
    const snapshot = await prepareModelRuntimeSnapshot({
      config: expectedConfig,
      agentId,
      agentDir: state.agentDir(agentId),
    });
    expect(snapshot.inheritedAuthDir).toBeUndefined();
    expect(snapshot.config).toEqual(expectedConfig);
    expect(getPreparedModelRuntimeAuthStore(snapshot)?.profiles["fixture:login"]).toMatchObject({
      type: "api_key",
      key,
    });
  }
}

describe("prepared model runtime shared-auth topology", () => {
  it("adopts a first save after an auth-only refresh has claimed publication", async () => {
    noteRuntimeAuthProfileStorePersistedMutation(state.agentDir("main"), {
      credentialsChanged: true,
      profileSetChanged: false,
      stateChanged: false,
      profileIds: [],
    });
    saveCredential();
    await expectPublishedCredential(config, "fixture-first-key");
  });

  it("republishes the first shared credential and accepts a subsequent update", async () => {
    expect(resolveSharedAuthStoreOwnership()).toEqual({ location: "legacy-main" });
    saveCredential();
    expect(resolveSharedAuthStoreOwnership()).toEqual({ location: "state-db" });
    await expectPublishedCredential(config, "fixture-first-key");

    saveCredential("fixture-rotated-key");
    await expectPublishedCredential(config, "fixture-rotated-key");
  });

  it("adopts the first save into a queued config publication without replaying old config", async () => {
    const configRequested = createDeferred<void>();
    const releaseConfig = createDeferred<OpenClawConfig>();
    const nextConfig = { ...config, messages: { responsePrefix: "new-config" } };
    const replacement = refreshPreparedModelRuntimeSnapshots(async () => {
      configRequested.resolve();
      return await releaseConfig.promise;
    });
    try {
      await configRequested.promise;
      saveCredential();
    } finally {
      releaseConfig.resolve(nextConfig);
      await replacement;
    }
    await expectPublishedCredential(nextConfig, "fixture-first-key");
  });

  it("replaces changed auth topology inside the pending config build", async () => {
    const nextConfig = { ...config, messages: { responsePrefix: "during-build" } };
    await refreshPreparedModelRuntimeSnapshots(nextConfig, {
      onBuildStats: vi.fn().mockImplementationOnce(() => saveCredential()),
    });
    await expectPublishedCredential(nextConfig, "fixture-first-key");
  });
});
