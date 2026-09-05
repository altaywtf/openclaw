import { expect, it, vi, type Mock } from "vitest";

type RestartPostCheckContext = {
  activationAccepted: boolean;
  json: boolean;
  stdout: NodeJS.WritableStream;
  warnings: string[];
  fail: (message: string, hints?: string[]) => void;
};

export type RestartParams = {
  opts?: { json?: boolean };
  beforeServiceMutation?: () => void;
  repairLoadedService?: (ctx: {
    json: boolean;
    stdout: NodeJS.WritableStream;
    state: unknown;
    issues: unknown[];
  }) => Promise<unknown>;
  postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<void>;
};

export function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

export async function expectRestartError(
  promise: Promise<unknown>,
): Promise<Error & { hints?: string[] }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { hints?: string[] };
  }
  throw new Error("expected restart to fail");
}

export function registerSystemdStopTests({
  service,
  findInstalledSystemdGatewayScope,
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync,
  mockSystemdScope,
  readActiveGatewayLockIdentity,
  stopSystemdService,
  runUnmanagedStop,
}: {
  service: { readRuntime: Mock; readCommand: Mock; stop: Mock };
  findInstalledSystemdGatewayScope: Mock;
  findVerifiedGatewayListenerPidsOnPortSync: Mock;
  signalVerifiedGatewayPidSync: Mock;
  mockSystemdScope: (unit: string) => void;
  readActiveGatewayLockIdentity: Mock;
  stopSystemdService: Mock;
  runUnmanagedStop: (options?: { force?: boolean }) => Promise<unknown>;
}) {
  it.each(["running", "inactive", "failed"])(
    "stops a disabled %s unit before signaling a remaining foreground Gateway",
    async (state) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      service.readRuntime.mockResolvedValue({
        status: state === "running" ? "running" : "stopped",
        state,
      });
      findInstalledSystemdGatewayScope.mockResolvedValue({
        scope: "user",
        unitName: "openclaw-gateway.service",
        unitPath: "/synthetic/.config/systemd/user/openclaw-gateway.service",
      });
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4300]);

      await runUnmanagedStop({ force: true });

      expect(service.stop).toHaveBeenCalledOnce();
      expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4300, "SIGTERM");
      expect(service.stop).toHaveBeenCalledBefore(findVerifiedGatewayListenerPidsOnPortSync);
    },
  );

  it.each(["unknown", "missing", "foreign"])(
    "does not route a disabled %s unit through the native stop path",
    async (kind) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      service.readRuntime.mockResolvedValue({
        status: kind === "unknown" ? "unknown" : "stopped",
        state: "inactive",
        missingUnit: kind === "missing",
      });
      findInstalledSystemdGatewayScope.mockResolvedValue({
        scope: "user",
        unitName: "openclaw-gateway.service",
        unitPath: "/tmp/synthetic/gateway.service",
      });
      if (kind === "foreign") {
        service.readCommand.mockResolvedValue({
          programArguments: ["foreign-service"],
          environment: {},
        });
      }
      await runUnmanagedStop({ force: true });
      expect(service.stop).not.toHaveBeenCalled();
    },
  );

  it.each(["stopped", "unknown", "unreadable"])(
    "stops a system-scope unit before remaining listeners when runtime is %s",
    async (runtime) => {
      mockSystemdScope("openclaw-gateway.service");
      if (runtime === "unreadable") {
        service.readRuntime.mockRejectedValue(new Error("runtime inspection unavailable"));
      } else {
        service.readRuntime.mockResolvedValue({ status: runtime });
      }
      stopSystemdService.mockResolvedValue(undefined);
      await expect(runUnmanagedStop()).resolves.toEqual(
        expect.objectContaining({ result: "stopped" }),
      );
      expect(stopSystemdService).toHaveBeenCalledOnce();
      expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGTERM");
      expect(stopSystemdService).toHaveBeenCalledBefore(findVerifiedGatewayListenerPidsOnPortSync);
    },
  );

  it("reports native stop after its process and lock disappear", async () => {
    mockSystemdScope("openclaw-gateway.service");
    stopSystemdService.mockImplementation(async () => {
      readActiveGatewayLockIdentity.mockResolvedValue(undefined);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    });
    await expect(runUnmanagedStop()).resolves.toEqual(
      expect.objectContaining({ result: "stopped" }),
    );
    expect(stopSystemdService).toHaveBeenCalledOnce();
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(stopSystemdService).toHaveBeenCalledBefore(readActiveGatewayLockIdentity);
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it("surfaces systemd sudo guidance and never signals when stopping a system-scope unit as non-root (openclaw#87577)", async () => {
    mockSystemdScope("openclaw-gateway.service");
    stopSystemdService.mockRejectedValue(
      new Error(
        "openclaw-gateway.service is a system-scope unit (/etc/systemd/system/openclaw-gateway.service); run `sudo systemctl stop openclaw-gateway.service` to stop it",
      ),
    );
    await expect(runUnmanagedStop()).rejects.toThrow(
      /sudo systemctl stop openclaw-gateway\.service/,
    );
    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });
}
