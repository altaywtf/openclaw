import { shouldForwardModelCommandToServer } from "../../../../src/auto-reply/commands-registry.shared.js";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import type { parseSlashCommand } from "../../lib/chat/commands.ts";
import { extractCompanionCommandQuestion } from "../../lib/chat/companion-question.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import {
  protectPendingChatOutboxAdmission,
  updatePendingChatOutboxAdmission,
} from "../../lib/chat/outbox-metadata-store.runtime.ts";
import { outboxPayloadTab } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  dispatchChatSlashCommand,
  requireChatSessionAction,
  shouldQueueLocalSlashCommand,
} from "./chat-commands.ts";
import {
  admitQueuedMessageForSession,
  enqueueChatMessage,
  excludeComposerAttachments,
  keepVolatileQueuedMessage,
  removeQueuedMessageWithoutReleasing,
} from "./chat-queue.ts";
import { isTerminalFailureChatSendAck } from "./chat-send-ack.ts";
import { sendChatMessageWithGeneratedRunId } from "./chat-send-actions.ts";
import {
  captureChatCommandComposerRecovery,
  clearOwnedCommandComposerFallback,
  commandComposerFallbackRetainsAttachments,
  restoreFailedCommandComposer,
  submittedCommandConnectionIsCurrent,
  submittedCommandScopeIsVisible,
  type ChatCommandComposerRecovery,
} from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatOutboxDrainDependencies, deliverChatQueueItem } from "./chat-send-delivery.ts";
import {
  reconnectSafeQueuedSendState,
  setChatError,
  waitForPendingChatSettings,
} from "./chat-send-queue-state.ts";
import {
  clearSubmittedComposerState,
  isChatResetCommand,
  ownsSubmittedComposerState,
} from "./chat-send-snapshot.ts";
import {
  chatSendHoldReason,
  formatTerminalChatSendAckError,
  OFFLINE_QUEUE_STORAGE_ERROR,
} from "./chat-send-support.ts";
import { getPendingChatPickerPatch } from "./chat-session.ts";
import { withChatSubmitGuard } from "./chat-submit-guard.ts";
import {
  recordNonTranscriptInputHistory,
  resetChatInputHistoryNavigation,
} from "./input-history.ts";
import {
  handleAbortChat,
  hasAbortableSessionRun,
  isChatBusy,
  isChatStopCommand,
} from "./run-lifecycle.ts";

type LocalCommandParams = {
  attachments: ChatAttachment[];
  credentialOwnerIsCurrent: () => boolean;
  deliveredAttachments: ChatAttachment[];
  hasAttachments: boolean;
  message: string;
  messageOverride?: string;
  onRejected?: () => void;
  parsed: ReturnType<typeof parseSlashCommand>;
  previousDraft: string;
  previousMentions?: readonly HumanMention[];
  restoreDraft?: boolean;
  sessionKey: string;
  submitKey: (kind: "detached" | "local", message: string, attachments: ChatAttachment[]) => string;
  userMessage: string;
};

export function shouldHandleLocalChatCommand(
  host: ChatHost,
  params: Pick<LocalCommandParams, "hasAttachments" | "parsed" | "userMessage">,
): boolean {
  const { hasAttachments, parsed, userMessage } = params;
  if (
    isChatStopCommand(userMessage) &&
    (userMessage.startsWith("/") || hasAbortableSessionRun(host))
  ) {
    return true;
  }
  if (/^\/(?:btw|side)(?::|\s|$)/i.test(userMessage)) {
    return true;
  }
  if (
    host.connected &&
    parsed?.args === "" &&
    parsed.command.clientPresentation?.when === "no-arguments" &&
    !hasAttachments &&
    host.chatReplyTarget == null &&
    host.dispatchClientPresentation
  ) {
    return true;
  }
  if (parsed?.command.key === "approve" && isChatBusy(host)) {
    return true;
  }
  const forwardsModelCommand =
    parsed?.command.key === "model" && shouldForwardModelCommandToServer(parsed.args);
  return Boolean(parsed?.command.executeLocal && !forwardsModelCommand);
}

