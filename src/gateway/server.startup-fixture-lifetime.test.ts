import path from "node:path";
import { expect, test } from "vitest";
import {
  gatewayStartupFixtureSource,
  runGatewayFixtureFork,
} from "./server.fixture-lifetime.test-support.js";

// Each retained failure needs its own fork: a later case must not reset the failed owner.
for (const scenario of [
  { id: "public clean cleanup", missingTls: false, failCleanup: false, requiredJoin: false },
  {
    id: "public required cleanup failure",
    missingTls: false,
    failCleanup: true,
    requiredJoin: true,
  },
  {
    id: "kernel required cleanup failure",
    missingTls: true,
    failCleanup: true,
    requiredJoin: true,
  },
]) {
  test(`startup fixture ownership: ${scenario.id}`, (context) =>
    runGatewayFixtureFork(
      context,
      (repoRoot, root) => gatewayStartupFixtureSource(repoRoot, root, scenario),
      (journal, text) => {
        const retained = scenario.failCleanup;
        const refusal = {
          rejected: retained,
          startupPreserved: retained,
          cleanupPreserved: retained,
        };
        const state = { home: retained, state: retained, selectorsIntact: retained };
        expect(journal, text).toMatchObject({
          combinedFailure: retained,
          nativeStartupMatches: true,
          startupCausePreserved: retained,
          cleanupIdentityPreserved: retained,
          cleanupFaultPreserved: retained,
          nativeCloseCalls: 1,
          nativeCloseStatus: retained ? "rejected" : "fulfilled",
          kernelReturned: !scenario.missingTls,
          listenCalls: scenario.missingTls ? 0 : 1,
          probeListening: retained,
          blockerListening: true,
          stopCalls: 1,
          lowerStops: 0,
          metadataRetains: 1,
          metadataReleases: retained ? 0 : 1,
          nativeOwnerRetained: retained,
          fixtureRelease: refusal,
          afterEach: refusal,
          cleanup: refusal,
          successorSetup: refusal,
          successorStarted: !retained,
          homeRestored: !retained,
          beforeCleanup: { home: true, state: true, selectorsIntact: true },
          afterCleanup: state,
          afterSuccessor: state,
          finally: {
            originalsJoined: true,
            nativeCloseCalls: 1,
            listenerResults: ["fulfilled", "fulfilled"],
            probeListening: false,
            blockerListening: false,
          },
        });
        if (!scenario.missingTls) {
          expect(journal, text).toMatchObject({ startupCode: "EADDRINUSE" });
        }
      },
    ));
}

