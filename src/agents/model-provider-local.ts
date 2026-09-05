/** Shared local model-provider URL classification. */
import { isLoopbackIpAddress, isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export const LOCAL_PROVIDER_HOST_ALIASES = new Set([
  "docker.orb.internal",
  "host.docker.internal",
  "host.orb.internal",
]);

export function isLocalProviderBaseUrl(
  baseUrl: string,
  additionalHostnames?: ReadonlySet<string>,
): boolean {
  try {
    let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      additionalHostnames?.has(host) === true ||
      isLoopbackIpAddress(host) ||
      isRfc1918Ipv4Address(host)
    );
  } catch {
    return false;
  }
}
