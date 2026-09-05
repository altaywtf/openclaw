import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import {
  createProviderBrowserAuthSession,
  ProviderBrowserSignInUnavailableError,
} from "../gateway/provider-browser-auth.js";
import {
  formatProviderLoginChoiceRef,
  formatProviderOAuthLoginRef,
  resolveProviderChannelLoginChoice,
  type ProviderChannelLoginChoice,
  type ProviderChannelLoginResolution,
} from "../plugins/provider-login-options.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { ReplyPayload } from "./reply-payload.js";
import type { RuntimeEnv } from "./runtime-env.js";

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
export type { ProviderChannelLoginChoice } from "../plugins/provider-login-options.js";

type ProviderAuthLoginFlowRuntime = typeof import("../commands/models/auth.js");

type ProviderLoginReply = ReplyPayload & { text: string };

type ProviderChannelLoginPreparation =
  | { status: "reply" | "rejected"; reply: ProviderLoginReply }
  | {
      status: "ready";
      choice: ProviderChannelLoginChoice;
      modelAccessChoice?: ModelsAuthLoginFlowOptions["modelAccessChoice"];
    };

type ProviderLoginSessionEntry = {
  sessionId: string;
  providerOverride?: string;
  modelProvider?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
};

type ProviderLoginSessionAdoption =
  | { status: "unchanged" }
  | {
      status: "patch";
      patch: {
        authProfileOverride: string;
        authProfileOverrideSource: "user";
        authProfileOverrideCompactionCount: undefined;
      };
    }
  | { status: "rejected" };

const PROVIDER_LOGIN_FLOW_TTL_MS = 15 * 60_000;

type ProviderLoginFlowRecord = {
  expiresAt: number;
  signal: AbortSignal;
  cancel: () => void;
};

type ProviderLoginFlowReservation =
  | { status: "active" }
  | { status: "reserved"; record: ProviderLoginFlowRecord };

export function createProviderLoginFlowRegistry(): Map<string, ProviderLoginFlowRecord> {
  return new Map();
}

const loadProviderAuthLoginFlowRuntime = createLazyRuntimeModule(
  () => import("../commands/models/auth.js"),
);
const bindProviderAuthLoginFlowRuntime = createLazyRuntimeMethodBinder(
  loadProviderAuthLoginFlowRuntime,
);

export const runModelsAuthLoginFlow: ProviderAuthLoginFlowRuntime["runModelsAuthLoginFlowCore"] =
  bindProviderAuthLoginFlowRuntime((runtime) => runtime.runModelsAuthLoginFlowCore);

function matchesLoginSnapshot(
  current: ProviderLoginSessionEntry,
  snapshot: ProviderLoginSessionEntry,
): boolean {
  return (
    current.sessionId === snapshot.sessionId &&
    current.authProfileOverride === snapshot.authProfileOverride &&
    current.authProfileOverrideSource === snapshot.authProfileOverrideSource &&
    current.authProfileOverrideCompactionCount === snapshot.authProfileOverrideCompactionCount
  );
}

function resolvePersistedModelProvider(entry: ProviderLoginSessionEntry): string | undefined {
  const provider = normalizeLowercaseStringOrEmpty(entry.providerOverride ?? entry.modelProvider);
  return provider || undefined;
}

