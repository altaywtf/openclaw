import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { removeBrowserAnnotationWithUndo } from "./browser-annotation-removal.ts";
import { ChatPaneHeader } from "./chat-pane-header.ts";
import { focusChatComposer } from "./components/chat-composer-dom.ts";

export abstract class ChatPaneBrowserAnnotationRender extends ChatPaneHeader {
  protected readonly removeBrowserAnnotation = (attachment: ChatAttachment) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const sourceSessionKey = state.sessionKey;
    removeBrowserAnnotationWithUndo(
      {
        getOwner: () => this.browserAnnotationOwner(),
        getSessionKey: () => this.state?.sessionKey ?? "",
        getAttachments: () => this.state?.chatAttachments ?? [],
        setAttachments: (attachments) => {
          if (this.state) {
            this.state.chatAttachments = attachments;
          }
        },
        requestUpdate: () => this.state?.requestUpdate?.(),
        focusComposer: () => {
          void this.updateComplete.then(() => {
            if (this.state !== state || this.state.sessionKey !== sourceSessionKey) {
              return;
            }
            focusChatComposer(this);
          });
        },
        focusRestoredAnnotation: (attachmentId) => {
          void this.updateComplete.then(() => {
            if (this.state !== state || this.state.sessionKey !== sourceSessionKey) {
              return;
            }
            const card = [...this.querySelectorAll<HTMLElement>("[data-attachment-id]")].find(
              (candidate) => candidate.dataset.attachmentId === attachmentId,
            );
            card?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
          });
        },
      },
      attachment,
      {
        removed: t("chat.composer.browserAnnotationRemoved"),
        undo: t("common.undo"),
        undoUnavailable: t("chat.composer.browserAnnotationUndoUnavailable"),
      },
    );
  };
}
