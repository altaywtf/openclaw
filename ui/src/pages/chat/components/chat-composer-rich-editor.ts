import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  StateField,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  WidgetType,
} from "@codemirror/view";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { preserveComposerBottomAnchor } from "./chat-composer-dom.ts";

export type ChatComposerRichEditorOptions = {
  draft: string;
  direction: "ltr" | "rtl";
  disabled: boolean;
  readOnly: boolean;
  placeholder: string;
  ariaLabel: string;
  ariaDescriptionIds: string;
  ariaControls?: string;
  ariaExpanded?: string;
  ariaActiveDescendant?: string;
  ariaKeyShortcuts: string;
  onKeyDown: (event: KeyboardEvent, source: HTMLTextAreaElement) => void;
  onBeforeInput: (event: InputEvent, source: HTMLTextAreaElement) => void;
  onInput: (event: InputEvent, source: HTMLTextAreaElement) => void;
  onSelect: (source: HTMLTextAreaElement) => void;
  onCompositionStart: (event: CompositionEvent, source: HTMLTextAreaElement) => void;
  onCompositionEnd: (event: CompositionEvent, source: HTMLTextAreaElement) => void;
  onBlur: (event: FocusEvent, source: HTMLTextAreaElement) => void;
  onPaste: (event: ClipboardEvent) => void;
};

export type ChatComposerRichEditorHandle = {
  destroy: () => void;
  updateOptions: (options: ChatComposerRichEditorOptions) => void;
  setDraft: (draft: string) => void;
  focus: () => void;
  hasFocus: () => boolean;
  setSelection: (start: number, end?: number) => void;
};

type RichDecorations = {
  all: DecorationSet;
  hidden: DecorationSet;
};

class ListMarkerWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: ListMarkerWidget) {
    return other.label === this.label;
  }

  override toDOM() {
    const marker = document.createElement("span");
    marker.className = "chat-composer-rich-list-marker";
    marker.textContent = this.label;
    return marker;
  }
}

function markerIsBeingEdited(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some((range) => range.head >= from && range.head <= to);
}

function buildRichDecorations(state: EditorState): RichDecorations {
  const ranges: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const addHidden = (from: number, to: number, decoration = Decoration.replace({})) => {
    if (markerIsBeingEdited(state, from, to)) {
      return;
    }
    const range = decoration.range(from, to);
    ranges.push(range);
    hidden.push(range);
  };
  const addLineClass = (from: number, to: number, className: string) => {
    for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
      const classes = lineClasses.get(line.from) ?? new Set<string>();
      classes.add(className);
      lineClasses.set(line.from, classes);
      if (line.to >= to || line.number === state.doc.lines) {
        break;
      }
    }
  };

  syntaxTree(state).iterate({
    enter(node) {
      const treeNode = node.node;
      switch (node.name) {
        case "ATXHeading1":
        case "ATXHeading2":
        case "ATXHeading3":
        case "ATXHeading4":
        case "ATXHeading5":
        case "ATXHeading6": {
          addLineClass(node.from, node.to, `chat-composer-rich-heading-${node.name.at(-1)}`);
          break;
        }
        case "HeaderMark":
        case "QuoteMark":
        case "CodeMark":
        case "EmphasisMark":
        case "StrikethroughMark": {
          addHidden(node.from, node.to);
          break;
        }
        case "Blockquote": {
          addLineClass(node.from, node.to, "chat-composer-rich-quote");
          break;
        }
        case "ListItem": {
          addLineClass(node.from, node.to, "chat-composer-rich-list-item");
          break;
        }
        case "ListMark": {
          const raw = state.sliceDoc(node.from, node.to);
          const label = /^\d/u.test(raw) ? raw : "•";
          addHidden(
            node.from,
            node.to,
            Decoration.replace({ widget: new ListMarkerWidget(label) }),
          );
          break;
        }
        case "StrongEmphasis":
        case "Emphasis":
        case "Strikethrough":
        case "InlineCode": {
          const first = treeNode.firstChild;
          const last = treeNode.lastChild;
          const from = first?.to ?? node.from;
          const to = last?.from ?? node.to;
          if (from < to) {
            const suffix =
              node.name === "StrongEmphasis"
                ? "strong"
                : node.name === "Emphasis"
                  ? "emphasis"
                  : node.name === "Strikethrough"
                    ? "strike"
                    : "code";
            ranges.push(Decoration.mark({ class: `chat-composer-rich-${suffix}` }).range(from, to));
          }
          break;
        }
        case "Link": {
          const children = [];
          for (let child = treeNode.firstChild; child; child = child.nextSibling) {
            children.push(child);
          }
          const target = children.find((child) => child.name === "URL");
          const marks = children.filter((child) => child.name === "LinkMark");
          const editingTarget = target && markerIsBeingEdited(state, target.from, target.to);
          const labelStart = marks[0];
          const labelEnd = marks[1];
          const linkEnd = marks.at(-1);
          if (!editingTarget && target && labelStart && labelEnd && linkEnd) {
            ranges.push(
              Decoration.mark({ class: "chat-composer-rich-link" }).range(
                labelStart.to,
                labelEnd.from,
              ),
            );
            addHidden(labelStart.from, labelStart.to);
            addHidden(labelEnd.from, target.to);
            addHidden(linkEnd.from, linkEnd.to);
          }
          break;
        }
        case "FencedCode": {
          addLineClass(node.from, node.to, "chat-composer-rich-code-block");
          break;
        }
      }
    },
  });

  for (const [from, classes] of lineClasses) {
    ranges.push(Decoration.line({ class: [...classes].join(" ") }).range(from));
  }
  return {
    all: Decoration.set(ranges, true),
    hidden: Decoration.set(hidden, true),
  };
}

