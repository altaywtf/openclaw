import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createAbortError } from "./abort-signal.js";

export type SessionEventWakeResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string; retryAtMs?: number }
  | { status: "failed"; reason: string };

export type SessionEventWakeRequest = {
  source: string;
  intent: "event" | "immediate" | "manual";
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  retainedWork?: boolean;
};

type WakeHandler = (
  request: SessionEventWakeRequest,
  signal: AbortSignal,
) => Promise<SessionEventWakeResult>;

type Settlement = {
  active: boolean;
  settle: (result: SessionEventWakeResult) => void;
};

type PendingWake = SessionEventWakeRequest & {
  sequence: number;
  barrierSequence?: number;
  readyAt: number;
  notBefore: number;
  blockedUntil: number;
  settlements: Settlement[];
};

type ActiveWake = { generation: number; controller: AbortController };

type RequestOptions = Omit<SessionEventWakeRequest, "retainedWork"> & { coalesceMs?: number };

function createSessionEventWakeRuntime() {
  const GLOBAL_TARGET = "::";
  const COALESCE_MS = 250;
  const RETRY_MS = 1_000;
  const IDLE_RETRY_MS = 60_000;
  const MAX_ACTIVE_TARGETS = 4;
  const RETRY_REASONS = new Set([
    "active-run",
    "requests-in-flight",
    "cron-in-progress",
    "preempted",
    "channel-not-ready",
    "not-due",
    "min-spacing",
    "flood",
  ]);
  const pending = new Map<string, PendingWake>();
  const active = new Map<string, ActiveWake>();
  let handler: WakeHandler | null = null;
  let generation = 0;
  let sequence = 0;
  let timer: NodeJS.Timeout | undefined;
  let timerDueAt = 0;

  function targetKey(request: SessionEventWakeRequest): string {
    if (!request.sessionKey || (request.sessionKey === "global" && !request.agentId)) {
      return `${request.agentId ?? ""}::`;
    }
    // Global rows live in distinct agent stores. A namespaced session already
    // contains its owner; a shared key needs the explicit owner as well.
    return parseAgentSessionKey(request.sessionKey)
      ? `::${request.sessionKey}`
      : `${request.agentId ?? ""}::${request.sessionKey}`;
  }

  function priority(wake: SessionEventWakeRequest): number {
    return wake.intent === "manual" || wake.intent === "immediate"
      ? 2
      : wake.source === "retry"
        ? 0
        : 1;
  }

  function enqueue(wake: PendingWake): void {
    const key = targetKey(wake);
    const previous = pending.get(key);
    if (!previous) {
      pending.set(key, wake);
      return;
    }
    const preferred = priority(wake) >= priority(previous) ? wake : previous;
    const bypassDeferred = preferred.intent !== "event" && !preferred.retainedWork;
    pending.set(key, {
      ...preferred,
      sequence: Math.min(previous.sequence, wake.sequence),
      barrierSequence:
        previous.barrierSequence === undefined
          ? wake.barrierSequence
          : Math.min(previous.barrierSequence, wake.barrierSequence ?? Infinity),
      readyAt: Math.min(previous.readyAt, wake.readyAt),
      notBefore: bypassDeferred ? 0 : Math.max(previous.notBefore, wake.notBefore),
      blockedUntil: Math.max(previous.blockedUntil, wake.blockedUntil),
      retainedWork: !bypassDeferred && (previous.retainedWork || wake.retainedWork),
      settlements: [...previous.settlements, ...wake.settlements].filter((entry) => entry.active),
    });
  }

  function isReady(wake: PendingWake, now: number): boolean {
    return Math.max(wake.readyAt, wake.notBefore, wake.blockedUntil) <= now;
  }

  function takeReady(): Array<[string, PendingWake]> {
    if (active.has(GLOBAL_TARGET)) {
      return [];
    }
    const now = performance.now();
    const global = pending.get(GLOBAL_TARGET);
    const globalReady = global && isReady(global, now);
    if (globalReady && active.size > 0) {
      return [];
    }
    const flush = globalReady && global.intent === "immediate";
    const candidates = globalReady && !flush ? [[GLOBAL_TARGET, global] as const] : pending;
    const ready: Array<[string, PendingWake]> = [];
    for (const [key, wake] of candidates) {
      if (ready.length + active.size >= MAX_ACTIVE_TARGETS) {
        break;
      }
      if (key === GLOBAL_TARGET && flush) {
        continue;
      }
      if (
        active.has(key) ||
        (key === GLOBAL_TARGET && (active.size > 0 || ready.length > 0)) ||
        (key !== GLOBAL_TARGET &&
          global?.barrierSequence !== undefined &&
          wake.sequence >= global.barrierSequence) ||
        wake.blockedUntil > now ||
        wake.notBefore > now ||
        (!flush && wake.readyAt > now)
      ) {
        continue;
      }
      pending.delete(key);
      ready.push([key, wake]);
    }
    // An immediate global wake flushes older targets first. Later arrivals stay
    // behind its sequence barrier, and no global turn overlaps a targeted turn.
    if (flush && ready.length === 0) {
      pending.delete(GLOBAL_TARGET);
      ready.push([GLOBAL_TARGET, global]);
    }
    return ready;
  }

  function settle(wake: PendingWake, result: SessionEventWakeResult): void {
    for (const entry of wake.settlements) {
      entry.settle(result);
    }
  }

  function retry(
    wake: PendingWake,
    result?: Extract<SessionEventWakeResult, { status: "skipped" }>,
  ): void {
    const delay =
      result?.retryAtMs !== undefined
        ? Math.max(0, result.retryAtMs - Date.now())
        : result?.reason === "preempted" || result?.reason === "channel-not-ready"
          ? IDLE_RETRY_MS
          : RETRY_MS;
    const guard =
      result && !["active-run", "requests-in-flight", "cron-in-progress"].includes(result.reason);
    const deadline = performance.now() + delay;
    enqueue({
      ...wake,
      readyAt: performance.now(),
      notBefore: guard ? deadline : 0,
      blockedUntil: guard ? 0 : deadline,
      retainedWork: guard ? true : wake.retainedWork,
    });
  }

  async function dispatch(
    key: string,
    wake: PendingWake,
    owner: ActiveWake,
    run: WakeHandler,
  ): Promise<void> {
    let result: SessionEventWakeResult | undefined;
    const signal = owner.controller.signal;
    let onAbort: (() => void) | undefined;
    try {
      result = await runWithGatewayIndependentRootWorkAdmission(() => {
        signal.throwIfAborted();
        // The handler may synchronously replace its owner, so subscribe before invoking it.
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () =>
            reject(createAbortError("Session event wake aborted", { cause: signal.reason }));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const request: SessionEventWakeRequest = {
          source: wake.source,
          intent: wake.intent,
          reason: wake.reason,
          ...(wake.agentId ? { agentId: wake.agentId } : {}),
          ...(wake.sessionKey ? { sessionKey: wake.sessionKey } : {}),
          ...(wake.retainedWork ? { retainedWork: true } : {}),
        };
        return Promise.race([run(request, signal), aborted]);
      }, "session:event");
      if (result.status === "skipped" && RETRY_REASONS.has(result.reason)) {
        if (owner.generation === generation) {
          retry(wake, result);
        } else {
          enqueue(wake);
        }
      } else {
        settle(wake, result);
      }
    } catch {
      // The handler must return an execution failure after admission. Only work
      // that has not claimed its occurrence may throw and return to this queue.
      if (owner.generation === generation) {
        retry(wake);
      } else if (!result) {
        enqueue(wake);
      }
    } finally {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      if (active.get(key) === owner) {
        active.delete(key);
      }
      schedulePending();
    }
  }

  function scheduleAt(dueAt: number): void {
    if (!handler || (timer && timerDueAt <= dueAt)) {
      return;
    }
    clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(
      () => {
        timer = undefined;
        const run = handler;
        if (!run) {
          return;
        }
        // Register the whole batch before invoking a handler so synchronous
        // replacement also aborts its generation's unstarted work.
        const ready = takeReady().map(([key, wake]) => {
          const owner = { generation, controller: new AbortController() };
          active.set(key, owner);
          return { key, wake, owner };
        });
        for (const { key, wake, owner } of ready) {
          void dispatch(key, wake, owner, run);
        }
        schedulePending();
      },
      resolveTimerTimeoutMs(Math.max(0, dueAt - performance.now()), COALESCE_MS, 0),
    );
    timer.unref?.();
  }

  function schedulePending(): void {
    if (active.size >= MAX_ACTIVE_TARGETS || active.has(GLOBAL_TARGET)) {
      return;
    }
    const now = performance.now();
    const global = pending.get(GLOBAL_TARGET);
    if (active.size > 0 && global && isReady(global, now)) {
      return;
    }
    let earliest = Infinity;
    for (const [key, wake] of pending) {
      if (
        active.has(key) ||
        (key !== GLOBAL_TARGET &&
          global?.barrierSequence !== undefined &&
          wake.sequence >= global.barrierSequence)
      ) {
        continue;
      }
      earliest = Math.min(earliest, Math.max(wake.readyAt, wake.notBefore, wake.blockedUntil));
    }
    if (Number.isFinite(earliest)) {
      scheduleAt(earliest);
    }
  }

  function setSessionEventWakeHandler(next: WakeHandler | null): () => void {
    generation += 1;
    const ownedGeneration = generation;
    handler = next;
    for (const owner of active.values()) {
      owner.controller.abort(new Error("Session event handler replaced"));
    }
    clearTimeout(timer);
    timer = undefined;
    if (next) {
      for (const wake of pending.values()) {
        wake.notBefore = 0;
        wake.blockedUntil = 0;
        wake.retainedWork = false;
      }
      schedulePending();
    }
    return () => {
      if (generation === ownedGeneration) {
        setSessionEventWakeHandler(null);
      }
    };
  }

  function enqueueRequest(
    options: RequestOptions,
    settlement?: Settlement,
    retryResult?: Extract<SessionEventWakeResult, { status: "skipped" }>,
  ): void {
    const now = performance.now();
    const { coalesceMs, ...wake } = options;
    const normalized = {
      ...wake,
      agentId: wake.agentId?.trim() || undefined,
      sessionKey: wake.sessionKey?.trim() || undefined,
      reason: wake.reason?.trim() || "requested",
    };
    const nextSequence = ++sequence;
    runWithoutOwnedSessionTranscriptWrites(() => {
      const pendingWake: PendingWake = {
        ...normalized,
        sequence: nextSequence,
        barrierSequence:
          targetKey(normalized) === GLOBAL_TARGET && wake.intent === "immediate"
            ? nextSequence
            : undefined,
        readyAt: now + resolveTimerTimeoutMs(coalesceMs, COALESCE_MS, 0),
        notBefore: 0,
        blockedUntil: 0,
        settlements: settlement ? [settlement] : [],
      };
      if (retryResult) {
        retry(pendingWake, retryResult);
      } else {
        enqueue(pendingWake);
      }
      schedulePending();
    });
  }

  function requestSessionEventWake(options: RequestOptions): void {
    enqueueRequest(options);
  }

  function requestSessionEventWakeRetry(
    options: RequestOptions,
    result: Extract<SessionEventWakeResult, { status: "skipped" }>,
  ): void {
    enqueueRequest(options, undefined, result);
  }

  function requestSessionEventWakeAndWait(
    options: RequestOptions,
    lifecycle?: { abortSignal?: AbortSignal },
  ): Promise<SessionEventWakeResult> {
    return new Promise((resolve) => {
      const signal = lifecycle?.abortSignal;
      const settlement: Settlement = {
        active: true,
        settle: (result) => {
          if (settlement.active) {
            settlement.active = false;
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          }
        },
      };
      const onAbort = () =>
        settlement.settle({ status: "failed", reason: "session event cancelled" });
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
        enqueueRequest(options, settlement);
      }
    });
  }

  return {
    setSessionEventWakeHandler,
    requestSessionEventWake,
    requestSessionEventWakeRetry,
    requestSessionEventWakeAndWait,
  };
}

// Native Gateway and source-transformed plugin modules must share the complete
// owner, including its timer and generation-bound disposer, not just the queue.
export const {
  setSessionEventWakeHandler,
  requestSessionEventWake,
  requestSessionEventWakeRetry,
  requestSessionEventWakeAndWait,
} = resolveGlobalSingleton(Symbol.for("openclaw.sessionEventWake"), createSessionEventWakeRuntime);
