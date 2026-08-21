import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  prepareSessionTranscriptDisplayProjection,
  type PreparedSessionTranscriptDisplayProjection,
} from "./session-transcript-display.js";
import {
  buildSessionTranscriptProjection,
  type SessionTranscriptProjectionSourceRow,
} from "./session-transcript-projection-rebuild.js";

type DatabaseScope = {
  agentId: string;
  env: NodeJS.ProcessEnv;
};

export function projectionRow(
  seq: number,
  event: Record<string, unknown>,
  createdAt = seq * 1_000,
): SessionTranscriptProjectionSourceRow {
  return { createdAt, event, seq };
}

export function projectionFixture(rows: SessionTranscriptProjectionSourceRow[]) {
  return buildSessionTranscriptProjection({
    rows,
    sessionId: "projection-session",
    sourceTranscriptUpdatedAt: 42,
  });
}

export function canvasUrlWithLength(length: number): string {
  const prefix = "/__openclaw__/canvas/documents/cv/";
  const segmentCount = 16;
  const contentLength = length - prefix.length - (segmentCount - 1);
  const baseLength = Math.floor(contentLength / segmentCount);
  const remainder = contentLength % segmentCount;
  const segments = Array.from({ length: segmentCount }, (_, index) =>
    "x".repeat(baseLength + (index < remainder ? 1 : 0)),
  );
  return `${prefix}${segments.join("/")}`;
}

export function readDisplayRowIdentities(scope: DatabaseScope, sessionId: string) {
  return openOpenClawAgentDatabase(scope)
    .db.prepare(
      "SELECT display_ordinal, row_id FROM session_transcript_display_rows WHERE session_id = ? ORDER BY display_ordinal",
    )
    .all(sessionId) as Array<{ display_ordinal: number; row_id: string }>;
}

export function serializeDisplayTables(scope: DatabaseScope): string {
  const db = openOpenClawAgentDatabase(scope).db;
  return [
    "session_transcript_display_rows",
    "session_transcript_display_row_sources",
    "session_transcript_display_canvas",
    "session_transcript_display_carry",
    "session_transcript_display_state",
  ]
    .flatMap((table) => db.prepare(`SELECT * FROM ${table}`).all())
    .map((value) => JSON.stringify(value))
    .join("\n");
}

export function readDisplaySnapshot(scope: DatabaseScope, sessionId: string) {
  const db = openOpenClawAgentDatabase(scope).db;
  const rows = db
    .prepare(
      "SELECT display_ordinal, kind, revision, source_event_seq FROM session_transcript_display_rows WHERE session_id = ? ORDER BY display_ordinal",
    )
    .all(sessionId) as Array<{
    display_ordinal: number;
    kind: string;
    revision: number;
    source_event_seq: number;
  }>;
  const ordinalByRowId = new Map(
    (
      db
        .prepare(
          "SELECT row_id, display_ordinal FROM session_transcript_display_rows WHERE session_id = ?",
        )
        .all(sessionId) as Array<{ display_ordinal: number; row_id: string }>
    ).map((entry) => [entry.row_id, entry.display_ordinal]),
  );
  const sources = (
    db
      .prepare(
        "SELECT row_id, relation, position, source_event_seq, source_occurrence FROM session_transcript_display_row_sources WHERE session_id = ? ORDER BY row_id, relation, position",
      )
      .all(sessionId) as Array<{
      position: number;
      relation: string;
      row_id: string;
      source_event_seq: number;
      source_occurrence: number;
    }>
  )
    .map((source) => {
      const result = {
        displayOrdinal: ordinalByRowId.get(source.row_id),
        position: source.position,
        relation: source.relation,
        sourceEventSeq: source.source_event_seq,
      };
      return source.source_occurrence === 0
        ? result
        : Object.assign(result, { sourceOccurrence: source.source_occurrence });
    })
    .toSorted(
      (left, right) =>
        (left.displayOrdinal ?? -1) - (right.displayOrdinal ?? -1) ||
        left.relation.localeCompare(right.relation) ||
        left.position - right.position,
    );
  const canvases = (
    db
      .prepare(
        "SELECT row_id, position, source_event_seq, url, view_id, title, preferred_height, sandbox, board_widget_name FROM session_transcript_display_canvas WHERE session_id = ? ORDER BY row_id, position",
      )
      .all(sessionId) as Array<{
      board_widget_name: string | null;
      position: number;
      preferred_height: number | null;
      row_id: string;
      sandbox: string | null;
      source_event_seq: number;
      title: string | null;
      url: string;
      view_id: string | null;
    }>
  )
    .map((canvas) => ({
      boardWidgetName: canvas.board_widget_name,
      displayOrdinal: ordinalByRowId.get(canvas.row_id),
      position: canvas.position,
      preferredHeight: canvas.preferred_height,
      sandbox: canvas.sandbox,
      sourceEventSeq: canvas.source_event_seq,
      title: canvas.title,
      url: canvas.url,
      viewId: canvas.view_id,
    }))
    .toSorted(
      (left, right) =>
        (left.displayOrdinal ?? -1) - (right.displayOrdinal ?? -1) ||
        left.position - right.position,
    );
  const carry = db
    .prepare(
      "SELECT kind, position, source_event_seq, source_occurrence, related_event_seq, delivery_event_seq FROM session_transcript_display_carry WHERE session_id = ? ORDER BY kind, position",
    )
    .all(sessionId)
    .map((entry) => {
      const carryRow = entry as {
        kind: string;
        delivery_event_seq: number | null;
        position: number;
        related_event_seq: number | null;
        source_event_seq: number;
        source_occurrence: number;
      };
      const result = {
        kind: carryRow.kind,
        position: carryRow.position,
        relatedEventSeq: carryRow.related_event_seq,
        sourceEventSeq: carryRow.source_event_seq,
      };
      if (carryRow.delivery_event_seq !== null) {
        Object.assign(result, { deliveryEventSeq: carryRow.delivery_event_seq });
      }
      if (carryRow.source_occurrence !== 0) {
        Object.assign(result, { sourceOccurrence: carryRow.source_occurrence });
      }
      return result;
    });
  return { canvases, carry, rows, sources };
}

