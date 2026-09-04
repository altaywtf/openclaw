import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import {
  validateAndSanitizeRemoteModelCatalogBundle,
  type RemoteModelCatalogBundle,
  type RemoteModelCatalogPricing,
} from "@openclaw/model-catalog-core";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compareOpenClawVersions } from "../config/version.js";
import { VERSION } from "../version.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";
import { isRemoteModelCatalogRefreshEnabled, resolveRemoteCatalogUrl } from "./remote-config.js";
import { readRemoteModelCatalog } from "./remote-store.js";

type RemoteModelCatalogOverlay = Readonly<Record<string, ModelCatalogProvider>>;
type ActiveRemoteModelCatalog = {
  sourceUrl: string;
  generatedAt: number;
  providers: RemoteModelCatalogOverlay;
  pricing?: Readonly<Record<string, RemoteModelCatalogPricing>>;
};

type CapturedRemoteModelCatalog = { catalog?: ActiveRemoteModelCatalog };
const REMOTE_MODEL_CATALOG_SNAPSHOT_KEY = "openclaw.remoteModelCatalogSnapshot";
let readBundledGeneratedAt = bundledCatalogGeneratedAt;
let readStoredCatalog = readRemoteModelCatalog;

function isCompatible(bundle: RemoteModelCatalogBundle): boolean {
  if (!bundle.minVersion) {
    return true;
  }
  const comparison = compareOpenClawVersions(VERSION, bundle.minVersion);
  return comparison !== null && comparison >= 0;
}

function readActiveRemoteModelCatalog(): ActiveRemoteModelCatalog | undefined {
  const bundledGeneratedAt = readBundledGeneratedAt();
  if (bundledGeneratedAt === undefined) {
    return undefined;
  }
  const stored = readStoredCatalog();
  if (!stored) {
    return undefined;
  }
  const bundle = validateAndSanitizeRemoteModelCatalogBundle(JSON.parse(stored.bundle_json));
  if (bundle.generatedAt <= bundledGeneratedAt || !isCompatible(bundle)) {
    return undefined;
  }
  return {
    sourceUrl: stored.source_url,
    generatedAt: bundle.generatedAt,
    providers: bundle.providers,
    ...(bundle.pricing ? { pricing: bundle.pricing } : {}),
  };
}

export function captureRemoteModelCatalogSnapshot(): CapturedRemoteModelCatalog {
  const captured = getEnvironmentData(REMOTE_MODEL_CATALOG_SNAPSHOT_KEY) as
    | CapturedRemoteModelCatalog
    | undefined;
  if (captured) {
    return captured;
  }
  let catalog: ActiveRemoteModelCatalog | undefined;
  try {
    catalog = readActiveRemoteModelCatalog();
  } catch {
    // Invalid optional metadata stays absent for this process, just like a missing download.
  }
  const snapshot = { catalog };
  // Workers inherit the same startup data, including absence. Later downloads must not change
  // rows in a replacement worker while the Gateway still uses the previous prices.
  setEnvironmentData(REMOTE_MODEL_CATALOG_SNAPSHOT_KEY, snapshot);
  return snapshot;
}

function getActiveRemoteModelCatalog(config: OpenClawConfig): ActiveRemoteModelCatalog | undefined {
  if (!isRemoteModelCatalogRefreshEnabled(config)) {
    return undefined;
  }
  const { catalog } = captureRemoteModelCatalogSnapshot();
  return catalog?.sourceUrl === resolveRemoteCatalogUrl(config) ? catalog : undefined;
}

export function checkRemoteModelCatalogUpdate(
  config: OpenClawConfig,
  expected: { sourceUrl: string; generatedAt: number },
): "restart-required" | "unchanged" | "superseded" {
  if (
    !isRemoteModelCatalogRefreshEnabled(config) ||
    resolveRemoteCatalogUrl(config) !== expected.sourceUrl
  ) {
    return "superseded";
  }
  if (getActiveRemoteModelCatalog(config)?.generatedAt === expected.generatedAt) {
    return "unchanged";
  }
  const value = readActiveRemoteModelCatalog();
  if (!value) {
    return "unchanged";
  }
  if (value.sourceUrl !== expected.sourceUrl || value.generatedAt !== expected.generatedAt) {
    return "superseded";
  }
  return "restart-required";
}

export function getRemoteModelCatalogProviderOverlay(
  config: OpenClawConfig,
  provider: string,
): ModelCatalogProvider | undefined {
  const providerId = normalizeProviderId(provider);
  return providerId ? getActiveRemoteModelCatalog(config)?.providers[providerId] : undefined;
}

export function getRemoteModelCatalogPricing(
  config: OpenClawConfig,
): Readonly<Record<string, RemoteModelCatalogPricing>> | undefined {
  return getActiveRemoteModelCatalog(config)?.pricing;
}

function setRemoteModelCatalogOverlaySourcesForTest(sources?: {
  bundledGeneratedAt?: typeof bundledCatalogGeneratedAt;
  readStoredCatalog?: typeof readRemoteModelCatalog;
}): void {
  setEnvironmentData(REMOTE_MODEL_CATALOG_SNAPSHOT_KEY, undefined);
  readBundledGeneratedAt = sources?.bundledGeneratedAt ?? bundledCatalogGeneratedAt;
  readStoredCatalog = sources?.readStoredCatalog ?? readRemoteModelCatalog;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.remoteModelCatalogOverlayTestApi")
  ] = {
    setRemoteModelCatalogOverlaySourcesForTest,
  };
}
