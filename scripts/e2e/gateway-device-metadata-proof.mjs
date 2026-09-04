import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { spawn as spawnPty } from "@lydell/node-pty";

// Product proof uses only the built CLI and native terminal. No runtime imports.
assert.equal(process.platform, "win32", "This proof must execute on native Windows");
const entry = path.resolve("openclaw.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-metadata-proof-"));
const token = randomBytes(32).toString("hex");
const report = { platform: process.platform, stages: [], outcome: "incomplete" };
const children = new Set();
let tui;
let phase = "setup";

const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const url = `ws://127.0.0.1:${port}`;
const baseEnv = {};
for (const [key, value] of Object.entries(process.env)) {
  if (
    /^(path|systemroot|windir|comspec|pathext|processor_architecture|programfiles|programfiles\(x86\)|programw6432|allusersprofile)$/i.test(
      key,
    )
  ) {
    baseEnv[key] = value;
  }
}

async function makeState(name) {
  const home = path.join(root, name);
  const state = path.join(home, "state");
  await fs.mkdir(state, { recursive: true });
  const config = path.join(state, "openclaw.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
        controlUi: { enabled: false },
        nodes: { pairing: { autoApproveLocal: false, sshVerify: false } },
      },
      plugins: { allow: [] },
    }),
  );
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "appdata"),
    LOCALAPPDATA: path.join(home, "localappdata"),
    TEMP: root,
    TMP: root,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_NO_RESPAWN: "1",
    NO_COLOR: "1",
    TERM: "xterm-256color",
  };
}

function start(env, args) {
  const child = spawn(process.execPath, [entry, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = { child, text: "", stdout: "" };
  children.add(child);
  child.stdout.on("data", (chunk) => {
    capture.stdout += chunk;
    capture.text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    capture.text += chunk;
  });
  child.once("close", () => children.delete(child));
  return capture;
}

async function stop(child) {
  if (!children.has(child)) return;
  await new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      env: baseEnv,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("close", resolve);
  });
}

async function command(env, args) {
  const capture = start(env, args);
  const timer = setTimeout(() => void stop(capture.child), 60_000);
  const code = await new Promise((resolve, reject) => {
    capture.child.once("error", reject);
    capture.child.once("close", resolve);
  });
  clearTimeout(timer);
  return { ...capture, code };
}

async function until(read, predicate, label) {
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}

function json(result) {
  assert.equal(result.code, 0, `CLI failed at ${phase}: ${sanitize(result.text)}`);
  return JSON.parse(result.stdout);
}

function sanitize(text) {
  return stripVTControlCharacters(text)
    .replaceAll(token, "<synthetic-token>")
    .replaceAll(root, "<isolated-state>");
}

const admin = await makeState("approver");
const device = await makeState("device");
const list = (env, explicit = true) =>
  command(env, [
    "devices",
    "list",
    "--json",
    ...(explicit ? ["--url", url, "--token", token] : []),
  ]);
const adminList = async () => json(await list(admin, false));
const approve = async (requestId) =>
  json(await command(admin, ["devices", "approve", requestId, "--json"]));
const projected = (row) => ({
  platform: row.platform,
  deviceFamily: row.deviceFamily ?? null,
  role: row.role,
  roles: row.roles,
  isRepair: row.isRepair,
});

function startTui(env) {
  let screen = "";
  const terminal = spawnPty(process.execPath, [entry, "tui", "--url", url, "--token", token], {
    name: "xterm-256color",
    cols: 140,
    rows: 40,
    cwd: process.cwd(),
    env,
  });
  terminal.onData((text) => {
    screen += stripVTControlCharacters(text);
  });
  const exited = new Promise((resolve) => terminal.onExit(resolve));
  const session = { terminal, screen: () => screen, exited };
  tui = session;
  return session;
}

async function stopTui(session) {
  session.terminal.kill();
  await session.exited;
  if (tui === session) tui = undefined;
}

async function completeTui(session) {
  await until(session.screen, (text) => text.includes("gateway connected"), "TUI connected");
  session.terminal.write("/gateway-status\r");
  await until(session.screen, (text) => text.includes("Gateway status"), "TUI status response");
  await stopTui(session);
}

