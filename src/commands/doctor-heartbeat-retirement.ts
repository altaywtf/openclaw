import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  completeProactiveJobInDatabase,
  readDefaultProactiveJobReceiptInDatabase,
  recordPendingProactiveJobInDatabase,
  type PendingProactiveJobReceipt,
} from "../cron/proactive-job-receipt.js";
import { readCronJobScratchStateInDatabase } from "../cron/scratch-store.js";
import { noteCronJobsStoreCommit } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import { listActiveCronRunReceiptJobIdsInDatabase } from "../cron/store/run-receipt-store.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { sameFsObject } from "../infra/path-case.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  assertHeartbeatRetirementSourceSelection,
  assertPendingDestination,
  isLegacyJob,
  withoutHeartbeatConfig,
  type HeartbeatRetirementPlan,
} from "./doctor-heartbeat-retirement-plan.js";
import {
  assertHeartbeatRetirementInheritedPolicy,
  heartbeatRetirementConfigFingerprint,
} from "./doctor-heartbeat-retirement-policy.js";
import {
  archiveHeartbeatSource,
  archivePathForSource,
  claimHeartbeatSource,
  readHeartbeatSource,
} from "./doctor-heartbeat-scratch-migration.js";
export {
  prepareHeartbeatRetirement,
  type HeartbeatRetirementPlan,
} from "./doctor-heartbeat-retirement-plan.js";

async function assertAbsentHeartbeatSources(
  plan: HeartbeatRetirementPlan,
  agentIds = plan.sourceSelection.agents.map(({ agentId }) => agentId),
): Promise<void> {
  for (const agentId of agentIds) {
    if (await readHeartbeatSource(plan.effectiveConfig, agentId, { env: plan.env })) {
      throw new Error("A heartbeat source remains; configuration was retained.");
    }
  }
}

// A contained link may leave its workspace and return through another source.
// Resolve removable-entry dependencies before publishing pending destinations.
async function orderHeartbeatSources(sources: HeartbeatRetirementPlan["sources"]) {
  const pending = new Map(
    sources
      .toSorted((a, b) => a.source.entryKey.localeCompare(b.source.entryKey))
      .map((item) => [item.source.entryKey, { item, dependencies: new Set<string>() }]),
  );
  for (const [entry, { dependencies }] of pending) {
    let current = entry;
    const visited = new Set<string>();
    while ((await fs.lstat(current)).isSymbolicLink()) {
      if (visited.has(current)) {
        throw new Error("Heartbeat source links changed into a cycle; configuration was retained.");
      }
      visited.add(current);
      const link = await fs.readlink(current);
      // Resolve symlink parents before collapsing '..'; lexical normalization
      // can otherwise select a different file or invent a cycle.
      const target = path.isAbsolute(link) ? link : `${path.dirname(current)}${path.sep}${link}`;
      const parent = await fs.realpath(path.dirname(target));
      current = path.join(parent, path.basename(target));
      const dependency = [...pending.keys()].find(
        (candidate) =>
          path.dirname(candidate) === parent &&
          path.basename(candidate).toLowerCase() === path.basename(current).toLowerCase(),
      );
      // Case variants are aliases only when the filesystem proves they name
      // the same entry; never collapse distinct files on case-sensitive stores.
      if (
        dependency &&
        (dependency === current ||
          sameFsObject(await fs.lstat(dependency), await fs.lstat(current)))
      ) {
        dependencies.add(dependency);
      }
    }
  }
  const ordered: typeof sources = [];
  while (pending.size) {
    const ready = [...pending].find(
      ([entry]) => ![...pending.values()].some(({ dependencies }) => dependencies.has(entry)),
    );
    if (!ready) {
      throw new Error(
        "Heartbeat source dependencies changed into a cycle; configuration was retained.",
      );
    }
    ordered.push(ready[1].item);
    pending.delete(ready[0]);
  }
  return ordered;
}

