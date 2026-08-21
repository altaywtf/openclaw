type ExpectedRow = {
  display_ordinal: number;
  kind: "assistant" | "opaque" | "user";
  revision: number;
  source_event_seq: number;
};

function expectedSnapshot(
  rows: ExpectedRow[],
  carry: Array<{
    kind: string;
    position: number;
    relatedEventSeq: number | null;
    sourceEventSeq: number;
  }> = [],
  sources: Array<{
    displayOrdinal: number;
    position: number;
    relation: string;
    sourceEventSeq: number;
  }> = [],
  canvases: Array<{
    boardWidgetName: string | null;
    displayOrdinal: number;
    position: number;
    preferredHeight: number | null;
    sandbox: string | null;
    sourceEventSeq: number;
    title: string | null;
    url: string;
    viewId: string | null;
  }> = [],
) {
  return { canvases, carry, rows, sources };
}

function expectedRows(count: number, kind: ExpectedRow["kind"], revision = 1): ExpectedRow[] {
  return Array.from({ length: count }, (_, sourceEventSeq) => ({
    display_ordinal: sourceEventSeq,
    kind,
    revision,
    source_event_seq: sourceEventSeq,
  }));
}

function expectedCarry(
  kind: string,
  sourceEventSeqs: number[],
  relatedEventSeq: (sourceEventSeq: number) => number | null = () => null,
) {
  return sourceEventSeqs.map((sourceEventSeq, position) => ({
    kind,
    position,
    relatedEventSeq: relatedEventSeq(sourceEventSeq),
    sourceEventSeq,
  }));
}

export function expectedTtsCarryCapPrefixes(count: number) {
  return Array.from({ length: count }, (_prefix, lastSource) => {
    const firstSource = Math.max(0, lastSource - 63);
    const sources = Array.from(
      { length: lastSource - firstSource + 1 },
      (_source, index) => firstSource + index,
    );
    return expectedSnapshot(
      expectedRows(lastSource + 1, "assistant"),
      expectedCarry("tts_candidate", sources),
    );
  });
}

export function expectedStreamCarryCapPrefixes(count: number) {
  return Array.from({ length: count }, (_prefix, lastSource) => {
    const firstSource = Math.max(0, lastSource - 7);
    const sources = Array.from(
      { length: lastSource - firstSource + 1 },
      (_source, index) => firstSource + index,
    );
    return expectedSnapshot(
      expectedRows(lastSource + 1, "assistant"),
      expectedCarry("stream_error", sources),
    );
  });
}

export function expectedMessageCarryCapPrefixes(count: number) {
  return Array.from({ length: count }, (_prefix, lastSource) => {
    const firstSource = Math.max(0, lastSource - 15);
    const sources = Array.from(
      { length: lastSource - firstSource + 1 },
      (_source, index) => firstSource + index,
    );
    return expectedSnapshot(
      expectedRows(lastSource + 1, "opaque"),
      expectedCarry("message_tool", sources),
    );
  });
}

export function expectedHeartbeatCarryCapPrefixes() {
  return [
    expectedSnapshot([], expectedCarry("heartbeat_boundary", [0])),
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 }],
      expectedCarry("heartbeat_boundary", [1]),
    ),
  ];
}

