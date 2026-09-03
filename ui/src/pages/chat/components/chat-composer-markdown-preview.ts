// Chat composer Markdown preview presentation.
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { adjustTextareaHeight, preserveComposerBottomAnchor } from "./chat-composer-dom.ts";

const RICH_MARKDOWN_HTML_RE =
  /<(?:a|blockquote|code|del|details|em|h[1-4]|hr|img|li|ol|pre|s|strong|table|ul)(?:\s|>)/iu;

function renderComposerMarkdownPreview(draft: string): string {
  const rendered = toSanitizedMarkdownHtml(draft, {
    codeBlockChrome: "none",
    codeBlockInteraction: "static",
    fileLinks: true,
    sessionLinks: true,
    tableInteractions: "none",
  });
  return RICH_MARKDOWN_HTML_RE.test(rendered) ? rendered : "";
}

export function syncComposerMarkdownPreview(textarea: HTMLTextAreaElement, draft: string) {
  const previous = textarea.previousElementSibling;
  let preview: HTMLElement;
  if (
    previous instanceof HTMLElement &&
    previous.classList.contains("agent-chat__composer-markdown-preview")
  ) {
    preview = previous;
  } else {
    // The textarea remains the only editable draft owner. Its adjacent inert
    // preview follows the same lifecycle without involving pane rerenders.
    preview = document.createElement("div");
    preview.className = "agent-chat__composer-markdown-preview";
    preview.hidden = true;
    preview.setAttribute("aria-hidden", "true");
    preview.setAttribute("inert", "");
    textarea.before(preview);
  }

  const rendered = renderComposerMarkdownPreview(draft);
  preserveComposerBottomAnchor(textarea, () => {
    preview.classList.toggle("chat-text", rendered.length > 0);
    preview.hidden = rendered.length === 0;
    preview.dir = detectTextDirection(draft);
    preview.innerHTML = rendered;
  });
}

export function syncComposerValuePresentation(textarea: HTMLTextAreaElement) {
  syncComposerMarkdownPreview(textarea, textarea.value);
  textarea.dir = detectTextDirection(textarea.value);
  adjustTextareaHeight(textarea);
}
