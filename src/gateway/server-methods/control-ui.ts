import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  GitHubIdentityError,
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../../agents/github-tool-identity.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { truncateUtf16Safe } from "../../utils.js";
import type { AssistantMediaGetResult, ControlUiSessionPreview } from "../control-ui-contract.js";
import { formatControlUiGitHubPreviewError } from "../control-ui-github-api.js";
import {
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
  type ControlUiGitHubPreviewIdentity,
  type ControlUiGitHubPreviewTarget,
} from "../control-ui-github-preview.js";
import {
  resolveControlUiSessionAccess,
  type ControlUiSessionAccess,
} from "../control-ui-session-access.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscriptions.js";
import { resolveControlUiAssistantMedia } from "../control-ui.js";
import { requestCurrentGitHubOAuthRefresh } from "../github-oauth-lifecycle.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type LoadGitHubPreview = (
  target: ControlUiGitHubPreviewTarget,
  identity?: ControlUiGitHubPreviewIdentity,
) => ReturnType<typeof loadControlUiGitHubPreview>;

async function prepareControlUiGitHubIdentity(
  { context, client, signal }: GatewayRequestHandlerOptions,
  agentId: string,
): Promise<{
  identity: ControlUiGitHubPreviewIdentity | undefined;
  assertSelected: () => void;
}> {
  const config = context.getRuntimeConfig();
  const configuredIdentity = () => {
    const current = context.getRuntimeConfig();
    return (
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: current, agentId, scope: "system" })
    );
  };
  const assertActive = () => {
    if (
      signal?.aborted ||
      (client?.connId &&
        !context.getClientConnIds?.((current) => current === client).has(client.connId))
    ) {
      throw new GitHubIdentityError("changed");
    }
  };
  // Without a managed selection, retain service/env/anonymous access without
  // probing native gh. Both paths must still own the selection at delivery.
  const identity = configuredIdentity()
    ? await prepareGitHubReadIdentity({
        config,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
        agentId,
        getCurrentConfig: () => context.getRuntimeConfig(),
        assertActive,
        refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
      })
    : undefined;
  return {
    identity,
    assertSelected:
      identity?.assertSelected ??
      (() => {
        assertActive();
        if (configuredIdentity()) {
          throw new GitHubIdentityError("changed");
        }
      }),
  };
}

type LoadSessionPreview = (
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
  mediaSource?: string,
) => ControlUiSessionAccess | null | Promise<ControlUiSessionAccess | null>;

type LoadAssistantMedia = (
  source: string,
  context: GatewayRequestContext,
  authority: { agentId?: string; connId: string; sessionKey?: string },
) => Promise<AssistantMediaGetResult>;

const SESSION_PREVIEW_TEXT_MAX_CHARS = 200;

function boundedPreviewText(value: string | undefined, maxChars = SESSION_PREVIEW_TEXT_MAX_CHARS) {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxChars) : undefined;
}