/** Decide one session-profile adoption from the authoritative row read immediately before write. */
export function decideProviderLoginSessionAdoption(params: {
  currentModelProvider: string | undefined;
  loginProvider: string;
  nextProfileId: string | undefined;
  snapshot: ProviderLoginSessionEntry | undefined;
  current: ProviderLoginSessionEntry | undefined;
}): ProviderLoginSessionAdoption {
  if (!params.nextProfileId) {
    return { status: "rejected" };
  }
  if (
    !params.currentModelProvider ||
    normalizeLowercaseStringOrEmpty(params.currentModelProvider) !==
      normalizeLowercaseStringOrEmpty(params.loginProvider) ||
    !params.current
  ) {
    return { status: "unchanged" };
  }
  const currentProvider = resolvePersistedModelProvider(params.current);
  const snapshotProvider = params.snapshot
    ? resolvePersistedModelProvider(params.snapshot)
    : undefined;
  if (
    (currentProvider &&
      currentProvider !== normalizeLowercaseStringOrEmpty(params.loginProvider)) ||
    (params.snapshot && currentProvider !== snapshotProvider)
  ) {
    return { status: "unchanged" };
  }
  if (params.snapshot) {
    if (!matchesLoginSnapshot(params.current, params.snapshot)) {
      return { status: "rejected" };
    }
  } else {
    const source =
      params.current.authProfileOverrideSource ??
      (typeof params.current.authProfileOverrideCompactionCount === "number"
        ? "auto"
        : params.current.authProfileOverride
          ? "user"
          : undefined);
    if (source === "user" && params.current.authProfileOverride !== params.nextProfileId) {
      return { status: "rejected" };
    }
  }
  const needsPatch =
    params.current.authProfileOverride !== params.nextProfileId ||
    params.current.authProfileOverrideSource !== "user" ||
    params.current.authProfileOverrideCompactionCount !== undefined;
  return needsPatch
    ? {
        status: "patch",
        patch: {
          authProfileOverride: params.nextProfileId,
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: undefined,
        },
      }
    : { status: "unchanged" };
}

export function reserveProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  now?: number;
  replacementMessage?: string;
}): ProviderLoginFlowReservation {
  const now = params.now ?? Date.now();
  const activeFlow = params.flows.get(params.flowKey);
  if (activeFlow && activeFlow.expiresAt > now) {
    return { status: "active" };
  }
  if (activeFlow) {
    activeFlow.cancel();
    params.flows.delete(params.flowKey);
  }
  const abortController = new AbortController();
  const record = {
    expiresAt: now + PROVIDER_LOGIN_FLOW_TTL_MS,
    signal: abortController.signal,
    cancel: () =>
      abortController.abort(
        new Error(params.replacementMessage ?? "Provider login was replaced by a newer flow."),
      ),
  };
  params.flows.set(params.flowKey, record);
  return { status: "reserved", record };
}

export function releaseProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  record: ProviderLoginFlowRecord;
}): void {
  if (params.flows.get(params.flowKey) === params.record) {
    params.flows.delete(params.flowKey);
  }
}

export async function prepareProviderChannelLogin(params: {
  commandText: string;
  commandAuthorized: boolean;
  senderIsOwner: boolean;
  isPrivateChat: boolean;
  config: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  signal?: AbortSignal;
}): Promise<ProviderChannelLoginPreparation | null> {
  const match = params.commandText.trim().match(/^\/login(?:\s+(.+?))?(?:\s+(all|keep))?$/u);
  if (!match) {
    return null;
  }
  params.signal?.throwIfAborted();
  if (!params.commandAuthorized || !params.senderIsOwner) {
    return {
      status: "rejected",
      reply: {
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
      },
    };
  }
  const resolution = resolveProviderChannelLoginChoice(match[1]?.trim() || undefined, {
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  if (resolution.status !== "resolved") {
    return { status: "reply", reply: buildProviderLoginChoicesReply(resolution) };
  }
  const choice = resolution.choice;
  if (!params.isPrivateChat) {
    return {
      status: "reply",
      reply: {
        text: `Provider login codes are only sent in a private chat or Control UI session. Open a private chat with OpenClaw and send \`${formatProviderLoginCommand(choice)}\` there.`,
      },
    };
  }
  if (choice.mode !== "chat") {
    return { status: "reply", reply: { text: formatProviderLoginControlUiHandoff(choice) } };
  }
  const modelAccessChoice = match[2] === "all" || match[2] === "keep" ? match[2] : undefined;
  const { prepareProviderModelAccessChoice } =
    await import("../commands/models/auth-model-policy.js");
  params.signal?.throwIfAborted();
  const prompt = prepareProviderModelAccessChoice({
    config: params.config,
    agentId: params.agentId,
    provider: choice.providerId,
    providerLabel: choice.providerLabel,
  });
  if (prompt && !modelAccessChoice) {
    const command = `/login ${formatProviderLoginChoiceRef(choice)}`;
    const buttons = prompt.options.map((option) => ({
      label: option.label,
      action: { type: "command" as const, command: `${command} ${option.value}` },
    }));
    return {
      status: "reply",
      reply: {
        text: [
          prompt.message,
          ...buttons.map((button) => `${button.label}: \`${button.action.command}\``),
        ].join("\n"),
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            { type: "text", text: prompt.message },
            { type: "buttons", buttons },
          ],
        },
      },
    };
  }
  return { status: "ready", choice, ...(modelAccessChoice ? { modelAccessChoice } : {}) };
}

