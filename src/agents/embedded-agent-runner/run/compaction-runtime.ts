import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import {
  withOwnedSessionTranscriptWrites,
  SessionTranscriptWriterClaimReboundError,
} from "../../../config/sessions/transcript-write-context.js";
import {
  bindContextEngineCompaction,
  inheritRuntimeCompactionDelegate,
} from "../../../context-engine/compaction-watchdog.js";
import type { resolveContextEngine } from "../../../context-engine/registry.js";
import type { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import {
  resolveCompactionSuccessorTranscript,
  type ContextEngineSessionTarget,
} from "../../../context-engine/types.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { listActiveProcessSessionReferences } from "../../bash-process-references.js";
import { resolveProcessToolScopeKey } from "../../bash-process-scope.js";
import { withHarnessContextEngineCompaction } from "../../harness/compaction.js";
import type { AgentHarnessContextEngineCompactionTransaction } from "../../harness/types.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { buildEmbeddedCompactionRuntimeContext } from "../compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../compaction-safety-timeout.js";
import {
  acceptCompactionSuccessor,
  resolveContextEngineCompactionSuccessor,
  type AcceptedCompactionSuccessor,
} from "../compaction-successor.js";
import { resolveContextEngineCapabilities } from "../context-engine-capabilities.js";
import { log } from "../logger.js";
import { mergeUsageIntoAccumulator, type UsageAccumulator } from "../usage-accumulator.js";
import { attachCompactionAccountingRecorder } from "./compaction-accounting-bridge.js";
import type { EmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { buildContextEngineCompactionSessionTarget } from "./session-bootstrap.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

type ContextEngine = Awaited<ReturnType<typeof resolveContextEngine>>;
type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;
type CompactionResult = Awaited<ReturnType<ContextEngine["compact"]>>;
type CompactionRuntime = ReturnType<typeof createEmbeddedRunCompactionRuntime>;

export type EmbeddedRunCompactionRecoveryInput = CompactionRuntime & {
  runParams: RunEmbeddedAgentParams;
  state: EmbeddedRunContextRecoveryState;
  contextEngine: ContextEngine;
  contextTokenBudget?: number;
  genericCompactionRecoveryAllowed: boolean;
  attempt: EmbeddedRunAttemptResult;
  runtimeAuthPlan: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["runtimeAuthPlan"];
  resolvedSessionKey: string;
  sessionAgentId: string;
  contextEngineAgentId?: string;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  modelId: string;
  harnessRuntime: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  thinkLevel: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  authProfileId?: string;
  authProfileIdSource: "auto" | "user";
  resolveContextEnginePluginId: () => string | undefined;
  buildRuntimeSettings: (settings: {
    tokenBudget?: number | null;
    degradedReason?: string | null;
  }) => ReturnType<typeof buildContextEngineRuntimeSettings>;
  prepareCompactedTranscriptRetry: (assertActive: () => void) => Promise<void>;
  armPostCompactionGuard: () => void;
  usageAccumulator: UsageAccumulator;
};

/** Preserve one prepared owner snapshot for both timeout and overflow recovery. */
export async function compactEmbeddedRunForRecovery(
  input: EmbeddedRunCompactionRecoveryInput,
  recovery: {
    tokenBudget: number;
    trigger: "overflow" | "timeout_recovery";
    diagId: string;
    attempt: number;
    maxAttempts: number;
    currentTokenCount?: number;
  },
) {
  const { runParams } = input;
  const owner = input.prepareRecoveryOwner();
  const activeSession = owner.session;
  const reason = recovery.trigger === "overflow" ? "overflow recovery" : "timeout recovery";
  await input.runOwnsCompactionBeforeHook(reason);
  owner.assertActive();
  const runtimeContext = {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: runParams.sessionKey,
      sandboxSessionKey: runParams.sandboxSessionKey,
      sandboxAgentId: runParams.sandboxAgentId,
      messageChannel: runParams.messageChannel,
      messageProvider: runParams.messageProvider,
      clientCaps: runParams.clientCaps,
      chatType: runParams.chatType,
      agentAccountId: runParams.agentAccountId,
      conversationRoutePeerId: runParams.conversationRoutePeerId,
      currentChannelId: runParams.currentChannelId,
      currentThreadTs: runParams.currentThreadTs,
      currentMessageId: runParams.currentMessageId,
      authProfileId: input.authProfileId,
      authProfileIdSource: input.authProfileIdSource,
      runtimeAuthPlan: input.runtimeAuthPlan,
      workspaceDir: input.workspaceDir,
      bootstrapWorkspaceDir: runParams.bootstrapWorkspaceDir,
      permissionMode: runParams.permissionMode,
      sessionRoot: runParams.sessionRoot,
      agentDir: input.agentDir,
      config: runParams.config,
      toolOverrides: runParams.toolOverrides,
      toolsAllow: runParams.toolsAllow,
      skillsSnapshot: runParams.skillsSnapshot,
      senderId: runParams.senderId,
      provider: input.provider,
      modelId: input.modelId,
      harnessRuntime: input.harnessRuntime,
      modelSelectionLocked: runParams.modelSelectionLocked,
      modelFallbacksOverride: runParams.modelFallbacksOverride,
      thinkLevel: input.thinkLevel,
      reasoningLevel: runParams.reasoningLevel,
      execOverrides: runParams.execOverrides,
      bashElevated: runParams.bashElevated,
      extraSystemPrompt: runParams.extraSystemPrompt,
      sourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,
      ownerNumbers: runParams.ownerNumbers,
      activeProcessSessions: listActiveProcessSessionReferences({
        scopeKey: resolveProcessToolScopeKey({
          sessionKey: runParams.sandboxSessionKey?.trim() || runParams.sessionKey,
          sessionId: activeSession.id,
          agentId: input.sessionAgentId,
        }),
      }),
    }),
    ...resolveContextEngineCapabilities({
      config: runParams.config,
      sessionKey: runParams.sessionKey,
      explicitAgentId: input.contextEngineAgentId,
      contextEnginePluginId: input.resolveContextEnginePluginId(),
      purpose:
        recovery.trigger === "overflow"
          ? "context-engine.overflow-compaction"
          : "context-engine.timeout-compaction",
    }),
    onCompactionHookMessages: input.onCompactionHookMessages,
    ...(input.attempt.promptCache ? { promptCache: input.attempt.promptCache } : {}),
    runId: runParams.runId,
    trigger: recovery.trigger,
    ...(recovery.currentTokenCount !== undefined
      ? { currentTokenCount: recovery.currentTokenCount }
      : {}),
    diagId: recovery.diagId,
    attempt: recovery.attempt,
    maxAttempts: recovery.maxAttempts,
  };
  let observedCompactions = 0;
  const runtimeSettings = input.buildRuntimeSettings({
    tokenBudget: recovery.tokenBudget,
    ...(recovery.trigger === "overflow" ? { degradedReason: "context_overflow" } : {}),
  });
  const compactParams: Parameters<ContextEngine["compact"]>[0] = {
    sessionId: activeSession.id,
    sessionKey: input.resolvedSessionKey,
    agentId: input.sessionAgentId,
    sessionTarget: buildContextEngineCompactionSessionTarget({
      agentId: input.sessionAgentId,
      config: runParams.config,
      sessionFile: activeSession.file,
      sessionId: activeSession.id,
      sessionKey: input.resolvedSessionKey,
      sessionTarget: activeSession.target,
    }),
    tokenBudget: recovery.tokenBudget,
    ...(recovery.currentTokenCount !== undefined
      ? { currentTokenCount: recovery.currentTokenCount }
      : {}),
    force: true,
    compactionTarget: "budget",
    runtimeContext,
    runtimeSettings,
  };
  const runRecoveryCompaction = async (
    harnessTransaction?: AgentHarnessContextEngineCompactionTransaction,
  ) => {
    let compactionResult: CompactionResult;
    try {
      const compact = bindContextEngineCompaction(input.contextEngine);
      compactionResult = await compactContextEngineWithSafetyTimeout(
        {
          info: input.contextEngine.info,
          compact: inheritRuntimeCompactionDelegate(compact, (backendParams) =>
            owner.withTranscriptWrites(backendParams.abortSignal, async () => {
              // The watchdog may copy runtimeContext to install its progress callback.
              // Attach private facts to the object the delegate actually receives.
              const restoreRecorder = backendParams.runtimeContext
                ? attachCompactionAccountingRecorder(backendParams.runtimeContext, {
                    memoryTranscript: owner.sessionManager
                      ? {
                          sessionManager: owner.sessionManager,
                          sessionTarget: activeSession.target,
                          assertActive: () => {
                            backendParams.abortSignal?.throwIfAborted();
                            owner.assertActive();
                          },
                        }
                      : undefined,
                    recordUsage: (usage) =>
                      mergeUsageIntoAccumulator(input.usageAccumulator, usage),
                    recordCompaction: (tokensAfter) => {
                      observedCompactions += 1;
                      input.state.observeContextAccounting({ kind: "compaction", tokensAfter });
                    },
                    onCompactionCommitted: () => harnessTransaction?.markProducerCommitted(),
                  })
                : undefined;
              try {
                return await compact(backendParams);
              } finally {
                restoreRecorder?.();
              }
            }),
          ),
        },
        compactParams,
        resolveCompactionTimeoutMs(runParams.config),
        runParams.abortSignal,
      );
    } catch (error) {
      // Only a live owner's backend failure is recoverable. Caller cancellation,
      // replacement, and claim loss must never become a truncation/retry request.
      owner.assertActive();
      log.warn(
        `contextEngine.compact() threw during ${reason} for ${input.provider}/${input.modelId}: ${String(error)}`,
      );
      compactionResult = { ok: false, compacted: false, reason: String(error) };
    }
    if (observedCompactions > 0 && !compactionResult.compacted) {
      // Post-commit failure is not an unperformed compaction. Retry the observed
      // current context, but never adopt a failed backend's successor proposal.
      compactionResult = {
        ok: compactionResult.ok,
        compacted: true,
        reason: compactionResult.reason,
      };
    }
    if (observedCompactions > 0 || (compactionResult.ok && compactionResult.compacted)) {
      harnessTransaction?.markProducerCommitted();
    } else {
      harnessTransaction?.rollbackBeforeProducerCommit();
    }
    const successor = resolveCompactionSuccessorTranscript(compactionResult);
    const target = compactionResult.result?.sessionTarget;
    const sameTarget =
      (!successor.sessionId || successor.sessionId === activeSession.id) &&
      (!successor.sessionFile || successor.sessionFile === activeSession.file) &&
      (!target?.agentId || target.agentId === activeSession.target?.agentId) &&
      (!target?.sessionKey || target.sessionKey === activeSession.target?.sessionKey) &&
      (!target?.storePath || target.storePath === activeSession.target?.storePath);
    const reportedTokens = compactionResult.result?.tokensAfter;
    const tokensAfter =
      typeof reportedTokens === "number" && Number.isFinite(reportedTokens) && reportedTokens >= 0
        ? Math.floor(reportedTokens)
        : undefined;
    const recordTokensAfter = () => {
      input.state.lastCompactionTokensAfter = tokensAfter;
      input.state.currentContextSnapshot = { tokens: tokensAfter };
    };
    if (compactionResult.compacted && observedCompactions === 0) {
      // Opaque engines report completion on return. Stock commits are already
      // recorded before hooks; their late result must not replace a newer context.
      // A proposed successor's token snapshot transfers only on host acceptance.
      input.state.observeContextAccounting({
        kind: "compaction",
        tokensAfter: sameTarget ? tokensAfter : undefined,
      });
    }
    owner.assertActive();
    // Stock compaction already updated this exact buffer; resolving its unchanged
    // portable identity would unnecessarily consult a borrowed durable session.
    const retainMemoryTranscript =
      owner.sessionManager &&
      sameTarget &&
      (target?.threadId === undefined || target.threadId === activeSession.target.threadId);
    const onAccepted = sameTarget ? undefined : recordTokensAfter;
    const adoptedPreviousSessionId =
      compactionResult.ok && compactionResult.compacted && !retainMemoryTranscript
        ? harnessTransaction
          ? await input.adoptCompactionTranscript(compactionResult, onAccepted, harnessTransaction)
          : await input.adoptCompactionTranscript(compactionResult, onAccepted)
        : undefined;
    return { result: compactionResult, previousSessionId: adoptedPreviousSessionId };
  };
  let recoveryResult: Awaited<ReturnType<typeof runRecoveryCompaction>>;
  if (input.harnessRuntime === "openclaw") {
    recoveryResult = await runRecoveryCompaction();
  } else {
    const preparedModelRuntime = input.preparedModelRuntime;
    if (!preparedModelRuntime) {
      throw new Error(
        `Agent harness ${input.harnessRuntime} context-engine compaction owner is unavailable`,
      );
    }
    recoveryResult = await withHarnessContextEngineCompaction({
      harnessRuntime: input.harnessRuntime,
      preparedModelRuntime,
      compaction: {
        agentId: activeSession.target.agentId,
        sessionId: activeSession.id,
        sessionKey: activeSession.target.sessionKey,
        storePath: activeSession.target.storePath,
        requiresNativeCompactionSync: input.contextEngine.info.ownsCompaction === true,
      },
      run: runRecoveryCompaction,
    });
  }
  input.assertRecoveryActive();
  return { ...recoveryResult, runtimeContext, runtimeSettings };
}

