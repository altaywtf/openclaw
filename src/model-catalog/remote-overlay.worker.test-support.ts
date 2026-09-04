import { parentPort, workerData } from "node:worker_threads";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getRemoteModelCatalogPricing,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";

const input = workerData as { config: OpenClawConfig; provider: string };
assert.ok(parentPort);
parentPort.postMessage(
  {
    overlay: getRemoteModelCatalogProviderOverlay(input.config, input.provider),
    pricing: getRemoteModelCatalogPricing(input.config),
  },
  [],
);
import assert from "node:assert/strict";
