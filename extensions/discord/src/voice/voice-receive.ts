import { PassThrough } from "node:stream";
import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Client } from "../internal/discord.js";
import { decodeOpusStreamChunks, VOICE_WAV_HEADER_BYTES, writeVoiceWavFile } from "./audio.js";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  finishVoiceCapture,
  scheduleVoiceCaptureFinalize,
} from "./capture-state.js";
import {
  type DiscordVoiceIngressContext,
  runDiscordVoiceAgentTurn,
  resolveDiscordVoiceIngressContext,
} from "./ingress.js";
import { formatVoiceLogPreview } from "./log-preview.js";
import type { DiscordVoiceMembershipTracker } from "./membership.js";
import { resolveDiscordVoiceIngressContextWithParticipants } from "./participant-context.js";
import {
  analyzeVoiceReceiveError,
  DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
  DECRYPT_FAILURE_WINDOW_MS,
  enableDaveReceivePassthrough as tryEnableDaveReceivePassthrough,
  finishVoiceDecryptRecovery,
  noteVoiceDecryptFailure,
  recoverDaveZeroTransition as tryRecoverDaveZeroTransition,
  resetVoiceReceiveRecoveryState,
} from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { processDiscordVoiceSegment, respondToDiscordVoiceTranscript } from "./segment.js";
import {
  CAPTURE_FINALIZE_GRACE_MS,
  logVoiceVerbose,
  MIN_SEGMENT_SECONDS,
  resolveVoiceTimeoutMs,
  type VoiceOperationResult,
  type VoiceJoinOptions,
  type VoiceRealtimeSpeakerTurn,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const logger = createSubsystemLogger("discord/voice");

export class DiscordVoiceReceive {
  readonly daveRecoveryAttempts = new Map<string, number>();

  constructor(
    private readonly params: {
      accountId: string;
      admissionAllowFrom?: string[];
      botUserId: () => string | undefined;
      cfg: OpenClawConfig;
      client: Client;
      discordConfig: DiscordAccountConfig;
      getSession: (guildId: string) => VoiceSessionEntry | undefined;
      isEntryCurrent: (entry: VoiceSessionEntry) => boolean;
      isFollowOwnedGuild: (guildId: string) => boolean;
      join: (
        params: { guildId: string; channelId: string },
        options?: VoiceJoinOptions,
      ) => Promise<VoiceOperationResult>;
      leave: (
        params: { guildId: string },
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      membership: DiscordVoiceMembershipTracker;
      runtime: RuntimeEnv;
      speakerContext: DiscordVoiceSpeakerContextResolver;
    },
  ) {}

  getRecoveryAttempt(guildId: string): number | undefined {
    return this.daveRecoveryAttempts.get(guildId);
  }

  deleteRecoveryAttempt(guildId: string): void {
    this.daveRecoveryAttempts.delete(guildId);
  }

  clearRecoveryAttempts(): void {
    this.daveRecoveryAttempts.clear();
  }

  scheduleCaptureFinalize(entry: VoiceSessionEntry, userId: string, reason: string): void {
    const graceMs = resolveVoiceTimeoutMs(
      this.params.discordConfig.voice?.captureSilenceGraceMs,
      CAPTURE_FINALIZE_GRACE_MS,
    );
    scheduleVoiceCaptureFinalize({
      state: entry.capture,
      userId,
      delayMs: graceMs,
      onFinalize: () => {
        logVoiceVerbose(
          `capture finalize: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${reason} grace=${graceMs}ms`,
        );
      },
    });
  }

  async handleSpeakingStart(
    entry: VoiceSessionEntry,
    userId: string,
    origin: "native" | "scan" = "native",
  ): Promise<void> {
    if (!userId || !this.params.isEntryCurrent(entry)) {
      return;
    }

    const botUserId = this.params.botUserId();
    if (botUserId && userId === botUserId) {
      return;
    }
    this.params.membership.notePresent(entry, userId);
    const activeCapture = entry.capture.get(userId);
    if (activeCapture) {
      const extended = clearVoiceCaptureFinalizeTimer(activeCapture);
      logVoiceVerbose(
        `capture start ignored (already active): guild ${entry.guildId} channel ${entry.channelId} user ${userId}${extended ? " (finalize canceled)" : ""}`,
      );
      return;
    }

    const capture = entry.transcripts;
    const realtime =
      entry.realtimeLifecycle.status === "active" ? entry.realtimeLifecycle.instance : undefined;
    const playing = entry.player.state.status === loadDiscordVoiceSdk().AudioPlayerStatus.Playing;
    // Scans cannot recover unsubscribed packets. Only a native start may admit
    // conversation for a new receive stream; already-owned streams keep their admission.
    const conversationAllowed =
      origin === "native" && !entry.captureOnly && !(playing && !realtime?.isBargeInEnabled());
    if (!capture && !conversationAllowed) {
      logVoiceVerbose(
        `capture ignored: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${playing ? "protected playback" : "inactive capture"}`,
      );
      return;
    }
    // Own start/end events while admission awaits. Recording capability permits
    // packet receipt; conversation without it still needs native authorization.
    const reservation = beginVoiceCapture(entry.capture, userId);
    try {
      const realtimeIngress =
        realtime && !capture
          ? await this.resolveDiscordVoiceIngressContext(entry, userId)
          : undefined;
      if (!capture && realtime && !realtimeIngress) {
        logVoiceVerbose(
          `realtime capture unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      if (!this.params.isEntryCurrent(entry) || entry.capture.get(userId) !== reservation) {
        return;
      }
      await this.receiveSpeaker(entry, userId, reservation, conversationAllowed, realtimeIngress);
    } finally {
      const stream = reservation.stream;
      const finishedActiveCapture = finishVoiceCapture(entry.capture, userId, reservation);
      if (finishedActiveCapture && stream && !stream.destroyed) {
        stream.destroy();
      }
    }
  }

  captureCurrentSpeakers(entry: VoiceSessionEntry): void {
    for (const userId of entry.connection.receiver.speaking.users.keys()) {
      void this.handleSpeakingStart(entry, userId, "scan").catch((error: unknown) =>
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(error)}`),
      );
    }
  }

  private responseContext(entry: VoiceSessionEntry, userId: string) {
    return {
      entry,
      userId,
      accountId: this.params.accountId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      admissionAllowFrom: this.params.admissionAllowFrom,
      runtime: this.params.runtime,
      speakerContext: this.params.speakerContext,
      fetchGuildName: async (guildId: string) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      enqueuePlayback: (playbackEntry: VoiceSessionEntry, task: () => Promise<void>) => {
        playbackEntry.playbackQueue = playbackEntry.playbackQueue
          .then(task)
          .catch((err: unknown) =>
            logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`),
          );
      },
    };
  }

  private async receiveSpeaker(
    entry: VoiceSessionEntry,
    userId: string,
    reservation: ReturnType<typeof beginVoiceCapture>,
    conversationAllowed: boolean,
    admittedIngress?: DiscordVoiceIngressContext | null,
  ): Promise<void> {
    const voiceSdk = loadDiscordVoiceSdk();
    const realtime =
      entry.realtimeLifecycle.status === "active" ? entry.realtimeLifecycle.instance : undefined;
    const protectedPlayback = () =>
      entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing &&
      !realtime?.isBargeInEnabled();
    this.enableDaveReceivePassthrough(
      entry,
      `speaker ${userId} start`,
      DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
    );
    const stream = (reservation.stream = entry.connection.receiver.subscribe(userId, {
      end: { behavior: voiceSdk.EndBehaviorType.Manual },
    }));
    if (!entry.audioInputBudget.enabled && !realtime) {
      logger.warn(
        "discord voice: capture skipped: audio understanding is disabled; enable tools.media.audio.enabled to transcribe voice.",
      );
      return;
    }
    // Reserve packets before identity/decoder awaits. Normal socket close ends this owned input
    // without destroying packets already received under the source subscription.
    const input = new PassThrough({ objectMode: true });
    type PacketReceipt = { capture: VoiceSessionEntry["transcripts"]; startedAt: number };
    const receipts = new WeakMap<Buffer, PacketReceipt>();
    let ingress: DiscordVoiceIngressContext | null = admittedIngress ?? null;
    let turn: VoiceRealtimeSpeakerTurn | undefined;
    const acceptPacket = (packet: Buffer) => {
      if (!this.params.isEntryCurrent(entry) || entry.capture.get(userId) !== reservation) {
        return;
      }
      const capture = entry.transcripts;
      if (!capture && !conversationAllowed) {
        return;
      }
      const receivedPacket = Buffer.from(packet);
      receipts.set(receivedPacket, { capture, startedAt: Date.now() });
      input.write(receivedPacket);
    };
    const endInput = () => input.end();
    let failed = false;
    let aborted = false;
    let resetReceiveRecovery = false;
    const onError = (error: unknown) => {
      const analysis = analyzeVoiceReceiveError(error);
      if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
        if (!aborted) {
          aborted = true;
          this.handleReceiveError(entry, error);
        }
        return;
      }
      if (failed) {
        return;
      }
      failed = true;
      this.handleReceiveError(entry, error);
    };
    stream.on("data", acceptPacket);
    stream.on("end", endInput);
    stream.on("close", endInput);
    stream.on("error", onError);
    let speaker: Promise<{ label: string }> | undefined;
    const admission = (async () => {
      const context = conversationAllowed
        ? (admittedIngress ??
          (await (realtime
            ? this.resolveDiscordVoiceIngressContext(entry, userId)
            : resolveDiscordVoiceIngressContext(this.responseContext(entry, userId)))))
        : null;
      if (failed || !context || !this.params.isEntryCurrent(entry) || protectedPlayback()) {
        return;
      }
      ingress = context;
      if (realtime) {
        if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing) {
          realtime.handleBargeIn("speaker-start");
        }
        turn = realtime.beginSpeakerTurn(context, userId);
      }
    })();
    const maxBytes = entry.audioInputBudget.enabled ? entry.audioInputBudget.maxBytes : 0;
    // WAV header + complete stereo PCM frames stay below the configured upload caps.
    const segmentBytes = Math.max(0, Math.floor((maxBytes - VOICE_WAV_HEADER_BYTES) / 4) * 4);
    let chunks: Buffer[] = [];
    let bytes = 0;
    const conversationTexts: string[] = [];
    let incompleteSpeech = false;
    let chunkedRecording = false;
    let overflow: Error | undefined;
    let segmentCapture: VoiceSessionEntry["transcripts"];
    let startedAt = 0;
    const pcmBytesPerMillisecond = (48_000 * 2 * 2) / 1_000;
    const flush = async () => {
      if (!bytes) {
        return;
      }
      const segmentChunks = chunks;
      const segmentByteCount = bytes;
      const timestamp = startedAt;
      const capture = segmentCapture;
      chunks = [];
      bytes = 0;
      const canConverse = () => !realtime && ingress !== null && this.params.isEntryCurrent(entry);
      if (failed || (!capture?.isCurrent() && !canConverse())) {
        return;
      }
      if (
        !capture &&
        segmentByteCount / (pcmBytesPerMillisecond * 1_000) < (aborted ? 0.2 : MIN_SEGMENT_SECONDS)
      ) {
        // Capture changes can split one utterance. Discarding even a short uncaptured
        // fragment makes the remaining text unsafe for conversation or active-run control.
        incompleteSpeech = true;
        return;
      }
      const recording = capture
        ? {
            capture,
            startedAt: timestamp,
            speaker: (speaker ??= this.params.speakerContext.resolveIdentity(
              entry.guildId,
              userId,
            )),
          }
        : undefined;
      const wav = await writeVoiceWavFile(Buffer.concat(segmentChunks, segmentByteCount));
      // Only paths wait behind STT; live PCM is released after bounded WAV materialization.
      entry.processingQueue = entry.processingQueue
        .then(async () => {
          try {
            const outcome = await processDiscordVoiceSegment({
              entry,
              cfg: this.params.cfg,
              wavPath: wav.path,
              durationSeconds: wav.durationSeconds,
              userId,
              // Batch commands revalidate native authorization after the queue wait.
              resolveIngressContext: async () =>
                canConverse()
                  ? await resolveDiscordVoiceIngressContext(this.responseContext(entry, userId))
                  : null,
              recording,
            });
            if (outcome.status === "transcribed") {
              conversationTexts.push(outcome.text);
            } else if (outcome.status === "excluded") {
              // A later authorization grant cannot restore a chunk excluded from this utterance.
              incompleteSpeech = true;
            }
          } catch (error) {
            incompleteSpeech = true;
            throw error;
          } finally {
            await wav.cleanup();
          }
        })
        .catch((error: unknown) =>
          logger.warn(`discord voice: recording failed: ${formatErrorMessage(error)}`),
        );
    };
    try {
      await decodeOpusStreamChunks(input, {
        onChunk: async (pcm, packet) => {
          const receipt = receipts.get(packet);
          if (!receipt || failed) {
            return;
          }
          // Recovery counters are shared by speakers. Later healthy packets must not
          // erase another speaker's failures after this stream's first successful decode.
          if (!resetReceiveRecovery && pcm.length > 0) {
            resetReceiveRecovery = true;
            this.resetDecryptFailureState(entry);
          }
          await admission;
          if (failed) {
            return;
          }
          if (this.params.isEntryCurrent(entry)) {
            turn?.sendInputAudio(pcm);
          }
          if (!entry.audioInputBudget.enabled || !segmentBytes) {
            incompleteSpeech = true;
            return;
          }
          chunkedRecording ||= receipt.capture !== undefined;
          if (receipt.capture !== segmentCapture) {
            await flush();
          }
          segmentCapture = receipt.capture;
          if (!chunkedRecording && bytes + pcm.length > segmentBytes) {
            chunks = [];
            bytes = 0;
            if (!realtime && !overflow) {
              overflow = new Error(
                "Discord voice audio exceeds the transcription limit; speak a shorter segment.",
              );
              logger.warn(`discord voice: ${overflow.message}`);
              throw overflow;
            }
            return;
          }
          if (
            !segmentCapture?.isCurrent() &&
            (realtime || !ingress || !this.params.isEntryCurrent(entry))
          ) {
            return;
          }
          for (let offset = 0; offset < pcm.length;) {
            if (!bytes) {
              startedAt = receipt.startedAt + offset / pcmBytesPerMillisecond;
            }
            const limit = segmentBytes;
            const length = Math.min(limit - bytes, pcm.length - offset);
            chunks.push(pcm.subarray(offset, offset + length));
            bytes += length;
            offset += length;
            if (chunkedRecording && bytes === limit) {
              await flush();
            }
          }
        },
        onError,
        onVerbose: logVoiceVerbose,
        onWarn: (message) => logger.warn(message),
      });
      await admission;
      await flush();
      if (overflow) {
        throw overflow;
      }
      // Recording chunks share STT text, but only speech finalization delivers a batch command.
      if (!failed && !realtime && conversationAllowed) {
        entry.processingQueue = entry.processingQueue
          .then(async () => {
            // Earlier chunks settle on this queue. Keep successful notes, but never
            // dispatch incomplete speech; WAV cleanup failures do not invalidate STT.
            if (
              incompleteSpeech ||
              !conversationTexts.length ||
              !this.params.isEntryCurrent(entry)
            ) {
              return;
            }
            const currentIngress = await this.resolveDiscordVoiceIngressContext(entry, userId);
            if (!currentIngress || !this.params.isEntryCurrent(entry)) {
              return;
            }
            await respondToDiscordVoiceTranscript({
              ...this.responseContext(entry, userId),
              ingress: currentIngress,
              transcript: conversationTexts.join("\n"),
            });
          })
          .catch((error: unknown) =>
            logger.warn(`discord voice: processing failed: ${formatErrorMessage(error)}`),
          );
      }
    } finally {
      turn?.close();
      stream.off("data", acceptPacket);
      stream.off("end", endInput);
      stream.off("close", endInput);
      stream.off("error", onError);
      input.destroy();
    }
  }

  handleReceiveError(entry: VoiceSessionEntry, err: unknown): void {
    const analysis = analyzeVoiceReceiveError(err);
    if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
      logVoiceVerbose(`receive stream ended: ${analysis.message}`);
      return;
    }
    if (analysis.isDecodeCorruption && !analysis.countsAsDecryptFailure) {
      logVoiceVerbose(`receive decode skipped: ${analysis.message}`);
      return;
    }
    logger.warn(`discord voice: receive error: ${analysis.message}`);
    if (analysis.shouldAttemptPassthrough) {
      if (this.params.isEntryCurrent(entry)) {
        const recovery = tryRecoverDaveZeroTransition({
          target: entry,
          sdk: loadDiscordVoiceSdk(),
          onWarn: (message) => logger.warn(message),
        });
        if (recovery === "failed") {
          this.startDecryptRecovery(entry, true);
          return;
        }
      }
      this.enableDaveReceivePassthrough(
        entry,
        "receive decrypt error",
        DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
      );
    }
    if (!analysis.countsAsDecryptFailure) {
      return;
    }
    const decryptFailure = noteVoiceDecryptFailure(entry.receiveRecovery);
    if (decryptFailure.firstFailure) {
      logger.warn(
        "discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)",
      );
    }
    if (!decryptFailure.shouldRecover) {
      return;
    }
    this.startDecryptRecovery(entry);
  }

  enableDaveReceivePassthrough(
    entry: Pick<VoiceSessionEntry, "guildId" | "channelId" | "connection">,
    reason: string,
    expirySeconds: number,
  ): boolean {
    const voiceSdk = loadDiscordVoiceSdk();
    return tryEnableDaveReceivePassthrough({
      target: {
        guildId: entry.guildId,
        channelId: entry.channelId,
        connection: entry.connection as {
          state: {
            status: unknown;
            networking?: {
              state?: {
                code?: unknown;
                dave?: {
                  session?: {
                    setPassthroughMode: (passthrough: boolean, expirySeconds: number) => void;
                  };
                };
              };
            };
          };
        },
      },
      sdk: {
        VoiceConnectionStatus: {
          Ready: voiceSdk.VoiceConnectionStatus.Ready,
        },
        NetworkingStatusCode: {
          Ready: voiceSdk.NetworkingStatusCode.Ready,
          Resuming: voiceSdk.NetworkingStatusCode.Resuming,
        },
      },
      reason,
      expirySeconds,
      onVerbose: logVoiceVerbose,
      onWarn: (message) => logger.warn(message),
    });
  }

  private async resolveDiscordVoiceIngressContext(
    entry: VoiceSessionEntry,
    userId: string,
  ): Promise<DiscordVoiceIngressContext | null> {
    return await resolveDiscordVoiceIngressContextWithParticipants({
      client: this.params.client,
      entry,
      userId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      admissionAllowFrom: this.params.admissionAllowFrom,
      botUserId: this.params.botUserId(),
      speakerContext: this.params.speakerContext,
    });
  }

  async runDiscordRealtimeAgentTurn(params: {
    context: {
      extraSystemPrompt?: string;
      senderIsOwner: boolean;
      speakerLabel: string;
    };
    entry: VoiceSessionEntry;
    message: string;
    toolsAllow?: string[];
    userId: string;
  }): Promise<string> {
    const { context, entry, message, toolsAllow, userId } = params;
    logger.info(
      `discord voice: agent turn start guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId} user=${userId} speaker=${context.speakerLabel} owner=${context.senderIsOwner} model=${this.params.discordConfig.voice?.model ?? "route-default"} message=${formatVoiceLogPreview(message)}`,
    );
    const turn = await runDiscordVoiceAgentTurn({
      entry,
      accountId: this.params.accountId,
      userId,
      message,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      runtime: this.params.runtime,
      context,
      toolsAllow,
      admissionAllowFrom: this.params.admissionAllowFrom,
      fetchGuildName: async (guildId) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      speakerContext: this.params.speakerContext,
    });
    if (!turn) {
      logVoiceVerbose(
        `realtime agent unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return "";
    }
    logger.info(
      `discord voice: agent turn answer (${turn.text.length} chars) guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId}: ${formatVoiceLogPreview(turn.text)}`,
    );
    return turn.text;
  }

  private startDecryptRecovery(entry: VoiceSessionEntry, force = false): void {
    let recovery: Promise<unknown>;
    if (force) {
      if (
        this.params.getSession(entry.guildId) !== entry ||
        entry.sessionLifecycle.status === "stopped" ||
        entry.receiveRecovery.decryptRecoveryInFlight
      ) {
        return;
      }
      const now = Date.now();
      for (const [guildId, attemptedAt] of this.daveRecoveryAttempts) {
        if (now - attemptedAt >= DECRYPT_FAILURE_WINDOW_MS) {
          this.daveRecoveryAttempts.delete(guildId);
        }
      }
      resetVoiceReceiveRecoveryState(entry.receiveRecovery);
      entry.receiveRecovery.decryptRecoveryInFlight = true;
      if (this.daveRecoveryAttempts.has(entry.guildId)) {
        const windowSeconds = DECRYPT_FAILURE_WINDOW_MS / 1_000;
        logger.warn(
          `discord voice: DAVE recovery failed again within ${windowSeconds} seconds; disconnecting guild=${entry.guildId} channel=${entry.channelId} to avoid a reconnect loop; retry /vc join after the voice gateway recovers`,
        );
        recovery = this.params.leave(
          { guildId: entry.guildId },
          { preserveFollowState: this.params.isFollowOwnedGuild(entry.guildId) },
        );
      } else {
        // A partially invalidated DAVE session suppresses all later decrypt failures.
        this.daveRecoveryAttempts.set(entry.guildId, now);
        recovery = this.recoverFromDecryptFailures(entry);
      }
    } else {
      recovery = this.recoverFromDecryptFailures(entry);
    }
    void recovery
      .catch((recoverErr: unknown) =>
        logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`),
      )
      .finally(() => {
        finishVoiceDecryptRecovery(entry.receiveRecovery);
      });
  }

  private resetDecryptFailureState(entry: VoiceSessionEntry): void {
    resetVoiceReceiveRecoveryState(entry.receiveRecovery);
    if (this.params.isEntryCurrent(entry)) {
      this.daveRecoveryAttempts.delete(entry.guildId);
    }
  }

  private async recoverFromDecryptFailures(entry: VoiceSessionEntry): Promise<void> {
    const active = this.params.getSession(entry.guildId);
    if (!active || active.connection !== entry.connection) {
      return;
    }
    const preserveFollowState = this.params.isFollowOwnedGuild(entry.guildId);
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.params.leave(
      { guildId: entry.guildId },
      { preserveFollowState },
    );
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.params.join(
      { guildId: entry.guildId, channelId: entry.channelId },
      {
        preserveFollowState,
        autoJoinWhenOccupied: entry.autoJoinWhenOccupied,
        captureOnly: entry.captureOnly,
      },
    );
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }
}
