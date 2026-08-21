import { randomUUID } from "node:crypto";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
} from "../../auto-reply/heartbeat-filter.js";
import { HEARTBEAT_PROMPT } from "../../auto-reply/heartbeat.js";
import {
  isForwardedSessionsSend,
  isPureStreamError,
  isRenderableAssistant,
  isSuppressedControlReply,
  isTtsSupplement,
  normalizeHistoryType,
  readCanvasPreviews,
  readMessageText,
  readMessageToolCalls,
  readMessageToolResult,
  readTtsMarker,
  ttsMarkerMatches,
  type MessageToolCall,
  type PreparedSessionTranscriptDisplayCanvas,
} from "./session-transcript-display-classification.js";
import {
  isCanonicalSessionTranscriptEntry,
  parseSessionTranscriptTreeEntry,
} from "./transcript-tree.js";
import { selectVisibleTranscriptEventEntries } from "./transcript-visible-events.js";

export const SESSION_TRANSCRIPT_DISPLAY_ROW_VERSION = 1;
export const SESSION_TRANSCRIPT_DISPLAY_SEMANTICS_VERSION = 1;
export const DISPLAY_CARRY_LIMITS = {
  canvas_pending: 16,
  heartbeat_boundary: 1,
  message_tool: 16,
  stream_error: 8,
  tts_candidate: 64,
} as const;

export type SessionTranscriptDisplayRowKind =
  | "assistant"
  | "compaction"
  | "opaque"
  | "reset"
  | "user";
export type SessionTranscriptDisplayRelation =
  | "message_tool_mirror"
  | "tts_supplement"
  | "turn_boundary";
export type SessionTranscriptDisplayCarryKind = keyof typeof DISPLAY_CARRY_LIMITS;
export type PreparedSessionTranscriptDisplaySource = {
  position: number;
  relation: SessionTranscriptDisplayRelation;
  sourceEventSeq: number;
};
export { type PreparedSessionTranscriptDisplayCanvas } from "./session-transcript-display-classification.js";
export type PreparedSessionTranscriptDisplayCarry = {
  kind: SessionTranscriptDisplayCarryKind;
  position: number;
  relatedEventSeq?: number;
  sourceEventSeq: number;
};
type PlannedSessionTranscriptDisplayRow = {
  canvases: PreparedSessionTranscriptDisplayCanvas[];
  kind: SessionTranscriptDisplayRowKind;
  semanticSources: PreparedSessionTranscriptDisplaySource[];
  sourceEventSeq: number;
};
export type PreparedSessionTranscriptDisplayRow = PlannedSessionTranscriptDisplayRow & {
  displayOrdinal: number;
  revision: number;
  rowId: string;
  rowVersion: number;
};
export type PreparedSessionTranscriptDisplayProjection = {
  carry: PreparedSessionTranscriptDisplayCarry[];
  rows: PreparedSessionTranscriptDisplayRow[];
};

export function createDisplayRowId(): string {
  return randomUUID();
}

export function parseDisplayRowKind(value: string): SessionTranscriptDisplayRowKind {
  if (
    value === "assistant" ||
    value === "compaction" ||
    value === "opaque" ||
    value === "reset" ||
    value === "user"
  ) {
    return value;
  }
  throw new Error(`Unexpected transcript display-row kind: ${value}`);
}

export function parseDisplayCarryKind(value: string): SessionTranscriptDisplayCarryKind {
  if (Object.hasOwn(DISPLAY_CARRY_LIMITS, value)) {
    return value as SessionTranscriptDisplayCarryKind;
  }
  throw new Error(`Unexpected transcript display carry kind: ${value}`);
}

export function hasTranscriptMessage(event: unknown): boolean {
  const record = readRecord(event);
  return record !== undefined && Object.hasOwn(record, "message") && record.message !== undefined;
}

export function shouldProjectActiveEvent(event: unknown): boolean {
  const record = readRecord(event);
  if (!record) {
    return false;
  }
  if (record.type === "session") {
    return false;
  }
  return (
    isCanonicalSessionTranscriptEntry(event) ||
    parseSessionTranscriptTreeEntry(event) !== undefined ||
    hasTranscriptMessage(event)
  );
}

export function isSessionTranscriptDisplayBoundary(event: unknown): boolean {
  const record = readRecord(event);
  if (!record) {
    return false;
  }
  const type = record.type;
  return type === "compaction" || type === "reset";
}

export type DisplayReducerRow = PlannedSessionTranscriptDisplayRow & {
  displayOrdinal: number;
  revision: number;
  rowId: string;
};

