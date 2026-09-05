import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { readSessionRuntimeOwnership } from "../../agents/harness/session-runtime-ownership.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChatMetadataReadParams, ChatMetadataResult } from "./chat-metadata-contract.js";

export function projectSessionModelCatalog(
  readParams: ChatMetadataReadParams,
  models: ModelChoice[],
  config: OpenClawConfig,
): ModelChoice[] {
  const ownership = readSessionRuntimeOwnership({ ...readParams, config });
  if (ownership?.auth !== "native") {
    return models;
  }
  // Pending native branches have no tuple yet. Remove the host-only gate from
  // the rendered placeholder, without calling it a native selection or proving credentials.
  const renderedModel =
    ownership.modelRef ??
    resolveSessionModelRef(config, readParams.sessionEntry, readParams.agentId, {
      allowPluginNormalization: false,
    });
  return models.map((model) => {
    if (model.provider !== renderedModel.provider || model.id !== renderedModel.model) {
      return model;
    }
    const {
      available: _available,
      unavailableReason: _reason,
      unavailableUntil: _until,
      ...native
    } = model;
    return native;
  });
}

export function projectChatSessionMetadata(
  readParams: ChatMetadataReadParams,
  metadata: ChatMetadataResult,
  config: OpenClawConfig,
): ChatMetadataResult {
  return metadata.models
    ? { ...metadata, models: projectSessionModelCatalog(readParams, metadata.models, config) }
    : metadata;
}
