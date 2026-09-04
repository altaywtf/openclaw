import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { sanitizeCompactionMessages } from "../agents/compaction-planning.js";
import { assembleHarnessContextEngine } from "../agents/harness/context-engine-lifecycle.js";
import { convertToLlm } from "../agents/sessions/messages.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyContextEngine } from "../context-engine/legacy.js";
import { persistHeartbeatOutcome } from "../infra/heartbeat-outcome-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  applyHeartbeatOutcomeRetirement,
  prepareHeartbeatOutcomeRetirement,
} from "./doctor-heartbeat-outcome-migration.js";

const roots: string[] = [];
const now = 2_000_000_000_000;
afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(initialize = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-outcome-retirement-"));
  roots.push(root);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("HOME", path.join(root, "home"));
  vi.spyOn(Date, "now").mockReturnValue(now);
  const env = { ...process.env };
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main" }] },
    session: { reset: { mode: "idle", idleMinutes: 60 } },
  };
  const scope = {
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env }),
    sessionKey: "agent:main:main",
    env,
  };
  const session = {
    sessionId: "session-one",
    lifecycleRevision: "generation-one",
    updatedAt: now,
    sessionStartedAt: now - 1000,
  };
  const persist = (summary = "Inbox cleared") =>
    persistHeartbeatOutcome({
      ...scope,
      runSessionKey: "agent:main:main:heartbeat",
      occurredAt: now - 500,
      response: {
        outcome: "done",
        summary,
        notify: false,
        reason: "No urgent work remains",
        priority: "high",
        nextCheck: "Tomorrow",
      },
      taskNames: ["inbox", "calendar"],
      wakeSource: "interval",
      wakeReason: "scheduled check",
    });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope))).db;
  const row = () =>
    database()
      .prepare("SELECT * FROM heartbeat_outcomes WHERE session_key = ?")
      .get(scope.sessionKey);
  const events = () => loadTranscriptEvents({ ...scope, sessionId: session.sessionId });
  if (initialize) {
    await replaceSessionEntry(scope, session);
    persist();
  }
  return { env, config, scope, session, persist, database, row, events };
}

it("prepares missing state without creating databases", async () => {
  const f = await fixture(false);
  expect(prepareHeartbeatOutcomeRetirement(f.config, f.env)).toMatchObject({
    imports: [],
    retainedExpired: [],
  });
  await expect(fs.stat(resolveOpenClawStateSqlitePath(f.env))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("imports all known facts as hidden context and retains the source row across reopen and replay", async () => {
  const f = await fixture();
  const before = f.row();
  const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  expect(plan.imports).toHaveLength(1);
  await applyHeartbeatOutcomeRetirement(plan);
  const after = f.row();
  expect(after).toEqual({
    ...before,
    context_run_id: plan.imports[0]!.importId,
    context_claimed_at: now,
  });
  const messages = await f.events();
  const text = JSON.stringify(messages);
  for (const fact of [
    "Inbox cleared",
    "No urgent work remains",
    "high",
    "Tomorrow",
    "inbox",
    "calendar",
    "interval",
    "scheduled check",
    "agent:main:main:heartbeat",
  ]) {
    expect(text).toContain(fact);
  }
  expect(messages).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({ role: "custom", display: false }),
    }),
  );
  expect(sessionAccessor.loadSessionEntryReadOnly(f.scope)).toMatchObject(f.session);
  closeOpenClawAgentDatabasesForTest();
  await applyHeartbeatOutcomeRetirement(plan);
  expect(await f.events()).toEqual(messages);
  expect(prepareHeartbeatOutcomeRetirement(f.config, f.env).imports.length).toBe(0);
  expect(f.row()).toEqual(after);
});

it("keeps imported facts in next-turn model context and compaction after reopen", async () => {
  const f = await fixture();
  await applyHeartbeatOutcomeRetirement(prepareHeartbeatOutcomeRetirement(f.config, f.env));
  closeOpenClawAgentDatabasesForTest();
  const manager = SessionManager.openModelContext({ ...f.scope, sessionId: f.session.sessionId });
  manager.appendMessage({ role: "user", content: "What happened?", timestamp: now + 1 });
  const assembled = await assembleHarnessContextEngine({
    contextEngine: new LegacyContextEngine(),
    sessionId: f.session.sessionId,
    modelId: "synthetic-model",
    messages: manager.buildSessionContext().messages,
    tokenBudget: 8_000,
  });
  const messages = assembled!.messages;
  expect(JSON.stringify(convertToLlm(messages))).toContain("Inbox cleared");
  expect(JSON.stringify(convertToLlm(sanitizeCompactionMessages(messages)))).toContain(
    "Inbox cleared",
  );
  expect(messages[0]).toMatchObject({
    role: "custom",
    customType: "openclaw.system-note",
    display: false,
  });
});

