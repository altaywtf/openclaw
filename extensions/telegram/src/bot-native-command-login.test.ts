// Tests Telegram native provider login command behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import type { TelegramLoginFlow } from "./bot-native-command-executors.test-support.js";
import {
  loginSessionMocks,
  registerLoginCommand,
  resetLoginCommandMocks,
} from "./bot-native-command-login.test-support.js";
import { createTelegramGroupCommandContext } from "./bot-native-commands.fixture-test-support.js";
import {
  createPrivateCommandContext,
  deliverReplies,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

describe("registerTelegramNativeCommands /login", () => {
  beforeEach(resetLoginCommandMocks);

  it("releases the chat lane only after structured device-code delivery", async () => {
    const controller = new AbortController();
    const preparationDelivered = createDeferred<void>();
    const allowDeviceCode = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    let loginCompleted = false;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.note("Preparing Codex login…");
      preparationDelivered.resolve();
      await allowDeviceCode.promise;
      if (!params.prompter.deviceCode) {
        throw new Error("expected structured device-code delivery");
      }
      await params.prompter.deviceCode({
        title: "OpenAI Codex device code",
        code: "PENDING-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      loginCompleted = true;
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      abortSignal: controller.signal,
      loginFlow,
    });

    let handlerReturned = false;
    const handlerTask = handler(createPrivateCommandContext({ match: "codex", userId: 200 })).then(
      () => {
        handlerReturned = true;
      },
    );
    try {
      await Promise.race([preparationDelivered.promise, handlerTask]);
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "Preparing Codex login…",
      );
      expect(handlerReturned).toBe(false);

      allowDeviceCode.resolve();
      await handlerTask;

      expect(loginCompleted).toBe(false);
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining("Code: <code>PENDING-CODE</code>"),
        expect.objectContaining({ parse_mode: "HTML" }),
      );
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
        "OpenAI login complete. Try your request again now.",
      );

      finishLogin.resolve();
      await vi.waitFor(() => expect(loginCompleted).toBe(true));
      await vi.waitFor(() =>
        expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
          "OpenAI login complete. Try your request again now.",
        ),
      );
    } finally {
      controller.abort();
      allowDeviceCode.resolve();
      finishLogin.resolve();
      await Promise.allSettled([
        handlerTask,
        ...loginFlow.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      ]);
    }
  });

  it("releases the chat lane after a browser button is delivered, then reports completion", async () => {
    const controller = new AbortController();
    const deliveryStarted = createDeferred<void>();
    const allowDelivery = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    deliverReplies.mockImplementationOnce(async () => {
      deliveryStarted.resolve();
      await allowDelivery.promise;
      return { delivered: true };
    });
    const channelLoginFlow = vi.fn<TelegramNativeCommandDeps["runProviderChannelLoginFlow"]>(
      async (flow) => {
        await flow.sendReply!({
          text: "Sign in: https://provider.example/login",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Sign in",
                    action: { type: "url", url: "https://provider.example/login" },
                  },
                ],
              },
            ],
          },
        });
        await finishLogin.promise;
        return {
          providerId: "openrouter",
          methodId: "oauth",
          modelAccess: "already-visible",
          authRefresh: "refreshed",
          profiles: [{ profileId: "openrouter:default", provider: "openrouter", mode: "api_key" }],
        };
      },
    );
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main" }] },
      },
      abortSignal: controller.signal,
      channelLoginFlow,
    });
    let returned = false;
    const task = handler(
      createPrivateCommandContext({ match: "oauth/openrouter/openrouter", userId: 200 }),
    ).then(() => {
      returned = true;
    });
    try {
      await Promise.race([deliveryStarted.promise, task]);
      expect(deliverReplies).toHaveBeenCalledOnce();
      expect(returned).toBe(false);
      allowDelivery.resolve();
      await task;
      expect(sendMessage).not.toHaveBeenCalled();
      finishLogin.resolve();
      await vi.waitFor(() =>
        expect(sendMessage).toHaveBeenCalledWith(
          100,
          "OpenRouter login complete. Try your request again now.",
          {},
        ),
      );
    } finally {
      controller.abort();
      allowDelivery.resolve();
      finishLogin.resolve();
      await Promise.allSettled([
        task,
        ...channelLoginFlow.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      ]);
    }
  });

  it("routes the login button through the non-blocking native login flow", async () => {
    const finishLogin = createDeferred<void>();
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "BUTTON-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { nativeCommandCallbackDispatcher, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });
    if (!nativeCommandCallbackDispatcher) {
      throw new Error("expected login callback dispatcher to be registered");
    }
    const callbackQuery = {
      id: "login-button",
      chat_instance: "login-button-chat",
      data: "tgcmd:/login codex",
      from: { id: 200, is_bot: false, first_name: "Bob", username: "bob" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: "private" as const, first_name: "Owner" },
        reply_markup: {
          inline_keyboard: [[{ text: "Sign in to OpenAI", callback_data: "tgcmd:/login codex" }]],
        },
      },
    };

    await expect(
      nativeCommandCallbackDispatcher({
        commandText: "/login codex",
        botUser: telegramBotInfoForTest,
        callbackQuery,
      }),
    ).resolves.toEqual({ handled: true, clearButtons: true });

    expect(loginFlow).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>BUTTON-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, nativeCommandCallbackDispatcher, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      allowFrom: ["200"],
    });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    if (!nativeCommandCallbackDispatcher) {
      throw new Error("Expected the native login callback dispatcher");
    }
    const groupContext = createTelegramGroupCommandContext({ match: "codex", userId: 200 });
    await expect(
      nativeCommandCallbackDispatcher({
        commandText: "/login codex",
        botUser: telegramBotInfoForTest,
        callbackQuery: {
          id: "group-login-warning",
          chat_instance: "group-login-chat",
          data: "tgcmd:/login codex",
          from: { id: 200, is_bot: false, first_name: "Owner" },
          message: {
            ...groupContext.message,
            from: { id: 200, is_bot: false, first_name: "Owner" },
          },
        },
      }),
    ).resolves.toEqual({ handled: true, clearButtons: true });

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts).toContain(
      "Provider login codes are only sent in a private chat or Control UI session. Open a private chat with OpenClaw and send `/login codex` there.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects a channel post even when it is not classified as a group", async () => {
    const channelLoginFlow = vi.fn<TelegramNativeCommandDeps["runProviderChannelLoginFlow"]>();
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { entries: { main: {} } },
      },
      channelLoginFlow,
    });
    const context = createPrivateCommandContext({ match: "codex", userId: 200 });
    await handler({
      ...context,
      message: {
        ...context.message,
        chat: { id: 100, type: "channel", title: "Public feed" },
      },
    });

    expect(channelLoginFlow).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Provider login codes are only sent in a private chat"),
      expect.any(Object),
    );
  });

  it.each([undefined, "999", "*"])("rejects /login without matching owner %s", async (owner) => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: owner === undefined ? undefined : [owner],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "Only a configured OpenClaw owner/admin can start provider login from this channel.",
    );
  });

  it("dedupes active /login flows for the same Telegram thread", async () => {
    const deferred = createDeferred<void>();
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "FIRST-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await deferred.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    deferred.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
      "OpenAI login is already active for this Telegram chat. Complete it, or wait for it to expire before requesting a new one.",
    );
  });

  it("releases a failed flow before any device code is delivered", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => {
      throw new Error("device-code request failed");
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).toHaveBeenCalledTimes(2);
    expect(
      sendMessage.mock.calls.filter(
        (call) => call[1] === "OpenAI login did not complete. Send `/login codex` to try again.",
      ),
    ).toHaveLength(2);
  });

  it("does not report auth failure when only the terminal notification fails", async () => {
    const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SUCCESS-CODE" });
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      runtime,
    });
    sendMessage.mockResolvedValueOnce({ message_id: 999 });
    sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await vi.waitFor(() =>
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("result notification failed"),
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login did not complete. Send `/login codex` to try again.",
    );
  });

  it("blocks provider prompts and terminal messages after Telegram stops", async () => {
    const shutdown = new AbortController();
    let loginSettled = false;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "ABORT-CODE" });
      if (!params.signal) {
        throw new Error("expected login owner signal");
      }
      const signal = params.signal;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Telegram stopped"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      } catch (error) {
        await params.prompter.note("Trouble with device code login?", "OAuth help");
        throw error;
      } finally {
        loginSettled = true;
      }
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      abortSignal: shutdown.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    shutdown.abort(new Error("Telegram stopped"));
    await vi.waitFor(() => expect(loginSettled).toBe(true));

    expect(sendMessage.mock.calls.map((call) => String(call[1]))).toHaveLength(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("ABORT-CODE");
  });

  it("keeps pending login alive across a polling-cycle restart", async () => {
    const account = new AbortController();
    const pollingCycle = new AbortController();
    const finishLogin = createDeferred<void>();
    let loginSignal: AbortSignal | undefined;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      loginSignal = params.signal;
      await params.prompter.deviceCode?.({ title: "Codex login", code: "RESTART-CODE" });
      await finishLogin.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { accountId, handler, sendMessage, sendMessageTelegram } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
      abortSignal: account.signal,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    pollingCycle.abort(new Error("recoverable polling restart"));
    sendMessage.mockRejectedValue(new Error("retired polling bot"));
    sendMessageTelegram.mockResolvedValueOnce({ messageId: "1000", chatId: "100" });

    expect(loginSignal?.aborted).toBe(false);
    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        "telegram:100",
        "OpenAI login complete. Try your request again now.",
        expect.objectContaining({ accountId, token: "token" }),
      ),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("moves the target session to the profile returned by Telegram /login codex", async () => {
    const finishLogin = createDeferred<void>();
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:owner@example.com",
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        modelAccess: "already-visible",
        profiles: [
          { profileId: "openai:new-owner@example.com", provider: "openai", mode: "oauth" },
        ],
      };
    });

    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    expect(loginSessionMocks.updateSessionStoreEntry).not.toHaveBeenCalled();
    finishLogin.resolve();

    expect(runModelsAuthLoginFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        method: "device-code",
        agent: "main",
      }),
    );
    expect(
      (runModelsAuthLoginFlow.mock.calls[0]?.[0] as { profileId?: string } | undefined)?.profileId,
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(loginSessionMocks.updateSessionStoreEntry).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        storePath: "/tmp/openclaw-sessions.json",
        requireWriteSuccess: true,
        skipMaintenance: true,
        update: expect.any(Function),
      }),
    );
    const patchUpdate = (
      loginSessionMocks.updateSessionStoreEntry.mock.calls[0]?.[0] as {
        update?: (entry: Record<string, unknown>) => Record<string, unknown>;
      }
    )?.update?.({
      authProfileOverride: "openai:owner@example.com",
      sessionId: "sess-main",
      updatedAt: 1,
    });
    expect(patchUpdate).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
  });

  it("does not pin the login profile after the Telegram session switches providers", async () => {
    const finishLogin = createDeferred<void>();
    const sessionStore: Record<string, SessionEntry> = {
      "agent:main:main": {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        authProfileOverride: "openai:owner@example.com",
        sessionId: "sess-main",
        updatedAt: 1,
      },
    };
    loginSessionMocks.loadSessionStore.mockReturnValue(sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({ title: "OpenAI Codex device code", code: "SWITCH" });
      await finishLogin.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        modelAccess: "already-visible",
        profiles: [
          { profileId: "openai:new-owner@example.com", provider: "openai", mode: "oauth" },
        ],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore["agent:main:main"] = {
      ...sessionStore["agent:main:main"],
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      updatedAt: 2,
    } as SessionEntry;
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
    expect(sessionStore["agent:main:main"]?.providerOverride).toBe("anthropic");
    expect(sessionStore["agent:main:main"]?.authProfileOverride).toBe("openai:owner@example.com");
  });

  it("moves a session created while Telegram login is pending to the returned profile", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "NEW-SESSION",
      });
      await finishLogin.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        modelAccess: "already-visible",
        profiles: [
          { profileId: "openai:new-owner@example.com", provider: "openai", mode: "oauth" },
        ],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(loginSessionMocks.updateSessionStoreEntry).toHaveBeenCalledTimes(1),
    );
    const update = (
      loginSessionMocks.updateSessionStoreEntry.mock.calls[0]?.[0] as {
        update?: (entry: SessionEntry) => Partial<SessionEntry> | null;
      }
    )?.update;
    expect(
      update?.({
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      }),
    ).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login complete. Try your request again now.",
        {},
      ),
    );
  });

  it("preserves a later user-selected profile on a session created during Telegram login", async () => {
    const finishLogin = createDeferred<void>();
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "LATER-USER-SELECTION",
      });
      await finishLogin.promise;
      return {
        providerId: "openai",
        methodId: "device-code",
        modelAccess: "already-visible",
        profiles: [{ profileId: "openai:login-profile", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    sessionStore = {
      "agent:main:main": {
        authProfileOverride: "openai:later-user-profile",
        authProfileOverrideSource: "user",
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
        {},
      ),
    );
    expect(sessionStore["agent:main:main"]?.authProfileOverride).toBe("openai:later-user-profile");
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it("marks a same-profile Telegram login as user-selected", async () => {
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      modelAccess: "already-visible",
      profiles: [{ profileId: "openai:owner@example.com", provider: "openai", mode: "oauth" }],
    }));
    const { handler } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    const update = (
      loginSessionMocks.updateSessionStoreEntry.mock.calls[0]?.[0] as {
        update?: (entry: Record<string, unknown>) => Record<string, unknown>;
      }
    )?.update;
    expect(update).toBeTypeOf("function");
    expect(
      update?.({
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        sessionId: "sess-main",
        updatedAt: 1,
      }),
    ).toEqual({
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    expect(
      update?.({
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "user",
        sessionId: "sess-main",
        updatedAt: 2,
      }),
    ).toBeNull();
  });

  it("reports partial success when Telegram cannot persist the returned profile", async () => {
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:old-owner@example.com",
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    loginSessionMocks.updateSessionStoreEntry.mockRejectedValueOnce(new Error("write failed"));
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      modelAccess: "already-visible",
      profiles: [{ profileId: "openai:new-owner@example.com", provider: "openai", mode: "oauth" }],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it("reports partial success when Telegram login returns no OpenAI profile", async () => {
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      modelAccess: "already-visible",
      profiles: [],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });

  it("revalidates an unchanged Telegram profile after device login", async () => {
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
      sessionId: "sess-main",
      updatedAt: 1,
    };
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": previousEntry,
    });
    loginSessionMocks.updateSessionStoreEntry.mockImplementationOnce(async (params) => {
      const concurrentEntry = {
        ...previousEntry,
        authProfileOverride: "openai:concurrent-owner@example.com",
        updatedAt: 2,
      };
      const patch = await params.update({ ...concurrentEntry });
      return patch ? { ...concurrentEntry, ...patch } : concurrentEntry;
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "openai",
      methodId: "device-code",
      modelAccess: "already-visible",
      profiles: [{ profileId: "openai:owner@example.com", provider: "openai", mode: "oauth" }],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "OpenAI login completed, but this Telegram session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      100,
      "OpenAI login complete. Try your request again now.",
      expect.any(Object),
    );
  });
});
