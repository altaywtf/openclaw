import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveNpmRunner } from "../npm-runner.mts";
import { createPnpmRunnerSpawnSpec } from "../pnpm-runner.mts";

// These helpers install/build test inputs. Product proof runs only built CLI entrypoints.
assert.equal(process.platform, "win32");
const candidateSha = "e081101d616dd7d13b7dac37e167a268c161067d";
const baselineSha = "a33604ea1ecab8212865cd225e17511cc0b69cb3";
const harnessRoot = process.cwd();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "metadata-candidate-"));
const candidate = path.join(root, "candidate");
const baseline = path.join(root, "baseline");
const legacy = path.join(root, "legacy");
const tests = [
  "src/shared/gateway-client-platform.test.ts",
  "src/node-host/gateway-platform-identity.test.ts",
  "src/node-host/runner.test.ts",
  "src/gateway/client.test.ts",
  "src/gateway/startup-local-cli-pairing.test.ts",
  "src/gateway/server/ws-connection/connect-device-metadata.test.ts",
  "src/tui/gateway-chat.test.ts",
  "src/tui/gateway-chat.connection.test.ts",
  "src/tui/gateway-chat.reconnect-errors.test.ts",
  "src/tui/gateway-chat.scopes.test.ts",
];

async function run(
  command: string,
  args: string[],
  cwd: string,
  options: SpawnOptions = {},
): Promise<number> {
  const child = spawn(command, args, { ...options, cwd, stdio: "inherit" });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function pnpm(args: string[], cwd: string) {
  const invocation = createPnpmRunnerSpawnSpec({ pnpmArgs: args, cwd });
  return await run(invocation.command, invocation.args, cwd, invocation.options);
}

async function checkout(sha: string, destination: string) {
  assert.equal(await run("git", ["fetch", "--depth=1", "origin", sha], harnessRoot), 0);
  assert.equal(await run("git", ["worktree", "add", "--detach", destination, sha], harnessRoot), 0);
  assert.equal(await run("git", ["diff", "--exit-code", sha], destination), 0);
  assert.equal(
    await pnpm(
      [
        "install",
        "--frozen-lockfile",
        "--prefer-offline",
        "--config.ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
      ],
      destination,
    ),
    0,
  );
}

console.log(`[metadata-proof] prepare baseline ${baselineSha}`);
await checkout(baselineSha, baseline);
const regression = "src/gateway/server/ws-connection/connect-device-metadata.test.ts";
await fs.copyFile(path.join(harnessRoot, regression), path.join(baseline, regression));
const redCode = await run(
  process.execPath,
  ["scripts/run-vitest.mjs", regression, "-t", "resolvePinnedClientMetadata"],
  baseline,
);
console.log(
  `[metadata-proof] pre-fix regression exit=${redCode}; inspect failures for intended alias assertions`,
);
assert.notEqual(redCode, 0, "The new alias regression must fail on baseline production");

console.log(`[metadata-proof] prepare exact candidate ${candidateSha}`);
await checkout(candidateSha, candidate);
assert.equal(await pnpm(["build:docker"], candidate), 0);
assert.equal(await run(process.execPath, ["scripts/run-vitest.mjs", ...tests], candidate), 0);
assert.equal(await run("git", ["diff", "--exit-code", candidateSha], candidate), 0);

await fs.mkdir(legacy);
await fs.writeFile(path.join(legacy, "package.json"), JSON.stringify({ private: true }));
const npm = resolveNpmRunner({
  npmArgs: ["install", "--no-audit", "--no-fund", "openclaw@2026.8.1-beta.2"],
});
assert.equal(await run(npm.command, npm.args, legacy, npm), 0);

console.log(`[metadata-proof] product under test ${candidateSha}; baseline ${baselineSha}`);
assert.equal(
  await run(
    process.execPath,
    [
      path.join(harnessRoot, "scripts/e2e/gateway-device-metadata-proof.mjs"),
      path.join(candidate, "openclaw.mjs"),
      path.join(legacy, "node_modules/openclaw/openclaw.mjs"),
    ],
    harnessRoot,
  ),
  0,
);
assert.equal(await run("git", ["diff", "--exit-code", candidateSha], candidate), 0);
