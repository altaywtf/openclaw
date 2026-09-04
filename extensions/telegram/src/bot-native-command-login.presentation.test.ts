import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsAuthLoginFlowOptions } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import type { TelegramLoginFlow } from "./bot-native-command-executors.test-support.js";
import {
  registerLoginCommand,
  resetLoginCommandMocks,
} from "./bot-native-command-login.test-support.js";
import {
  createPrivateCommandContext,
  deliverReplies,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

describe("registerTelegramNativeCommands /login presentation", () => {
  beforeEach(resetLoginCommandMocks);

  it("handles /login codex by sending the device code before login completes", async () => {
    let loginParams: ModelsAuthLoginFlowOptions | undefined;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      loginParams = params;
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: [
          "Open this URL in your LOCAL browser and enter the code below.",
          "URL: https://auth.openai.com/codex/device",
        ].join("\n"),
      });
      return {
        providerId: "openai",
        methodId: "device-code",
        profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage, setMyCommands } = registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          ownerAllowFrom: ["200"],
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    expect(setMyCommands).toHaveBeenCalledOnce();
    const registeredCommands = setMyCommands.mock.calls[0]?.[0];
    expect(registeredCommands).toContainEqual({
      command: "login",
      description: "Sign in to a model provider.",
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    expect(loginParams).toMatchObject({ provider: "openai", method: "device-code", agent: "main" });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 5_000 });

    const texts = sendMessage.mock.calls.map((call) => String(call[1]));
    expect(texts[0]).toContain("URL: https://auth.openai.com/codex/device");
    expect(texts[0]).toContain("Code: <code>ABCD-EFGH</code>");
    expect(texts[0]).toContain("Never share it.");
    expect(sendMessage.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ parse_mode: "HTML" }));
    expect(texts.at(-1)).toContain("OpenAI login complete. Try your request again now.");
  });

  it.each(["all", "keep"] as const)(
    "asks before native login and consumes the %s model-access continuation",
    async (selection) => {
      const channelLoginFlow = vi.fn<TelegramNativeCommandDeps["runProviderChannelLoginFlow"]>(
        async (flow) => {
          await flow.sendDeviceCode?.({
            title: "Provider sign-in",
            code: "CHOICE-CODE",
            message: "URL: https://auth.example.test/device",
          });
          return {
            providerId: flow.choice.providerId,
            methodId: flow.choice.methodId,
            modelAccess: flow.modelAccessChoice === "all" ? "enabled" : "restricted",
            authRefresh: "refreshed",
            profiles: [{ profileId: "openai:owner", provider: "openai", mode: "oauth" }],
          };
        },
      );
      const { handler, nativeCommandCallbackDispatcher, sendMessage } = registerLoginCommand({
        cfg: {
          commands: { native: true, ownerAllowFrom: ["200"] },
          agents: {
            defaults: { modelPolicy: { allow: ["openai/current"] } },
            entries: { main: {} },
          },
        },
        channelLoginFlow,
      });
      if (!nativeCommandCallbackDispatcher) {
        throw new Error("Expected the native login callback dispatcher");
      }
      const dispatchCommand = async (commandText: string) =>
        await nativeCommandCallbackDispatcher({
          commandText,
          botUser: telegramBotInfoForTest,
          callbackQuery: {
            id: `model-access-${selection}`,
            chat_instance: "model-access-chat",
            data: `tgcmd:${commandText}`,
            from: { id: 200, is_bot: false, first_name: "Owner" },
            message: {
              message_id: 10,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 100, type: "private", first_name: "Owner" },
            },
          },
        });

      await handler(createPrivateCommandContext({ match: "", userId: 200 }));
      const providerButton = deliverReplies.mock.calls
        .at(-1)?.[0]
        .replies.flatMap(
          (reply) =>
            reply.presentation?.blocks.flatMap((block) =>
              block.type === "buttons" ? block.buttons : [],
            ) ?? [],
        )
        .find((button) => button.label === "OpenAI");
      if (providerButton?.action?.type !== "command") {
        throw new Error("Expected the OpenAI provider choice command");
      }
      expect(channelLoginFlow).not.toHaveBeenCalled();
      await dispatchCommand(providerButton.action.command);

      expect(channelLoginFlow).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      const menu = deliverReplies.mock.calls.at(-1)?.[0].replies[0];
      const buttons =
        menu?.presentation?.blocks.flatMap((block) =>
          block.type === "buttons" ? block.buttons : [],
        ) ?? [];
      expect(buttons.map((button) => button.label)).toEqual([
        "Show all OpenAI models",
        "Keep current restrictions",
      ]);
      expect(menu?.presentationTextMode).toBe("fallback");
      const button = buttons[selection === "all" ? 0 : 1];
      if (button?.action?.type !== "command") {
        throw new Error("Expected a model-access continuation command");
      }
      expect(menu?.text).toContain(button.action.command);
      await dispatchCommand(button.action.command);

      expect(channelLoginFlow).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          choice: expect.objectContaining({ providerId: "openai", methodId: "device-code" }),
          agentId: "main",
          modelAccessChoice: selection,
        }),
      );
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining("Code: <code>CHOICE-CODE</code>"),
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    },
  );

  it("handles /login xai with the same tap-to-copy device-code flow", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      await params.prompter.deviceCode?.({
        title: "xAI OAuth",
        code: "XAI-ABCD",
        expiresInMinutes: 10,
        message:
          "Open this URL in your LOCAL browser and enter the code below.\nURL: https://accounts.x.ai/oauth2/device",
      });
      return {
        providerId: "xai",
        methodId: "oauth",
        modelAccess: "enabled",
        profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
      };
    });
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: {
          defaults: { model: { primary: "xai/grok-4" } },
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "xai", userId: 200 }));

    expect(loginFlow).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "xai", method: "oauth", agent: "main" }),
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain("Code: <code>XAI-ABCD</code>");
    expect(String(sendMessage.mock.calls[0]?.[1])).toContain(
      "URL: https://accounts.x.ai/oauth2/device",
    );
    expect(String(sendMessage.mock.calls[1]?.[1])).toBe(
      "xAI (Grok) login complete. Available xAI (Grok) models will update automatically. Your default model is unchanged. Use /models to browse.",
    );
  });

  it("reports saved auth when provider model access could not be enabled", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      providerId: "xai",
      methodId: "oauth",
      modelAccess: "failed" as const,
      profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
    }));
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "xai", userId: 200 }));

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(String(sendMessage.mock.calls[0]?.[1])).toBe(
      "xAI (Grok) login complete. Your credential is saved, but OpenClaw could not enable its models. Retry /login xai after the current config change finishes.",
    );
  });

  it("hands guided secret login to the masked Control UI wizard", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>();
    const { handler, sendMessage } = registerLoginCommand({
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "groq", userId: 200 }));

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      "Groq API key needs secure input that chat must not store. Open Control UI → Models → Connect, then choose “Groq API key” under Connect with an API key or token.",
      {},
    );
    expect(loginFlow).not.toHaveBeenCalled();
  });
});
