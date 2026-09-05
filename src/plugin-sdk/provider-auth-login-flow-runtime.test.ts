import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import {
  buildProviderLoginChoicesReply,
  formatProviderLoginComplete,
  prepareProviderChannelLogin,
  type ProviderChannelLoginChoice,
  runProviderChannelLoginFlow,
} from "./provider-auth-login-flow-runtime.js";

const mocks = vi.hoisted(() => ({
  resolveProviderChannelLoginChoice:
    vi.fn<
      typeof import("../plugins/provider-login-options.js").resolveProviderChannelLoginChoice
    >(),
  runModelsAuthLoginFlowCore: vi.fn<
    (options: ModelsAuthLoginFlowOptions) => Promise<ModelsAuthLoginFlowResult>
  >(async () => ({
    providerId: "xai",
    methodId: "oauth",
    modelAccess: "already-visible",
    authRefresh: "refreshed",
    profiles: [],
  })),
}));

vi.mock("../commands/models/auth.js", () => ({
  runModelsAuthLoginFlowCore: mocks.runModelsAuthLoginFlowCore,
}));

vi.mock("../plugins/provider-login-options.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-login-options.js")>(
    "../plugins/provider-login-options.js",
  );
  return { ...actual, resolveProviderChannelLoginChoice: mocks.resolveProviderChannelLoginChoice };
});

const choice: ProviderChannelLoginChoice = {
  choiceId: "xai-oauth",
  pluginId: "xai",
  providerId: "xai",
  methodId: "oauth",
  label: "xAI OAuth",
  providerLabel: "xAI (Grok)",
  command: "xai",
  mode: "chat",
};

const loginParams = {
  choice,
  agentId: "main",
  config: {},
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  unsupportedPromptMessage: "Open Control UI → Models and choose Sign in.",
};

const preparationParams = {
  commandText: "/login xai",
  commandAuthorized: true,
  senderIsOwner: true,
  isPrivateChat: true,
  config: {
    agents: {
      defaults: { modelPolicy: { allow: ["other/current"] } },
      entries: { main: {} },
    },
  },
  agentId: "main",
};

describe("provider channel login runtime", () => {
  beforeEach(() => {
    mocks.runModelsAuthLoginFlowCore.mockClear();
    mocks.resolveProviderChannelLoginChoice.mockReset().mockReturnValue({
      status: "resolved",
      choice,
    });
  });

  it.each([
    { commandAuthorized: false, senderIsOwner: true },
    { commandAuthorized: true, senderIsOwner: false },
  ])("rejects preflight without both authorization facts: %j", async (authorization) => {
    await expect(
      prepareProviderChannelLogin({ ...preparationParams, ...authorization }),
    ).resolves.toMatchObject({
      status: "rejected",
      reply: { text: expect.stringContaining("owner/admin") },
    });
    expect(mocks.resolveProviderChannelLoginChoice).not.toHaveBeenCalled();
    expect(mocks.runModelsAuthLoginFlowCore).not.toHaveBeenCalled();
  });

  it("resolves a stale continuation again instead of starting another provider", async () => {
    mocks.resolveProviderChannelLoginChoice.mockReturnValue({ status: "unsupported", choices: [] });
    await expect(
      prepareProviderChannelLogin({
        ...preparationParams,
        commandText: "/login removed/choice all",
      }),
    ).resolves.toMatchObject({
      status: "reply",
      reply: { text: expect.stringContaining("No provider connections") },
    });
    expect(mocks.runModelsAuthLoginFlowCore).not.toHaveBeenCalled();
  });

  it("does not prepare cancelled login commands", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Login cancelled"));
    await expect(
      prepareProviderChannelLogin({ ...preparationParams, signal: controller.signal }),
    ).rejects.toThrow("Login cancelled");
    expect(mocks.resolveProviderChannelLoginChoice).not.toHaveBeenCalled();
  });

  it.each([false, true])("leaves other commands unhandled (aborted: %s)", async (aborted) => {
    await expect(
      prepareProviderChannelLogin({
        ...preparationParams,
        commandText: "/models",
        signal: aborted ? AbortSignal.abort(new Error("Login cancelled")) : undefined,
      }),
    ).resolves.toBeNull();
    expect(mocks.resolveProviderChannelLoginChoice).not.toHaveBeenCalled();
  });

  it("fails closed when an offered provider asks chat for extra input", async () => {
    const sendMessage = vi.fn(async () => {});
    mocks.runModelsAuthLoginFlowCore.mockImplementationOnce(async (options) => {
      await options.prompter.text({ message: "Enter a secret" });
      return {
        providerId: "xai",
        methodId: "oauth",
        modelAccess: "already-visible",
        authRefresh: "refreshed",
        profiles: [],
      };
    });

    await expect(runProviderChannelLoginFlow({ ...loginParams, sendMessage })).rejects.toThrow(
      "Open Control UI",
    );
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "Open Control UI → Models and choose Sign in.",
    );
  });

  it("reports saved credentials when the running Gateway cannot refresh them", () => {
    expect(
      formatProviderLoginComplete(choice, false, "already-visible", "gateway-unreachable"),
    ).toBe(
      "xAI (Grok) login complete. Your credential is saved, but this Gateway could not refresh its model catalog. Restart the Gateway, then use /models.",
    );
  });

  it("keeps native buttons and text fallback bound to the same exact choice", () => {
    const reply = buildProviderLoginChoicesReply({
      status: "ambiguous",
      choices: [choice],
    });
    expect(reply.presentationTextMode).toBe("fallback");
    expect(reply.presentation?.blocks).toContainEqual({
      type: "buttons",
      buttons: [
        {
          label: choice.label,
          action: { type: "command", command: "/login xai/xai-oauth" },
        },
      ],
    });
    expect(reply.text).toContain(`${choice.label}: \`/login xai/xai-oauth\``);
  });

  it("gives a visible setup instruction when no connections are available", () => {
    expect(buildProviderLoginChoicesReply({ status: "unsupported", choices: [] })).toEqual({
      text: "No provider connections are available. Enable a provider plugin in Control UI → Models.",
    });
  });

  it("renders every OAuth provider as a button without the method-list cap", () => {
    const providers = Array.from({ length: 10 }, (_value, index) => ({
      pluginId: `plugin-${index}`,
      providerId: `provider-${index}`,
      label: `Provider ${index}`,
    }));
    const reply = buildProviderLoginChoicesReply({ status: "providers", providers });
    const buttons =
      reply.presentation?.blocks.flatMap((block) =>
        block.type === "buttons" ? block.buttons : [],
      ) ?? [];
    expect(buttons).toHaveLength(providers.length);
    expect(reply.text).toContain("Choose a provider to sign in:");
    expect(reply.text).toContain("/login oauth/plugin-9/provider-9");
    expect(reply.text).not.toContain("more in Control UI");
  });

  it("does not substitute API-key or setup choices for an empty OAuth list", () => {
    expect(buildProviderLoginChoicesReply({ status: "providers", providers: [] })).toEqual({
      text: "No OAuth sign-in providers are available. Use /login <provider> for other connection options.",
    });
  });

  it("reports a rejected Gateway refresh without recommending a restart", () => {
    expect(formatProviderLoginComplete(choice, false, "already-visible", "gateway-rejected")).toBe(
      "xAI (Grok) login complete. Your credential is saved, but this Gateway rejected the auth refresh. Check the Gateway logs, then use /models.",
    );
  });
});