function buildProviderChannelLoginPrompter(params: {
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
}): ModelsAuthLoginFlowOptions["prompter"] {
  const sendCleanMessage = async (message: string) => {
    params.signal?.throwIfAborted();
    const text = message.trim();
    if (text) {
      await params.sendMessage(text);
      params.signal?.throwIfAborted();
    }
  };
  const sendDeviceCode = params.sendDeviceCode;
  const unsupportedPrompt = async () => {
    await sendCleanMessage(params.unsupportedPromptMessage);
    throw new Error(params.unsupportedPromptMessage);
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => {
      await sendCleanMessage([title?.trim(), message.trim()].filter(Boolean).join("\n\n"));
    },
    ...(sendDeviceCode
      ? {
          deviceCode: async (deviceCode) => {
            params.signal?.throwIfAborted();
            await sendDeviceCode(deviceCode);
            params.signal?.throwIfAborted();
          },
        }
      : {}),
    plain: sendCleanMessage,
    select: unsupportedPrompt,
    multiselect: unsupportedPrompt,
    text: unsupportedPrompt,
    confirm: unsupportedPrompt,
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

export async function runProviderChannelLoginFlow(params: {
  choice: ProviderChannelLoginChoice;
  agentId: string;
  profileId?: string;
  modelAccessChoice?: ModelsAuthLoginFlowOptions["modelAccessChoice"];
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  sendMessage: (message: string) => Promise<void>;
  sendReply?: (reply: ReplyPayload) => Promise<void> | void;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
}): Promise<ModelsAuthLoginFlowResult> {
  const browser = createProviderBrowserAuthSession({
    signal: params.signal,
    openUrl: async (url) => {
      const heading = `Sign in with ${params.choice.providerLabel}. Return here after approving access.`;
      const reply: ReplyPayload = {
        text: `${heading}\n${url}`,
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            { type: "text", text: heading },
            {
              type: "buttons",
              buttons: [
                {
                  label: `Sign in with ${params.choice.providerLabel}`,
                  action: { type: "url", url },
                },
              ],
            },
          ],
        },
      };
      if (params.sendReply) {
        await params.sendReply(reply);
      } else {
        await params.sendMessage(reply.text!);
      }
    },
  });
  try {
    return await runModelsAuthLoginFlow({
      provider: params.choice.providerId,
      method: params.choice.methodId,
      ownerPluginId: params.choice.pluginId,
      credentialOnly: true,
      modelAccessChoice: params.modelAccessChoice,
      agent: params.agentId,
      ...(params.profileId ? { profileId: params.profileId } : {}),
      config: params.config,
      runtime: params.runtime,
      signal: browser.signal,
      browserAuthorization: async (request) => {
        try {
          return await browser.authorize(request);
        } catch (error) {
          if (error instanceof ProviderBrowserSignInUnavailableError) {
            await params.sendMessage(error.message);
          }
          throw error;
        }
      },
      beforePersistentEffect: browser.assertCurrent,
      prompter: buildProviderChannelLoginPrompter({
        sendMessage: params.sendMessage,
        sendDeviceCode: params.sendDeviceCode,
        signal: browser.signal,
        unsupportedPromptMessage: params.unsupportedPromptMessage,
      }),
      isRemote: true,
      openUrl: async () => {},
    });
  } finally {
    browser.close();
  }
}

export function formatProviderLoginCommand(choice: ProviderChannelLoginChoice): string {
  return `/login ${choice.command}`;
}

