import { isDeepStrictEqual } from "node:util";
// Resolves transcript source configuration from OpenClaw config.
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Configuration normalization for transcript capture/import.
 *
 * Raw config can contain optional auto-start provider locators; resolution
 * returns bounded defaults and drops malformed entries before runtime startup.
 */
/** Raw auto-start transcript source entry from config. */
type TranscriptsAutoStartConfig = {
  providerId: string;
  whenOccupied?: boolean;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

/** Normalized auto-start source entry consumed by transcript runtime code. */
export type ResolvedTranscriptsAutoStartConfig = {
  providerId: string;
  whenOccupied: boolean;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

/** Raw transcripts config block. */
export type TranscriptsConfig = {
  enabled?: boolean;
  autoStart?: TranscriptsAutoStartConfig[];
};

/** Resolved transcripts config with defaults applied. */
type ResolvedTranscriptsConfig = {
  enabled: boolean;
  maxUtterances: number;
  autoStart: ResolvedTranscriptsAutoStartConfig[];
};

const DEFAULT_TRANSCRIPTS_MAX_UTTERANCES = 2_000;

function withoutTitles(config: TranscriptsConfig | undefined) {
  return (
    config && {
      ...config,
      ...(config.autoStart && {
        autoStart: config.autoStart.map(({ title: _title, ...source }) => source),
      }),
    }
  );
}

/** Compare full source intent before reading titles, without borrowing new routing authority. */
export function hasSameTranscriptCaptureIntent(
  previous: TranscriptsConfig | undefined,
  candidate: TranscriptsConfig | undefined,
): boolean {
  return isDeepStrictEqual(withoutTitles(previous), withoutTitles(candidate));
}

/** Bounded process diagnostic correlation only, never admission or resume authority. */
export function transcriptCaptureConfigHash(config: TranscriptsConfig | undefined): string {
  return hashRuntimeConfigValue({ transcripts: withoutTitles(config) });
}

/** Compare authoritative config, including routing, credentials and full invitation URLs. */
export function isTranscriptTitleOnlyConfigChange(
  previous: OpenClawConfig | undefined,
  candidate: OpenClawConfig | undefined,
): boolean {
  if (!previous || !candidate || isDeepStrictEqual(previous.transcripts, candidate.transcripts)) {
    return false;
  }
  const captureConfig = ({ transcripts, meta, ...config }: OpenClawConfig) => {
    // Only writer bookkeeping is irrelevant to this reload decision. Other
    // metadata and every non-title config value retain their normal handling.
    const { lastTouchedVersion: _version, ...metadata } = meta ?? {};
    return { ...config, meta: metadata, transcripts: withoutTitles(transcripts) };
  };
  return isDeepStrictEqual(captureConfig(previous), captureConfig(candidate));
}

function resolveAutoStart(raw: unknown): ResolvedTranscriptsAutoStartConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry): ResolvedTranscriptsAutoStartConfig | undefined => {
      const config = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const providerId = readString(config.providerId);
      if (!providerId) {
        return undefined;
      }
      return {
        providerId,
        whenOccupied: config.whenOccupied === true,
        sessionId: readString(config.sessionId),
        title: readString(config.title),
        accountId: readString(config.accountId),
        guildId: readString(config.guildId),
        channelId: readString(config.channelId),
        meetingUrl: readString(config.meetingUrl),
      };
    })
    .filter((entry): entry is ResolvedTranscriptsAutoStartConfig => entry !== undefined);
}

/** Normalize raw transcripts config into runtime settings. */
export function resolveTranscriptsConfig(raw: unknown): ResolvedTranscriptsConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: config.enabled !== false,
    maxUtterances: DEFAULT_TRANSCRIPTS_MAX_UTTERANCES,
    autoStart: resolveAutoStart(config.autoStart),
  };
}
