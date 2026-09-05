import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, inject, it, vi } from "vitest";
import type {
  TranscriptsGetResult,
  TranscriptsListResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { withIsolatedTestHome } from "../../test/test-env.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../test-utils/bundled-plugin-public-surface.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import {
  assertCaptureAddress,
  installCaptureBindGuard,
  protectedCapturePorts,
  resolveTranscriptCapturePorts,
} from "./transcript-capture-network.test-support.js";

type CaptureArguments = { action: "start" | "stop" } & Record<string, unknown>;
type ScriptedCall = { callId: string; args: CaptureArguments; output?: string };
type DiscordCaptureFixture = {
  register(api: OpenClawPluginApi): void;
  expectReady(): Promise<{ speakerId: string; speakerLabel: string; voiceSessionKey: string }>;
  recordAfterTurn(): Promise<void>;
  beginLateDelivery(): Promise<void>;
  finishLateDelivery(): Promise<void>;
  close(): Promise<void>;
  restore(): void;
};
type DiscordCaptureTestApi = {
  loadDiscordGatewayCaptureFixture(this: void): Promise<{
    captureTarget: { accountId: string; guildId: string; channelId: string };
    capturedText: string;
    lateText: string;
    createDiscordGatewayCaptureFixture(
      this: void,
      params: {
        cfg: OpenClawConfig;
        runtime: PluginRuntime;
      },
    ): DiscordCaptureFixture;
  }>;
};

function sendResponse(response: ServerResponse, item: Record<string, unknown>) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${randomUUID()}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

