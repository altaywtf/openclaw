import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureOpenClawAgentTranscriptProjectionBindingSchema,
  SESSION_TRANSCRIPT_PROJECTION_BINDINGS_TABLE,
  validateOpenClawAgentTranscriptProjectionBindingSchema,
} from "../../state/openclaw-agent-transcript-projection-binding-schema.js";

type SourceGenerationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_projection_bindings"
  | "session_windows"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
>;

const EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ = -1;

type SessionTranscriptSourceGeneration = {
  generation: string;
  indexedSeq: number;
};

type SessionTranscriptProjectionBinding =
  | {
      projection: "active";
      projectionGeneration: null;
      sourceGeneration: string;
    }
  | {
      projection: "display";
      projectionGeneration: string;
      sourceGeneration: string;
    };

function getSourceGenerationKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SourceGenerationDatabase>(db);
}

function createTranscriptGeneration(): string {
  return randomUUID().replaceAll("-", "");
}

/** Reads the authoritative source generation and frontier from one SQLite snapshot. */
export function readSessionTranscriptSourceGenerationInTransaction(
  db: DatabaseSync,
  sessionId: string,
): SessionTranscriptSourceGeneration | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSourceGenerationKysely(db)
      .selectFrom("session_windows as window")
      .innerJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .select((eb) => [
        "rewrite.generation",
        eb
          .selectFrom("transcript_events as event")
          .select((inner) => inner.fn.max<number>("event.seq").as("indexed_seq"))
          .whereRef("event.session_id", "=", "window.session_id")
          .as("indexed_seq"),
      ])
      .where("window.session_id", "=", sessionId),
  );
  return row
    ? {
        generation: row.generation,
        indexedSeq: row.indexed_seq ?? EMPTY_SESSION_TRANSCRIPT_SOURCE_INDEXED_SEQ,
      }
    : undefined;
}

/** Materializes one source generation; ordinary appends preserve an existing token. */
export function ensureSessionTranscriptSourceGenerationInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): string {
  const generation = createTranscriptGeneration();
  const db = getSourceGenerationKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("transcript_rewrite_watermarks")
      .values({ session_id: sessionId, generation, updated_at: Date.now() })
      .onConflict((conflict) => conflict.column("session_id").doNothing()),
  );
  return (
    readSessionTranscriptSourceGenerationInTransaction(database.db, sessionId)?.generation ??
    generation
  );
}

/** Backfills legacy windows through the same source-generation policy before reconciliation. */
export function ensureAllSessionTranscriptSourceGenerationsInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
): number {
  const db = getSourceGenerationKysely(database.db);
  const missing = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows as window")
      .leftJoin(
        "transcript_rewrite_watermarks as rewrite",
        "rewrite.session_id",
        "window.session_id",
      )
      .select("window.session_id")
      .where("rewrite.session_id", "is", null),
  ).rows;
  for (const row of missing) {
    ensureSessionTranscriptSourceGenerationInTransaction(database, row.session_id);
  }
  return missing.length;
}

/** Reads one derived projection's binding without materializing an absent lazy group. */
export function readSessionTranscriptProjectionBindingInTransaction(
  db: DatabaseSync,
  sessionId: string,
  projection: SessionTranscriptProjectionBinding["projection"],
): SessionTranscriptProjectionBinding | undefined {
  if (!validateOpenClawAgentTranscriptProjectionBindingSchema(db)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getSourceGenerationKysely(db)
      .selectFrom(SESSION_TRANSCRIPT_PROJECTION_BINDINGS_TABLE)
      .select(["projection", "projection_generation", "source_generation"])
      .where("session_id", "=", sessionId)
      .where("projection", "=", projection),
  );
  if (!row) {
    return undefined;
  }
  if (row.projection === "active" && row.projection_generation === null) {
    return {
      projection: "active",
      projectionGeneration: null,
      sourceGeneration: row.source_generation,
    };
  }
  if (row.projection === "display" && row.projection_generation !== null) {
    return {
      projection: "display",
      projectionGeneration: row.projection_generation,
      sourceGeneration: row.source_generation,
    };
  }
  throw new Error(`Invalid transcript projection binding for ${sessionId}:${projection}`);
}

