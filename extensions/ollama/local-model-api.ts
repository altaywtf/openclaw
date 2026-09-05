import { isCloudModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { isLoopbackIpAddress, isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";

const LOCAL_OLLAMA_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "::1",
  "::",
  "docker.orb.internal",
  "host.docker.internal",
  "host.orb.internal",
]);

export function isLocalOllamaBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return (
    LOCAL_OLLAMA_HOSTNAMES.has(host) ||
    host.replace(/\.+$/, "") === "localhost" ||
    isLoopbackIpAddress(host) ||
    host.endsWith(".local") ||
    isRfc1918Ipv4Address(host) ||
    /^fe[89ab][0-9a-f]:/.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    (!host.includes(".") && !host.includes(":"))
  );
}

export function isHostedOllamaCloud(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === "ollama.com" || host.endsWith(".ollama.com");
}

export function isSelfHostedOllamaModel(modelId: string, baseUrl?: string): boolean {
  return !isCloudModelRef(modelId) && !isHostedOllamaCloud(baseUrl);
}
