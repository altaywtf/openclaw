import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../styles.css";
import "../../styles/transcripts.css";
import { meetingEntry, meetingPage } from "../../test-helpers/transcripts.test-support.ts";
import { renderTranscripts } from "./view.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  container.remove();
});

function readerProps(): Parameters<typeof renderTranscripts>[0] {
  return {
    basePath: "",
    search: "?selected=meeting",
    drafts: {},
    onDraft: vi.fn(),
    connected: true,
    allowed: true,
    list: { sessions: [meetingEntry], nextCursor: null },
    listLoading: false,
    listError: null,
    reader: {
      pages: [
        {
          ...meetingPage,
          utterances: [{ sequence: 0, speakerLabel: "Avery", text: "Unbroken".repeat(120) }],
        },
      ],
      loading: false,
      error: null,
      trimmed: false,
    },
    readerTab: "text",
    exportState: { kind: "idle" },
    onNavigate: vi.fn(),
    onRefresh: vi.fn(),
    onReaderRetry: vi.fn(),
    onReaderTab: vi.fn(),
    onLoadMore: vi.fn(),
    onReaderStart: vi.fn(),
    onDownload: vi.fn(),
  };
}

describe.skipIf(!hasBrowserLayout)("meeting transcript responsive reader", () => {
  it("keeps long speaker text inside the reading column and switches to a mobile drill-in", async () => {
    const { page } = await import("vitest/browser");
    const props = readerProps();
    await page.viewport(1320, 900);
    render(renderTranscripts(props), container);
    const library = document.querySelector<HTMLElement>(".transcripts-library")!;
    const reader = document.querySelector<HTMLElement>(".transcripts-reader")!;
    expect(getComputedStyle(library).display).not.toBe("none");
    expect(reader.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      library.getBoundingClientRect().right - 1,
    );
    expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1);
    await page.viewport(390, 844);
    expect(getComputedStyle(library).display).toBe("none");
    expect(reader.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1);
    const summary = document.querySelector<HTMLElement>("#transcript-reader-tab-summary")!;
    summary.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(props.onReaderTab).toHaveBeenCalledWith("summary");
    render(renderTranscripts({ ...props, readerTab: "summary" }), container);
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain(
      "Notes extracted using text heuristics",
    );
  });
  it("uses themed search controls and keeps the third library entry above the fold", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(1440, 1000);
    const props = readerProps();
    props.list = {
      sessions: [
        meetingEntry,
        { ...meetingEntry, selector: "second" },
        { ...meetingEntry, selector: "third" },
      ],
      nextCursor: null,
    };
    render(renderTranscripts(props), container);
    const libraryInput = document.querySelector<HTMLInputElement>('input[name="query"]')!;
    const readerInput = document.querySelector<HTMLInputElement>('input[name="find"]')!;
    const libraryStyle = getComputedStyle(libraryInput);
    const readerStyle = getComputedStyle(readerInput);
    for (const property of ["backgroundColor", "borderRadius", "paddingLeft"] as const) {
      expect(readerStyle[property]).toBe(libraryStyle[property]);
    }
    const third = document.querySelectorAll(".transcripts-list__entry")[2]!;
    expect(third.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
    expect(document.querySelector<HTMLDetailsElement>(".transcripts-filters details")!.open).toBe(
      false,
    );
  });

  it("keeps summary paragraphs together without flattening text newlines", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(1440, 1000);
    const props = readerProps();
    props.readerTab = "summary";
    props.reader.pages = [
      {
        ...meetingPage,
        summary: {
          ...meetingPage.summary!,
          overview: "First line.\nSecond line.",
          actionItems: ["Follow up."],
          risks: ["None recorded."],
        },
      },
    ];
    render(renderTranscripts(props), container);
    const summary = document.querySelector<HTMLElement>(".transcripts-summary")!;
    const blocks = [...summary.children];
    const lineHeight = Number.parseFloat(getComputedStyle(summary).lineHeight);
    for (let index = 1; index < blocks.length; index++) {
      const gap =
        blocks[index]!.getBoundingClientRect().top -
        blocks[index - 1]!.getBoundingClientRect().bottom;
      expect(gap, `gap before summary block ${index}`).toBeLessThan(lineHeight * 2);
    }
    const overview = blocks[2]!;
    const generatedAt = blocks[1]!;
    expect(generatedAt.getBoundingClientRect().height).toBeLessThan(
      Number.parseFloat(getComputedStyle(generatedAt).lineHeight) * 1.5,
    );
    expect(overview.textContent).toBe("First line.\nSecond line.");
    expect(overview.getBoundingClientRect().height).toBeGreaterThan(lineHeight * 1.5);
  });
});