export async function handleLocalChatCommand(
  host: ChatHost,
  params: LocalCommandParams,
): Promise<boolean> {
  const {
    attachments,
    deliveredAttachments,
    hasAttachments,
    message,
    messageOverride,
    parsed,
    previousDraft,
    previousMentions,
    sessionKey,
    userMessage,
  } = params;
  if (
    isChatStopCommand(userMessage) &&
    (userMessage.startsWith("/") || hasAbortableSessionRun(host))
  ) {
    if (host.connected && !requireChatSessionAction(host, "abort")) {
      return true;
    }
    host.chatRunError = null;
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, userMessage);
    }
    await handleAbortChat(host);
    return true;
  }

  host.chatRunError = null;
  if (/^\/(?:btw|side)(?::|\s|$)/i.test(userMessage)) {
    const question = extractCompanionCommandQuestion(userMessage);
    if (!question) {
      return true;
    }
    await withChatSubmitGuard(host, params.submitKey("local", message, []), async () => {
      if (messageOverride == null) {
        recordNonTranscriptInputHistory(host, userMessage);
        if (host.chatMessage === previousDraft) {
          host.chatMessage = "";
          host.chatMentions = [];
          resetChatInputHistoryNavigation(host);
        }
      }
      await host.openSessionCompanion?.(question);
    });
    return true;
  }

  const clientPresentation = parsed?.command.clientPresentation;
  const dispatchClientPresentation = host.dispatchClientPresentation;
  if (
    host.connected &&
    parsed?.args === "" &&
    clientPresentation?.when === "no-arguments" &&
    !hasAttachments &&
    host.chatReplyTarget == null &&
    dispatchClientPresentation
  ) {
    const result = await withChatSubmitGuard(
      host,
      params.submitKey("local", message, []),
      async () => {
        if (host.sessionKey !== sessionKey) {
          return "not-handled" as const;
        }
        let handled = false;
        try {
          handled = await dispatchClientPresentation(clientPresentation.action);
        } catch {
          // Presentation failures retain the established remote command path.
        }
        if (!handled) {
          return "not-handled" as const;
        }
        if (host.sessionKey !== sessionKey) {
          return "handled" as const;
        }
        if (messageOverride == null) {
          clearSubmittedComposerState(host, previousDraft, attachments, previousMentions);
          recordNonTranscriptInputHistory(host, message);
        }
        return "handled" as const;
      },
    );
    if (result !== "not-handled") {
      return true;
    }
  }

  if (parsed?.command.key === "approve" && isChatBusy(host)) {
    await withChatSubmitGuard(
      host,
      params.submitKey("detached", message, attachments),
      async () => {
        if (!(await waitForSubmittedRoute(host, sessionKey, params.credentialOwnerIsCurrent))) {
          return;
        }
        const cleared =
          messageOverride == null
            ? clearSubmittedComposerState(host, previousDraft, attachments, previousMentions, true)
            : {};
        if (messageOverride == null) {
          recordNonTranscriptInputHistory(host, userMessage);
        }
        const recoveryScope = resolveUiConversationIdentity(host, sessionKey);
        await sendDetachedCommandMessage(host, message, {
          attachments: deliveredAttachments.length ? deliveredAttachments : undefined,
          recovery: captureChatCommandComposerRecovery(
            host,
            recoveryScope,
            cleared.previousDraft === undefined
              ? undefined
              : {
                  draft: cleared.previousDraft,
                  mentions: cleared.previousMentions,
                  attachments: cleared.previousAttachments ?? [],
                },
          ),
        });
      },
    );
    return true;
  }

  const forwardsModelCommand =
    parsed?.command.key === "model" && shouldForwardModelCommandToServer(parsed.args);
  if (!parsed?.command.executeLocal || forwardsModelCommand) {
    return false;
  }
  if (shouldQueueLocalSlashCommand(parsed.command.key)) {
    const holdReason = chatSendHoldReason(host, sessionKey);
    if (holdReason) {
      setChatError(host, holdReason);
      return true;
    }
    await withChatSubmitGuard(host, params.submitKey("local", message, attachments), async () => {
      const admission = captureChatOutboxAdmission(host, sessionKey);
      try {
        await outboxPayloadTab();
      } catch {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      if (host.sessionKey !== sessionKey || !params.credentialOwnerIsCurrent()) {
        return;
      }
      const queued = enqueueChatMessage(
        host,
        message,
        isChatResetCommand(message),
        { args: parsed.args, name: parsed.command.key },
        resolveCurrentUserIdentity(host.hello, host.client?.instanceId, host.selfUser) ?? undefined,
      );
      if (!queued) {
        return;
      }
      const releasePendingProtection = protectPendingChatOutboxAdmission(
        host,
        admission.scope,
        queued,
      );
      if (!releasePendingProtection) {
        await removeQueuedMessageWithoutReleasing(host, queued.id);
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      if (
        messageOverride == null &&
        ownsSubmittedComposerState(host, previousDraft, attachments, previousMentions)
      ) {
        recordNonTranscriptInputHistory(host, userMessage);
        host.chatMessage = "";
        host.chatMentions = [];
        resetChatInputHistoryNavigation(host);
      }
      queued.sendState = reconnectSafeQueuedSendState(host);
      if (!(await admitQueuedMessageForSession(host, admission, queued))) {
        const canRestoreComposer =
          messageOverride == null &&
          host.sessionKey === sessionKey &&
          !host.chatMessage &&
          host.chatAttachments.length === 0;
        if (canRestoreComposer) {
          await removeQueuedMessageWithoutReleasing(host, queued.id);
          host.chatMessage = previousDraft;
          host.chatMentions = previousMentions ?? [];
          host.chatAttachments = attachments;
        } else {
          queued.sendState = "failed";
          queued.sendError = OFFLINE_QUEUE_STORAGE_ERROR;
          keepVolatileQueuedMessage(host, sessionKey, queued, queued.agentId, { retryable: true });
          updatePendingChatOutboxAdmission(queued);
        }
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      releasePendingProtection();
      await deliverChatQueueItem(host, queued, { routingSessionKey: sessionKey });
    });
    return true;
  }

  const waitsForPicker = parsed.command.key === "redirect";
  const dispatchLocalCommand = async () => {
    if (
      waitsForPicker &&
      !(await waitForSubmittedRoute(host, sessionKey, params.credentialOwnerIsCurrent))
    ) {
      return;
    }
    let previousComposerDraft = messageOverride == null ? previousDraft : undefined;
    let recoveryComposer:
      | { draft: string; mentions?: readonly HumanMention[]; attachments: ChatAttachment[] }
      | undefined;
    const recoveryScope = resolveUiConversationIdentity(host, sessionKey);
    if (messageOverride == null) {
      recordNonTranscriptInputHistory(host, userMessage);
      if (waitsForPicker) {
        const cleared = clearSubmittedComposerState(
          host,
          previousDraft,
          attachments,
          previousMentions,
        );
        previousComposerDraft = cleared.previousDraft;
        if (cleared.previousDraft !== undefined) {
          recoveryComposer = {
            draft: cleared.previousDraft,
            mentions: cleared.previousMentions,
            attachments: cleared.previousAttachments ?? [],
          };
        }
      } else {
        recoveryComposer = {
          draft: previousDraft,
          mentions: previousMentions,
          attachments: parsed.command.key === "export-session" ? [] : attachments,
        };
        host.chatMessage = "";
        host.chatMentions = [];
        if (parsed.command.key !== "export-session") {
          host.chatAttachments = [];
        }
        resetChatInputHistoryNavigation(host);
      }
    }
    const recovery = captureChatCommandComposerRecovery(host, recoveryScope, recoveryComposer);
    const result = await dispatchChatSlashCommand(host, parsed.command.key, parsed.args, {
      previousDraft: previousComposerDraft,
      restoreDraft: Boolean(messageOverride && params.restoreDraft),
      sendResetMessage: (resetMessage, resetOpts) =>
        chatOutboxDrainDependencies.sendResetSlashCommand(host, resetMessage, resetOpts),
    });
    if (
      result === "failed" &&
      (messageOverride != null || submittedCommandScopeIsVisible(host, recovery))
    ) {
      params.onRejected?.();
    }
    if (result === "failed" || result === "cancelled") {
      if (!restoreFailedCommandComposer(host, recovery)) {
        releaseChatAttachmentPayloads(
          excludeComposerAttachments(host, recovery.composer?.attachments),
        );
      }
      return;
    }
    if (result === "completed") {
      if (submittedCommandConnectionIsCurrent(host, recovery)) {
        clearOwnedCommandComposerFallback(host, recovery);
      }
      if (!commandComposerFallbackRetainsAttachments(host, recovery)) {
        releaseChatAttachmentPayloads(
          excludeComposerAttachments(host, recovery.composer?.attachments),
        );
      }
    }
  };
  if (waitsForPicker) {
    await withChatSubmitGuard(
      host,
      params.submitKey("local", message, attachments),
      dispatchLocalCommand,
    );
  } else {
    await dispatchLocalCommand();
  }
  return true;
}

async function waitForSubmittedRoute(
  host: ChatHost,
  sessionKey: string,
  credentialOwnerIsCurrent: () => boolean,
): Promise<boolean> {
  const pending = getPendingChatPickerPatch(host, sessionKey);
  if (pending && !(await waitForPendingChatSettings(host, sessionKey, pending))) {
    return false;
  }
  return host.sessionKey === sessionKey && credentialOwnerIsCurrent();
}

async function sendDetachedCommandMessage(
  host: ChatHost,
  message: string,
  opts: {
    attachments?: ChatAttachment[];
    recovery: ChatCommandComposerRecovery;
    runId?: string;
  },
): Promise<void> {
  const ack = await sendChatMessageWithGeneratedRunId(host, message, opts.attachments, {
    canApplyError: () => submittedCommandScopeIsVisible(host, opts.recovery),
    runId: opts.runId,
  });
  const sendAck = ack && !("kind" in ack) ? ack : null;
  const ok =
    sendAck?.status === "ok" || sendAck?.status === "started" || sendAck?.status === "in_flight";
  if (!ok && !restoreFailedCommandComposer(host, opts.recovery)) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts.attachments));
  }
  if (
    isTerminalFailureChatSendAck(sendAck) &&
    submittedCommandScopeIsVisible(host, opts.recovery)
  ) {
    setChatError(host, formatTerminalChatSendAckError(sendAck, "detached"));
  }
  if (ok) {
    if (submittedCommandConnectionIsCurrent(host, opts.recovery)) {
      clearOwnedCommandComposerFallback(host, opts.recovery);
    }
    if (!commandComposerFallbackRetainsAttachments(host, opts.recovery)) {
      releaseChatAttachmentPayloads(excludeComposerAttachments(host, opts.attachments));
    }
  }
}
