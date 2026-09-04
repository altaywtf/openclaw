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
const repository = process.cwd();
const evidence = path.join(repository, ".artifacts/macos-local-auth-proof");
fs.mkdirSync(evidence, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "local-auth-")));
const binary = path.join(repository, "dist/OpenClaw.app/Contents/MacOS/OpenClaw");
assert.ok(fs.existsSync(binary));
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
  "scripts/e2e/macos-local-auth-proof.mts",
]);

const results: Record<string, unknown>[] = [];
const syntheticValues: string[] = [];
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function sanitized(value: string): string {
  let result = value.replaceAll(root, "<fixture>").replaceAll(repository, "<checkout>");
  for (const secret of syntheticValues)
    result = result.replaceAll(secret, "<synthetic-credential>");
  for (const privateValue of [process.env.HOME, os.hostname()]) {
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

async function observe(name: string, typed: boolean, port: number): Promise<void> {
  const profile = `auth-proof-${randomUUID().slice(0, 8)}`;
  const home = path.join(root, name, "home");
  const state = path.join(home, `.openclaw-${profile}`);
  const temporary = path.join(root, name, "tmp");
  const keychain = path.join(home, "Library/Keychains/proof.keychain-db");
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
  Object.assign(env, {
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: `${temporary}/`,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
  const credential = `synthetic-${randomUUID()}`;
  syntheticValues.push(credential);
  const ref = { source: "env", provider: "proof", id: "GW_PROOF_CREDENTIAL" };
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token: typed ? ref : credential },
      },
      secrets: { providers: { proof: { source: "env", allowlist: ["GW_PROOF_CREDENTIAL"] } } },
      logging: {
        level: "debug",
        consoleLevel: "debug",
        consoleStyle: "json",
        file: path.join(state, "gateway.jsonl"),
      },
    }),
    { mode: 0o600 },
  );
  // The ordinary installer carries durable env inputs into its LaunchAgent snapshot.
  fs.writeFileSync(path.join(state, ".env"), `GW_PROOF_CREDENTIAL=${credential}\n`, {
    mode: 0o600,
  });
  const wrapper = path.join(root, name, "gateway-wrapper");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(repository, "openclaw.mjs"))} "$@" --verbose --ws-log full\n`,
    { mode: 0o700 },
  );
  const cli = (suffix: string, args: string[]) =>
    command(
      `${name}-${suffix}`,
      process.execPath,
      [path.join(repository, "openclaw.mjs"), ...args],
      env,
    );
  let installed = false;
  let keychainCreated = false;
  const result: Record<string, unknown> = {
    name,
    typed,
    port,
    profile,
    productionRevision: baseline,
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
      ["openclaw.gatewayProjectRootPath", "-string", repository],
    ]) {
      assert.equal(
        await command(`${name}-${key}`, "defaults", ["write", suite, key, type, value], env),
        0,
      );
    }
    // Installation owns activation; no direct launchctl bootstrap or hand-written plist.
    installed = true;
    assert.equal(
      await cli("install", [
        "gateway",
        "install",
        "--port",
        String(port),
        "--runtime",
        "node",
        "--wrapper",
        wrapper,
        "--json",
      ]),
      0,
    );
    const serviceEnvironment = path.join(state, "service-env", `ai.openclaw.${profile}.env`);
    result.serviceHasCredential = fs.readFileSync(serviceEnvironment, "utf8").includes(credential);
    result.appHasCredential = Object.values(env).includes(credential);
    if (typed) assert.equal(result.serviceHasCredential, true);
    assert.equal(result.appHasCredential, false);
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
    const controller = new AbortController();
    const app = command(`${name}-app`, binary, ["--attach-only", "--chat"], env, {
      signal: controller.signal,
      timeoutMs: 90_000,
    }).then(
      (exit) => ({ exit }),
      (error: unknown) => ({ error }),
    );
    try {
      // Observe the same startup interval in both cases. Logs, not the timer, decide the verdict.
      await delay(45_000);
      result.screenshotExit = await command(
        `${name}-screenshot`,
        "screencapture",
        ["-x", path.join(evidence, `${name}.png`)],
        env,
        { timeoutMs: 10_000 },
      );
    } finally {
      controller.abort();
      const outcome = await app;
      if ("error" in outcome) {
        const error = outcome.error;
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ABORT_ERR") {
          throw error;
        }
        result.appExit = "stopped-after-observation";
      } else {
        result.appExit = outcome.exit;
      }
    }
    result.serviceStatusExit = await cli("status", ["gateway", "status", "--json", "--no-probe"]);
  } finally {
    const cleanup = await Promise.allSettled([
      installed ? cli("uninstall", ["gateway", "uninstall", "--json"]) : Promise.resolve(0),
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
    assert.ok(cleanupSucceeded, "An owned native fixture did not clean up");
  }
}

try {
  await observe("literal-control", false, 19891);
  await observe("typed-service-env", true, 19892);
} finally {
  fs.writeFileSync(
    path.join(evidence, "observations.json"),
    JSON.stringify(
      {
        revision,
        baseline,
        scope: "Actual app and installed local Gateway; observations require independent judgment.",
        results,
      },
      null,
      2,
    ),
  );
}