/** Dormant until the integration owner installs ordinary policy execution and its schema fence. */
export async function applyHeartbeatRetirement(
  plan: HeartbeatRetirementPlan,
  finalConfig: OpenClawConfig,
): Promise<void> {
  if (
    heartbeatRetirementConfigFingerprint(finalConfig) !==
    heartbeatRetirementConfigFingerprint(withoutHeartbeatConfig(finalConfig))
  ) {
    throw new Error("The final Doctor candidate still contains heartbeat configuration.");
  }
  assertHeartbeatRetirementSourceSelection(plan, finalConfig);
  assertHeartbeatRetirementInheritedPolicy(plan, finalConfig);
  const retiredConfigRevision = heartbeatRetirementConfigFingerprint(finalConfig);
  let claim: Awaited<ReturnType<typeof claimHeartbeatSource>> | undefined;
  try {
    const sources = await orderHeartbeatSources(plan.sources);
    for (const source of sources) {
      await archiveHeartbeatSource({ ...source, env: plan.env });
    }
    for (const { source, agentId } of plan.sources) {
      if (
        !isDeepStrictEqual(
          await readHeartbeatSource(plan.effectiveConfig, agentId, { env: plan.env }),
          source,
        )
      ) {
        throw new Error(
          "A heartbeat source changed during preparation; configuration was retained.",
        );
      }
    }
    await assertAbsentHeartbeatSources(plan, plan.absentSourceAgentIds);
    assertHeartbeatRetirementSourceSelection(plan, finalConfig);
    assertHeartbeatRetirementInheritedPolicy(plan, finalConfig);
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const storeKey = cronStoreKey(plan.storePath);
        const rows = loadCronRows(db, storeKey);
        const currentJobs = loadedCronStoreFromRows(rows).store.jobs;
        const activeIds = listActiveCronRunReceiptJobIdsInDatabase(db, plan.storePath);
        if (
          plan.agents.some((agent) =>
            (agent.receipt?.jobs ?? agent.jobs.map(({ job }) => ({ jobId: job.id }))).some(
              ({ jobId }) => activeIds.has(jobId),
            ),
          )
        ) {
          throw new Error(
            "An automation still has an active run receipt; finish recovery before heartbeat cutover.",
          );
        }
        if (
          !isDeepStrictEqual(
            currentJobs
              .filter(isLegacyJob)
              .map((job) => job.id)
              .toSorted(),
            plan.legacyJobIds,
          )
        ) {
          throw new Error("Legacy automation inventory changed during preparation.");
        }
        const scratch = (id: string) => readCronJobScratchStateInDatabase(db, storeKey, id);
        for (const agent of plan.agents) {
          const receipt = readDefaultProactiveJobReceiptInDatabase(
            db,
            plan.storePath,
            agent.agentId,
          );
          if (agent.receipt) {
            if (agent.receipt.retiredConfigRevision !== retiredConfigRevision) {
              throw new Error(
                "The final Doctor candidate changed during pending cutover; configuration was retained.",
              );
            }
            if (!isDeepStrictEqual(receipt, agent.receipt)) {
              throw new Error("Cutover receipt changed during preparation.");
            }
            assertPendingDestination(agent.receipt, currentJobs, scratch);
            continue;
          }
          if (receipt) {
            throw new Error("Cutover receipt appeared during preparation.");
          }
          for (const item of agent.jobs) {
            const current = currentJobs.find((job) => job.id === item.job.id);
            if (
              !isDeepStrictEqual(current, item.previous) ||
              current?.state.runningAtMs !== undefined ||
              current?.state.queuedAtMs !== undefined ||
              !isDeepStrictEqual(scratch(item.job.id), item.scratch)
            ) {
              throw new Error(
                `Automation ${item.job.id} changed during preparation; no cutover was committed.`,
              );
            }
          }
        }
        for (const agent of plan.agents) {
          if (agent.receipt) {
            continue;
          }
          const bindings: PendingProactiveJobReceipt["jobs"] = [];
          for (const item of agent.jobs) {
            const job = upsertCronJobRow(db, storeKey, item.job, item.sortOrder);
            if (!isDeepStrictEqual(item.scratch, item.nextScratch)) {
              const next = item.nextScratch;
              const values = {
                store_key: storeKey,
                job_id: job.id,
                revision: next.currentRevision,
                content: next.scratch?.content ?? null,
                source_sha256: next.scratch?.sourceSha256 ?? null,
                updated_at_ms: plan.nowMs,
              };
              executeSqliteQuerySync(
                db,
                getCronStoreKysely(db)
                  .insertInto("cron_job_scratch")
                  .values(values)
                  .onConflict((conflict) =>
                    conflict.columns(["store_key", "job_id"]).doUpdateSet(values),
                  ),
              );
            }
            bindings.push({
              jobId: job.id,
              configRevision: resolveCronJobConfigRevision(job),
              scratchRevision: item.nextScratch.currentRevision,
            });
          }
          recordPendingProactiveJobInDatabase(db, plan.storePath, agent.agentId, {
            phase: "pending",
            jobId: agent.defaultJobId,
            provisionedAtMs: plan.nowMs,
            sourceRevision: agent.sourceRevision,
            jobs: bindings,
            retiredConfigRevision,
            ...(agent.sourceFile ? { sourceFile: agent.sourceFile } : {}),
          });
        }
      },
      { env: plan.env },
      { operationLabel: "doctor.heartbeat-retirement.prepare" },
    );
    noteCronJobsStoreCommit(cronStoreKey(plan.storePath));
    for (const { source, agentId } of sources) {
      claim = await claimHeartbeatSource(source);
      await claim.release({
        archivePath: archivePathForSource(agentId, source.sha256, plan.env),
        verifyDestination: () => verifyPreparedDestinations(plan, finalConfig),
      });
      claim = undefined;
    }
    await assertAbsentHeartbeatSources(plan);
    assertHeartbeatRetirementSourceSelection(plan, finalConfig);
  } catch (error) {
    if (claim) {
      await claim.restore(error).catch((restoreError: unknown) => {
        throw new AggregateError(
          [error, restoreError],
          "Heartbeat cutover failed; preserve the migration claims and backups before retrying.",
          { cause: error },
        );
      });
    }
    throw error;
  }
}

