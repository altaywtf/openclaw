import {
  assertCodexCustomProviderEffectiveConfig,
  assertCodexCustomProviderResponse,
  assertCodexCustomProviderThreadConfig,
  CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
  type CodexCustomProviderBinding,
} from "./custom-provider.js";
import { isJsonObject } from "./protocol.js";
import { applyCodexManagedShellEnvironment } from "./thread-shell-environment.js";

type RequestOptions = { signal?: AbortSignal; timeoutMs?: number; assertCurrent?: () => void };
type ReadRequest = (method: string, params: unknown, options: RequestOptions) => Promise<unknown>;
type PreflightErrors = {
  cancellation: (reason: "aborted" | "timed out", cause?: unknown) => Error;
  rejection: (cause: unknown) => Error;
};
const SESSION_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
const INFERENCE_METHODS = new Set(["turn/start", "thread/compact/start"]);
const EXECUTION_METHODS = new Set(["command/exec", "process/spawn"]);

/** One prepared credential and route belong to one physical app-server process. */
export class CodexCustomProviderClientBinding {
  readonly binding: Readonly<CodexCustomProviderBinding>;

  constructor(
    binding: CodexCustomProviderBinding,
    private readonly cwd: string,
  ) {
    this.binding = Object.freeze({ ...binding });
  }

  handles(method: string): boolean {
    return (
      SESSION_METHODS.has(method) || INFERENCE_METHODS.has(method) || EXECUTION_METHODS.has(method)
    );
  }

  async request<T>(params: {
    method: string;
    input: unknown;
    options: RequestOptions;
    read: ReadRequest;
    send: (input: unknown, options: RequestOptions) => Promise<T>;
    errors: PreflightErrors;
  }): Promise<T> {
    const started = Date.now();
    const options = () => {
      if (params.options.signal?.aborted) {
        throw params.errors.cancellation("aborted", params.options.signal.reason);
      }
      params.options.assertCurrent?.();
      const timeoutMs =
        params.options.timeoutMs === undefined
          ? undefined
          : params.options.timeoutMs - (Date.now() - started);
      if (timeoutMs !== undefined && timeoutMs <= 0) {
        throw params.errors.cancellation("timed out");
      }
      return { ...params.options, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    };
    const prepare = async () => {
      if (!isJsonObject(params.input)) {
        throw new Error("Codex custom provider requires an explicit thread request");
      }
      const input = params.input;
      if (EXECUTION_METHODS.has(params.method) && input.env != null && !isJsonObject(input.env)) {
        throw new Error("Codex custom provider command environment must be an object");
      }
      assertCodexCustomProviderThreadConfig(input.config);
      if (
        input.approvalsReviewer === "auto_review" ||
        input.approvalsReviewer === "guardian_subagent"
      ) {
        throw new Error(
          "Custom provider workload credentials cannot authorize model-backed approval review",
        );
      }
      if (input.modelProvider != null) {
        assertCodexCustomProviderResponse(this.binding, input.modelProvider);
      }
      let cwd = typeof input.cwd === "string" ? input.cwd : this.cwd;
      if (INFERENCE_METHODS.has(params.method) || params.method === "thread/fork") {
        if (typeof input.threadId !== "string") {
          throw new Error("Codex custom provider requires an existing thread identity");
        }
        const result = await params.read(
          "thread/read",
          { threadId: input.threadId, includeTurns: false },
          options(),
        );
        const thread =
          isJsonObject(result) && isJsonObject(result.thread) ? result.thread : undefined;
        assertCodexCustomProviderResponse(this.binding, thread?.modelProvider);
        if (typeof thread?.cwd === "string" && input.cwd == null) {
          cwd = thread.cwd;
        }
      }
      const effective = await params.read("config/read", { cwd, includeLayers: true }, options());
      assertCodexCustomProviderEffectiveConfig(
        this.binding,
        isJsonObject(effective) ? effective.config : undefined,
      );
      return {
        input: SESSION_METHODS.has(params.method)
          ? {
              ...input,
              modelProvider: this.binding.provider,
              config: {
                ...applyCodexManagedShellEnvironment(
                  isJsonObject(input.config) ? input.config : {},
                  { [CODEX_CUSTOM_PROVIDER_API_KEY_ENV]: "" },
                  true,
                ),
                "features.shell_snapshot": false,
              },
            }
          : EXECUTION_METHODS.has(params.method)
            ? {
                ...input,
                env: {
                  ...(isJsonObject(input.env) ? input.env : {}),
                  [CODEX_CUSTOM_PROVIDER_API_KEY_ENV]: "",
                },
              }
            : input,
        options: options(),
      };
    };
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare();
    } catch (error) {
      // Validation reads may have been written; the requested mutation has not.
      throw params.errors.rejection(error);
    }
    const result = await params.send(prepared.input, prepared.options);
    if (SESSION_METHODS.has(params.method)) {
      assertCodexCustomProviderResponse(
        this.binding,
        isJsonObject(result) ? result.modelProvider : undefined,
      );
    }
    return result;
  }
}
