import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloseTab, RegistryModule } from "./session-tab-registry.sqlite.test-helpers.js";

const processStateSymbols = [
  "openclaw.browser.session-tabs.volatile",
  "openclaw.browser.session-tabs.volatile-cleanup",
  "openclaw.browser.session-tabs.volatile-aliases",
  "openclaw.browser.session-tabs.exact-volatile-aliases",
];

function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of processStateSymbols) {
    delete state[Symbol.for(name)];
  }
}

describe("volatile session tab cleanup across Browser plugin bundles", () => {
  let freshModuleCounter = 0;

  async function freshRegistry(label: string): Promise<RegistryModule> {
    freshModuleCounter += 1;
    return await importFreshModule<RegistryModule>(
      import.meta.url,
      `./session-tab-registry.js?concurrent=${label}-${freshModuleCounter}`,
    );
  }

  beforeEach(clearProcessLocalTabState);
  afterEach(clearProcessLocalTabState);

  it.each(
    (["custom", "node"] as const).flatMap((dispatch) =>
      (["removed", "replaced", "reregistered", "ownership", "rerouted", "touched"] as const).map(
        (change) => ({ dispatch, change }),
      ),
    ),
  )(
    "checks queued $dispatch registration ownership after it is $change",
    async ({ dispatch, change }) => {
      const registry = await freshRegistry("queued-retirement");
      const closed = vi.fn();
      const closeTarget = async () => {
        closed();
        return { status: "closed" as const };
      };
      const closeTab =
        dispatch === "custom"
          ? async () => {
              closed();
            }
          : undefined;
      const tab = {
        sessionKey: "agent:main:main",
        targetId: "bridge-tab",
        route:
          dispatch === "node"
            ? { kind: "node-proxy" as const, nodeId: "node-1", closeTarget }
            : { kind: "browser-control" as const, baseUrl: "http://127.0.0.1:9999" },
        ownership: {
          status: "durable" as const,
          nativeTargetId: "native",
          profileFingerprint: "profile",
          browserInstanceFingerprint: "browser",
        },
        now: 1_000,
      };
      registry.trackSessionBrowserTab(tab);
      const closing = registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [tab.sessionKey],
        closeTab,
      });
      if (change === "removed" || change === "replaced" || change === "rerouted") {
        registry.untrackSessionBrowserTab(tab);
      }
      if (change === "replaced" || change === "reregistered") {
        registry.trackSessionBrowserTab(tab);
      } else if (change === "ownership") {
        registry.trackSessionBrowserTab({
          ...tab,
          ownership: { status: "non-durable", reason: "browser-identity-unavailable" },
        });
      } else if (change === "rerouted") {
        registry.trackSessionBrowserTab({
          ...tab,
          route:
            dispatch === "node"
              ? { kind: "node-proxy", nodeId: "node-2", closeTarget }
              : { kind: "browser-control", baseUrl: "http://127.0.0.1:9998" },
        });
      } else if (change === "touched") {
        registry.touchSessionBrowserTab({ ...tab, now: 2_000 });
      }
      await expect(closing).resolves.toBe(change === "touched" ? 1 : 0);
      expect(closed).toHaveBeenCalledTimes(change === "touched" ? 1 : 0);
      await expect(
        registry.closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], closeTab }),
      ).resolves.toBe(change === "removed" || change === "touched" ? 0 : 1);
    },
  );

  it.each(["agent:main:first", "agent:main:second"])(
    "preserves %s registration replaced while a shared target close settles",
    async (replacedSessionKey) => {
      const registry = await freshRegistry("settling-retirement");
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const tab = {
        targetId: "shared-tab",
        route: { kind: "browser-control" as const, baseUrl: "http://127.0.0.1:9999" },
        now: 1_000,
      };
      for (const sessionKey of ["agent:main:first", "agent:main:second"]) {
        registry.trackSessionBrowserTab({ ...tab, sessionKey });
      }
      const closing = registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:first"],
        closeTab: async () => {
          started.resolve();
          await release.promise;
        },
      });
      await started.promise;
      registry.untrackSessionBrowserTab({ ...tab, sessionKey: replacedSessionKey });
      registry.trackSessionBrowserTab({ ...tab, sessionKey: replacedSessionKey });
      release.resolve();
      await expect(closing).resolves.toBe(1);
      const closeTab = vi.fn<CloseTab>(async () => {});
      await expect(
        registry.closeTrackedBrowserTabsForSessions({
          sessionKeys: ["agent:main:first", "agent:main:second"],
          closeTab,
        }),
      ).resolves.toBe(1);
      expect(closeTab).toHaveBeenCalledOnce();
    },
  );

  it("preserves a replacement registered while the close client loads", async () => {
    const loading = createDeferred<void>();
    const release = createDeferred<void>();
    const browserCloseTabByRawTargetId = vi.fn(async () => {});
    vi.doMock("./client.js", async () => {
      loading.resolve();
      await release.promise;
      return { browserCloseTabByRawTargetId };
    });
    try {
      const registry = await freshRegistry("loading-retirement");
      const tab = {
        sessionKey: "agent:main:main",
        targetId: "bridge-tab",
        route: { kind: "browser-control" as const, baseUrl: "http://127.0.0.1:9999" },
        now: 1_000,
      };
      registry.trackSessionBrowserTab(tab);
      const closing = registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [tab.sessionKey],
      });
      await loading.promise;
      registry.untrackSessionBrowserTab(tab);
      registry.trackSessionBrowserTab(tab);
      release.resolve();
      await expect(closing).resolves.toBe(0);
      expect(browserCloseTabByRawTargetId).not.toHaveBeenCalled();
      await expect(
        registry.closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey] }),
      ).resolves.toBe(1);
      expect(browserCloseTabByRawTargetId).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      vi.doUnmock("./client.js");
    }
  });

  it("shares one close attempt and releases a failed reservation for retry", async () => {
    const first = await freshRegistry("first");
    const duplicate = await freshRegistry("duplicate");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "bridge-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
    });

    let failClose!: () => void;
    const failedClose = new Promise<void>((_resolve, reject) => {
      failClose = () => reject(new Error("network down"));
    });
    const closeTab = vi.fn<CloseTab>(async () => await failedClose);
    const onWarn = vi.fn();
    const firstAttempts = [first, duplicate].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
        onWarn,
      }),
    );
    failClose();
    await expect(Promise.all(firstAttempts)).resolves.toEqual([0, 0]);
    expect(closeTab).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledOnce();

    let finishRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    const retry = vi.fn<CloseTab>(async () => await retryGate);
    const retries = [duplicate, first].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: retry,
      }),
    );
    finishRetry();
    const retryResults = await Promise.all(retries);

    expect(retry).toHaveBeenCalledOnce();
    expect(retryResults.reduce((total, closed) => total + closed, 0)).toBe(1);
  });
});
