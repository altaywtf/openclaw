import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { expect, vi } from "vitest";
import { discordPlugin } from "../../channel-plugin-api.js";
import { registerDiscordTranscriptSourceProvider } from "../../transcripts-source-api.js";
import type { Client } from "../internal/discord.js";
import * as audio from "./audio.js";
import * as sdkRuntime from "./sdk-runtime.js";
import type { VoiceSessionEntry } from "./session.js";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./transcripts-source.js";
import { DiscordVoiceManager } from "./voice-runtime.js";

export const captureTarget = {
  accountId: "gateway-capture-fixture",
  guildId: "810000000000000001",
  channelId: "810000000000000002",
};
const speakerId = "810000000000000003";
const speakerLabel = "Synthetic speaker";
export const capturedText = "Synthetic capture continues after the initiating turn settles.";
export const lateText = "Synthetic late STT must not enter the stopped capture.";

/** Owns only external Discord/codec/STT edges; no routing, authorization or dispatch mocks. */
export function createDiscordGatewayCaptureFixture(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
}) {
  const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
    pluginId: "discord",
    errorMessage: "Discord runtime not initialized",
  });
  const previousRuntime = runtimeStore.tryGetRuntime();
  const sdk = sdkRuntime.loadDiscordVoiceSdk();
  const speaking = Object.assign(new EventEmitter(), {
    // Speech predates readiness: there is deliberately no initial native start event.
    users: new Map([[speakerId, Date.now()]]),
  });
  const streams: PassThrough[] = [];
  const subscribe = vi.fn(() => {
    const stream = new PassThrough();
    streams.push(stream);
    return stream;
  });
  const player = Object.assign(new EventEmitter(), {
    state: { status: sdk.AudioPlayerStatus.Idle },
    stop: vi.fn(() => true),
    play: vi.fn(),
  });
  const connection = Object.assign(new EventEmitter(), {
    state: { status: sdk.VoiceConnectionStatus.Ready },
    receiver: { speaking, subscribe },
    subscribe: vi.fn(),
    destroy: vi.fn(() => {
      connection.state.status = sdk.VoiceConnectionStatus.Destroyed;
      connection.emit(sdk.VoiceConnectionStatus.Destroyed);
    }),
  });
  // Intercept the actual cached createRequire loader, not an unrelated ESM package import.
  const sdkSpy = vi.spyOn(sdkRuntime, "loadDiscordVoiceSdk").mockReturnValue({
    ...sdk,
    getVoiceConnection: () => undefined,
    joinVoiceChannel: vi.fn(() => connection),
    createAudioPlayer: vi.fn(() => player),
    entersState: vi.fn(async (target) => target),
  } as unknown as ReturnType<typeof sdkRuntime.loadDiscordVoiceSdk>);
  const decoding = new Set<Promise<void>>();
  const codecSpy = vi
    .spyOn(audio, "decodeOpusStreamChunks")
    .mockImplementation((input, options) => {
      const work = (async () => {
        for await (const packet of input) {
          // One synthetic packet is 20 ms of stereo PCM. Preserve packet identity for receipts.
          const pcm = Buffer.alloc(960 * 2 * 2);
          pcm.fill(packet[0]);
          await options.onChunk(pcm, packet);
        }
      })();
      decoding.add(work);
      void work.then(
        () => decoding.delete(work),
        () => decoding.delete(work),
      );
      return work;
    });
  const lateStt = createDeferred<void>();
  const wavPaths: string[] = [];
  const stt = vi
    .spyOn(params.runtime.mediaUnderstanding, "transcribeAudioFile")
    .mockImplementation(async ({ filePath, mime }) => {
      const wav = await fs.readFile(filePath);
      expect(mime).toBe("audio/wav");
      expect(wav.subarray(0, 4).toString()).toBe("RIFF");
      expect(wav.subarray(8, 12).toString()).toBe("WAVE");
      expect(wav.readUInt32LE(24)).toBe(48_000);
      expect(wav.readUInt16LE(22)).toBe(2);
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      expect(wav.subarray(44).equals(Buffer.alloc(960 * 2 * 2, wav[44]))).toBe(true);
      wavPaths.push(filePath);
      if (wav[44] === 2) {
        await lateStt.promise;
        return { text: lateText };
      }
      expect(wav[44]).toBe(1);
      return { text: capturedText };
    });
  const client = {
    fetchChannel: async () => ({
      id: captureTarget.channelId,
      guildId: captureTarget.guildId,
      type: 2,
      name: "synthetic-capture",
    }),
    fetchGuild: async () => ({ id: captureTarget.guildId, name: "Synthetic guild" }),
    fetchMember: async () => ({
      nickname: speakerLabel,
      user: { id: speakerId, username: "synthetic-speaker", bot: false },
      roles: [],
    }),
    getPlugin: (id: string) =>
      id === "voice"
        ? { getGatewayAdapterCreator: () => () => ({ sendPayload: () => true, destroy() {} }) }
        : id === "gateway"
          ? {
              listVoiceChannelStates: () => [
                {
                  user_id: speakerId,
                  channel_id: captureTarget.channelId,
                  member: { nick: speakerLabel, user: { id: speakerId, bot: false } },
                },
              ],
            }
          : undefined,
  } as unknown as Client;
  function restore() {
    // A different owner installed during teardown must never be overwritten or cleared.
    if (runtimeStore.tryGetRuntime() === params.runtime) {
      if (previousRuntime) {
        runtimeStore.setRuntime(previousRuntime);
      } else {
        runtimeStore.clearRuntime();
      }
    }
    stt.mockRestore();
    codecSpy.mockRestore();
    sdkSpy.mockRestore();
  }
  let manager: DiscordVoiceManager;
  try {
    runtimeStore.setRuntime(params.runtime);
    manager = new DiscordVoiceManager({
      client,
      cfg: params.cfg,
      discordConfig: params.cfg.channels!.discord!.accounts![captureTarget.accountId]!,
      accountId: captureTarget.accountId,
      botUserId: "810000000000000004",
      runtime: {
        log() {},
        error() {},
        exit: () => {
          throw new Error("unexpected Discord exit");
        },
      },
    });
    setDiscordTranscriptsVoiceManager({ accountId: captureTarget.accountId, manager });
  } catch (error) {
    restore();
    throw error;
  }
  let entry: VoiceSessionEntry | undefined;

  async function drain() {
    await Promise.all(decoding);
    // The receiver removes packet listeners only after scheduling its final WAV/STT work.
    await expect
      .poll(() => streams.every((stream) => stream.listenerCount("data") === 0))
      .toBe(true);
    await entry?.processingQueue;
    await entry?.playbackQueue;
  }

  return {
    register(api: OpenClawPluginApi) {
      // Same probe-type erasure used by defineBundledChannelEntry at registration.
      api.registerChannel({ plugin: discordPlugin as ChannelPlugin });
      registerDiscordTranscriptSourceProvider(api);
    },
    async expectReady() {
      await expect.poll(() => streams.length).toBe(1);
      // Observe the actual typed session; never construct or mutate a session substitute.
      entry = manager["sessions"].get(captureTarget.guildId);
      expect(entry).toMatchObject({
        captureOnly: true,
        sessionLifecycle: { status: "active" },
        realtimeLifecycle: { status: "inactive", generation: 0 },
        route: { agentId: "main", accountId: captureTarget.accountId },
      });
      expect(entry?.transcripts?.isCurrent()).toBe(true);
      expect(subscribe).toHaveBeenCalledWith(speakerId, {
        end: { behavior: sdk.EndBehaviorType.Manual },
      });
      return { speakerId, speakerLabel, voiceSessionKey: entry!.voiceSessionKey };
    },
    async recordAfterTurn() {
      streams[0]!.end(Buffer.from([1]));
      await drain();
      expect(stt).toHaveBeenCalledTimes(1);
      await expect(fs.stat(wavPaths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    },
    async beginLateDelivery() {
      speaking.emit("start", speakerId);
      await expect.poll(() => streams.length).toBe(2);
      streams[1]!.end(Buffer.from([2]));
      await expect.poll(() => wavPaths.length).toBe(2);
    },
    async finishLateDelivery() {
      lateStt.resolve();
      await drain();
      expect(stt).toHaveBeenCalledTimes(2);
      expect(manager.status()).toEqual([]);
      expect(entry?.sessionLifecycle.status).toBe("stopped");
      expect(entry?.transcripts).toBeUndefined();
      expect(connection.state.status).toBe(sdk.VoiceConnectionStatus.Destroyed);
      expect(speaking.listenerCount("start")).toBe(0);
      expect(speaking.listenerCount("end")).toBe(0);
      expect(player.play).not.toHaveBeenCalled();
      expect(entry?.capture.size).toBe(0);
      for (const filePath of wavPaths) {
        await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
    async close() {
      // Retire this provider before releasing held STT, then drain while runtime/spies still exist.
      entry ??= manager["sessions"].get(captureTarget.guildId);
      try {
        const captures = await discordVoiceTranscriptsSourceProvider.status!({
          providerId: "discord-voice",
          ...captureTarget,
        });
        for (const capture of captures) {
          if (capture.sessionId) {
            await discordVoiceTranscriptsSourceProvider.stop!({
              sessionId: capture.sessionId,
              source: { providerId: "discord-voice", ...captureTarget },
            });
          }
        }
      } finally {
        try {
          await manager.destroy();
        } finally {
          for (const stream of streams) {
            stream.destroy();
          }
          lateStt.resolve();
          try {
            await drain();
          } finally {
            setDiscordTranscriptsVoiceManager({
              accountId: captureTarget.accountId,
              manager: null,
              expectedManager: manager,
            });
          }
        }
      }
    },
    restore,
  };
}
