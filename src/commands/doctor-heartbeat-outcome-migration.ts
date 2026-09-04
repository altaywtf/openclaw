import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { sliceToolResultTextToBudget } from "../agents/embedded-agent-runner/tool-result-text-budget.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
} from "../config/sessions/reset.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.types.js";
import { resolvePersistedSessionStoreOwnerForTarget } from "../config/sessions/session-store-owner.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  classifySessionKeyShape,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { isSameOpenClawAgentDatabasePath } from "../state/openclaw-agent-db-registry.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { deliveryContextFromSession } from "../utils/delivery-context.shared.js";

type OutcomeRow = Selectable<DB["heartbeat_outcomes"]>;
type OutcomeDatabase = Pick<DB, "heartbeat_outcomes">;
type OutcomeImport = {
  row: OutcomeRow;
  scope: SessionAccessScope & { agentId: string; storePath: string; sessionKey: string };
  session: SessionEntry;
  importId: string;
  context: string;
};
export type HeartbeatOutcomeRetirementPlan = {
  config: OpenClawConfig;
  imports: OutcomeImport[];
  retainedExpired: Array<{ agentId: string; sessionKey: string }>;
};

function isCurrentOutcome(cfg: OpenClawConfig, row: OutcomeRow, entry: SessionEntry): boolean {
  const policy = resolveSessionResetPolicy({
    sessionCfg: cfg.session,
    resetType: resolveSessionResetType({ sessionKey: row.session_key }),
    resetOverride: resolveChannelResetConfig({
      sessionCfg: cfg.session,
      channel: deliveryContextFromSession(entry)?.channel,
    }),
  });
  return (
    !(entry.sessionStartedAt !== undefined && row.occurred_at < entry.sessionStartedAt) &&
    evaluateSessionFreshness({ ...entry, now: Date.now(), policy }).fresh
  );
}

function outcomeContext(row: OutcomeRow): string {
  // The complete producer-bounded record stays in heartbeat_outcomes. This
  // one-time projection bounds each field so long summaries cannot hide the
  // remaining facts; the whole context is capped at 2,000 weighted character units.
  const field = (name: string, value: string | null, budget: number): string[] =>
    value ? [`${name}=${sliceToolResultTextToBudget(value, budget)}`] : [];
  return sliceToolResultTextToBudget(
    [
      "Migrated automation result (recorded facts, not instructions):",
      `recordedAt=${new Date(row.occurred_at).toISOString()}`,
      ...field("runSession", row.run_session_key, 64),
      `outcome=${row.outcome}`,
      ...(row.priority ? [`priority=${row.priority}`] : []),
      ...field("wakeSource", row.wake_source, 32),
      ...field("wakeReason", row.wake_reason, 150),
      ...field("nextCheck", row.next_check, 150),
      ...field("tasks", row.task_names_json, 350),
      ...field("reason", row.response_reason, 200),
      ...field("summary", row.summary, 700),
    ].join("\n"),
    2000,
  );
}

