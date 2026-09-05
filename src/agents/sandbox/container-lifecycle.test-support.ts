// Shared test fixtures for container lifecycle suites. These keep the suites'
// distinct configs and fake Docker/Podman process behavior unchanged.
import fs from "node:fs";
import type { SandboxConfig } from "./types.js";

export type ContainerSpawnCall = {
  command: string;
  args: string[];
  globalArgs: string[];
  envFileContents?: string;
};

type ContainerSpawnState = {
  calls: ContainerSpawnCall[];
  containerExists: boolean;
  inspectRunning: boolean;
  inspectError: string;
  labelHash: string;
  podmanInfo: string;
  podmanConnections: string;
  podmanMachines: string;
  beforeStart?: () => void;
};

export async function spawnContainerProcess(
  spawnState: ContainerSpawnState,
  commandAndArgs: string[],
) {
  const [command = "", ...rawArgs] = commandAndArgs;
  const globalArgs: string[] = [];
  let args = rawArgs;
  if (command === "podman") {
    while (args[0] === "--url" || args[0] === "--identity") {
      globalArgs.push(...args.slice(0, 2));
      args = args.slice(2);
    }
  }
  // The tests assert docker CLI arguments without requiring Docker; this mock
  // implements only the inspect/create/start/rm calls used by ensureSandboxContainer.
  const envFileIndex = args.indexOf("--env-file");
  const envFile = envFileIndex === -1 ? undefined : args[envFileIndex + 1];
  const call: ContainerSpawnCall = { command, args, globalArgs };
  if (args[0] === "create" && envFile) {
    call.envFileContents = fs.readFileSync(envFile, "utf8");
  }
  spawnState.calls.push(call);

  const inspectRunning =
    args[0] === "inspect" && args[1] === "-f" && args[2] === "{{.State.Running}}";
  const inspectLabel =
    args[0] === "inspect" &&
    args[1] === "-f" &&
    Boolean(args[2]?.includes('index .Config.Labels "openclaw.configHash"'));
  const handlers: {
    matches: boolean;
    run: () => { code?: number; stdout?: string; stderr?: string };
  }[] = [
    {
      matches: command !== "docker" && command !== "podman",
      run: () => ({ code: 1, stderr: `unexpected command: ${command}` }),
    },
    {
      matches: inspectRunning && Boolean(spawnState.inspectError),
      run: () => ({ code: 125, stderr: spawnState.inspectError }),
    },
    {
      matches: (inspectRunning || inspectLabel) && !spawnState.containerExists,
      run: () => ({ code: 1, stderr: "No such object" }),
    },
    {
      matches: inspectRunning,
      run: () => ({ stdout: spawnState.inspectRunning ? "true\n" : "false\n" }),
    },
    {
      matches: inspectLabel,
      run: () => ({ stdout: `${spawnState.labelHash}\n` }),
    },
    {
      matches: command === "podman" && args[0] === "info",
      run: () => ({ stdout: spawnState.podmanInfo }),
    },
    {
      matches: command === "podman" && args[0] === "system",
      run: () => ({ stdout: spawnState.podmanConnections }),
    },
    {
      matches: command === "podman" && args[0] === "machine",
      run: () => ({ stdout: spawnState.podmanMachines }),
    },
    {
      matches: args[0] === "rm" && args[1] === "-f",
      run: () => {
        spawnState.containerExists = false;
        spawnState.inspectRunning = false;
        return {};
      },
    },
    {
      matches: (args[0] === "image" && args[1] === "inspect") || args[0] === "exec",
      run: () => ({}),
    },
    {
      matches: args[0] === "create" && spawnState.containerExists,
      run: () => ({ code: 1, stderr: "container name is already in use" }),
    },
    {
      matches: args[0] === "create",
      run: () => {
        spawnState.containerExists = true;
        spawnState.inspectRunning = false;
        spawnState.labelHash =
          args
            .find((arg) => arg.startsWith("openclaw.configHash="))
            ?.slice("openclaw.configHash=".length) ?? "";
        return {};
      },
    },
    {
      matches: args[0] === "start",
      run: () => {
        spawnState.beforeStart?.();
        spawnState.inspectRunning = true;
        return {};
      },
    },
  ];
  // First-match dispatch keeps errors ahead of state changes; only the selected handler runs.
  const {
    code = 0,
    stdout = "",
    stderr = "",
  } = handlers.find(({ matches }) => matches)?.run() ?? {
    code: 1,
    stderr: `unexpected docker args: ${args.join(" ")}`,
  };
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

export function createSandboxConfig(
  dns: string[],
  binds?: string[],
  workspaceAccess: "rw" | "ro" | "none" = "rw",
  env: Record<string, string> = { LANG: "C.UTF-8" },
): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "shared",
    workspaceAccess,
    workspaceRoot: "~/.openclaw/sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:test",
      containerPrefix: "oc-test-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env,
      dns,
      extraHosts: ["host.docker.internal:host-gateway"],
      binds: binds ?? ["/tmp/workspace:/workspace:rw"],
      dangerouslyAllowReservedContainerTargets: true,
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "openclaw-browser:test",
      containerPrefix: "oc-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 5000,
    },
    tools: { allow: [], deny: [] },
    prune: { idleHours: 24, maxAgeDays: 7 },
  };
}

export function createBrowserSandboxConfig(noVncEnabled: boolean): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "session",
    workspaceAccess: "none",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "default",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp", "/var/tmp", "/run"],
      network: "none",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: true,
      image: "openclaw-sandbox-browser:bookworm-slim",
      containerPrefix: "openclaw-sbx-browser-",
      network: "openclaw-sandbox-browser",
      cdpPort: 9222,
      vncPort: 5900,
      noVncPort: 6080,
      headless: false,
      noVncEnabled,
      allowHostControl: false,
      autoStart: true,
      autoStartTimeoutMs: 12_000,
    },
    tools: {
      allow: ["browser"],
      deny: [],
    },
    prune: {
      idleHours: 24,
      maxAgeDays: 7,
    },
  };
}
