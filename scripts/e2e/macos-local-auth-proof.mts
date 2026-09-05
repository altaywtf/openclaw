import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runManagedCommand } from "../lib/managed-child-process.mts";

// This fixture needs the disposable native CI account, not an operator desktop.
assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_OS, "macOS");
assert.ok(process.env.RUNNER_TEMP);
const harnessRepository = process.cwd();
assert.equal(process.argv[2], "candidate");
const repository = fs.realpathSync(path.join(harnessRepository, process.argv[2]));
const evidence = path.join(harnessRepository, ".artifacts/macos-local-auth-proof");
fs.mkdirSync(evidence, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "local-auth-")));
const binary = path.join(repository, "dist/OpenClaw.app/Contents/MacOS/OpenClaw");
assert.ok(fs.existsSync(binary));
const runtimeRoot = path.join(
  repository,
  "dist/OpenClaw.app/Contents/Resources/node-worker/arm64/lib/node_modules/openclaw",
);
const runtimeNode = path.join(
  repository,
  "dist/OpenClaw.app/Contents/Resources/node-worker/arm64/bin/node",
);
const runtimeCLI = path.join(runtimeRoot, "openclaw.mjs");
assert.ok(fs.existsSync(runtimeNode));
assert.ok(fs.existsSync(runtimeCLI));
const baseline = "606d9ab82afdb28ebaad33896e41811b96ad87c7";
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const productDelta = execFileSync("git", ["diff", "--name-only", baseline, "HEAD"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
assert.deepEqual(productDelta.toSorted(), [
  ".github/workflows/macos-local-auth-proof.yml",
  "scripts/e2e/fixtures/macos-local-auth-proof/candidate.commit",
  "scripts/e2e/fixtures/macos-local-auth-proof/candidate.patch",
  "scripts/e2e/macos-local-auth-proof.mts",
]);
const candidate = "23b805fa3821e06e882d846843d96da2252a91bd";
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  candidate,
);
assert.equal(
  execFileSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim(),
  "",
);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(runtimeRoot, "dist/build-info.json"), "utf8")).commit,
  candidate,
);
process.chdir(runtimeRoot);

