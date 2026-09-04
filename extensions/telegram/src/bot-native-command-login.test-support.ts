import {
  createEmptyPluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ModelsAuthLoginFlowOptions } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import type { TelegramLoginFlow } from "./bot-native-command-executors.test-support.js";
import { stubTelegramProviderLoginFlow } from "./bot-native-commands.fixture-test-support.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
} from "./bot-native-commands.menu-test-support.js";

type TelegramLoginResult = Awaited<ReturnType<TelegramLoginFlow>>;
type LoginFlowResult = Partial<TelegramLoginResult> &
  Pick<TelegramLoginResult, "providerId" | "methodId" | "profiles">;

let loginAccountIndex = 0;

export function registerLoginCommand(
  params: {
    cfg: OpenClawConfig;
    accountId?: string;
    allowFrom?: string[];
    abortSignal?: AbortSignal;
    runtime?: RuntimeEnv;
  } & (
    | { loginFlow: (options: ModelsAuthLoginFlowOptions) => Promise<LoginFlowResult> }
    | { channelLoginFlow: TelegramNativeCommandDeps["runProviderChannelLoginFlow"] }
  ),
) {
  const botHarness = createCommandBot();
  const accountId = params.accountId ?? `login-test-${++loginAccountIndex}`;
  const nativeParams = createNativeCommandTestParams(params.cfg, {
    accountId,
    bot: botHarness.bot,
    allowFrom: params.allowFrom ?? ["200"],
    ...(params.abortSignal
      ? {
          opts: {
            token: "token",
            accountAbortSignal: params.abortSignal,
          },
        }
      : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  const sendMessageTelegram = vi.fn(async (_to, text) => {
    const result = await botHarness.bot.api.sendMessage(100, text, {});
    return { messageId: String(result.message_id), chatId: "100" };
  });
  const nativeCommandCallbackDispatcher = withPluginRuntimeRegistryScope(
    createEmptyPluginRegistry(),
    () =>
      registerTelegramNativeCommands({
        ...nativeParams,
        telegramDeps: {
          ...nativeParams.telegramDeps,
          runProviderChannelLoginFlow:
            "channelLoginFlow" in params
              ? params.channelLoginFlow
              : stubTelegramProviderLoginFlow(params.loginFlow),
          sendMessageTelegram,
        } as never,
      }),
  );
  const handler = botHarness.commandHandlers.get("login");
  if (!handler) {
    throw new Error("expected login command handler to be registered");
  }
  return {
    ...botHarness,
    accountId,
    handler,
    nativeCommandCallbackDispatcher,
    sendMessageTelegram,
  };
}
