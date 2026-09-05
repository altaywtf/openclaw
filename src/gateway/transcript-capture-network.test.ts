import { Server } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  assertCaptureAddress,
  installCaptureBindGuard,
  protectedCapturePorts,
  resolveTranscriptCapturePorts,
} from "./transcript-capture-network.test-support.js";

const ports = { gateway: 30001, provider: 30002 };

function substituteNativeListen(emitListening = false) {
  const descriptor = Object.getOwnPropertyDescriptor(Server.prototype, "listen")!;
  const calls = vi.fn();
  // A plain method keeps the guard's own spy distinct from this native substitute.
  function listen(this: Server) {
    calls();
    if (emitListening) {
      queueMicrotask(() => this.emit("listening"));
    }
    return this;
  }
  Object.defineProperty(Server.prototype, "listen", { ...descriptor, value: listen });
  return {
    calls,
    listen,
    restore: () => Object.defineProperty(Server.prototype, "listen", descriptor),
  };
}

describe("transcript fixture network boundary without native sockets", () => {
  it("keeps dynamic allocation optional and accepts a complete exact pair", () => {
    expect(resolveTranscriptCapturePorts(undefined)).toBeUndefined();
    expect(resolveTranscriptCapturePorts(ports)).toEqual(ports);
  });

  it.each([
    null,
    {},
    { gateway: 30001 },
    { provider: 30002 },
    { ...ports, provider: 30001 },
    ...[0, -1, 65536, 1.5, Number.NaN, "30002", ...protectedCapturePorts].flatMap((port) => [
      { ...ports, gateway: port },
      { ...ports, provider: port },
    ]),
  ])("rejects invalid provided ports %j", (input) => {
    expect(() => resolveTranscriptCapturePorts(input)).toThrow("transcriptCapturePorts");
  });

  it.each([
    [30001],
    [30001, "localhost"],
    [30001, "0.0.0.0"],
    [30001, "::"],
    [0, "::1"],
    [{ port: 30001 }],
    [{ port: 30001, host: "localhost" }],
    [30003, "127.0.0.1"],
    [0, "127.0.0.1"],
    ["30001", "127.0.0.1"],
    ...protectedCapturePorts.map((port) => [port, "127.0.0.1"]),
  ])("rejects a bind before native listen: %j", async (...args) => {
    const native = substituteNativeListen();
    const guard = installCaptureBindGuard(() => ({
      ports: Object.values(ports),
      allocating: false,
    }));
    const server = new Server();
    try {
      const error = new Promise<Error>((resolve) => {
        server.once("error", resolve);
      });
      // Reflect.apply supplies the native method's required server receiver.
      // oxlint-disable-next-line typescript/unbound-method
      Reflect.apply(server.listen, server, args);
      await expect(error).resolves.toMatchObject({
        message: expect.stringContaining("unexpected transcript fixture bind"),
      });
      expect(native.calls).not.toHaveBeenCalled();
      expect(guard.observed).toEqual([]);
    } finally {
      await guard.close();
      native.restore();
    }
  });

  it.each([false, true])(
    "observes actual IPv4 endpoints (allocation=%s) and restores the hook",
    async (allocating) => {
      const native = substituteNativeListen(true);
      const guard = installCaptureBindGuard(() => ({ ports: Object.values(ports), allocating }));
      const server = new Server();
      const address = vi
        .spyOn(server, "address")
        .mockReturnValue({ address: "127.0.0.1", port: ports.provider, family: "IPv4" });
      try {
        const listening = new Promise<void>((resolve) => {
          server.once("listening", resolve);
        });
        server.listen({ host: "127.0.0.1", port: allocating ? 0 : ports.provider });
        await listening;
        expect(native.calls).toHaveBeenCalledOnce();
        expect(guard.observed).toEqual([address.mock.results[0]?.value]);
        expect(guard.failures).toEqual([]);
      } finally {
        await guard.close();
        address.mockRestore();
        // The test's native substitute remains installed until its own owner restores it.
        // This compares method identity without calling it or discarding its receiver.
        // oxlint-disable-next-line typescript/unbound-method
        expect(Server.prototype.listen).toBe(native.listen);
        native.restore();
      }
    },
  );

  it("closes an owned listener when its observed address disagrees", async () => {
    const native = substituteNativeListen(true);
    const guard = installCaptureBindGuard(() => ({
      ports: Object.values(ports),
      allocating: false,
    }));
    const server = new Server();
    const address = vi
      .spyOn(server, "address")
      .mockReturnValue({ address: "0.0.0.0", port: ports.gateway, family: "IPv4" });
    const close = vi.spyOn(server, "close").mockReturnValue(server);
    try {
      const error = new Promise<Error>((resolve) => {
        server.once("error", resolve);
      });
      server.listen(ports.gateway, "127.0.0.1");
      await expect(error).resolves.toMatchObject({ message: expect.stringContaining("disagrees") });
      expect(close).toHaveBeenCalledOnce();
      expect(guard.failures).toHaveLength(1);
      expect(guard.observed).toEqual([]);
    } finally {
      await guard.close();
      address.mockRestore();
      close.mockRestore();
      native.restore();
    }
  });

  it.each([
    null,
    "socket-path",
    { address: "::1", port: 30001, family: "IPv6" },
    ...[30003, ...protectedCapturePorts].map((port) => ({
      address: "127.0.0.1",
      port,
      family: "IPv4",
    })),
  ])("rejects an unexpected observed address %j", (address) => {
    expect(() => assertCaptureAddress(address, ports.gateway)).toThrow("disagrees");
  });
});
