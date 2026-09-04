import { isDeepStrictEqual } from "node:util";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createCodexAttemptPreparationTiming } from "./attempt-preparation-timing.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { synchronizePendingCodexNativeCompaction } from "./compact.js";
import { activateCodexAttemptTurn } from "./run-attempt-active-turn.js";
import { cleanupCodexAttempt } from "./run-attempt-cleanup.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { prepareCodexAttemptContext } from "./run-attempt-context.js";
import { finalizeCodexAttempt } from "./run-attempt-finalize.js";
import { createCodexAttemptLifecycleController } from "./run-attempt-lifecycle-controller.js";
import { createCodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import { prepareCodexAttemptPrompt } from "./run-attempt-prompt.js";
import { prepareCodexAttemptResources } from "./run-attempt-resources.js";
import { prepareCodexAttemptRoute } from "./run-attempt-route.js";
import { prepareCodexAttemptRuntime } from "./run-attempt-runtime.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { startCodexAttemptRuntime } from "./run-attempt-start.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import { prepareCodexAttemptTurnRequest } from "./run-attempt-turn-request.js";
import { startCodexAttemptTurn } from "./run-attempt-turn-start.js";
import { createCodexAttemptTurnState } from "./run-attempt-turn-state.js";
import type { CodexRunAttemptOptions } from "./run-attempt-types.js";
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";
import { retireCodexAppServerSessionGeneration } from "./session-retirement.js";

async function retryPendingCodexNativeCompaction(
  connection: Awaited<ReturnType<typeof prepareCodexAttemptConnection>>,
): Promise<"continue" | "reprepare" | "reprepare_after_nonapply"> {
  const { bindingIdentity, bindingStore, mutable, nativeToolSurfaceEnabled, options, params } =
    connection;
  const pendingBinding = mutable.startupBinding;
  if (pendingBinding?.nativeCompactionSyncPending !== true) {
    return "continue";
  }
  const outcome = await synchronizePendingCodexNativeCompaction(
    {
      ...params,
      model: params.modelId,
      trigger:
        params.trigger === "manual" || params.trigger === "overflow" ? params.trigger : undefined,
      senderId: params.senderId ?? undefined,
      senderName: params.senderName ?? undefined,
      senderUsername: params.senderUsername ?? undefined,
      senderE164: params.senderE164 ?? undefined,
      nativeToolSurface: nativeToolSurfaceEnabled ? "unrestricted" : "host-isolated",
    },
    {
      bindingStore,
      pluginConfig: options.pluginConfig,
      ...(options.clientFactory ? { clientFactory: options.clientFactory } : {}),
      allowNonManualNativeRequest: true,
      nativeCompactionRequest: "required_preflight",
      expectedBinding: pendingBinding,
    },
  );
  const currentBinding = bindingStore.read(bindingIdentity);
  mutable.startupBinding = currentBinding;
  mutable.startupContextTokens = undefined;
  if (outcome.kind === "synchronized" || outcome.kind === "deferred_for_transient_restriction") {
    return "continue";
  }
  params.abortSignal?.removeEventListener("abort", connection.abortFromUpstream);
  if (outcome.kind === "binding_changed" || !isDeepStrictEqual(currentBinding, outcome.binding)) {
    return "reprepare";
  }
  if (outcome.kind === "retry_pending") {
    throw new Error(
      "Codex native compaction retry remains pending before turn/start. Retry the turn after native compaction becomes available.",
    );
  }
  assertCodexBindingMayBeReplaced(
    outcome.binding,
    outcome.kind === "stale_thread"
      ? "recovering stale native compaction history"
      : "rotating a thread whose persisted restrictions prohibit native compaction",
    params.expectedSessionRuntimeOwnership,
  );
  if (bindingIdentity.kind !== "session") {
    throw new Error("Codex native compaction recovery requires a session binding");
  }
  const retirement = await retireCodexAppServerSessionGeneration({
    bindingStore,
    identity: bindingIdentity,
    mode: "reset",
    config: params.config,
    storePath: params.sessionTarget?.storePath,
    expectedBinding: outcome.binding,
  });
  return retirement === "applied" ? "reprepare" : "reprepare_after_nonapply";
}

export async function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParamsV2,
  options: CodexRunAttemptOptions,
): Promise<EmbeddedRunAttemptResult> {
  const preparation = createCodexAttemptPreparationTiming(params);
  let connection: Awaited<ReturnType<typeof prepareCodexAttemptConnection>>;
  for (let repreparations = 0; ; repreparations += 1) {
    connection = await preparation.measure("connection", () =>
      prepareCodexAttemptConnection({ params, options }),
    );
    let preflight: Awaited<ReturnType<typeof retryPendingCodexNativeCompaction>>;
    try {
      preflight = await preparation.measure("native-compaction-sync", () =>
        retryPendingCodexNativeCompaction(connection),
      );
    } catch (error) {
      params.abortSignal?.removeEventListener("abort", connection.abortFromUpstream);
      throw error;
    }
    if (preflight === "continue") {
      break;
    }
    if (repreparations >= 2) {
      throw new Error(
        "Codex binding changed repeatedly during native compaction recovery after 2 repreparations",
      );
    }
  }
  const runtime = await preparation.measure("runtime", () =>
    prepareCodexAttemptRuntime(connection),
  );
  const attemptTools = await preparation.measure("tools", () => prepareCodexAttemptTools(runtime));
  const attemptContext = await preparation.measure("context", () =>
    prepareCodexAttemptContext(runtime, attemptTools),
  );
  const attemptPrompt = await preparation.measure("prompt", () =>
    prepareCodexAttemptPrompt(attemptContext),
  );
  const resources = prepareCodexAttemptResources(attemptPrompt);
  attemptTools.runtimeYieldCompletionClaim.current = () =>
    resources.state.nativeHookRelay?.hasClaimedDirectChild() ?? false;
  await preparation.measure("runtime-start", () => startCodexAttemptRuntime(resources));

  const turnRuntime = createCodexAttemptTurnState(resources);
  try {
    const lifecycle = createCodexAttemptLifecycleController(resources, turnRuntime);
    const notifications = createCodexAttemptNotificationController(
      resources,
      turnRuntime,
      lifecycle,
    );
    const serverRequests = createCodexAttemptServerRequestController(
      resources,
      turnRuntime,
      lifecycle,
    );
    const { ensureCurrentThreadRoute } = await preparation.measure("thread-route", () =>
      prepareCodexAttemptRoute(
        resources,
        turnRuntime,
        notifications,
        serverRequests.handleServerRequest,
      ),
    );
    const turnRequest = await preparation.measure("turn-request", () =>
      prepareCodexAttemptTurnRequest(
        resources,
        turnRuntime,
        ensureCurrentThreadRoute,
        notifications.waitForActiveNativeTurnCompletion,
      ),
    );
    preparation.ready();
    const turnStart = await startCodexAttemptTurn(
      resources,
      turnRuntime,
      notifications,
      turnRequest,
    );
    if ("result" in turnStart) {
      return turnStart.result;
    }
    const activeTurn = activateCodexAttemptTurn(
      resources,
      turnRuntime,
      lifecycle,
      notifications,
      turnStart.turn,
    );
    let finalizedResult: EmbeddedRunAttemptResult;
    try {
      await activeTurn.ready;
      finalizedResult = await finalizeCodexAttempt(
        resources,
        turnRuntime,
        lifecycle,
        notifications,
        turnRequest,
        activeTurn,
      );
    } finally {
      await cleanupCodexAttempt(resources, turnRuntime, lifecycle, turnRequest, activeTurn);
    }
    // Cleanup retires the execution lease; only then can device loss no longer
    // race the final result captured during asynchronous terminal processing.
    if (
      resources.state.executionDisconnectError &&
      !connection.terminalState.explicitCancellationObserved
    ) {
      throw resources.state.executionDisconnectError;
    }
    return finalizedResult;
  } finally {
    turnRuntime.deadlines.dispose();
  }
}