function parseSessionPreviewKey(params: unknown): string | null {
  if (!isRecord(params) || Object.keys(params).some((key) => key !== "sessionKey")) {
    return null;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  return sessionKey && sessionKey.length <= 512 ? sessionKey : null;
}

function parseAssistantMediaParams(
  params: unknown,
): { source: string; sessionKey?: string } | null {
  if (
    !isRecord(params) ||
    Object.keys(params).some((key) => key !== "source" && key !== "sessionKey")
  ) {
    return null;
  }
  const source = typeof params.source === "string" ? params.source.trim() : "";
  if (!source || source.length > 8192) {
    return null;
  }
  if (params.sessionKey === undefined) {
    return { source };
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  return sessionKey && sessionKey.length <= 512 ? { source, sessionKey } : null;
}

async function loadAssistantMedia(
  source: string,
  context: GatewayRequestContext,
  authority: { agentId?: string; connId: string; sessionKey?: string },
): Promise<AssistantMediaGetResult> {
  const cfg = context.getRuntimeConfig();
  return await resolveControlUiAssistantMedia(source, cfg, authority);
}

function projectSessionPreview(source: ControlUiSessionAccess | null): ControlUiSessionPreview {
  if (!source) {
    return { status: "unavailable" };
  }
  const lastMessagePreview = boundedPreviewText(
    source.lastMessagePreview ? redactToolPayloadText(source.lastMessagePreview) : undefined,
  );
  const title = boundedPreviewText(source.title);
  const derivedTitle = boundedPreviewText(source.derivedTitle);
  const kind = boundedPreviewText(source.kind, 64);
  const channel = boundedPreviewText(source.channel, 80);
  return {
    status: "ok",
    sessionKey: source.sessionKey,
    agentId: source.agentId,
    ...(title ? { title } : {}),
    ...(derivedTitle ? { derivedTitle } : {}),
    ...(kind ? { kind } : {}),
    ...(channel ? { channel } : {}),
    ...(typeof source.updatedAt === "number" && Number.isFinite(source.updatedAt)
      ? { updatedAt: source.updatedAt }
      : {}),
    ...(lastMessagePreview ? { lastMessagePreview } : {}),
    ...(typeof source.archived === "boolean" ? { archived: source.archived } : {}),
  };
}

function loadControlUiSessionPreview(
  sessionKey: string,
  context: GatewayRequestContext,
  client: GatewayClient | null,
  mediaSource?: string,
): ControlUiSessionAccess | null {
  return resolveControlUiSessionAccess(sessionKey, context.getRuntimeConfig(), client, mediaSource);
}

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = loadControlUiGitHubPreview,
  loadSessionPreview: LoadSessionPreview = loadControlUiSessionPreview,
  loadMedia: LoadAssistantMedia = loadAssistantMedia,
): GatewayRequestHandlers {
  return {
    "assistant.media.get": async ({ params, context, client, respond }) => {
      const parsed = parseAssistantMediaParams(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid assistant.media.get params"),
        );
        return;
      }
      const connId = client?.connId?.trim();
      if (!connId) {
        respond(
          true,
          { available: false, reason: "Client unavailable", code: "client_unavailable" },
          undefined,
        );
        return;
      }
      if (!parsed.sessionKey) {
        respond(true, await loadMedia(parsed.source, context, { connId }), undefined);
        return;
      }
      const session = await loadSessionPreview(parsed.sessionKey, context, client, parsed.source);
      if (!session) {
        respond(
          true,
          { available: false, reason: "Session unavailable", code: "session_unavailable" },
          undefined,
        );
        return;
      }
      const agentId = session.agentId;
      const sessionKey = session.sessionKey;
      respond(
        true,
        await loadMedia(parsed.source, context, {
          agentId,
          connId,
          ...(sessionKey ? { sessionKey } : {}),
        }),
        undefined,
      );
    },
    "controlUi.githubPreview": async (options) => {
      const { params, respond, context } = options;
      const target = parseControlUiGitHubPreviewTarget(params);
      if (!target) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.githubPreview params"),
        );
        return;
      }
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
        normalize: normalizeOptionalString,
      });
      if (!resolved) {
        return;
      }
      try {
        const { identity, assertSelected } = await prepareControlUiGitHubIdentity(
          options,
          resolved.agentId,
        );
        const preview = await loadGitHubPreview(target, identity);
        assertSelected();
        respond(true, preview, undefined);
      } catch (error) {
        const { message, ...details } =
          error instanceof GitHubIdentityError
            ? { message: error.message, retryable: error.reason !== "unavailable" }
            : formatControlUiGitHubPreviewError(error);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
      }
    },
    "controlUi.sessionPreview": async ({ params, client, context, respond }) => {
      const sessionKey = parseSessionPreviewKey(params);
      if (!sessionKey) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.sessionPreview params"),
        );
        return;
      }
      try {
        respond(
          true,
          projectSessionPreview(await loadSessionPreview(sessionKey, context, client)),
          undefined,
        );
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Session preview unavailable"),
        );
      }
    },
    "controlUi.sessionPullRequests.subscribe": ({ params, client, context, respond }) => {
      const parsed = parseControlUiSessionPullRequestsSubscribeParams(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid controlUi.sessionPullRequests.subscribe params",
          ),
        );
        return;
      }
      const connId = client?.connId?.trim();
      const subscriptions = context.controlUiSessionPullRequests;
      if (!connId || !subscriptions) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "session pull request subscriptions unavailable"),
        );
        return;
      }
      if (parsed.refreshSessionKeys.length > 0) {
        void subscriptions.replace(connId, parsed.sessionKeys, new Set(parsed.refreshSessionKeys));
      } else {
        void subscriptions.replace(connId, parsed.sessionKeys);
      }
      respond(true, { subscribed: parsed.sessionKeys.length > 0 }, undefined);
    },
  };
}

export const controlUiHandlers = createControlUiHandlers();
