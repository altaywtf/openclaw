import type { ChatSendIntent } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { normalizeChatFollowUpModeOverride } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, HumanMention } from "../../lib/chat/chat-types.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import type { ControlUiFollowUpMode } from "../../lib/chat/follow-up-mode.ts";
import { trimHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  finishPendingChatOutboxAdmission,
  persistPendingChatOutboxAdmission,
  protectPendingChatOutboxAdmission,
  updatePendingChatOutboxAdmission,
} from "../../lib/chat/outbox-metadata-store.runtime.ts";
import { outboxPayloadTab } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { composeBrowserAnnotationContext } from "./browser-annotation-context.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  admitQueuedMessageForSession,
  keepVolatileQueuedMessage,
  readQueuedMessageById,
  syncVisibleChatQueueProjection,
} from "./chat-queue.ts";
import { handleLocalChatCommand, shouldHandleLocalChatCommand } from "./chat-send-command.ts";
import { cancelChatDelivery } from "./chat-send-composer.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { deliverChatQueueItem } from "./chat-send-delivery.ts";
import {
  canSendVolatileQueueItem,
  createPendingSendMessage,
  publishPendingSendMessage,
  reconnectSafeQueuedSendState,
  setChatError,
} from "./chat-send-queue-state.ts";
import { resolveDisplayedLeafEntryId } from "./chat-send-request.ts";
import {
  captureSubmittedCredentialOwner,
  chatSubmitKey,
  clearSubmittedComposerState,
  isChatResetCommand,
  ownsSubmittedComposerState,
  prependReplyQuote,
  snapshotChatAttachments,
} from "./chat-send-snapshot.ts";
import { chatSendHoldReason, OFFLINE_QUEUE_STORAGE_ERROR } from "./chat-send-support.ts";
import { recordChatSendTiming } from "./chat-send-timing.ts";
import { getPendingChatPickerPatch } from "./chat-session.ts";
import { withChatSubmitGuard, yieldChatSubmitToInput } from "./chat-submit-guard.ts";
import { persistChatComposerState } from "./composer-persistence.ts";
import { recordNonTranscriptInputHistory } from "./input-history.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  outboxPayloadError,
  prepareOutboxPayload,
  retireOutboxPayload,
} from "./outbox-payloads.ts";
import { controlUiNowMs } from "./performance.ts";
import { activeQueuedMessageEdit, retireEditedQueuedMessageSource } from "./queued-message-edit.ts";
import { hasDirectSessionRun, isChatBusy, isChatStopCommand } from "./run-lifecycle.ts";

