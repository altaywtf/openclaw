type MockEditor = {
  destroy: () => void;
  focus: () => void;
  hasFocus: () => boolean;
  setDraft: (draft: string) => void;
  setSelection: (start: number, end?: number) => void;
  updateOptions: (options: MockOptions) => void;
};

type MockOptions = { draft: string };

type MockState = {
  composerEditor: MockEditor | null;
  composerEditorHost: HTMLElement | null;
  composerEditorOptions: MockOptions | null;
  composerTextarea: HTMLTextAreaElement | null;
  restoreComposerFocus: boolean;
};

function attach(state: MockState) {
  const host = state.composerEditorHost;
  const source = state.composerTextarea;
  const options = state.composerEditorOptions;
  if (state.composerEditor || !host || !source || !options) {
    return;
  }
  const content = document.createElement("div");
  content.className = "cm-content";
  content.contentEditable = "true";
  content.tabIndex = 0;
  content.textContent = options.draft;
  host.append(content);
  const setDraft = (draft: string) => {
    source.value = draft;
    content.textContent = draft;
  };
  state.composerEditor = {
    destroy: () => content.remove(),
    focus: () => content.focus(),
    hasFocus: () => document.activeElement === content,
    setDraft,
    setSelection: (start, end = start) => source.setSelectionRange(start, end),
    updateOptions: (next) => setDraft(next.draft),
  };
  if (state.restoreComposerFocus) {
    state.restoreComposerFocus = false;
    queueMicrotask(() => state.composerEditor?.focus());
  }
}

export function setChatComposerRichEditorHost(state: MockState, element?: Element) {
  const next = element instanceof HTMLElement ? element : null;
  if (state.composerEditorHost && state.composerEditorHost !== next) {
    state.composerEditor?.destroy();
    state.composerEditor = null;
  }
  state.composerEditorHost = next;
  attach(state);
}

export function setChatComposerRichEditorSource(state: MockState, element?: Element) {
  const next = element instanceof HTMLTextAreaElement ? element : null;
  if (state.composerTextarea && state.composerTextarea !== next) {
    state.composerEditor?.destroy();
    state.composerEditor = null;
  }
  state.composerTextarea = next;
  attach(state);
}

export function updateChatComposerRichEditor(state: MockState, options: MockOptions) {
  state.composerEditorOptions = options;
  state.composerEditor?.updateOptions(options);
  attach(state);
}
