import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { ReplyDispatchReceipt } from "./reply-dispatcher.types.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export type BackgroundTurnPolicy = Pick<
  RunEmbeddedAgentParams,
  | "terminalReplyExpectation"
  | "jobId"
  | "scheduledToolPolicy"
  | "scheduledRuntimeAuthority"
  | "scheduledRuntimeAuthorityRecoveryRequired"
> & {
  trigger: "background" | "cron";
  model?: string;
  thinking?: string;
  fallbacks?: string[];
  timeoutSeconds?: number;
  lightContext?: boolean;
  toolsAllow?: string[];
};

export type BackgroundTurnParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  prompt: string;
  source: InputProvenance;
  deliveryContext: DeliveryContext | undefined;
  policy: BackgroundTurnPolicy;
  signal?: AbortSignal;
  expectedSessionId?: string;
  /** Synchronous caller-owned assertion/claim after session ownership, before side effects. */
  claim?: (
    operation: ReplyOperation,
    storePath?: string,
    databaseClaim?: OpenClawAgentDatabaseClaim,
  ) => void;
  /** Canonical agent-run start; does not mean that a reply was delivered. */
  onStarted?: (runId: string) => void;
};

export type BackgroundTurnResult =
  | {
      status: "skipped";
      reason: string;
      executionStarted: false;
      durationMs: number;
    }
  | {
      status: "settled";
      executionStarted: boolean;
      execution: "ok" | "failed" | "cancelled" | "superseded" | "not-run";
      delivery?: ReplyDispatchReceipt;
      outputText?: string;
      error?: string;
      durationMs: number;
    };
