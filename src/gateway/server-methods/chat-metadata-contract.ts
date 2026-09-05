import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export type ChatMetadataSessionEntry = Partial<
  Pick<
    SessionEntry,
    | "sessionId"
    | "agentHarnessId"
    | "modelSelectionLocked"
    | "pluginOwnerId"
    | "providerOverride"
    | "modelOverride"
    | "authProfileOverride"
    | "authProfileOverrideSource"
    | "authProfileOverrideCompactionCount"
  >
>;

export type ChatMetadataReadParams = {
  agentId: string;
  sessionKey?: string;
  sessionEntry?: ChatMetadataSessionEntry;
};

export type ChatMetadataResult = {
  commands?: unknown[];
  models?: ModelChoice[];
  swarmEnabled: boolean;
};