const richDecorations = StateField.define<RichDecorations>({
  create: buildRichDecorations,
  update(value, transaction) {
    return transaction.docChanged || transaction.selection
      ? buildRichDecorations(transaction.state)
      : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.all),
    EditorView.atomicRanges.of((view) => view.state.field(field).hidden),
  ],
});

function copyEditorSelectionToSource(view: EditorView, source: HTMLTextAreaElement) {
  const range = view.state.selection.main;
  source.selectionStart = range.from;
  source.selectionEnd = range.to;
}

export function createChatComposerRichEditor(params: {
  parent: HTMLElement;
  source: HTMLTextAreaElement;
  options: ChatComposerRichEditorOptions;
}): ChatComposerRichEditorHandle {
  let options = params.options;
  let applyingDraft = false;
  let pendingInput: Pick<InputEventInit, "data" | "inputType" | "isComposing"> | null = null;
  let lastPlaceholder = options.placeholder;
  let lastEditable = !options.disabled && !options.readOnly;
  const editable = new Compartment();
  const placeholderText = new Compartment();

  const syncSource = (view: EditorView) => {
    const draft = view.state.sliceDoc();
    const direction = detectTextDirection(draft);
    params.source.value = draft;
    params.source.dir = direction;
    view.contentDOM.dir = direction;
    copyEditorSelectionToSource(view, params.source);
  };
  const inputEvent = () =>
    new InputEvent("input", {
      bubbles: true,
      inputType: pendingInput?.inputType ?? "insertText",
      data: pendingInput?.data ?? null,
      isComposing: pendingInput?.isComposing ?? false,
    });

  const state = EditorState.create({
    doc: options.draft,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({
        base: markdownLanguage,
        completeHTMLTags: false,
        pasteURLAsLink: false,
      }),
      richDecorations,
      EditorView.lineWrapping,
      editable.of([EditorState.readOnly.of(!lastEditable), EditorView.editable.of(lastEditable)]),
      placeholderText.of(placeholder(options.placeholder)),
      EditorView.domEventHandlers({
        keydown(event, view) {
          syncSource(view);
          options.onKeyDown(event, params.source);
          return event.defaultPrevented;
        },
        beforeinput(event, view) {
          syncSource(view);
          pendingInput = {
            data: event.data,
            inputType: event.inputType,
            isComposing: event.isComposing,
          };
          options.onBeforeInput(event, params.source);
          return event.defaultPrevented;
        },
        compositionstart(event, view) {
          syncSource(view);
          options.onCompositionStart(event, params.source);
          return false;
        },
        compositionend(event, view) {
          syncSource(view);
          options.onCompositionEnd(event, params.source);
          return false;
        },
        focus(_event, view) {
          syncSource(view);
          options.onSelect(params.source);
          return false;
        },
        blur(event, view) {
          syncSource(view);
          options.onBlur(event, params.source);
          if (params.source.value !== view.state.sliceDoc()) {
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: params.source.value },
            });
          }
          return false;
        },
        paste(event) {
          options.onPaste(event);
          return event.defaultPrevented;
        },
      }),
      EditorView.updateListener.of((update) => {
        syncSource(update.view);
        if (update.docChanged && !applyingDraft) {
          options.onInput(inputEvent(), params.source);
        }
        if (update.selectionSet && !update.docChanged) {
          options.onSelect(params.source);
        }
        pendingInput = null;
      }),
    ],
  });

  params.parent.replaceChildren();
  const view = new EditorView({
    parent: params.parent,
    root: document,
    state,
    dispatchTransactions(transactions, editor) {
      preserveComposerBottomAnchor(params.parent, () => editor.update(transactions));
    },
  });
  view.contentDOM.setAttribute("aria-autocomplete", "list");
  view.contentDOM.setAttribute("spellcheck", "true");

  // The source remains a hidden Markdown compatibility boundary for existing
  // composer integrations; CodeMirror is the only user-visible editing surface.
  const syncFromSource = () => {
    if (params.source.value === view.state.sliceDoc()) {
      copyEditorSelectionToSource(view, params.source);
      return;
    }
    applyingDraft = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: params.source.value },
      selection: EditorSelection.range(params.source.selectionStart, params.source.selectionEnd),
    });
    applyingDraft = false;
  };
  const syncSelectionFromSource = () => {
    const from = Math.min(params.source.selectionStart, view.state.doc.length);
    const to = Math.min(params.source.selectionEnd, view.state.doc.length);
    view.dispatch({ selection: EditorSelection.range(from, to) });
  };
  params.source.addEventListener("input", syncFromSource);
  params.source.addEventListener("select", syncSelectionFromSource, true);
  params.source.addEventListener("pointerup", syncSelectionFromSource, true);
  params.source.addEventListener("compositionend", syncFromSource, true);

  const updateOptions = (next: ChatComposerRichEditorOptions) => {
    const draftChanged = next.draft !== options.draft;
    options = next;
    params.source.disabled = next.disabled;
    params.source.readOnly = next.readOnly;
    params.source.dir = next.direction;
    view.contentDOM.dir = next.direction;
    view.contentDOM.setAttribute("aria-label", next.ariaLabel);
    view.contentDOM.setAttribute("aria-describedby", next.ariaDescriptionIds);
    view.contentDOM.setAttribute("aria-keyshortcuts", next.ariaKeyShortcuts);
    for (const [name, value] of [
      ["aria-controls", next.ariaControls],
      ["aria-expanded", next.ariaExpanded],
      ["aria-activedescendant", next.ariaActiveDescendant],
    ] as const) {
      if (value === undefined) {
        view.contentDOM.removeAttribute(name);
      } else {
        view.contentDOM.setAttribute(name, value);
      }
    }
    const nextEditable = !next.disabled && !next.readOnly;
    const effects = [];
    if (nextEditable !== lastEditable) {
      lastEditable = nextEditable;
      effects.push(
        editable.reconfigure([
          EditorState.readOnly.of(!nextEditable),
          EditorView.editable.of(nextEditable),
        ]),
      );
    }
    if (next.placeholder !== lastPlaceholder) {
      lastPlaceholder = next.placeholder;
      effects.push(placeholderText.reconfigure(placeholder(next.placeholder)));
    }
    if (effects.length > 0) {
      view.dispatch({ effects });
    }
    if (draftChanged && next.draft !== view.state.sliceDoc()) {
      applyingDraft = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next.draft },
        selection: EditorSelection.cursor(next.draft.length),
      });
      applyingDraft = false;
    }
    syncSource(view);
  };

  updateOptions(options);
  return {
    destroy: () => {
      params.source.removeEventListener("input", syncFromSource);
      params.source.removeEventListener("select", syncSelectionFromSource, true);
      params.source.removeEventListener("pointerup", syncSelectionFromSource, true);
      params.source.removeEventListener("compositionend", syncFromSource, true);
      view.destroy();
    },
    updateOptions,
    setDraft: (draft) => {
      if (draft === view.state.sliceDoc()) {
        return;
      }
      applyingDraft = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: draft },
        selection: EditorSelection.cursor(draft.length),
      });
      applyingDraft = false;
      options = { ...options, draft };
      syncSource(view);
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    setSelection: (start, end = start) => {
      const from = Math.min(Math.max(0, start), view.state.doc.length);
      const to = Math.min(Math.max(0, end), view.state.doc.length);
      view.dispatch({ selection: EditorSelection.range(from, to) });
      copyEditorSelectionToSource(view, params.source);
    },
  };
}

