import { isDeepStrictEqual } from "node:util";
import { stableStringify } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveUserTimezone } from "../agents/date-time.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelFallbacks,
  resolveModelRefFromString,
} from "../agents/model-selection-resolve.js";
import { applyModelDefaults } from "../config/defaults.js";
import { normalizeAgentModelRefForConfig, toAgentModelListLike } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronDelivery, CronStoredJob } from "../cron/types.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  resolveHeartbeatAgents,
  resolveHeartbeatConfig,
  resolveHeartbeatIntervalMs,
} from "../infra/heartbeat-config.js";
import { resolveHeartbeatSessionKey } from "../infra/heartbeat-runner-session.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";

type RetiredHeartbeatWindow = { start: string; end: string; timezone?: string };
type RetiredHeartbeatDelivery = CronDelivery & {
  target?: "owner";
  directPolicy?: "allow" | "block";
};

function alertsEnabled(cfg: OpenClawConfig, target: string, accountId?: string): boolean {
  const channels =
    target === "owner" || target === "last"
      ? Object.keys(cfg.channels ?? {}).filter(
          (key) => key !== "defaults" && key !== "modelByChannel",
        )
      : [target];
  const values = new Set(
    (channels.length ? channels : ["webchat"]).flatMap((channel) => {
      const accounts = Object.keys(
        asOptionalRecord(asOptionalRecord(cfg.channels?.[channel])?.accounts) ?? {},
      );
      return (accountId ? [accountId] : accounts.length ? accounts : [undefined]).map(
        (id) => resolveHeartbeatVisibility({ cfg, channel, accountId: id }).showAlerts,
      );
    }),
  );
  if (values.size !== 1) {
    throw new Error(
      "Mixed heartbeat alert visibility cannot be represented by one automation delivery policy; configuration was retained.",
    );
  }
  return values.has(true);
}

/** Prepared destination shape; runtime policy ownership lands with the complete cutover. */
export type RetiredHeartbeatJob = CronStoredJob & {
  activeHours?: RetiredHeartbeatWindow;
  idleOnly: true;
  delivery: RetiredHeartbeatDelivery;
  payload: Extract<CronStoredJob["payload"], { kind: "agentTurn" }> & {
    skipIfScratchEmpty?: boolean;
  };
};

