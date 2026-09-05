import path from "node:path";
import {
  discordVoiceTranscriptsSourceProvider,
  loadDiscordVoiceTestHarness,
  setDiscordTranscriptsVoiceManager,
} from "../extensions/discord/test-api.js";
import { createTranscriptsTool } from "../src/agents/tools/transcripts-tool.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { TranscriptsStore } from "../src/transcripts/store.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

const { defineDiscordVoiceTests } = await loadDiscordVoiceTestHarness();

defineDiscordVoiceTests(
  ({
    expect,
    expectDefined,
    it,
    vi,
    createClientWithMember,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    receiveRecordedSpeech,
    expectConnectedStatus,
    lastRealtimeBridgeParams,
    beginSpeakerTurn,
    realtimeSessionMock,
    createRealtimeVoiceBridgeSessionMock,
    loggerErrorMock,
    loggerWarnMock,
    joinVoiceChannelMock,
  }) => {
    it.each([
      ...(["manager destruction", "persistence failure"] as const).map((terminal) => ({
        terminal,
        mode: "stt-tts" as const,
        promotion: "ready" as const,
      })),
      ...(["agent-proxy", "bidi"] as const).flatMap((mode) =>
        (["completed", "error"] as const).flatMap((terminal) =>
          (["ready", "pending resolve", "pending reject", "factory close"] as const).map(
            (promotion) => ({ mode, terminal, promotion }),
          ),
        ),
      ),
    ])(
      "preserves independent capture across $mode $terminal ($promotion)",
      async ({ terminal, mode, promotion }) => {
        const tempDirs = createTempDirTracker();
        const stateDir = tempDirs.make("discord-transcripts-replacement-");
        const accountId = "transcript-replacement";
        const discordConfig = makeVoiceConfig(
          { mode },
          { token: "test-token", groupPolicy: "open", allowFrom: ["discord:u-speaker"] },
        );
        const config = {
          transcripts: { enabled: true },
          channels: { discord: { accounts: { [accountId]: discordConfig } } },
        };
        const makeManager = () =>
          createManager(
            discordConfig,
            createClientWithMember("u-speaker", "Speaker", "0001"),
            config,
            accountId,
          );
        let manager = makeManager();
        const registry = createEmptyPluginRegistry();
        registry.transcriptSourceProviders.push({
          pluginId: "discord",
          source: "discord/transcripts-source-api.ts",
          provider: discordVoiceTranscriptsSourceProvider,
        });
        const tool = createTranscriptsTool({
          config,
          stateDir,
          agentId: "transcript-replacement",
          caller: { kind: "operator", source: "local" },
        });
        const execute = (params: Record<string, unknown>) =>
          withPluginRuntimeRegistryScope(registry, () => tool.execute("transcripts", params));
        const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        });
        const source = { providerId: "discord-voice", accountId, guildId: "g1", channelId: "1001" };
        const providerStop = vi.spyOn(discordVoiceTranscriptsSourceProvider, "stop");
        const writeSummary = vi.spyOn(TranscriptsStore.prototype, "writeSummary");
        const start = (sessionId: string) => execute({ action: "start", sessionId, ...source });
        const record = (text: string) =>
          receiveRecordedSpeech(manager, text, getSessionEntry(manager), "u-speaker");
        setDiscordTranscriptsVoiceManager({ accountId, manager });
        try {
          await start("first");
          await record("Keep the original historical note.");
          const oldCapture = expectDefined(
            getSessionEntry(manager).transcripts,
            "first registration",
          );
          if (terminal === "persistence failure") {
            writeSummary.mockRejectedValueOnce(new Error("synthetic summary failure"));
          }
          await start("second");
          await record("This belongs only to the replacement.");
          await oldCapture.onUtterance({ text: "Stale delivery after replacement." });
          expect(oldCapture.isCurrent()).toBe(false);
          await vi.waitFor(async () => {
            await expect(execute({ action: "status" })).resolves.toMatchObject({
              details: {
                active: [expect.objectContaining({ sessionId: "second" })],
                pendingFinalization:
                  terminal === "persistence failure"
                    ? [expect.objectContaining({ sessionId: "first" })]
                    : [],
              },
            });
          });
          const first = expectDefined(await store.readSession("first"), "first capture");
          const second = expectDefined(await store.readSession("second"), "second capture");
          expect(first.stoppedAt).toEqual(expect.any(String));
          expect(first.source).toMatchObject(source);
          expect(second.source).toEqual(first.source);
          expect((await store.readUtterancesForSession(second)).map((row) => row.text)).toEqual([
            "This belongs only to the replacement.",
          ]);
          expect(first.metadata).toEqual({ agentId: "transcript-replacement" });
          expect((await store.readUtterancesForSession(first)).map((row) => row.text)).toEqual([
            "Keep the original historical note.",
          ]);
          await execute({ action: "stop", sessionId: "first" });
          await expect(execute({ action: "summarize", sessionId: "first" })).resolves.toMatchObject(
            {
              details: { summary: { sessionId: "first", utteranceCount: 1 } },
            },
          );
          expect(providerStop).not.toHaveBeenCalled();
          expectConnectedStatus(manager, "1001");

          const transport = getSessionEntry(manager);
          const connection = expectDefined(
            joinVoiceChannelMock.mock.results.at(-1)?.value,
            "capture transport",
          );
          const joinCount = joinVoiceChannelMock.mock.calls.length;
          const preservesReceiver = terminal === "completed" || terminal === "error";
          const registration = expectDefined(transport.transcripts, "surviving registration");
          let provider: ReturnType<typeof lastRealtimeBridgeParams> | undefined;
          let turn: ReturnType<typeof beginSpeakerTurn> | undefined;
          if (terminal === "completed" || terminal === "error") {
            let finishConnect: (() => void) | undefined;
            if (promotion === "factory close") {
              createRealtimeVoiceBridgeSessionMock.mockImplementationOnce(() => {
                lastRealtimeBridgeParams().onClose?.(terminal);
                return realtimeSessionMock;
              });
            } else if (promotion !== "ready") {
              realtimeSessionMock.connect.mockImplementationOnce(
                () =>
                  new Promise<undefined>((resolve, reject) => {
                    finishConnect = () =>
                      promotion === "pending reject"
                        ? reject(new Error("synthetic promotion failure"))
                        : resolve(undefined);
                  }),
              );
            }
            const joining = manager.join({ guildId: "g1", channelId: "1001" });
            try {
              if (promotion === "ready") {
                expect(await joining).toMatchObject({ ok: true });
                turn = beginSpeakerTurn(transport, {
                  userId: "u-speaker",
                  speakerLabel: "Speaker",
                });
              } else if (promotion !== "factory close") {
                await vi.waitFor(() => expect(realtimeSessionMock.connect).toHaveBeenCalledOnce());
              }
              if (promotion !== "factory close") {
                provider = lastRealtimeBridgeParams();
                expectDefined(provider.onClose, "provider terminal callback")(terminal);
                // A bound speaker failure leaves the room alive; a failed warm connection
                // still retires promotion before its pending connect settles.
                if (promotion === "ready") {
                  expectConnectedStatus(manager, "1001");
                } else {
                  expect(manager.status()).toEqual([]);
                }
                expect(registration.isCurrent()).toBe(true);
                if (promotion !== "ready") {
                  expect(connection.destroy).not.toHaveBeenCalled();
                  await record("Recording continues while failed promotion settles.");
                }
              }
            } finally {
              finishConnect?.();
            }
            if (promotion !== "ready") {
              expect(await joining).toMatchObject({ ok: false });
            }
            provider = lastRealtimeBridgeParams();
            if (preservesReceiver) {
              expect(getSessionEntry(manager)).toBe(transport);
              expect(connection.destroy).not.toHaveBeenCalled();
              expectConnectedStatus(manager, "1001");
            } else {
              expect(connection.destroy).toHaveBeenCalledOnce();
            }
            expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
            if (promotion === "ready") {
              expect(loggerErrorMock).not.toHaveBeenCalled();
              expect(loggerWarnMock).toHaveBeenCalledWith(
                expect.stringContaining(
                  `realtime speaker failed user=u-speaker: Realtime provider closed unexpectedly: ${terminal}`,
                ),
              );
            } else {
              expect(loggerErrorMock).toHaveBeenCalledExactlyOnceWith(
                expect.stringContaining(`Realtime provider closed unexpectedly: ${terminal}`),
              );
            }
            if (promotion === "factory close") {
              expect(realtimeSessionMock.connect).not.toHaveBeenCalled();
            }
          } else {
            await manager.destroy();
          }
          if (!preservesReceiver) {
            expect(manager.status()).toEqual([]);
          }
          expect(registration.isCurrent()).toBe(true);
          await expect(execute({ action: "status" })).resolves.toMatchObject({
            details: {
              active: [expect.objectContaining({ sessionId: "second" })],
              pendingFinalization: [],
            },
          });
          expect((await store.readSession("second"))?.stoppedAt).toBeUndefined();
          if (provider) {
            if (!preservesReceiver) {
              await manager.join({ guildId: "g1", channelId: "1001" });
            }
            turn?.close();
            provider.onClose?.("error");
            provider.onReady?.();
            provider.onTranscript?.("user", "Late text from a retired transport.", true);
          } else {
            const previousManager = manager;
            manager = makeManager();
            setDiscordTranscriptsVoiceManager({ accountId, manager });
            setDiscordTranscriptsVoiceManager({
              accountId,
              manager: null,
              expectedManager: previousManager,
            });
          }
          await vi.waitFor(() => expectConnectedStatus(manager, "1001"));
          await record("The same registration resumed recording.");
          if (preservesReceiver) {
            expect(joinVoiceChannelMock).toHaveBeenCalledTimes(joinCount);
            expect(connection.destroy).not.toHaveBeenCalled();
          }
          expect((await store.readUtterancesForSession(second)).map((row) => row.text)).toEqual([
            "This belongs only to the replacement.",
            ...(promotion === "pending resolve" || promotion === "pending reject"
              ? ["Recording continues while failed promotion settles."]
              : []),
            "The same registration resumed recording.",
          ]);
          // Offline stop retires the subscription, not a replaceable manager or transport.
          await manager.destroy();
          await execute({ action: "stop", sessionId: "second" });
          expect(await store.readSession("second")).toMatchObject({
            stoppedAt: expect.any(String),
          });
          manager = makeManager();
          setDiscordTranscriptsVoiceManager({ accountId, manager });
          expect(manager.status()).toEqual([]);
          await expect(execute({ action: "status" })).resolves.toMatchObject({
            details: { active: [], pendingFinalization: [] },
          });
          const stoppedSecond = expectDefined(await store.readSession("second"), "ended capture");
          const stoppedTexts = await store.readUtterancesForSession(stoppedSecond);
          await start("third");
          turn?.close();
          provider?.onClose?.("error");
          provider?.onReady?.();
          provider?.onTranscript?.("user", "Late text from the retired provider.", true);
          const stopCalls = providerStop.mock.calls.length;
          await execute({ action: "stop", sessionId: "second" });
          expect(providerStop).toHaveBeenCalledTimes(stopCalls);
          expectConnectedStatus(manager, "1001");
          await expect(execute({ action: "status" })).resolves.toMatchObject({
            details: {
              active: [expect.objectContaining({ sessionId: "third" })],
              pendingFinalization: [],
            },
          });
          expect(await store.readSession("second")).toEqual(stoppedSecond);
          expect(await store.readUtterancesForSession(stoppedSecond)).toEqual(stoppedTexts);
          const third = expectDefined(await store.readSession("third"), "new capture");
          expect(await store.readUtterancesForSession(third)).toEqual([]);
        } finally {
          writeSummary.mockRestore();
          for (const sessionId of ["first", "second", "third"]) {
            await execute({ action: "stop", sessionId }).catch(() => undefined);
          }
          await manager.destroy();
          setDiscordTranscriptsVoiceManager({ accountId, manager: null, expectedManager: manager });
          providerStop.mockRestore();
          closeOpenClawStateDatabaseForTest();
          tempDirs.cleanup();
        }
      },
    );
  },
);