it("rolls the consumed marker back when the transcript insert fails", async () => {
  const f = await fixture();
  const before = f.row();
  const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  f.database().exec(
    "CREATE TRIGGER reject_outcome_context BEFORE INSERT ON transcript_events BEGIN SELECT RAISE(ABORT, 'context insert failed'); END",
  );
  await expect(applyHeartbeatOutcomeRetirement(plan)).rejects.toThrow("context insert failed");
  expect(f.row()).toEqual(before);
  f.database().exec("DROP TRIGGER reject_outcome_context");
  await applyHeartbeatOutcomeRetirement(plan);
  expect(f.row()).toMatchObject({ context_run_id: plan.imports[0]!.importId });
});

it("does not reappend when the caller loses acknowledgement after the transaction committed", async () => {
  const f = await fixture();
  const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  const persistTurn = sessionAccessor.persistSessionTranscriptTurn;
  vi.spyOn(sessionAccessor, "persistSessionTranscriptTurn").mockImplementationOnce(
    async (...args) => {
      await persistTurn(...args);
      throw new Error("lost acknowledgement");
    },
  );
  await expect(applyHeartbeatOutcomeRetirement(plan)).rejects.toThrow("lost acknowledgement");
  const committed = await f.events();
  await applyHeartbeatOutcomeRetirement(plan);
  expect(await f.events()).toEqual(committed);
  expect(f.row()).toMatchObject({ context_run_id: plan.imports[0]!.importId });
});

it("keeps a consumed outcome retired after its same-session transcript is replaced", async () => {
  const f = await fixture();
  const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  await applyHeartbeatOutcomeRetirement(plan);
  const consumed = f.row();
  await replaceTranscriptEvents({ ...f.scope, sessionId: f.session.sessionId }, []);
  closeOpenClawAgentDatabasesForTest();
  const freshPlan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  expect(freshPlan.imports).toEqual([]);
  await applyHeartbeatOutcomeRetirement(plan);
  expect(await f.events()).toEqual([]);
  await applyHeartbeatOutcomeRetirement(freshPlan);
  expect(await f.events()).toEqual([]);
  expect(f.row()).toEqual(consumed);
});

it("rejects a replacement outcome in the real append transaction", async () => {
  const f = await fixture();
  const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  const persistTurn = sessionAccessor.persistSessionTranscriptTurn;
  vi.spyOn(sessionAccessor, "persistSessionTranscriptTurn").mockImplementationOnce(
    async (...args) => {
      f.persist("Newer outcome");
      return await persistTurn(...args);
    },
  );
  await expect(applyHeartbeatOutcomeRetirement(plan)).rejects.toThrow(
    "changed before its transcript commit",
  );
  expect(f.row()).toMatchObject({ summary: "Newer outcome", context_run_id: null });
  expect(JSON.stringify(await f.events())).not.toContain("Inbox cleared");
});

it("rejects a lifecycle rotation without consuming its old outcome", async () => {
  const f = await fixture();
  const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  const before = f.row();
  const persistTurn = sessionAccessor.persistSessionTranscriptTurn;
  vi.spyOn(sessionAccessor, "persistSessionTranscriptTurn").mockImplementationOnce(
    async (...args) => {
      await replaceSessionEntry(f.scope, { ...f.session, lifecycleRevision: "generation-two" });
      return await persistTurn(...args);
    },
  );
  await expect(applyHeartbeatOutcomeRetirement(plan)).rejects.toThrow(
    "changed before its heartbeat outcome",
  );
  expect(f.row()).toEqual(before);
  expect(JSON.stringify(await f.events())).not.toContain("Inbox cleared");
});

it.each(["previous session", "expired session"])(
  "retains %s facts without promoting them into current context",
  async (reason) => {
    const f = await fixture();
    await replaceSessionEntry(f.scope, {
      ...f.session,
      ...(reason === "previous session"
        ? { sessionStartedAt: now }
        : { updatedAt: now - 7_200_000, lastInteractionAt: now - 7_200_000 }),
    });
    const before = f.row();
    const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
    expect(plan.imports.length).toBe(0);
    expect(plan.retainedExpired).toEqual([{ agentId: "main", sessionKey: f.scope.sessionKey }]);
    await applyHeartbeatOutcomeRetirement(plan);
    expect(f.row()).toEqual(before);
    expect(JSON.stringify(await f.events())).not.toContain("Inbox cleared");
  },
);