const results: Record<string, unknown>[] = [];
const syntheticValues: string[] = [];
const runnerNames = [
  process.env.HOME,
  process.env.RUNNER_TRACKING_ID,
  os.hostname(),
  os.userInfo().username,
];
for (const property of ["ComputerName", "LocalHostName"]) {
  runnerNames.push(execFileSync("scutil", ["--get", property], { encoding: "utf8" }).trim());
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function sanitized(value: string): string {
  let result = value
    .replaceAll(root, "<fixture>")
    .replaceAll(repository, "<candidate>")
    .replaceAll(harnessRepository, "<harness>");
  for (const [index, secret] of syntheticValues.entries())
    result = result.replaceAll(secret, `<synthetic-credential-${index + 1}>`);
  for (const privateValue of runnerNames) {
    if (privateValue) result = result.replaceAll(privateValue, "<runner>");
  }
  return result;
}

async function command(
  name: string,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<number> {
  const raw = path.join(root, `${name}.log`);
  const descriptor = fs.openSync(raw, "w", 0o600);
  try {
    return await runManagedCommand({
      bin,
      args,
      env,
      stdio: ["ignore", descriptor, descriptor],
      requireProcessTreeExit: true,
      timeoutMs: options.timeoutMs ?? 180_000,
      signal: options.signal,
    });
  } finally {
    fs.closeSync(descriptor);
    fs.writeFileSync(path.join(evidence, `${name}.log`), sanitized(fs.readFileSync(raw, "utf8")));
  }
}

type Surface = "token" | "password";
type Scenario = {
  name: string;
  surface: Surface;
  appValue?: "same" | "different";
  wrapperValue?: boolean;
  inactiveOpposite?: boolean;
  mixedImplicit?: boolean;
  remoteToken?: boolean;
  rejected?: "denied" | "unresolved";
};

async function observe(scenario: Scenario, port: number): Promise<void> {
  const { name, surface } = scenario;
  const profile = `auth-proof-${randomUUID().slice(0, 8)}`;
  // Native service ownership is anchored to the OS account, not a relocated HOME.
  // The disposable CI account and a fresh named profile provide the isolation.
  const home = os.userInfo().homedir;
  assert.equal(process.env.HOME, home);
  const state = path.join(home, `.openclaw-${profile}`);
  const configPath = path.join(state, "openclaw.json");
  const plist = path.join(home, "Library/LaunchAgents", `ai.openclaw.${profile}.plist`);
  assert.ok(!fs.existsSync(state), "Refusing to reuse an existing profile");
  assert.ok(!fs.existsSync(plist), "Refusing to reuse an existing service");
  const temporary = path.join(root, name, "tmp");
  const keychain = path.join(root, name, "proof.keychain-db");
  for (const directory of [
    state,
    temporary,
    path.dirname(keychain),
    path.join(home, "Library/Preferences"),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "DEVELOPER_DIR",
    "SDKROOT",
    "TOOLCHAINS",
    "LANG",
    "RUNNER_TRACKING_ID",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  assert.ok(env.PATH);
  Object.assign(env, {
    PATH: `${path.dirname(runtimeNode)}:${env.PATH}`,
    HOME: home,
    TMPDIR: `${temporary}/`,
    OPENCLAW_PROFILE: profile,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  const credential = `synthetic-${randomUUID()}`;
  const otherCredential = `synthetic-${randomUUID()}`;
  assert.notEqual(credential, otherCredential);
  syntheticValues.push(credential, otherCredential);
  const ref = { source: "env", provider: "proof", id: "GW_PROOF_CREDENTIAL" };
  const opposite = surface === "token" ? "password" : "token";
  const auth = scenario.remoteToken
    ? { password: ref }
    : scenario.mixedImplicit
      ? { [opposite]: ref }
      : {
          mode: surface,
          [surface]: ref,
          ...(scenario.inactiveOpposite ? { [opposite]: { ...ref, id: "GW_PROOF_INACTIVE" } } : {}),
        };
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth,
      ...(scenario.remoteToken ? { remote: { token: otherCredential } } : {}),
      // Keep the healthy server's credentials fixed while the app reads a rejected ref.
      // This is an existing operator reload policy, not an auth or pairing bypass.
      ...(scenario.rejected ? { reload: { mode: "off" } } : {}),
    },
    secrets: { providers: { proof: { source: "env", allowlist: ["GW_PROOF_CREDENTIAL"] } } },
    logging: {
      level: "debug",
      consoleLevel: "debug",
      consoleStyle: "json",
      file: path.join(state, "gateway.jsonl"),
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const ambientKey = `OPENCLAW_GATEWAY_${surface.toUpperCase()}`;
  const durableEnv: Record<string, string> = scenario.wrapperValue
    ? {}
    : { GW_PROOF_CREDENTIAL: scenario.mixedImplicit ? otherCredential : credential };
  if (scenario.mixedImplicit) durableEnv[ambientKey] = credential;
  // The ordinary installer carries durable env inputs into its LaunchAgent snapshot.
  fs.writeFileSync(
    path.join(state, ".env"),
    Object.entries(durableEnv)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  );
  const appEnv = { ...env };
  if (scenario.appValue) {
    appEnv.GW_PROOF_CREDENTIAL = scenario.appValue === "same" ? credential : otherCredential;
  }
  if (scenario.rejected) appEnv[ambientKey] = credential;
  if (scenario.remoteToken) {
    assert.equal(appEnv.OPENCLAW_GATEWAY_TOKEN, undefined);
    assert.equal(appEnv.OPENCLAW_GATEWAY_PASSWORD, undefined);
  }
  const wrapper = path.join(root, name, "gateway-wrapper");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\n${scenario.wrapperValue ? `export GW_PROOF_CREDENTIAL=${shellQuote(credential)}\n` : ""}exec ${shellQuote(runtimeNode)} ${shellQuote(runtimeCLI)} "$@" --verbose --ws-log full\n`,
    { mode: 0o700 },
  );
  const cli = (suffix: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    command(`${name}-${suffix}`, runtimeNode, [runtimeCLI, "--profile", profile, ...args], {
      ...env,
      ...extraEnv,
    });
  let keychainCreated = false;
  const failures: unknown[] = [];
  const result: Record<string, unknown> = {
    name,
    scenario,
    port,
    profile,
    productionRevision: candidate,
    freshProfile: true,
    configuredCredentialsDiffer: credential !== otherCredential,
    appStandardCredentialsAbsent:
      appEnv.OPENCLAW_GATEWAY_TOKEN === undefined && appEnv.OPENCLAW_GATEWAY_PASSWORD === undefined,
  };
  results.push(result);
  try {
    for (const args of [
      ["create-keychain", "-p", "", keychain],
      ["unlock-keychain", "-p", "", keychain],
      ["set-keychain-settings", keychain],
      ["list-keychains", "-d", "user", "-s", keychain],
      ["default-keychain", "-d", "user", "-s", keychain],
    ]) {
      assert.equal(
        await command(`${name}-${args[0]}`, "security", args, env, { timeoutMs: 30_000 }),
        0,
      );
      keychainCreated = true;
    }
    const suite = `ai.openclaw.mac.profile.${profile}`;
    for (const [key, type, value] of [
      ["openclaw.onboardingSeen", "-bool", "true"],
      ["openclaw.onboardingVersion", "-int", "8"],
      ["openclaw.computerControlEnabled", "-bool", "false"],
      ["openclaw.swabbleEnabled", "-bool", "false"],
      ["openclaw.gatewayProjectRootPath", "-string", runtimeRoot],
    ]) {
      assert.equal(
        await command(`${name}-${key}`, "defaults", ["write", suite, key, type, value], env),
        0,
      );
    }
    // Installation owns activation; no direct launchctl bootstrap or hand-written plist.
    assert.equal(
      await cli(
        "install",
        [
          "gateway",
          "install",
          "--port",
          String(port),
          "--runtime",
          "node",
          "--wrapper",
          wrapper,
          "--json",
        ],
        scenario.wrapperValue ? { GW_PROOF_CREDENTIAL: credential } : {},
      ),
      0,
    );
    const installedConfigText = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      path.join(evidence, `${name}-installed-config.json`),
      sanitized(installedConfigText),
    );
    const installedConfig = JSON.parse(installedConfigText);
    assert.deepEqual(installedConfig.gateway.auth, auth);
    if (scenario.remoteToken) assert.equal(installedConfig.gateway.remote?.token, otherCredential);
    result.installedAuthInputPreserved = true;
    const serviceEnvironment = path.join(state, "service-env", `ai.openclaw.${profile}.env`);
    const snapshot = fs.readFileSync(serviceEnvironment, "utf8");
    fs.writeFileSync(path.join(evidence, `${name}-service-environment.txt`), sanitized(snapshot));
    result.serviceStandardCredentialsAbsent =
      !snapshot.includes("OPENCLAW_GATEWAY_TOKEN=") &&
      !snapshot.includes("OPENCLAW_GATEWAY_PASSWORD=");
    if (scenario.remoteToken) assert.equal(result.serviceStandardCredentialsAbsent, true);
    result.serviceSnapshotHasCredential = snapshot.includes(credential);
    result.serviceSnapshotHasRefKey = snapshot.includes("GW_PROOF_CREDENTIAL=");
    result.appHasCredential = Object.values(appEnv).includes(credential);
    result.wrapperSuppliesCredential = Boolean(scenario.wrapperValue);
    assert.equal(result.serviceSnapshotHasCredential, !scenario.wrapperValue);
    assert.equal(result.serviceSnapshotHasRefKey, !scenario.wrapperValue);
    const readinessDeadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < readinessDeadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        ready = response.ok;
      } catch {
        /* A service still starting has no HTTP listener yet. */
      }
      if (ready) break;
      await delay(1_000);
    }
    result.serviceReady = ready;
    assert.ok(ready, "The actual installed Gateway did not become ready");
    const readyConfigText = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(path.join(evidence, `${name}-ready-config.json`), sanitized(readyConfigText));
    result.authInputUnchangedAtAppStart =
      JSON.stringify(JSON.parse(readyConfigText).gateway.auth) === JSON.stringify(auth);
    if (scenario.rejected) {
      const rejectedConfig = structuredClone(config);
      if (scenario.rejected === "denied") {
        rejectedConfig.secrets.providers.proof.allowlist = [];
      } else {
        rejectedConfig.gateway.auth[surface] = { ...ref, id: "GW_PROOF_MISSING" };
        rejectedConfig.secrets.providers.proof.allowlist.push("GW_PROOF_MISSING");
      }
      fs.writeFileSync(configPath, JSON.stringify(rejectedConfig), { mode: 0o600 });
      fs.writeFileSync(
        path.join(evidence, `${name}-rejected-config.json`),
        sanitized(JSON.stringify(rejectedConfig, null, 2)),
      );
      await delay(2_000);
    }
    const phases = scenario.rejected ? ["rejected", "corrected"] : ["connect"];
    for (const phase of phases) {
      if (phase === "corrected") {
        fs.writeFileSync(configPath, installedConfigText, { mode: 0o600 });
        await delay(2_000);
      }
      const phaseResult: Record<string, unknown> = { phase, startedAt: new Date().toISOString() };
      result[phase] = phaseResult;
      const controller = new AbortController();
      const app = command(`${name}-${phase}-app`, binary, ["--attach-only", "--chat"], appEnv, {
        signal: controller.signal,
        timeoutMs: 90_000,
      }).then(
        (exit) => ({ exit }),
        (error: unknown) => ({ error }),
      );
      try {
        // Complete protocol logs supply the verdict; elapsed time alone cannot pass a case.
        await delay(45_000);
        phaseResult.serviceHealthy = (
          await fetch(`http://127.0.0.1:${port}/healthz`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok;
        assert.equal(phaseResult.serviceHealthy, true);
      } finally {
        controller.abort();
        const outcome = await app;
        if ("error" in outcome) {
          const error = outcome.error;
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ABORT_ERR") {
            throw error;
          }
          phaseResult.appExit = "stopped-after-observation";
        } else {
          phaseResult.appExit = outcome.exit;
        }
        phaseResult.finishedAt = new Date().toISOString();
      }
    }
    // Run explicit controls only after the fresh native phase. CLI shared auth
    // omits device identity, so a cached device token cannot satisfy these probes.
    if (scenario.remoteToken) {
      result.remoteTokenProtectedRequestExit = await cli("remote-token-control", [
        "gateway",
        "call",
        "config.get",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        otherCredential,
        "--json",
      ]);
      result.localPasswordProtectedRequestExit = await cli("local-password-control", [
        "gateway",
        "call",
        "config.get",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--password",
        credential,
        "--json",
      ]);
    }
    result.serviceStatusExit = await cli("status", ["gateway", "status", "--json", "--no-probe"]);
  } catch (error) {
    result.failure = sanitized(String(error));
    failures.push(error);
  } finally {
    const cleanup = await Promise.allSettled([
      fs.existsSync(plist)
        ? cli("uninstall", ["gateway", "uninstall", "--json"])
        : Promise.resolve(0),
      keychainCreated
        ? command(`${name}-keychain-cleanup`, "security", ["delete-keychain", keychain], env)
        : Promise.resolve(0),
    ]);
    result.cleanup = cleanup.map((entry) =>
      entry.status === "fulfilled"
        ? { exit: entry.value }
        : { error: sanitized(String(entry.reason)) },
    );
    const cleanupSucceeded = cleanup.every(
      (entry) => entry.status === "fulfilled" && entry.value === 0,
    );
    for (const [file, label] of [
      [path.join(state, "gateway.jsonl"), "gateway"],
      [path.join(home, "Library/Logs/openclaw", `gateway-${profile}.log`), "supervisor"],
    ]) {
      if (fs.existsSync(file)) {
        fs.writeFileSync(
          path.join(evidence, `${name}-${label}.log`),
          sanitized(fs.readFileSync(file, "utf8")),
        );
      }
    }
    result.cleanupSucceeded = cleanupSucceeded;
    if (!cleanupSucceeded) failures.push(new Error("An owned native fixture did not clean up"));
  }
  if (failures.length) throw new AggregateError(failures, `${name} native fixture failed`);
}

try {
  const scenarios: Scenario[] = [
    { name: "typed-service-token", surface: "token" },
    { name: "typed-service-password", surface: "password" },
    { name: "service-wins-token", surface: "token", appValue: "different" },
    { name: "service-wins-password", surface: "password", appValue: "different" },
    { name: "app-fallback-token", surface: "token", appValue: "same", wrapperValue: true },
    { name: "app-fallback-password", surface: "password", appValue: "same", wrapperValue: true },
    { name: "inactive-password", surface: "token", inactiveOpposite: true },
    { name: "inactive-token", surface: "password", inactiveOpposite: true },
    { name: "implicit-password", surface: "password", mixedImplicit: true },
    { name: "implicit-token", surface: "token", mixedImplicit: true },
    { name: "denied-token", surface: "token", rejected: "denied" },
    { name: "denied-password", surface: "password", rejected: "denied" },
    { name: "unresolved-token", surface: "token", rejected: "unresolved" },
    { name: "unresolved-password", surface: "password", rejected: "unresolved" },
    { name: "implicit-password-remote-token", surface: "password", remoteToken: true },
  ];
  const selected = scenarios.filter((scenario) => scenario.name === process.argv[3]);
  assert.equal(selected.length, 1, "Select exactly one named native scenario");
  for (const [index, scenario] of selected.entries()) {
    await observe(scenario, 19891 + index);
  }
} finally {
  fs.writeFileSync(
    path.join(evidence, "observations.json"),
    JSON.stringify(
      {
        revision,
        baseline,
        candidate,
        scope: "Actual app and installed local Gateway; observations require independent judgment.",
        results,
      },
      null,
      2,
    ),
  );
}