export type DisplayReducerEffects = {
  addCanvases: (
    row: DisplayReducerRow,
    sourceEventSeq: number,
    canvases: Array<Omit<PreparedSessionTranscriptDisplayCanvas, "position">>,
  ) => void;
  addRelation: (
    row: DisplayReducerRow,
    relation: SessionTranscriptDisplayRelation,
    sourceEventSeqs: readonly number[],
  ) => void;
  appendRow: (kind: SessionTranscriptDisplayRowKind, sourceEventSeq: number) => DisplayReducerRow;
  beginSource: () => void;
  findRow: (sourceEventSeq: number) => DisplayReducerRow | undefined;
  removeCanvases: (sourceEventSeq: number) => void;
  replaceStreamRows: (
    pendingSourceEventSeqs: readonly number[],
    sourceEventSeq: number,
  ) => DisplayReducerRow;
};

export type DisplayReducerState = {
  carry: PreparedSessionTranscriptDisplayCarry[];
  effects: DisplayReducerEffects;
  readEvent: (sourceEventSeq: number) => unknown;
};

function carryEntries(
  state: DisplayReducerState,
  kind: SessionTranscriptDisplayCarryKind,
): PreparedSessionTranscriptDisplayCarry[] {
  return state.carry.filter((entry) => entry.kind === kind);
}

function replaceCarry(
  state: DisplayReducerState,
  kind: SessionTranscriptDisplayCarryKind,
  entries: PreparedSessionTranscriptDisplayCarry[],
): void {
  entries.forEach((entry, position) => {
    entry.kind = kind;
    entry.position = position;
  });
  state.carry = [...state.carry.filter((entry) => entry.kind !== kind), ...entries];
}

function pushCarry(
  state: DisplayReducerState,
  kind: SessionTranscriptDisplayCarryKind,
  entry: Omit<PreparedSessionTranscriptDisplayCarry, "kind" | "position">,
): PreparedSessionTranscriptDisplayCarry | undefined {
  const entries = [...carryEntries(state, kind), { ...entry, kind, position: 0 }];
  const overflow = entries.length - DISPLAY_CARRY_LIMITS[kind];
  const dropped = overflow > 0 ? entries.splice(0, overflow)[0] : undefined;
  replaceCarry(state, kind, entries);
  return dropped;
}

function clearCarry(
  state: DisplayReducerState,
  ...kinds: SessionTranscriptDisplayCarryKind[]
): void {
  const removed = new Set(kinds);
  state.carry = state.carry.filter((entry) => !removed.has(entry.kind));
}

function eventMessage(event: unknown): Record<string, unknown> | undefined {
  return readRecord(readRecord(event)?.message);
}

function messageToolCallForCarry(
  state: DisplayReducerState,
  entry: PreparedSessionTranscriptDisplayCarry,
): MessageToolCall | undefined {
  const sameSourceBefore = carryEntries(state, "message_tool").filter(
    (candidate) =>
      candidate.position < entry.position && candidate.sourceEventSeq === entry.sourceEventSeq,
  ).length;
  const message = eventMessage(state.readEvent(entry.sourceEventSeq));
  return message ? readMessageToolCalls(message)[sameSourceBefore] : undefined;
}

function attachPendingHeartbeat(
  state: DisplayReducerState,
  row: DisplayReducerRow,
  role: unknown,
): void {
  if (role === "system" || role === "custom") {
    return;
  }
  const boundary = carryEntries(state, "heartbeat_boundary").at(-1);
  if (!boundary) {
    return;
  }
  state.effects.addRelation(row, "turn_boundary", [boundary.sourceEventSeq]);
  clearCarry(state, "heartbeat_boundary");
}

function flushMessageToolMirrors(
  state: DisplayReducerState,
  anchor: DisplayReducerRow,
  selected?: readonly PreparedSessionTranscriptDisplayCarry[],
): void {
  const pending = carryEntries(state, "message_tool");
  const chosen = selected ?? pending.filter((entry) => entry.relatedEventSeq !== undefined);
  if (chosen.length > 0) {
    state.effects.addRelation(
      anchor,
      "message_tool_mirror",
      chosen.map((entry) => entry.sourceEventSeq),
    );
  }
  if (selected) {
    const flushed = new Set(selected);
    replaceCarry(
      state,
      "message_tool",
      pending.filter((entry) => !flushed.has(entry)),
    );
  } else {
    clearCarry(state, "message_tool");
  }
}