export function plannedDisplaySnapshot(rows: SessionTranscriptProjectionSourceRow[]) {
  return normalizeDisplayPlan(prepareSessionTranscriptDisplayProjection(rows));
}

function normalizeDisplayPlan(plan: PreparedSessionTranscriptDisplayProjection) {
  return {
    canvases: plan.rows
      .flatMap((plannedRow) =>
        plannedRow.canvases.map((canvas) => ({
          boardWidgetName: canvas.boardWidgetName ?? null,
          displayOrdinal: plannedRow.displayOrdinal,
          position: canvas.position,
          preferredHeight: canvas.preferredHeight ?? null,
          sandbox: canvas.sandbox ?? null,
          sourceEventSeq: canvas.sourceEventSeq,
          title: canvas.title ?? null,
          url: canvas.url,
          viewId: canvas.viewId ?? null,
        })),
      )
      .toSorted(
        (left, right) =>
          left.displayOrdinal - right.displayOrdinal || left.position - right.position,
      ),
    carry: plan.carry
      .map((entry) => {
        const result = {
          kind: entry.kind,
          position: entry.position,
          relatedEventSeq: entry.relatedEventSeq ?? null,
          sourceEventSeq: entry.sourceEventSeq,
        };
        if (entry.deliveryEventSeq !== undefined) {
          Object.assign(result, { deliveryEventSeq: entry.deliveryEventSeq });
        }
        if (entry.sourceOccurrence !== 0) {
          Object.assign(result, { sourceOccurrence: entry.sourceOccurrence });
        }
        return result;
      })
      .toSorted(
        (left, right) => left.kind.localeCompare(right.kind) || left.position - right.position,
      ),
    rows: plan.rows.map((entry) => ({
      display_ordinal: entry.displayOrdinal,
      kind: entry.kind,
      revision: entry.revision,
      source_event_seq: entry.sourceEventSeq,
    })),
    sources: plan.rows
      .flatMap((entry) =>
        entry.semanticSources.map((source) => {
          const result = {
            displayOrdinal: entry.displayOrdinal,
            position: source.position,
            relation: source.relation,
            sourceEventSeq: source.sourceEventSeq,
          };
          return source.sourceOccurrence === 0
            ? result
            : Object.assign(result, { sourceOccurrence: source.sourceOccurrence });
        }),
      )
      .toSorted(
        (left, right) =>
          left.displayOrdinal - right.displayOrdinal ||
          left.relation.localeCompare(right.relation) ||
          left.position - right.position,
      ),
  };
}

