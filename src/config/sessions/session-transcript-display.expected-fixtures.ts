import { STATEFUL_DISPLAY_EXPECTED_PREFIXES } from "./session-transcript-display.test-support.js";

type ExpectedRow = {
  display_ordinal: number;
  kind: "assistant" | "opaque" | "user";
  revision: number;
  source_event_seq: number;
};

function expectedSnapshot(
  rows: ExpectedRow[],
  carry: Array<{
    deliveryEventSeq?: number;
    kind: string;
    position: number;
    relatedEventSeq: number | null;
    sourceEventSeq: number;
    sourceOccurrence?: number;
  }> = [],
  sources: Array<{
    displayOrdinal: number;
    position: number;
    relation: string;
    sourceEventSeq: number;
    sourceOccurrence?: number;
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

export function dryRunMessageToolEvents(): Record<string, unknown>[] {
  return [
    {
      id: "dry-run-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dry-run-call",
            name: "message",
            arguments: {
              action: "send",
              message: "Dry run",
              status: "dry_run",
            },
          },
        ],
      },
      type: "message",
    },
    {
      id: "dry-run-result",
      message: {
        role: "toolResult",
        toolCallId: "dry-run-call",
        toolName: "message",
        result: { ok: true },
      },
      type: "message",
    },
    {
      id: "dry-run-flush",
      message: { role: "assistant", content: "NO_REPLY" },
      type: "message",
    },
  ];
}

export function dryRunMessageToolResultEvents(): Record<string, unknown>[] {
  return [
    {
      id: "dry-result-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "dry-result-call",
            name: "message",
            arguments: { action: "send", message: "Dry result" },
          },
        ],
      },
      type: "message",
    },
    {
      id: "dry-result",
      message: {
        role: "toolResult",
        toolCallId: "dry-result-call",
        toolName: "message",
        result: { status: "dry_run" },
      },
      type: "message",
    },
    {
      id: "dry-result-flush",
      message: { role: "assistant", content: "NO_REPLY" },
      type: "message",
    },
  ];
}