export function createEmbeddedRunCompactionRuntime(input: {
  runParams: PreparedEmbeddedRunInput["runParams"];
  contextEngine: ContextEngine;
  hookRunner: PreparedEmbeddedRunInput["hookRunner"];
  hookContext: PreparedEmbeddedRunInput["hookContext"];
  sessionPromptState: SessionPromptState;
}) {
  const { runParams: params, contextEngine, hookRunner, hookContext, sessionPromptState } = input;
  const admittedAssertion = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext)
    : undefined;
  const memoryManager =
    params.sessionManager && !params.sessionManager.getSessionTarget()
      ? params.sessionManager
      : undefined;
  const detached = params.sessionPersistence === "detached";
  const assertAdmittedActive = () => {
    // Preserve the caller's reason before a closed admission can replace it.
    params.abortSignal?.throwIfAborted();
    if (!admittedAssertion) {
      throw new Error("compaction recovery requires an active admitted run");
    }
    admittedAssertion();
  };
  const assertRecoveryTarget = (
    target: ContextEngineSessionTarget | undefined,
    sessionId = sessionPromptState.sessionId,
    writerFence = sessionPromptState.sessionWriterFence,
  ) => {
    assertAdmittedActive();
    if (memoryManager || detached) {
      return;
    }
    const entry =
      target?.sessionKey && target.storePath
        ? loadSessionEntry({
            sessionKey: target.sessionKey,
            storePath: target.storePath,
            readConsistency: "latest",
          })
        : undefined;
    if (
      !writerFence ||
      writerFence.expectedWriterRunId !== params.runId ||
      entry?.sessionId !== sessionId ||
      entry.lifecycleRevision !== writerFence.expectedLifecycleRevision ||
      entry.activeWriterRunId !== writerFence.expectedWriterRunId
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  const assertRecoveryActive = () => assertRecoveryTarget(sessionPromptState.sessionTarget);
  const getPreparedTarget = () => {
    const target = sessionPromptState.sessionTarget;
    if (!target?.agentId || !target.sessionKey || !target.storePath) {
      throw new Error("compaction recovery requires a complete transcript target");
    }
    return {
      ...target,
      agentId: target.agentId,
      sessionId: sessionPromptState.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    };
  };
  const prepareRecoveryOwner = () => {
    assertRecoveryActive();
    const { sessionId, sessionFile, sessionWriterFence: writerFence } = sessionPromptState;
    const target = { ...getPreparedTarget(), ...writerFence };
    const assertActive = () => {
      assertRecoveryTarget(target, sessionId, writerFence);
      const current = sessionPromptState.sessionTarget;
      if (
        sessionPromptState.sessionId !== sessionId ||
        sessionPromptState.sessionFile !== sessionFile ||
        current?.agentId !== target.agentId ||
        current?.sessionKey !== target.sessionKey ||
        current?.storePath !== target.storePath
      ) {
        throw new Error("active session changed after recovery transcript preparation");
      }
    };
    return {
      session: { id: sessionId, file: sessionFile, target },
      ...(memoryManager ? { sessionManager: memoryManager } : {}),
      assertActive,
      withTranscriptWrites: <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => {
        const assertInvocationActive = () => {
          signal?.throwIfAborted();
          assertActive();
        };
        const assertCommitAllowed = () => {
          assertInvocationActive();
          if (detached || memoryManager) {
            throw new Error("detached recovery cannot persist a session transcript");
          }
        };
        // Bind the original owner and the safety wrapper's child signal to every
        // nested write, including callbacks retained beyond the backend result.
        return withOwnedSessionTranscriptWrites(
          {
            sessionTarget: target,
            assertCommitAllowed,
            withTranscriptWrite: async (write) => await write(),
          },
          async () => {
            assertInvocationActive();
            return await run();
          },
        );
      },
    };
  };
  const prepareRecoverySession = () => {
    const owner = prepareRecoveryOwner();
    const sessionManager =
      memoryManager ??
      (detached ? undefined : SessionManager.open(owner.session.target, params.workspaceDir));
    return {
      sessionManager,
      assertActive: owner.assertActive,
      withSessionManagerRewriteLock: <T>(operation: () => Promise<T> | T): Promise<T> =>
        owner.withTranscriptWrites(undefined, async () => {
          if (!sessionManager) {
            throw new Error("detached recovery has no caller-owned transcript to rewrite");
          }
          sessionManager.reloadPersistedTranscript();
          return await operation();
        }),
    };
  };
  const resolveActiveHookContext = () => ({
    ...hookContext,
    sessionId: sessionPromptState.sessionId,
  });
  const adoptCompactionTranscript = async (
    compactResult: CompactionResult,
    onAccepted?: () => void,
    harnessTransaction?: AgentHarnessContextEngineCompactionTransaction,
  ): Promise<string | undefined> => {
    assertRecoveryActive();
    const currentTarget = getPreparedTarget();
    if (memoryManager || detached) {
      const successor = await resolveContextEngineCompactionSuccessor({
        config: params.config,
        currentSessionFile: sessionPromptState.sessionFile,
        currentTarget,
        result: compactResult,
      });
      assertAdmittedActive();
      sessionPromptState.capturePreparedCompactionTarget(successor);
      onAccepted?.();
      sessionPromptState.notifyCompactionSessionAdopted(currentTarget.sessionId);
      assertAdmittedActive();
      return successor.sessionId !== currentTarget.sessionId ? currentTarget.sessionId : undefined;
    }
    const writerFence = sessionPromptState.sessionWriterFence;
    const recordAccepted = (accepted: AcceptedCompactionSuccessor) => {
      sessionPromptState.recordCommittedCompactionSuccessor(accepted);
      onAccepted?.();
    };
    const accepted = await acceptCompactionSuccessor({
      config: params.config,
      currentSessionFile: sessionPromptState.sessionFile,
      currentTarget,
      result: compactResult,
      ...(harnessTransaction ? { harnessTransaction } : {}),
      expectedEntry: {
        sessionId: currentTarget.sessionId,
        lifecycleRevision: writerFence?.expectedLifecycleRevision,
        activeWriterRunId: writerFence?.expectedWriterRunId,
      },
      assertActive: assertAdmittedActive,
      onCommitted: recordAccepted,
    });
    // Unchanged identity has no storage publication, but its validated current
    // row still identifies the already-recorded compaction for accounting.
    if (!accepted.previousSessionId) {
      recordAccepted(accepted);
    }
    assertRecoveryActive();
    sessionPromptState.notifyCompactionSessionAdopted(accepted.previousSessionId);
    assertRecoveryActive();
    return accepted.previousSessionId;
  };
  const onCompactionHookMessages = async (payload: {
    phase: "before" | "after";
    messages: string[];
  }) => {
    const messages = payload.messages.filter((message) => message.trim().length > 0);
    if (messages.length === 0) {
      return;
    }
    assertRecoveryActive();
    await params.onAgentEvent?.({
      stream: "compaction",
      data: {
        phase: payload.phase === "before" ? "start" : "end",
        ...(payload.phase === "after" ? { completed: true } : {}),
        messages,
      },
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
    assertRecoveryActive();
  };
  const runOwnsCompactionBeforeHook = async (reason: string) => {
    assertRecoveryActive();
    if (contextEngine.info.ownsCompaction !== true || !hookRunner?.hasHooks("before_compaction")) {
      return;
    }
    try {
      await hookRunner.runBeforeCompaction(
        { messageCount: -1, sessionFile: sessionPromptState.sessionFile },
        resolveActiveHookContext(),
      );
    } catch (error) {
      assertRecoveryActive();
      log.warn(`before_compaction hook failed during ${reason}: ${String(error)}`);
    }
    assertRecoveryActive();
  };
  const runOwnsCompactionAfterHook = async (
    reason: string,
    compactResult: Awaited<ReturnType<ContextEngine["compact"]>>,
    previousSessionId?: string,
  ) => {
    assertRecoveryActive();
    if (
      contextEngine.info.ownsCompaction !== true ||
      !compactResult.ok ||
      !compactResult.compacted ||
      !hookRunner?.hasHooks("after_compaction")
    ) {
      return;
    }
    try {
      await hookRunner.runAfterCompaction(
        {
          messageCount: -1,
          compactedCount: -1,
          tokenCount: compactResult.result?.tokensAfter,
          sessionFile:
            resolveCompactionSuccessorTranscript(compactResult).sessionFile ??
            sessionPromptState.sessionFile,
          ...(previousSessionId ? { previousSessionId } : {}),
        },
        resolveActiveHookContext(),
      );
    } catch (error) {
      assertRecoveryActive();
      log.warn(`after_compaction hook failed during ${reason}: ${String(error)}`);
    }
    assertRecoveryActive();
  };

  return {
    assertRecoveryActive,
    prepareRecoveryOwner,
    prepareRecoverySession,
    adoptCompactionTranscript,
    onCompactionHookMessages,
    runOwnsCompactionBeforeHook,
    runOwnsCompactionAfterHook,
  };
}
