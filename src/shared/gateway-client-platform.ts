export function resolveGatewayClientPlatform(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return platform;
  }
}

export function resolveGatewayClientDeviceFamily(platform: string): string | undefined {
  switch (platform) {
    case "darwin":
      return "Mac";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return undefined;
  }
}
