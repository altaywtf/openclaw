import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readConfigMachineStateWithMetadataInDatabase,
  writeConfigMachineStateInDatabase,
} from "../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { cronStoreKey } from "./store/key.js";

const JobBindingSchema = z
  .object({
    jobId: z.string().min(1),
    configRevision: z.string().min(1),
    scratchRevision: z.number().int().nonnegative(),
  })
  .strict();
const ReceiptIdentity = {
  jobId: z.string().min(1),
  provisionedAtMs: z.number().int().nonnegative(),
};
const ProactiveReceiptSchema = z.discriminatedUnion("phase", [
  z
    .object({
      ...ReceiptIdentity,
      phase: z.literal("pending"),
      sourceRevision: z.string().min(1),
      retiredConfigRevision: z.string().min(1),
      sourceFile: z
        .object({ entryKey: z.string().min(1), sha256: z.string().min(1) })
        .strict()
        .optional(),
      jobs: z.array(JobBindingSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...ReceiptIdentity,
      phase: z.literal("complete"),
      convertedJobIds: z.array(z.string().min(1)),
    })
    .strict(),
]);

export type ProactiveJobReceipt = z.infer<typeof ProactiveReceiptSchema>;
export type PendingProactiveJobReceipt = Extract<ProactiveJobReceipt, { phase: "pending" }>;

function receiptKey(storePath: string, agentId: string): string {
  return `automation-default:${cronStoreKey(storePath)}:${normalizeAgentId(agentId)}`;
}

export function readDefaultProactiveJobReceiptInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
): ProactiveJobReceipt | undefined {
  const value = readConfigMachineStateWithMetadataInDatabase(
    db,
    receiptKey(storePath, agentId),
  )?.value;
  if (value === undefined) {
    return undefined;
  }
  const decoded = ProactiveReceiptSchema.safeParse(value);
  if (!decoded.success) {
    throw new Error(
      `Invalid automation cutover receipt for ${agentId}; preserve the state and restore a verified backup before retrying.`,
    );
  }
  return decoded.data;
}

export function readDefaultProactiveJobReceipt(
  storePath: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): ProactiveJobReceipt | undefined {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId),
    options,
  );
}

/** Called in the same transaction that publishes the exact converted jobs and scratch. */
export function recordPendingProactiveJobInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
  receipt: PendingProactiveJobReceipt,
): void {
  const previous = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
  if (previous) {
    throw new Error(`Agent ${agentId} already has an automation cutover receipt.`);
  }
  writeConfigMachineStateInDatabase(
    db,
    receiptKey(storePath, agentId),
    JSON.stringify(receipt),
    Date.now(),
  );
}

/** Completion retains identity after operator edits or permanent job deletion. */
export function completeProactiveJobInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
  expected: PendingProactiveJobReceipt,
): void {
  const previous = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
  if (!previous || previous.phase !== "pending" || !isDeepStrictEqual(previous, expected)) {
    throw new Error(`Agent ${agentId} cutover receipt changed before completion.`);
  }
  const complete: ProactiveJobReceipt = {
    phase: "complete",
    jobId: previous.jobId,
    provisionedAtMs: previous.provisionedAtMs,
    convertedJobIds: previous.jobs.map((job) => job.jobId).filter((id) => id !== previous.jobId),
  };
  writeConfigMachineStateInDatabase(
    db,
    receiptKey(storePath, agentId),
    JSON.stringify(complete),
    Date.now(),
  );
}

export function isProactiveJobCutoverPending(
  storePath: string,
  job: { id: string; agentId?: string },
  db?: DatabaseSync,
): boolean {
  if (!job.agentId) {
    return false;
  }
  const receipt = db
    ? readDefaultProactiveJobReceiptInDatabase(db, storePath, job.agentId)
    : readDefaultProactiveJobReceipt(storePath, job.agentId);
  return receipt?.phase === "pending" && receipt.jobs.some((binding) => binding.jobId === job.id);
}