export const STATEFUL_DISPLAY_EXPECTED_PREFIXES = {
  heartbeat: [
    {
      canvases: [],
      carry: [
        {
          kind: "heartbeat_boundary",
          position: 0,
          relatedEventSeq: null,
          sourceEventSeq: 0,
        },
      ],
      rows: [],
      sources: [],
    },
    {
      canvases: [],
      carry: [
        {
          kind: "heartbeat_boundary",
          position: 0,
          relatedEventSeq: null,
          sourceEventSeq: 0,
        },
      ],
      rows: [],
      sources: [],
    },
    {
      canvases: [],
      carry: [
        {
          kind: "heartbeat_boundary",
          position: 0,
          relatedEventSeq: null,
          sourceEventSeq: 0,
        },
      ],
      rows: [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 2 }],
      sources: [],
    },
    {
      canvases: [],
      carry: [],
      rows: [
        { display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 2 },
        { display_ordinal: 1, kind: "user", revision: 1, source_event_seq: 3 },
      ],
      sources: [
        {
          displayOrdinal: 1,
          position: 0,
          relation: "turn_boundary",
          sourceEventSeq: 0,
        },
      ],
    },
  ],
  streamError: [
    {
      canvases: [],
      carry: [{ kind: "stream_error", position: 0, relatedEventSeq: null, sourceEventSeq: 0 }],
      rows: [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      sources: [],
    },
    {
      canvases: [],
      carry: [{ kind: "stream_error", position: 0, relatedEventSeq: null, sourceEventSeq: 0 }],
      rows: [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      sources: [],
    },
    {
      canvases: [],
      carry: [{ kind: "tts_candidate", position: 0, relatedEventSeq: null, sourceEventSeq: 2 }],
      rows: [{ display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 2 }],
      sources: [],
    },
  ],
  messageTool: [
    {
      canvases: [],
      carry: [{ kind: "message_tool", position: 0, relatedEventSeq: null, sourceEventSeq: 0 }],
      rows: [{ display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 }],
      sources: [],
    },
    {
      canvases: [],
      carry: [{ kind: "message_tool", position: 0, relatedEventSeq: 1, sourceEventSeq: 0 }],
      rows: [
        { display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 },
        { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      ],
      sources: [],
    },
    {
      canvases: [],
      carry: [],
      rows: [
        { display_ordinal: 0, kind: "opaque", revision: 1, source_event_seq: 0 },
        { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
        { display_ordinal: 2, kind: "assistant", revision: 1, source_event_seq: 2 },
      ],
      sources: [
        {
          displayOrdinal: 2,
          position: 0,
          relation: "message_tool_mirror",
          sourceEventSeq: 0,
        },
        {
          displayOrdinal: 2,
          position: 0,
          relation: "message_tool_result",
          sourceEventSeq: 1,
        },
      ],
    },
  ],
  tts: [
    {
      canvases: [],
      carry: [{ kind: "tts_candidate", position: 0, relatedEventSeq: null, sourceEventSeq: 0 }],
      rows: [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      sources: [],
    },
    {
      canvases: [],
      carry: [{ kind: "tts_candidate", position: 0, relatedEventSeq: null, sourceEventSeq: 0 }],
      rows: [
        { display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 },
        { display_ordinal: 1, kind: "user", revision: 1, source_event_seq: 1 },
      ],
      sources: [],
    },
    {
      canvases: [],
      carry: [{ kind: "tts_candidate", position: 0, relatedEventSeq: null, sourceEventSeq: 0 }],
      rows: [
        { display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 0 },
        { display_ordinal: 1, kind: "user", revision: 1, source_event_seq: 1 },
      ],
      sources: [
        {
          displayOrdinal: 0,
          position: 0,
          relation: "tts_supplement",
          sourceEventSeq: 2,
        },
      ],
    },
  ],
  canvas: [
    {
      canvases: [],
      carry: [{ kind: "tts_candidate", position: 0, relatedEventSeq: null, sourceEventSeq: 0 }],
      rows: [{ display_ordinal: 0, kind: "assistant", revision: 1, source_event_seq: 0 }],
      sources: [],
    },
    {
      canvases: [
        {
          boardWidgetName: "status",
          displayOrdinal: 0,
          position: 0,
          preferredHeight: 1200,
          sandbox: "scripts",
          sourceEventSeq: 1,
          title: "Canvas title",
          url: "/__openclaw__/canvas/documents/cv_status/assets/status%20page.html",
          viewId: "cv_status",
        },
      ],
      carry: [
        {
          kind: "canvas_pending",
          position: 0,
          relatedEventSeq: 0,
          sourceEventSeq: 1,
        },
        { kind: "tts_candidate", position: 0, relatedEventSeq: null, sourceEventSeq: 0 },
      ],
      rows: [
        { display_ordinal: 0, kind: "assistant", revision: 2, source_event_seq: 0 },
        { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
      ],
      sources: [],
    },
    {
      canvases: [
        {
          boardWidgetName: "status",
          displayOrdinal: 2,
          position: 0,
          preferredHeight: 1200,
          sandbox: "scripts",
          sourceEventSeq: 1,
          title: "Canvas title",
          url: "/__openclaw__/canvas/documents/cv_status/assets/status%20page.html",
          viewId: "cv_status",
        },
      ],
      carry: [
        { kind: "tts_candidate", position: 0, relatedEventSeq: null, sourceEventSeq: 0 },
        { kind: "tts_candidate", position: 1, relatedEventSeq: null, sourceEventSeq: 2 },
      ],
      rows: [
        { display_ordinal: 0, kind: "assistant", revision: 3, source_event_seq: 0 },
        { display_ordinal: 1, kind: "opaque", revision: 1, source_event_seq: 1 },
        { display_ordinal: 2, kind: "assistant", revision: 2, source_event_seq: 2 },
      ],
      sources: [],
    },
  ],
} as const;