export function resolveHeartbeatRetirementPolicy(params: {
  effectiveConfig: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
}) {
  const { effectiveConfig: cfg, agentId, env } = params;
  for (const channel of Object.values(cfg.channels ?? {})) {
    const entry = asOptionalRecord(channel);
    const records = [
      entry,
      ...Object.values(asOptionalRecord(entry?.accounts) ?? {}).map(asOptionalRecord),
    ];
    if (
      records.some((record) => {
        const visibility = asOptionalRecord(record?.heartbeatVisibility);
        return visibility?.showOk !== undefined || visibility?.useIndicator !== undefined;
      })
    ) {
      throw new Error(
        "Explicit heartbeat showOk/useIndicator settings have no ordinary cron equivalent; configuration was retained.",
      );
    }
  }
  const heartbeat = resolveHeartbeatConfig(cfg, agentId);
  const everyMs = resolveHeartbeatIntervalMs(cfg, undefined, heartbeat);
  const enrolled = resolveHeartbeatAgents(cfg).some((agent) => agent.agentId === agentId);
  const session = resolveHeartbeatSessionKey(cfg, agentId, heartbeat, undefined, env);
  const active = heartbeat?.activeHours;
  let activeHours: RetiredHeartbeatWindow | undefined;
  // Legacy windows with either endpoint absent were unrestricted. Filling the
  // missing endpoint would silently introduce a new execution restriction.
  if (
    active?.start &&
    active.end &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(active.start) &&
    /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(active.end)
  ) {
    const timezone = active.timezone?.trim();
    let normalizedTimezone = timezone;
    if (timezone && timezone !== "user" && timezone !== "local") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
      } catch {
        normalizedTimezone = "user";
      }
    }
    activeHours = {
      start: active.start,
      end: active.end,
      ...(normalizedTimezone ? { timezone: normalizedTimezone } : {}),
    };
  }
  const globalTimeout = cfg.agents?.defaults?.timeoutSeconds;
  const timeoutSeconds =
    heartbeat?.timeoutSeconds ??
    (typeof globalTimeout === "number" && Number.isFinite(globalTimeout)
      ? globalTimeout === 0
        ? 0
        : Math.max(1, Math.floor(globalTimeout))
      : Math.max(1, Math.min(600, Math.ceil((everyMs ?? 600_000) / 1000))));
  const target = normalizeOptionalString(heartbeat?.target) ?? "owner";
  const delivery: RetiredHeartbeatDelivery = {
    mode:
      target === "none" || !alertsEnabled(cfg, target, heartbeat?.accountId) ? "none" : "announce",
    ...(target === "owner" ? { target } : target !== "none" ? { channel: target } : {}),
    ...(target !== "owner" && target !== "none" && heartbeat?.to ? { to: heartbeat.to } : {}),
    ...(heartbeat?.accountId ? { accountId: heartbeat.accountId } : {}),
    ...(heartbeat?.directPolicy ? { directPolicy: heartbeat.directPolicy } : {}),
  };
  const model = normalizeOptionalString(heartbeat?.model);
  return {
    eligible: enrolled && everyMs !== null,
    everyMs,
    sessionKey: session.sessionKey,
    sessionStorePath: session.storePath,
    sessionTarget: heartbeat?.isolatedSession
      ? ("isolated" as const)
      : (`session:${session.sessionKey}` as const),
    activeHours,
    idleOnly: true as const,
    delivery,
    payload: {
      ...(model ? { model } : {}),
      timeoutSeconds,
      ...(heartbeat?.lightContext !== undefined ? { lightContext: heartbeat.lightContext } : {}),
    },
    prompt: normalizeOptionalString(heartbeat?.prompt),
    // Preserve the distinction between inherited fallback policy and an
    // explicit empty override while a prepared cutover is pending.
    agentModel: resolveAgentConfig(cfg, agentId)?.model,
    defaultModel: cfg.agents?.defaults?.model,
    // A user-timezone edit changes the effective window even when its authored
    // token stays "user"; pin that fact in the migration source fingerprint.
    userTimezone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
  };
}

