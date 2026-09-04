import {
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../infra/agent-events.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseClaim,
  type OpenClawAgentDatabaseIdentity,
} from "../state/openclaw-agent-db-identity.js";

type SessionBackgroundIdentity = { sessionId?: string; lifecycleRevision?: string };
type SessionBackgroundScope = {
  database: OpenClawAgentDatabaseClaim["database"];
  sessionKey: string;
};
export type SessionBackgroundTarget = SessionBackgroundIdentity & {
  agentId: string;
  sessionKey: string;
  lifecycleGeneration: string;
  abortController: AbortController;
  databaseClaim: OpenClawAgentDatabaseClaim;
};

const custody = resolveGlobalSingleton(Symbol.for("openclaw.sessionBackgroundCustody"), () => ({
  targets: new Map<OpenClawAgentDatabaseIdentity, Map<string, Set<SessionBackgroundTarget>>>(),
  releases: new WeakMap<SessionBackgroundTarget, () => void>(),
  retired: new WeakSet<SessionBackgroundTarget>(),
}));

function findTargets(scope: SessionBackgroundScope): Set<SessionBackgroundTarget> | undefined {
  if (custody.targets.size === 0) {
    return undefined;
  }
  return custody.targets
    .get(getOpenClawAgentDatabaseIdentity(scope.database))
    ?.get(scope.sessionKey);
}

function sameIdentity(
  left: SessionBackgroundIdentity | undefined,
  right: SessionBackgroundIdentity | undefined,
): boolean {
  return (
    left?.sessionId === right?.sessionId && left?.lifecycleRevision === right?.lifecycleRevision
  );
}

function captureTargets(
  scope: SessionBackgroundScope,
  previous: SessionBackgroundIdentity | undefined,
) {
  return [...(findTargets(scope) ?? [])].filter((target) => sameIdentity(target, previous));
}

/** Retain only live process/queue custody; completed occurrences leave no identity history. */
export function retainSessionBackgroundTarget(target: SessionBackgroundTarget): void {
  const { databaseClaim, sessionKey } = target;
  databaseClaim.assertCurrent();
  const sessions = custody.targets.get(databaseClaim.identity) ?? new Map();
  const targets = sessions.get(sessionKey) ?? new Set<SessionBackgroundTarget>();
  targets.add(target);
  sessions.set(sessionKey, targets);
  custody.targets.set(databaseClaim.identity, sessions);
  custody.releases.set(target, () => {
    targets.delete(target);
    if (targets.size === 0) {
      sessions.delete(sessionKey);
    }
    if (sessions.size === 0) {
      custody.targets.delete(databaseClaim.identity);
    }
    custody.releases.delete(target);
    databaseClaim.release();
  });
}

export function releaseSessionBackgroundTarget(target: SessionBackgroundTarget): void {
  custody.releases.get(target)?.();
}

export function isSessionBackgroundTargetRetired(target: SessionBackgroundTarget): boolean {
  return custody.retired.has(target) || !target.databaseClaim.isCurrent();
}

function retireTarget(target: SessionBackgroundTarget): void {
  releaseSessionBackgroundTarget(target);
  custody.retired.add(target);
  target.abortController.abort();
}

/** Capture subscribers before commit; later same-identity work belongs to a new occurrence. */
export function prepareSessionBackgroundTargetRetirement(
  database: SessionBackgroundScope["database"],
  entries: Iterable<readonly [string, SessionBackgroundIdentity | undefined]>,
): () => void {
  const captured = new Set<SessionBackgroundTarget>();
  for (const [sessionKey, previous] of entries) {
    if (!previous) {
      continue;
    }
    for (const target of captureTargets({ database, sessionKey }, previous)) {
      captured.add(target);
    }
  }
  return () => {
    for (const target of captured) {
      retireTarget(target);
    }
  };
}

/** Only the canonical compaction commit may carry pending work into a successor. */
export function advanceSessionBackgroundTargets(
  params: SessionBackgroundScope & {
    agentId: string;
    previous: SessionBackgroundIdentity;
    current: SessionBackgroundIdentity;
  },
): void {
  const captured = captureTargets(params, params.previous);
  const publish = () => {
    for (const target of captured) {
      if (target.agentId === params.agentId && sameIdentity(target, params.previous)) {
        target.sessionId = params.current.sessionId;
        target.lifecycleRevision = params.current.lifecycleRevision;
      }
    }
  };
  if (!deferSqlitePostCommitPublication(params.database.db, publish)) {
    publish();
  }
}

export function prepareChangedSessionBackgroundTargets(
  params: SessionBackgroundScope & {
    previous: SessionBackgroundIdentity | undefined;
    current: SessionBackgroundIdentity | undefined;
    reset?: true;
  },
): () => void {
  const captured =
    !params.reset && sameIdentity(params.previous, params.current)
      ? []
      : captureTargets(params, params.previous);
  // Shared SQLite stores can put several agents behind one global row. A row replacement
  // retires all of its old subscribers; separate per-agent stores never share this key.
  return () => {
    for (const target of captured) {
      // Compaction can explicitly accept a successor before generic publication.
      if (sameIdentity(target, params.previous)) {
        retireTarget(target);
      }
    }
  };
}

registerAgentEventLifecycleRotationHandler("session-background-custody", () => {
  // Aborting an old owner can rotate again and retain work in that newer lifecycle.
  const previous = Array.from(custody.targets.values())
    .flatMap((sessions) => Array.from(sessions.values()).flatMap((targets) => Array.from(targets)))
    .filter((target) => !isAgentEventLifecycleGenerationCurrent(target.lifecycleGeneration));
  previous.forEach(retireTarget);
});
