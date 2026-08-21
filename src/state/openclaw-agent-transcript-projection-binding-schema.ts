import type { DatabaseSync } from "node:sqlite";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

export const SESSION_TRANSCRIPT_PROJECTION_BINDINGS_TABLE =
  "session_transcript_projection_bindings";
export const SESSION_TRANSCRIPT_PROJECTION_BINDINGS_OWNER_INDEX =
  "idx_agent_transcript_projection_bindings_owner";

const BINDING_SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${SESSION_TRANSCRIPT_PROJECTION_BINDINGS_TABLE} (`;
const BINDING_SCHEMA_END = "CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(";
const VALIDATED_SCHEMA_VERSIONS = new WeakMap<DatabaseSync, number>();

function splitBindingSchema(sql: string): { bindings: string; withoutBindings: string } {
  const start = sql.indexOf(BINDING_SCHEMA_START);
  const end = sql.indexOf(BINDING_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent transcript projection binding schema markers are missing.");
  }
  return {
    bindings: sql.slice(start, end),
    withoutBindings: `${sql.slice(0, start)}${sql.slice(end)}`,
  };
}

const bindingSchema = splitBindingSchema(OPENCLAW_AGENT_SCHEMA_SQL);
const AGENT_TRANSCRIPT_PROJECTION_BINDING_SCHEMA_SQL = bindingSchema.bindings;
export const AGENT_SCHEMA_WITHOUT_TRANSCRIPT_PROJECTION_BINDINGS_SQL =
  bindingSchema.withoutBindings;

function schemaObjectExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name));
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA schema_version").get() as { schema_version?: unknown } | undefined;
  if (typeof row?.schema_version !== "number") {
    throw new Error("OpenClaw agent transcript projection binding schema version is invalid.");
  }
  return row.schema_version;
}

/** Validates a present lazy binding group without materializing an absent one. */
export function validateOpenClawAgentTranscriptProjectionBindingSchema(db: DatabaseSync): boolean {
  const schemaVersion = readSchemaVersion(db);
  if (VALIDATED_SCHEMA_VERSIONS.get(db) === schemaVersion) {
    return true;
  }
  const tablePresent = schemaObjectExists(db, SESSION_TRANSCRIPT_PROJECTION_BINDINGS_TABLE);
  const indexPresent = schemaObjectExists(db, SESSION_TRANSCRIPT_PROJECTION_BINDINGS_OWNER_INDEX);
  if (!tablePresent && !indexPresent) {
    return false;
  }
  if (!tablePresent || !indexPresent) {
    throw new Error("OpenClaw agent transcript projection binding schema is partially present.");
  }
  assertSqliteSchemaContains(
    db,
    "OpenClaw agent transcript projection binding schema",
    AGENT_TRANSCRIPT_PROJECTION_BINDING_SCHEMA_SQL,
  );
  if (!db.isTransaction) {
    VALIDATED_SCHEMA_VERSIONS.set(db, schemaVersion);
  }
  return true;
}

function cacheBindingSchemaAfterTransaction(db: DatabaseSync): void {
  setImmediate(() => {
    if (!db.isOpen || db.isTransaction) {
      return;
    }
    try {
      validateOpenClawAgentTranscriptProjectionBindingSchema(db);
    } catch {
      // The next feature use must surface external drift synchronously.
    }
  });
}

/** Lazily installs the complete additive projection-binding group on first publication. */
export function ensureOpenClawAgentTranscriptProjectionBindingSchema(db: DatabaseSync): void {
  if (validateOpenClawAgentTranscriptProjectionBindingSchema(db)) {
    return;
  }
  const ensure = () => {
    db.exec(AGENT_TRANSCRIPT_PROJECTION_BINDING_SCHEMA_SQL); // sqlite-allow-raw -- Canonical additive DDL only.
    assertSqliteSchemaContains(
      db,
      "OpenClaw agent transcript projection binding schema",
      AGENT_TRANSCRIPT_PROJECTION_BINDING_SCHEMA_SQL,
    );
  };
  if (db.isTransaction) {
    ensure();
    cacheBindingSchemaAfterTransaction(db);
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
  VALIDATED_SCHEMA_VERSIONS.set(db, readSchemaVersion(db));
}
