export function resolveGatewayClientPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

export function resolveGatewayClientDeviceFamily(platform: NodeJS.Platform): string | undefined {
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
