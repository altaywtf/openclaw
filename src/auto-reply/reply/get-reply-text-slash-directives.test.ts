import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import { createTypingController } from "./typing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: createChannelTestPluginBase({
          id: "discord",
          capabilities: { nativeCommands: true, chatTypes: ["direct"] },
        }),
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

async function resolveTextSlashDirective(
  body: string,
  options?: {
    botUsername?: string;
    commandsText?: boolean;
    surface?: string;
    authorized?: boolean;
    admin?: boolean;
  },
) {
  const storePath = path.join(tempDirs.make("openclaw-text-slash-directive-"), "sessions.json");
  const surface = options?.surface ?? "webchat";
  const sessionKey = `agent:main:${surface}:direct:user-1`;
  const ctx = buildTestCtx({
    Body: body,
    BodyForAgent: body,
    CommandBody: body,
    CommandSource: "text",
    CommandAuthorized: options?.authorized ?? true,
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized: options?.authorized ?? true,
      commandName: body.slice(1).split(/\s+/, 1)[0],
      body,
    },
    Provider: surface,
    Surface: surface,
    BotUsername: options?.botUsername,
    GatewayClientScopes: options?.admin === false ? [] : ["operator.admin"],
    SessionKey: sessionKey,
  });
  const sessionEntry = { sessionId: "session-1", updatedAt: 1 };
  await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
  const storedBefore = loadExactSessionEntry({ sessionKey, storePath })?.entry;
  const result = await resolveReplyDirectives({
    ctx,
    cfg: markCompleteReplyConfig({
      session: { store: storePath },
      commands: options?.commandsText === undefined ? undefined : { text: options.commandsText },
    }),
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: {},
    sessionCtx: ctx,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    storePath,
    sessionScope: "per-sender",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: body,
    resetTriggered: false,
    commandAuthorized: options?.authorized ?? true,
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    provider: "openai",
    model: "gpt-5.5",
    hasResolvedHeartbeatModelOverride: false,
    typing: createTypingController({}),
  });
  return { result, sessionKey, storePath, storedBefore };
}

describe("text slash directive ownership", () => {
  it.each([
    { directive: "/think high", expected: { resolvedThinkLevel: "high" } },
    { directive: "/fast on", expected: { resolvedFastMode: true, resolvedFastModeOverride: true } },
    { directive: "/verbose full", expected: { resolvedVerboseLevel: "full" } },
  ])(
    "applies $directive to the current turn without persisting it",
    async ({ directive, expected }) => {
      const { result, sessionKey, storePath } = await resolveTextSlashDirective(
        `${directive} Review this`,
      );

      expect(result).toMatchObject({ kind: "continue", result: expected });
      const entry = loadExactSessionEntry({ sessionKey, storePath })?.entry;
      expect(entry?.thinkingLevel).toBeUndefined();
      expect(entry?.fastMode).toBeUndefined();
      expect(entry?.verboseLevel).toBeUndefined();
    },
  );

  it.each([
    "/think high ",
    "/think high\r\n",
    "/fast on\n",
    "/verbose on\n",
    "/think high /verbose on\n",
    "/exec security=full ask=off ",
    "/exec security=full ask=off\n",
  ])(
    "keeps the task after %j in the model turn without changing session defaults",
    async (prefix) => {
      const task = "Review  this:\n```python\n    print('a  b')\n\t# tabs stay  \n```";
      const { result, sessionKey, storePath } = await resolveTextSlashDirective(`${prefix}${task}`);

      expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: task } });
      const entry = loadExactSessionEntry({ sessionKey, storePath })?.entry;
      expect(entry).toMatchObject({
        sessionId: "session-1",
        updatedAt: 1,
      });
      expect(entry?.thinkingLevel).toBeUndefined();
      expect(entry?.fastMode).toBeUndefined();
      expect(entry?.verboseLevel).toBeUndefined();
      expect(entry).not.toHaveProperty("execSecurity");
      expect(entry).not.toHaveProperty("execAsk");
    },
  );

  it.each([
    "/model list -g Review this",
    "/model list@work --runtime codex -g Review this",
    "/model status -a -g Review this",
  ])("ignores mixed model information metadata: %s", async (body) => {
    for (const authorized of [true, false]) {
      const { result, sessionKey, storePath, storedBefore } = await resolveTextSlashDirective(
        body,
        {
          admin: false,
          authorized,
        },
      );
      expect(result).toMatchObject({
        kind: "continue",
        result: {
          cleanedBody: expect.stringContaining("Review this"),
          directives: {
            hasModelDirective: false,
            rawModelDirective: undefined,
            rawModelProfile: undefined,
            rawModelRuntime: undefined,
            modelDirectiveSource: undefined,
            modelScope: undefined,
            modelScopeConflict: false,
          },
        },
      });
      expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toEqual(storedBefore);
    }
  });

  it.each(["", "  "])(
    "keeps an addressed exec task after prefix %j with its per-turn policy",
    async (prefix) => {
      const task = "Review  this:\n```python\n    print('a  b')\n```";
      const { result } = await resolveTextSlashDirective(
        `${prefix}/exec@openclaw security=full ask=off\n${task}`,
        {
          botUsername: "openclaw",
        },
      );

      expect(result).toMatchObject({
        kind: "continue",
        result: { cleanedBody: task, execOverrides: { security: "full", ask: "off" } },
      });
    },
  );

  it("preserves unknown addressed command text for the model", async () => {
    const body = "/unknown@openclaw explain  this\n    unchanged";
    const { result } = await resolveTextSlashDirective(body, { botUsername: "openclaw" });

    expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: body } });
  });

  it("rejects positional exec arguments instead of sending them to the model", async () => {
    const { result } = await resolveTextSlashDirective("/exec gateway");

    expect(result).toMatchObject({
      kind: "reply",
      reply: { text: 'Unexpected argument "gateway" for /exec.' },
    });
  });

  it.each(["/exec host=gateway", "  /exec@openclaw host=gateway", "/exec@openclaw: host=gateway"])(
    "preserves canonical exec key/value arguments: %s",
    async (body) => {
      const { result, sessionKey, storePath } = await resolveTextSlashDirective(body, {
        botUsername: "openclaw",
      });

      expect(result).toMatchObject({
        kind: "reply",
        reply: { text: expect.stringContaining("Exec defaults set (host=gateway).") },
      });
      expect(loadExactSessionEntry({ sessionKey, storePath })?.entry.execHost).toBe("gateway");
    },
  );

  it.each(["/exec@openclaw gateway", "  /exec@openclaw gateway", "/exec@openclaw: gateway"])(
    "rejects positional exec arguments addressed to the current bot: %s",
    async (body) => {
      const { result } = await resolveTextSlashDirective(body, {
        botUsername: "openclaw",
      });

      expect(result).toMatchObject({
        kind: "reply",
        reply: { text: 'Unexpected argument "gateway" for /exec.' },
      });
    },
  );

  it("preserves text exec commands when text routing is disabled on a native surface", async () => {
    const body = "/exec host=gateway";
    const { result, sessionKey, storePath } = await resolveTextSlashDirective(body, {
      commandsText: false,
      surface: "discord",
    });

    expect(result).toMatchObject({ kind: "continue", result: { cleanedBody: body } });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry.execHost).toBeUndefined();
  });
});
