import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolvePersistedSessionStoreOwner } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { heartbeatTaskDeclarationKey, isHeartbeatTaskCronJob } from "../cron/heartbeat-task.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  type PendingProactiveJobReceipt,
} from "../cron/proactive-job-receipt.js";
import { cronSchedulingInputsEqual } from "../cron/schedule-identity.js";
import { assertCronJobScratchContent } from "../cron/scratch-contract.js";
import {
  readCronJobScratchStateInDatabase,
  type CronJobScratchState,
} from "../cron/scratch-store.js";
import { computeJobNextRunAtMs } from "../cron/service/jobs-scheduling.js";
import { finalizeUpdatedJob } from "../cron/service/ops-mutations.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { resolveHeartbeatAgents, resolveHeartbeatConfig } from "../infra/heartbeat-config.js";
import { resolveHeartbeatSessionKey } from "../infra/heartbeat-runner-session.js";
import {
  resolveHeartbeatPhaseMs,
  resolveHeartbeatSchedulerSeed,
} from "../infra/heartbeat-schedule.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  convertHeartbeatJobForRetirement,
  heartbeatRetirementConfigFingerprint,
  heartbeatRetirementFingerprint,
  resolveHeartbeatRetirementPolicy,
  type RetiredHeartbeatJob,
} from "./doctor-heartbeat-retirement-policy.js";
import { readHeartbeatSource, type HeartbeatSource } from "./doctor-heartbeat-scratch-migration.js";
import { validateLegacyHeartbeatTasks } from "./doctor-heartbeat-task-migration.js";
import { analyzeLegacyHeartbeatTasks } from "./heartbeat-task-legacy.js";

type JobPlan = {
  previous?: CronStoredJob;
  job: RetiredHeartbeatJob;
  sortOrder: number;
  scratch: CronJobScratchState;
  nextScratch: CronJobScratchState;
};
type AgentPlan = {
  agentId: string;
  sourceRevision: string;
  receipt?: PendingProactiveJobReceipt;
  jobs: JobPlan[];
  defaultJobId: string;
  sourceFile?: { entryKey: string; sha256: string };
};
type SourcePlan = { source: HeartbeatSource; agentId: string };
export type HeartbeatRetirementPlan = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  effectiveConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  storePath: string;
  agents: AgentPlan[];
  sources: SourcePlan[];
  absentSourceAgentIds: string[];
  nowMs: number;
  legacyJobIds: string[];
  sourceSelection: ReturnType<typeof resolveSourceSelection>;
};

function resolveSourceSelection(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, legacyConfig = cfg) {
  return {
    storePath: resolveCronJobsStorePathFromConfig(cfg, env),
    sessionStoreOwner: resolvePersistedSessionStoreOwner(cfg),
    agents: listAgentIds(cfg)
      .toSorted()
      .map((agentId) => {
        const session = resolveHeartbeatSessionKey(
          cfg,
          agentId,
          resolveHeartbeatConfig(legacyConfig, agentId),
          undefined,
          env,
        );
        const scope = resolveSqliteScope({ agentId, env, ...session });
        return {
          agentId,
          workspace: resolveIdentityPathViaExistingAncestorSync(
            resolveAgentWorkspaceDir(cfg, agentId, env),
          ),
          sessionKey: scope.sessionKey,
          databasePath: resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)),
        };
      }),
  };
}

/** Writer normalization may change spelling, but cannot move the prepared sources. */
export function assertHeartbeatRetirementSourceSelection(
  plan: HeartbeatRetirementPlan,
  cfg: OpenClawConfig,
): void {
  if (
    !isDeepStrictEqual(
      resolveSourceSelection(cfg, plan.env, plan.effectiveConfig),
      plan.sourceSelection,
    )
  ) {
    throw new Error(
      "Heartbeat source selection changed after preparation; configuration was retained.",
    );
  }
}

export function withoutHeartbeatConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(cfg);
  if (next.agents?.defaults) {
    delete next.agents.defaults.heartbeat;
  }
  for (const agent of Object.values(next.agents?.entries ?? {})) {
    delete agent.heartbeat;
  }
  for (const agent of next.agents?.list ?? []) {
    delete agent.heartbeat;
  }
  for (const channel of Object.values(next.channels ?? {})) {
    if (!isRecord(channel)) {
      continue;
    }
    delete channel.heartbeatVisibility;
    if (!isRecord(channel.accounts)) {
      continue;
    }
    for (const account of Object.values(channel.accounts)) {
      if (isRecord(account)) {
        delete account.heartbeatVisibility;
      }
    }
  }
  return next;
}

