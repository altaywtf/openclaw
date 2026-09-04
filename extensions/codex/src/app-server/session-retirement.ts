import { isDeepStrictEqual } from "node:util";
import type {
  AgentHarnessSessionDeletionMutation,
  AgentHarnessSessionDeletionParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isIncognitoSessionKey } from "../incognito-session.js";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  releaseCodexAppServerLiveThread,
} from "./client-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  reconcileCurrentCodexSessionGeneration,
  sessionBindingIdentity,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
  type CodexSessionGenerationRetirementResult,
} from "./session-binding.js";
import { getCodexSessionInitializationRollback } from "./session-initialization.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";
import {
  isSameCodexAppServerThreadOwner,
  withCodexAppServerThreadMutation,
} from "./thread-ownership.js";

async function releaseSessionSubscription(
  client: NonNullable<ReturnType<typeof retainSharedCodexAppServerClientByInstanceId>>["client"],
  binding: CodexAppServerThreadBinding,
  sessionKey: string | undefined,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  // End child ownership before the parent subscription, so late completions
  // cannot deliver into a replacement OpenClaw session generation.
  codexNativeSubagentMonitorRuntime.retireParent(client, binding.threadId);
  const released = await releaseCodexAppServerLiveThread(client, binding.threadId, assertCurrent);
  assertCurrent?.();
  if (!released && isIncognitoSessionKey(sessionKey)) {
    const unsubscribed = await unsubscribeCodexThreadBestEffort(client, {
      threadId: binding.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      assertCurrent,
    });
    assertCurrent?.();
    if (!unsubscribed) {
      await closeCodexStartupClientBestEffort(client);
      throw new CodexAppServerUnsafeSubscriptionError(
        `Codex retired session subscription could not be released: ${binding.threadId}`,
      );
    }
  }
}

/** Prepare exact binding deletion before the session owner commits either database. */
export async function withCodexAppServerSessionDeletion<T>(
  bindingStore: CodexAppServerBindingStore,
  params: AgentHarnessSessionDeletionParams,
  run: (mutation: AgentHarnessSessionDeletionMutation) => Promise<T>,
): Promise<T> {
  const { assertCurrent } = params;
  const identity = sessionBindingIdentity(params);
  const remove = async () => {
    const reconciled = await reconcileCurrentCodexSessionGeneration({
      bindingStore,
      identity,
      storePath: params.storePath,
      assertCurrent,
    });
    if (reconciled.kind === "conflict") {
      throw new Error("Codex binding generation changed before session deletion");
    }
    return await bindingStore.withSessionDeletion(
      identity,
      assertCurrent,
      async (binding, mutation) => {
        assertCurrent();
        const rollbackInitialization = getCodexSessionInitializationRollback(
          bindingStore,
          params,
          identity,
          binding,
        );
        if (binding?.connectionScope === "supervision" && !rollbackInitialization) {
          throw new Error(
            "Cannot delete a session while its Codex binding is owned by supervision",
          );
        }
        const clientLease = binding?.clientId
          ? retainSharedCodexAppServerClientByInstanceId(binding.clientId)
          : undefined;
        const assertUnclaimed = () => {
          assertCurrent();
          if (
            clientLease &&
            binding &&
            isCodexAppServerLiveThreadClaimed(clientLease.client, binding.threadId)
          ) {
            throw new Error(
              "Cannot delete a session while its Codex thread is claimed by active work",
            );
          }
        };
        let committed = false;
        try {
          assertUnclaimed();
          return await run({
            commit() {
              assertUnclaimed();
              mutation.commit();
              committed = true;
            },
            rollback() {
              mutation.rollback();
              committed = false;
            },
          });
        } finally {
          try {
            if (committed && rollbackInitialization) {
              assertCurrent();
              await rollbackInitialization();
            }
            // An artifact publication failure after COMMIT still ends this subscription;
            // only the session owner's transaction rollback may restore the binding.
            if (committed && binding && clientLease) {
              await withCodexAppServerThreadMutation(binding.threadId, async () => {
                assertCurrent();
                // Most expired bindings no longer have a live subscription. Only
                // live threads need the persisted-owner check (idle retention is bounded).
                if (
                  !hasCodexAppServerLiveThread(clientLease.client, binding.threadId) &&
                  !isIncognitoSessionKey(params.sessionKey)
                ) {
                  return;
                }
                // The deleted row is absent now. Any surviving owner, including a
                // successor at the same key, keeps its connection-scoped subscription.
                if (await bindingStore.hasOtherThreadOwner(binding.threadId)) {
                  return;
                }
                await releaseSessionSubscription(
                  clientLease.client,
                  binding,
                  params.sessionKey,
                  assertUnclaimed,
                );
              });
            }
          } finally {
            clientLease?.release();
          }
        }
      },
    );
  };
  return params.initialization ? await bindingStore.withThreadArchiveFence(remove) : await remove();
}

/** Retire binding and native subscription under the same generation/physical-client ownership fence. */
export async function retireCodexAppServerSessionGeneration(params: {
  bindingStore: CodexAppServerBindingStore;
  identity: Extract<CodexAppServerBindingIdentity, { kind: "session" }>;
  mode: "reset" | "retire";
  config?: OpenClawConfig;
  storePath?: string;
  expectedBinding?: CodexAppServerThreadBinding;
}): Promise<CodexSessionGenerationRetirementResult> {
  const { bindingStore, identity } = params;
  const retireGeneration = () =>
    params.mode === "reset"
      ? bindingStore.resetSessionGeneration(identity)
      : bindingStore.retireSessionGeneration(identity);
  const { kind, sessionId } = await reconcileCurrentCodexSessionGeneration(params);
  if (kind === "conflict") {
    return "conflict";
  }
  if ((kind === "successor" || kind === "descendant") && sessionId !== identity.sessionId) {
    return "absent";
  }
  const expectedBinding = params.expectedBinding ?? bindingStore.read(identity);
  if (!expectedBinding) {
    // Leasing an absent/retired row manufactures state or rejects its fence;
    // callers need the original absent/conflict result for reset reclamation.
    return await retireGeneration();
  }
  const matchesExpectedBinding = (binding: CodexAppServerThreadBinding | undefined) =>
    binding !== undefined &&
    (params.expectedBinding
      ? isDeepStrictEqual(binding, expectedBinding)
      : isSameCodexAppServerThreadOwner(binding, expectedBinding));
  if (!matchesExpectedBinding(bindingStore.read(identity))) {
    return "conflict";
  }
  return await withCodexAppServerThreadMutation(expectedBinding.threadId, () =>
    bindingStore.withLease(identity, async () => {
      const binding = bindingStore.read(identity);
      if (!matchesExpectedBinding(binding)) {
        return "conflict";
      }
      const result = await retireGeneration();
      if (result !== "applied" || !binding?.clientId) {
        return result;
      }

      // Locate the original physical client only after its exact binding was
      // retired; delayed reset events must never unsubscribe a newer generation.
      const clientLease = retainSharedCodexAppServerClientByInstanceId(binding.clientId);
      if (!clientLease) {
        return result;
      }
      try {
        await releaseSessionSubscription(clientLease.client, binding, identity.sessionKey);
      } finally {
        clientLease.release();
      }
      return result;
    }),
  );
}
