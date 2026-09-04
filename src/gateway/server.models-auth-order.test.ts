import { expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../config/io.js";
import * as secretsRuntime from "../secrets/runtime.js";
import { rpcReq } from "./test-helpers.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { openClient } = setupGatewaySessionsTestHarness();

test("models.authOrderSet requires admin scope before updating the shared order", async () => {
  const cfg = getRuntimeConfig();
  const agentDir = resolveAgentDir(cfg, "main");
  const previousStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
  const provider = "fixture";
  const initialOrder = ["fixture:first", "fixture:second"];
  const updatedOrder = initialOrder.toReversed();
  saveAuthProfileStore(
    {
      ...previousStore,
      profiles: {
        ...previousStore.profiles,
        "fixture:first": { type: "api_key", provider, key: "fixture-first" },
        "fixture:second": { type: "api_key", provider, key: "fixture-second" },
      },
      order: { ...previousStore.order, [provider]: initialOrder },
    },
    agentDir,
    { sharedStoreWrite: true },
  );
  await refreshPreparedModelRuntimeSnapshots(cfg, { gatewayLifecycle: true });

  const clients: WebSocket[] = [];
  try {
    for (const scope of ["operator.read", "operator.write"]) {
      const { ws } = await openClient({ scopes: [scope] });
      clients.push(ws);
      const denied = await rpcReq(ws, "models.authOrderSet", {
        provider,
        profileIds: updatedOrder,
      });
      expect(denied.error).toMatchObject({
        code: "FORBIDDEN",
        message: "missing scope: operator.admin",
      });
      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).order?.[provider]).toEqual(
        initialOrder,
      );
    }

    const { ws } = await openClient({ scopes: ["operator.admin", "operator.read"] });
    clients.push(ws);
    const before = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
    const allowed = await rpcReq(ws, "models.authOrderSet", {
      provider,
      profileIds: updatedOrder,
    });
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).order?.[provider]).toEqual(
      updatedOrder,
    );
    const after = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
    expect(before).toBeDefined();
    expect(after?.pluginGeneration).toBe(before?.pluginGeneration);
    const status = await rpcReq<{
      providers: Array<{ provider: string; profileOrder?: string[] }>;
    }>(ws, "models.authStatus", {});
    expect(status.ok, JSON.stringify(status)).toBe(true);
    expect(status.payload?.providers).toContainEqual(
      expect.objectContaining({ provider, profileOrder: updatedOrder }),
    );
    const refresh = vi
      .spyOn(secretsRuntime, "refreshActiveProviderAuthRuntimeSnapshot")
      .mockRejectedValueOnce(new Error("auth publication unavailable"));
    try {
      const failed = await rpcReq(ws, "models.authOrderSet", {
        provider,
        profileIds: initialOrder,
      });
      expect(failed.ok).toBe(false);
      expect(failed.error).toMatchObject({
        code: "UNAVAILABLE",
        message:
          "Auth order was saved, but its model catalog could not refresh: Error: auth publication unavailable. Refresh models to retry.",
      });
      expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).order?.[provider]).toEqual(
        initialOrder,
      );
    } finally {
      refresh.mockRestore();
    }
  } finally {
    for (const client of clients) {
      client.close();
    }
    saveAuthProfileStore(previousStore, agentDir, { sharedStoreWrite: true });
    await refreshPreparedModelRuntimeSnapshots(cfg, { gatewayLifecycle: true });
  }
});
