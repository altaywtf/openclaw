import { Server, type AddressInfo, type Socket } from "node:net";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";

export type TranscriptCapturePorts = { gateway: number; provider: number };

declare module "vitest" {
  export interface ProvidedContext {
    transcriptCapturePorts?: TranscriptCapturePorts;
  }
}

export const protectedCapturePorts = [18789, 19943, 58091, 58173];

function isCapturePort(port: unknown): port is number {
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535 &&
    !protectedCapturePorts.includes(port)
  );
}

export function resolveTranscriptCapturePorts(input: unknown): TranscriptCapturePorts | undefined {
  if (input === undefined) {
    return undefined;
  }
  const ports = asOptionalRecord(input);
  if (
    !ports ||
    !isCapturePort(ports.gateway) ||
    !isCapturePort(ports.provider) ||
    ports.gateway === ports.provider
  ) {
    throw new Error(
      "transcriptCapturePorts requires distinct, unprotected integer gateway and provider ports",
    );
  }
  return { gateway: ports.gateway, provider: ports.provider };
}

function assertCaptureBind(
  host: unknown,
  port: unknown,
  allowed: readonly number[],
  allocating: boolean,
): asserts port is number {
  if (
    host !== "127.0.0.1" ||
    !(isCapturePort(port) || (allocating && port === 0)) ||
    (!allocating && !allowed.includes(port))
  ) {
    throw new Error(`unexpected transcript fixture bind ${String(host)}:${String(port)}`);
  }
}

export function assertCaptureAddress(
  address: AddressInfo | string | null,
  requestedPort: number,
): asserts address is AddressInfo {
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1" ||
    !isCapturePort(address.port) ||
    (requestedPort !== 0 && address.port !== requestedPort)
  ) {
    throw new Error("transcript fixture listener disagrees with its requested loopback endpoint");
  }
}

// Install before creating either server. Exact runs allow no allocation probes;
// ordinary CI retains the existing port helper only until Gateway publishes its port.
export function installCaptureBindGuard(policy: () => { ports: number[]; allocating: boolean }) {
  const observed: AddressInfo[] = [];
  const rejected: { host: unknown; port: unknown }[] = [];
  const failures: Error[] = [];
  const owned = new Set<Server>();
  const sockets = new Set<Socket>();
  const onConnection = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  // oxlint-disable-next-line typescript/unbound-method
  const originalListen = Server.prototype.listen;
  const fence = vi.spyOn(Server.prototype, "listen").mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    const options = asOptionalRecord(args[0]);
    const host = options?.host ?? args[1];
    const port = options?.port ?? args[0];
    try {
      const current = policy();
      assertCaptureBind(host, port, current.ports, current.allocating);
    } catch (error) {
      rejected.push({ host, port });
      // Match native listen failure delivery, including Gateway's optional IPv6 probe.
      // Nothing reaches the native bind for a denied endpoint.
      queueMicrotask(() => this.emit("error", error));
      return this;
    }
    owned.add(this);
    this.on("connection", onConnection);
    const onListening = () => {
      try {
        const address = this.address();
        assertCaptureAddress(address, port);
        observed.push(address);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        this.close();
        this.emit("error", failure);
      }
    };
    this.prependOnceListener("listening", onListening);
    this.once("error", () => this.off("listening", onListening));
    return Reflect.apply(originalListen, this, args);
  });
  return {
    observed,
    rejected,
    failures,
    async close() {
      try {
        for (const socket of sockets) {
          socket.destroy();
        }
        await Promise.all(
          [...owned].map(async (server) => {
            server.off("connection", onConnection);
            if (server.listening) {
              await new Promise<void>((resolve) => {
                server.close(() => resolve());
              });
            }
          }),
        );
      } finally {
        fence.mockRestore();
      }
    },
  };
}