export function formatProviderLoginComplete(
  choice: ProviderChannelLoginChoice,
  imported: boolean,
  modelAccess: ModelsAuthLoginFlowResult["modelAccess"],
  authRefresh: ModelsAuthLoginFlowResult["authRefresh"],
): string {
  const login = imported
    ? `${choice.providerLabel} login complete using your existing CLI sign-in.`
    : `${choice.providerLabel} login complete.`;
  if (modelAccess === "failed") {
    return `${login} Your credential is saved, but OpenClaw could not enable its models. Retry ${formatProviderLoginCommand(choice)} after the current config change finishes.`;
  }
  if (authRefresh === "gateway-rejected") {
    return `${login} Your credential is saved, but this Gateway rejected the auth refresh. Check the Gateway logs, then use /models.`;
  }
  if (authRefresh === "gateway-unreachable") {
    return `${login} Your credential is saved, but this Gateway could not refresh its model catalog. Restart the Gateway, then use /models.`;
  }
  if (modelAccess === "enabled") {
    return `${login} Available ${choice.providerLabel} models will update automatically. Your default model is unchanged. Use /models to browse.`;
  }
  if (modelAccess === "restricted") {
    return `${login} Your current model restrictions are unchanged. Use /models to browse available models.`;
  }
  return `${login} Try your request again now.`;
}

export function formatProviderLoginSessionSwitchFailed(
  choice: ProviderChannelLoginChoice,
  sessionLabel = "session",
): string {
  return `${choice.providerLabel} login completed, but this ${sessionLabel} could not switch to the newly authenticated profile. Retry \`${formatProviderLoginCommand(choice)}\`, or select the profile manually.`;
}

export function formatProviderLoginFailed(choice: ProviderChannelLoginChoice): string {
  return `${choice.providerLabel} login did not complete. Send \`${formatProviderLoginCommand(choice)}\` to try again.`;
}

function formatProviderLoginControlUiHandoff(choice: ProviderChannelLoginChoice): string {
  if (choice.mode === "setup") {
    return `${choice.label} needs provider setup. Open Control UI → Models → Connect, then choose “${choice.label}” under Provider setup.`;
  }
  return choice.mode === "secret"
    ? `${choice.label} needs secure input that chat must not store. Open Control UI → Models → Connect, then choose “${choice.label}” under Connect with an API key or token.`
    : `${choice.label} needs provider sign-in. Open Control UI → Models → Connect, then choose “${choice.label}” under Sign in.`;
}

export function buildProviderLoginChoicesReply(
  resolution: Exclude<ProviderChannelLoginResolution, { status: "resolved" }>,
): ProviderLoginReply {
  const buttons =
    resolution.status === "providers"
      ? resolution.providers.map((provider) => ({
          label: provider.label,
          action: {
            type: "command" as const,
            command: `/login ${formatProviderOAuthLoginRef(provider)}`,
          },
        }))
      : resolution.choices
          .toSorted((left, right) => Number(right.mode === "chat") - Number(left.mode === "chat"))
          .slice(0, 8)
          .map((choice) => ({
            label: choice.label,
            action: {
              type: "command" as const,
              command: `/login ${formatProviderLoginChoiceRef(choice)}`,
            },
          }));
  if (buttons.length === 0) {
    return {
      text:
        resolution.status === "providers"
          ? "No OAuth sign-in providers are available. Use /login <provider> for other connection options."
          : "No provider connections are available. Enable a provider plugin in Control UI → Models.",
    };
  }
  const heading =
    resolution.status === "providers"
      ? "Choose a provider to sign in:"
      : resolution.status === "ambiguous"
        ? "Choose how to connect:"
        : "Unsupported login provider. Available provider access commands:";
  const remaining =
    resolution.status === "providers" ? 0 : resolution.choices.length - buttons.length;
  const more = remaining > 0 ? `${remaining} more in Control UI → Models.` : undefined;
  return {
    text: [
      heading,
      ...buttons.map((button) => `${button.label}: \`${button.action.command}\``),
      more,
    ]
      .filter(Boolean)
      .join("\n"),
    presentationTextMode: "fallback",
    presentation: {
      blocks: [
        { type: "text", text: heading },
        { type: "buttons", buttons },
        ...(more ? [{ type: "context" as const, text: more }] : []),
      ],
    },
  };
}

/** A persisted row proves a patch only when it carries the exact login profile we wrote. */
export function isProviderLoginPatchPersisted(
  persisted: ProviderLoginSessionEntry,
  nextProfileId: string,
): boolean {
  return (
    persisted.authProfileOverride === nextProfileId &&
    persisted.authProfileOverrideSource === "user" &&
    persisted.authProfileOverrideCompactionCount === undefined
  );
}