function handleMessageToolResult(
  state: DisplayReducerState,
  message: Record<string, unknown>,
  sourceEventSeq: number,
): void {
  const result = readMessageToolResult(message);
  if (!result?.successful) {
    return;
  }
  const pending = carryEntries(state, "message_tool");
  for (const entry of pending) {
    if (entry.relatedEventSeq !== undefined) {
      continue;
    }
    const call = messageToolCallForCarry(state, entry);
    if (
      !call ||
      (call.callId && result.callId !== call.callId) ||
      (call.requiresSourceRouteConfirmation && !result.sourceRouteConfirmed)
    ) {
      continue;
    }
    entry.relatedEventSeq = sourceEventSeq;
  }
  replaceCarry(state, "message_tool", pending);
}

function handleDeliveryMirror(
  state: DisplayReducerState,
  message: Record<string, unknown>,
  row: DisplayReducerRow,
): boolean {
  if (!readRecord(message.openclawDeliveryMirror)) {
    return false;
  }
  const text = readMessageText(message)?.trim();
  if (!text) {
    return false;
  }
  const matching = carryEntries(state, "message_tool").filter((entry) => {
    const call = messageToolCallForCarry(state, entry);
    return entry.relatedEventSeq !== undefined && call?.text.trim() === text;
  });
  if (matching.length === 0) {
    return false;
  }
  flushMessageToolMirrors(state, row, matching);
  return true;
}

function findTtsTarget(
  state: DisplayReducerState,
  marker: { spokenText?: string; textSha256?: string },
): DisplayReducerRow | undefined {
  for (const entry of carryEntries(state, "tts_candidate").toReversed()) {
    const candidate = eventMessage(state.readEvent(entry.sourceEventSeq));
    if (candidate && ttsMarkerMatches(marker, candidate)) {
      return state.effects.findRow(entry.sourceEventSeq);
    }
  }
  return undefined;
}

function movePendingCanvases(state: DisplayReducerState, target: DisplayReducerRow): void {
  const pending = carryEntries(state, "canvas_pending");
  for (const entry of pending) {
    const message = eventMessage(state.readEvent(entry.sourceEventSeq));
    const canvases = message ? readCanvasPreviews(message, entry.sourceEventSeq) : [];
    if (canvases.length > 0) {
      state.effects.addCanvases(target, entry.sourceEventSeq, canvases);
    } else {
      state.effects.removeCanvases(entry.sourceEventSeq);
    }
  }
  clearCarry(state, "canvas_pending");
}

function isToolShapedMessage(message: Record<string, unknown>): boolean {
  const role = normalizeHistoryType(message.role);
  if (role === "toolresult" || role === "tool" || role === "function") {
    return true;
  }
  return (
    typeof message.toolCallId === "string" ||
    typeof message.tool_call_id === "string" ||
    typeof message.toolName === "string" ||
    typeof message.tool_name === "string" ||
    (Array.isArray(message.content) &&
      message.content.some((block) => {
        const type = normalizeHistoryType(readRecord(block)?.type);
        return type === "toolcall" || type === "tooluse" || type === "toolresult";
      }))
  );
}

