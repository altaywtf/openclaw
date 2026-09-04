// Control UI model metadata boundary.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelCatalogResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export function modelCatalogRefreshError(result: ModelCatalogResult): string | null {
  return result.refreshFailed
    ? t(
        result.models.length > 0
          ? "chat.modelControls.modelsRefreshFailed"
          : "chat.modelControls.modelsUnavailable",
      )
    : null;
}

/** Reads the current Gateway catalog. The Gateway is the only model-list owner. */
export async function loadModelCatalog(
  client: GatewayBrowserClient,
  opts: {
    agentId: string;
    preparedOnly?: boolean;
    refresh?: boolean;
    signal?: AbortSignal;
  },
): Promise<ModelCatalogResult> {
  opts.signal?.throwIfAborted();
  const params = {
    view: "configured",
    agentId: opts.agentId.trim(),
    ...(opts.preparedOnly ? { preparedOnly: true } : {}),
    ...(opts.refresh ? { refresh: true } : {}),
  };
  return opts.signal
    ? await client.request<ModelCatalogResult>("models.list", params, { signal: opts.signal })
    : await client.request<ModelCatalogResult>("models.list", params);
}