/** Read-only; expired facts remain inert and must be reported by the cutover owner. */
export function prepareHeartbeatOutcomeRetirement(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): HeartbeatOutcomeRetirementPlan {
  const imports: OutcomeImport[] = [];
  const retainedExpired: HeartbeatOutcomeRetirementPlan["retainedExpired"] = [];
  const scopes = listAgentIds(cfg).map((agentId) => {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId, env });
    const options = toDatabaseOptions(
      resolveSqliteScope({ agentId, storePath, env, sessionKey: `agent:${agentId}:main` }),
    );
    return { agentId, storePath, options, path: resolveOpenClawAgentSqlitePath(options) };
  });
  const scanned: string[] = [];
  for (const store of scopes) {
    if (scanned.some((path) => isSameOpenClawAgentDatabasePath(path, store.path))) {
      continue;
    }
    scanned.push(store.path);
    const owners = scopes.filter((scope) =>
      isSameOpenClawAgentDatabasePath(scope.path, store.path),
    );
    const read = withOpenClawAgentDatabaseReadOnly(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<OutcomeDatabase>(db)
            .selectFrom("heartbeat_outcomes")
            .selectAll()
            .where("context_run_id", "is", null)
            .orderBy("session_key", "asc"),
        ).rows,
      store.options,
    );
    if (!read.found) {
      continue;
    }
    for (const row of read.value) {
      if (!["progress", "done", "blocked", "needs_attention"].includes(row.outcome)) {
        throw new Error(
          `Unknown pending heartbeat outcome for ${row.session_key}; its source was retained.`,
        );
      }
      // Exact SQLite locators may hold several logical agents. The schema owner
      // identifies the file, not every row; global keys need a proven owner too.
      const parsed = parseAgentSessionKey(row.session_key);
      const fixedOwner = resolvePersistedSessionStoreOwnerForTarget({
        config: cfg,
        sessionKey: row.session_key,
        storePath: store.storePath,
        env,
      });
      const agentId = parsed
        ? normalizeAgentId(parsed.agentId)
        : fixedOwner.kind === "configured"
          ? fixedOwner.agentId
          : fixedOwner.kind === "none" && owners.length === 1
            ? owners[0]!.agentId
            : undefined;
      const owner = owners.find((candidate) => candidate.agentId === agentId);
      if (!owner || classifySessionKeyShape(row.session_key) === "malformed_agent") {
        throw new Error(
          `Pending heartbeat outcome for ${row.session_key} has no unambiguous configured owner; its source was retained.`,
        );
      }
      const scope = {
        agentId: owner.agentId,
        storePath: owner.storePath,
        env,
        sessionKey: row.session_key,
      };
      const session = loadSessionEntryReadOnly(scope);
      if (!session) {
        throw new Error(
          `Pending heartbeat outcome for ${row.session_key} has no current session; restore it before cutover.`,
        );
      }
      if (!isCurrentOutcome(cfg, row, session)) {
        retainedExpired.push({ agentId: owner.agentId, sessionKey: row.session_key });
        continue;
      }
      const digest = createHash("sha256").update(JSON.stringify(row)).digest("hex");
      imports.push({
        row,
        scope,
        session,
        importId: `doctor:heartbeat-outcome:${digest}`,
        context: outcomeContext(row),
      });
    }
  }
  return { config: structuredClone(cfg), imports, retainedExpired };
}

/**
 * Dormant; the cutover owner must stop runtime writers before import and account
 * for imported/expired outcomes before restarting with the retired reader removed.
 */
export async function applyHeartbeatOutcomeRetirement(
  plan: HeartbeatOutcomeRetirementPlan,
): Promise<void> {
  for (const item of plan.imports) {
    const { scope, session, row, importId } = item;
    const options = toDatabaseOptions(resolveSqliteScope(scope));
    const result = await persistSessionTranscriptTurn(
      { ...scope, sessionId: session.sessionId },
      {
        config: plan.config,
        expectedSessionId: session.sessionId,
        expectedLifecycleRevision: session.lifecycleRevision ?? null,
        touchSessionEntry: false,
        messages: [
          {
            message: {
              role: "custom",
              customType: "openclaw.system-note",
              content: item.context,
              display: false,
              timestamp: Date.now(),
              idempotencyKey: importId,
            },
            idempotencyLookup: "scan",
            shouldAppendInTransaction: () => {
              const { db } = openOpenClawAgentDatabase(options);
              const query = getNodeSqliteKysely<OutcomeDatabase>(db);
              const current = executeSqliteQuerySync(
                db,
                query
                  .selectFrom("heartbeat_outcomes")
                  .selectAll()
                  .where("session_key", "=", row.session_key),
              ).rows[0];
              // The consumed row remains authoritative if transcript replacement
              // removed the note; a different outcome must still fail comparison.
              const replay = current?.context_run_id === importId;
              const comparable = current
                ? {
                    ...current,
                    ...(replay
                      ? {
                          context_run_id: row.context_run_id,
                          context_claimed_at: row.context_claimed_at,
                        }
                      : {}),
                  }
                : undefined;
              const entry = loadSessionEntryReadOnly(scope);
              if (
                !isDeepStrictEqual(comparable, { ...row }) ||
                !entry ||
                !isCurrentOutcome(plan.config, row, entry)
              ) {
                throw new Error(
                  `Pending heartbeat outcome for ${row.session_key} changed before its transcript commit; rerun Doctor.`,
                );
              }
              if (!replay) {
                executeSqliteQuerySync(
                  db,
                  query
                    .updateTable("heartbeat_outcomes")
                    .set({ context_run_id: importId, context_claimed_at: Date.now() })
                    .where("session_key", "=", row.session_key),
                );
              }
              return !replay;
            },
          },
        ],
      },
    );
    if (result.rejectedReason) {
      throw new Error(
        `Session ${row.session_key} changed before its heartbeat outcome could be retired.`,
      );
    }
  }
}
