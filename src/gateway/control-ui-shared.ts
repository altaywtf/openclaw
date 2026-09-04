// Browser-safe Control UI base-path normalization shared by route contracts and Gateway callers.
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";

/** Normalizes a Control UI base path to either "" or a leading-slash path without trailing slash. */
export function normalizeControlUiBasePath(basePath?: string | null): string {
  const value = basePath?.trim() ?? "";
  if (!value || value === "/") {
    return "";
  }
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

/** Advertise browser identity at its authenticated ingress, independently of native transport auth. */
export function resolveControlUiIdentityUrl(
  cfg: OpenClawConfig,
  auth: ResolvedGatewayAuth,
): string | undefined {
  const usesIdentity =
    auth.mode === "trusted-proxy" ||
    (auth.mode !== "none" && auth.allowTailscale && cfg.gateway?.tailscale?.mode === "serve");
  if (!usesIdentity || cfg.gateway?.controlUi?.enabled === false) {
    return undefined;
  }
  const origin = resolveGatewayPublicOrigin(cfg);
  if (!origin?.startsWith("https://")) {
    return undefined;
  }
  return `${origin}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}/`;
}

/** Keeps push navigation in the receiving PWA while selecting its originating Gateway. */
export function resolveControlUiWebPushUrl(cfg: OpenClawConfig, relativePath: string): string {
  const publicOrigin = resolveGatewayPublicOrigin(cfg);
  if (!publicOrigin) {
    return relativePath;
  }
  // A remote Gateway's base path may differ from the PWA's service-worker scope.
  const basePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const gatewayUrl = `${publicOrigin.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:")}${basePath}`;
  return `${relativePath}#${new URLSearchParams({ gatewayUrl })}`;
}