/** Reduces one active-path source through the persisted display transition contract. */
export function reduceSessionTranscriptDisplaySource(
  state: DisplayReducerState,
  source: { event: unknown; seq: number },
): void {
  state.effects.beginSource();
  if (!shouldProjectActiveEvent(source.event)) {
    return;
  }
  const record = readRecord(source.event);
  if (!record) {
    return;
  }
  if (record.type === "compaction" || record.type === "reset") {
    clearCarry(
      state,
      "canvas_pending",
      "heartbeat_boundary",
      "message_tool",
      "stream_error",
      "tts_candidate",
    );
    state.effects.appendRow(record.type, source.seq);
    return;
  }
  const message = readRecord(record.message);
  if (!message) {
    state.effects.appendRow("opaque", source.seq);
    return;
  }
  const role = message.role;
  if (isForwardedSessionsSend(message)) {
    const kind = role === "assistant" && isRenderableAssistant(message) ? "assistant" : "opaque";
    state.effects.appendRow(kind, source.seq);
    return;
  }
  if (
    role === "user" &&
    isHeartbeatUserMessage(message as { role: string; content?: unknown }, HEARTBEAT_PROMPT)
  ) {
    clearCarry(state, "message_tool", "stream_error");
    const dropped = pushCarry(state, "heartbeat_boundary", { sourceEventSeq: source.seq });
    if (dropped) {
      state.effects.appendRow("opaque", dropped.sourceEventSeq);
    }
    return;
  }
  if (
    role === "assistant" &&
    isHeartbeatOkResponse(message as { role: string; content?: unknown })
  ) {
    return;
  }
  if (role === "user") {
    clearCarry(state, "message_tool", "stream_error");
    const row = state.effects.appendRow("user", source.seq);
    attachPendingHeartbeat(state, row, role);
    return;
  }
  if (isPureStreamError(message)) {
    const row = state.effects.appendRow("assistant", source.seq);
    attachPendingHeartbeat(state, row, role);
    pushCarry(state, "stream_error", { sourceEventSeq: source.seq });
    return;
  }
  const calls = readMessageToolCalls(message);
  if (calls.length > 0) {
    const row = state.effects.appendRow("opaque", source.seq);
    attachPendingHeartbeat(state, row, role);
    calls.forEach(() => {
      pushCarry(state, "message_tool", { sourceEventSeq: source.seq });
    });
    return;
  }
  const ttsMarker = readTtsMarker(message);
  if (ttsMarker && isTtsSupplement(message)) {
    const target = findTtsTarget(state, ttsMarker);
    if (target) {
      state.effects.addRelation(target, "tts_supplement", [source.seq]);
      return;
    }
    const row = state.effects.appendRow("opaque", source.seq);
    attachPendingHeartbeat(state, row, role);
    return;
  }
  const canvas = isToolShapedMessage(message) ? readCanvasPreviews(message, source.seq) : [];
  if (canvas.length > 0) {
    const row = state.effects.appendRow("opaque", source.seq);
    attachPendingHeartbeat(state, row, role);
    const targetSource = carryEntries(state, "tts_candidate").at(-1)?.sourceEventSeq;
    const target = targetSource === undefined ? undefined : state.effects.findRow(targetSource);
    const dropped = pushCarry(state, "canvas_pending", {
      ...(target ? { relatedEventSeq: target.sourceEventSeq } : {}),
      sourceEventSeq: source.seq,
    });
    if (dropped) {
      state.effects.removeCanvases(dropped.sourceEventSeq);
    }
    if (target) {
      state.effects.addCanvases(target, source.seq, canvas);
    }
    return;
  }
  const result = readMessageToolResult(message);
  const suppressed = isSuppressedControlReply(message);
  const deliveryMirror = readRecord(message.openclawDeliveryMirror) !== undefined;
  let row: DisplayReducerRow | undefined;
  if (result) {
    row = state.effects.appendRow("opaque", source.seq);
    handleMessageToolResult(state, message, source.seq);
  } else if (!suppressed) {
    const kind =
      role === "assistant" && isRenderableAssistant(message)
        ? "assistant"
        : role === "user"
          ? "user"
          : "opaque";
    const pendingErrors = carryEntries(state, "stream_error");
    row =
      kind === "assistant" && pendingErrors.length > 0
        ? state.effects.replaceStreamRows(
            pendingErrors.map((entry) => entry.sourceEventSeq),
            source.seq,
          )
        : state.effects.appendRow(kind, source.seq);
    if (kind === "assistant") {
      clearCarry(state, "stream_error");
    }
  }
  if (row && deliveryMirror && handleDeliveryMirror(state, message, row)) {
    attachPendingHeartbeat(state, row, role);
    return;
  }
  if (suppressed) {
    const succeeded = carryEntries(state, "message_tool").filter(
      (entry) => entry.relatedEventSeq !== undefined,
    );
    if (succeeded.length > 0) {
      row = state.effects.appendRow("assistant", source.seq);
      flushMessageToolMirrors(state, row);
      attachPendingHeartbeat(state, row, role);
    }
    return;
  }
  if (!row) {
    return;
  }
  attachPendingHeartbeat(state, row, role);
  if (row.kind === "assistant" && isRenderableAssistant(message)) {
    clearCarry(state, "message_tool");
    movePendingCanvases(state, row);
    pushCarry(state, "tts_candidate", { sourceEventSeq: source.seq });
  }
}

