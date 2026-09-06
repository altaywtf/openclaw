import { describe, expect, it, vi } from "vitest";
import { CodexCustomProviderClientBinding } from "./custom-provider-client.js";
import { CODEX_CUSTOM_PROVIDER_API_KEY_ENV } from "./custom-provider.js";

const binding = { provider: "proxy", baseUrl: "https://proxy.example/v1" };
const errors = {
  cancellation: (reason: "aborted" | "timed out", cause?: unknown) => new Error(reason, { cause }),
  rejection: (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
};
function fixture() {
  const config = {
    allow_login_shell: false,
    features: { shell_snapshot: false },
    shell_environment_policy: { experimental_use_profile: false, set: { CODEX_API_KEY: "" } },
    model_providers: {
      proxy: {
        base_url: binding.baseUrl,
        env_key: CODEX_CUSTOM_PROVIDER_API_KEY_ENV,
        wire_api: "responses",
      },
    },
  };
  const read = vi.fn(async (method: string) =>
    method === "thread/read"
      ? { thread: { modelProvider: "proxy", cwd: "/workspace" } }
      : { config },
  );
  const send = vi.fn(async () => ({ modelProvider: "proxy" }));
  const client = new CodexCustomProviderClientBinding(binding, "/workspace");
  return { config, read, send, client };
}

describe("prepared custom provider request binding", () => {
  it.each(["command/exec", "process/spawn"])(
    "scrubs workload keys from %s request overlays",
    async (method) => {
      const f = fixture();
      expect(f.client.handles(method)).toBe(true);
      await f.client.request({
        errors,
        method,
        options: {},
        read: f.read,
        send: f.send,
        input: {
          command: ["command"],
          env: { CODEX_API_KEY: "synthetic-overlay", KEEP_THIS: "kept" },
        },
      });
      expect(f.send).toHaveBeenCalledWith(
        { command: ["command"], env: { CODEX_API_KEY: "", KEEP_THIS: "kept" } },
        {},
      );
    },
  );
  it("keeps thread overrides from restoring the native workload key or shell snapshots", async () => {
    const f = fixture();
    await f.client.request({
      errors,
      method: "thread/start",
      options: {},
      read: f.read,
      send: f.send,
      input: {
        config: {
          allow_login_shell: true,
          "features.shell_snapshot": true,
          shell_environment_policy: {
            experimental_use_profile: true,
            set: { CODEX_API_KEY: "synthetic-thread-key", KEEP_THIS: "kept" },
          },
        },
      },
    });
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          allow_login_shell: false,
          "features.shell_snapshot": false,
          shell_environment_policy: {
            experimental_use_profile: false,
            set: { CODEX_API_KEY: "", KEEP_THIS: "kept" },
          },
        },
      }),
      {},
    );
  });

  it.each(["thread/start", "thread/resume", "thread/fork"])(
    "binds the final %s request to the verified native provider",
    async (method) => {
      const f = fixture();
      await f.client.request({
        errors,
        method,
        input: { threadId: "thread", model: "model" },
        options: {},
        read: f.read,
        send: f.send,
      });
      expect(f.send).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread", model: "model", modelProvider: "proxy" }),
        {},
      );
      expect(f.read).toHaveBeenCalledWith(
        "config/read",
        { cwd: "/workspace", includeLayers: true },
        {},
      );
    },
  );

  it.each(["turn/start", "thread/compact/start"])(
    "rejects wrong existing thread ownership for %s",
    async (method) => {
      const f = fixture();
      const read = vi.fn(async () => ({ thread: { modelProvider: "openai" } }));
      await expect(
        f.client.request({
          errors,
          method,
          input: { threadId: "wrong" },
          options: {},
          read,
          send: f.send,
        }),
      ).rejects.toThrow("different provider");
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it("rechecks config on an existing process before its next turn", async () => {
    const f = fixture();
    const params = {
      errors,
      method: "turn/start",
      input: { threadId: "thread" },
      options: {},
      read: f.read,
      send: f.send,
    };
    await f.client.request(params);
    f.config.model_providers.proxy.base_url = "https://different.example/v1";
    await expect(f.client.request(params)).rejects.toThrow("endpoint does not match");
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each([
    { config: { "model_providers.proxy.env_key": "OTHER_KEY" } },
    { modelProvider: "openai" },
    { approvalsReviewer: "auto_review" },
  ])("rejects a conflicting final request before network writes: %j", async (input) => {
    const f = fixture();
    await expect(
      f.client.request({
        errors,
        method: "thread/start",
        input,
        options: {},
        read: f.read,
        send: f.send,
      }),
    ).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("rejects a mismatched returned provider before the caller can start a turn", async () => {
    const f = fixture();
    await expect(
      f.client.request({
        errors,
        method: "thread/start",
        input: {},
        options: {},
        read: f.read,
        send: async () => ({ modelProvider: "openai" }),
      }),
    ).rejects.toThrow("different provider");
  });

  it("rechecks caller authority after awaiting effective config", async () => {
    const f = fixture();
    const controller = new AbortController();
    const read = async () => {
      controller.abort();
      return { config: f.config };
    };
    await expect(
      f.client.request({
        errors,
        method: "thread/start",
        input: {},
        options: { signal: controller.signal },
        read,
        send: f.send,
      }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
});
