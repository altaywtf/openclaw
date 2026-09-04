// Shared helpers for comparing session rows against list defaults.
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { buildQualifiedChatModelValue } from "./chat/model-ref.ts";

type SessionModelFields = Pick<GatewaySessionRow, "agentRuntime" | "model" | "modelProvider">;

export function sessionModelMatchesDefaults(
  session: SessionModelFields | null | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
): boolean {
  const sessionRuntime = session?.agentRuntime?.id?.trim();
  const defaultRuntime = defaults?.agentRuntime?.id?.trim();
  return (
    ((!session?.model && !session?.modelProvider) ||
      buildQualifiedChatModelValue(session?.model, session?.modelProvider) ===
        buildQualifiedChatModelValue(defaults?.model, defaults?.modelProvider)) &&
    (!sessionRuntime || !defaultRuntime || sessionRuntime === defaultRuntime)
  );
}