export const NEGATIVE_DISPLAY_EXPECTED_PREFIXES = {
  dryRunResult: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 }],
      expectedCarry("message_tool", [0]),
    ),
    expectedSnapshot(expectedRows(2, "opaque"), expectedCarry("message_tool", [0])),
    expectedSnapshot(expectedRows(2, "opaque")),
  ],
  sameSourceMessageMirror: [
    expectedSnapshot(
      [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 }],
      [
        { kind: "message_tool", position: 0, relatedEventSeq: null, sourceEventSeq: 0 },
        {
          kind: "message_tool",
          position: 1,
          relatedEventSeq: null,
          sourceEventSeq: 0,
          sourceOccurrence: 1,
        },
      ],
    ),
    expectedSnapshot(expectedRows(2, "opaque"), [
      { kind: "message_tool", position: 0, relatedEventSeq: 1, sourceEventSeq: 0 },
      {
        kind: "message_tool",
        position: 1,
        relatedEventSeq: null,
        sourceEventSeq: 0,
        sourceOccurrence: 1,
      },
    ]),
    expectedSnapshot(expectedRows(3, "opaque"), [
      { kind: "message_tool", position: 0, relatedEventSeq: 1, sourceEventSeq: 0 },
      {
        kind: "message_tool",
        position: 1,
        relatedEventSeq: 2,
        sourceEventSeq: 0,
        sourceOccurrence: 1,
      },
    ]),
    expectedSnapshot(
      [
        ...expectedRows(3, "opaque"),
        { display_ordinal: 3, kind: "assistant", revision: 1, source_event_seq: 3 },
      ],
      [
        {
          kind: "message_tool",
          position: 0,
          relatedEventSeq: 2,
          sourceEventSeq: 0,
          sourceOccurrence: 1,
        },
        ...expectedCarry("tts_candidate", [3]),
      ],
      [
        {
          displayOrdinal: 3,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
        },
        {
          displayOrdinal: 3,
          position: 0,
          relation: "message_tool_result",
          sourceEventSeq: 1,
        },
      ],
    ),
    expectedSnapshot(
      [
        ...expectedRows(3, "opaque"),
        { display_ordinal: 3, kind: "assistant", revision: 1, source_event_seq: 3 },
        { display_ordinal: 4, kind: "assistant", revision: 1, source_event_seq: 4 },
      ],
      expectedCarry("tts_candidate", [3]),
      [
        {
          displayOrdinal: 3,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
        },
        {
          displayOrdinal: 3,
          position: 0,
          relation: "message_tool_result",
          sourceEventSeq: 1,
        },
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
          sourceOccurrence: 1,
        },
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_result",
          sourceEventSeq: 2,
        },
      ],
    ),
  ],
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
      [...expectedCarry("message_tool", [2], () => 3), ...expectedCarry("tts_candidate", [4])],
      [
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
        },
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_result",
          sourceEventSeq: 1,
        },
      ],
    ),
    expectedSnapshot(
      [
        ...expectedRows(4, "opaque"),
        { display_ordinal: 4, kind: "assistant", revision: 1, source_event_seq: 4 },
        { display_ordinal: 5, kind: "assistant", revision: 1, source_event_seq: 5 },
      ],
      expectedCarry("tts_candidate", [4]),
      [
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
        },
        {
          displayOrdinal: 4,
          position: 0,
          relation: "message_tool_result",
          sourceEventSeq: 1,
        },
        {
          displayOrdinal: 5,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 2,
        },
        {
          displayOrdinal: 5,
          position: 0,
          relation: "message_tool_result",
          sourceEventSeq: 3,
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

export const DELIVERY_CANVAS_EXPECTED_PREFIXES = [
  STATEFUL_DISPLAY_EXPECTED_PREFIXES.canvas[0],
  STATEFUL_DISPLAY_EXPECTED_PREFIXES.canvas[1],
  expectedSnapshot(
    [
      { display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 0 },
      { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      { display_ordinal: 2, kind: "opaque", revision: 1, source_event_seq: 2 },
    ],
    [
      {
        kind: "canvas_pending",
        position: 0,
        relatedEventSeq: 0,
        sourceEventSeq: 1,
      },
      { kind: "message_tool", position: 0, relatedEventSeq: null, sourceEventSeq: 2 },
      ...expectedCarry("tts_candidate", [0]),
    ],
    [],
    STATEFUL_DISPLAY_EXPECTED_PREFIXES.canvas[1].canvases.slice(),
  ),
  expectedSnapshot(
    [
      { display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 0 },
      { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      { display_ordinal: 2, kind: "opaque", revision: 1, source_event_seq: 2 },
      { display_ordinal: 3, kind: "opaque", revision: 1, source_event_seq: 3 },
    ],
    [
      {
        kind: "canvas_pending",
        position: 0,
        relatedEventSeq: 0,
        sourceEventSeq: 1,
      },
      { kind: "message_tool", position: 0, relatedEventSeq: 3, sourceEventSeq: 2 },
      ...expectedCarry("tts_candidate", [0]),
    ],
    [],
    STATEFUL_DISPLAY_EXPECTED_PREFIXES.canvas[1].canvases.slice(),
  ),
  expectedSnapshot(
    [
      { display_ordinal: 0, kind: "assistant", revision: 3, source_event_seq: 0 },
      { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      { display_ordinal: 2, kind: "opaque", revision: 1, source_event_seq: 2 },
      { display_ordinal: 3, kind: "opaque", revision: 1, source_event_seq: 3 },
      { display_ordinal: 4, kind: "assistant", revision: 2, source_event_seq: 4 },
    ],
    expectedCarry("tts_candidate", [0, 4]),
    [
      {
        displayOrdinal: 4,
        position: 0,
        relation: "message_tool_mirror",
        sourceEventSeq: 2,
      },
      {
        displayOrdinal: 4,
        position: 0,
        relation: "message_tool_result",
        sourceEventSeq: 3,
      },
    ],
    STATEFUL_DISPLAY_EXPECTED_PREFIXES.canvas[2].canvases.map((canvas) =>
      Object.assign({}, canvas, { displayOrdinal: 4 }),
    ),
  ),
] as const;
