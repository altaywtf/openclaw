import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import type { SystemAgentConfiguredRoute } from "../../system-agent/inference-route.js";
import {
  runSetupInferenceTurn,
  verifySetupInference,
} from "../../system-agent/setup-inference-turn.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import { resolveAuthProfileOrder } from "./order.js";
import {
  loadPendingAuthProfileStore,
  preparePendingAuthProfileProbe,
  promotePendingAuthProfile,
  saveAuthProfileCandidates,
  withPendingAuthProfileProbe,
} from "./pending.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { readPersistedAuthProfileStateRaw, readPersistedAuthProfileStoreRaw } from "./sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore } from "./store.js";
import { upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

const provider = "pending-execution-fixture";
const modelId = "fixture-model";
const firstProfileId = `${provider}:first`;
const secondProfileId = `${provider}:second`;
const pendingProfileId = `${provider}:replacement`;
const firstKey = "fixture-first-active-key";
const secondKey = "fixture-second-active-key";
const pendingKey = "fixture-pending-key";

let state: OpenClawTestState;
let server: Server;
let config: OpenClawConfig;
let route: SystemAgentConfiguredRoute;
const requests: Array<{ authorization: string | undefined; path: string | undefined }> = [];
const rejectedKeys = new Set<string>();

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "pending-execution",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  requests.length = 0;
  rejectedKeys.clear();
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const authorization = request.headers.authorization;
      requests.push({ authorization, path: request.url });
      if (rejectedKeys.has(authorization ?? "")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: `The server refused ${authorization?.slice("Bearer ".length)}.`,
              type: "authentication_error",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "pending-execution-response",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [
            { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Pending execution fixture did not bind a loopback port");
  }
  config = {
    plugins: { enabled: false },
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: `${provider}/${modelId}` },
      },
      entries: { main: {} },
    },
    models: {
      mode: "replace",
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [
            {
              id: modelId,
              name: "Pending execution fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32_000,
              maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
  await state.writeConfig(config);
  for (const [profileId, key] of [
    [firstProfileId, firstKey],
    [secondProfileId, secondKey],
  ] as const) {
    await upsertAuthProfileWithLockOrThrow({
      agentDir: state.agentDir("main"),
      profileId,
      credential: { type: "api_key", provider, key },
    });
  }
  const active = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("main"));
  active.lastGood = { [provider]: firstProfileId };
  active.usageStats = {
    [firstProfileId]: { lastUsed: 1 },
    [secondProfileId]: { lastUsed: 2 },
  };
  saveAuthProfileStore(active, state.agentDir("main"), {
    sharedStoreWrite: true,
    syncExternalCli: false,
  });
  route = {
    runner: "embedded",
    agentHarnessRuntimeOverride: "openclaw",
    agentDir: state.agentDir("main"),
    agentId: "main",
    provider,
    model: modelId,
    modelLabel: `${provider}/${modelId}`,
    runConfig: config,
  };
});

afterEach(async () => {
  resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  resetSecretRedactionRegistryForTest();
  resetSecretRedactionRegistryForTest();
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  await state?.cleanup();
});

function runInference(authProfileId?: string) {
  return runSetupInferenceTurn({
    route: { ...route, ...(authProfileId ? { authProfileId } : {}) },
    deps: {},
    requireExecutionOwner: true,
  });
}

function savePendingSignIn() {
  saveAuthProfileCandidates({
    baseConfig: config,
    agentDir: state.agentDir("main"),
    profiles: [
      {
        profileId: pendingProfileId,
        credential: { type: "api_key", provider, key: pendingKey },
      },
    ],
    setup: {
      providerId: provider,
      pluginId: "fixture",
      authChoice: "fixture-key",
      modelRef: `${provider}/${modelId}`,
      connectionPatch: {},
    },
  });
  expect(loadPendingAuthProfileStore().profiles[pendingProfileId]).toEqual({
    type: "api_key",
    provider,
    key: pendingKey,
  });
}

describe("pending credential real execution", () => {
  it("baseline: ordinary stored credentials reach HTTP and retain automatic fallback", async () => {
    rejectedKeys.add(`Bearer ${firstKey}`);
    const result = await runInference();
    expect(result).toMatchObject({
      ok: true,
      auth: { authProfileId: secondProfileId },
    });
    expect(requests.map((request) => request.authorization)).toEqual([
      `Bearer ${firstKey}`,
      `Bearer ${secondKey}`,
    ]);
    expect(requests.every((request) => request.path === "/v1/chat/completions")).toBe(true);
  }, 90_000);

  it("isolates the selected pending key until promotion with its real successful binding", async () => {
    const agentDir = state.agentDir("main");
    const activeBefore = readPersistedAuthProfileStoreRaw();
    const stateBefore = readPersistedAuthProfileStateRaw();
    savePendingSignIn();
    const ordinaryStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    expect(ordinaryStore.profiles[pendingProfileId]).toBeUndefined();
    expect(resolveAuthProfileOrder({ cfg: config, store: ordinaryStore, provider })).toEqual([
      firstProfileId,
      secondProfileId,
    ]);

    resetSecretRedactionRegistryForTest();
    rejectedKeys.add(`Bearer ${pendingKey}`);
    const rejected = await withPendingAuthProfileProbe(
      { profileId: pendingProfileId, agentDir },
      () => runInference(pendingProfileId),
    );
    expect(rejected.ok).toBe(false);
    expect(requests.length).toBeGreaterThan(0);
    expect([...new Set(requests.map((request) => request.authorization))]).toEqual([
      `Bearer ${pendingKey}`,
    ]);
    expect(JSON.stringify(rejected)).not.toContain(pendingKey);

    requests.length = 0;
    rejectedKeys.delete(`Bearer ${pendingKey}`);
    const { proof, selected } = await withPendingAuthProfileProbe(
      { profileId: pendingProfileId, agentDir },
      async () => {
        const prepared = await preparePendingAuthProfileProbe({
          profileId: pendingProfileId,
          agentDir,
          config,
        });
        if (!prepared) {
          throw new Error("The saved pending sign-in did not prepare a verification proof.");
        }
        return { proof: prepared, selected: await runInference(pendingProfileId) };
      },
    );
    expect(selected).toMatchObject({ ok: true, auth: { authProfileId: pendingProfileId } });
    if (!selected.ok) {
      throw new Error("The selected pending credential did not complete its verification.");
    }
    expect(requests.map((request) => request.authorization)).toEqual([`Bearer ${pendingKey}`]);

    requests.length = 0;
    const ordinary = await runInference();
    expect(ordinary).toMatchObject({ ok: true, auth: { authProfileId: firstProfileId } });
    expect(requests.map((request) => request.authorization)).toEqual([`Bearer ${firstKey}`]);
    expect(readPersistedAuthProfileStoreRaw()).toEqual(activeBefore);
    expect(readPersistedAuthProfileStateRaw()).toEqual(stateBefore);
    expect(loadPendingAuthProfileStore().profiles[pendingProfileId]).toMatchObject({
      provider,
      type: "api_key",
      key: pendingKey,
    });
    await expect(
      promotePendingAuthProfile({ proof, verifiedAuth: selected.auth, config }),
    ).resolves.toBe(true);
    expect(loadPendingAuthProfileStore().profiles[pendingProfileId]).toBeUndefined();
    expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).toEqual({
      [firstProfileId]: { type: "api_key", provider, key: firstKey },
      [secondProfileId]: { type: "api_key", provider, key: secondKey },
      [pendingProfileId]: { type: "api_key", provider, key: pendingKey },
    });
  }, 180_000);

  it("refuses a saved default pinned to a pending sign-in during generic verification", async () => {
    savePendingSignIn();
    await state.writeConfig({
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          model: { primary: `${provider}/${modelId}@${pendingProfileId}` },
        },
      },
    });
    clearRuntimeAuthProfileStoreSnapshots();
    resetPreparedModelRuntimeSnapshotsForTest();
    const result = await verifySetupInference({
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    expect(requests).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(loadPendingAuthProfileStore().profiles[pendingProfileId]).toMatchObject({
      provider,
      type: "api_key",
      key: pendingKey,
    });
    expect(
      loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("main")).profiles[
        pendingProfileId
      ],
    ).toBeUndefined();
  }, 90_000);
});
