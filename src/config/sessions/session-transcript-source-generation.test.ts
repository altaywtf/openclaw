import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { appendTranscriptMessage, upsertSessionEntryCore } from "./session-accessor.js";
import { ensureSqliteTranscriptGenerationsForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { importSqliteSessionRows } from "./session-accessor.sqlite-import.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import {
  claimPreparedSessionTranscriptProjectionInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  prepareSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";
import { replaceSessionTranscriptSourceGenerationInTransaction } from "./session-transcript-source-generation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function createScope(name: string) {
  return {
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: tempDirs.make(`openclaw-source-generation-${name}-`) },
    sessionId: `session-${name}`,
    sessionKey: `agent:main:${name}`,
  };
}

function readGeneration(scope: ReturnType<typeof createScope>): string | undefined {
  return (
    openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env })
      .db.prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .get(scope.sessionId) as { generation: string } | undefined
  )?.generation;
}

describe("session transcript source generation", () => {
  it("owns an empty generation and rotates it once for an empty replacement", async () => {
    const scope = createScope("empty-replacement");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const initial = readGeneration(scope);
    expect(initial).toMatch(/^[0-9a-f]{32}$/u);

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db.exec(`
      CREATE TEMP TABLE tracked_source_generation_writes (write_count INTEGER NOT NULL);
      INSERT INTO tracked_source_generation_writes (write_count) VALUES (0);
      CREATE TEMP TRIGGER track_source_generation_insert
      AFTER INSERT ON transcript_rewrite_watermarks
      WHEN NEW.session_id = '${scope.sessionId}'
      BEGIN
        UPDATE tracked_source_generation_writes SET write_count = write_count + 1;
      END;
      CREATE TEMP TRIGGER track_source_generation_update
      AFTER UPDATE ON transcript_rewrite_watermarks
      WHEN NEW.session_id = '${scope.sessionId}'
      BEGIN
        UPDATE tracked_source_generation_writes SET write_count = write_count + 1;
      END;
    `);

    await replaceTranscriptEvents(scope, []);

    expect(readGeneration(scope)).toMatch(/^[0-9a-f]{32}$/u);
    expect(readGeneration(scope)).not.toBe(initial);
    expect(
      database.db.prepare("SELECT write_count FROM tracked_source_generation_writes").get(),
    ).toEqual({ write_count: 1 });
  });

  it("gives an empty legacy import an authoritative generation", async () => {
    const scope = createScope("empty-import");
    await importSqliteSessionRows({
      agentId: scope.agentId,
      env: scope.env,
      entry: { sessionId: scope.sessionId, updatedAt: 10 },
      sessionKey: scope.sessionKey,
    });

    expect(readGeneration(scope)).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("repairs the generation of an empty legacy canonical source", async () => {
    const scope = createScope("empty-canonical-repair");
    const entry = { sessionId: scope.sessionId, updatedAt: 10 };
    await upsertSessionEntryCore(scope, entry);
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .run(scope.sessionId);

    await ensureSqliteTranscriptGenerationsForCanonicalRepair([
      {
        agentId: scope.agentId,
        entry,
        sessionKey: scope.sessionKey,
        storePath: database.path,
      },
    ]);

    expect(readGeneration(scope)).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("publishes active and display bindings only after projection use", async () => {
    const scope = createScope("projection-bindings");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    expect(
      database.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_projection_bindings'",
        )
        .get(),
    ).toBeUndefined();

    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "binding source" },
    });

    const sourceGeneration = readGeneration(scope);
    expect(
      database.db
        .prepare(
          `SELECT projection, projection_generation, source_generation
           FROM session_transcript_projection_bindings
           WHERE session_id = ?
           ORDER BY projection`,
        )
        .all(scope.sessionId),
    ).toEqual([
      {
        projection: "active",
        projection_generation: null,
        source_generation: sourceGeneration,
      },
      {
        projection: "display",
        projection_generation: expect.stringMatching(/^[0-9a-f]{32}$/u),
        source_generation: sourceGeneration,
      },
    ]);
  });

  it("rejects prepared work after a same-sequence source replacement", async () => {
    const scope = createScope("stale-preparation");
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "prepared source" },
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db.exec(`
      UPDATE session_transcript_index_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
      UPDATE session_transcript_display_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
    `);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();

    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        replaceSessionTranscriptSourceGenerationInTransaction(writeDatabase, scope.sessionId);
        expect(
          writeDatabase.db
            .prepare(
              "SELECT COUNT(*) AS count FROM session_transcript_projection_bindings WHERE session_id = ?",
            )
            .get(scope.sessionId),
        ).toEqual({ count: 0 });
        expect(
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -101),
        ).toBe(false);
      },
      { agentId: scope.agentId, env: scope.env },
    );
  });

  it("rejects final publication after a same-sequence source replacement", async () => {
    const scope = createScope("stale-finalization");
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "claimed source" },
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db.exec(`
      UPDATE session_transcript_index_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
      UPDATE session_transcript_display_state
      SET needs_rebuild = 1
      WHERE session_id = '${scope.sessionId}';
    `);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();
    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        expect(
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -202),
        ).toBe(true);
      },
      { agentId: scope.agentId, env: scope.env },
    );

    runOpenClawAgentWriteTransaction(
      (writeDatabase) => {
        replaceSessionTranscriptSourceGenerationInTransaction(writeDatabase, scope.sessionId);
        expect(
          finalizePreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -202),
        ).toBe(false);
      },
      { agentId: scope.agentId, env: scope.env },
    );
  });
});