export function isLegacyJob(job: CronStoredJob): boolean {
  return job.payload.kind === "heartbeat" || isHeartbeatTaskCronJob(job);
}

export function assertPendingDestination(
  receipt: PendingProactiveJobReceipt,
  jobs: readonly CronStoredJob[],
  scratch: (jobId: string) => CronJobScratchState,
): void {
  for (const binding of receipt.jobs) {
    const job = jobs.find((candidate) => candidate.id === binding.jobId);
    if (
      !job ||
      job.state.runningAtMs !== undefined ||
      job.state.queuedAtMs !== undefined ||
      resolveCronJobConfigRevision(job) !== binding.configRevision ||
      scratch(job.id).currentRevision !== binding.scratchRevision
    ) {
      throw new Error(
        `Automation ${binding.jobId} changed during pending cutover; configuration was retained.`,
      );
    }
  }
}

/** Read-only preparation pins effective defaults separately from authored configuration. */
export async function prepareHeartbeatRetirement(params: {
  sourceConfig: OpenClawConfig;
  effectiveConfig: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<HeartbeatRetirementPlan> {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const cfg = params.effectiveConfig;
  const sourceSelection = resolveSourceSelection(cfg, env);
  const storePath = sourceSelection.storePath;
  const storeKey = cronStoreKey(storePath);
  const snapshot = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const rows = loadCronRows(db, storeKey);
      const loaded = loadedCronStoreFromRows(rows);
      if (loaded.invalidConfigRows.length) {
        throw new Error("Cron contains unreadable rows; repair them before heartbeat cutover.");
      }
      const jobs = loaded.store.jobs;
      return {
        jobs,
        sortOrder: new Map(rows.map((row) => [row.job_id, row.sort_order])),
        scratch: new Map(
          jobs.map((job) => [job.id, readCronJobScratchStateInDatabase(db, storeKey, job.id)]),
        ),
        receipts: new Map(
          listAgentIds(cfg).map((agentId) => [
            agentId,
            readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId),
          ]),
        ),
      };
    },
    { env },
  ) ?? { jobs: [], sortOrder: new Map(), scratch: new Map(), receipts: new Map() };
  const agentIds = new Set(resolveHeartbeatAgents(cfg).map((agent) => agent.agentId));
  const configured = new Set(listAgentIds(cfg));
  const sourceFiles = new Map<string, HeartbeatSource>();
  const sources = new Map<string, SourcePlan>();
  for (const agentId of configured) {
    const source = await readHeartbeatSource(cfg, agentId, { env });
    if (source) {
      sourceFiles.set(agentId, source);
      sources.set(source.entryKey, { source, agentId });
    }
    if (source || resolveHeartbeatConfig(cfg, agentId)) {
      agentIds.add(agentId);
    }
  }
  // Absence is part of the snapshot: a file appearing between shared owners'
  // reads must not be archived after only the later owner received its tasks.
  for (const agentId of configured) {
    if (
      !isDeepStrictEqual(await readHeartbeatSource(cfg, agentId, { env }), sourceFiles.get(agentId))
    ) {
      throw new Error("A heartbeat source changed during preparation; configuration was retained.");
    }
  }
  for (const job of snapshot.jobs.filter(isLegacyJob)) {
    if (!job.agentId || !configured.has(job.agentId)) {
      throw new Error(
        `Legacy automation ${job.id} has no configured owner; configuration was retained.`,
      );
    }
    agentIds.add(job.agentId);
  }
  for (const [agentId, receipt] of snapshot.receipts) {
    if (receipt) {
      agentIds.add(agentId);
    }
  }
  const agents: AgentPlan[] = [];
  let sortOrder = Math.max(-1, ...snapshot.sortOrder.values()) + 1;
  const seed = resolveHeartbeatSchedulerSeed(undefined, { env, readOnly: true });
  for (const agentId of [...agentIds].toSorted()) {
    const policy = resolveHeartbeatRetirementPolicy({ effectiveConfig: cfg, agentId, env });
    const sourceRevision = heartbeatRetirementFingerprint(policy);
    const receipt = snapshot.receipts.get(agentId);
    if (receipt?.phase === "complete") {
      if (
        sourceFiles.has(agentId) ||
        resolveHeartbeatConfig(params.sourceConfig, agentId) ||
        heartbeatRetirementConfigFingerprint({ channels: params.sourceConfig.channels }) !==
          heartbeatRetirementConfigFingerprint({
            channels: withoutHeartbeatConfig(params.sourceConfig).channels,
          })
      ) {
        throw new Error(
          `Agent ${agentId} acquired legacy heartbeat intent after completed cutover; configuration and files were retained.`,
        );
      }
      if (snapshot.jobs.some((job) => job.agentId === agentId && isLegacyJob(job))) {
        throw new Error(
          `Agent ${agentId} acquired legacy jobs after completed cutover; configuration was retained.`,
        );
      }
      continue;
    }
    if (receipt?.phase === "pending") {
      if (snapshot.jobs.some((job) => job.agentId === agentId && isLegacyJob(job))) {
        throw new Error(
          "Legacy automation appeared during pending cutover; configuration was retained.",
        );
      }
      if (
        receipt.sourceRevision !== sourceRevision &&
        receipt.retiredConfigRevision !== heartbeatRetirementConfigFingerprint(params.sourceConfig)
      ) {
        throw new Error(
          `Agent ${agentId} heartbeat policy changed during pending cutover; restore the original policy or a verified backup before retrying. Configuration was retained.`,
        );
      }
      assertPendingDestination(
        receipt,
        snapshot.jobs,
        (id) => snapshot.scratch.get(id) ?? { currentRevision: 0 },
      );
      const source = sourceFiles.get(agentId);
      const recorded = receipt.sourceFile;
      const workspace = sourceSelection.agents.find(
        (agent) => agent.agentId === agentId,
      )!.workspace;
      if (
        (recorded &&
          recorded.entryKey !== path.join(workspace, path.basename(recorded.entryKey))) ||
        (source && (recorded?.entryKey !== source.entryKey || recorded.sha256 !== source.sha256))
      ) {
        throw new Error(
          `Agent ${agentId} heartbeat file changed during pending cutover; configuration was retained.`,
        );
      }
      agents.push({
        agentId,
        sourceRevision: receipt.sourceRevision,
        receipt,
        defaultJobId: receipt.jobId,
        jobs: [],
      });
      continue;
    }
    const previousJobs = snapshot.jobs.filter((job) => job.agentId === agentId && isLegacyJob(job));
    const generated = previousJobs
      .filter(
        (job) => job.payload.kind === "heartbeat" && job.declarationKey === `heartbeat:${agentId}`,
      )
      .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs);
    const everyMs = policy.everyMs ?? 30 * 60_000;
    const original = generated[0] ?? {
      id: randomUUID(),
      agentId,
      name: `Proactive check (${agentId})`,
      enabled: policy.eligible,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: {
        kind: "every" as const,
        everyMs,
        anchorMs: resolveHeartbeatPhaseMs({ schedulerSeed: seed, agentId, intervalMs: everyMs }),
      },
      payload: { kind: "heartbeat" as const },
      sessionTarget: "main" as const,
      wakeMode: "next-heartbeat" as const,
      state: {},
    };
    const monitor = convertHeartbeatJobForRetirement(original, policy, nowMs);
    // Config owns the canonical monitor; a stopped Gateway may not have applied
    // a cadence re-enable yet. Editable tasks retain their stored enabled flag.
    monitor.enabled = policy.eligible;
    if (
      generated[0] &&
      policy.everyMs !== null &&
      (monitor.schedule.kind !== "every" || monitor.schedule.everyMs !== policy.everyMs)
    ) {
      monitor.schedule = {
        kind: "every",
        everyMs: policy.everyMs,
        anchorMs: resolveHeartbeatPhaseMs({
          schedulerSeed: seed,
          agentId,
          intervalMs: policy.everyMs,
        }),
      };
    }
    if (!generated[0]) {
      monitor.state.nextRunAtMs = computeJobNextRunAtMs(monitor, nowMs);
    } else if (!cronSchedulingInputsEqual(original, monitor)) {
      finalizeUpdatedJob({
        job: original,
        nextJob: monitor,
        now: nowMs,
        schedulingInputsRequested: true,
        scheduleChanged: !isDeepStrictEqual(original.schedule, monitor.schedule),
      });
    }
    const scratch = snapshot.scratch.get(monitor.id) ?? { currentRevision: 0 };
    const source = sourceFiles.get(agentId);
    let content = scratch.scratch?.content;
    if (source) {
      // SQLite is already authoritative after the first scratch mutation. A
      // leftover file is archived, but cannot revive an unset checklist or
      // overwrite an operator edit.
      if (scratch.currentRevision === 0) {
        content = source.content;
      }
    }
    const document = analyzeLegacyHeartbeatTasks(content ?? "");
    const tasks = document.hasTasksBlock
      ? validateLegacyHeartbeatTasks(document.tasks, document.taskEntryCount)
      : [];
    const jobs: JobPlan[] = [
      {
        previous: generated[0],
        job: monitor,
        sortOrder: snapshot.sortOrder.get(monitor.id) ?? sortOrder++,
        scratch,
        nextScratch: scratch,
      },
    ];
    if (content !== undefined) {
      assertCronJobScratchContent(document.strippedContent);
      const sourceSha256 =
        scratch.currentRevision === 0 ? source?.sha256 : scratch.scratch?.sourceSha256;
      if (
        scratch.scratch?.content !== document.strippedContent ||
        scratch.scratch?.sourceSha256 !== sourceSha256
      ) {
        const revision = scratch.currentRevision + 1;
        jobs[0]!.nextScratch = {
          currentRevision: revision,
          scratch: {
            content: document.strippedContent,
            revision,
            updatedAtMs: nowMs,
            ...(sourceSha256 ? { sourceSha256 } : {}),
          },
        };
      }
    }
    for (const previous of previousJobs.filter((job) => job !== generated[0])) {
      if (
        previous.payload.kind === "heartbeat" &&
        previous.declarationKey?.startsWith("heartbeat:") &&
        !generated.includes(previous)
      ) {
        throw new Error(
          `Legacy monitor ${previous.id} has a conflicting declaration; configuration was retained.`,
        );
      }
      const state = snapshot.scratch.get(previous.id) ?? { currentRevision: 0 };
      const job = convertHeartbeatJobForRetirement(previous, policy, nowMs);
      // Match the monitor reconciler's newest-row winner while retaining the
      // retired duplicates' IDs, scratch, and history for inspection.
      if (generated.includes(previous)) {
        job.enabled = false;
      }
      jobs.push({
        previous,
        job,
        sortOrder: snapshot.sortOrder.get(previous.id)!,
        scratch: state,
        nextScratch: state,
      });
    }
    const session = loadSessionEntryReadOnly({
      agentId,
      storePath: policy.sessionStorePath,
      sessionKey: policy.sessionKey,
      env,
    });
    for (const { task, intervalMs, occurrenceIndex } of tasks) {
      const declaration = heartbeatTaskDeclarationKey(agentId, task.name, occurrenceIndex);
      const matches = snapshot.jobs.filter((job) => job.declarationKey === declaration);
      if (
        matches.length > 1 ||
        (matches[0] && (!isHeartbeatTaskCronJob(matches[0]) || matches[0].agentId !== agentId))
      ) {
        throw new Error(
          `Heartbeat task ${task.name} collides with another automation; configuration was retained.`,
        );
      }
      if (matches[0]) {
        continue;
      }
      const lastRunAtMs = session?.heartbeatTaskState?.[task.name];
      const anchorMs =
        typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs)
          ? Math.max(nowMs + 1, lastRunAtMs + intervalMs)
          : nowMs + 1;
      const job: RetiredHeartbeatJob = {
        id: randomUUID(),
        agentId,
        name: task.name,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        enabled: policy.eligible,
        sessionKey: policy.sessionKey,
        sessionTarget: policy.sessionTarget,
        wakeMode: "now",
        activeHours: policy.activeHours,
        idleOnly: true,
        delivery: policy.delivery,
        schedule: { kind: "every", everyMs: intervalMs, anchorMs },
        payload: { kind: "agentTurn", message: task.prompt, ...policy.payload },
        state:
          typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs) ? { lastRunAtMs } : {},
      };
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
      jobs.push({
        job,
        sortOrder: sortOrder++,
        scratch: { currentRevision: 0 },
        nextScratch: { currentRevision: 0 },
      });
    }
    agents.push({
      agentId,
      sourceRevision,
      jobs,
      defaultJobId: monitor.id,
      ...(source ? { sourceFile: { entryKey: source.entryKey, sha256: source.sha256 } } : {}),
    });
  }
  return {
    sourceConfig: structuredClone(params.sourceConfig),
    effectiveConfig: structuredClone(cfg),
    config: withoutHeartbeatConfig(params.sourceConfig),
    storePath,
    env,
    nowMs,
    sourceSelection,
    agents,
    sources: [...sources.values()],
    absentSourceAgentIds: [...configured].filter((agentId) => !sourceFiles.has(agentId)),
    legacyJobIds: snapshot.jobs
      .filter(isLegacyJob)
      .map((job) => job.id)
      .toSorted(),
  };
}