function createPreparedDisplayEffects(rows: DisplayReducerRow[]): DisplayReducerEffects {
  const newRows = new Set<string>();
  const revisedRows = new Set<string>();
  const revise = (row: DisplayReducerRow, includeNew = false) => {
    if ((!includeNew && newRows.has(row.rowId)) || revisedRows.has(row.rowId)) {
      return;
    }
    row.revision += 1;
    revisedRows.add(row.rowId);
  };
  const normalize = () => {
    rows.forEach((row, displayOrdinal) => {
      row.displayOrdinal = displayOrdinal;
    });
  };
  const reindexCanvases = (
    canvases: PreparedSessionTranscriptDisplayCanvas[],
  ): PreparedSessionTranscriptDisplayCanvas[] => {
    canvases.forEach((canvas, position) => {
      canvas.position = position;
    });
    return canvases;
  };
  return {
    addCanvases: (row, sourceEventSeq, canvases) => {
      let changed = false;
      for (const candidate of rows) {
        const retained = reindexCanvases(
          candidate.canvases.filter((canvas) => canvas.sourceEventSeq !== sourceEventSeq),
        );
        if (retained.length !== candidate.canvases.length) {
          candidate.canvases = retained;
          revise(candidate);
          changed ||= candidate === row;
        }
      }
      const existing = new Set(row.canvases.map((canvas) => canvas.viewId ?? canvas.url));
      for (const canvas of canvases) {
        const identity = canvas.viewId ?? canvas.url;
        if (!existing.has(identity) && row.canvases.length < 16) {
          row.canvases.push({ ...canvas, position: row.canvases.length });
          existing.add(identity);
          changed = true;
        }
      }
      if (changed) {
        revise(row, true);
      }
    },
    addRelation: (row, relation, sourceEventSeqs) => {
      const existing = new Set(
        row.semanticSources
          .filter((source) => source.relation === relation)
          .map((source) => source.sourceEventSeq),
      );
      const limit = relation === "turn_boundary" ? 1 : 16;
      let changed = false;
      for (const sourceEventSeq of sourceEventSeqs) {
        if (existing.has(sourceEventSeq) || existing.size >= limit) {
          continue;
        }
        row.semanticSources.push({
          position: existing.size,
          relation,
          sourceEventSeq,
        });
        existing.add(sourceEventSeq);
        changed = true;
      }
      if (changed) {
        revise(row);
      }
    },
    appendRow: (kind, sourceEventSeq) => {
      const row: DisplayReducerRow = {
        canvases: [],
        displayOrdinal: rows.length,
        kind,
        revision: 1,
        rowId: createDisplayRowId(),
        semanticSources: [],
        sourceEventSeq,
      };
      rows.push(row);
      newRows.add(row.rowId);
      return row;
    },
    beginSource: () => {
      newRows.clear();
      revisedRows.clear();
    },
    findRow: (sourceEventSeq) => rows.find((row) => row.sourceEventSeq === sourceEventSeq),
    removeCanvases: (sourceEventSeq) => {
      for (const row of rows) {
        const retained = reindexCanvases(
          row.canvases.filter((canvas) => canvas.sourceEventSeq !== sourceEventSeq),
        );
        if (retained.length !== row.canvases.length) {
          row.canvases = retained;
          revise(row);
        }
      }
    },
    replaceStreamRows: (pendingSourceEventSeqs, sourceEventSeq) => {
      const pending = rows
        .filter((row) => pendingSourceEventSeqs.includes(row.sourceEventSeq))
        .toSorted((left, right) => left.displayOrdinal - right.displayOrdinal);
      const target = pending[0];
      if (!target) {
        return createPreparedDisplayEffects(rows).appendRow("assistant", sourceEventSeq);
      }
      target.kind = "assistant";
      target.sourceEventSeq = sourceEventSeq;
      revise(target);
      for (const extra of pending.slice(1)) {
        rows.splice(rows.indexOf(extra), 1);
      }
      normalize();
      return target;
    },
  };
}

/** Builds display rows and numeric carry from the canonical active transcript path. */
export function prepareSessionTranscriptDisplayProjection(
  rows: readonly { event: unknown; seq: number }[],
): PreparedSessionTranscriptDisplayProjection {
  const bySeq = new Map(rows.map((row) => [row.seq, row.event]));
  const preparedRows: DisplayReducerRow[] = [];
  const state: DisplayReducerState = {
    carry: [],
    effects: createPreparedDisplayEffects(preparedRows),
    readEvent: (sourceEventSeq) => bySeq.get(sourceEventSeq),
  };
  const events = rows.map((row) => row.event);
  for (const entry of selectVisibleTranscriptEventEntries(events)) {
    const source = rows[entry.seq - 1];
    if (source) {
      reduceSessionTranscriptDisplaySource(state, { event: entry.event, seq: source.seq });
    }
  }
  return {
    carry: state.carry,
    rows: preparedRows.map((row) =>
      Object.assign(row, { rowVersion: SESSION_TRANSCRIPT_DISPLAY_ROW_VERSION }),
    ),
  };
}

export function prepareSessionTranscriptDisplayRows(
  rows: readonly { event: unknown; seq: number }[],
): PreparedSessionTranscriptDisplayRow[] {
  return prepareSessionTranscriptDisplayProjection(rows).rows;
}