export function expectedCanvasCarryCapPrefixes(count: number) {
  return Array.from({ length: count + 1 }, (_prefix, prefixIndex) => {
    if (prefixIndex === 0) {
      return expectedSnapshot(
        [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
        expectedCarry("tts_candidate", [0]),
      );
    }
    const lastSource = prefixIndex;
    const firstCanvasSource = Math.max(1, lastSource - 15);
    const canvasSources = Array.from(
      { length: lastSource - firstCanvasSource + 1 },
      (_source, index) => firstCanvasSource + index,
    );
    return expectedSnapshot(
      [
        { display_ordinal: 0, kind: "assistant", revision: 1 + lastSource, source_event_seq: 0 },
        ...Array.from({ length: lastSource }, (_row, index) => ({
          display_ordinal: index + 1,
          kind: "opaque" as const,
          revision: 1,
          source_event_seq: index + 1,
        })),
      ],
      [
        ...expectedCarry("canvas_pending", canvasSources, () => 0),
        ...expectedCarry("tts_candidate", [0]),
      ],
      [],
      canvasSources.map((sourceEventSeq, position) => ({
        boardWidgetName: null,
        displayOrdinal: 0,
        position,
        preferredHeight: null,
        sandbox: null,
        sourceEventSeq,
        title: null,
        url: `/__openclaw__/canvas/documents/cv_test/${sourceEventSeq - 1}.html`,
        viewId: `view-${sourceEventSeq - 1}`,
      })),
    );
  });
}

export const NEGATIVE_DISPLAY_EXPECTED_PREFIXES = {
  selectiveMessageMirror: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 }],
      expectedCarry("message_tool", [0]),
    ),
    expectedSnapshot(
      expectedRows(2, "opaque"),
      expectedCarry("message_tool", [0], () => 1),
    ),
    expectedSnapshot(expectedRows(3, "opaque"), [
      ...expectedCarry("message_tool", [0], () => 1),
      { kind: "message_tool", position: 1, relatedEventSeq: null, sourceEventSeq: 2 },
    ]),
    expectedSnapshot(expectedRows(4, "opaque"), [
      ...expectedCarry("message_tool", [0], () => 1),
      { kind: "message_tool", position: 1, relatedEventSeq: 3, sourceEventSeq: 2 },
    ]),
    expectedSnapshot(
      [
        ...expectedRows(4, "opaque"),
        { display_ordinal: 4, kind: "assistant", revision: 1, source_event_seq: 4 },
      ],
      expectedCarry("message_tool", [2], () => 3),
      [
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
        },
      ],
    ),
    expectedSnapshot(
      [
        ...expectedRows(4, "opaque"),
        { display_ordinal: 4, kind: "assistant", revision: 1, source_event_seq: 4 },
        { display_ordinal: 5, kind: "assistant", revision: 1, source_event_seq: 5 },
      ],
      [],
      [
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
        },
        {
          displayOrdinal: 5,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 2,
        },
      ],
    ),
  ],
  unmatchedDeliveryMirror: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 }],
      expectedCarry("message_tool", [0]),
    ),
    expectedSnapshot(
      expectedRows(2, "opaque"),
      expectedCarry("message_tool", [0], () => 1),
    ),
    expectedSnapshot(
      [
        ...expectedRows(2, "opaque"),
        { display_ordinal: 2, kind: "assistant", revision: 1, source_event_seq: 2 },
      ],
      expectedCarry("tts_candidate", [2]),
    ),
    expectedSnapshot(
      [
        ...expectedRows(2, "opaque"),
        { display_ordinal: 2, kind: "assistant", revision: 1, source_event_seq: 2 },
      ],
      expectedCarry("tts_candidate", [2]),
    ),
  ],
  forwardedMessageTool: [
    expectedSnapshot([{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 }]),
    expectedSnapshot(expectedRows(2, "opaque")),
    expectedSnapshot(expectedRows(2, "opaque")),
  ],
  forwardedHeartbeat: [
    expectedSnapshot([], expectedCarry("heartbeat_boundary", [0])),
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 1 }],
      expectedCarry("heartbeat_boundary", [0]),
    ),
    expectedSnapshot(
      [
        { display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 1 },
        { display_ordinal: 1, kind: "user", revision: 1, source_event_seq: 2 },
      ],
      [],
      [{ displayOrdinal: 1, position: 0, relation: "turn_boundary", sourceEventSeq: 0 }],
    ),
  ],
  settledStreamError: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      expectedCarry("stream_error", [0]),
    ),
    expectedSnapshot([
      { display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 },
      { display_ordinal: 1, kind: "user", revision: 1, source_event_seq: 1 },
    ]),
    expectedSnapshot(
      [
        { display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 },
        { display_ordinal: 1, kind: "user", revision: 1, source_event_seq: 1 },
        { display_ordinal: 2, kind: "assistant", revision: 1, source_event_seq: 2 },
      ],
      expectedCarry("tts_candidate", [2]),
    ),
  ],
  multipleStreamErrors: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      expectedCarry("stream_error", [0]),
    ),
    expectedSnapshot(expectedRows(2, "assistant"), expectedCarry("stream_error", [0, 1])),
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 2 }],
      expectedCarry("tts_candidate", [2]),
    ),
  ],
  structuredStreamError: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      expectedCarry("tts_candidate", [0]),
    ),
    expectedSnapshot(expectedRows(2, "assistant"), expectedCarry("tts_candidate", [0, 1])),
  ],
  mismatchedTts: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      expectedCarry("tts_candidate", [0]),
    ),
    expectedSnapshot(
      [
        { display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 },
        { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      ],
      expectedCarry("tts_candidate", [0]),
    ),
  ],
} as const;
