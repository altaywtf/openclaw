import { describe, expect, it } from "vitest";
import {
  resolveGatewayClientDeviceFamily,
  resolveGatewayClientPlatform,
} from "./gateway-client-platform.js";

describe("gateway client platform metadata", () => {
  it.each([
    { runtime: "darwin", platform: "macos", deviceFamily: "Mac" },
    { runtime: "win32", platform: "windows", deviceFamily: "Windows" },
    { runtime: "linux", platform: "linux", deviceFamily: "Linux" },
    { runtime: "freebsd", platform: "freebsd", deviceFamily: undefined },
  ] as const)("maps $runtime to $platform/$deviceFamily", ({ runtime, platform, deviceFamily }) => {
    expect(resolveGatewayClientPlatform(runtime)).toBe(platform);
    expect(resolveGatewayClientDeviceFamily(runtime)).toBe(deviceFamily);
  });
});
