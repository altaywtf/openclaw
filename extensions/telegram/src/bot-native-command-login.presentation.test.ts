import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