it("rechecks reset freshness after awaiting the transcript owner", async () => {
  const f = await fixture();
  const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
  const before = f.row();
  const persistTurn = sessionAccessor.persistSessionTranscriptTurn;
  vi.spyOn(sessionAccessor, "persistSessionTranscriptTurn").mockImplementationOnce(
    async (...args) => {
      vi.spyOn(Date, "now").mockReturnValue(now + 7_200_000);
      return await persistTurn(...args);
    },
  );
  await expect(applyHeartbeatOutcomeRetirement(plan)).rejects.toThrow(
    "changed before its transcript commit",
  );
  expect(f.row()).toEqual(before);
});

it.each(["shared", "per-agent", "per-agent global"])(
  "imports each logical owner once from %s stores across interrupted retry",
  async (kind) => {
    const f = await fixture(false);
    f.config.agents = { ownership: "explicit", entries: { main: {}, ops: {} } };
    if (kind === "shared") {
      f.config.session!.store = path.join(f.env.OPENCLAW_STATE_DIR!, "shared.sqlite");
    }
    const scopes = ["main", "ops"].map((agentId) => ({
      env: f.env,
      agentId,
      sessionKey: kind === "per-agent global" ? "global" : `agent:${agentId}:main`,
      sessionId: `session-${agentId}`,
      storePath: resolveSessionStorePathCore(f.config.session?.store, { agentId, env: f.env }),
    }));
    for (const scope of scopes) {
      await replaceSessionEntry(scope, { ...f.session, sessionId: scope.sessionId });
      persistHeartbeatOutcome({
        ...scope,
        runSessionKey: `${scope.sessionKey}:heartbeat`,
        occurredAt: now - 500,
        response: { outcome: "done", summary: `Result for ${scope.agentId}`, notify: false },
      });
    }
    const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
    expect(plan.imports.map(({ scope }) => [scope.agentId, scope.sessionKey])).toEqual([
      ["main", kind === "per-agent global" ? "global" : "agent:main:main"],
      ["ops", kind === "per-agent global" ? "global" : "agent:ops:main"],
    ]);
    const persistTurn = sessionAccessor.persistSessionTranscriptTurn;
    vi.spyOn(sessionAccessor, "persistSessionTranscriptTurn").mockImplementationOnce(
      async (...args) => {
        await persistTurn(...args);
        throw new Error("Interrupted between owners");
      },
    );
    await expect(applyHeartbeatOutcomeRetirement(plan)).rejects.toThrow(
      "Interrupted between owners",
    );
    closeOpenClawAgentDatabasesForTest();
    const retry = prepareHeartbeatOutcomeRetirement(f.config, f.env);
    expect(retry.imports.map(({ scope }) => scope.agentId)).toEqual(["ops"]);
    await applyHeartbeatOutcomeRetirement(retry);
    for (const scope of scopes) {
      const messages = await loadTranscriptEvents(scope);
      const contexts = messages.filter(
        (event) => asOptionalRecord(asOptionalRecord(event)?.message)?.role === "custom",
      );
      expect(contexts).toHaveLength(1);
      expect(JSON.stringify(contexts)).toContain(`Result for ${scope.agentId}`);
    }
    expect(prepareHeartbeatOutcomeRetirement(f.config, f.env).imports).toHaveLength(0);
  },
);

it.each([undefined, "ops", "retired"])(
  "requires a proven logical owner for a shared global outcome (owner: %s)",
  async (owner) => {
    const f = await fixture(false);
    f.config.agents = {
      ownership: "explicit",
      entries: { main: {}, ops: {} },
      ...(owner ? { defaults: { sessionStore: { agentId: owner } } } : {}),
    };
    f.config.session = {
      ...f.config.session,
      scope: "global",
      store: path.join(f.env.OPENCLAW_STATE_DIR!, "shared.sqlite"),
    };
    const scope = {
      ...f.scope,
      agentId: "ops",
      storePath: f.config.session.store,
      sessionKey: "global",
      sessionId: f.session.sessionId,
    };
    await replaceSessionEntry(scope, f.session);
    persistHeartbeatOutcome({
      ...scope,
      runSessionKey: "agent:ops:global:heartbeat",
      occurredAt: now - 500,
      response: { outcome: "done", summary: "Global result for ops", notify: false },
    });
    if (owner !== "ops") {
      expect(() => prepareHeartbeatOutcomeRetirement(f.config, f.env)).toThrow("configured owner");
      expect(JSON.stringify(await loadTranscriptEvents(scope))).not.toContain(
        "Global result for ops",
      );
      return;
    }
    const plan = prepareHeartbeatOutcomeRetirement(f.config, f.env);
    expect(plan.imports.map((item) => [item.scope.agentId, item.scope.sessionKey])).toEqual([
      ["ops", "global"],
    ]);
    await applyHeartbeatOutcomeRetirement(plan);
    expect(JSON.stringify(await loadTranscriptEvents(scope))).toContain("Global result for ops");
  },
);