try {
  phase = "gateway startup";
  const gateway = start(admin, ["gateway", "run", "--allow-unconfigured"]);
  await until(
    async () => {
      if (gateway.child.exitCode !== null) {
        throw new Error(`Gateway exited: ${sanitize(gateway.text)}`);
      }
      return gateway.text;
    },
    (text) => text.includes("listening on"),
    "Gateway listening",
  );

  phase = "normal administrator approval";
  // Read-only CLI commands do not mint device identities. The real TUI does.
  const adminTui = startTui(admin);
  await until(
    adminTui.screen,
    (text) => text.includes("pairing required"),
    "administrator pairing",
  );
  let rows = await adminList();
  for (const request of rows.pending) await approve(request.requestId);
  await stopTui(adminTui);
  await completeTui(startTui(admin));
  json(await list(admin));
  report.stages.push({ phase, completedAuthenticatedCommand: true });

  phase = "initial CLI device approval";
  const deviceTui = startTui(device);
  rows = await until(adminList, (value) => value.pending.length === 1, "initial device pairing");
  assert.equal(rows.pending.length, 1);
  const deviceId = rows.pending[0].deviceId;
  await approve(rows.pending[0].requestId);
  await stopTui(deviceTui);
  await completeTui(startTui(device));
  json(await list(device));
  report.stages.push({ phase, completedAuthenticatedCommand: true });

  phase = "Node Host role approval";
  let node = start(device, [
    "node",
    "run",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--display-name",
    "Metadata proof node",
  ]);
  rows = await until(
    adminList,
    (value) => value.pending.some((row) => row.deviceId === deviceId),
    "Node Host approval request",
  );
  const nodeRequest = rows.pending.find((row) => row.deviceId === deviceId);
  report.stages.push({ phase, approval: projected(nodeRequest), sameDevice: true });
  await approve(nodeRequest.requestId);
  await stop(node.child);
  node = start(device, [
    "node",
    "run",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--display-name",
    "Metadata proof node",
  ]);
  await until(
    async () => node.text,
    (text) => text.includes("node host gateway connected:"),
    "authenticated Node Host connection",
  );
  const invoked = json(
    await command(admin, [
      "nodes",
      "invoke",
      "--node",
      deviceId,
      "--command",
      "system.which",
      "--params",
      '{"bins":["node"]}',
      "--json",
    ]),
  );
  assert.equal(invoked.ok, true);
  report.stages.push({ phase: "Node Host operation", completed: true });
  await stop(node.child);

  phase = "CLI after approved Node Host";
  const cliResult = await list(device);
  rows = await adminList();
  const cliRequest = rows.pending.find((row) => row.deviceId === deviceId);
  report.stages.push({
    phase,
    exitCode: cliResult.code,
    approval: cliRequest ? projected(cliRequest) : null,
  });
  assert.notEqual(cliResult.code, 0, "Expected current-main metadata approval failure");
  assert.ok(cliRequest?.isRepair, "Expected same-device metadata repair request");
  assert.ok(gateway.text.includes("reason=metadata-upgrade"));
  await approve(cliRequest.requestId);

  phase = "TUI after CLI approval";
  const finalTui = startTui(device);
  await until(
    finalTui.screen,
    (text) => text.includes("gateway connected") || text.includes("pairing required"),
    "TUI connection result",
  );
  report.stages.push({
    phase,
    connected: finalTui.screen().includes("gateway connected"),
    pairingRequired: finalTui.screen().includes("pairing required"),
  });
  report.outcome = "current-main-repeated-metadata-approval";
} catch (error) {
  report.failure = { phase, message: sanitize(String(error)) };
  process.exitCode = 1;
} finally {
  if (tui) await stopTui(tui);
  for (const child of [...children]) await stop(child);
  report.cleanup = { trackedChildrenRemaining: children.size };
  await fs.mkdir(".artifacts/gateway-device-metadata", { recursive: true });
  await fs.writeFile(
    ".artifacts/gateway-device-metadata/proof.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
