import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { spawn as spawnPty } from "@lydell/node-pty";
import WebSocket from "ws";

// Product proof uses only the built CLI and native terminal. No runtime imports.
assert.equal(process.platform, "win32", "This proof must execute on native Windows");
const entry = path.resolve(process.argv[2] ?? "openclaw.mjs");
const legacyEntry = process.argv[3];
const requireGreen = legacyEntry !== undefined;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-metadata-proof-"));
const token = randomBytes(32).toString("hex");
const report = { platform: process.platform, stages: [], outcome: "incomplete" };
const children = new Set();
const captures = [];
const childExits = new WeakMap();
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

function start(env, args, application = entry) {
  const child = spawn(process.execPath, [application, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = { child, text: "", stdout: "" };
  captures.push(capture);
  children.add(child);
  child.stdout.on("data", (chunk) => {
    capture.stdout += chunk;
    capture.text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    capture.text += chunk;
  });
  child.once("close", () => children.delete(child));
  childExits.set(child, new Promise((resolve) => child.once("close", resolve)));
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
  await childExits.get(child);
}

async function command(env, args, application = entry) {
  const capture = start(env, args, application);
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
    .replaceAll(root, "<isolated-state>")
    .replaceAll(process.cwd(), "<product-checkout>");
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

async function ready(gateway) {
  await until(
    async () => {
      if (gateway.child.exitCode !== null) {
        throw new Error(`Gateway exited: ${sanitize(gateway.text)}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok && (await response.json()).ready === true;
      } catch {
        return false;
      }
    },
    (value) => value,
    "Gateway readyz",
  );
}

function wireIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    privateKey,
    publicKey: raw.toString("base64url"),
    id: createHash("sha256").update(raw).digest("hex"),
  };
}

async function wireConnect(identity, platform, deviceFamily, { corruptSignature = false } = {}) {
  const socket = new WebSocket(url);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const pending = new Map();
  let sequence = 0;
  let resolveChallenge;
  let rejectChallenge;
  const challenge = new Promise((resolve, reject) => {
    resolveChallenge = resolve;
    rejectChallenge = reject;
  });
  const challengeTimer = setTimeout(
    () => rejectChallenge(new Error("Wire challenge timeout")),
    15_000,
  );
  socket.on("error", rejectChallenge);
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "event" && frame.event === "connect.challenge") {
      resolveChallenge(frame.payload);
    }
    if (frame.type === "res") pending.get(frame.id)?.(frame);
  });
  function request(method, params = {}) {
    const id = `metadata-proof-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Wire request timeout: ${method}`));
      }, 15_000);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(frame);
      });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }
  try {
    const { nonce, ts } = await challenge;
    clearTimeout(challengeTimer);
    const scopes = ["operator.read"];
    const payload = [
      "v3",
      identity.id,
      "test",
      "test",
      "operator",
      scopes.join(","),
      String(ts),
      token,
      nonce,
      platform.toLowerCase(),
      (deviceFamily ?? "").toLowerCase(),
    ].join("|");
    const response = await request("connect", {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        id: "test",
        mode: "test",
        version: "metadata-proof",
        platform: corruptSignature ? `${platform}-changed` : platform,
        deviceFamily,
      },
      role: "operator",
      scopes,
      caps: [],
      auth: { token },
      device: {
        id: identity.id,
        publicKey: identity.publicKey,
        signedAt: ts,
        nonce,
        signature: sign(null, Buffer.from(payload), identity.privateKey).toString("base64url"),
      },
    });
    let health;
    if (response.ok) {
      assert.equal(response.payload.protocol, 4);
      health = await request("health");
      assert.equal(health.ok, true);
    }
    return { response, health };
  } finally {
    clearTimeout(challengeTimer);
    socket.close();
    await closed;
  }
}

async function approveWire(identity) {
  const rows = await adminList();
  const request = rows.pending.find((row) => row.deviceId === identity.id);
  assert.ok(request);
  assert.equal(request.publicKey, identity.publicKey);
  await approve(request.requestId);
}

async function wireControls() {
  const identity = wireIdentity();
  report.controls = [];
  const first = await wireConnect(identity, "windows", "Windows");
  assert.equal(first.response.ok, false);
  assert.equal(first.response.error.details.reason, "not-paired");
  await approveWire(identity);
  assert.equal((await wireConnect(identity, "windows", "Windows")).response.ok, true);
  report.controls.push({
    case: "distinct key",
    first: first.response,
    approvedHealthCompleted: true,
  });

  const copiedId = { ...wireIdentity(), id: identity.id };
  const counterfeit = await wireConnect(copiedId, "windows", "Windows");
  assert.equal(counterfeit.response.error.details.reason, "device-id-mismatch");
  const malformed = await wireConnect(identity, "windows", "Windows", { corruptSignature: true });
  assert.equal(malformed.response.error.details.reason, "device-signature");
  assert.equal((await adminList()).pending.length, 0);
  report.controls.push({
    case: "key and signature binding",
    counterfeit: counterfeit.response,
    malformed: malformed.response,
  });

  for (const [platform, deviceFamily] of [
    ["linux", "Linux"],
    ["linux", "Workstation"],
  ]) {
    const rejected = await wireConnect(identity, platform, deviceFamily);
    assert.equal(rejected.response.ok, false);
    assert.equal(rejected.response.error.details.reason, "metadata-upgrade");
    await approveWire(identity);
    assert.equal((await wireConnect(identity, platform, deviceFamily)).response.ok, true);
    report.controls.push({
      case: "non-equivalent metadata",
      platform,
      deviceFamily,
      rejected: rejected.response,
      approvedHealthCompleted: true,
    });
  }
}

try {
  phase = "gateway startup";
  const gateway = start(admin, ["gateway", "run", "--allow-unconfigured"]);
  await ready(gateway);

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
  const adminIdentity = json(await command(admin, ["node", "identity", "--json"]));
  report.stages.push({ phase, completedAuthenticatedCommand: true });

  phase = "initial CLI device approval";
  const deviceTui = startTui(device);
  rows = await until(adminList, (value) => value.pending.length === 1, "initial device pairing");
  assert.equal(rows.pending.length, 1);
  const deviceId = rows.pending[0].deviceId;
  assert.notEqual(deviceId, adminIdentity.deviceId);
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
  phase = "Node Host command approval";
  const pendingNodes = await until(
    async () => json(await command(admin, ["nodes", "pending", "--json"])),
    (value) => value.some((row) => row.nodeId === deviceId),
    "Node Host command-surface request",
  );
  const nodeSurface = pendingNodes.find((row) => row.nodeId === deviceId);
  const invokeArgs = [
    "nodes",
    "invoke",
    "--node",
    deviceId,
    "--command",
    "system.which",
    "--params",
    '{"bins":["node"]}',
    "--json",
  ];
  assert.notEqual((await command(admin, invokeArgs)).code, 0);
  json(await command(admin, ["nodes", "approve", nodeSurface.requestId, "--json"]));
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
    "approved Node Host connection",
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
  assert.equal(typeof invoked.payload.bins.node, "string");
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
  if (cliRequest) {
    assert.ok(cliRequest.isRepair, "Expected same-device metadata repair request");
    await approve(cliRequest.requestId);
  } else {
    json(cliResult);
  }

  phase = "TUI after approved Node Host";
  const finalTui = startTui(device);
  await until(
    finalTui.screen,
    (text) =>
      text.includes("gateway connected") ||
      text.includes("pairing required") ||
      text.includes("device metadata change pending approval"),
    "TUI connection result",
  );
  rows = await adminList();
  const tuiRequest = rows.pending.find((row) => row.deviceId === deviceId);
  const pairedBeforeTuiApproval = rows.paired.find((row) => row.deviceId === deviceId);
  report.stages.push({
    phase,
    connected: finalTui.screen().includes("gateway connected"),
    pairingRequired: Boolean(tuiRequest),
    approval: tuiRequest ? projected(tuiRequest) : null,
    paired: projected(pairedBeforeTuiApproval),
    terminal: sanitize(finalTui.screen()),
  });
  if (finalTui.screen().includes("gateway connected")) {
    await completeTui(finalTui);
  } else {
    assert.ok(tuiRequest?.isRepair, "Expected same-device TUI metadata request");
    assert.ok(gateway.text.includes("reason=metadata-upgrade"));
    await approve(tuiRequest.requestId);
    await stopTui(finalTui);
    await completeTui(startTui(device));
    report.stages.push({ phase: "TUI after metadata approval", completedStatusRequest: true });
  }
  phase = "second Node Host after TUI";
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
  const secondNode = await until(
    async () => ({
      rows: await adminList(),
      connected: node.text.includes("node host gateway connected:"),
    }),
    (value) => value.connected || value.rows.pending.some((row) => row.deviceId === deviceId),
    "second Node Host outcome",
  );
  report.stages.push({
    phase,
    connected: secondNode.connected,
    approval: secondNode.rows.pending.filter((row) => row.deviceId === deviceId).map(projected),
  });
  if (secondNode.connected) {
    assert.equal(json(await command(admin, invokeArgs)).ok, true);
  }
  await stop(node.child);
  phase = "final CLI";
  const finalCli = await list(device);
  report.stages.push({ phase, exitCode: finalCli.code });
  json(finalCli);
  await completeTui(startTui(device));
  report.stages.push({ phase: "final TUI", completedStatusRequest: true });
  report.outcome =
    cliRequest || tuiRequest || secondNode.rows.pending.some((row) => row.deviceId === deviceId)
      ? "metadata-approval-after-approved-device-and-role"
      : "alternating-sequence-completed-without-metadata-approval";
  if (requireGreen) {
    assert.equal(report.outcome, "alternating-sequence-completed-without-metadata-approval");
    phase = "public wire approval controls";
    await wireControls();
    report.gateway = sanitize(gateway.text);
    await stop(gateway.child);

    phase = "legacy package startup";
    const legacyEnv = await makeState("legacy-upgrade");
    delete legacyEnv.OPENCLAW_GATEWAY_TOKEN;
    const legacyConfig = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token" },
        controlUi: { enabled: false },
      },
      plugins: { allow: [] },
    };
    await fs.writeFile(legacyEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(legacyConfig));
    const oldGateway = start(legacyEnv, ["gateway", "run", "--allow-unconfigured"], legacyEntry);
    await ready(oldGateway);
    const oldVersion = await command(legacyEnv, ["--version"], legacyEntry);
    assert.equal(oldVersion.code, 0);
    assert.ok(oldVersion.stdout.includes("2026.8.1-beta.2"));
    const oldDevices = json(await command(legacyEnv, ["devices", "list", "--json"], legacyEntry));
    assert.equal(oldDevices.paired.length, 1);
    const oldDevice = oldDevices.paired[0];
    assert.equal(oldDevice.platform, "win32");
    assert.equal(oldDevice.deviceFamily, undefined);
    report.legacy = { version: oldVersion.stdout.trim(), before: projected(oldDevice) };
    await stop(oldGateway.child);

    phase = "legacy state upgraded to candidate";
    legacyConfig.gateway.auth.token = token;
    legacyConfig.gateway.nodes = { pairing: { autoApproveLocal: false, sshVerify: false } };
    legacyEnv.OPENCLAW_GATEWAY_TOKEN = token;
    await fs.writeFile(legacyEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(legacyConfig));
    const upgradedGateway = start(legacyEnv, ["gateway", "run", "--allow-unconfigured"]);
    await ready(upgradedGateway);
    const upgradeRows = json(await list(legacyEnv));
    const upgradedDevice = upgradeRows.paired.find((row) => row.deviceId === oldDevice.deviceId);
    assert.ok(upgradedDevice);
    report.legacy.beforeTui = projected(upgradedDevice);
    await completeTui(startTui(legacyEnv));
    assert.equal(json(await list(legacyEnv)).pending.length, 0);
    report.legacy.sameIdentityTuiStatusCompleted = true;

    phase = "legacy identity node role approval";
    const legacyNodeArgs = [
      "node",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--display-name",
      "Legacy metadata proof node",
    ];
    let legacyNode = start(legacyEnv, legacyNodeArgs);
    const legacyPending = await until(
      async () => json(await list(legacyEnv)),
      (value) => value.pending.some((row) => row.deviceId === oldDevice.deviceId),
      "legacy node role request",
    );
    const legacyRequest = legacyPending.pending.find((row) => row.deviceId === oldDevice.deviceId);
    assert.equal(legacyRequest.role, "node");
    json(await command(legacyEnv, ["devices", "approve", legacyRequest.requestId, "--json"]));
    await stop(legacyNode.child);
    legacyNode = start(legacyEnv, legacyNodeArgs);
    await until(
      async () => legacyNode.text,
      (text) => text.includes("node host gateway connected:"),
      "legacy node connected",
    );
    const legacySurfaces = await until(
      async () => json(await command(legacyEnv, ["nodes", "pending", "--json"])),
      (value) => value.some((row) => row.nodeId === oldDevice.deviceId),
      "legacy node command approval",
    );
    const legacySurface = legacySurfaces.find((row) => row.nodeId === oldDevice.deviceId);
    json(await command(legacyEnv, ["nodes", "approve", legacySurface.requestId, "--json"]));
    await stop(legacyNode.child);
    legacyNode = start(legacyEnv, legacyNodeArgs);
    await until(
      async () => legacyNode.text,
      (text) => text.includes("node host gateway connected:"),
      "approved legacy node connected",
    );
    const legacyInvokeArgs = [
      "nodes",
      "invoke",
      "--node",
      oldDevice.deviceId,
      "--command",
      "system.which",
      "--params",
      '{"bins":["node"]}',
      "--json",
    ];
    const legacyInvocation = json(await command(legacyEnv, legacyInvokeArgs));
    assert.equal(legacyInvocation.ok, true);
    assert.equal(typeof legacyInvocation.payload.bins.node, "string");
    await stop(legacyNode.child);
    json(await list(legacyEnv));
    await completeTui(startTui(legacyEnv));
    legacyNode = start(legacyEnv, legacyNodeArgs);
    await until(
      async () => legacyNode.text,
      (text) => text.includes("node host gateway connected:"),
      "legacy node reconnect",
    );
    assert.equal(json(await command(legacyEnv, legacyInvokeArgs)).ok, true);
    await stop(legacyNode.child);
    json(await list(legacyEnv));
    await completeTui(startTui(legacyEnv));
    assert.equal(json(await list(legacyEnv)).pending.length, 0);
    assert.equal(upgradedGateway.text.includes("reason=metadata-upgrade"), false);
    report.legacy.completedAlternatingSequence = true;
    report.legacy.gateway = sanitize(upgradedGateway.text);
    await stop(upgradedGateway.child);
  }
} catch (error) {
  report.failure = { phase, message: sanitize(String(error)) };
  report.diagnostics = captures.map((capture) => ({
    exitCode: capture.child.exitCode,
    output: sanitize(capture.text),
  }));
  if (tui) report.terminal = sanitize(tui.screen());
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
