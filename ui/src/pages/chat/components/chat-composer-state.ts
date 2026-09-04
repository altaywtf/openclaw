import type { ChatQueueItem, HumanMention } from "../../../lib/chat/chat-types.ts";
import type { ChatRunUiStatus } from "../run-lifecycle.ts";
import { disconnectComposerPopoverAnchorObserver } from "./chat-composer-dom.ts";
import { clearGoalElapsedTimers } from "./chat-composer-goal.ts";
import { HumanMentionMenu } from "./chat-composer-mention-menu.ts";
import { resetChatComposerRichEditor } from "./chat-composer-rich-editor.ts";
import { createSkillMenuState } from "./chat-composer-skill-menu.ts";
import { createSlashMenuState } from "./chat-composer-slash-menu.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

function createChatComposerState(): ChatComposerState {
  return {
    ...createSlashMenuState(),
    ...createSkillMenuState(),
    composerComposing: false,
    mentionMenu: new HumanMentionMenu(),
    composingDraft: null,
    composerInputIntentKey: null,
    pendingClearedSubmittedDraft: null,
    goalExpandedId: null,
    goalComposer: null,
    activeGatewayQuestionId: null,
    gatewayQuestionCollapsed: false,
    questionTakeoverActive: false,
    restoreComposerFocus: false,
    composerInput: null,
    composerTextarea: null,
    composerEditorHost: null,
    composerEditor: null,
    composerEditorOptions: null,
    microphonePicker: null,
    capabilityMenuOpen: false,
    capabilityMenuView: "root",
    textareaRef: null,
    composerEditorRef: null,
    composerInputRef: null,
    dictation: null,
    composerDraftScopeKey: null,
    dictationError: null,
    dictationSelection: null,
  };
}

const composerStates = new Map<string, ChatComposerState>();

export function getChatComposerState(paneId: string): ChatComposerState {
  const existing = composerStates.get(paneId);
  if (existing) {
    return existing;
  }
  const state = createChatComposerState();
  composerStates.set(paneId, state);
  return state;
}

export function hasTerminalRunStatus(status: ChatRunUiStatus | null | undefined): boolean {
  return status?.phase === "done" || status?.phase === "interrupted";
}

export function isCurrentSessionSubmittedProgress(
  item: ChatQueueItem,
  sessionKey: string,
  status: ChatRunUiStatus | null | undefined,
): boolean {
  return (
    item.sessionKey === sessionKey &&
    !item.pendingRunId &&
    (item.sendState === "sending" || item.sendState === "waiting-model") &&
    (status == null || item.sendRunId !== status.runId)
  );
}

// Single source for "the agent is visibly working": drives both the thread's
// working spark and the composer's sr-only announcement. A fresh terminal
// toast masks stale abortable rows so neither surface flashes back to working.
export function isChatRunWorking(
  props: Pick<ChatComposerProps, "canAbort" | "onAbort" | "runStatus" | "queue" | "sessionKey">,
): boolean {
  const canAbort = Boolean(props.canAbort && props.onAbort);
  return (
    (canAbort && !hasTerminalRunStatus(props.runStatus)) ||
    props.queue.some((item) =>
      isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
    )
  );
}

export function composerDraftKey(
  props: Pick<ChatComposerProps, "currentAgentId" | "sessionKey">,
): string {
  return `${props.currentAgentId}\u0000${props.sessionKey}`;
}

export function resetComposerDraftScope(state: ChatComposerState) {
  state.dictation?.dispose();
  state.dictation = null;
  state.dictationSelection = null;
  resetChatComposerRichEditor(state);
}

export function commitComposerDraft(
  props: ChatComposerProps,
  value: string,
  mentions?: readonly HumanMention[],
): void {
  const currentDraft = props.getDraft ? props.getDraft() : props.draft;
  if (currentDraft === value && mentions === undefined) {
    return;
  }
  const hadMentions = (props.getMentions?.() ?? props.mentions ?? []).length > 0;
  props.onDraftChange(value, mentions);
  if (hadMentions || mentions?.length) {
    props.onRequestUpdate?.();
  }
}

export function markComposerInputIntent(state: ChatComposerState, key: string): void {
  state.composerInputIntentKey = key;
}

export function consumeComposerInputIntent(state: ChatComposerState, key: string): boolean {
  if (state.composerInputIntentKey !== key) {
    return false;
  }
  state.composerInputIntentKey = null;
  return true;
}

function clearPendingClearedSubmittedDraft(state: ChatComposerState, key: string): void {
  if (state.pendingClearedSubmittedDraft?.key === key) {
    state.pendingClearedSubmittedDraft = null;
  }
}

export function syncComposerDraftAfterSend(
  state: ChatComposerState,
  props: ChatComposerProps,
  draftKey: string,
  target: HTMLTextAreaElement | null,
) {
  state.mentionMenu.close();
  const submittedDraft = target?.value ?? props.getDraft?.() ?? props.draft;
  const hostDraft = props.getDraft?.() ?? props.draft;
  if (hostDraft === "" && submittedDraft !== "" && target?.value === submittedDraft) {
    state.pendingClearedSubmittedDraft = { key: draftKey, value: submittedDraft };
  } else {
    clearPendingClearedSubmittedDraft(state, draftKey);
  }
  if (target && target.value !== hostDraft) {
    target.value = hostDraft;
    state.composerEditor?.setDraft(hostDraft);
  }
}

function isExplicitComposerInsertion(event: InputEvent): boolean {
  return event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop";
}

export function suppressStaleSubmittedDraftReplay(
  target: HTMLTextAreaElement,
  event: InputEvent,
  currentDraft: string,
  hasInputIntent: boolean,
  state: ChatComposerState,
): boolean {
  const pending = state.pendingClearedSubmittedDraft;
  if (!pending) {
    return false;
  }
  if (target.value !== pending.value || hasInputIntent || isExplicitComposerInsertion(event)) {
    return false;
  }

  target.value = currentDraft;
  state.composerEditor?.setDraft(currentDraft);
  return true;
}

function disposeChatComposerState(state: ChatComposerState) {
  state.mentionMenu.dispose();
  state.composerDraftScopeKey = null;
  state.dictation?.dispose();
  state.microphonePicker?.dispose();
  state.composerEditor?.destroy();
  if (state.composerInput) {
    disconnectComposerPopoverAnchorObserver(state.composerInput);
  }
}

export function resetChatComposerState(paneId?: string) {
  if (paneId) {
    // Goal elapsed timers are keyed by element and cleaned up when their
    // element leaves the DOM, so a per-pane reset does not need to touch them.
    const paneState = composerStates.get(paneId);
    if (paneState) {
      disposeChatComposerState(paneState);
    }
    composerStates.delete(paneId);
    return;
  }
  for (const state of composerStates.values()) {
    disposeChatComposerState(state);
  }
  composerStates.clear();
  clearGoalElapsedTimers();
}