function gatewayModuleImportFixtureSource(
  repoRoot: string,
  root: string,
  rejectingImport: boolean,
): string {
  const source = (file: string) => JSON.stringify(path.join(repoRoot, file));
  return `
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { vi } from "vitest";
const hooks = vi.hoisted(() => ({ setup: [], cleanup: [] }));
vi.mock("vitest", async (original) => ({
  ...(await original()),
  beforeEach: fn => hooks.setup.push(fn),
  afterEach: fn => hooks.cleanup.push(fn),
}));
const { test } = await vi.importActual("vitest");
const { createDeferredCore } = await import(${source("src/shared/deferred.ts")});
fs.writeFileSync(${JSON.stringify(path.join(root, "worker.pid"))}, String(process.pid));
const serverModuleId = ${source("src/gateway/server.ts")};
const rejectingImport = ${JSON.stringify(rejectingImport)};
let nativeStarts = 0;
let startSelectorsIntact;
let selectorSnapshot;
const listeners = new Set();
const moduleValue = () => ({
  resetPreparedModelCatalogForTest: async () => {},
  startGatewayServer: async () => {
    nativeStarts++;
    startSelectorsIntact = [...selectorSnapshot].every(([key, value]) => process.env[key] === value);
    const listener = net.createServer();
    listeners.add(listener);
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    return {
      startupSettled: Promise.resolve(),
      getTailscaleIngressEndpoint: () => undefined,
      close: () => new Promise((resolve, reject) => {
        listener.close(error => error ? reject(error) : resolve());
      }),
    };
  },
});
vi.doMock(serverModuleId, moduleValue);
const helpers = await import(${source("src/gateway/test-helpers.server.ts")});
const takeHooks = () => ({ setup: hooks.setup.splice(0), cleanup: hooks.cleanup.splice(0) });
const runHooks = async callbacks => { for (const callback of callbacks) await callback(); };
const containsError = (error, expected) => error === expected ||
  (error instanceof Error && containsError(error.cause, expected));
const observe = async run => {
  try { await run(); return { rejected: false }; }
  catch (error) { return { rejected: true, message: String(error) }; }
};

test("retains state while a fresh Gateway helper imports its server module", async () => {
  helpers.installGatewayTestHooks();
  const fixture = takeHooks();
  await runHooks(fixture.setup);
  const home = process.env.HOME;
  const marker = path.join(home, "import-owner.txt");
  fs.writeFileSync(marker, "owned");
  selectorSnapshot = new Map(["HOME", "USERPROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"].map(key => [key, process.env[key]]));
  const readState = () => ({
    homePresent: fs.existsSync(marker),
    selectorsIntact: [...selectorSnapshot].every(([key, value]) => process.env[key] === value),
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const importError = new Error("synthetic server module import failure");
  let acquisition;
  let server;
  let journal;
  try {
    // Module reset is supported while the process-level fixture owner stays authoritative.
    vi.resetModules();
    vi.doMock(serverModuleId, async () => {
      entered.resolve();
      await release.promise;
      if (rejectingImport) throw importError;
      return moduleValue();
    });
    const fresh = await import(${source("src/gateway/test-helpers.server.ts")});
    const { gatewayFixtureLifetime } = await import(${source("src/gateway/gateway-fixture-lifetime.test-support.ts")});
    acquisition = fresh.startTestGatewayServer(0, { bind: "loopback", auth: { mode: "none" } });
    await Promise.race([entered.promise, acquisition]);
    const activeDuringImport = gatewayFixtureLifetime.hasActiveServers();
    const releaseDuringImport = await observe(() => gatewayFixtureLifetime.assertReleased());
    // Execute the real hook at the same boundary where a runner timeout unwinds the case.
    const cleanupDuringImport = await observe(() => runHooks(fixture.cleanup));
    const duringImport = readState();
    release.resolve();
    const [result] = await Promise.allSettled([acquisition]);
    if (result.status === "fulfilled") server = result.value;
    journal = {
      activeDuringImport, releaseDuringImport, cleanupDuringImport, duringImport,
      importRejected: result.status === "rejected",
      importCausePreserved: result.status === "rejected" && containsError(result.reason, importError),
      nativeStarts, startSelectorsIntact,
    };
    await server?.close();
    journal.releaseAfterSettlement = await observe(() => gatewayFixtureLifetime.assertReleased());
    await runHooks(fixture.cleanup);
    journal.homeRemovedAfterSettlement = !fs.existsSync(marker);
  } finally {
    release.resolve();
    if (acquisition) {
      const [result] = await Promise.allSettled([acquisition]);
      if (result.status === "fulfilled" && !server) await result.value.close();
    }
    for (const listener of listeners) {
      if (listener.listening) await new Promise(resolve => listener.close(resolve));
    }
    await observe(() => runHooks(fixture.cleanup));
    if (journal) {
      journal.allListenersClosed = [...listeners].every(listener => !listener.listening);
      fs.writeFileSync(${JSON.stringify(path.join(root, "journal.json"))}, JSON.stringify(journal));
    }
  }
});
`;
}

for (const rejectingImport of [false, true]) {
  test(`startup fixture owns a pending module import (rejects: ${rejectingImport})`, (context) =>
    runGatewayFixtureFork(
      context,
      (repoRoot, root) => gatewayModuleImportFixtureSource(repoRoot, root, rejectingImport),
      (journal, text) => {
        expect(journal, text).toMatchObject({
          activeDuringImport: true,
          releaseDuringImport: { rejected: true },
          cleanupDuringImport: { rejected: true },
          duringImport: { homePresent: true, selectorsIntact: true },
          importRejected: rejectingImport,
          importCausePreserved: rejectingImport,
          nativeStarts: rejectingImport ? 0 : 1,
          ...(rejectingImport ? {} : { startSelectorsIntact: true }),
          releaseAfterSettlement: { rejected: false },
          homeRemovedAfterSettlement: true,
          allListenersClosed: true,
        });
      },
    ));
}