type ChatComposerRichEditorState = {
  composerEditor: ChatComposerRichEditorHandle | null;
  composerEditorHost: HTMLElement | null;
  composerEditorOptions: ChatComposerRichEditorOptions | null;
  composerTextarea: HTMLTextAreaElement | null;
  restoreComposerFocus: boolean;
};

function attachChatComposerRichEditor(state: ChatComposerRichEditorState) {
  if (
    state.composerEditor ||
    !state.composerEditorHost ||
    !state.composerTextarea ||
    !state.composerEditorOptions
  ) {
    return;
  }
  state.composerEditor = createChatComposerRichEditor({
    parent: state.composerEditorHost,
    source: state.composerTextarea,
    options: state.composerEditorOptions,
  });
}

export function setChatComposerRichEditorSource(
  state: ChatComposerRichEditorState,
  element?: Element,
) {
  const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
  if (state.composerTextarea && state.composerTextarea !== nextTextarea) {
    state.composerEditor?.destroy();
    state.composerEditor = null;
  }
  state.composerTextarea = nextTextarea;
  attachChatComposerRichEditor(state);
  if (state.restoreComposerFocus && state.composerEditor) {
    state.restoreComposerFocus = false;
    queueMicrotask(() => state.composerEditor?.focus());
  }
}

export function setChatComposerRichEditorHost(
  state: ChatComposerRichEditorState,
  element?: Element,
) {
  const nextHost = element instanceof HTMLElement ? element : null;
  if (state.composerEditorHost && state.composerEditorHost !== nextHost) {
    state.composerEditor?.destroy();
    state.composerEditor = null;
  }
  state.composerEditorHost = nextHost;
  attachChatComposerRichEditor(state);
}

export function updateChatComposerRichEditor(
  state: ChatComposerRichEditorState,
  options: ChatComposerRichEditorOptions,
) {
  state.composerEditorOptions = options;
  state.composerEditor?.updateOptions(options);
  attachChatComposerRichEditor(state);
}