/** Complete job receipts after the full owner verifies Claw/outcomes and rereads canonical sourceConfig. */
export async function completeHeartbeatRetirement(
  plan: HeartbeatRetirementPlan,
  persistedConfig: OpenClawConfig,
): Promise<void> {
  if (
    heartbeatRetirementConfigFingerprint(persistedConfig) !==
    heartbeatRetirementConfigFingerprint(withoutHeartbeatConfig(persistedConfig))
  ) {
    throw new Error("Heartbeat configuration is still present; cutover remains pending.");
  }
  await assertAbsentHeartbeatSources(plan);
  assertHeartbeatRetirementSourceSelection(plan, persistedConfig);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const storeKey = cronStoreKey(plan.storePath);
      const jobs = loadedCronStoreFromRows(loadCronRows(db, storeKey)).store.jobs;
      if (jobs.some(isLegacyJob)) {
        throw new Error("Legacy automation remains unconverted; cutover stays pending.");
      }
      for (const agent of plan.agents) {
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, plan.storePath, agent.agentId);
        if (receipt?.phase === "complete") {
          continue;
        }
        if (!receipt || receipt.sourceRevision !== agent.sourceRevision) {
          throw new Error("Cutover receipt changed before completion.");
        }
        if (
          receipt.retiredConfigRevision !== heartbeatRetirementConfigFingerprint(persistedConfig)
        ) {
          throw new Error(
            "Persisted configuration differs from the final Doctor candidate; cutover remains pending.",
          );
        }
        assertPendingDestination(receipt, jobs, (id) =>
          readCronJobScratchStateInDatabase(db, storeKey, id),
        );
        completeProactiveJobInDatabase(db, plan.storePath, agent.agentId, receipt);
      }
    },
    { env: plan.env },
    { operationLabel: "doctor.heartbeat-retirement.complete" },
  );
  noteCronJobsStoreCommit(cronStoreKey(plan.storePath));
}

function verifyPreparedDestinations(
  plan: HeartbeatRetirementPlan,
  finalConfig: OpenClawConfig,
): void {
  assertHeartbeatRetirementSourceSelection(plan, finalConfig);
  const found = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const storeKey = cronStoreKey(plan.storePath);
      const jobs = loadedCronStoreFromRows(loadCronRows(db, storeKey)).store.jobs;
      for (const agent of plan.agents) {
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, plan.storePath, agent.agentId);
        if (receipt?.phase !== "pending" || receipt.sourceRevision !== agent.sourceRevision) {
          throw new Error("Cutover receipt changed before source retirement.");
        }
        assertPendingDestination(receipt, jobs, (id) =>
          readCronJobScratchStateInDatabase(db, storeKey, id),
        );
      }
      return true;
    },
    { env: plan.env },
  );
  if (!found) {
    throw new Error("Cutover state disappeared before source retirement.");
  }
}