export function sessionTranscriptProjectionBindingMatches(
  binding: SessionTranscriptProjectionBinding | undefined,
  sourceGeneration: string,
  projectionGeneration?: string,
): boolean {
  return Boolean(
    binding &&
    binding.sourceGeneration === sourceGeneration &&
    (binding.projection === "active" || binding.projectionGeneration === projectionGeneration),
  );
}

/** Returns source identity only when one derived projection is bound to it. */
export function readBoundSessionTranscriptSourceGenerationInTransaction(
  db: DatabaseSync,
  sessionId: string,
  projection: { projection: "active" } | { projection: "display"; projectionGeneration: string },
): SessionTranscriptSourceGeneration | undefined {
  const source = readSessionTranscriptSourceGenerationInTransaction(db, sessionId);
  if (!source) {
    return undefined;
  }
  return sessionTranscriptProjectionBindingMatches(
    readSessionTranscriptProjectionBindingInTransaction(db, sessionId, projection.projection),
    source.generation,
    projection.projection === "display" ? projection.projectionGeneration : undefined,
  )
    ? source
    : undefined;
}

/** Publishes one derived projection binding in its owning write transaction. */
export function writeSessionTranscriptProjectionBindingInTransaction(
  db: DatabaseSync,
  sessionId: string,
  binding: SessionTranscriptProjectionBinding,
): void {
  ensureOpenClawAgentTranscriptProjectionBindingSchema(db);
  const existing = readSessionTranscriptProjectionBindingInTransaction(
    db,
    sessionId,
    binding.projection,
  );
  if (
    existing?.sourceGeneration === binding.sourceGeneration &&
    existing.projectionGeneration === binding.projectionGeneration
  ) {
    return;
  }
  executeSqliteQuerySync(
    db,
    getSourceGenerationKysely(db)
      .insertInto(SESSION_TRANSCRIPT_PROJECTION_BINDINGS_TABLE)
      .values({
        projection: binding.projection,
        projection_generation: binding.projectionGeneration,
        session_id: sessionId,
        source_generation: binding.sourceGeneration,
      })
      .onConflict((conflict) =>
        conflict.columns(["session_id", "projection"]).doUpdateSet({
          projection_generation: binding.projectionGeneration,
          source_generation: binding.sourceGeneration,
        }),
      ),
  );
}

/** Clears derived bindings without creating their lazy storage. */
export function deleteSessionTranscriptProjectionBindingsInTransaction(
  db: DatabaseSync,
  sessionId: string,
  projection?: SessionTranscriptProjectionBinding["projection"],
): void {
  if (!validateOpenClawAgentTranscriptProjectionBindingSchema(db)) {
    return;
  }
  const query = getSourceGenerationKysely(db)
    .deleteFrom(SESSION_TRANSCRIPT_PROJECTION_BINDINGS_TABLE)
    .where("session_id", "=", sessionId);
  executeSqliteQuerySync(
    db,
    projection === undefined ? query : query.where("projection", "=", projection),
  );
}

/** Replaces source identity and invalidates every derived binding atomically. */
export function replaceSessionTranscriptSourceGenerationInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  source: { generation?: string; updatedAt?: number } = {},
): string {
  const generation = source.generation ?? createTranscriptGeneration();
  const updatedAt = source.updatedAt ?? Date.now();
  deleteSessionTranscriptProjectionBindingsInTransaction(database.db, sessionId);
  executeSqliteQuerySync(
    database.db,
    getSourceGenerationKysely(database.db)
      .insertInto("transcript_rewrite_watermarks")
      .values({ generation, session_id: sessionId, updated_at: updatedAt })
      .onConflict((conflict) =>
        conflict.column("session_id").doUpdateSet({
          generation,
          updated_at: updatedAt,
        }),
      ),
  );
  return generation;
}
