import type { ChatSendShortcut } from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import {
  type ComposerDictationController,
  insertComposerDictation,
} from "../composer-dictation.ts";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import {
  type ChatComposerRichEditorOptions,
  updateChatComposerRichEditor,
} from "./chat-composer-rich-editor.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

type RichEditorHandlers = Pick<
  ChatComposerRichEditorOptions,
  | "onKeyDown"
  | "onBeforeInput"
  | "onInput"
  | "onSelect"
  | "onCompositionStart"
  | "onCompositionEnd"
  | "onBlur"
>;

export function configureChatComposerRichEditor(params: {
  state: ChatComposerState;
  props: ChatComposerProps;
  dictation: ComposerDictationController | undefined;
  canCompose: boolean;
  goalPending: boolean;
  visibleDraft: string;
  placeholder: string;
  sendShortcut: ChatSendShortcut;
  slashMenuAnnouncementId: string;
  slashMenuListboxId: string;
  menuVisible: boolean;
  activeOptionId: string | null;
  handlers: RichEditorHandlers;
}) {
  const { state, props, dictation } = params;
  const draft = dictation?.active
    ? insertComposerDictation(
        state.dictationSelection?.value ?? params.visibleDraft,
        dictation.transcript,
        state.dictationSelection?.start ?? params.visibleDraft.length,
        state.dictationSelection?.end ?? params.visibleDraft.length,
      ).value
    : params.visibleDraft;
  updateChatComposerRichEditor(state, {
    draft,
    direction: detectTextDirection(draft),
    disabled: !params.canCompose,
    readOnly: dictation?.locksComposer === true || params.goalPending,
    placeholder: dictation?.active ? "" : params.placeholder,
    ariaLabel: t("chat.composer.composerInput"),
    ariaDescriptionIds: `${params.slashMenuAnnouncementId}${
      props.disabledReason ? ` ${paneDomId(props.paneId, "disabled-reason")}` : ""
    }`,
    ariaControls: params.menuVisible ? params.slashMenuListboxId : undefined,
    ariaExpanded: params.menuVisible ? "true" : undefined,
    ariaActiveDescendant: params.activeOptionId ?? undefined,
    ariaKeyShortcuts: params.sendShortcut === "enter" ? "Enter" : "Control+Enter Meta+Enter",
    ...params.handlers,
    onPaste: (event) => {
      if (params.canCompose && !props.suggestionComposer) {
        handleChatAttachmentPaste(event, props);
      }
    },
  });
}
