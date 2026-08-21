import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { STREAM_ERROR_FALLBACK_TEXT } from "../../agents/stream-message-shared.js";
import { HEARTBEAT_PROMPT } from "../../auto-reply/heartbeat.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn, upsertSessionEntryCore } from "./session-accessor.js";
import {
  appendEligibleSessionTranscriptDisplayRowInTransaction,
  prepareSessionTranscriptDisplayProjection,
  prepareSessionTranscriptDisplayRows,
} from "./session-transcript-display.js";
import {
  buildSessionTranscriptProjection,
  type SessionTranscriptProjectionSourceRow,
} from "./session-transcript-projection-rebuild.js";
import { reconcileSessionTranscriptDisplayProjection } from "./session-transcript-reconcile.js";

const SESSION_ID = "projection-session";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function row(
  seq: number,
  event: Record<string, unknown>,
  createdAt = seq * 1_000,
): SessionTranscriptProjectionSourceRow {
  return { createdAt, event, seq };
}

function projection(rows: SessionTranscriptProjectionSourceRow[]) {
  return buildSessionTranscriptProjection({
    rows,
    sessionId: SESSION_ID,
    sourceTranscriptUpdatedAt: 42,
  });
}

describe("canonical session transcript projection", () => {
  let env: NodeJS.ProcessEnv;
  const scope = {
    agentId: "main",
    sessionId: SESSION_ID,
    sessionKey: "agent:main:projection-session",
  };

  beforeEach(() => {
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-transcript-projection-"),
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  function readProjectionSourceRows(): SessionTranscriptProjectionSourceRow[] {
    return openOpenClawAgentDatabase({ agentId: scope.agentId, env })
      .db.prepare(
        "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(scope.sessionId)
      .map((entry) => {
        const sourceRow = entry as { created_at: number; event_json: string; seq: number };
        return {
          createdAt: sourceRow.created_at,
          event: JSON.parse(sourceRow.event_json),
          seq: sourceRow.seq,
        };
      });
  }

  function readDisplayRows(sessionId = scope.sessionId) {
    return openOpenClawAgentDatabase({ agentId: scope.agentId, env })
      .db.prepare(
        "SELECT display_ordinal, kind, source_event_seq FROM session_transcript_display_rows WHERE session_id = ? ORDER BY display_ordinal",
      )
      .all(sessionId);
  }

  function readDisplaySnapshot(sessionId: string) {
    const db = openOpenClawAgentDatabase({ agentId: scope.agentId, env }).db;
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

  function plannedDisplaySnapshot(rows: SessionTranscriptProjectionSourceRow[]) {
    const planned = prepareSessionTranscriptDisplayProjection(rows);
    return {
      canvases: planned.rows
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
      carry: planned.carry
        .map((entry) => ({
          kind: entry.kind,
          position: entry.position,
          relatedEventSeq: entry.relatedEventSeq ?? null,
          sourceEventSeq: entry.sourceEventSeq,
        }))
        .toSorted(
          (left, right) => left.kind.localeCompare(right.kind) || left.position - right.position,
        ),
      rows: planned.rows.map((entry) => ({
        display_ordinal: entry.displayOrdinal,
        kind: entry.kind,
        revision: entry.revision,
        source_event_seq: entry.sourceEventSeq,
      })),
      sources: planned.rows
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

  async function expectIncrementalDisplayParity(name: string, events: Record<string, unknown>[]) {
    const sessionId = `${scope.sessionId}-${name}`;
    const sessionKey = `${scope.sessionKey}-${name}`;
    await upsertSessionEntryCore(
      { agentId: scope.agentId, env, sessionKey },
      { sessionId, updatedAt: 1 },
    );
    const sourceRows: SessionTranscriptProjectionSourceRow[] = [];
    for (const [seq, event] of events.entries()) {
      runOpenClawAgentWriteTransaction(
        (database) => {
          database.db
            .prepare(
              "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(sessionId, seq, JSON.stringify(event), seq + 1);
          appendEligibleSessionTranscriptDisplayRowInTransaction(database.db, {
            event,
            seq,
            sessionId,
          });
        },
        { agentId: scope.agentId, env },
      );
      sourceRows.push(row(seq, event, seq + 1));
      expect(readDisplaySnapshot(sessionId), `prefix ${seq} of ${name}`).toEqual(
        plannedDisplaySnapshot(sourceRows),
      );
    }
  }

  it("projects one deterministic active branch for both rebuild owners", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(1, {
        id: "root",
        message: { content: "root text", role: "user" },
        parentId: null,
        type: "message",
      }),
      row(2, {
        id: "abandoned",
        message: { content: "abandoned text", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
      row(3, {
        id: "active",
        message: { content: "active text", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
    ]);

    expect(result).toMatchObject({
      activeEventCount: 2,
      activeMessageCount: 2,
      leafEventId: "active",
      sessionId: SESSION_ID,
      sourceIndexedSeq: 3,
      sourceTranscriptUpdatedAt: 42,
    });
    expect(result.activeRows).toEqual([
      { activePosition: 0, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, eventSeq: 3, messagePosition: 1 },
    ]);
    expect(
      result.displayRows.map(({ displayOrdinal, kind, sourceEventSeq }) => ({
        displayOrdinal,
        kind,
        sourceEventSeq,
      })),
    ).toEqual([
      { displayOrdinal: 0, kind: "user", sourceEventSeq: 1 },
      { displayOrdinal: 1, kind: "assistant", sourceEventSeq: 3 },
    ]);
    expect(result.ftsRows).toEqual([
      { messageId: "root", role: "user", text: "root text", timestamp: 1_000 },
      { messageId: "active", role: "assistant", text: "active text", timestamp: 3_000 },
    ]);
  });

  it("matches incremental append and rebuild after excluding the header and abandoned branch", async () => {
    await persistSessionTranscriptTurn(
      { ...scope, env },
      {
        messages: [
          {
            eventId: "root",
            maintainDisplayProjection: true,
            parentId: null,
            message: { role: "user", content: "root" },
          },
          {
            eventId: "abandoned",
            maintainDisplayProjection: true,
            parentId: "root",
            message: { role: "assistant", content: "abandoned" },
          },
          {
            eventId: "active",
            maintainDisplayProjection: true,
            parentId: "root",
            message: { role: "assistant", content: "active" },
          },
        ],
        touchSessionEntry: false,
      },
    );
    await reconcileSessionTranscriptDisplayProjection({ agentId: scope.agentId, env });

    const planned = prepareSessionTranscriptDisplayRows(readProjectionSourceRows()).map(
      ({ displayOrdinal, kind, sourceEventSeq }) => ({
        display_ordinal: displayOrdinal,
        kind,
        source_event_seq: sourceEventSeq,
      }),
    );
    expect(readDisplayRows()).toEqual(planned);
    expect(planned).toEqual([
      { display_ordinal: 0, kind: "user", source_event_seq: 1 },
      { display_ordinal: 1, kind: "assistant", source_event_seq: 3 },
    ]);
  });

  it("keeps incremental and rebuild semantics equal after every stateful prefix", async () => {
    const message = (id: string, value: Record<string, unknown>) => ({
      id,
      message: value,
      type: "message",
    });
    const canvasDetails = (url: string, id: string) => ({
      mcpAppPreview: {
        kind: "canvas",
        presentation: {
          preferred_height: 1400,
          sandbox: "scripts",
          target: "assistant_message",
          title: "Canvas title",
        },
        view: { boardWidgetName: "status", id, url },
      },
    });
    await expectIncrementalDisplayParity("heartbeat", [
      message("heartbeat-user", { role: "user", content: HEARTBEAT_PROMPT }),
      message("heartbeat-ok", { role: "assistant", content: "HEARTBEAT_OK" }),
      message("heartbeat-system", { role: "system", content: "internal" }),
      message("heartbeat-visible", { role: "user", content: "visible" }),
    ]);
    await expectIncrementalDisplayParity("stream-error", [
      message("stream-error", {
        role: "assistant",
        content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
        stopReason: "error",
      }),
      message("stream-hidden", { role: "assistant", content: "NO_REPLY" }),
      message("stream-repair", { role: "assistant", content: "Recovered reply" }),
    ]);
    await expectIncrementalDisplayParity("message-tool", [
      message("message-call", {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-message",
            name: "message",
            arguments: { action: "send", message: "RAW_TOOL_CALL_SENTINEL" },
          },
        ],
      }),
      message("message-result", {
        role: "toolResult",
        toolCallId: "call-message",
        toolName: "message",
        content: [{ type: "text", text: "RAW_TOOL_RESULT_SENTINEL" }],
        details: { sourceReplyRoute: "current-source" },
        result: { ok: true },
      }),
      message("message-flush", { role: "assistant", content: "NO_REPLY" }),
    ]);
    await expectIncrementalDisplayParity("tts", [
      message("tts-target", { role: "assistant", content: "Spoken answer" }),
      message("tts-intervening-user", { role: "user", content: "later prompt" }),
      message("tts-supplement", {
        role: "assistant",
        content: [
          { type: "text", text: "Audio reply" },
          { type: "audio", url: "/media/tts.mp3" },
        ],
        openclawTtsSupplement: { spokenText: "Spoken answer" },
      }),
    ]);
    await expectIncrementalDisplayParity("canvas", [
      message("canvas-target", { role: "assistant", content: "Initial assistant" }),
      message("canvas-tool", {
        role: "toolResult",
        toolCallId: "canvas-call",
        toolName: "canvas",
        content: [{ type: "text", text: "RAW_CANVAS_RESULT_SENTINEL" }],
        details: canvasDetails(
          "/__openclaw__/canvas/documents/cv_status/assets/status%20page.html",
          "cv_status",
        ),
      }),
      message("canvas-next-assistant", { role: "assistant", content: "Final assistant" }),
    ]);

    const privacyDatabase = openOpenClawAgentDatabase({ agentId: scope.agentId, env }).db;
    const serialized = [
      "session_transcript_display_rows",
      "session_transcript_display_row_sources",
      "session_transcript_display_canvas",
      "session_transcript_display_carry",
      "session_transcript_display_state",
    ]
      .flatMap((table) => privacyDatabase.prepare(`SELECT * FROM ${table}`).all())
      .map((value) => JSON.stringify(value))
      .join("\n");
    expect(serialized).not.toContain("RAW_TOOL_CALL_SENTINEL");
    expect(serialized).not.toContain("RAW_TOOL_RESULT_SENTINEL");
    expect(serialized).not.toContain("RAW_CANVAS_RESULT_SENTINEL");
  });

  it("applies deterministic carry caps and canvas v1 bounds", () => {
    const assistantRows = Array.from({ length: 65 }, (_, seq) =>
      row(seq, {
        id: `assistant-${seq}`,
        message: { role: "assistant", content: `answer ${seq}` },
        type: "message",
      }),
    );
    const result = prepareSessionTranscriptDisplayProjection(assistantRows);
    expect(result.carry.filter((entry) => entry.kind === "tts_candidate")).toEqual(
      Array.from({ length: 64 }, (_, position) => ({
        kind: "tts_candidate",
        position,
        sourceEventSeq: position + 1,
      })),
    );

    const canvas = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "assistant",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      row(1, {
        id: "canvas",
        message: {
          role: "toolResult",
          toolName: "canvas",
          details: {
            mcpAppPreview: {
              kind: "canvas",
              presentation: {
                preferred_height: 50_000,
                sandbox: "scripts",
                target: "assistant_message",
                title: "x".repeat(300),
              },
              view: {
                boardWidgetName: "status",
                id: "cv_status",
                url: "/__openclaw__/canvas/documents/cv_status/index%20page.html",
              },
            },
          },
        },
        type: "message",
      }),
    ]).rows[0]?.canvases[0];
    expect(canvas).toMatchObject({
      boardWidgetName: "status",
      preferredHeight: 1200,
      sandbox: "scripts",
      sourceEventSeq: 1,
      url: "/__openclaw__/canvas/documents/cv_status/index%20page.html",
      viewId: "cv_status",
    });
    expect(canvas?.title).toHaveLength(256);

    const streamCarry = prepareSessionTranscriptDisplayProjection(
      Array.from({ length: 9 }, (_, seq) =>
        row(seq, {
          id: `stream-${seq}`,
          message: {
            role: "assistant",
            content: STREAM_ERROR_FALLBACK_TEXT,
            stopReason: "error",
          },
          type: "message",
        }),
      ),
    ).carry.filter((entry) => entry.kind === "stream_error");
    expect(streamCarry.map((entry) => entry.sourceEventSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const messageCarry = prepareSessionTranscriptDisplayProjection(
      Array.from({ length: 17 }, (_, seq) =>
        row(seq, {
          id: `message-${seq}`,
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `call-${seq}`,
                name: "message",
                arguments: { action: "send", message: `message ${seq}` },
              },
            ],
          },
          type: "message",
        }),
      ),
    ).carry.filter((entry) => entry.kind === "message_tool");
    expect(messageCarry.map((entry) => entry.sourceEventSeq)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );

    const heartbeatCarry = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "heartbeat-0",
        message: { role: "user", content: HEARTBEAT_PROMPT },
        type: "message",
      }),
      row(1, {
        id: "heartbeat-1",
        message: { role: "user", content: HEARTBEAT_PROMPT },
        type: "message",
      }),
    ]).carry.filter((entry) => entry.kind === "heartbeat_boundary");
    expect(heartbeatCarry).toEqual([
      { kind: "heartbeat_boundary", position: 0, sourceEventSeq: 1 },
    ]);

    const canvasProjection = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "canvas-target",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      ...Array.from({ length: 17 }, (_, index) =>
        row(index + 1, {
          id: `canvas-${index}`,
          message: {
            role: "toolResult",
            toolName: "canvas",
            details: {
              mcpAppPreview: {
                kind: "canvas",
                presentation: { target: "assistant_message" },
                view: {
                  id: `view-${index}`,
                  url: `/__openclaw__/canvas/documents/cv_test/${index}.html`,
                },
              },
            },
          },
          type: "message",
        }),
      ),
    ]);
    expect(
      canvasProjection.carry
        .filter((entry) => entry.kind === "canvas_pending")
        .map((entry) => entry.sourceEventSeq),
    ).toEqual(Array.from({ length: 16 }, (_, index) => index + 2));
    expect(canvasProjection.rows[0]?.canvases.map((entry) => entry.sourceEventSeq)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 2),
    );
  });

  it.each([
    "https://example.com/canvas",
    "/__openclaw__/canvas/documents/cv_test/../index.html",
    "/__openclaw__/canvas/documents/cv_test/%2findex.html",
    "/__openclaw__/canvas/documents/cv_test/%2Findex.html",
    "/__openclaw__/canvas/documents/cv_test/%zz",
    "/__openclaw__/canvas/documents/cv_test/index.html?token=secret",
    "/__openclaw__/canvas/documents/cv_test/index.html#fragment",
    "/__openclaw__/canvas/documents/cv_test/",
    `/__openclaw__/canvas/documents/cv_test/${"x".repeat(129)}`,
    "/__openclaw__/canvas/documents/cv_test/%00index.html",
    "/__openclaw__/canvas/documents/cv_test/name%3Avalue",
  ])("rejects unsafe persisted canvas URL %s", (url) => {
    const result = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "assistant",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      row(1, {
        id: "canvas",
        message: {
          role: "toolResult",
          toolName: "canvas",
          details: {
            mcpAppPreview: {
              kind: "canvas",
              presentation: { target: "assistant_message" },
              view: { id: "cv_test", url },
            },
          },
        },
        type: "message",
      }),
    ]);
    expect(result.rows.flatMap((entry) => entry.canvases)).toEqual([]);
  });

  it("caps and deduplicates canvas facts while omitting unsupported fields", () => {
    const previews = Array.from({ length: 17 }, (_, index) => ({
      type: "canvas",
      preview: {
        boardWidgetName: "Invalid Widget",
        className: "private-class",
        kind: "canvas",
        preferredHeight: 100,
        render: "url",
        sandbox: "trusted",
        style: "color:red",
        surface: "assistant_message",
        title: `Canvas ${index}`,
        url: `/__openclaw__/canvas/documents/cv_test/${index}.html`,
        viewId: index === 16 ? "view-15" : `view-${index}`,
      },
      rawText: "RAW_CANVAS_TEXT",
    }));
    const result = prepareSessionTranscriptDisplayProjection([
      row(0, {
        id: "assistant",
        message: { role: "assistant", content: "target" },
        type: "message",
      }),
      row(1, {
        id: "canvas",
        message: {
          role: "toolResult",
          toolName: "canvas",
          content: previews,
        },
        type: "message",
      }),
    ]);
    const canvases = result.rows[0]?.canvases ?? [];
    expect(canvases).toHaveLength(16);
    expect(canvases.every((canvas) => canvas.preferredHeight === undefined)).toBe(true);
    expect(canvases.every((canvas) => canvas.sandbox === undefined)).toBe(true);
    expect(canvases.every((canvas) => canvas.boardWidgetName === undefined)).toBe(true);
    expect(JSON.stringify(canvases)).not.toContain("RAW_CANVAS_TEXT");
    expect(JSON.stringify(canvases)).not.toContain("private-class");
    expect(JSON.stringify(canvases)).not.toContain("color:red");
  });

  it("keeps persisted row timestamps for timestamp-less and invalid-timestamp messages", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(
        1,
        {
          id: "old-user",
          message: { content: [{ text: "old content", type: "text" }], role: "user" },
          parentId: null,
          type: "message",
        },
        1_700_000_000_000,
      ),
      row(
        2,
        {
          id: "invalid-timestamp",
          message: { content: "still old", role: "assistant" },
          parentId: "old-user",
          timestamp: "not a date",
          type: "message",
        },
        1_700_000_001_000,
      ),
    ]);

    expect(result.ftsRows.map(({ messageId, timestamp }) => ({ messageId, timestamp }))).toEqual([
      { messageId: "old-user", timestamp: 1_700_000_000_000 },
      { messageId: "invalid-timestamp", timestamp: 1_700_000_001_000 },
    ]);
  });

  it("respects a leaf-control rewind without indexing the abandoned continuation", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(1, {
        id: "root",
        message: { content: "keep", role: "user" },
        parentId: null,
        type: "message",
      }),
      row(2, {
        id: "abandoned",
        message: { content: "remove", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
      row(3, {
        appendParentId: "root",
        id: "rewind",
        parentId: "abandoned",
        targetId: "root",
        type: "leaf",
      }),
    ]);

    expect(result.leafEventId).toBe("root");
    expect(result.activeRows).toEqual([{ activePosition: 0, eventSeq: 1, messagePosition: 0 }]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual(["root"]);
  });

  it("keeps legacy flat-message ordering and searchable identities", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 1 }),
      row(1, {
        id: "legacy-user",
        message: { content: "first", role: "user" },
        type: "message",
      }),
      row(2, {
        id: "legacy-assistant",
        message: { content: "second", role: "assistant" },
        type: "message",
      }),
    ]);

    expect(result.activeRows).toEqual([
      { activePosition: 0, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, eventSeq: 2, messagePosition: 1 },
    ]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual([
      "legacy-user",
      "legacy-assistant",
    ]);
    expect(result.sourceIndexedSeq).toBe(2);
  });
});