describe("Gateway admitted Discord transcript capture", () => {
  it("records an already-speaking participant after start settles, then fences STT across stop", async () => {
    const ports = resolveTranscriptCapturePorts(inject("transcriptCapturePorts"));
    // The parent must launch the runner with a clean environment and an OS egress fence.
    // This loopback server is a scripted Responses substitute, not a network sandbox.
    const env = captureEnv([
      "OPENCLAW_TEST_MINIMAL_GATEWAY",
      "OPENCLAW_SKIP_CHANNELS",
      "OPENCLAW_SKIP_GMAIL_WATCHER",
      "OPENCLAW_SKIP_CRON",
      "OPENCLAW_SKIP_CANVAS_HOST",
      "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
      "OPENCLAW_SKIP_PROVIDERS",
      "OPENCLAW_BUILD_PRIVATE_QA",
      "OPENCLAW_QA_FORCE_RUNTIME",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
      "OPENCLAW_GATEWAY_PORT",
    ]);
    const isolated = withIsolatedTestHome({ mode: "hermetic" });
    const stateDir = path.join(isolated.tempHome, ".openclaw");
    const workspace = path.join(isolated.tempHome, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    let gateway:
      | Awaited<ReturnType<typeof import("./test-helpers.e2e.js").startGatewayWithClient>>
      | undefined;
    let fixture: DiscordCaptureFixture | undefined;
    let cleanupRuntime: (() => Promise<void>) | undefined;
    const requests: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    const calls: ScriptedCall[] = [];
    const deniedConnections: string[] = [];
    let providerPort: number | undefined;
    deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
    const selectedGatewayPort = () => ports?.gateway ?? Number(process.env.OPENCLAW_GATEWAY_PORT);
    const bindGuard = installCaptureBindGuard(() => ({
      ports: [ports?.provider ?? providerPort ?? 0, selectedGatewayPort()],
      allocating: !ports && !process.env.OPENCLAW_GATEWAY_PORT,
    }));
    // The native method must retain each caller's socket, supplied by Reflect.apply below.
    // oxlint-disable-next-line typescript/unbound-method
    const originalConnect = Socket.prototype.connect;
    // Node HTTP(S), WS and fetch sockets share this boundary. The OS fence also covers
    // native transports/children; neither layer may forward an unexpected destination.
    const socketFence = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (
      this: Socket,
      ...args: unknown[]
    ) {
      const normalized = Array.isArray(args[0]) ? args[0] : args;
      const options = asOptionalRecord(normalized[0]);
      const host = options?.host ?? normalized[1];
      const port = Number(options?.port ?? normalized[0]);
      // startGatewayWithClient publishes its allocated port before opening its WS client.
      const gatewayPort = selectedGatewayPort();
      if (
        host !== "127.0.0.1" ||
        !Number.isInteger(port) ||
        port <= 0 ||
        (port !== providerPort && port !== gatewayPort) ||
        protectedCapturePorts.includes(port)
      ) {
        const reason = `unexpected socket destination ${String(host)}:${port}`;
        deniedConnections.push(reason);
        throw new Error(reason);
      }
      return Reflect.apply(originalConnect, this, args);
    });
    let currentCall: ScriptedCall | undefined;
    let awaitingOutput = false;
    let summaryTranscript: string | undefined;
    let summaryRequests = 0;
    const providerServer = createServer((request, response) => {
      void (async () => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/responses");
        expect(request.headers.authorization).toBe("Bearer test");
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = asOptionalRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        expect(body?.model).toBe("capture-proof");
        expect(body?.stream).toBe(true);
        requests.push(body!);
        // Unscripted conversation calls fail visibly, including recording-only scan regressions.
        expect(currentCall, "unexpected model request outside an admitted tool turn").toBeDefined();
        const call = currentCall!;
        if (awaitingOutput && call.args.action === "stop" && !body?.tools) {
          expect(summaryRequests++).toBe(0);
          expect(summaryTranscript).toBeDefined();
          const summaryInput = JSON.stringify(body);
          expect(summaryInput).toContain(
            "Write concise meeting notes in the transcript's language.",
          );
          expect(summaryInput).toContain(summaryTranscript!);
          sendResponse(response, {
            type: "message",
            id: "msg_capture_summary",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  overview: "The participant supplied a synthetic capture note.",
                  decisions: [],
                  actionItems: [],
                  risks: [],
                }),
                annotations: [],
              },
            ],
          });
          return;
        }
        if (!awaitingOutput) {
          expect(body?.tools).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "transcripts" })]),
          );
          awaitingOutput = true;
          sendResponse(response, {
            type: "function_call",
            id: `fc_${call.callId}`,
            call_id: call.callId,
            name: "transcripts",
            arguments: JSON.stringify(call.args),
            status: "completed",
          });
          return;
        }
        const input = body?.input;
        expect(Array.isArray(input)).toBe(true);
        const result = (input as unknown[])
          .map(asOptionalRecord)
          .findLast(
            (item) => item?.type === "function_call_output" && item.call_id === call.callId,
          );
        expect(result, "the actual tool result must return through the runtime").toBeDefined();
        expect(typeof result?.output).toBe("string");
        call.output = result!.output as string;
        currentCall = undefined;
        awaitingOutput = false;
        sendResponse(response, {
          type: "message",
          id: `msg_${call.callId}`,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: `Completed ${call.args.action}.`, annotations: [] },
          ],
        });
      })().catch((error: unknown) => {
        errors.push(error);
        response.writeHead(500).end("Unexpected scripted capture request");
      });
    });
    try {
      for (const key of [
        "OPENCLAW_BUILD_PRIVATE_QA",
        "OPENCLAW_QA_FORCE_RUNTIME",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_PASSWORD",
      ]) {
        deleteTestEnvValue(key);
      }
      for (const key of [
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_CANVAS_HOST",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        "OPENCLAW_SKIP_PROVIDERS",
      ]) {
        setTestEnvValue(key, "1");
      }
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      await Promise.all([
        fs.mkdir(workspace, { recursive: true }),
        fs.mkdir(stateDir, { recursive: true }),
      ]);
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(ports?.provider ?? 0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      assertCaptureAddress(address, ports?.provider ?? 0);
      providerPort = address.port;
      const provider = buildMockOpenAiResponsesProvider(
        `http://127.0.0.1:${address.port}/v1`,
        "capture-proof",
      );
      const testApiId = resolveRelativeBundledPluginPublicModuleId({
        fromModuleUrl: import.meta.url,
        pluginId: "discord",
        artifactBasename: "test-api.js",
      });
      // The public source barrel loads in Vitest's graph, so its opt-in spies intercept
      // the same owner modules. Plugin internals remain outside the core typecheck graph.
      const { loadDiscordGatewayCaptureFixture } = (await import(
        testApiId
      )) as DiscordCaptureTestApi;
      const { createDiscordGatewayCaptureFixture, captureTarget, capturedText, lateText } =
        await loadDiscordGatewayCaptureFixture();
      summaryTranscript = capturedText;
      const { startGatewayWithClient } = await import("./test-helpers.e2e.js");
      const { createPluginRuntime } = await import("../plugins/runtime/index.js");
      const { createPluginRegistry } = await import("../plugins/registry.js");
      const { createPluginRecord } = await import("../plugins/loader-records.js");
      const { getActivePluginRegistry, setActivePluginRegistry } =
        await import("../plugins/runtime.js");
      const { clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js");
      const { resetConfigOverrides } = await import("../config/runtime-overrides.js");
      const { drainSessionStoreWriterQueuesForTest, clearSessionStoreCacheForTest } =
        await import("../config/sessions/store-writer-state.js");
      const { closeOpenClawStateDatabaseByPath } = await import("../state/openclaw-state-db.js");
      const { activeSessions } = await import("../transcripts/capture.js");
      const { TranscriptsStore } = await import("../transcripts/store.js");
      const previousRegistry = getActivePluginRegistry();
      cleanupRuntime = async () => {
        const ownedCaptures = () =>
          [...activeSessions.values()].filter(
            (capture) => capture.session.source.accountId === captureTarget.accountId,
          );
        try {
          for (const capture of ownedCaptures()) {
            await capture.finalization;
          }
          expect(ownedCaptures()).toEqual([]);
        } finally {
          try {
            await drainSessionStoreWriterQueuesForTest();
          } finally {
            clearSessionStoreCacheForTest();
            closeOpenClawStateDatabaseByPath(path.join(stateDir, "state", "openclaw.sqlite"));
            resetConfigOverrides();
            clearRuntimeConfigSnapshot();
            clearConfigCache();
            if (previousRegistry) {
              setActivePluginRegistry(previousRegistry);
            }
          }
        }
      };
      resetConfigOverrides();
      const token = "synthetic-gateway-capture-token";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef, fallbacks: [] },
            models: {
              [provider.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        channels: {
          discord: {
            accounts: {
              [captureTarget.accountId]: {
                token: "synthetic-discord-token",
                voice: { enabled: true, mode: "stt-tts" },
              },
            },
          },
        },
        gateway: { auth: { mode: "token", token } },
        models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
        plugins: { allow: ["discord"], slots: { memory: "none" } },
        tools: { allow: ["transcripts"], codeMode: false, toolSearch: false },
        transcripts: { enabled: true },
      };
      const runtime = createPluginRuntime();
      fixture = createDiscordGatewayCaptureFixture({ cfg, runtime });
      const registration = createPluginRegistry({ runtime, logger: console });
      const record = createPluginRecord({
        id: "discord",
        source: path.resolve("extensions/discord/index.ts"),
        rootDir: path.resolve("extensions/discord"),
        origin: "bundled",
        enabled: true,
        configSchema: true,
      });
      registration.registry.plugins.push(record);
      fixture.register(registration.createApi(record, { config: cfg }));
      expect(registration.registry.diagnostics).toEqual([]);
      expect(record.transcriptSourceProviderIds).toEqual(["discord-voice"]);
      // Minimal startup retains this real registration; it skips monitor login/sidecars only.
      // This does not prove full plugin discovery or Discord monitor startup.
      setActivePluginRegistry(registration.registry);
      gateway = await startGatewayWithClient({
        port: ports?.gateway,
        cfg,
        configPath,
        token,
        scopes: ["operator.admin"],
      });
      expect(bindGuard.failures).toEqual([]);
      expect(bindGuard.observed).toContainEqual(
        expect.objectContaining({ address: "127.0.0.1", port: gateway.port }),
      );
      expect(gateway.port).not.toBe(providerPort);
      // The optional IPv6 capability probe is denied before native listen; it is
      // not a listener or an exception to the literal IPv4 boundary.
      expect(bindGuard.rejected.length).toBeLessThanOrEqual(1);
      expect(bindGuard.rejected.every(({ host, port }) => host === "::1" && port === 0)).toBe(true);
      expect(getActivePluginRegistry()).toBe(registration.registry);
      const client = gateway.client;
      const sessionKey = `agent:main:capture-proof-${randomUUID()}`;
      const sessionId = `capture-${randomUUID()}`;
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
      const runTurn = async (args: CaptureArguments) => {
        const call: ScriptedCall = { callId: `capture_${calls.length}`, args };
        calls.push(call);
        currentCall = call;
        const accepted = await client.request<{ runId: string; status: string }>("agent", {
          sessionKey,
          message: `Perform the synthetic capture ${args.action} operation.`,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(accepted.status).toBe("accepted");
        expect(accepted.runId).toEqual(expect.any(String));
        const completed = await client.request<{ status: string }>("agent.wait", {
          runId: accepted.runId,
          timeoutMs: 30_000,
        });
        expect(completed.status).toBe("ok");
        expect(errors).toEqual([]);
        expect(call.output).toBeDefined();
        expect(currentCall).toBeUndefined();
        return call.output!;
      };
      const start = await runTurn({
        action: "start",
        providerId: "discord-voice",
        ...captureTarget,
        sessionId,
      });
      expect(start).toContain(`Transcripts started: ${sessionId}`);
      const selector = /^Selector: (.+)$/m.exec(start)?.[1];
      expect(selector).toBeDefined();
      const speaker = await fixture.expectReady();
      const admitted = await store.readSession(selector!);
      expect(admitted).toMatchObject({ sessionId, metadata: { agentId: "main" } });
      expect(admitted?.source).toEqual({
        providerId: "discord-voice",
        ...captureTarget,
        agentId: "main",
      });
      const listed = await client.request<TranscriptsListResult>("transcripts.list", {});
      expect(listed.sessions).toHaveLength(1);
      expect(listed.sessions[0]).toMatchObject({
        selector,
        sessionId,
        agentId: "main",
        source: { providerId: "discord-voice", ...captureTarget },
        activeSubscription: true,
      });
      expect(requests).toHaveLength(2);

      await fixture.recordAfterTurn();
      const captured = await client.request<TranscriptsGetResult>("transcripts.get", {
        selector,
        includeUtterances: true,
      });
      expect(captured.session).toMatchObject({
        selector,
        sessionId,
        utteranceCount: 1,
        activeSubscription: true,
      });
      expect(captured.utterances).toEqual([
        expect.objectContaining({
          sequence: 0,
          text: capturedText,
          final: true,
          speakerId: speaker.speakerId,
          speakerLabel: speaker.speakerLabel,
        }),
      ]);
      expect(requests).toHaveLength(2);
      expect(errors).toEqual([]);

      await fixture.beginLateDelivery();
      const stop = await runTurn({ action: "stop", selector });
      expect(stop).toContain(`Transcripts stopped: ${sessionId}`);
      expect(stop).toContain(`Selector: ${selector}`);
      await fixture.finishLateDelivery();
      const stopped = await client.request<TranscriptsGetResult>("transcripts.get", {
        selector,
        includeUtterances: true,
      });
      expect(stopped.session).toMatchObject({
        selector,
        sessionId,
        agentId: "main",
        utteranceCount: 1,
        activeSubscription: false,
        stoppedAt: expect.any(String),
      });
      expect(stopped.utterances).toEqual(captured.utterances);
      expect(stopped.summary).toMatchObject({ utteranceCount: 1, source: "model" });
      expect(JSON.stringify(stopped)).not.toContain(lateText);
      const stoppedSession = await store.readSession(selector!);
      expect(stoppedSession).toEqual({ ...admitted, stoppedAt: stopped.session.stoppedAt });
      const utterances = await store.readUtterancesForSession(stoppedSession!);
      expect(utterances).toEqual([
        expect.objectContaining({
          text: capturedText,
          metadata: {
            channel: "discord",
            guildId: captureTarget.guildId,
            channelId: captureTarget.channelId,
            voiceSessionKey: speaker.voiceSessionKey,
          },
        }),
      ]);
      expect(requests).toHaveLength(5);
      expect(summaryRequests).toBe(1);
      expect(errors).toEqual([]);
      expect(deniedConnections).toEqual([]);
      expect(bindGuard.failures).toEqual([]);
      expect(bindGuard.rejected.length).toBeLessThanOrEqual(1);
      expect(bindGuard.rejected.every(({ host, port }) => host === "::1" && port === 0)).toBe(true);
    } finally {
      // Keep the actual runtime and edge spies alive until sources, streams and Gateway settle.
      try {
        await fixture?.close();
      } finally {
        try {
          if (gateway) {
            try {
              await gateway.client.stopAndWait();
            } finally {
              await gateway.server.close({ reason: "synthetic transcript capture cleanup" });
            }
          }
        } finally {
          providerServer.closeAllConnections();
          await new Promise<void>((resolve) => {
            providerServer.close(() => resolve());
          });
          try {
            await cleanupRuntime?.();
          } finally {
            fixture?.restore();
            socketFence.mockRestore();
            try {
              await bindGuard.close();
            } finally {
              isolated.cleanup();
              env.restore();
            }
          }
        }
      }
    }
  });
});