export function heartbeatRetirementFingerprint(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** Match the writer-owned source projection after JSON removes own-undefined fields. */
export function heartbeatRetirementConfigFingerprint(config: OpenClawConfig): string {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Match persisted JSON omission semantics, not an in-memory clone.
  return heartbeatRetirementFingerprint(JSON.parse(JSON.stringify(config)));
}

function inheritedPolicyInputs(cfg: OpenClawConfig, agentId: string) {
  const defaults = cfg.agents?.defaults;
  const agentModel = toAgentModelListLike(resolveAgentConfig(cfg, agentId)?.model);
  const defaultModel = toAgentModelListLike(defaults?.model);
  return {
    timeoutSeconds: defaults?.timeoutSeconds,
    userTimezone: defaults?.userTimezone,
    agentPrimary: agentModel?.primary && normalizeAgentModelRefForConfig(agentModel.primary),
    agentFallbacks: agentModel?.fallbacks?.map(normalizeAgentModelRefForConfig),
    defaultPrimary: defaultModel?.primary && normalizeAgentModelRefForConfig(defaultModel.primary),
    defaultFallbacks: defaultModel?.fallbacks?.map(normalizeAgentModelRefForConfig),
  };
}

function modelBindings(config: OpenClawConfig, agentId: string, refs: readonly string[]) {
  const cfg = applyModelDefaults(config);
  const primary = resolveDefaultModelForAgent({ cfg, agentId });
  const aliasIndex = buildModelAliasIndex({ cfg, agentId, defaultProvider: primary.provider });
  return [
    primary,
    ...refs.map((raw) => {
      const resolved = resolveModelRefFromString({
        cfg,
        agentId,
        raw,
        defaultProvider: primary.provider,
        aliasIndex,
      });
      return resolved ? { ref: resolved.ref, aliased: resolved.alias !== undefined } : null;
    }),
  ];
}

export function assertHeartbeatRetirementInheritedPolicy(
  plan: {
    sourceConfig: OpenClawConfig;
    effectiveConfig: OpenClawConfig;
    agents: ReadonlyArray<{ agentId: string }>;
  },
  candidate: OpenClawConfig,
): void {
  for (const { agentId } of plan.agents) {
    const authored = inheritedPolicyInputs(plan.sourceConfig, agentId);
    const effective = inheritedPolicyInputs(plan.effectiveConfig, agentId);
    const final = inheritedPolicyInputs(candidate, agentId);
    if (resolveHeartbeatConfig(plan.effectiveConfig, agentId)?.timeoutSeconds !== undefined) {
      authored.timeoutSeconds = undefined;
      effective.timeoutSeconds = undefined;
      final.timeoutSeconds = undefined;
    }
    // Doctor may materialize an omitted effective default. An authored value
    // disappearing is a policy edit, and an explicit empty fallback stays one.
    const fields = [
      "timeoutSeconds",
      "userTimezone",
      "agentPrimary",
      "agentFallbacks",
      "defaultPrimary",
      "defaultFallbacks",
    ] as const;
    const project = (inputs: typeof authored) =>
      fields.map((key) =>
        inputs[key] === undefined && authored[key] === undefined ? effective[key] : inputs[key],
      );
    const refs = [
      resolveHeartbeatConfig(plan.effectiveConfig, agentId)?.model,
      ...resolveConfiguredModelFallbacks({ cfg: plan.effectiveConfig, agentId }),
    ].flatMap((ref) => (ref ? [ref] : []));
    const authoredBindings = modelBindings(plan.sourceConfig, agentId, refs);
    const effectiveBindings = modelBindings(plan.effectiveConfig, agentId, refs);
    const sameBindings = modelBindings(candidate, agentId, refs).every(
      (binding, index) =>
        isDeepStrictEqual(binding, authoredBindings[index]) ||
        isDeepStrictEqual(binding, effectiveBindings[index]),
    );
    if (!isDeepStrictEqual(project(authored), project(final)) || !sameBindings) {
      throw new Error(
        `Agent ${agentId} inherited heartbeat policy changed after preparation; configuration was retained.`,
      );
    }
  }
}

const DEFAULT_PROMPT =
  "Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.";

export function convertHeartbeatJobForRetirement(
  previous: CronStoredJob,
  policy: ReturnType<typeof resolveHeartbeatRetirementPolicy>,
  nowMs: number,
): RetiredHeartbeatJob {
  const payload = previous.payload;
  const message = payload.kind === "systemEvent" ? payload.text : (policy.prompt ?? DEFAULT_PROMPT);
  const storedDelivery = previous.delivery;
  if (
    storedDelivery?.mode === "webhook" ||
    (["channel", "to", "threadId", "accountId", "completionDestination"] as const).some(
      (key) =>
        storedDelivery?.[key] !== undefined &&
        !isDeepStrictEqual(storedDelivery[key], policy.delivery[key]),
    )
  ) {
    throw new Error(
      `Legacy automation ${previous.id} has an explicit delivery destination that heartbeat never executed; resolve it before cutover. Configuration was retained.`,
    );
  }
  const tools = {
    ...(payload.toolsAllow ? { toolsAllow: payload.toolsAllow } : {}),
    ...(payload.toolsAllowIsDefault !== undefined
      ? { toolsAllowIsDefault: payload.toolsAllowIsDefault }
      : {}),
  };
  const job: RetiredHeartbeatJob = {
    ...structuredClone(previous),
    enabled: previous.enabled && policy.eligible,
    sessionKey: policy.sessionKey,
    sessionTarget: policy.sessionTarget,
    activeHours: policy.activeHours,
    idleOnly: true,
    // The heartbeat wake bus ignored task completion routes. Preserve its
    // effective delivery and cron's independently active failure destination.
    delivery: {
      ...policy.delivery,
      ...(storedDelivery?.failureDestination
        ? { failureDestination: storedDelivery.failureDestination }
        : {}),
    },
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message,
      ...policy.payload,
      ...tools,
      ...(payload.kind === "heartbeat" ? { skipIfScratchEmpty: true } : {}),
    },
    updatedAtMs: nowMs,
  };
  delete job.declarationKey;
  return job;
}