export type ChatSendSubmitOptions = {
  intent?: ChatSendIntent;
  attachmentsOverride?: readonly ChatAttachment[];
  mentionsOverride?: readonly HumanMention[];
  followUpMode?: ControlUiFollowUpMode;
  /** Only the inline queued-row submit may resume and replace an edited row. */
  resumeQueuedMessageEditId?: string;
  restoreDraft?: boolean;
  /** Lets request-scoped UI actions recover from rejected local commands. */
  onLocalCommandSendRejected?: () => void;
};

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: ChatSendSubmitOptions,
  submissionAction?: Event,
) {
  const previousDraft = host.chatMessage;
  const previousMentions = host.chatMentions?.map((mention) => ({ ...mention }));
  const intent = opts?.intent;
  const rawMessage = messageOverride ?? host.chatMessage;
  const draftMentions = messageOverride == null ? previousMentions : opts?.mentionsOverride;
  const submitted = trimHumanMentions(rawMessage, draftMentions);
  const userMessage = intent ? rawMessage : submitted.text;
  const submittedAtMs = controlUiNowMs();
  const submittedSessionKey = host.sessionKey;
  const submittedClient = host.client;
  const submittedEpoch = host.connectionEpoch;
  const submittedOwnerIsCurrent = captureOutboxPayloadOwner(host);
  const submittedCredentialOwnerIsCurrent = captureSubmittedCredentialOwner(host);
  let expectedLeafEntryId = resolveDisplayedLeafEntryId(host);
  const attachmentsToSend = snapshotChatAttachments(
    messageOverride == null ? host.chatAttachments : (opts?.attachmentsOverride ?? []),
  );
  const hasAttachments = attachmentsToSend.length > 0;
  if (intent) {
    if (draftMentions?.length) {
      setChatError(host, t("chat.mentions.unsupported"));
      return undefined;
    }
    if (!host.connected || !host.client) {
      setChatError(host, t("chat.goals.offline"));
      return undefined;
    }
    if (isChatBusy(host) || hasDirectSessionRun(host)) {
      setChatError(host, t("chat.goals.busy"));
      return undefined;
    }
    if (attachmentsToSend.some((attachment) => attachment.browserAnnotation)) {
      setChatError(host, t("chat.goals.annotationUnsupported"));
      return undefined;
    }
    if (!userMessage.trim()) {
      return undefined;
    }
  }
  const requestedEditId = opts?.resumeQueuedMessageEditId;
  const inlineEdit = requestedEditId ? activeQueuedMessageEdit(host) : null;
  if (requestedEditId != null && inlineEdit?.id !== requestedEditId) {
    return undefined;
  }
  const isInlineEditSubmission = requestedEditId != null && inlineEdit?.id === requestedEditId;
  const submittedInlineEditRevision = isInlineEditSubmission ? inlineEdit.revision : null;
  // Classify the operator's raw row draft before browser annotation context is
  // prepended. Otherwise annotation text can hide /stop, /compact, or a stop
  // alias from the inline-edit command fence.
  const rawParsedCommand = intent ? null : parseSlashCommand(userMessage);
  if (
    submitted.mentions?.length &&
    (rawParsedCommand || /^\/(?:btw|side)(?::|\s|$)/i.test(userMessage))
  ) {
    setChatError(host, t("chat.mentions.unsupported"));
    return undefined;
  }
  if (isInlineEditSubmission && (rawParsedCommand || isChatStopCommand(userMessage))) {
    setChatError(
      host,
      "Queued-row edits cannot run commands or stop aliases. Cancel this edit and send the command from the composer.",
    );
    return undefined;
  }

  // Commands own the raw composer text. Annotation context is model input and must not
  // turn a recognized command into an ordinary message.
  const message =
    rawParsedCommand || intent
      ? userMessage
      : composeBrowserAnnotationContext(userMessage, attachmentsToSend);
  // Slash commands may use ordinary files, but annotations belong to the next model prompt.
  const deliveredAttachments = rawParsedCommand
    ? attachmentsToSend.filter((attachment) => !attachment.browserAnnotation)
    : attachmentsToSend;

  if (!message && !hasAttachments) {
    return undefined;
  }

  if (
    !intent &&
    shouldHandleLocalChatCommand(host, {
      hasAttachments,
      parsed: rawParsedCommand,
      userMessage,
    })
  ) {
    if (
      await handleLocalChatCommand(host, {
        attachments: attachmentsToSend,
        credentialOwnerIsCurrent: submittedCredentialOwnerIsCurrent,
        deliveredAttachments,
        hasAttachments,
        message,
        messageOverride,
        previousMentions,
        onRejected: opts?.onLocalCommandSendRejected,
        parsed: rawParsedCommand,
        previousDraft,
        restoreDraft: opts?.restoreDraft,
        sessionKey: submittedSessionKey,
        submitKey: (kind, commandMessage, commandAttachments) =>
          chatSubmitKey(host, kind, commandMessage, commandAttachments),
        userMessage,
      })
    ) {
      return undefined;
    }
  }
  if (!intent) {
    host.chatRunError = null;
  }

  const replyTarget = isInlineEditSubmission ? null : host.chatReplyTarget;
  // Persisted ids use replyToId; synthetic replies fall back to a quote.
  const replyToId = isInlineEditSubmission
    ? inlineEdit.replyToId
    : replyTarget?.sourceMessageId?.trim() || undefined;
  const quotedMessage =
    replyTarget && !replyToId && !intent ? prependReplyQuote(message, replyTarget) : message;
  // Ambient work context is only for a new model message, never a command, Goal,
  // or queued-row edit (which already contains its original frozen context).
  const workContext =
    !intent && !isInlineEditSubmission && !userMessage.startsWith("/")
      ? host.getWorkContext?.()
      : undefined;
  // The person's words lead. Session titles are derived from the first user
  // message, so a leading reference block would title the conversation after
  // the snapshot instead of what was actually asked.
  const effectiveMessage = workContext ? `${quotedMessage}\n\n${workContext}` : quotedMessage;
  const mentionOffset = quotedMessage.length - userMessage.length;
  const effectiveMentions = submitted.mentions?.map((mention) => ({
    profileId: mention.profileId,
    start: mention.start + mentionOffset,
    end: mention.end + mentionOffset,
  }));

  const refreshSessions = Boolean(intent) || isChatResetCommand(message);
  // A row edit and a composer send may intentionally carry the same payload.
  // Keep their guards independent so submitting one cannot suppress the other.
  const submitKind = requestedEditId ? "queued-edit" : intent ? "goal" : "message";
  const submitKey = chatSubmitKey(
    host,
    submitKind,
    effectiveMessage,
    attachmentsToSend,
    effectiveMentions,
  );
  let accepted = false;
  const submitMessage = async () => {
    if (host.sessionKey !== submittedSessionKey) {
      return;
    }
    const submittedAgentId = scopedAgentIdForSession(host, submittedSessionKey);
    const submissionOwnerIsCurrent = () =>
      host.client === submittedClient &&
      host.connectionEpoch === submittedEpoch &&
      host.sessionKey === submittedSessionKey &&
      visibleSessionMatches(host, submittedSessionKey, submittedAgentId);
    if (!visibleSessionMatches(host, submittedSessionKey, submittedAgentId)) {
      setChatError(host, t("mcpServers.sessionUnavailable"));
      return;
    }
    if (intent && (isChatBusy(host) || hasDirectSessionRun(host))) {
      setChatError(host, t("chat.goals.busy"));
      return;
    }
    // History can await while the operator cancels or changes the row edit.
    // Never admit a replacement captured from a stale row-local draft.
    const resumedEditCandidate = activeQueuedMessageEdit(host);
    if (
      isInlineEditSubmission &&
      (resumedEditCandidate !== inlineEdit ||
        resumedEditCandidate.revision !== submittedInlineEditRevision)
    ) {
      return;
    }
    const holdReason = chatSendHoldReason(host, submittedSessionKey);
    if (holdReason) {
      setChatError(host, holdReason);
      return;
    }
    let pendingSettings = getPendingChatPickerPatch(host, submittedSessionKey);
    let waitingForSettings = Boolean(pendingSettings);
    const directRunActive = hasDirectSessionRun(host);
    // Only an explicit browser override replaces inherited Gateway policy.
    const followUpMode =
      opts?.followUpMode ??
      host.chatFollowUpMode ??
      normalizeChatFollowUpModeOverride(host.settings?.chatFollowUpMode);
    const activeRunQueueMode =
      !intent && directRunActive && followUpMode !== "queue" ? followUpMode : undefined;
    // The edited row hands its place to the replacement and is retired by the same
    // store write, so a rejected write leaves the original queued and editable.
    const resumedEdit =
      requestedEditId && resumedEditCandidate?.id === requestedEditId ? resumedEditCandidate : null;
    const replacement = resumedEdit
      ? {
          id: resumedEdit.id,
          expected: resumedEdit.source,
        }
      : undefined;
    const submission = createPendingSendMessage(
      host,
      effectiveMessage,
      deliveredAttachments.length ? deliveredAttachments : undefined,
      refreshSessions,
      submittedAtMs,
      waitingForSettings ? "waiting-model" : reconnectSafeQueuedSendState(host),
      replyToId,
      resumedEdit?.orderKey,
      activeRunQueueMode,
      intent,
      expectedLeafEntryId,
      effectiveMentions,
    );
    if (!submission) {
      return;
    }
    let queued = submission.item;
    try {
      if (!isInlineEditSubmission && !host.selectedChatSessionIncognito) {
        try {
          await outboxPayloadTab();
        } catch {
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
      }
      if (!submittedCredentialOwnerIsCurrent()) {
        return;
      }
      const pendingProtection = !isInlineEditSubmission
        ? protectPendingChatOutboxAdmission(host, submission.admission.scope, queued)
        : () => undefined;
      if (!pendingProtection) {
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      const releasePendingProtection = pendingProtection;
      // Page shutdown can journal inline attachment bytes synchronously. A native
      // Blob without that snapshot must reach IndexedDB before composer ownership moves.
      const needsNativeAttachmentAdmission = queued.attachments?.some(
        (attachment) => !getChatAttachmentDataUrl(attachment),
      );
      if (needsNativeAttachmentAdmission) {
        const payload = await prepareOutboxPayload(host, queued);
        if (payload.status === "failed") {
          releasePendingProtection();
          setChatError(host, outboxPayloadError(payload.reason));
          return;
        }
        queued = { ...queued, ...payload.update };
        if (!submittedOwnerIsCurrent()) {
          const retained = persistPendingChatOutboxAdmission(queued);
          const composerStillOwned =
            messageOverride == null &&
            ownsSubmittedComposerState(host, previousDraft, attachmentsToSend, previousMentions);
          const clearedPersistedDraft =
            composerStillOwned &&
            persistChatComposerState(
              { ...host, chatAttachments: [], chatMentions: [], chatMessage: "" },
              submittedSessionKey,
            );
          if (retained && clearedPersistedDraft) {
            clearSubmittedComposerState(
              host,
              previousDraft,
              attachmentsToSend,
              previousMentions,
              Boolean(rawParsedCommand),
            );
            recordNonTranscriptInputHistory(host, userMessage);
          }
          if (!retained) {
            retireOutboxPayload(queued);
          }
          return;
        }
        if (!host.selectedChatSessionIncognito && !updatePendingChatOutboxAdmission(queued)) {
          releasePendingProtection();
          retireOutboxPayload(queued);
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
          return;
        }
      }
      const optimisticHandoff = !host.selectedChatSessionIncognito;
      const composerStillOwned =
        messageOverride == null &&
        ownsSubmittedComposerState(host, previousDraft, attachmentsToSend, previousMentions);
      if (
        composerStillOwned &&
        optimisticHandoff &&
        !persistChatComposerState(
          { ...host, chatAttachments: [], chatMentions: [], chatMessage: "" },
          submittedSessionKey,
        )
      ) {
        releasePendingProtection();
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      let cleared =
        composerStillOwned && optimisticHandoff
          ? clearSubmittedComposerState(
              host,
              previousDraft,
              attachmentsToSend,
              previousMentions,
              Boolean(rawParsedCommand),
            )
          : {};
      if (messageOverride == null && optimisticHandoff) {
        recordNonTranscriptInputHistory(host, userMessage);
      }
      if (optimisticHandoff && submissionAction && typeof MessageChannel !== "undefined") {
        // The immutable in-memory row owns the submitted composer immediately.
        // Yield before persistence, history, or attachment work can delay new input.
        await yieldChatSubmitToInput();
      }
      if (!submissionOwnerIsCurrent() || !submittedCredentialOwnerIsCurrent()) {
        if (!persistPendingChatOutboxAdmission(queued)) {
          if (optimisticHandoff && submittedCredentialOwnerIsCurrent()) {
            queued = { ...queued, sendState: "failed", sendError: OFFLINE_QUEUE_STORAGE_ERROR };
            keepVolatileQueuedMessage(host, submittedSessionKey, queued, queued.agentId, {
              retryable: true,
            });
          }
          setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        }
        return;
      }
      if (messageOverride == null && !optimisticHandoff) {
        cleared = clearSubmittedComposerState(
          host,
          previousDraft,
          attachmentsToSend,
          previousMentions,
          Boolean(rawParsedCommand),
        );
        recordNonTranscriptInputHistory(host, userMessage);
      }
      publishPendingSendMessage(host, queued);
      const currentSubmission = () => {
        const current = readQueuedMessageById(host, queued.id);
        return current?.sendRunId === queued.sendRunId ? current : null;
      };
      if (!submissionOwnerIsCurrent() || !currentSubmission()) {
        persistPendingChatOutboxAdmission(queued);
        return;
      }
      if (host.chatLoading) {
        // A terminal event can render before its authoritative leaf arrives.
        // Reuse the in-flight history request before fencing delivery, after input handoff.
        const historyLoaded = await loadChatHistory(host);
        const retainedSubmission = currentSubmission();
        if (!historyLoaded || !submissionOwnerIsCurrent() || !retainedSubmission) {
          if (!retainedSubmission) {
            releasePendingProtection();
            return;
          }
          if (isInlineEditSubmission) {
            await cancelChatDelivery(host, queued, {
              previousDraft: cleared.previousDraft,
              previousAttachments: cleared.previousAttachments,
              previousMentions: cleared.previousMentions,
            });
            releasePendingProtection();
            return;
          }
          const historyError =
            "Chat history could not be refreshed. Review and retry this message.";
          queued = { ...queued, sendError: historyError, sendState: "failed" };
          keepVolatileQueuedMessage(host, submittedSessionKey, queued, queued.agentId, {
            retryable: true,
          });
          await admitQueuedMessageForSession(host, submission.admission, queued);
          setChatError(host, historyError);
          return;
        }
        expectedLeafEntryId = resolveDisplayedLeafEntryId(host);
        queued = { ...queued, expectedLeafEntryId };
        keepVolatileQueuedMessage(host, submittedSessionKey, queued, queued.agentId);
      }
      const currentEdit = activeQueuedMessageEdit(host);
      if (
        isInlineEditSubmission &&
        (currentEdit !== inlineEdit || currentEdit.revision !== submittedInlineEditRevision)
      ) {
        await cancelChatDelivery(host, queued, {});
        return;
      }
      if (queued.attachments?.length) {
        const payload = await prepareOutboxPayload(host, queued);
        if (!currentSubmission()) {
          const pendingItem =
            payload.status === "ready" ? { ...queued, ...payload.update } : queued;
          if (!persistPendingChatOutboxAdmission(pendingItem) && payload.status === "ready") {
            retireOutboxPayload(payload.update);
          }
          return;
        }
        const payloadEdit = activeQueuedMessageEdit(host);
        const editStillOwnsSubmission =
          !isInlineEditSubmission ||
          (payloadEdit === inlineEdit && payloadEdit.revision === submittedInlineEditRevision);
        if (!editStillOwnsSubmission) {
          if (payload.status === "ready") {
            retireOutboxPayload(payload.update);
          }
          return;
        }
        if (payload.status === "failed" || !submittedOwnerIsCurrent()) {
          const reason = payload.status === "failed" ? payload.reason : "unavailable";
          if (payload.status === "ready") {
            retireOutboxPayload(payload.update);
          }
          queued = failOutboxPayload(queued, reason);
          keepVolatileQueuedMessage(host, submittedSessionKey, queued, queued.agentId, {
            retryable: true,
          });
          const admitted = await admitQueuedMessageForSession(
            host,
            submission.admission,
            queued,
            replacement,
          );
          if (!admitted) {
            persistPendingChatOutboxAdmission(queued);
          }
          if (resumedEdit) {
            await retireEditedQueuedMessageSource(host, admitted, queued.attachments, resumedEdit);
          }
          setChatError(host, outboxPayloadError(reason));
          return;
        }
        queued = { ...queued, ...payload.update };
        const hold = chatSendHoldReason(host, submittedSessionKey);
        if (intent && (hold || isChatBusy(host) || hasDirectSessionRun(host))) {
          const error = hold ?? t("chat.goals.busy");
          if (!host.chatMessage && !host.chatAttachments.length) {
            retireOutboxPayload(queued);
            await cancelChatDelivery(host, queued, {
              previousAttachments: cleared.previousAttachments,
              previousDraft: cleared.previousDraft,
              previousMentions: cleared.previousMentions,
            });
            releasePendingProtection();
          } else {
            queued = { ...queued, sendState: "failed", sendError: error };
            keepVolatileQueuedMessage(host, submittedSessionKey, queued, queued.agentId, {
              retryable: true,
            });
            updatePendingChatOutboxAdmission(queued);
          }
          setChatError(host, error);
          return;
        }
        // Retain a picker captured before storage, including its rejected result;
        // delivery follows the latest picker tail before issuing the request.
        pendingSettings ??= getPendingChatPickerPatch(host, submittedSessionKey);
        waitingForSettings = Boolean(pendingSettings);
        queued.sendState = waitingForSettings
          ? "waiting-model"
          : reconnectSafeQueuedSendState(host);
        keepVolatileQueuedMessage(host, submittedSessionKey, queued, queued.agentId);
      }
      const admittedDurably = await admitQueuedMessageForSession(
        host,
        submission.admission,
        queued,
        replacement,
      );
      if (resumedEdit) {
        await retireEditedQueuedMessageSource(
          host,
          admittedDurably,
          queued.attachments,
          resumedEdit,
        );
      }
      if (!admittedDurably && !currentSubmission()) {
        if (!persistPendingChatOutboxAdmission(queued)) {
          retireOutboxPayload(queued);
        }
        return;
      }
      if (!admittedDurably && !submittedCredentialOwnerIsCurrent()) {
        const retained = persistPendingChatOutboxAdmission(queued);
        if (!retained) {
          retireOutboxPayload(queued);
        }
        return;
      }
      const canSendFromMemory =
        !admittedDurably &&
        !queued.attachments?.length &&
        (!resumedEdit || !resumedEdit.sourceWasDurable) &&
        // A still-open edit means its stored source outlived the rejected write;
        // sending the replacement from memory would strand the original as a duplicate.
        !activeQueuedMessageEdit(host) &&
        !waitingForSettings &&
        canSendVolatileQueueItem(host, queued, submittedSessionKey);
      if (!admittedDurably && !canSendFromMemory) {
        if (!host.chatMessage && !host.chatAttachments.length) {
          retireOutboxPayload(queued);
          await cancelChatDelivery(host, queued, {
            previousDraft: cleared.previousDraft,
            previousAttachments: cleared.previousAttachments,
            previousMentions: cleared.previousMentions,
          });
          releasePendingProtection();
        } else {
          queued = { ...queued, sendState: "failed", sendError: OFFLINE_QUEUE_STORAGE_ERROR };
          keepVolatileQueuedMessage(host, submittedSessionKey, queued, queued.agentId, {
            retryable: true,
          });
          updatePendingChatOutboxAdmission(queued);
        }
        setChatError(host, OFFLINE_QUEUE_STORAGE_ERROR);
        return;
      }
      if (!submittedCredentialOwnerIsCurrent()) {
        return;
      }
      const current = readQueuedMessageById(host, queued.id);
      // Input may retire this admission or another drain may advance it. Only
      // position changes preserve the handoff; the drain owns ordering/edit holds.
      const deliveryItem =
        current &&
        sameQueuedDeliveryVersion(queued, {
          ...current,
          agentId: queued.agentId,
          orderKey: queued.orderKey,
          sessionKey: queued.sessionKey,
        })
          ? { ...queued, ...current, attachments: queued.attachments }
          : null;
      if (deliveryItem && canSendFromMemory) {
        updatePendingChatOutboxAdmission({
          ...deliveryItem,
          sendAttempts: (deliveryItem.sendAttempts ?? 0) + 1,
          sendState: "sending",
        });
      }
      const sendResult = deliveryItem
        ? await deliverChatQueueItem(host, deliveryItem, {
            previousDraft: cleared.previousDraft,
            previousAttachments: cleared.previousAttachments,
            previousMentions: cleared.previousMentions,
            ...(intent || (directRunActive && followUpMode !== "queue")
              ? { allowActiveRunSend: true }
              : {}),
            ...(expectedLeafEntryId !== undefined ? { expectedLeafEntryId } : {}),
            ...(pendingSettings ? { pendingSettings } : {}),
            restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
            restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
            restoreOnTerminalFailure: Boolean(rawParsedCommand || intent),
            routingSessionKey: submittedSessionKey,
            storageMode: canSendFromMemory ? "memory" : "durable",
          })
        : "pending";
      syncVisibleChatQueueProjection(host);
      const pending = readQueuedMessageById(host, queued.id);
      if (!admittedDurably && pending && (pending.sendAttempts ?? 0) > 0) {
        updatePendingChatOutboxAdmission(pending);
      }
      accepted = sendResult !== "failed";
      const pendingBusySend =
        sendResult === "pending" &&
        pending?.sendState === "waiting-idle" &&
        host.sessionKey === submittedSessionKey &&
        visibleSessionMatches(host, submittedSessionKey, pending.agentId) &&
        (isChatBusy(host) || hasDirectSessionRun(host));
      if (pendingBusySend) {
        recordChatSendTiming(host, pending, "queued-busy", submittedAtMs);
      }
      if (
        (sendResult !== "failed" || pending?.sendState === "failed") &&
        replyTarget &&
        host.chatReplyTarget === replyTarget &&
        submissionOwnerIsCurrent()
      ) {
        // The reconnect queue owns the quote; later offline turns must not reuse it.
        host.chatReplyTarget = null;
      }
    } finally {
      // Every exit ends live preparation; recovery never has to infer whether
      // a canceled or failed submission still has asynchronous work in flight.
      finishPendingChatOutboxAdmission(submission.item.id);
    }
  };
  await withChatSubmitGuard(host, submitKey, submitMessage, submissionAction);
  return accepted;
}
