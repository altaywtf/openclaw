import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  prepareSessionTranscriptDisplayProjection,
  type PreparedSessionTranscriptDisplayProjection,
} from "./session-transcript-display.js";
import type { SessionTranscriptProjectionSourceRow } from "./session-transcript-projection-rebuild.js";

type DatabaseScope = {
  agentId: string;
  env: NodeJS.ProcessEnv;
};

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
        "SELECT row_id, relation, position, source_event_seq FROM session_transcript_display_row_sources WHERE session_id = ? ORDER BY row_id, relation, position",
      )
      .all(sessionId) as Array<{
      position: number;
      relation: string;
      row_id: string;
      source_event_seq: number;
    }>
  )
    .map((source) => ({
      displayOrdinal: ordinalByRowId.get(source.row_id),
      position: source.position,
      relation: source.relation,
      sourceEventSeq: source.source_event_seq,
    }))
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
      "SELECT kind, position, source_event_seq, related_event_seq FROM session_transcript_display_carry WHERE session_id = ? ORDER BY kind, position",
    )
    .all(sessionId)
    .map((entry) => {
      const carryRow = entry as {
        kind: string;
        position: number;
        related_event_seq: number | null;
        source_event_seq: number;
      };
      return {
        kind: carryRow.kind,
        position: carryRow.position,
        relatedEventSeq: carryRow.related_event_seq,
        sourceEventSeq: carryRow.source_event_seq,
      };
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
      .map((entry) => ({
        kind: entry.kind,
        position: entry.position,
        relatedEventSeq: entry.relatedEventSeq ?? null,
        sourceEventSeq: entry.sourceEventSeq,
      }))
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
        entry.semanticSources.map((source) => ({
          displayOrdinal: entry.displayOrdinal,
          position: source.position,
          relation: source.relation,
          sourceEventSeq: source.sourceEventSeq,
        })),
      )
      .toSorted(
        (left, right) =>
          left.displayOrdinal - right.displayOrdinal ||
          left.relation.localeCompare(right.relation) ||
          left.position - right.position,
      ),
  };
}
